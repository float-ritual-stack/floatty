//! WebSocket endpoint for real-time Y.Doc sync.
//!
//! Clients connect to /ws and receive Y.Doc updates as they happen.
//! Updates are broadcast when POST /api/v1/update is called.
//!
//! ## Message Format (BroadcastMessage)
//!
//! The server sends JSON messages with three variants. Fields use `skip_serializing_if`
//! so clients MUST null-check before using `seq` or `data`.
//!
//! ### 1. Update Message
//! Normal CRDT update with sequence number for gap detection:
//! ```json
//! { "seq": 417, "txId": "1706789123456-42", "data": "<base64>" }
//! ```
//! - `seq`: Sequence number from persistence (always present)
//! - `txId`: Transaction ID for echo prevention (optional, present when sender provided one)
//! - `data`: Base64-encoded Y.Doc update bytes
//!
//! ### 2. Heartbeat Message
//! Periodic gap-detection signal (every 30s when no updates sent):
//! ```json
//! { "seq": 525 }
//! ```
//! - `seq`: Latest sequence number from server
//! - `data`: **ABSENT** (not null, the field is omitted)
//! - Clients should run gap detection against this seq but NOT apply any update
//!
//! ### 3. Restore/Full-State Message
//! Full Y.Doc replacement (after `/api/v1/restore` or `/api/v1/backup/restore`):
//! ```json
//! { "data": "<base64>" }
//! ```
//! - `seq`: **ABSENT** (pre-restore seq tracking is stale)
//! - `data`: Base64-encoded full Y.Doc state
//! - Clients MUST reset their seq tracking before applying (avoid false gap detection)
//!
//! ## Heartbeat Mechanism
//!
//! Includes a heartbeat mechanism (30s interval) that broadcasts the latest
//! sequence number when no updates have been sent, allowing clients to detect
//! gaps that may have occurred during the non-atomic persist-broadcast window.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::Response,
};
use crate::{OutlineContext, OutlineManager};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use floatty_core::YDocStore;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;

/// Heartbeat interval - broadcast latest seq if no updates sent
const HEARTBEAT_INTERVAL_SECS: u64 = 30;

/// Message format for WebSocket broadcasts
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastMessage {
    /// Sequence number from persistence layer (for gap detection)
    /// None for legacy broadcasts (restore, bulk operations)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seq: Option<i64>,
    /// Transaction ID from the sender (for echo prevention)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tx_id: Option<String>,
    /// Base64-encoded Y.Doc update bytes
    /// None for heartbeat messages (seq-only, triggers gap detection)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    /// Presence: focused block ID (spike for TUI follower)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presence: Option<PresenceInfo>,
}

/// Lightweight presence payload
#[derive(Clone, Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceInfo {
    pub block_id: String,
    pub pane_id: Option<String>,
}

/// Shared state for WebSocket broadcasting
pub struct WsBroadcaster {
    /// Channel for broadcasting Y.Doc updates to all connected clients
    tx: broadcast::Sender<BroadcastMessage>,
    /// Flag to track if any update was broadcast since last heartbeat check
    update_sent_since_heartbeat: AtomicBool,
    /// Last known presence (focused block) — persisted for GET /api/v1/presence
    last_presence: Mutex<Option<PresenceInfo>>,
}

impl WsBroadcaster {
    /// Create a new broadcaster with the given channel capacity
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self {
            tx,
            update_sent_since_heartbeat: AtomicBool::new(false),
            last_presence: Mutex::new(None),
        }
    }

    /// Broadcast a Y.Doc update to all connected clients
    ///
    /// # Arguments
    /// - `update`: Raw Y.Doc update bytes
    /// - `tx_id`: Transaction ID for echo prevention (sender filters its own updates)
    /// - `seq`: Sequence number from persistence layer (for gap detection)
    pub fn broadcast(&self, update: Vec<u8>, tx_id: Option<String>, seq: Option<i64>) {
        let update_len = update.len();
        let msg = BroadcastMessage {
            seq,
            tx_id,
            data: Some(BASE64.encode(&update)),
            presence: None,
        };
        // Mark that we sent an update (heartbeat will skip if true)
        self.update_sent_since_heartbeat.store(true, Ordering::Relaxed);
        match self.tx.send(msg) {
            Ok(receiver_count) => {
                if let Some(s) = seq {
                    tracing::info!("Broadcast {} bytes (seq={}) to {} client(s)", update_len, s, receiver_count);
                } else {
                    tracing::info!("Broadcast {} bytes to {} client(s)", update_len, receiver_count);
                }
            }
            Err(_) => {
                tracing::info!("Broadcast skipped (no WebSocket clients connected)");
            }
        }
    }

    /// Broadcast a heartbeat message with only the latest sequence number.
    /// Used to trigger client gap detection without sending actual data.
    /// Called periodically (every 30s) when no updates have been broadcast.
    pub fn broadcast_heartbeat(&self, seq: i64) {
        let msg = BroadcastMessage {
            seq: Some(seq),
            tx_id: None,
            data: None,
            presence: None,
        };
        match self.tx.send(msg) {
            Ok(receiver_count) => {
                tracing::debug!("Heartbeat seq={} to {} client(s)", seq, receiver_count);
            }
            Err(_) => {
                // No clients connected, heartbeat not needed
            }
        }
    }

    /// Broadcast cursor presence (spike for TUI follower) and persist for GET /api/v1/presence
    pub fn broadcast_presence(&self, block_id: String, pane_id: Option<String>) {
        let info = PresenceInfo { block_id, pane_id };
        if let Ok(mut guard) = self.last_presence.lock() {
            *guard = Some(info.clone());
        }
        let msg = BroadcastMessage {
            seq: None,
            tx_id: None,
            data: None,
            presence: Some(info),
        };
        let _ = self.tx.send(msg);
    }

    /// Get the last known presence (focused block), if any
    pub fn get_last_presence(&self) -> Option<PresenceInfo> {
        self.last_presence.lock().ok()?.clone()
    }

    /// Check and reset the update-sent flag.
    /// Returns true if an update was sent since last check.
    fn check_and_reset_update_flag(&self) -> bool {
        self.update_sent_since_heartbeat.swap(false, Ordering::Relaxed)
    }

    /// Subscribe to updates (called by each WebSocket connection)
    fn subscribe(&self) -> broadcast::Receiver<BroadcastMessage> {
        self.tx.subscribe()
    }
}

