//! Index lifecycle management for Tantivy.
//!
//! IndexManager owns the Tantivy Index and provides access to:
//! - The index itself (for creating writers/readers)
//! - The schema (for building documents)
//! - Strongly-typed field references (for document operations)
//!
//! # Index Location
//!
//! The index is stored at `~/.floatty/search_index/`.
//!
//! # Example
//!
//! ```rust,ignore
//! let manager = IndexManager::open_or_create()?;
//!
//! // Create a writer (Unit 3.2)
//! let writer = manager.index().writer(50_000_000)?;
//!
//! // Build documents using typed fields
//! let fields = manager.fields();
//! let mut doc = TantivyDocument::new();
//! doc.add_text(fields.block_id, "b123");
//! doc.add_text(fields.content, "Hello world");
//! ```

use super::schema::{build_schema, get_field};
use super::SearchError;
use std::path::PathBuf;
use tantivy::directory::MmapDirectory;
use tantivy::schema::{Field, Schema};
use tantivy::Index;
use tracing::{debug, info};

/// The index directory name under ~/.floatty/
const INDEX_DIR_NAME: &str = "search_index";

/// Manages the Tantivy search index lifecycle.
///
/// Create via `IndexManager::open_or_create()` which either opens
/// an existing index or creates a new one with the schema.
pub struct IndexManager {
    index: Index,
    schema: Schema,
    fields: SchemaFields,
    index_path: PathBuf,
}

/// Strongly-typed field references for document operations.
///
/// Use these instead of string lookups for type safety and performance.
#[derive(Debug, Clone, Copy)]
pub struct SchemaFields {
    /// Block ID - primary key for deletions.
    pub block_id: Field,
    /// Full-text searchable content.
    pub content: Field,
    /// Block type for faceted filtering (sh, ai, ctx, etc.).
    pub block_type: Field,
    /// Parent block ID for context retrieval.
    pub parent_id: Field,
    /// Last update timestamp for recency sorting.
    pub updated_at: Field,
    /// Whether block has :: markers.
    pub has_markers: Field,
    /// Full-text searchable marker values (e.g., "project::floatty mode::dev").
    pub markers: Field,
    /// [[wikilink]] targets (multi-value, exact match).
    pub outlinks: Field,
    /// Marker types for faceting (e.g., "project", "mode").
    pub marker_types: Field,
    /// "type::value" formatted marker pairs (e.g., "project::floatty").
    pub marker_values: Field,
    /// Block creation timestamp (epoch seconds).
    pub created_at: Field,
    /// ctx:: event timestamp (epoch seconds). Distinct from created_at.
    pub ctx_at: Field,
}

impl SchemaFields {
    /// Create field references from a schema.
    fn from_schema(schema: &Schema) -> Self {
        Self {
            block_id: get_field(schema, "block_id"),
            content: get_field(schema, "content"),
            block_type: get_field(schema, "block_type"),
            parent_id: get_field(schema, "parent_id"),
            updated_at: get_field(schema, "updated_at"),
            has_markers: get_field(schema, "has_markers"),
            markers: get_field(schema, "markers"),
            outlinks: get_field(schema, "outlinks"),
            marker_types: get_field(schema, "marker_types"),
            marker_values: get_field(schema, "marker_values"),
            created_at: get_field(schema, "created_at"),
            ctx_at: get_field(schema, "ctx_at"),
        }
    }
}

impl IndexManager {
    /// Open an existing index or create a new one.
    ///
    /// The index is stored at `~/.floatty/search_index/`.
    ///
    /// # Errors
    ///
    /// Returns `SearchError` if:
    /// - Home directory cannot be determined
    /// - Index directory cannot be created
    /// - Index cannot be opened or created
    pub fn open_or_create() -> Result<Self, SearchError> {
        let index_path = get_index_path()?;
        Self::open_or_create_at(index_path)
    }

    /// Open an existing index or create a new one at a specific path.
    ///
    /// This is primarily for testing with temp directories.
    pub fn open_or_create_at(path: PathBuf) -> Result<Self, SearchError> {
        let schema = build_schema();
        let fields = SchemaFields::from_schema(&schema);

        // Ensure directory exists
        std::fs::create_dir_all(&path)?;

        // Create MmapDirectory for the path
        let dir = MmapDirectory::open(&path)?;

        // Check if index already exists (meta.json present)
        let meta_path = path.join("meta.json");
        let index = if meta_path.exists() {
            debug!("Opening existing index at {:?}", path);
            Index::open(dir)?
        } else {
            info!("Creating new search index at {:?}", path);
            Index::create(dir, schema.clone(), Default::default())?
        };

        Ok(Self {
            index,
            schema,
            fields,
            index_path: path,
        })
    }

