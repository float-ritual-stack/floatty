//! Origin enum for tagging the source of Y.Doc mutations.
//!
//! Origin tags prevent infinite hook loops by letting downstream
//! handlers filter events by source. For example, a MetadataHook
//! that writes to block.metadata with Origin::Hook will not trigger
//! other hooks that filter out Hook-originated events.
//!
//! # Usage
//!
//! ```rust,ignore
//! use floatty_core::Origin;
//!
//! // In a hook that writes metadata:
//! fn process_changes(&self, changes: &[BlockChange], store: &YDocStore) {
//!     // Write with Origin::Hook so we don't trigger ourselves
//!     store.update_metadata(id, metadata, Origin::Hook);
//! }
//!
//! // In accepts_origins to filter:
//! fn accepts_origins(&self) -> Option<Vec<Origin>> {
//!     Some(vec![Origin::User, Origin::Remote, Origin::Agent])
//!     // Does NOT include Origin::Hook, preventing loops
//! }
//! ```

use serde::{Deserialize, Serialize};

/// Source of a Y.Doc mutation.
///
/// Used by the hook registry to filter events and prevent infinite loops.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Origin {
    /// Human keystroke, click, or direct interaction.
    #[default]
    User,

    /// System hook (e.g., metadata extraction, indexing).
    /// Hooks that write with Origin::Hook do NOT trigger other hooks.
    Hook,

    /// CRDT sync from server or peer.
    /// Remote updates already have metadata extracted at source.
    Remote,

    /// AI agent action (Claude, other LLMs).
    Agent,

    /// Batch import, paste, or bulk operations.
    /// May need different debounce behavior.
    BulkImport,
}

impl Origin {
    /// Convert to bytes for Y.Doc transaction origin tagging.
    ///
    /// Used with `doc.transact_mut_with(origin.as_bytes())` to tag mutations
    /// with their source, enabling downstream filtering.
    pub fn as_bytes(&self) -> std::sync::Arc<[u8]> {
        std::sync::Arc::from(self.to_string().as_bytes())
    }

    /// Returns true if this origin should trigger metadata extraction hooks.
    ///
    /// Remote and Hook origins are excluded:
    /// - Remote: metadata was already extracted at the source peer
    /// - Hook: prevents infinite loops
    pub fn triggers_metadata_hooks(&self) -> bool {
        matches!(self, Origin::User | Origin::Agent | Origin::BulkImport)
    }

    /// Returns true if this origin should trigger search index updates.
    ///
    /// All origins except Hook should update the local search index.
    /// Remote changes need to be indexed locally even though metadata
    /// was extracted at the source.
    pub fn triggers_index_hooks(&self) -> bool {
        matches!(self, Origin::User | Origin::Remote | Origin::Agent | Origin::BulkImport)
    }
}

impl std::fmt::Display for Origin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Origin::User => write!(f, "user"),
            Origin::Hook => write!(f, "hook"),
            Origin::Remote => write!(f, "remote"),
            Origin::Agent => write!(f, "agent"),
            Origin::BulkImport => write!(f, "bulk_import"),
        }
    }
}

/// Try to parse an origin from a string (e.g., from Y.Doc transaction origin).
impl TryFrom<&str> for Origin {
    type Error = ();

    fn try_from(s: &str) -> Result<Self, Self::Error> {
        match s.to_lowercase().as_str() {
            "user" => Ok(Origin::User),
            "hook" => Ok(Origin::Hook),
            "remote" => Ok(Origin::Remote),
            "agent" => Ok(Origin::Agent),
            "bulk_import" | "bulkimport" | "bulk-import" => Ok(Origin::BulkImport),
            _ => Err(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_origin_equality() {
        assert_eq!(Origin::User, Origin::User);
        assert_ne!(Origin::User, Origin::Hook);
    }

    #[test]
    fn test_origin_copy() {
        let origin = Origin::User;
        let copied = origin; // Copy, not move
        assert_eq!(origin, copied);
    }

    #[test]
    fn test_origin_display() {
        assert_eq!(Origin::User.to_string(), "user");
        assert_eq!(Origin::Hook.to_string(), "hook");
        assert_eq!(Origin::Remote.to_string(), "remote");
        assert_eq!(Origin::Agent.to_string(), "agent");
        assert_eq!(Origin::BulkImport.to_string(), "bulk_import");
    }

    #[test]
    fn test_origin_from_str() {
        assert_eq!(Origin::try_from("user"), Ok(Origin::User));
        assert_eq!(Origin::try_from("USER"), Ok(Origin::User));
        assert_eq!(Origin::try_from("hook"), Ok(Origin::Hook));
        assert_eq!(Origin::try_from("remote"), Ok(Origin::Remote));
        assert_eq!(Origin::try_from("agent"), Ok(Origin::Agent));
        assert_eq!(Origin::try_from("bulk_import"), Ok(Origin::BulkImport));
        assert_eq!(Origin::try_from("bulkimport"), Ok(Origin::BulkImport));
        assert!(Origin::try_from("unknown").is_err());
    }

    #[test]
    fn test_triggers_metadata_hooks() {
        assert!(Origin::User.triggers_metadata_hooks());
        assert!(Origin::Agent.triggers_metadata_hooks());
        assert!(Origin::BulkImport.triggers_metadata_hooks());
        assert!(!Origin::Hook.triggers_metadata_hooks());
        assert!(!Origin::Remote.triggers_metadata_hooks());
    }

    #[test]
    fn test_triggers_index_hooks() {
        assert!(Origin::User.triggers_index_hooks());
        assert!(Origin::Remote.triggers_index_hooks());
        assert!(Origin::Agent.triggers_index_hooks());
        assert!(Origin::BulkImport.triggers_index_hooks());
        assert!(!Origin::Hook.triggers_index_hooks());
    }

    #[test]
    fn test_serde_roundtrip() {
        let origins = vec![
            Origin::User,
            Origin::Hook,
            Origin::Remote,
            Origin::Agent,
            Origin::BulkImport,
        ];

        for origin in origins {
            let json = serde_json::to_string(&origin).unwrap();
            let parsed: Origin = serde_json::from_str(&json).unwrap();
            assert_eq!(origin, parsed);
        }
    }

    #[test]
    fn test_serde_snake_case() {
        // Verify snake_case serialization
        let json = serde_json::to_string(&Origin::BulkImport).unwrap();
        assert_eq!(json, "\"bulk_import\"");

        // Can deserialize from snake_case
        let parsed: Origin = serde_json::from_str("\"bulk_import\"").unwrap();
        assert_eq!(parsed, Origin::BulkImport);
    }
}
