//! WebSocket endpoint for real-time Y.Doc sync.
//!
//! Clients connect to /ws and receive Y.Doc updates as they happen.
//! Updates are broadcast when POST /api/v1/update is called.
//!
//! Includes a heartbeat mechanism (30s interval) that broadcasts the latest
//! sequence number when no updates have been sent, allowing clients to detect
//! gaps that may have occurred during the non-atomic persist-broadcast window.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Response,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use floatty_core::YDocStore;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
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
}

/// Shared state for WebSocket broadcasting
pub struct WsBroadcaster {
    /// Channel for broadcasting Y.Doc updates to all connected clients
    tx: broadcast::Sender<BroadcastMessage>,
    /// Flag to track if any update was broadcast since last heartbeat check
    update_sent_since_heartbeat: AtomicBool,
}

impl WsBroadcaster {
    /// Create a new broadcaster with the given channel capacity
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self {
            tx,
            update_sent_since_heartbeat: AtomicBool::new(false),
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

/// WebSocket upgrade handler
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(broadcaster): State<Arc<WsBroadcaster>>,
) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, broadcaster))
}

/// Handle an individual WebSocket connection
async fn handle_socket(socket: WebSocket, broadcaster: Arc<WsBroadcaster>) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = broadcaster.subscribe();

    tracing::info!("WebSocket client connected");

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

    // Clean up send task
    send_task.abort();
    tracing::info!("WebSocket client disconnected");
}
