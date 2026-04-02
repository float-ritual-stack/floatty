//! Durable voice session storage and transcript append logic.
//!
//! Voice sessions are stored as file-backed artifacts under `{data_dir}/__attachments/`
//! so they remain durable outside the outline while still being browsable through the
//! existing attachments HTTP route.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use uuid::Uuid;

const SESSION_PREFIX: &str = "voice-session-";
const TRANSCRIPT_PREFIX: &str = "voice-transcript-";
const JSON_SUFFIX: &str = ".json";
const MARKDOWN_SUFFIX: &str = ".md";
static SESSION_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

#[derive(Debug)]
pub enum VoiceError {
    Io(std::io::Error),
    Json(serde_json::Error),
    InvalidMode(String),
    InvalidStatus(String),
    InvalidSessionId(String),
    InvalidTimestamp { field: &'static str, value: String },
    InvalidStatusTransition { from: String, to: String },
    NotFound(String),
    EmptyTranscript,
    SessionNotWritable { session_id: String, status: String },
}

impl fmt::Display for VoiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(err) => write!(f, "voice session I/O failed: {err}"),
            Self::Json(err) => write!(f, "voice session JSON failed: {err}"),
            Self::InvalidMode(mode) => write!(f, "unsupported voice mode: {mode}"),
            Self::InvalidStatus(status) => write!(f, "unsupported voice status: {status}"),
            Self::InvalidSessionId(session_id) => {
                write!(f, "invalid voice session id: {session_id}")
            }
            Self::InvalidTimestamp { field, value } => {
                write!(f, "invalid {field} timestamp: {value}")
            }
            Self::InvalidStatusTransition { from, to } => {
                write!(f, "cannot transition voice session from {from} to {to}")
            }
            Self::NotFound(id) => write!(f, "voice session not found: {id}"),
            Self::EmptyTranscript => write!(f, "transcript text cannot be empty"),
            Self::SessionNotWritable { session_id, status } => write!(
                f,
                "voice session {session_id} is {status}; resume it before appending transcript"
            ),
        }
    }
}

impl std::error::Error for VoiceError {}

impl From<std::io::Error> for VoiceError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for VoiceError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceSessionMode {
    QuickNote,
    Solo,
    OneOnOne,
    Group,
    Dump,
}

impl VoiceSessionMode {
    pub fn parse(raw: Option<&str>) -> Result<Self, VoiceError> {
        let normalized = raw.unwrap_or("solo").trim().to_lowercase();
        match normalized.as_str() {
            "" | "solo" | "thinking" | "solo-thinking" => Ok(Self::Solo),
            "quick-note" | "quick" | "note" | "voice-note" => Ok(Self::QuickNote),
            "1:1" | "one-on-one" | "one_on_one" | "1on1" => Ok(Self::OneOnOne),
            "group" | "meeting" | "group-meeting" => Ok(Self::Group),
            "dump" | "passive-dump" | "passive" => Ok(Self::Dump),
            other => Err(VoiceError::InvalidMode(other.to_string())),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::QuickNote => "quick-note",
            Self::Solo => "solo",
            Self::OneOnOne => "one-on-one",
            Self::Group => "group",
            Self::Dump => "dump",
        }
    }