/// Start the heartbeat background task.
/// Broadcasts the latest sequence number every 30s if no updates were sent.
/// This allows clients to detect gaps from the non-atomic persist-broadcast window.
pub fn start_heartbeat(broadcaster: Arc<WsBroadcaster>, store: Arc<YDocStore>) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(HEARTBEAT_INTERVAL_SECS));
        // Skip the first tick (fires immediately)
        interval.tick().await;

        loop {
            interval.tick().await;

            // Only send heartbeat if no updates were broadcast since last check
            if broadcaster.check_and_reset_update_flag() {
                continue; // Updates were sent, no heartbeat needed
            }

            // Get latest seq from store
            match store.get_latest_seq() {
                Ok(Some(seq)) => {
                    broadcaster.broadcast_heartbeat(seq);
                }
                Ok(None) => {
                    // No updates in database, nothing to heartbeat
                }
                Err(e) => {
                    tracing::warn!("Heartbeat failed to get latest seq: {}", e);
                }
            }
        }
    });
    tracing::info!("Heartbeat task started (interval: {}s)", HEARTBEAT_INTERVAL_SECS);
}

/// Shared state for the WebSocket route — needs both default broadcaster and OutlineManager
#[derive(Clone)]
pub struct WsState {
    pub default_broadcaster: Arc<WsBroadcaster>,
    pub outline_manager: Arc<OutlineManager>,
}

/// Query params for WebSocket connection
#[derive(serde::Deserialize, Default)]
pub struct WsQuery {
    /// Outline name to subscribe to. Absent or "default" = default outline.
    pub outline: Option<String>,
}

/// WebSocket upgrade handler — supports ?outline={name} for per-outline subscriptions
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(ws_state): State<WsState>,
    Query(query): Query<WsQuery>,
) -> Response {
    let outline_name = query.outline.unwrap_or_else(|| "default".to_string());

    let (broadcaster, outline_ctx) = if outline_name == "default" {
        (Arc::clone(&ws_state.default_broadcaster), None)
    } else {
        match ws_state.outline_manager.get_context(&outline_name) {
            Ok(ctx) => {
                ctx.ensure_hook_system(); // Wire callbacks if needed
                let bc = Arc::clone(&ctx.broadcaster);
                (bc, Some(ctx))
            }
            Err(e) => {
                tracing::warn!("WS connect for unknown outline '{}': {}", outline_name, e);
                (Arc::clone(&ws_state.default_broadcaster), None)
            }
        }
    };

    let outline_for_log = outline_name.clone();
    ws.on_upgrade(move |socket| handle_socket(socket, broadcaster, outline_for_log, outline_ctx))
}

