//! Block metadata types for extracted markers, wikilinks, and other derived data.
//!
//! Metadata is populated by hooks that process block content changes.
//! This enables search indexing, backlink tracking, and agent integration.
//!
//! NOTE: These types are exported to TypeScript via ts-rs. Run `cargo run --bin ts-gen`
//! after modifying this file to regenerate bindings.

use serde::{Deserialize, Deserializer, Serialize};
use ts_rs::TS;

/// Accept both integer and float timestamps from yrs deserialization.
/// Legacy Y.Doc data stores extractedAt as f64 (yrs::Any::Number),
/// new data stores as i64 (yrs::Any::BigInt).
fn deserialize_timestamp_lenient<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de;

    struct TimestampVisitor;

    impl<'de> de::Visitor<'de> for TimestampVisitor {
        type Value = Option<i64>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("an integer, float, or null")
        }

        fn visit_i64<E: de::Error>(self, v: i64) -> Result<Self::Value, E> {
            Ok(Some(v))
        }

        fn visit_u64<E: de::Error>(self, v: u64) -> Result<Self::Value, E> {
            Ok(Some(v as i64))
        }

        fn visit_f64<E: de::Error>(self, v: f64) -> Result<Self::Value, E> {
            Ok(Some(v as i64))
        }

        fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }

        fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
    }

    deserializer.deserialize_any(TimestampVisitor)
}

/// A :: marker extracted from block content.
///
/// Examples:
/// - `ctx::` → Marker { marker_type: "ctx", value: None }
/// - `[project::floatty]` → Marker { marker_type: "project", value: Some("floatty") }
/// - `sh::` → Marker { marker_type: "sh", value: None }
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    /// The marker type: "ctx", "project", "mode", "issue", "sh", "ai", etc.
    pub marker_type: String,

    /// Optional value following the marker.
    /// For `[project::floatty]`, value is "floatty".
    /// For bare `ctx::`, value is None.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
}

impl Marker {
    /// Create a new marker with just a type (no value).
    pub fn new(marker_type: impl Into<String>) -> Self {
        Self {
            marker_type: marker_type.into(),
            value: None,
        }
    }

    /// Create a new marker with type and value.
    pub fn with_value(marker_type: impl Into<String>, value: impl Into<String>) -> Self {
        Self {
            marker_type: marker_type.into(),
            value: Some(value.into()),
        }
    }
}

/// Structured metadata extracted from block content.
///
/// This is populated by the metadata extraction hook and stored in `block.metadata`.
/// The structure enables:
/// - Efficient marker queries (what blocks have `[project::X]`?)
/// - Backlink tracking (what blocks link to `[[Page]]`?)
/// - Stub detection (referenced but not yet created pages)
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, rename_all = "camelCase")]
#[serde(rename_all = "camelCase")]
pub struct BlockMetadata {
    /// All :: markers found in this block.
    /// Includes both prefix markers (sh::, ai::, ctx::) and tag markers ([project::X]).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub markers: Vec<Marker>,

    /// [[wikilink]] targets found in this block.
    /// For `[[Target|Alias]]`, stores only "Target".
    /// For nested `[[outer [[inner]]]]`, stores both "outer [[inner]]" and "inner".
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub outlinks: Vec<String>,

    /// True if this block is a stub (referenced by wikilink but not yet created).
    /// Stubs are blocks under pages:: with no real content yet.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_stub: bool,

    /// Timestamp of last metadata extraction.
    /// Used to skip re-extraction if content unchanged.
    /// Accepts both i64 and f64 on deserialization (yrs stores as f64 in legacy data).
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "deserialize_timestamp_lenient")]
    #[ts(type = "number | null")]
    pub extracted_at: Option<i64>,
}

impl BlockMetadata {
    /// Create empty metadata.
    pub fn new() -> Self {
        Self::default()
    }