    fn default_title(&self) -> &'static str {
        match self {
            Self::QuickNote => "Quick voice note",
            Self::Solo => "Solo thinking session",
            Self::OneOnOne => "1:1 session",
            Self::Group => "Group session",
            Self::Dump => "Passive voice dump",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VoiceSessionStatus {
    Active,
    Paused,
    Complete,
}

impl VoiceSessionStatus {
    pub fn parse(raw: &str) -> Result<Self, VoiceError> {
        match raw.trim().to_lowercase().as_str() {
            "active" => Ok(Self::Active),
            "paused" | "pause" => Ok(Self::Paused),
            "complete" | "completed" | "done" => Ok(Self::Complete),
            other => Err(VoiceError::InvalidStatus(other.to_string())),
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Paused => "paused",
            Self::Complete => "complete",
        }
    }

    fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::Active, Self::Active)
                | (Self::Active, Self::Paused)
                | (Self::Active, Self::Complete)
                | (Self::Paused, Self::Paused)
                | (Self::Paused, Self::Active)
                | (Self::Paused, Self::Complete)
                | (Self::Complete, Self::Complete)
        )
    }

    fn is_writable(self) -> bool {
        matches!(self, Self::Active)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceEvidenceAnchor {
    pub chunk_index: usize,
    pub line_start: usize,
    pub line_end: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceProjectionItem {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub done: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub evidence: Vec<VoiceEvidenceAnchor>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceProjection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub key_points: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub decisions: Vec<VoiceProjectionItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub action_items: Vec<VoiceProjectionItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub follow_ups: Vec<VoiceProjectionItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub open_questions: Vec<VoiceProjectionItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub candidate_ideas: Vec<VoiceProjectionItem>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub thought_threads: Vec<VoiceProjectionItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceSession {
    pub id: String,
    pub title: String,
    pub mode: VoiceSessionMode,
    pub status: VoiceSessionStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_block_id: Option<String>,
    pub transcript_attachment_name: String,
    pub metadata_attachment_name: String,
    pub transcript_path: String,
    pub metadata_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_attachment_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio_path: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub transcript_chunks: usize,
    pub transcript_lines: usize,
    pub transcript_words: usize,
    #[serde(default)]
    pub projection: VoiceProjection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateVoiceSessionInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_block_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppendVoiceTranscriptInput {
    pub session_id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateVoiceSessionStatusInput {
    pub session_id: String,
    pub status: String,
}

fn attachments_dir(attachments_path: &Path) -> PathBuf {
    attachments_path.to_path_buf()
}

fn metadata_filename(session_id: &str) -> String {
    format!("{SESSION_PREFIX}{session_id}{JSON_SUFFIX}")
}

fn transcript_filename(session_id: &str) -> String {
    format!("{TRANSCRIPT_PREFIX}{session_id}{MARKDOWN_SUFFIX}")
}

fn metadata_path(attachments_path: &Path, session_id: &str) -> PathBuf {
    attachments_dir(attachments_path).join(metadata_filename(session_id))
}

fn transcript_path(attachments_path: &Path, session_id: &str) -> PathBuf {
    attachments_dir(attachments_path).join(transcript_filename(session_id))
}

fn ensure_attachments_dir(attachments_path: &Path) -> Result<PathBuf, VoiceError> {
    let dir = attachments_dir(attachments_path);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn session_locks() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    SESSION_LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn session_lock(session_id: &str) -> Arc<Mutex<()>> {
    let mut locks = session_locks()
        .lock()
        .expect("voice session lock registry poisoned");
    locks
        .entry(session_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

fn validate_session_id(session_id: &str) -> Result<(), VoiceError> {
    Uuid::parse_str(session_id)
        .map(|_| ())
        .map_err(|_| VoiceError::InvalidSessionId(session_id.to_string()))
}

fn normalize_timestamp(
    value: Option<&str>,
    field: &'static str,
) -> Result<Option<String>, VoiceError> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            DateTime::parse_from_rfc3339(value)
                .map(|timestamp| timestamp.to_rfc3339())
                .map_err(|_| VoiceError::InvalidTimestamp {
                    field,
                    value: value.to_string(),
                })
        })
        .transpose()
}

fn yaml_quoted(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

fn sanitize_markdown_single_line(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut pending_space = false;

    for ch in value.trim().chars() {
        let replacement = if ch.is_control() {
            Some(' ')
        } else if matches!(ch, '\n' | '\r' | '\t') {
            Some(' ')
        } else {
            None
        };

        if let Some(space) = replacement {
            if !pending_space && !out.is_empty() {
                out.push(space);
                pending_space = true;
            }
            continue;
        }

        out.push(ch);
        pending_space = false;
    }

    if out.is_empty() {
        "untitled".to_string()
    } else {
        out
    }
}

fn sanitize_marker_value(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut pending_dash = false;

    for ch in value.trim().chars() {
        if ch.is_whitespace() || ch.is_control() {
            if !pending_dash && !out.is_empty() {
                out.push('-');
                pending_dash = true;
            }
            continue;
        }

        let safe = match ch {
            '[' | ']' | '{' | '}' | '<' | '>' | '`' => '-',
            _ => ch,
        };

        if safe == '-' && (pending_dash || out.is_empty()) {
            continue;
        }

        out.push(safe);
        pending_dash = safe == '-';
    }

    if out.is_empty() {
        "unknown".to_string()
    } else {
        out
    }
}

fn render_session_header(session: &VoiceSession) -> String {
    let source_block = session.source_block_id.as_deref().unwrap_or("");
    let safe_title = sanitize_markdown_single_line(&session.title);
    format!(
        concat!(
            "---\n",
            "id: {id}\n",
            "title: {title}\n",
            "mode: {mode}\n",
            "status: {status}\n",
            "createdAt: {created_at}\n",
            "updatedAt: {updated_at}\n",
            "sourceBlockId: {source_block}\n",
            "---\n\n",
            "# {safe_title}\n\n",
            "- [voice::session] [session::{session_id}] [mode::{mode_tag}] [status::{status_tag}]\n\n",
            "## Transcript\n"
        ),
        id = yaml_quoted(&session.id),
        title = yaml_quoted(&session.title),
        mode = yaml_quoted(session.mode.as_str()),
        status = yaml_quoted(session.status.as_str()),
        created_at = yaml_quoted(&session.created_at),
        updated_at = yaml_quoted(&session.updated_at),
        source_block = yaml_quoted(source_block),
        safe_title = safe_title,
        session_id = session.id,
        mode_tag = session.mode.as_str(),
        status_tag = session.status.as_str(),
    )
}

fn render_transcript_chunk(
    input: &AppendVoiceTranscriptInput,
    chunk_index: usize,
    now: &str,
) -> String {
    let kind = sanitize_marker_value(input.kind.as_deref().unwrap_or("transcript"));
    let speaker_tag = input
        .speaker
        .as_deref()
        .filter(|speaker| !speaker.trim().is_empty())
        .map(|speaker| format!(" [speaker::{}]", sanitize_marker_value(speaker)))
        .unwrap_or_default();
    let started_tag = input
        .started_at
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!(" [started::{}]", sanitize_marker_value(value)))
        .unwrap_or_default();
    let ended_tag = input
        .ended_at
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!(" [ended::{}]", sanitize_marker_value(value)))
        .unwrap_or_default();

    format!(
        "\n### Chunk {chunk_index} @ {now} [chunk::{kind}]{speaker_tag}{started_tag}{ended_tag}\n\n{text}\n",
        text = input.text.trim()
    )
}

fn transcript_stats(transcript_path: &Path) -> Result<(usize, usize, usize), VoiceError> {
    if !transcript_path.exists() {
        return Err(VoiceError::NotFound(
            transcript_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("unknown")
                .to_string(),
        ));
    }

    let transcript = fs::read_to_string(transcript_path)?;
    let mut chunks = 0;
    let mut lines = 0;
    let mut words = 0;
    let mut saw_chunk = false;
    let mut skip_leading_blank = false;

    let mut lines_iter = transcript.lines().peekable();
    while let Some(line) = lines_iter.next() {
        if line.starts_with("### Chunk ") {
            chunks += 1;
            saw_chunk = true;
            skip_leading_blank = true;
            continue;
        }

        if !saw_chunk {
            continue;
        }

        if skip_leading_blank && line.is_empty() {
            skip_leading_blank = false;
            continue;
        }

        skip_leading_blank = false;
        if line.is_empty()
            && lines_iter
                .peek()
                .map(|next| next.starts_with("### Chunk "))
                .unwrap_or(true)
        {
            continue;
        }
        lines += 1;
        words += line.split_whitespace().count();
    }

    Ok((chunks, lines, words))
}

fn reconcile_session_stats(
    attachments_path: &Path,
    session: &mut VoiceSession,
) -> Result<bool, VoiceError> {
    let transcript_path = transcript_path(attachments_path, &session.id);
    let (chunks, lines, words) = transcript_stats(&transcript_path)?;
    let changed = session.transcript_chunks != chunks
        || session.transcript_lines != lines
        || session.transcript_words != words;

    if changed {
        session.transcript_chunks = chunks;
        session.transcript_lines = lines;
        session.transcript_words = words;
        session.updated_at = Utc::now().to_rfc3339();
    }

    Ok(changed)
}

fn write_session_json(path: &Path, session: &VoiceSession) -> Result<(), VoiceError> {
    let json = serde_json::to_string_pretty(session)?;
    let temp_path = path.with_extension("json.tmp");
    fs::write(&temp_path, json)?;
    fs::rename(temp_path, path)?;
    Ok(())
}

fn read_session_json(path: &Path) -> Result<VoiceSession, VoiceError> {
    if !path.exists() {
        return Err(VoiceError::NotFound(
            path.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("unknown")
                .to_string(),
        ));
    }
    let json = fs::read_to_string(path)?;
    Ok(serde_json::from_str(&json)?)
}

pub fn create_voice_session(
    attachments_path: &Path,
    input: CreateVoiceSessionInput,
) -> Result<VoiceSession, VoiceError> {
    ensure_attachments_dir(attachments_path)?;

    let mode = VoiceSessionMode::parse(input.mode.as_deref())?;
    let now = Utc::now().to_rfc3339();
    let id = Uuid::new_v4().to_string();
    let title = input
        .title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            format!(
                "{} {}",
                mode.default_title(),
                Utc::now().format("%Y-%m-%d %H:%M")
            )
        });

    let transcript_attachment_name = transcript_filename(&id);
    let metadata_attachment_name = metadata_filename(&id);
    let transcript_path = transcript_path(attachments_path, &id);
    let metadata_path = metadata_path(attachments_path, &id);

    let session = VoiceSession {
        id,
        title,
        mode,
        status: VoiceSessionStatus::Active,
        source_block_id: input.source_block_id,
        transcript_attachment_name,
        metadata_attachment_name,
        transcript_path: transcript_path.display().to_string(),
        metadata_path: metadata_path.display().to_string(),
        audio_attachment_name: None,
        audio_path: None,
        created_at: now.clone(),
        updated_at: now,
        transcript_chunks: 0,
        transcript_lines: 0,
        transcript_words: 0,
        projection: VoiceProjection::default(),
    };

    fs::write(&transcript_path, render_session_header(&session))?;
    write_session_json(&metadata_path, &session)?;

    Ok(session)
}

pub fn get_voice_session(config_path: &Path, session_id: &str) -> Result<VoiceSession, VoiceError> {
    validate_session_id(session_id)?;
    let lock = session_lock(session_id);
    let _guard = lock.lock().expect("voice session mutex poisoned");

    let metadata_path = metadata_path(config_path, session_id);
    let mut session = read_session_json(&metadata_path)?;
    if reconcile_session_stats(config_path, &mut session)? {
        write_session_json(&metadata_path, &session)?;
    }

    Ok(session)
}

pub fn list_voice_sessions(
    attachments_path: &Path,
    limit: Option<usize>,
) -> Result<Vec<VoiceSession>, VoiceError> {
    let dir = attachments_dir(attachments_path);
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut sessions = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let file_name = file_name.to_string_lossy();
        if !file_name.starts_with(SESSION_PREFIX) || !file_name.ends_with(JSON_SUFFIX) {
            continue;
        }

        let path = entry.path();
        let json = match fs::read_to_string(&path) {
            Ok(json) => json,
            Err(_) => continue,
        };
        let session = match serde_json::from_str::<VoiceSession>(&json) {
            Ok(session) => session,
            Err(_) => continue,
        };
        sessions.push(session);
    }

    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    if let Some(limit) = limit {
        sessions.truncate(limit);
    }

    Ok(sessions)
}

pub fn append_voice_transcript(
    attachments_path: &Path,
    mut input: AppendVoiceTranscriptInput,
) -> Result<VoiceSession, VoiceError> {
    if input.text.trim().is_empty() {
        return Err(VoiceError::EmptyTranscript);
    }

    ensure_attachments_dir(attachments_path)?;
    validate_session_id(&input.session_id)?;
    input.started_at = normalize_timestamp(input.started_at.as_deref(), "started_at")?;
    input.ended_at = normalize_timestamp(input.ended_at.as_deref(), "ended_at")?;

    let lock = session_lock(&input.session_id);
    let _guard = lock.lock().expect("voice session mutex poisoned");

    let metadata_path = metadata_path(attachments_path, &input.session_id);
    let transcript_path = transcript_path(attachments_path, &input.session_id);
    let mut session = read_session_json(&metadata_path)?;
    let _ = reconcile_session_stats(attachments_path, &mut session)?;

    if !session.status.is_writable() {
        return Err(VoiceError::SessionNotWritable {
            session_id: session.id.clone(),
            status: session.status.as_str().to_string(),
        });
    }

    let now = Utc::now().to_rfc3339();
    let next_chunk_index = session.transcript_chunks + 1;
    let rendered_chunk = render_transcript_chunk(&input, next_chunk_index, &now);

    if !transcript_path.exists() {
        return Err(VoiceError::NotFound(input.session_id.clone()));
    }

    let mut file = OpenOptions::new().append(true).open(&transcript_path)?;
    file.write_all(rendered_chunk.as_bytes())?;

    session.transcript_chunks = next_chunk_index;
    session.transcript_lines += input.text.lines().count();
    session.transcript_words += input.text.split_whitespace().count();
    session.updated_at = now;

    write_session_json(&metadata_path, &session)?;

    Ok(session)
}

pub fn update_voice_session_status(
    attachments_path: &Path,
    input: UpdateVoiceSessionStatusInput,
) -> Result<VoiceSession, VoiceError> {
    ensure_attachments_dir(attachments_path)?;
    validate_session_id(&input.session_id)?;

    let lock = session_lock(&input.session_id);
    let _guard = lock.lock().expect("voice session mutex poisoned");

    let metadata_path = metadata_path(attachments_path, &input.session_id);
    let mut session = read_session_json(&metadata_path)?;
    let _ = reconcile_session_stats(attachments_path, &mut session)?;
    let next_status = VoiceSessionStatus::parse(&input.status)?;

    if !session.status.can_transition_to(next_status) {
        return Err(VoiceError::InvalidStatusTransition {
            from: session.status.as_str().to_string(),
            to: next_status.as_str().to_string(),
        });
    }

    if session.status != next_status {
        session.status = next_status;
        session.updated_at = Utc::now().to_rfc3339();
        write_session_json(&metadata_path, &session)?;
    }

    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::thread;
    use tempfile::tempdir;

    fn test_config_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempdir().expect("tempdir");
        let config_path = dir.path().join("config.toml");
        (dir, config_path)
    }

    #[test]
    fn create_voice_session_writes_files() {
        let (_dir, config_path) = test_config_path();
        let session = create_voice_session(
            &config_path,
            CreateVoiceSessionInput {
                mode: Some("solo".into()),
                title: Some("Thinking through sync".into()),
                source_block_id: Some("block-123".into()),
            },
        )
        .expect("create session");

        assert_eq!(session.mode, VoiceSessionMode::Solo);
        assert!(Path::new(&session.metadata_path).exists());
        assert!(Path::new(&session.transcript_path).exists());

        let transcript = fs::read_to_string(&session.transcript_path).expect("transcript");
        assert!(transcript.contains("Thinking through sync"));
        assert!(transcript.contains("[session::"));
    }

    #[test]
    fn append_voice_transcript_updates_counts() {
        let (_dir, config_path) = test_config_path();
        let session = create_voice_session(
            &config_path,
            CreateVoiceSessionInput {
                mode: Some("group".into()),
                title: Some("Weekly sync".into()),
                source_block_id: None,
            },
        )
        .expect("create session");

        let updated = append_voice_transcript(
            &config_path,
            AppendVoiceTranscriptInput {
                session_id: session.id.clone(),
                text: "Decision: ship the durable transcript layer.\nAction: wire the handler."
                    .into(),
                speaker: Some("evan".into()),
                started_at: Some("2026-04-01T13:02:00Z".into()),
                ended_at: Some("2026-04-01T13:03:00Z".into()),
                kind: Some("transcript".into()),
            },
        )
        .expect("append transcript");

        assert_eq!(updated.transcript_chunks, 1);
        assert_eq!(updated.transcript_lines, 2);
        assert!(updated.transcript_words >= 9);

        let transcript = fs::read_to_string(&updated.transcript_path).expect("transcript");
        assert!(transcript.contains("[speaker::evan]"));
        assert!(transcript.contains("Decision: ship the durable transcript layer."));
    }

    #[test]
    fn append_voice_transcript_validates_timestamps() {
        let (_dir, config_path) = test_config_path();
        let session = create_voice_session(
            &config_path,
            CreateVoiceSessionInput {
                mode: Some("group".into()),
                title: Some("Weekly sync".into()),
                source_block_id: None,
            },
        )
        .expect("create session");

        let err = append_voice_transcript(
            &config_path,
            AppendVoiceTranscriptInput {
                session_id: session.id,
                text: "Malformed timestamp".into(),
                speaker: None,
                started_at: Some("not-a-timestamp".into()),
                ended_at: None,
                kind: Some("transcript".into()),
            },
        )
        .expect_err("invalid timestamps should be rejected");

        assert!(matches!(
            err,
            VoiceError::InvalidTimestamp { field, .. } if field == "started_at"
        ));
    }

    #[test]
    fn append_voice_transcript_requires_active_session() {
        let (_dir, config_path) = test_config_path();
        let session = create_voice_session(
            &config_path,
            CreateVoiceSessionInput {
                mode: Some("solo".into()),
                title: Some("Solo session".into()),
                source_block_id: None,
            },
        )
        .expect("create session");

        let paused = update_voice_session_status(
            &config_path,
            UpdateVoiceSessionStatusInput {
                session_id: session.id.clone(),
                status: "paused".into(),
            },
        )
        .expect("pause session");
        assert_eq!(paused.status, VoiceSessionStatus::Paused);

        let err = append_voice_transcript(
            &config_path,
            AppendVoiceTranscriptInput {
                session_id: session.id.clone(),
                text: "This should be rejected".into(),
                speaker: None,
                started_at: None,
                ended_at: None,
                kind: None,
            },
        )
        .expect_err("append should fail for paused sessions");

        assert!(matches!(
            err,
            VoiceError::SessionNotWritable {
                status,
                ..
            } if status == "paused"
        ));
    }

    #[test]
    fn update_voice_session_status_enforces_lifecycle() {
        let (_dir, config_path) = test_config_path();
        let session = create_voice_session(
            &config_path,
            CreateVoiceSessionInput {
                mode: Some("group".into()),
                title: Some("Weekly sync".into()),
                source_block_id: None,
            },
        )
        .expect("create session");

        let paused = update_voice_session_status(
            &config_path,
            UpdateVoiceSessionStatusInput {
                session_id: session.id.clone(),
                status: "paused".into(),
            },
        )
        .expect("pause session");
        assert_eq!(paused.status, VoiceSessionStatus::Paused);

        let resumed = update_voice_session_status(
            &config_path,
            UpdateVoiceSessionStatusInput {
                session_id: session.id.clone(),
                status: "active".into(),
            },
        )
        .expect("resume session");
        assert_eq!(resumed.status, VoiceSessionStatus::Active);

        let completed = update_voice_session_status(
            &config_path,
            UpdateVoiceSessionStatusInput {
                session_id: session.id.clone(),
                status: "complete".into(),
            },
        )
        .expect("complete session");
        assert_eq!(completed.status, VoiceSessionStatus::Complete);

        let err = update_voice_session_status(
            &config_path,
            UpdateVoiceSessionStatusInput {
                session_id: session.id,
                status: "active".into(),
            },
        )
        .expect_err("completed sessions should not resume");

        assert!(matches!(
            err,
            VoiceError::InvalidStatusTransition { from, to }
            if from == "complete" && to == "active"
        ));
    }

    #[test]
    fn voice_session_rejects_invalid_session_ids() {
        let (_dir, config_path) = test_config_path();

        let err = get_voice_session(&config_path, "../not-a-uuid")
            .expect_err("invalid session ids should fail");

        assert!(matches!(err, VoiceError::InvalidSessionId(_)));
    }

    #[test]
    fn append_voice_transcript_fails_if_transcript_file_is_missing() {
        let (_dir, config_path) = test_config_path();
        let session = create_voice_session(
            &config_path,
            CreateVoiceSessionInput {
                mode: Some("solo".into()),
                title: Some("Transcript missing".into()),
                source_block_id: None,
            },
        )
        .expect("create session");

        fs::remove_file(&session.transcript_path).expect("remove transcript");

        let err = append_voice_transcript(
            &config_path,
            AppendVoiceTranscriptInput {
                session_id: session.id,
                text: "Should not recreate transcript".into(),
                speaker: None,
                started_at: None,
                ended_at: None,
                kind: None,
            },
        )
        .expect_err("missing transcript should fail");

        assert!(matches!(err, VoiceError::NotFound(_)));
    }

    #[test]
    fn append_voice_transcript_serializes_concurrent_appends() {
        let (_dir, config_path) = test_config_path();
        let session = create_voice_session(
            &config_path,
            CreateVoiceSessionInput {
                mode: Some("solo".into()),
                title: Some("Concurrent appends".into()),
                source_block_id: None,
            },
        )
        .expect("create session");

        let config_path = Arc::new(config_path);
        let session_id = session.id.clone();
        let mut threads = Vec::new();

        for idx in 0..4 {
            let config_path = Arc::clone(&config_path);
            let session_id = session_id.clone();
            threads.push(thread::spawn(move || {
                append_voice_transcript(
                    &config_path,
                    AppendVoiceTranscriptInput {
                        session_id,
                        text: format!("Chunk {idx}"),
                        speaker: None,
                        started_at: None,
                        ended_at: None,
                        kind: Some("transcript".into()),
                    },
                )
            }));
        }

        for handle in threads {
            handle
                .join()
                .expect("thread join")
                .expect("append transcript");
        }

        let final_session = get_voice_session(&config_path, &session.id).expect("final session");
        assert_eq!(final_session.transcript_chunks, 4);
        assert_eq!(final_session.transcript_lines, 4);

        let transcript = fs::read_to_string(&final_session.transcript_path).expect("transcript");
        assert_eq!(transcript.matches("\n### Chunk ").count(), 4);
        for chunk_number in 1..=4 {
            assert_eq!(
                transcript
                    .matches(&format!("### Chunk {chunk_number} @"))
                    .count(),
                1
            );
        }
    }

    #[test]
    fn renderers_sanitize_embedded_metadata() {
        let session = VoiceSession {
            id: Uuid::new_v4().to_string(),
            title: "Bad\nTitle".into(),
            mode: VoiceSessionMode::Solo,
            status: VoiceSessionStatus::Active,
            source_block_id: Some("block]\n123".into()),
            transcript_attachment_name: "voice-transcript.md".into(),
            metadata_attachment_name: "voice-session.json".into(),
            transcript_path: "/tmp/voice-transcript.md".into(),
            metadata_path: "/tmp/voice-session.json".into(),
            audio_attachment_name: None,
            audio_path: None,
            created_at: "2026-04-01T13:02:00Z".into(),
            updated_at: "2026-04-01T13:02:00Z".into(),
            transcript_chunks: 0,
            transcript_lines: 0,
            transcript_words: 0,
            projection: VoiceProjection::default(),
        };

        let header = render_session_header(&session);
        assert!(header.contains("title: \"Bad\\nTitle\""));
        assert!(header.contains("# Bad Title"));
        assert!(header.contains("sourceBlockId: \"block]\\n123\""));

        let chunk = render_transcript_chunk(
            &AppendVoiceTranscriptInput {
                session_id: session.id,
                text: "Hello".into(),
                speaker: Some("evan]\ncase".into()),
                started_at: Some("2026-04-01T13:02:00Z".into()),
                ended_at: Some("2026-04-01T13:03:00Z".into()),
                kind: Some("raw dump".into()),
            },
            1,
            "2026-04-01T13:03:00Z",
        );

        assert!(chunk.contains("[chunk::raw-dump]"));
        assert!(chunk.contains("[speaker::evan-case]"));
    }
}
