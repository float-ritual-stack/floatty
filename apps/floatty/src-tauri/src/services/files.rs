/// Recent agent-written files (FLO-799)
///
/// Pure business logic over the `file_events` table the JSONL watcher fills.
/// Testable without a Tauri runtime.
use crate::db::{FileEvent, FloattyDb};
use std::sync::Arc;

/// Rows returned when the caller doesn't specify.
pub const DEFAULT_RECENT_FILES_LIMIT: i32 = 50;

/// Upper bound. The query already collapses to one row per distinct path, but
/// an unbounded limit would still drag the whole table across the IPC boundary.
const MAX_RECENT_FILES_LIMIT: i32 = 200;

/// Most recently written files, newest first, one row per distinct path.
pub fn get_recent_files(db: &Arc<FloattyDb>, limit: i32) -> Result<Vec<FileEvent>, String> {
    let limit = limit.clamp(1, MAX_RECENT_FILES_LIMIT);
    db.get_recent_files(limit).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::FileEventInsert;

    fn event(id: &str, path: &str, time: &str) -> FileEventInsert {
        FileEventInsert {
            id: id.to_string(),
            file_path: path.to_string(),
            tool_name: "Write".to_string(),
            event_time: Some(time.to_string()),
            ..Default::default()
        }
    }

    fn seeded_db(events: &[FileEventInsert]) -> Arc<FloattyDb> {
        let db = Arc::new(FloattyDb::open_in_memory().expect("open in-memory db"));
        db.insert_scan_with_position("/path/to/session.jsonl", &[], events, 0)
            .expect("seed file events");
        db
    }

    #[test]
    fn returns_newest_first() {
        let db = seeded_db(&[
            event("a", "/path/to/old.md", "2026-07-10T10:00:00.000Z"),
            event("b", "/path/to/new.md", "2026-07-12T10:00:00.000Z"),
        ]);

        let recent = get_recent_files(&db, 10).expect("query");
        let paths: Vec<_> = recent.iter().map(|e| e.file_path.as_str()).collect();
        assert_eq!(paths, vec!["/path/to/new.md", "/path/to/old.md"]);
    }

    #[test]
    fn collapses_repeated_writes_to_latest_per_path() {
        // The same file edited three times is one row carrying the newest edit.
        let db = seeded_db(&[
            event("a", "/path/to/spec.md", "2026-07-12T10:00:00.000Z"),
            event("b", "/path/to/spec.md", "2026-07-12T11:00:00.000Z"),
            event("c", "/path/to/spec.md", "2026-07-12T12:00:00.000Z"),
            event("d", "/path/to/other.md", "2026-07-12T09:00:00.000Z"),
        ]);

        let recent = get_recent_files(&db, 10).expect("query");
        assert_eq!(recent.len(), 2, "one row per distinct path");

        let spec = &recent[0];
        assert_eq!(spec.file_path, "/path/to/spec.md");
        assert_eq!(
            spec.event_time.as_deref(),
            Some("2026-07-12T12:00:00.000Z"),
            "carries the newest event, not the first"
        );
    }

    #[test]
    fn limit_is_clamped_to_a_sane_range() {
        let db = seeded_db(&[
            event("a", "/path/to/one.md", "2026-07-12T10:00:00.000Z"),
            event("b", "/path/to/two.md", "2026-07-12T11:00:00.000Z"),
        ]);

        assert_eq!(get_recent_files(&db, 1).expect("query").len(), 1);
        // Zero/negative would otherwise mean "no rows" (or error) in SQLite.
        assert_eq!(get_recent_files(&db, 0).expect("query").len(), 1);
        assert_eq!(get_recent_files(&db, -5).expect("query").len(), 1);
        assert_eq!(get_recent_files(&db, 9_999).expect("query").len(), 2);
    }

    #[test]
    fn rescanning_the_same_events_is_idempotent() {
        // The watcher replays lines after a crash; tool_use ids make that safe.
        let events = [event("a", "/path/to/spec.md", "2026-07-12T10:00:00.000Z")];
        let db = seeded_db(&events);

        let second = db
            .insert_scan_with_position("/path/to/session.jsonl", &[], &events, 0)
            .expect("replay");
        assert_eq!(second.file_events, 0, "replayed rows are ignored");
        assert_eq!(get_recent_files(&db, 10).expect("query").len(), 1);
    }
}