/// Handle an individual WebSocket connection
async fn handle_socket(
    socket: WebSocket,
    broadcaster: Arc<WsBroadcaster>,
    outline: String,
    outline_ctx: Option<Arc<OutlineContext>>,
) {
    // Track active connections for non-default outlines (used by LRU eviction)
    if let Some(ref ctx) = outline_ctx {
        ctx.active_connections.fetch_add(1, Ordering::Relaxed);
    }

    let (mut sender, mut receiver) = socket.split();
    let mut rx = broadcaster.subscribe();

    tracing::info!("WebSocket client connected (outline: {})", outline);

    // Spawn task to forward broadcasts to this client
    let send_task = tokio::spawn(async move {
        // FLO-152: Handle RecvError::Lagged explicitly instead of silently dropping
        loop {
            match rx.recv().await {
                Ok(msg) => {
                    // Send as JSON text message (includes txId for echo prevention)
                    let json = match serde_json::to_string(&msg) {
                        Ok(j) => j,
                        Err(e) => {
                            tracing::error!("Failed to serialize broadcast: {}", e);
                            continue;
                        }
                    };
                    if sender.send(Message::Text(json.into())).await.is_err() {
                        break; // Client disconnected
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    // Client fell behind - warn but continue (will get next available message)
                    tracing::warn!("WebSocket client lagged {} messages, catching up", n);
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    // Broadcaster closed, exit cleanly
                    tracing::debug!("Broadcast channel closed");
                    break;
                }
            }
        }
    });

    // Handle incoming messages (for future bidirectional sync)
    while let Some(msg) = receiver.next().await {
        match msg {
            Ok(Message::Close(_)) => break,
            Ok(Message::Ping(data)) => {
                // Pong is handled automatically by axum
                tracing::trace!("Received ping: {:?}", data);
            }
            Ok(_) => {
                // Currently we don't process incoming messages from clients
                // In the future, clients could push updates here too
            }
            Err(e) => {
                tracing::warn!("WebSocket error: {}", e);
                break;
            }
        }
    }

    // Clean up send task and decrement active connections
    send_task.abort();
    if let Some(ref ctx) = outline_ctx {
        ctx.active_connections.fetch_sub(1, Ordering::Relaxed);
    }
    tracing::info!("WebSocket client disconnected (outline: {})", outline);
}

#[cfg(test)]
mod tests {
    use super::*;

    // ═══════════════════════════════════════════════════════════════
    // BROADCAST MESSAGE SERIALIZATION TESTS (wire format contract)
    // ═══════════════════════════════════════════════════════════════

    #[test]
    fn test_broadcast_message_serialization_heartbeat() {
        // Heartbeat: seq present, no data, no txId
        let msg = BroadcastMessage {
            seq: Some(525),
            tx_id: None,
            data: None,
            presence: None,
        };
        let json = serde_json::to_string(&msg).unwrap();

        assert!(json.contains("\"seq\":525"), "Should have seq field");
        assert!(!json.contains("\"data\""), "Should NOT have data field (skip_serializing_if)");
        assert!(!json.contains("\"txId\""), "Should NOT have txId field");

        // Verify it parses as expected JSON shape
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.get("seq").unwrap(), 525);
        assert!(parsed.get("data").is_none());
        assert!(parsed.get("txId").is_none());
    }

    #[test]
    fn test_broadcast_message_serialization_update() {
        // Normal update: seq + txId + data
        let msg = BroadcastMessage {
            seq: Some(526),
            tx_id: Some("tx-abc".into()),
            data: Some("AQID".into()), // base64
            presence: None,
        };
        let json = serde_json::to_string(&msg).unwrap();

        assert!(json.contains("\"seq\":526"), "Should have seq");
        assert!(json.contains("\"data\":\"AQID\""), "Should have data");
        assert!(json.contains("\"txId\":\"tx-abc\""), "Should have txId");
    }

    #[test]
    fn test_broadcast_message_serialization_restore() {
        // Restore/full-state: data present, no seq (legacy)
        let msg = BroadcastMessage {
            seq: None,
            tx_id: None,
            data: Some("AQID".into()),
            presence: None,
        };
        let json = serde_json::to_string(&msg).unwrap();

        assert!(json.contains("\"data\""), "Should have data field");
        assert!(!json.contains("\"seq\""), "Should NOT have seq field");
        assert!(!json.contains("\"txId\""), "Should NOT have txId field");

        // Verify shape
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(parsed.get("seq").is_none(), "seq should be absent");
        assert_eq!(parsed.get("data").unwrap(), "AQID");
    }

    // ═══════════════════════════════════════════════════════════════
    // HEARTBEAT FLAG LIFECYCLE TEST
    // ═══════════════════════════════════════════════════════════════

    #[test]
    fn test_heartbeat_flag_lifecycle() {
        let broadcaster = WsBroadcaster::new(16);

        // Initially: no updates sent
        assert!(
            !broadcaster.check_and_reset_update_flag(),
            "Flag should be false initially"
        );

        // After broadcast: flag is set
        broadcaster.broadcast(vec![1, 2, 3], None, Some(1));
        assert!(
            broadcaster.check_and_reset_update_flag(),
            "Flag should be true after broadcast"
        );

        // After check_and_reset: flag is cleared
        assert!(
            !broadcaster.check_and_reset_update_flag(),
            "Flag should be false after reset"
        );

        // Multiple broadcasts before check: still just one flag
        broadcaster.broadcast(vec![1], None, Some(2));
        broadcaster.broadcast(vec![2], None, Some(3));
        assert!(
            broadcaster.check_and_reset_update_flag(),
            "Flag should be true after multiple broadcasts"
        );
        assert!(
            !broadcaster.check_and_reset_update_flag(),
            "Flag should be false after second reset"
        );
    }
}
