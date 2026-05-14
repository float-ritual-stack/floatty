//! Tantivy schema definition for block search.
//!
//! # Fields
//!
//! | Field | Type | Options | Purpose |
//! |-------|------|---------|---------|
//! | block_id | TEXT | STRING, STORED | Primary key, term-based deletion |
//! | content | TEXT | TEXT, STORED | Full-text search + snippet generation |
//! | block_type | TEXT | STRING, FAST | Facet filtering (sh, ctx, etc.) |
//! | parent_id | TEXT | STRING, STORED | Context retrieval |
//! | updated_at | DATE | FAST, STORED | Recency sorting |
//! | has_markers | BOOL | FAST, STORED | Filter for ctx:: blocks |
//! | outlinks | TEXT | STRING | [[wikilink]] targets (multi-value) |
//! | marker_types | TEXT | STRING | Marker type faceting (multi-value) |
//! | marker_values | TEXT | STRING | "type::value" pairs (multi-value) |
//! | created_at | I64 | FAST, STORED | Block creation timestamp |
//! | ctx_at | I64 | FAST, STORED | ctx:: event timestamp |
//! | depth | I64 | FAST, STORED | Block tree depth (for ranking boost) |
//! | nearest_page_block_id | TEXT | STRING, STORED | Nearest ancestor that is a registered page |
//! | nearest_page_name | TEXT | STRING, STORED | Page name for `nearest_page_block_id` |
//! | ancestor_block_ids | TEXT | STRING, STORED (multi-value) | Capped ancestor chain |
//! | subtree_size | I64 | FAST, STORED | Approximate descendant count cap |
//! | inbound_count | I64 | FAST, STORED | Number of `outlinks` referencing this block's page name |
//! | inbound_block_ids | TEXT | STRING, STORED (multi-value) | Top-N inbound block IDs |
//!
//! # Why block_id is Indexed STRING
//!
//! Tantivy requires indexed fields for term-based deletion.
//! When updating a block, we delete by `block_id` term then add the new doc.
//! STRING (not TEXT) means the ID is stored as-is without tokenization.

use tantivy::schema::{
    DateOptions, Field, Schema, TextFieldIndexing, TextOptions, STORED, STRING, TEXT,
};