    /// Check if metadata is empty (no markers, no outlinks, not a stub).
    pub fn is_empty(&self) -> bool {
        self.markers.is_empty() && self.outlinks.is_empty() && !self.is_stub
    }

    /// Add a marker.
    pub fn add_marker(&mut self, marker: Marker) {
        self.markers.push(marker);
    }

    /// Add an outlink.
    pub fn add_outlink(&mut self, target: impl Into<String>) {
        self.outlinks.push(target.into());
    }

    /// Get markers of a specific type.
    pub fn markers_of_type(&self, marker_type: &str) -> Vec<&Marker> {
        self.markers
            .iter()
            .filter(|m| m.marker_type == marker_type)
            .collect()
    }

    /// Check if this block has a marker of the given type.
    pub fn has_marker(&self, marker_type: &str) -> bool {
        self.markers.iter().any(|m| m.marker_type == marker_type)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_marker_new() {
        let marker = Marker::new("ctx");
        assert_eq!(marker.marker_type, "ctx");
        assert_eq!(marker.value, None);
    }

    #[test]
    fn test_marker_with_value() {
        let marker = Marker::with_value("project", "floatty");
        assert_eq!(marker.marker_type, "project");
        assert_eq!(marker.value, Some("floatty".to_string()));
    }

    #[test]
    fn test_metadata_empty() {
        let meta = BlockMetadata::new();
        assert!(meta.is_empty());
        assert!(meta.markers.is_empty());
        assert!(meta.outlinks.is_empty());
        assert!(!meta.is_stub);
    }

    #[test]
    fn test_metadata_add_marker() {
        let mut meta = BlockMetadata::new();
        meta.add_marker(Marker::new("ctx"));
        meta.add_marker(Marker::with_value("project", "floatty"));

        assert!(!meta.is_empty());
        assert_eq!(meta.markers.len(), 2);
        assert!(meta.has_marker("ctx"));
        assert!(meta.has_marker("project"));
        assert!(!meta.has_marker("mode"));
    }

    #[test]
    fn test_metadata_add_outlink() {
        let mut meta = BlockMetadata::new();
        meta.add_outlink("Page Name");
        meta.add_outlink("Another Page");

        assert!(!meta.is_empty());
        assert_eq!(meta.outlinks.len(), 2);
        assert!(meta.outlinks.contains(&"Page Name".to_string()));
    }

    #[test]
    fn test_metadata_markers_of_type() {
        let mut meta = BlockMetadata::new();
        meta.add_marker(Marker::with_value("project", "floatty"));
        meta.add_marker(Marker::with_value("project", "float-hub"));
        meta.add_marker(Marker::with_value("mode", "dev"));

        let projects = meta.markers_of_type("project");
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].value.as_deref(), Some("floatty"));
        assert_eq!(projects[1].value.as_deref(), Some("float-hub"));
    }

    #[test]
    fn test_metadata_stub() {
        let mut meta = BlockMetadata::new();
        meta.is_stub = true;

        assert!(!meta.is_empty()); // Stub counts as "not empty"
    }

    #[test]
    fn test_metadata_serialization() {
        let mut meta = BlockMetadata::new();
        meta.add_marker(Marker::with_value("project", "test"));
        meta.add_outlink("Page");
        meta.extracted_at = Some(1234567890);

        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains("\"markerType\":\"project\""));
        assert!(json.contains("\"value\":\"test\""));
        assert!(json.contains("\"outlinks\":[\"Page\"]"));

        // Deserialize back
        let parsed: BlockMetadata = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.markers.len(), 1);
        assert_eq!(parsed.outlinks.len(), 1);
    }

    #[test]
    fn test_metadata_skip_empty_fields() {
        let meta = BlockMetadata::new();
        let json = serde_json::to_string(&meta).unwrap();

        // Empty fields should be skipped
        assert!(!json.contains("markers"));
        assert!(!json.contains("outlinks"));
        assert!(!json.contains("isStub"));
        assert!(!json.contains("extractedAt"));
    }
}
