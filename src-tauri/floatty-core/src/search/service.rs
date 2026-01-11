//! Search service for querying the Tantivy index.
//!
//! SearchService provides query primitives for full-text search across blocks.
//! Results are returned as block IDs with scores - hydrate full blocks from Y.Doc.
//!
//! # Architecture
//!
//! The search flow follows "Y.Doc is source of truth" pattern:
//! ```text
//! Query → Tantivy → [block_ids + scores] → Y.Doc → [full blocks]
//! ```
//!
//! # Example
//!
//! ```rust,ignore
//! use floatty_core::search::{SearchService, IndexManager};
//!
//! let manager = Arc::new(IndexManager::open_or_create()?);
//! let search = SearchService::new(manager);
//!
//! // Simple search
//! let hits = search.search("floatty", 10)?;
//!
//! // Filtered search
//! let hits = search.search_with_filters(
//!     "floatty",
//!     SearchFilters { block_types: Some(vec!["sh".into()]), ..Default::default() },
//!     10
//! )?;
//!
//! // Hydrate from Y.Doc
//! for hit in hits {
//!     if let Some(block) = store.get_block(&hit.block_id) {
//!         // Use full block data
//!     }
//! }
//! ```

use super::{IndexManager, SearchError};
use std::sync::Arc;
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, Occur, Query, QueryParser, TermQuery};
use tantivy::schema::{IndexRecordOption, Value};
use tantivy::Term;

/// A search result with block ID and relevance score.
#[derive(Debug, Clone)]
pub struct SearchHit {
    /// The block ID - use to hydrate full block from Y.Doc.
    pub block_id: String,
    /// Relevance score from Tantivy (higher = more relevant).
    pub score: f32,
    /// Optional highlighted snippet (future enhancement).
    pub snippet: Option<String>,
}

/// Filters for narrowing search results.
#[derive(Debug, Clone, Default)]
pub struct SearchFilters {
    /// Filter to specific block types (e.g., ["sh", "ai"]).
    /// Uses OR logic - matches any of the specified types.
    pub block_types: Option<Vec<String>>,

    /// Filter by marker presence.
    /// `Some(true)` = only blocks with :: markers
    /// `Some(false)` = only blocks without markers
    /// `None` = no filter
    pub has_markers: Option<bool>,

    /// Filter by parent block ID.
    /// Useful for searching within a subtree.
    pub parent_id: Option<String>,
}

/// Search service for querying indexed blocks.
///
/// Wraps IndexManager and provides search primitives.
/// Create one instance and share via Arc for concurrent queries.
pub struct SearchService {
    index: Arc<IndexManager>,
}

impl SearchService {
    /// Create a new search service wrapping an IndexManager.
    pub fn new(index: Arc<IndexManager>) -> Self {
        Self { index }
    }

    /// Search blocks by content.
    ///
    /// Returns up to `limit` results ordered by relevance.
    /// Empty query returns no results.
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// let hits = service.search("project meeting", 10)?;
    /// ```
    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, SearchError> {
        self.search_with_filters(query, SearchFilters::default(), limit)
    }