    /// Get the Tantivy index for writer/reader access.
    pub fn index(&self) -> &Index {
        &self.index
    }

    /// Get the schema for document building.
    pub fn schema(&self) -> &Schema {
        &self.schema
    }

    /// Get strongly-typed field references.
    pub fn fields(&self) -> SchemaFields {
        self.fields
    }

    /// Get the path where the index is stored.
    ///
    /// For debugging/logging purposes.
    pub fn path(&self) -> &PathBuf {
        &self.index_path
    }

    /// Get the default index directory path (static, no instance needed).
    ///
    /// Used by nuke-on-startup to delete stale index before open_or_create().
    pub fn index_path() -> Result<PathBuf, SearchError> {
        get_index_path()
    }
}

/// Get the default index path ({data_dir}/search_index/).
///
/// Uses `FLOATTY_DATA_DIR` if set, otherwise build-profile-aware default.
fn get_index_path() -> Result<PathBuf, SearchError> {
    Ok(crate::data_dir().join(INDEX_DIR_NAME))
}


#[cfg(test)]
mod tests {
    use super::*;
    use tantivy::TantivyDocument;
    use tempfile::tempdir;

    #[test]
    fn test_open_creates_index() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("search_index");

        // Index should not exist yet
        assert!(!index_path.exists());

        // Create index
        let manager = IndexManager::open_or_create_at(index_path.clone()).unwrap();

        // Index directory should now exist
        assert!(index_path.exists());

        // Schema should have 12 fields (7 original + 5 new)
        assert_eq!(manager.schema().fields().count(), 12);
    }

    #[test]
    fn test_open_existing_index() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("search_index");

        // Create index first time
        let manager1 = IndexManager::open_or_create_at(index_path.clone()).unwrap();
        let fields1 = manager1.fields();

        // Open again (should reopen, not recreate)
        let manager2 = IndexManager::open_or_create_at(index_path).unwrap();
        let fields2 = manager2.fields();

        // Fields should be the same
        assert_eq!(fields1.block_id, fields2.block_id);
        assert_eq!(fields1.content, fields2.content);
    }

    #[test]
    fn test_schema_fields_accessible() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("search_index");

        let manager = IndexManager::open_or_create_at(index_path).unwrap();
        let fields = manager.fields();

        // All fields should be valid
        let schema = manager.schema();
        assert_eq!(schema.get_field_entry(fields.block_id).name(), "block_id");
        assert_eq!(schema.get_field_entry(fields.content).name(), "content");
        assert_eq!(schema.get_field_entry(fields.block_type).name(), "block_type");
        assert_eq!(schema.get_field_entry(fields.parent_id).name(), "parent_id");
        assert_eq!(schema.get_field_entry(fields.updated_at).name(), "updated_at");
        assert_eq!(schema.get_field_entry(fields.has_markers).name(), "has_markers");
        assert_eq!(schema.get_field_entry(fields.markers).name(), "markers");
    }

    #[test]
    fn test_can_create_writer() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("search_index");

        let manager = IndexManager::open_or_create_at(index_path).unwrap();

        // Should be able to create a writer
        let writer = manager.index().writer::<TantivyDocument>(15_000_000); // 15MB heap
        assert!(writer.is_ok());
    }

    #[test]
    fn test_can_create_reader() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("search_index");

        let manager = IndexManager::open_or_create_at(index_path).unwrap();

        // Should be able to create a reader
        let reader = manager.index().reader();
        assert!(reader.is_ok());
    }

    #[test]
    fn test_index_path_method() {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("search_index");

        let manager = IndexManager::open_or_create_at(index_path.clone()).unwrap();

        // Path should match what we provided
        assert_eq!(manager.path(), &index_path);
    }

    #[test]
    fn test_get_index_path() {
        // Should return a path ending with search_index
        let path = get_index_path().unwrap();
        assert!(path.ends_with("search_index"));
        assert!(path.to_string_lossy().contains(".floatty"));
    }
}
