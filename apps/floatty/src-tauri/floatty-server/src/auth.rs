//! API key authentication middleware for floatty-server.

use axum::{
    body::Body,
    extract::{ConnectInfo, Request, State},
    http::{header::AUTHORIZATION, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::net::SocketAddr;

/// API key authentication state
#[derive(Clone)]
pub struct ApiKeyAuth {
    api_key: String,
}

impl ApiKeyAuth {
    /// Create a new API key auth with the given key
    pub fn new(api_key: String) -> Self {
        Self { api_key }
    }

    /// Get the expected API key
    pub fn key(&self) -> &str {
        &self.api_key
    }
}

/// Middleware function that validates Bearer token
pub async fn auth_middleware(
    State(auth): State<ApiKeyAuth>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    request: Request<Body>,
    next: Next,
) -> Response {
    // Skip auth for health endpoint
    if request.uri().path() == "/api/v1/health" {
        return next.run(request).await;
    }

    // Skip auth for CORS preflight (OPTIONS) requests
    // CorsLayer handles these; auth would block with 401
    if request.method() == axum::http::Method::OPTIONS {
        return next.run(request).await;
    }

    // Skip auth for localhost connections (127.0.0.1 or ::1)
    // Remote access still requires API key
    if addr.ip().is_loopback() {
        return next.run(request).await;
    }

    // Extract and validate Authorization header
    let auth_header = request
        .headers()
        .get(AUTHORIZATION)
        .and_then(|h| h.to_str().ok());

    match auth_header {
        Some(header) if header.starts_with("Bearer ") => {
            let token = &header[7..];
            if token == auth.key() {
                next.run(request).await
            } else {
                (StatusCode::UNAUTHORIZED, "Invalid API key").into_response()
            }
        }
        Some(_) => (StatusCode::UNAUTHORIZED, "Invalid Authorization header format").into_response(),
        None => (StatusCode::UNAUTHORIZED, "Missing Authorization header").into_response(),
    }
}
