//! FLO-927 regression — index-hook ↔ handler lock-order cycle.
//!
//! Production forensics (2026-08-24, two total hangs of floatty-server): every
//! tokio worker parked in `futex_wait`, `/health` dead, last log line a Y.Doc
//! compaction. The wedge is a three-party lock cycle between the Y.Doc
//! `RwLock` and a hook index `RwLock`:
//!
//! ```text
//! HTTP handler   : doc.read()      → index.read()          (block_service.rs)
//! index hook     : index.write()   → store.get_block()      (= doc.read())
//! any writer     : doc.write()                              (POST /update, CRUD)
//! ```
//!
//! Two readers never conflict — until a writer QUEUES on `doc`. `std::sync::RwLock`
//! (Linux futex impl and macOS queue impl alike) refuses NEW readers while a
//! writer is waiting, so:
//!
//! * hook   : holds `index.write()`, blocks on `doc.read()`   (writer queued)
//! * handler: holds `doc.read()`,    blocks on `index.read()` (hook holds write)
//! * writer : blocks on `doc.write()`                         (handler holds read)
//!
//! Permanent. Every later `doc.read()` queues behind the writer → the worker
//! pool drains → nothing (not even `/health`) is scheduled.
//!
//! This test reproduces the cycle with the REAL hooks and the REAL store, on
//! plain OS threads (no tokio needed — the cycle is in the locks, the runtime
//! only decides how loud the failure is). It is deterministic in both
//! directions:
//!
//! * broken hook: the handler cannot get `index.read()` for `PROBE_TIMEOUT`
//!   while the hook sits on `doc.read()` holding `index.write()` → FAIL.
//! * fixed hook (store reads happen BEFORE `index.write()`): the hook waits on
//!   `doc.read()` holding nothing, the handler's `index.try_read()` succeeds at
//!   once, the handler releases `doc`, the writer runs, the hook runs → PASS,
//!   independent of thread scheduling.
//!
//! The handler probe uses `try_read()` + polling so a broken hook produces a
//! named assertion failure instead of a hung test process: once the handler
//! gives up it drops `doc.read()`, the writer proceeds, the hook unblocks.

use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use floatty_core::hooks::{BlockHook, InheritanceIndexHook, PageNameIndexHook};
use floatty_core::{BlockChange, BlockChangeBatch, Origin, YDocStore};
use tempfile::tempdir;
use yrs::{ArrayPrelim, Map, Transact, WriteTxn};

/// How long the simulated handler keeps trying to take `index.read()` while
/// holding `doc.read()`. On a broken hook this is the time-to-failure; on a
/// fixed hook the probe succeeds on the first attempt.
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// Grace so the writer is genuinely QUEUED on `doc.write()` (it blocks inside
/// the OS lock; there is no observable "is queued" state) before the hook is
/// started. Only affects how reliably the BROKEN configuration fails.
const QUEUE_GRACE: Duration = Duration::from_millis(150);

fn insert_block(
    store: &YDocStore,
    id: &str,
    content: &str,
    parent_id: Option<&str>,
    child_ids: &[&str],
) {
    let doc = store.doc();
    let doc_guard = doc.write().unwrap();
    let mut txn = doc_guard.transact_mut();
    let blocks = txn.get_or_insert_map("blocks");
    let block_map: yrs::MapRef = blocks.get_or_init(&mut txn, id);
    block_map.insert(&mut txn, "content", yrs::Any::String(content.into()));
    if let Some(pid) = parent_id {
        block_map.insert(&mut txn, "parentId", yrs::Any::String(pid.into()));
    }
    let child_any: Vec<yrs::Any> = child_ids
        .iter()
        .map(|c| yrs::Any::String((*c).into()))
        .collect();
    block_map.insert(&mut txn, "childIds", ArrayPrelim::from(child_any));
}

/// A small tree: `pages::` container → page → child. Enough for every hook
/// code path under test to call into the store at least once.
fn seed_store() -> Arc<YDocStore> {
    let dir = tempdir().unwrap();
    let store = YDocStore::open(&dir.path().join("flo927.db"), "test").unwrap();
    // Keep the tempdir alive for the process lifetime — the store owns an
    // open SQLite handle into it.
    std::mem::forget(dir);
    insert_block(&store, "pages", "pages::", None, &["page-1"]);
    insert_block(&store, "page-1", "# Demo Page", Some("pages"), &["child-1"]);
    insert_block(
        &store,
        "child-1",
        "child content [[Demo Page]]",
        Some("page-1"),
        &[],
    );
    Arc::new(store)
}