    /// Search blocks with filters.
    ///
    /// Combines full-text query with filter predicates.
    /// Filters are applied as AND conditions with the text query.
    ///
    /// # Example
    ///
    /// ```rust,ignore
    /// let hits = service.search_with_filters(
    ///     "meeting notes",
    ///     SearchFilters {
    ///         block_types: Some(vec!["ctx".into()]),
    ///         has_markers: Some(true),
    ///         ..Default::default()
    ///     },
    ///     20
    /// )?;
    /// ```
    pub fn search_with_filters(
        &self,
        query: &str,
        filters: SearchFilters,
        limit: usize,
    ) -> Result<Vec<SearchHit>, SearchError> {
        // Empty query returns no results
        let query_trimmed = query.trim();
        if query_trimmed.is_empty() {
            return Ok(Vec::new());
        }

        // Get reader and searcher
        let reader = self.index.index().reader()?;
        let searcher = reader.searcher();
        let fields = self.index.fields();

        // Build the text query
        let query_parser = QueryParser::for_index(self.index.index(), vec![fields.content]);
        let text_query = query_parser.parse_query(query_trimmed)?;

        // Build filter queries
        let filter_queries = self.build_filter_queries(&filters);

        // Combine text query with filters (AND logic)
        let final_query: Box<dyn Query> = if filter_queries.is_empty() {
            text_query
        } else {
            let mut clauses: Vec<(Occur, Box<dyn Query>)> = vec![(Occur::Must, text_query)];
            for filter in filter_queries {
                clauses.push((Occur::Must, filter));
            }
            Box::new(BooleanQuery::new(clauses))
        };

        // Execute search
        let top_docs = searcher.search(&final_query, &TopDocs::with_limit(limit))?;

        // Map results to SearchHit
        let mut hits = Vec::with_capacity(top_docs.len());
        for (score, doc_address) in top_docs {
            let doc: tantivy::TantivyDocument = searcher.doc(doc_address)?;
            if let Some(block_id) = doc.get_first(fields.block_id) {
                if let Some(id_str) = block_id.as_str() {
                    hits.push(SearchHit {
                        block_id: id_str.to_string(),
                        score,
                        snippet: None, // TODO: Add snippet generation
                    });
                }
            }
        }

        Ok(hits)
    }