/// Build the schema for the block search index.
///
/// Returns a Schema with all fields needed for block search.
pub fn build_schema() -> Schema {
    let mut builder = Schema::builder();

    // block_id: Primary key for deletions
    // STRING = indexed without tokenization, STORED = retrievable
    builder.add_text_field("block_id", STRING | STORED);

    // content: Full-text searchable + stored for snippet generation
    // TEXT = tokenized with standard analyzer, STORED = retrievable for SnippetGenerator
    builder.add_text_field("content", TEXT | STORED);

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

    // has_markers: String filter for ctx:: blocks
    // Stored as "true"/"false" for term-based queries (TermQuery on text)
    // STRING = indexed without tokenization, STORED = retrievable
    builder.add_text_field("has_markers", STRING | STORED);

    // markers: Full-text searchable marker values
    // Stores concatenated marker strings like "project::floatty mode::dev issue::264"
    // TEXT = tokenized with standard analyzer, so "project::floatty" is searchable
    builder.add_text_field("markers", TEXT);

    // outlinks: Multi-value TEXT field for [[wikilink]] targets
    // Each outlink added separately via add_text() for multi-value behavior
    // STRING = exact match (case-sensitive term queries)
    builder.add_text_field("outlinks", STRING);

    // marker_types: Multi-value TEXT field for marker type faceting
    // e.g., "project", "mode", "ctx" — allows filtering by marker type
    builder.add_text_field("marker_types", STRING);

    // marker_values: Multi-value TEXT field for "type::value" formatted strings
    // e.g., "project::floatty" — more specific than marker_types
    builder.add_text_field("marker_values", STRING);

    // marker_types_own: Own markers only (excludes inherited from ancestors)
    // For `inherited=false` queries
    builder.add_text_field("marker_types_own", STRING);

    // marker_values_own: Own "type::value" pairs only (excludes inherited)
    builder.add_text_field("marker_values_own", STRING);

    // created_at: Block creation timestamp (epoch seconds)
    // FAST = column-oriented for range queries, STORED = retrievable
    let i64_options = tantivy::schema::NumericOptions::default()
        .set_fast()
        .set_stored()
        .set_indexed();
    builder.add_i64_field("created_at", i64_options.clone());

    // ctx_at: Temporal axis for ctx:: markers (event time, not creation time)
    // A block about a Feb 15 meeting created Mar 11: created_at=Mar 11, ctx_at=Feb 15
    builder.add_i64_field("ctx_at", i64_options.clone());

    // depth: Block depth in tree (0 = root page, 1 = direct child, etc.)
    // Used for ranking boost: shallow blocks rank higher for same query terms
    builder.add_i64_field("depth", i64_options.clone());

    // ----- ancestor context fields -----
    // The "always-on" wire surface for `AncestorContext`. Populated by
    // TantivyIndexHook from a single `walk_ancestors` pass per block.
    // Schema additions are FREE per Tantivy ephemerality (the index is
    // nuked + rebuilt on every server start), so no migration is needed.

    // nearest_page_block_id / nearest_page_name: derived from the same
    // walk_ancestors call that produces `depth`. STORED so search hits can
    // surface "this hit lives on page X" without a second lookup.
    builder.add_text_field("nearest_page_block_id", STRING | STORED);
    builder.add_text_field("nearest_page_name", STRING | STORED);

    // ancestor_block_ids: multi-value capped ancestor chain (nearest-first,
    // capped at 10 per the walker's depth cap). STORED so the search-shape
    // helper can surface the ancestry without re-walking the Y.Doc.
    builder.add_text_field("ancestor_block_ids", STRING | STORED);

    // subtree_size: rough descendant count for "navigate vs read" hint.
    // Capped at 1000 to keep populating cost bounded.
    builder.add_i64_field("subtree_size", i64_options.clone());

    // inbound_count: number of [[wikilinks]] across the index that target
    // this block's nearest_page_name. Approximates "load-bearing" weight.
    builder.add_i64_field("inbound_count", i64_options);

    // inbound_block_ids: top-N inbound source block IDs (multi-value, top 5
    // by recency). Opt-in surfacing via `?include=inbound_samples` — the
    // hit-shaping helper joins these to content previews at response time.
    builder.add_text_field("inbound_block_ids", STRING | STORED);

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
        assert!(schema.get_field("markers").is_ok());
        assert!(schema.get_field("outlinks").is_ok());
        assert!(schema.get_field("marker_types").is_ok());
        assert!(schema.get_field("marker_values").is_ok());
        assert!(schema.get_field("created_at").is_ok());
        assert!(schema.get_field("ctx_at").is_ok());
        assert!(schema.get_field("marker_types_own").is_ok());
        assert!(schema.get_field("marker_values_own").is_ok());
        // ancestor context fields
        assert!(schema.get_field("nearest_page_block_id").is_ok());
        assert!(schema.get_field("nearest_page_name").is_ok());
        assert!(schema.get_field("ancestor_block_ids").is_ok());
        assert!(schema.get_field("subtree_size").is_ok());
        assert!(schema.get_field("inbound_count").is_ok());
        assert!(schema.get_field("inbound_block_ids").is_ok());
    }

    #[test]
    fn test_schema_field_count() {
        let schema = build_schema();
        // 15 original + 6 ancestor-context fields
        let field_count = schema.fields().count();
        assert_eq!(field_count, 21);
    }

    #[test]
    fn test_block_id_is_stored() {
        let schema = build_schema();
        let field = schema
            .get_field("block_id")
            .expect("block_id field should exist");
        let entry = schema.get_field_entry(field);

        // block_id should be stored (for retrieval after search)
        assert!(entry.is_stored());
    }

    #[test]
    fn test_content_is_text() {
        let schema = build_schema();
        let field = schema
            .get_field("content")
            .expect("content field should exist");
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
