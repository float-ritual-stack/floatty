use crate::db::{CtxDatabase, ParsedCtx};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// Configuration for the Ollama parser
#[derive(Clone, Serialize, Deserialize)]
pub struct ParserConfig {
    pub endpoint: String,
    pub model: String,
    pub system_prompt: String,
    pub timeout_ms: u64,
    pub max_retries: i32,
    pub poll_interval_ms: u64,
}

impl Default for ParserConfig {
    fn default() -> Self {
        Self {
            endpoint: "http://localhost:11434".to_string(),
            model: "qwen2.5:7b".to_string(),
            system_prompt: DEFAULT_SYSTEM_PROMPT.to_string(),
            timeout_ms: 30000,
            max_retries: 3,
            poll_interval_ms: 2000,
        }
    }
}

const DEFAULT_SYSTEM_PROMPT: &str = r#"You extract structured data from text containing ctx:: markers.

A ctx:: marker looks like:
ctx::YYYY-MM-DD @ HH:MM AM/PM [tag::value] [tag::value] optional message

Common tags: project::, mode::, issue::, meeting::

Extract the marker fields AND summarize the surrounding context."#;

const EXAMPLE_INPUT: &str = r#"EXAMPLE INPUT:
Starting investigation on pharmacy issue 120.
- ctx::2025-12-15 @ 10:30 AM [project::pharmacy] [issue::120] beginning fresh investigation
Will check the GP node rendering first.

EXAMPLE OUTPUT:
{"timestamp":"2025-12-15","time":"10:30 AM","project":"pharmacy","issue":"120","summary":"Starting investigation on pharmacy issue 120, planning to check GP node rendering","message":"beginning fresh investigation"}

---
NOW PARSE THIS:

"#;

/// Ollama API request
#[derive(Serialize)]
struct OllamaRequest {
    model: String,
    prompt: String,
    system: String,
    stream: bool,
    format: OllamaFormat,
}

/// Ollama structured output format
#[derive(Serialize)]
struct OllamaFormat {
    #[serde(rename = "type")]
    type_: String,
    properties: OllamaProperties,
    required: Vec<String>,
}

#[derive(Serialize)]
struct OllamaProperties {
    timestamp: OllamaProperty,
    time: OllamaProperty,
    project: OllamaProperty,
    mode: OllamaProperty,
    meeting: OllamaProperty,
    issue: OllamaProperty,
    summary: OllamaProperty,
    message: OllamaProperty,
}

#[derive(Serialize)]
struct OllamaProperty {
    #[serde(rename = "type")]
    type_: String,
}

/// Ollama API response
#[derive(Deserialize)]
struct OllamaResponse {
    response: String,
}

/// Raw parsed response from Ollama (simplified - no tags array)
#[derive(Deserialize)]
struct RawParsedCtx {
    timestamp: Option<String>,
    time: Option<String>,
    project: Option<String>,
    mode: Option<String>,
    meeting: Option<String>,
    issue: Option<String>,
    summary: Option<String>,
    message: Option<String>,
}

/// Background worker for parsing ctx:: markers via Ollama
pub struct CtxParser {
    config: ParserConfig,
    db: Arc<CtxDatabase>,
    client: Client,
    running: Arc<std::sync::Mutex<bool>>,
}

impl CtxParser {
    pub fn new(db: Arc<CtxDatabase>, config: ParserConfig) -> Result<Self, String> {
        let client = Client::builder()
            .timeout(Duration::from_millis(config.timeout_ms))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

        Ok(Self {
            config,
            db,
            client,
            running: Arc::new(std::sync::Mutex::new(false)),
        })
    }

