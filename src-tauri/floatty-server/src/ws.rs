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
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::broadcast;

/// Shared state for WebSocket broadcasting
#[derive(Clone)]
pub struct WsBroadcaster {
    /// Channel for broadcasting Y.Doc updates to all connected clients
    tx: broadcast::Sender<Vec<u8>>,
}

impl WsBroadcaster {
    /// Create a new broadcaster with the given channel capacity
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity);
        Self { tx }
    }

    /// Broadcast a Y.Doc update to all connected clients
    pub fn broadcast(&self, update: Vec<u8>) {
        let update_len = update.len();
        match self.tx.send(update) {
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
    fn subscribe(&self) -> broadcast::Receiver<Vec<u8>> {
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
        while let Ok(update) = rx.recv().await {
            // Send as binary message (Y.Doc update bytes)
            if sender.send(Message::Binary(update.into())).await.is_err() {
                break; // Client disconnected
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
