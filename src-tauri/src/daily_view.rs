//! Daily note view extraction using Ollama structured output.
//!
//! Extracts structured data from daily notes (timelogs, scattered thoughts)
//! using LLM with JSON schema constraint.

use chrono::{Duration, Local};
use ollama_rs::{
    generation::completion::request::GenerationRequest,
    generation::parameters::{FormatType, JsonStructure},
    Ollama,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::config::AggregatorConfig;

/// PR reference with status.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct PrInfo {
    /// PR number
    pub num: i32,
    /// Status: "open", "merged", or "closed"
    pub status: String,
}

/// A single timelog entry from a daily note.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct TimelogEntry {
    /// Time of the entry (e.g., "09:30am", "2:15pm – 3:00pm")
    pub time: String,
    /// Project name (e.g., "floatty", "float-infra")
    pub project: Option<String>,
    /// Mode/type (e.g., "shipped", "spike", "maintenance", "meeting")
    pub mode: Option<String>,
    /// Issue reference (e.g., "FLO-102")
    pub issue: Option<String>,
    /// Meeting name if this is a meeting entry
    pub meeting: Option<String>,
    /// Brief summary of what happened
    pub summary: String,
    /// Bullet point details (from sub-bullets)
    #[serde(default)]
    pub details: Vec<String>,
    /// Phase descriptions (e.g., "Phase 1: Setup database")
    #[serde(default)]
    pub phases: Vec<String>,
    /// PR references
    #[serde(default)]
    pub prs: Vec<PrInfo>,
}

/// Scattered thought / note.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ScatteredThought {
    /// Title or heading
    pub title: String,
    /// Content/body
    pub content: String,
}

/// Summary stats for the day.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DayStats {
    /// Number of work sessions
    pub sessions: i32,
    /// Total hours worked (e.g., "8h", "6.5h")
    pub hours: String,
    /// Number of PRs mentioned
    pub prs: i32,
}

/// Structured data extracted from a daily note.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct DailyNoteData {
    /// The date of the daily note (YYYY-MM-DD)
    pub date: String,
    /// Day of week (e.g., "Saturday")
    pub day_of_week: String,
    /// Summary statistics
    pub stats: DayStats,
    /// Extracted timelog entries
    pub timelogs: Vec<TimelogEntry>,
    /// Scattered thoughts / notes section
    #[serde(default)]
    pub scattered_thoughts: Vec<ScatteredThought>,
}

/// Resolve date argument to file path.
///
/// - "today" → current date
/// - "yesterday" → yesterday's date
/// - "2026-01-03" → that date
pub fn resolve_daily_path(date_arg: &str) -> String {
    let date = match date_arg.to_lowercase().as_str() {
        "today" => Local::now().format("%Y-%m-%d").to_string(),
        "yesterday" => {
            (Local::now() - Duration::days(1))
                .format("%Y-%m-%d")
                .to_string()
        }
        other => other.to_string(),
    };

    // Use dirs crate for home directory (same as config.rs)
    let home = dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "/tmp".to_string());

    format!("{}/.evans-notes/daily/{}.md", home, date)
}

/// Extract structured data from daily note content using Ollama.
async fn extract_daily_data(content: &str, date: &str) -> Result<DailyNoteData, String> {
    let config = AggregatorConfig::load();

    // Parse endpoint
    let url = url::Url::parse(&config.ollama_endpoint).map_err(|e| e.to_string())?;
    let scheme = url.scheme();
    let host = url.host_str().unwrap_or("localhost");
    let port = url.port().unwrap_or(11434);
    let host_with_scheme = format!("{}://{}", scheme, host);

    log::info!(
        "daily:: extracting from date={} on {}:{} model={}",
        date,
        host_with_scheme,
        port,
        &config.ollama_model
    );

    let ollama = Ollama::new(host_with_scheme, port);

    // Build prompt with schema hint
    let prompt = format!(
        "Extract structured data from this daily note for date {}.

EXTRACTION RULES:

1. Timelogs: Look in the timelog section for entries formatted as:
   - TIME - [tag::value] description text

   Example: - 06:33pm - [project::floatctl-rs] PR review fixes: addressed CodeRabbit issues

   For each entry extract:
   - time: Just the time part (e.g., 06:33pm)
   - project: Value from [project::X] tag, or null
   - mode: Value from [mode::X] tag, or null
   - issue: Issue references like FLO-102
   - meeting: Value from [meeting::X] tag, or null
   - summary: EVERYTHING after the tags to end of line (this is the important part!)
   - details: Any sub-bullet points under this entry
   - phases: Lines with Phase N: pattern
   - prs: PR numbers with their status (open/merged/closed)

   IMPORTANT: The summary should contain the full description, not just the time.

2. Stats: Calculate from timelogs
   - sessions: Count of timelog entries
   - hours: Estimate total time worked
   - prs: Count unique PR numbers

3. Scattered thoughts: Look in scattered thoughts section
   - title: The heading
   - content: The body text

Daily note content:
---
{}
---

Return JSON matching the schema. Use {} for day_of_week.",
        date,
        content,
        chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map(|d| d.format("%A").to_string())
            .unwrap_or_else(|_| "Unknown".to_string())
    );

    // Create request with structured JSON output
    let request = GenerationRequest::new(config.ollama_model.clone(), prompt)
        .format(FormatType::StructuredJson(Box::new(
            JsonStructure::new::<DailyNoteData>(),
        )));

    log::info!("daily:: sending request to Ollama...");

    match ollama.generate(request).await {
        Ok(res) => {
            log::info!("daily:: got response ({} chars)", res.response.len());

            // Parse the JSON response
            serde_json::from_str::<DailyNoteData>(&res.response).map_err(|e| {
                log::error!("daily:: JSON parse error: {} response: {}", e, res.response);
                format!("Failed to parse LLM response: {}", e)
            })
        }
        Err(e) => {
            log::error!("daily:: Ollama error: {}", e);
            Err(format!("Ollama error: {}", e))
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// TAURI COMMANDS
// ═══════════════════════════════════════════════════════════════

/// Execute a daily:: block - extract structured data from daily note
///
/// Takes a date argument (e.g., "2026-01-03", "today", "yesterday")
/// Returns structured JSON with timelogs and scattered thoughts.
#[tauri::command]
pub async fn execute_daily_command(date_arg: String) -> Result<DailyNoteData, String> {
    // Resolve date to file path
    let path = resolve_daily_path(&date_arg);
    log::info!("daily:: resolved {} -> {}", date_arg, path);

    // Read file content
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path, e))?;

    // Extract date from path for metadata
    let date = std::path::Path::new(&path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(&date_arg)
        .to_string();

    // Extract structured data via Ollama
    extract_daily_data(&content, &date).await
}