    /// Start the parser worker in a background thread
    /// Safe to call multiple times - will only spawn one thread
    pub fn start(&self) {
        // Guard against duplicate start() calls - only spawn if not already running
        {
            let mut guard = self.running.lock().unwrap_or_else(|e| e.into_inner());
            if *guard {
                log::warn!("ctx:: parser already running, ignoring duplicate start()");
                return;
            }
            *guard = true;
        }

        let db = Arc::clone(&self.db);
        let config = self.config.clone();
        let client = self.client.clone();
        let running = Arc::clone(&self.running);

        thread::spawn(move || {
            log::info!("Starting ctx:: parser worker");

            // Create tokio runtime for async HTTP
            let rt = match tokio::runtime::Runtime::new() {
                Ok(rt) => rt,
                Err(e) => {
                    log::error!("Failed to create tokio runtime for parser: {}", e);
                    log::error!("ctx:: parser will not function - markers will remain pending");
                    return;
                }
            };

            loop {
                if !*running.lock().unwrap_or_else(|e| e.into_inner()) {
                    break;
                }

                // Get pending markers
                match db.get_pending(10) {
                    Ok(markers) if !markers.is_empty() => {
                        log::info!("Processing {} pending markers", markers.len());

                        for marker in markers {
                            let result = rt.block_on(parse_marker(&client, &config, &marker.raw_line));

                            match result {
                                Ok(parsed) => {
                                    match serde_json::to_string(&parsed) {
                                        Ok(json) => {
                                            if let Err(e) = db.update_parsed(&marker.id, &json) {
                                                log::error!("Failed to update marker {}: {}", marker.id, e);
                                            }
                                        }
                                        Err(e) => {
                                            log::error!("Failed to serialize parsed ctx for {}: {}", marker.id, e);
                                            if let Err(e) = db.mark_error(&marker.id) {
                                                log::error!("Failed to mark error: {}", e);
                                            }
                                        }
                                    }
                                }
                                Err(e) => {
                                    log::warn!("Failed to parse marker {}: {}", marker.id, e);
                                    if let Err(e) = db.mark_error(&marker.id) {
                                        log::error!("Failed to mark error: {}", e);
                                    }
                                }
                            }
                        }
                    }
                    Ok(_) => {
                        // No pending markers, check for error retries
                        if let Err(e) = db.reset_errors_for_retry(config.max_retries) {
                            log::error!("Failed to reset errors: {}", e);
                        }
                    }
                    Err(e) => {
                        log::error!("Failed to get pending markers: {}", e);
                    }
                }

                thread::sleep(Duration::from_millis(config.poll_interval_ms));
            }

            log::info!("ctx:: parser worker stopped");
        });
    }

    /// Stop the parser worker
    pub fn stop(&self) {
        *self.running.lock().unwrap_or_else(|e| e.into_inner()) = false;
    }
}

/// Parse a single ctx:: line using Ollama
async fn parse_marker(
    client: &Client,
    config: &ParserConfig,
    raw_line: &str,
) -> Result<ParsedCtx, Box<dyn std::error::Error + Send + Sync>> {
    let format = OllamaFormat {
        type_: "object".to_string(),
        properties: OllamaProperties {
            timestamp: OllamaProperty { type_: "string".to_string() },
            time: OllamaProperty { type_: "string".to_string() },
            project: OllamaProperty { type_: "string".to_string() },
            mode: OllamaProperty { type_: "string".to_string() },
            meeting: OllamaProperty { type_: "string".to_string() },
            issue: OllamaProperty { type_: "string".to_string() },
            summary: OllamaProperty { type_: "string".to_string() },
            message: OllamaProperty { type_: "string".to_string() },
        },
        required: vec!["timestamp".to_string(), "time".to_string(), "summary".to_string()],
    };

    let request = OllamaRequest {
        model: config.model.clone(),
        prompt: format!("{}{}", EXAMPLE_INPUT, raw_line),
        system: config.system_prompt.clone(),
        stream: false,
        format,
    };

    let url = format!("{}/api/generate", config.endpoint);
    let resp = client
        .post(&url)
        .json(&request)
        .send()
        .await
        .map_err(|e| {
            if e.is_connect() {
                format!("Cannot connect to Ollama at {}: {} (is it running?)", url, e)
            } else if e.is_timeout() {
                format!("Timeout connecting to Ollama at {} (try increasing timeout_ms)", url)
            } else {
                format!("HTTP error calling Ollama: {}", e)
            }
        })?;

    // Check HTTP status before parsing
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Ollama returned HTTP {}: {}", status, body).into());
    }

    let resp_text = resp.text().await.map_err(|e| format!("Failed to read response body: {}", e))?;

    // Try to parse as OllamaResponse
    let ollama_resp: OllamaResponse = serde_json::from_str(&resp_text)
        .map_err(|e| format!("Failed to parse Ollama response: {}. Raw: {}", e, &resp_text[..resp_text.len().min(500)]))?;

    // Parse the JSON response from Ollama
    let raw: RawParsedCtx = serde_json::from_str(&ollama_resp.response)
        .map_err(|e| format!("Failed to parse ctx JSON: {}. Raw: {}", e, &ollama_resp.response[..ollama_resp.response.len().min(500)]))?;

    // Convert to our ParsedCtx type (simple 1:1 mapping now)
    let parsed = ParsedCtx {
        timestamp: raw.timestamp,
        time: raw.time,
        project: raw.project,
        mode: raw.mode,
        meeting: raw.meeting,
        issue: raw.issue,
        summary: raw.summary,
        message: raw.message,
    };

    Ok(parsed)
}