#[derive(Debug, PartialEq)]
enum Outcome {
    HandlerDone,
    HandlerTimedOut,
    WriterDone,
    HookDone,
}

/// Run the three-party probe against `hook`. `probe_index` must attempt a
/// NON-blocking read of the hook's index (`try_read().is_ok()`).
///
/// Returns the outcomes in completion order.
fn run_cycle_probe(
    hook: Arc<dyn BlockHook>,
    store: Arc<YDocStore>,
    batch: BlockChangeBatch,
    probe_index: Arc<dyn Fn() -> bool + Send + Sync>,
) -> Vec<Outcome> {
    let (outcome_tx, outcome_rx) = mpsc::channel::<Outcome>();
    let (held_tx, held_rx) = mpsc::channel::<()>();
    let (hook_started_tx, hook_started_rx) = mpsc::channel::<()>();

    // ── handler: doc.read() held, then wants index.read() ──────────────────
    let handler = {
        let store = Arc::clone(&store);
        let tx = outcome_tx.clone();
        thread::spawn(move || {
            let doc = store.doc();
            let _doc_guard = doc.read().unwrap();
            held_tx.send(()).unwrap();
            // Wait until the hook thread is running so the probe measures the
            // hook's lock behaviour, not an empty index.
            hook_started_rx.recv().unwrap();
            thread::sleep(QUEUE_GRACE);
            let deadline = Instant::now() + PROBE_TIMEOUT;
            let outcome = loop {
                if probe_index() {
                    break Outcome::HandlerDone;
                }
                if Instant::now() >= deadline {
                    break Outcome::HandlerTimedOut;
                }
                thread::sleep(Duration::from_millis(10));
            };
            tx.send(outcome).unwrap();
            // _doc_guard drops here → writer can proceed → hook can proceed.
        })
    };

    // Handler holds doc.read() from here on.
    held_rx.recv().unwrap();

    // ── writer: queue a doc.write() behind the handler ──────────────────────
    let writer = {
        let store = Arc::clone(&store);
        let tx = outcome_tx.clone();
        thread::spawn(move || {
            let doc = store.doc();
            let guard = doc.write().unwrap();
            drop(guard);
            tx.send(Outcome::WriterDone).unwrap();
        })
    };
    thread::sleep(QUEUE_GRACE);

    // ── hook: the real hook, the real batch ────────────────────────────────
    let hook_thread = {
        let store = Arc::clone(&store);
        let tx = outcome_tx;
        thread::spawn(move || {
            hook_started_tx.send(()).unwrap();
            hook.process(&batch, store);
            tx.send(Outcome::HookDone).unwrap();
        })
    };

    let mut outcomes = Vec::new();
    let overall_deadline = Instant::now() + PROBE_TIMEOUT * 3;
    while outcomes.len() < 3 {
        let remaining = overall_deadline.saturating_duration_since(Instant::now());
        match outcome_rx.recv_timeout(remaining) {
            Ok(o) => outcomes.push(o),
            Err(_) => break,
        }
    }
    let _ = handler.join();
    let _ = writer.join();
    let _ = hook_thread.join();
    outcomes
}

fn assert_no_cycle(outcomes: &[Outcome], hook_name: &str) {
    assert!(
        !outcomes.contains(&Outcome::HandlerTimedOut),
        "FLO-927 lock-order cycle: a handler holding doc.read() could not acquire \
         {hook_name} index.read() within {PROBE_TIMEOUT:?} while the hook held \
         index.write() and waited on doc.read() behind a queued writer. \
         Hooks must finish ALL store reads before taking index.write(). \
         outcomes={outcomes:?}"
    );
    assert_eq!(outcomes.len(), 3, "not every party finished: {outcomes:?}");
    assert!(outcomes.contains(&Outcome::HandlerDone));
    assert!(outcomes.contains(&Outcome::WriterDone));
    assert!(outcomes.contains(&Outcome::HookDone));
}

