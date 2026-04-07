//! Outline name validation and metadata types.
//!
//! Each outline is an independent Y.Doc backed by its own SQLite file.
//! The "default" outline maps to the legacy `ctx_markers.db` file.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;
use std::time::SystemTime;
use thiserror::Error;

/// Regex: lowercase alphanumeric + hyphens, 1-63 chars, starts with alphanumeric, no trailing hyphen.
static NAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,62}$").unwrap());

/// Errors for outline operations.
#[derive(Error, Debug)]
pub enum OutlineError {
    #[error("invalid outline name: {0}")]
    InvalidName(String),

    #[error("'default' is a reserved outline name")]
    ReservedName,

    #[error("outline '{0}' already exists")]
    AlreadyExists(String),

    #[error("outline '{0}' not found")]
    NotFound(String),

    #[error("store error: {0}")]
    Store(#[from] crate::store::StoreError),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

/// Validated outline name. Cannot be "default" (reserved for legacy outline).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct OutlineName(String);

impl OutlineName {
    /// Validate and create an outline name.
    ///
    /// Rules:
    /// - Lowercase alphanumeric + hyphens only
    /// - 1-63 characters
    /// - Must start with alphanumeric
    /// - No trailing hyphen
    /// - "default" is reserved
    pub fn new(name: &str) -> Result<Self, OutlineError> {
        if name == "default" {
            return Err(OutlineError::ReservedName);
        }
        if name.ends_with('-') {
            return Err(OutlineError::InvalidName(format!(
                "'{name}' must not end with a hyphen"
            )));
        }
        if !NAME_RE.is_match(name) {
            return Err(OutlineError::InvalidName(format!(
                "'{name}' must be 1-63 chars, lowercase alphanumeric + hyphens, start with alphanumeric"
            )));
        }
        Ok(Self(name.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for OutlineName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// Metadata about an outline (for list/get responses).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutlineInfo {
    pub name: String,
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<u64>,
}

impl OutlineInfo {
    /// Build from filesystem metadata.
    pub fn from_path(name: &str, path: &std::path::Path) -> Result<Self, std::io::Error> {
        let meta = std::fs::metadata(path)?;
        Ok(Self {
            name: name.to_string(),
            size_bytes: meta.len(),
            created_at: meta
                .created()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs()),
            modified_at: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_names() {
        assert!(OutlineName::new("travel-plans").is_ok());
        assert!(OutlineName::new("a").is_ok());
        assert!(OutlineName::new("work-log").is_ok());
        assert!(OutlineName::new("my-outline-2026").is_ok());
        assert!(OutlineName::new("0-starts-with-digit").is_ok());
        // Max length: 63 chars
        let long = "a".repeat(63);
        assert!(OutlineName::new(&long).is_ok());
    }

    #[test]
    fn invalid_names() {
        // Empty
        assert!(OutlineName::new("").is_err());
        // Uppercase
        assert!(OutlineName::new("Travel").is_err());
        // Spaces
        assert!(OutlineName::new("my outline").is_err());
        // Starts with hyphen
        assert!(OutlineName::new("-bad").is_err());
        // Trailing hyphen
        assert!(OutlineName::new("bad-").is_err());
        // Too long (64 chars)
        let long = "a".repeat(64);
        assert!(OutlineName::new(&long).is_err());
        // Special chars
        assert!(OutlineName::new("no_underscores").is_err());
        assert!(OutlineName::new("no.dots").is_err());
        assert!(OutlineName::new("no/slashes").is_err());
    }

    #[test]
    fn default_is_reserved() {
        let err = OutlineName::new("default").unwrap_err();
        assert!(matches!(err, OutlineError::ReservedName));
    }

    #[test]
    fn display_and_as_str() {
        let name = OutlineName::new("my-outline").unwrap();
        assert_eq!(name.as_str(), "my-outline");
        assert_eq!(format!("{name}"), "my-outline");
    }
}
