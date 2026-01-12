//! WebSocket endpoint for real-time Y.Doc sync.
//!
//! Clients connect to /ws and receive Y.Doc updates as they happen.
//! Updates are broadcast when POST /api/v1/update is called.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Response,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::sync::Arc;
use tokio::sync::broadcast;

/// Message format for WebSocket broadcasts
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BroadcastMessage {
    /// Transaction ID from the sender (for echo prevention)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tx_id: Option<String>,
    /// Base64-encoded Y.Doc update bytes
    pub data: String,
}

/// Shared state for WebSocket broadcasting
#[derive(Clone)]
pub struct WsBroadcaster {
    /// Channel for broadcasting Y.Doc updates to all connected clients
    tx: broadcast::Sender<BroadcastMessage>,
}

impl WsBroadcaster {
    /// Create a new broadcaster with the given channel capacity
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self { tx }
    }

    /// Broadcast a Y.Doc update to all connected clients
    pub fn broadcast(&self, update: Vec<u8>, tx_id: Option<String>) {
        let update_len = update.len();
        let msg = BroadcastMessage {
            tx_id,
            data: BASE64.encode(&update),
        };
        match self.tx.send(msg) {
            Ok(receiver_count) => {
                if receiver_count > 0 {
                    tracing::trace!("Broadcast {} bytes to {} client(s)", update_len, receiver_count);
                }
            }
            Err(_) => {
                // No receivers connected - this is expected when no WebSocket clients
                // are connected. Only log at trace level to avoid noise.
                tracing::trace!("Broadcast skipped (no WebSocket clients connected)");
            }
        }
    }

    /// Subscribe to updates (called by each WebSocket connection)
    fn subscribe(&self) -> broadcast::Receiver<BroadcastMessage> {
        self.tx.subscribe()
    }
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
