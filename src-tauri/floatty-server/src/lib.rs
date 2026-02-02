//! floatty-server: Headless HTTP API for the floatty block store.
//!
//! Exposes floatty-core's YDocStore over REST for external editors.
//!
//! ## Quick Start
//!
//! ```bash
//! # Run the server
//! floatty-server
//!
//! # Test with curl
//! curl -H "Authorization: Bearer $API_KEY" http://localhost:8765/api/v1/health
//! ```

pub mod api;
pub mod auth;
pub mod backup;
pub mod config;
pub mod ws;

pub use api::create_router;
pub use auth::ApiKeyAuth;
pub use backup::{BackupDaemon, BackupInfo, DaemonStatus};
pub use config::{BackupConfig, ServerConfig};
pub use ws::WsBroadcaster;