    /// Build filter queries from SearchFilters.
    fn build_filter_queries(&self, filters: &SearchFilters) -> Vec<Box<dyn Query>> {
        let fields = self.index.fields();
        let mut queries: Vec<Box<dyn Query>> = Vec::new();

        // Block type filter (OR logic within, AND with other filters)
        if let Some(ref types) = filters.block_types {
            if !types.is_empty() {
                let type_clauses: Vec<(Occur, Box<dyn Query>)> = types
                    .iter()
                    .map(|t| {
                        let term = Term::from_field_text(fields.block_type, t);
                        let query: Box<dyn Query> =
                            Box::new(TermQuery::new(term, IndexRecordOption::Basic));
                        (Occur::Should, query)
                    })
                    .collect();
                queries.push(Box::new(BooleanQuery::new(type_clauses)));
            }
        }

        // has_markers filter
        if let Some(has_markers) = filters.has_markers {
            // Boolean field indexed as "true" or "false" text
            let term = Term::from_field_text(
                fields.has_markers,
                if has_markers { "true" } else { "false" },
            );
            queries.push(Box::new(TermQuery::new(term, IndexRecordOption::Basic)));
        }

        // parent_id filter
        if let Some(ref parent_id) = filters.parent_id {
            let term = Term::from_field_text(fields.parent_id, parent_id);
            queries.push(Box::new(TermQuery::new(term, IndexRecordOption::Basic)));
        }

        queries
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// Helper to create an index with test documents.
    /// Returns (TempDir, Arc<IndexManager>) - caller must hold TempDir to keep index alive.
    fn create_test_index(docs: &[(&str, &str, &str, bool)]) -> (tempfile::TempDir, Arc<IndexManager>) {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("search_index");
        let manager = Arc::new(IndexManager::open_or_create_at(index_path).unwrap());

        // Create writer and add documents
        let fields = manager.fields();
        let mut writer = manager.index().writer::<tantivy::TantivyDocument>(15_000_000).unwrap();

        for (id, content, block_type, has_markers) in docs {
            let mut doc = tantivy::TantivyDocument::new();
            doc.add_text(fields.block_id, *id);
            doc.add_text(fields.content, *content);
            doc.add_text(fields.block_type, *block_type);
            doc.add_text(fields.parent_id, ""); // Empty parent
            doc.add_text(fields.has_markers, if *has_markers { "true" } else { "false" });
            writer.add_document(doc).unwrap();
        }

        writer.commit().unwrap();

        (dir, manager)
    }

    #[test]
    fn test_search_basic() {
        let (_dir, manager) = create_test_index(&[
            ("b1", "hello world floatty", "text", false),
            ("b2", "goodbye world", "text", false),
            ("b3", "floatty is great", "text", false),
        ]);

        let service = SearchService::new(manager);

        let hits = service.search("floatty", 10).unwrap();
        assert_eq!(hits.len(), 2);

        // Both b1 and b3 should match
        let ids: Vec<_> = hits.iter().map(|h| h.block_id.as_str()).collect();
        assert!(ids.contains(&"b1"));
        assert!(ids.contains(&"b3"));
    }

    #[test]
    fn test_search_empty_query() {
        let (_dir, manager) = create_test_index(&[("b1", "hello world", "text", false)]);

        let service = SearchService::new(manager);

        // Empty query should return no results
        let hits = service.search("", 10).unwrap();
        assert!(hits.is_empty());

        // Whitespace-only should also return no results
        let hits = service.search("   ", 10).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn test_search_no_matches() {
        let (_dir, manager) = create_test_index(&[("b1", "hello world", "text", false)]);

        let service = SearchService::new(manager);

        let hits = service.search("nonexistent", 10).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn test_search_limit() {
        let (_dir, manager) = create_test_index(&[
            ("b1", "floatty one", "text", false),
            ("b2", "floatty two", "text", false),
            ("b3", "floatty three", "text", false),
        ]);

        let service = SearchService::new(manager);

        // Limit to 2 results
        let hits = service.search("floatty", 2).unwrap();
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn test_search_filter_block_type() {
        let (_dir, manager) = create_test_index(&[
            ("b1", "floatty shell command", "sh", false),
            ("b2", "floatty ai prompt", "ai", false),
            ("b3", "floatty text note", "text", false),
        ]);

        let service = SearchService::new(manager);

        // Filter to only sh blocks
        let hits = service
            .search_with_filters(
                "floatty",
                SearchFilters {
                    block_types: Some(vec!["sh".into()]),
                    ..Default::default()
                },
                10,
            )
            .unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block_id, "b1");
    }

    #[test]
    fn test_search_filter_multiple_types() {
        let (_dir, manager) = create_test_index(&[
            ("b1", "floatty shell", "sh", false),
            ("b2", "floatty ai", "ai", false),
            ("b3", "floatty text", "text", false),
        ]);

        let service = SearchService::new(manager);

        // Filter to sh OR ai
        let hits = service
            .search_with_filters(
                "floatty",
                SearchFilters {
                    block_types: Some(vec!["sh".into(), "ai".into()]),
                    ..Default::default()
                },
                10,
            )
            .unwrap();

        assert_eq!(hits.len(), 2);
        let ids: Vec<_> = hits.iter().map(|h| h.block_id.as_str()).collect();
        assert!(ids.contains(&"b1"));
        assert!(ids.contains(&"b2"));
    }

    #[test]
    fn test_search_filter_has_markers() {
        let (_dir, manager) = create_test_index(&[
            ("b1", "floatty with markers", "ctx", true),
            ("b2", "floatty without markers", "text", false),
        ]);

        let service = SearchService::new(manager);

        // Only blocks with markers
        let hits = service
            .search_with_filters(
                "floatty",
                SearchFilters {
                    has_markers: Some(true),
                    ..Default::default()
                },
                10,
            )
            .unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block_id, "b1");

        // Only blocks without markers
        let hits = service
            .search_with_filters(
                "floatty",
                SearchFilters {
                    has_markers: Some(false),
                    ..Default::default()
                },
                10,
            )
            .unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block_id, "b2");
    }

    #[test]
    fn test_search_combined_filters() {
        let (_dir, manager) = create_test_index(&[
            ("b1", "floatty sh with markers", "sh", true),
            ("b2", "floatty sh without", "sh", false),
            ("b3", "floatty ai with markers", "ai", true),
            ("b4", "floatty text", "text", false),
        ]);

        let service = SearchService::new(manager);

        // sh blocks with markers
        let hits = service
            .search_with_filters(
                "floatty",
                SearchFilters {
                    block_types: Some(vec!["sh".into()]),
                    has_markers: Some(true),
                    ..Default::default()
                },
                10,
            )
            .unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block_id, "b1");
    }

    #[test]
    fn test_search_score_ordering() {
        let (_dir, manager) = create_test_index(&[
            ("b1", "floatty floatty floatty", "text", false), // More occurrences
            ("b2", "floatty once", "text", false),
        ]);

        let service = SearchService::new(manager);

        let hits = service.search("floatty", 10).unwrap();
        assert_eq!(hits.len(), 2);

        // First result should have higher score (more term frequency)
        assert!(hits[0].score >= hits[1].score);
    }
}
