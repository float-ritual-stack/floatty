/// Tauri command wrappers for durable voice session storage.
use crate::services::voice;
use crate::AppState;
use tauri::State;

#[tauri::command]
pub async fn create_voice_session(
    state: State<'_, AppState>,
    mode: Option<String>,
    title: Option<String>,
    source_block_id: Option<String>,
) -> Result<voice::VoiceSession, String> {
    voice::create_voice_session(
        &state.config_path,
        voice::CreateVoiceSessionInput {
            mode,
            title,
            source_block_id,
        },
    )
    .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn get_voice_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<voice::VoiceSession, String> {
    voice::get_voice_session(&state.config_path, &session_id).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn list_voice_sessions(
    state: State<'_, AppState>,
    limit: Option<usize>,
) -> Result<Vec<voice::VoiceSession>, String> {
    voice::list_voice_sessions(&state.config_path, limit).map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn append_voice_transcript(
    state: State<'_, AppState>,
    session_id: String,
    text: String,
    speaker: Option<String>,
    started_at: Option<String>,
    ended_at: Option<String>,
    kind: Option<String>,
) -> Result<voice::VoiceSession, String> {
    voice::append_voice_transcript(
        &state.config_path,
        voice::AppendVoiceTranscriptInput {
            session_id,
            text,
            speaker,
            started_at,
            ended_at,
            kind,
        },
    )
    .map_err(|err| err.to_string())
}