#[test]
fn inheritance_index_hook_never_holds_index_write_across_store_reads() {
    let store = seed_store();
    let hook = Arc::new(InheritanceIndexHook::new());
    let index = hook.index();

    let mut batch = BlockChangeBatch::new();
    batch.push(BlockChange::ContentChanged {
        id: "child-1".to_string(),
        old_content: "old".to_string(),
        new_content: "child content [[Demo Page]]".to_string(),
        origin: Origin::Remote,
    });

    let outcomes = run_cycle_probe(
        hook,
        store,
        batch,
        Arc::new(move || index.try_read().is_ok()),
    );
    assert_no_cycle(&outcomes, "InheritanceIndexHook");
}

#[test]
fn inheritance_index_hook_cold_start_rebuild_never_holds_index_write_across_store_reads() {
    let store = seed_store();
    let hook = Arc::new(InheritanceIndexHook::new());
    let index = hook.index();

    let mut batch = BlockChangeBatch::with_transaction_id(
        floatty_core::events::COLD_START_REHYDRATION_TX_ID.to_string(),
    );
    batch.push(BlockChange::ContentChanged {
        id: "child-1".to_string(),
        old_content: String::new(),
        new_content: "child content [[Demo Page]]".to_string(),
        origin: Origin::BulkImport,
    });

    let outcomes = run_cycle_probe(
        hook,
        store,
        batch,
        Arc::new(move || index.try_read().is_ok()),
    );
    assert_no_cycle(&outcomes, "InheritanceIndexHook(rebuild)");
}

#[test]
fn page_name_index_hook_never_holds_index_write_across_store_reads() {
    let store = seed_store();
    let hook = Arc::new(PageNameIndexHook::new());
    let index = hook.index();

    // Exercise every store-reading handler in one batch: created (page under
    // pages::), content changed, moved. Deleted reads nothing.
    let mut batch = BlockChangeBatch::new();
    batch.push(BlockChange::Created {
        id: "pages".to_string(),
        content: "pages::".to_string(),
        parent_id: None,
        origin: Origin::Remote,
    });
    batch.push(BlockChange::Created {
        id: "page-1".to_string(),
        content: "# Demo Page".to_string(),
        parent_id: Some("pages".to_string()),
        origin: Origin::Remote,
    });
    batch.push(BlockChange::ContentChanged {
        id: "child-1".to_string(),
        old_content: "old".to_string(),
        new_content: "child content [[Demo Page]]".to_string(),
        origin: Origin::Remote,
    });
    batch.push(BlockChange::Moved {
        id: "page-1".to_string(),
        old_parent_id: None,
        new_parent_id: Some("pages".to_string()),
        origin: Origin::Remote,
    });

    let outcomes = run_cycle_probe(
        hook,
        store,
        batch,
        Arc::new(move || index.try_read().is_ok()),
    );
    assert_no_cycle(&outcomes, "PageNameIndexHook");
}

#[test]
fn page_name_index_hook_cold_start_rebuild_never_holds_index_write_across_store_reads() {
    let store = seed_store();
    let hook = Arc::new(PageNameIndexHook::new());
    let index = hook.index();

    let mut batch = BlockChangeBatch::with_transaction_id(
        floatty_core::events::COLD_START_REHYDRATION_TX_ID.to_string(),
    );
    batch.push(BlockChange::ContentChanged {
        id: "child-1".to_string(),
        old_content: String::new(),
        new_content: "child content [[Demo Page]]".to_string(),
        origin: Origin::BulkImport,
    });

    let outcomes = run_cycle_probe(
        hook,
        store,
        batch,
        Arc::new(move || index.try_read().is_ok()),
    );
    assert_no_cycle(&outcomes, "PageNameIndexHook(rebuild)");
}

/// Sanity check on the primitive the cycle depends on: with a writer queued,
/// `std::sync::RwLock` refuses a new reader. If a future platform/libstd
/// changes this, the four tests above lose their teeth — this one says why.
#[test]
fn std_rwlock_blocks_new_readers_while_a_writer_is_queued() {
    let lock = Arc::new(std::sync::RwLock::new(0u8));
    let held = lock.read().unwrap();
    let writer = {
        let lock = Arc::clone(&lock);
        thread::spawn(move || {
            let g = lock.write().unwrap();
            drop(g);
        })
    };
    thread::sleep(QUEUE_GRACE);
    assert!(
        lock.try_read().is_err(),
        "std RwLock granted a new reader while a writer was queued — the \
         FLO-927 probe tests cannot detect the cycle on this platform"
    );
    drop(held);
    writer.join().unwrap();
}
