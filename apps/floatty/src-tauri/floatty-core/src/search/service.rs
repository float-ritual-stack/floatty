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
use tantivy::collector::{Count, TopDocs};
use tantivy::query::{AllQuery, BooleanQuery, Occur, Query, QueryParser, RangeQuery, TermQuery};
use tantivy::schema::{IndexRecordOption, Value};
use tantivy::snippet::SnippetGenerator;
use tantivy::Term;

/// Escape Tantivy query syntax characters so user input is treated as literal text.
///
/// Tantivy special chars: `+`, `-`, `&&`, `||`, `!`, `(`, `)`, `{`, `}`, `[`, `]`,
/// `^`, `"`, `~`, `*`, `?`, `:`, `\`, `/`
///
/// We escape the subset that commonly appears in floatty notes:
/// - `::` (field syntax) — ubiquitous in ctx::, project::, search::, etc.
/// - `[` `]` (range queries) — wikilinks [[like this]]
/// - `(` `)` — grouping, common in prose
/// - `{` `}` — set syntax
/// - `"` — phrase syntax
/// - `*` `?` — wildcards
/// - `~` — fuzzy
/// - `^` — boost
/// - `!` `+` `-` — boolean operators
fn escape_tantivy_query(input: &str) -> String {
    let mut result = String::with_capacity(input.len() + 8);
    for ch in input.chars() {
        match ch {
            ':' | '[' | ']' | '(' | ')' | '{' | '}' | '"' | '*' | '?' | '~' | '^' | '!'
            | '+' | '\\' | '/' => {
                result.push('\\');
                result.push(ch);
            }
            // `-` only special at start of term, but safer to always escape
            '-' => {
                result.push('\\');
                result.push(ch);
            }
            _ => result.push(ch),
        }
    }
    result
}

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

    /// Filter by [[wikilink]] outlink target (exact match).
    pub outlink: Option<String>,

    /// Filter by marker type (e.g., "project", "mode", "ctx").
    pub marker_type: Option<String>,

    /// Filter by "type::value" marker pair (e.g., "project::floatty").
    pub marker_value: Option<String>,

    /// Filter by created_at range (epoch seconds, inclusive).
    pub created_after: Option<i64>,
    pub created_before: Option<i64>,

    /// Filter by ctx_at range (epoch seconds, inclusive).
    pub ctx_after: Option<i64>,
    pub ctx_before: Option<i64>,

    /// When false, marker_type/marker_value queries use own-only fields
    /// (excludes inherited markers from ancestors). Default: true (combined).
    pub include_inherited: Option<bool>,

    /// Exclude specific block types (e.g., ["eval", "sh"]).
    /// Uses MustNot logic - excludes ALL specified types.
    pub exclude_types: Option<Vec<String>>,
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
    /// let (_total, hits) = service.search("project meeting", 10)?;
    /// ```
    pub fn search(&self, query: &str, limit: usize) -> Result<(usize, Vec<SearchHit>), SearchError> {
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
    /// let (_total, hits) = service.search_with_filters(
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
    ) -> Result<(usize, Vec<SearchHit>), SearchError> {
        let query_trimmed = query.trim();
        let filter_queries = self.build_filter_queries(&filters);

        // Empty text + no filters = no results
        if query_trimmed.is_empty() && filter_queries.is_empty() {
            return Ok((0, Vec::new()));
        }

        // Get reader and searcher
        let reader = self.index.index().reader()?;
        let searcher = reader.searcher();
        let fields = self.index.fields();

        // Build the text query (or AllQuery for filter-only searches)
        let base_query: Box<dyn Query> = if query_trimmed.is_empty() {
            Box::new(AllQuery)
        } else {
            let query_escaped = escape_tantivy_query(query_trimmed);
            let mut query_parser =
                QueryParser::for_index(self.index.index(), vec![fields.content, fields.markers]);
            query_parser.set_field_boost(fields.content, 2.0);
            query_parser.set_field_boost(fields.markers, 1.0);
            query_parser.parse_query(&query_escaped)?
        };

        // Build exclusion queries (MustNot)
        let exclude_queries = self.build_exclude_queries(&filters);

        // Combine base query with filters (AND logic) + exclusions (MustNot)
        let final_query: Box<dyn Query> = if filter_queries.is_empty() && exclude_queries.is_empty() {
            base_query
        } else {
            let mut clauses: Vec<(Occur, Box<dyn Query>)> = vec![(Occur::Must, base_query)];
            for filter in filter_queries {
                clauses.push((Occur::Must, filter));
            }
            for exclude in exclude_queries {
                clauses.push((Occur::MustNot, exclude));
            }
            Box::new(BooleanQuery::new(clauses))
        };

        // Execute search (Count collector gives true total, TopDocs gives limited results)
        let (total_count, top_docs) = searcher.search(&final_query, &(Count, TopDocs::with_limit(limit)))?;

        // Create snippet generator for text queries (not filter-only)
        let snippet_gen = if !query_trimmed.is_empty() {
            SnippetGenerator::create(&searcher, &final_query, fields.content).ok()
        } else {
            None
        };

        // Map results to SearchHit
        let mut hits = Vec::with_capacity(top_docs.len());
        for (score, doc_address) in top_docs {
            let doc: tantivy::TantivyDocument = searcher.doc(doc_address)?;
            if let Some(block_id) = doc.get_first(fields.block_id) {
                if let Some(id_str) = block_id.as_str() {
                    let snippet = snippet_gen.as_ref().and_then(|gen| {
                        let s = gen.snippet_from_doc(&doc);
                        let html = s.to_html();
                        if html.is_empty() { None } else { Some(html) }
                    });
                    hits.push(SearchHit {
                        block_id: id_str.to_string(),
                        score,
                        snippet,
                    });
                }
            }
        }

        Ok((total_count, hits))
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

        // outlink filter (exact match on [[wikilink]] target)
        if let Some(ref outlink) = filters.outlink {
            let term = Term::from_field_text(fields.outlinks, outlink);
            queries.push(Box::new(TermQuery::new(term, IndexRecordOption::Basic)));
        }

        // marker_type filter — use own-only fields when include_inherited=false
        let use_own_only = filters.include_inherited == Some(false);
        if let Some(ref mt) = filters.marker_type {
            let field = if use_own_only { fields.marker_types_own } else { fields.marker_types };
            let term = Term::from_field_text(field, mt);
            queries.push(Box::new(TermQuery::new(term, IndexRecordOption::Basic)));
        }

        // marker_value filter ("type::value" pair)
        if let Some(ref mv) = filters.marker_value {
            let field = if use_own_only { fields.marker_values_own } else { fields.marker_values };
            let term = Term::from_field_text(field, mv);
            queries.push(Box::new(TermQuery::new(term, IndexRecordOption::Basic)));
        }

        // created_at range filter
        if filters.created_after.is_some() || filters.created_before.is_some() {
            let lower = filters
                .created_after
                .map(|v| std::ops::Bound::Included(Term::from_field_i64(fields.created_at, v)))
                .unwrap_or(std::ops::Bound::Unbounded);
            let upper = filters
                .created_before
                .map(|v| std::ops::Bound::Included(Term::from_field_i64(fields.created_at, v)))
                .unwrap_or(std::ops::Bound::Unbounded);
            queries.push(Box::new(RangeQuery::new(lower, upper)));
        }

        // ctx_at range filter
        if filters.ctx_after.is_some() || filters.ctx_before.is_some() {
            let lower = filters
                .ctx_after
                .map(|v| std::ops::Bound::Included(Term::from_field_i64(fields.ctx_at, v)))
                .unwrap_or(std::ops::Bound::Unbounded);
            let upper = filters
                .ctx_before
                .map(|v| std::ops::Bound::Included(Term::from_field_i64(fields.ctx_at, v)))
                .unwrap_or(std::ops::Bound::Unbounded);
            queries.push(Box::new(RangeQuery::new(lower, upper)));
        }

        queries
    }

    /// Build exclusion queries (MustNot) for exclude_types filter.
    fn build_exclude_queries(&self, filters: &SearchFilters) -> Vec<Box<dyn Query>> {
        let fields = self.index.fields();
        let mut queries: Vec<Box<dyn Query>> = Vec::new();

        if let Some(ref types) = filters.exclude_types {
            for t in types {
                let term = Term::from_field_text(fields.block_type, t);
                queries.push(Box::new(TermQuery::new(term, IndexRecordOption::Basic)));
            }
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
        // Convert to extended format with empty markers
        let extended: Vec<_> = docs
            .iter()
            .map(|(id, content, block_type, has_markers)| (*id, *content, *block_type, *has_markers, ""))
            .collect();
        create_test_index_with_markers(&extended)
    }

    /// Helper to create an index with test documents including markers.
    /// Returns (TempDir, Arc<IndexManager>) - caller must hold TempDir to keep index alive.
    fn create_test_index_with_markers(
        docs: &[(&str, &str, &str, bool, &str)],
    ) -> (tempfile::TempDir, Arc<IndexManager>) {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("search_index");
        let manager = Arc::new(IndexManager::open_or_create_at(index_path).unwrap());

        // Create writer and add documents
        let fields = manager.fields();
        let mut writer = manager.index().writer::<tantivy::TantivyDocument>(15_000_000).unwrap();

        for (id, content, block_type, has_markers, markers) in docs {
            let mut doc = tantivy::TantivyDocument::new();
            doc.add_text(fields.block_id, *id);
            doc.add_text(fields.content, *content);
            doc.add_text(fields.block_type, *block_type);
            doc.add_text(fields.parent_id, ""); // Empty parent
            doc.add_text(fields.has_markers, if *has_markers { "true" } else { "false" });
            doc.add_text(fields.markers, *markers);
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

        let (_total, hits) = service.search("floatty", 10).unwrap();
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
        let (_total, hits) = service.search("", 10).unwrap();
        assert!(hits.is_empty());

        // Whitespace-only should also return no results
        let (_total, hits) = service.search("   ", 10).unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn test_search_no_matches() {
        let (_dir, manager) = create_test_index(&[("b1", "hello world", "text", false)]);

        let service = SearchService::new(manager);

        let (_total, hits) = service.search("nonexistent", 10).unwrap();
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

        // Limit to 2 results — total should reflect all 3 matches
        let (total, hits) = service.search("floatty", 2).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(total, 3, "total should be true match count, not truncated len");
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
        let (_total, hits) = service
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
        let (_total, hits) = service
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
        let (_total, hits) = service
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
        let (_total, hits) = service
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
        let (_total, hits) = service
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

        let (_total, hits) = service.search("floatty", 10).unwrap();
        assert_eq!(hits.len(), 2);

        // First result should have higher score (more term frequency)
        assert!(hits[0].score >= hits[1].score);
    }

    #[test]
    fn test_search_by_marker_value() {
        // Test searching by extracted marker values (e.g., "project::floatty")
        let (_dir, manager) = create_test_index_with_markers(&[
            ("b1", "working today", "text", true, "project::floatty mode::dev"),
            ("b2", "other work", "text", true, "project::pharmacy"),
            ("b3", "no markers", "text", false, ""),
        ]);

        let service = SearchService::new(manager);

        // Search for project::floatty - should match b1's markers field
        let (_total, hits) = service.search("project::floatty", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block_id, "b1");

        // Search for project::pharmacy - should match b2
        let (_total, hits) = service.search("project::pharmacy", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block_id, "b2");

        // Search for mode::dev - should match b1
        let (_total, hits) = service.search("mode::dev", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block_id, "b1");
    }

    #[test]
    fn test_search_marker_partial_match() {
        // Test that partial marker terms work (Tantivy tokenizes on whitespace/punctuation)
        let (_dir, manager) = create_test_index_with_markers(&[
            ("b1", "context marker", "ctx", true, "project::floatty"),
            ("b2", "other block", "text", false, ""),
        ]);

        let service = SearchService::new(manager);

        // Search for just "floatty" - should match via markers field
        let (_total, hits) = service.search("floatty", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block_id, "b1");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Enriched field filter tests (Unit 1.1/1.2)
    // ─────────────────────────────────────────────────────────────────────────

    /// Helper to create an index with fully enriched documents.
    struct EnrichedDoc {
        id: &'static str,
        content: &'static str,
        block_type: &'static str,
        has_markers: bool,
        markers: &'static str,
        outlinks: Vec<&'static str>,
        marker_types: Vec<&'static str>,
        marker_values: Vec<&'static str>,
        /// Own-only marker types (subset of marker_types, excludes inherited)
        marker_types_own: Vec<&'static str>,
        /// Own-only marker values (subset of marker_values, excludes inherited)
        marker_values_own: Vec<&'static str>,
        created_at: i64,
        ctx_at: i64,
    }

    fn create_enriched_index(docs: &[EnrichedDoc]) -> (tempfile::TempDir, Arc<IndexManager>) {
        let dir = tempdir().unwrap();
        let index_path = dir.path().join("search_index");
        let manager = Arc::new(IndexManager::open_or_create_at(index_path).unwrap());

        let fields = manager.fields();
        let mut writer = manager.index().writer::<tantivy::TantivyDocument>(15_000_000).unwrap();

        for d in docs {
            let mut doc = tantivy::TantivyDocument::new();
            doc.add_text(fields.block_id, d.id);
            doc.add_text(fields.content, d.content);
            doc.add_text(fields.block_type, d.block_type);
            doc.add_text(fields.parent_id, "");
            doc.add_text(fields.has_markers, if d.has_markers { "true" } else { "false" });
            doc.add_text(fields.markers, d.markers);
            for outlink in &d.outlinks {
                doc.add_text(fields.outlinks, *outlink);
            }
            for mt in &d.marker_types {
                doc.add_text(fields.marker_types, *mt);
            }
            for mv in &d.marker_values {
                doc.add_text(fields.marker_values, *mv);
            }
            for mt in &d.marker_types_own {
                doc.add_text(fields.marker_types_own, *mt);
            }
            for mv in &d.marker_values_own {
                doc.add_text(fields.marker_values_own, *mv);
            }
            if d.created_at > 0 {
                doc.add_i64(fields.created_at, d.created_at);
            }
            if d.ctx_at > 0 {
                doc.add_i64(fields.ctx_at, d.ctx_at);
            }
            writer.add_document(doc).unwrap();
        }

        writer.commit().unwrap();
        (dir, manager)
    }

    fn test_docs() -> Vec<EnrichedDoc> {
        vec![
            EnrichedDoc {
                id: "b1",
                content: "ctx::2026-03-11 project::floatty meeting notes with [[Daily Page]]",
                block_type: "ctx",
                has_markers: true,
                markers: "ctx project::floatty",
                outlinks: vec!["Daily Page", "Weekly Index"],
                // Combined: own ctx + project, plus inherited "repo" from ancestor
                marker_types: vec!["ctx", "project", "repo"],
                marker_values: vec!["project::floatty", "repo::floatty"],
                // Own only: ctx + project (repo is inherited)
                marker_types_own: vec!["ctx", "project"],
                marker_values_own: vec!["project::floatty"],
                created_at: 1773220000, // Mar 11
                ctx_at: 1773220000,
            },
            EnrichedDoc {
                id: "b2",
                content: "project::pharmacy mode::dev fixing [[Issue #264]]",
                block_type: "text",
                has_markers: true,
                markers: "project::pharmacy mode::dev",
                outlinks: vec!["Issue #264"],
                marker_types: vec!["project", "mode"],
                marker_values: vec!["project::pharmacy", "mode::dev"],
                marker_types_own: vec!["project", "mode"],
                marker_values_own: vec!["project::pharmacy", "mode::dev"],
                created_at: 1773300000, // Mar 12
                ctx_at: 0,
            },
            EnrichedDoc {
                id: "b3",
                content: "plain text no markers no links",
                block_type: "text",
                has_markers: false,
                markers: "",
                outlinks: vec![],
                marker_types: vec![],
                marker_values: vec![],
                marker_types_own: vec![],
                marker_values_own: vec![],
                created_at: 1773400000, // Mar 13
                ctx_at: 0,
            },
        ]
    }

    #[test]
    fn test_filter_outlink() {
        let (_dir, manager) = create_enriched_index(&test_docs());
        let service = SearchService::new(manager);

        let (_total, hits) = service
            .search_with_filters("project meeting fixing text", SearchFilters {
                outlink: Some("Daily Page".into()),
                ..Default::default()
            }, 10)
            .unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block_id, "b1");
    }

    #[test]
    fn test_filter_marker_type() {
        let (_dir, manager) = create_enriched_index(&test_docs());
        let service = SearchService::new(manager);

        // Filter by marker_type=mode → only b2 has mode
        let (_total, hits) = service
            .search_with_filters("project meeting fixing text", SearchFilters {
                marker_type: Some("mode".into()),
                ..Default::default()
            }, 10)
            .unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block_id, "b2");
    }

    #[test]
    fn test_filter_marker_value() {
        let (_dir, manager) = create_enriched_index(&test_docs());
        let service = SearchService::new(manager);

        let (_total, hits) = service
            .search_with_filters("project meeting fixing text", SearchFilters {
                marker_value: Some("project::pharmacy".into()),
                ..Default::default()
            }, 10)
            .unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block_id, "b2");
    }

    #[test]
    fn test_filter_created_after() {
        let (_dir, manager) = create_enriched_index(&test_docs());
        let service = SearchService::new(manager);

        // created_after Mar 12 → b2 and b3
        let (_total, hits) = service
            .search_with_filters("project meeting fixing text", SearchFilters {
                created_after: Some(1773300000),
                ..Default::default()
            }, 10)
            .unwrap();

        assert_eq!(hits.len(), 2);
        let ids: Vec<_> = hits.iter().map(|h| h.block_id.as_str()).collect();
        assert!(ids.contains(&"b2"));
        assert!(ids.contains(&"b3"));
    }

    #[test]
    fn test_filter_created_range() {
        let (_dir, manager) = create_enriched_index(&test_docs());
        let service = SearchService::new(manager);

        // Between Mar 11 and Mar 12 (inclusive) → b1 and b2
        let (_total, hits) = service
            .search_with_filters("project meeting fixing text", SearchFilters {
                created_after: Some(1773220000),
                created_before: Some(1773300000),
                ..Default::default()
            }, 10)
            .unwrap();

        assert_eq!(hits.len(), 2);
        let ids: Vec<_> = hits.iter().map(|h| h.block_id.as_str()).collect();
        assert!(ids.contains(&"b1"));
        assert!(ids.contains(&"b2"));
    }

    #[test]
    fn test_filter_ctx_at() {
        let (_dir, manager) = create_enriched_index(&test_docs());
        let service = SearchService::new(manager);

        // Only b1 has ctx_at set
        let (_total, hits) = service
            .search_with_filters("project meeting fixing text", SearchFilters {
                ctx_after: Some(1773200000),
                ..Default::default()
            }, 10)
            .unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block_id, "b1");
    }

    #[test]
    fn test_filter_only_no_text_query() {
        let (_dir, manager) = create_enriched_index(&test_docs());
        let service = SearchService::new(manager);

        // Empty text query + filter = should use AllQuery as base
        let (_total, hits) = service
            .search_with_filters("", SearchFilters {
                marker_type: Some("project".into()),
                ..Default::default()
            }, 10)
            .unwrap();

        // b1 and b2 both have marker_type=project
        assert_eq!(hits.len(), 2);
        let ids: Vec<_> = hits.iter().map(|h| h.block_id.as_str()).collect();
        assert!(ids.contains(&"b1"));
        assert!(ids.contains(&"b2"));
    }

    #[test]
    fn test_filter_inherited_false() {
        let (_dir, manager) = create_enriched_index(&test_docs());
        let service = SearchService::new(manager);

        // Default (inherited=true): marker_type=repo matches b1 (inherited from ancestor)
        let (_total, hits) = service
            .search_with_filters("", SearchFilters {
                marker_type: Some("repo".into()),
                ..Default::default()
            }, 10)
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block_id, "b1");

        // inherited=false: marker_type=repo returns 0 (b1 doesn't OWN repo marker)
        let (_total, hits) = service
            .search_with_filters("", SearchFilters {
                marker_type: Some("repo".into()),
                include_inherited: Some(false),
                ..Default::default()
            }, 10)
            .unwrap();
        assert_eq!(hits.len(), 0);

        // inherited=false: marker_type=project still returns b1 (it OWNS project)
        let (_total, hits) = service
            .search_with_filters("", SearchFilters {
                marker_type: Some("project".into()),
                include_inherited: Some(false),
                ..Default::default()
            }, 10)
            .unwrap();
        assert_eq!(hits.len(), 2); // b1 and b2 both own project
    }

    #[test]
    fn test_filter_combined_marker_type_and_outlink() {
        let (_dir, manager) = create_enriched_index(&test_docs());
        let service = SearchService::new(manager);

        // marker_type=project AND outlink="Issue #264" → only b2
        let (_total, hits) = service
            .search_with_filters("project meeting fixing text", SearchFilters {
                marker_type: Some("project".into()),
                outlink: Some("Issue #264".into()),
                ..Default::default()
            }, 10)
            .unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].block_id, "b2");
    }
}
