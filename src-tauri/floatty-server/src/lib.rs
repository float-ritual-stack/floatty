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
pub mod config;

pub use api::create_router;
pub use auth::ApiKeyAuth;
pub use config::ServerConfig;
