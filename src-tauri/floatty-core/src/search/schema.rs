//! Tantivy schema definition for block search.
//!
//! # Fields
//!
//! | Field | Type | Options | Purpose |
//! |-------|------|---------|---------|
//! | block_id | TEXT | STRING, STORED | Primary key, term-based deletion |
//! | content | TEXT | TEXT | Full-text search with tokenization |
//! | block_type | TEXT | STRING, FAST | Facet filtering (sh, ai, ctx, etc.) |
//! | parent_id | TEXT | STRING, STORED | Context retrieval |
//! | updated_at | DATE | FAST, STORED | Recency sorting |
//! | has_markers | BOOL | FAST, STORED | Filter for ctx:: blocks |
//!
//! # Why block_id is Indexed STRING
//!
//! Tantivy requires indexed fields for term-based deletion.
//! When updating a block, we delete by `block_id` term then add the new doc.
//! STRING (not TEXT) means the ID is stored as-is without tokenization.

use tantivy::schema::{
    DateOptions, Field, Schema, TextFieldIndexing, TextOptions, FAST, STORED, STRING, TEXT,
};

/// Build the schema for the block search index.
///
/// Returns a Schema with all fields needed for block search.
pub fn build_schema() -> Schema {
    let mut builder = Schema::builder();

    // block_id: Primary key for deletions
    // STRING = indexed without tokenization, STORED = retrievable
    builder.add_text_field("block_id", STRING | STORED);

    // content: Full-text searchable
    // TEXT = tokenized with standard analyzer
    builder.add_text_field("content", TEXT);

    // block_type: Fast field for faceted filtering
    // STRING = exact match, FAST = column-oriented for filtering
    let type_options = TextOptions::default()
        .set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer("raw")
                .set_index_option(tantivy::schema::IndexRecordOption::Basic),
        )
        .set_fast(None)
        .set_stored();
    builder.add_text_field("block_type", type_options);

    // parent_id: For context retrieval (not searched, just stored)
    builder.add_text_field("parent_id", STRING | STORED);

    // updated_at: For recency sorting
    // FAST = column-oriented for sorting, STORED = retrievable
    let date_options = DateOptions::default().set_fast().set_stored();
    builder.add_date_field("updated_at", date_options);

    // has_markers: Boolean filter for ctx:: blocks
    // FAST = column-oriented for filtering, STORED = retrievable
    builder.add_bool_field("has_markers", FAST | STORED);

    builder.build()
}

/// Get a field by name from the schema.
///
/// # Panics
///
/// Panics if the field doesn't exist. This should only be used with
/// known field names from this module's schema.
pub fn get_field(schema: &Schema, name: &str) -> Field {
    schema
        .get_field(name)
        .unwrap_or_else(|_| panic!("Field '{}' not found in schema", name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_schema_has_all_fields() {
        let schema = build_schema();

        // All fields should exist (get_field returns Result in tantivy 0.22)
        assert!(schema.get_field("block_id").is_ok());
        assert!(schema.get_field("content").is_ok());
        assert!(schema.get_field("block_type").is_ok());
        assert!(schema.get_field("parent_id").is_ok());
        assert!(schema.get_field("updated_at").is_ok());
        assert!(schema.get_field("has_markers").is_ok());
    }

    #[test]
    fn test_schema_field_count() {
        let schema = build_schema();
        // Should have exactly 6 fields
        // schema.fields() returns an iterator of (Field, &FieldEntry)
        let field_count = schema.fields().count();
        assert_eq!(field_count, 6);
    }

    #[test]
    fn test_block_id_is_stored() {
        let schema = build_schema();
        let field = schema.get_field("block_id").expect("block_id field should exist");
        let entry = schema.get_field_entry(field);

        // block_id should be stored (for retrieval after search)
        assert!(entry.is_stored());
    }

    #[test]
    fn test_content_is_text() {
        let schema = build_schema();
        let field = schema.get_field("content").expect("content field should exist");
        let entry = schema.get_field_entry(field);

        // content should be indexed (TEXT implies indexing)
        assert!(entry.is_indexed());
    }

    #[test]
    fn test_get_field_helper() {
        let schema = build_schema();

        // Should return valid fields
        let _block_id = get_field(&schema, "block_id");
        let _content = get_field(&schema, "content");
    }

    #[test]
    #[should_panic(expected = "Field 'nonexistent' not found")]
    fn test_get_field_panics_on_missing() {
        let schema = build_schema();
        get_field(&schema, "nonexistent");
    }
}
