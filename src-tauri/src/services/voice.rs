//! Durable voice session storage and transcript append logic.
//!
//! Voice sessions are stored as file-backed artifacts under `{data_dir}/__attachments/`
//! so they remain durable outside the outline while still being browsable through the
//! existing attachments HTTP route.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const SESSION_PREFIX: &str = "voice-session-";
const TRANSCRIPT_PREFIX: &str = "voice-transcript-";
const JSON_SUFFIX: &str = ".json";
const MARKDOWN_SUFFIX: &str = ".md";

#[derive(Debug)]
pub enum VoiceError {
    Io(std::io::Error),
    Json(serde_json::Error),
    InvalidMode(String),
    NotFound(String),
    EmptyTranscript,
}

impl fmt::Display for VoiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(err) => write!(f, "voice session I/O failed: {err}"),
            Self::Json(err) => write!(f, "voice session JSON failed: {err}"),
            Self::InvalidMode(mode) => write!(f, "unsupported voice mode: {mode}"),
            Self::NotFound(id) => write!(f, "voice session not found: {id}"),
            Self::EmptyTranscript => write!(f, "transcript text cannot be empty"),
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

fn attachments_dir(config_path: &Path) -> PathBuf {
    config_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("__attachments")
}

fn metadata_filename(session_id: &str) -> String {
    format!("{SESSION_PREFIX}{session_id}{JSON_SUFFIX}")
}

fn transcript_filename(session_id: &str) -> String {
    format!("{TRANSCRIPT_PREFIX}{session_id}{MARKDOWN_SUFFIX}")
}

fn metadata_path(config_path: &Path, session_id: &str) -> PathBuf {
    attachments_dir(config_path).join(metadata_filename(session_id))
}

fn transcript_path(config_path: &Path, session_id: &str) -> PathBuf {
    attachments_dir(config_path).join(transcript_filename(session_id))
}

fn ensure_attachments_dir(config_path: &Path) -> Result<PathBuf, VoiceError> {
    let dir = attachments_dir(config_path);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn render_session_header(session: &VoiceSession) -> String {
    let source_block = session.source_block_id.as_deref().unwrap_or("");
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
            "# {title}\n\n",
            "- [voice::session] [session::{id}] [mode::{mode}] [status::{status}]\n\n",
            "## Transcript\n"
        ),
        id = session.id,
        title = session.title,
        mode = session.mode.as_str(),
        status = match session.status {
            VoiceSessionStatus::Active => "active",
            VoiceSessionStatus::Paused => "paused",
            VoiceSessionStatus::Complete => "complete",
        },
        created_at = session.created_at,
        updated_at = session.updated_at,
        source_block = source_block,
    )
}

fn render_transcript_chunk(
    input: &AppendVoiceTranscriptInput,
    chunk_index: usize,
    now: &str,
) -> String {
    let kind = input.kind.as_deref().unwrap_or("transcript");
    let speaker_tag = input
        .speaker
        .as_deref()
        .filter(|speaker| !speaker.trim().is_empty())
        .map(|speaker| format!(" [speaker::{speaker}]"))
        .unwrap_or_default();
    let started_tag = input
        .started_at
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!(" [started::{value}]"))
        .unwrap_or_default();
    let ended_tag = input
        .ended_at
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(|value| format!(" [ended::{value}]"))
        .unwrap_or_default();

    format!(
        "\n### Chunk {chunk_index} @ {now} [chunk::{kind}]{speaker_tag}{started_tag}{ended_tag}\n\n{text}\n",
        text = input.text.trim()
    )
}

fn write_session_json(path: &Path, session: &VoiceSession) -> Result<(), VoiceError> {
    let json = serde_json::to_string_pretty(session)?;
    fs::write(path, json)?;
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
    config_path: &Path,
    input: CreateVoiceSessionInput,
) -> Result<VoiceSession, VoiceError> {
    ensure_attachments_dir(config_path)?;

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
    let transcript_path = transcript_path(config_path, &id);
    let metadata_path = metadata_path(config_path, &id);

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
    read_session_json(&metadata_path(config_path, session_id))
}

pub fn list_voice_sessions(
    config_path: &Path,
    limit: Option<usize>,
) -> Result<Vec<VoiceSession>, VoiceError> {
    let dir = attachments_dir(config_path);
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
    config_path: &Path,
    input: AppendVoiceTranscriptInput,
) -> Result<VoiceSession, VoiceError> {
    if input.text.trim().is_empty() {
        return Err(VoiceError::EmptyTranscript);
    }

    ensure_attachments_dir(config_path)?;

    let metadata_path = metadata_path(config_path, &input.session_id);
    let transcript_path = transcript_path(config_path, &input.session_id);
    let mut session = read_session_json(&metadata_path)?;

    let now = Utc::now().to_rfc3339();
    let next_chunk_index = session.transcript_chunks + 1;
    let rendered_chunk = render_transcript_chunk(&input, next_chunk_index, &now);

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&transcript_path)?;
    file.write_all(rendered_chunk.as_bytes())?;

    session.updated_at = now;
    session.transcript_chunks = next_chunk_index;
    session.transcript_lines += input.text.lines().count();
    session.transcript_words += input.text.split_whitespace().count();

    write_session_json(&metadata_path, &session)?;

    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
