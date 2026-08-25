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
    IndexWriterDone,
}

/// Run the three-party probe against a hook that takes its index WRITE lock
/// (`InheritanceIndexHook`, `PageNameIndexHook`). `probe_index` must attempt
/// a NON-blocking read of the hook's index (`try_read().is_ok()`).
///
/// For a hook that holds an index READ guard across store reads see
/// [`run_tantivy_probe`] — that shape needs a queued index writer to wedge.
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

fn assert_no_cycle(parties: usize, outcomes: &[Outcome], hook_name: &str) {
    assert!(
        !outcomes.contains(&Outcome::HandlerTimedOut),
        "FLO-927 lock-order cycle: a handler holding doc.read() could not acquire \
         {hook_name} index.read() within {PROBE_TIMEOUT:?} while the hook held \
         an index guard and waited on doc.read() behind a queued writer. \
         Hooks must finish ALL store reads before taking ANY index lock. \
         outcomes={outcomes:?}"
    );
    assert_eq!(
        outcomes.len(),
        parties,
        "not every party finished: {outcomes:?}"
    );
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
    assert_no_cycle(3, &outcomes, "InheritanceIndexHook");
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
    assert_no_cycle(3, &outcomes, "InheritanceIndexHook(rebuild)");
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
    assert_no_cycle(3, &outcomes, "PageNameIndexHook");
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
    assert_no_cycle(3, &outcomes, "PageNameIndexHook(rebuild)");
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

// ── Tantivy: an ASYNC hook holding an index READ guard across store reads ─
//
// `TantivyIndexHook` is `is_sync() == false` (`tokio::spawn`ed), so it runs
// concurrently with the SYNC hooks of later batches. Pre-fix, `index_block`
// held `page_name_index.read()` across `walk_ancestors(StoreParentLookup)` +
// `compute_subtree_size(store)` — hundreds of `doc.read()`s. Four parties:
//
//   tantivy : page_name_index.read() → doc.read()   (STORE under INDEX — the bug)
//   writer  : doc.write()                           (queued behind the handler)
//   pni-w   : page_name_index.write()               (PageNameIndexHook's shape; queued behind tantivy)
//   handler : doc.read() → page_name_index.read()   (blocked by the queued pni writer)
//
// Choreography: the hook's index-held window is detected by spinning on
// `page_name_index.try_write()` — the instant it fails, the hook holds the
// read guard. Queue the doc writer, then the index writer, then release the
// handler's probe. A wide subtree under the indexed block makes the window
// milliseconds long (≈800 store reads) so detection is not a coin toss.
// Post-fix the guard is only held for in-memory lookups, so whether or not
// the detector catches it, no store read happens under it and all four
// parties finish.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::RwLock;

use floatty_core::hooks::tantivy_index::TantivyIndexHook;
use floatty_core::hooks::{InheritanceIndex, PageNameIndex};
use floatty_core::search::WriterHandle;

fn run_tantivy_probe(
    store: Arc<YDocStore>,
    pni: Arc<RwLock<PageNameIndex>>,
    hook: Arc<dyn BlockHook>,
    batch: BlockChangeBatch,
) -> Vec<Outcome> {
    let (outcome_tx, outcome_rx) = mpsc::channel::<Outcome>();
    let (held_tx, held_rx) = mpsc::channel::<()>();
    let (go_tx, go_rx) = mpsc::channel::<()>();
    let hook_done = Arc::new(AtomicBool::new(false));

    // ── handler: doc.read() held, later wants page_name_index.read() ──────
    let handler = {
        let store = Arc::clone(&store);
        let pni = Arc::clone(&pni);
        let tx = outcome_tx.clone();
        thread::spawn(move || {
            let doc = store.doc();
            let _doc_guard = doc.read().unwrap();
            held_tx.send(()).unwrap();
            go_rx.recv().unwrap();
            let deadline = Instant::now() + PROBE_TIMEOUT;
            let outcome = loop {
                if pni.try_read().is_ok() {
                    break Outcome::HandlerDone;
                }
                if Instant::now() >= deadline {
                    break Outcome::HandlerTimedOut;
                }
                thread::sleep(Duration::from_millis(10));
            };
            tx.send(outcome).unwrap();
        })
    };
    held_rx.recv().unwrap();

    // ── hook: needs a tokio context (index_block spawns the writer send) ──
    let hook_thread = {
        let store = Arc::clone(&store);
        let done = Arc::clone(&hook_done);
        let tx = outcome_tx.clone();
        thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap();
            let _enter = rt.enter();
            hook.process(&batch, store);
            done.store(true, Ordering::Release);
            tx.send(Outcome::HookDone).unwrap();
        })
    };

    // ── detector: wait until the hook holds the index read (or is done) ───
    let detect_deadline = Instant::now() + PROBE_TIMEOUT;
    loop {
        match pni.try_write() {
            Ok(g) => drop(g),
            Err(_) => break, // hook holds page_name_index.read()
        }
        if hook_done.load(Ordering::Acquire) || Instant::now() >= detect_deadline {
            break;
        }
        std::hint::spin_loop();
    }

    // ── writer: queue doc.write() behind the handler ──────────────────────
    let writer = {
        let store = Arc::clone(&store);
        let tx = outcome_tx.clone();
        thread::spawn(move || {
            let doc = store.doc();
            drop(doc.write().unwrap());
            tx.send(Outcome::WriterDone).unwrap();
        })
    };
    thread::sleep(QUEUE_GRACE / 5);

    // ── index writer: queue page_name_index.write() behind the hook ───────
    let index_writer = {
        let pni = Arc::clone(&pni);
        let tx = outcome_tx;
        thread::spawn(move || {
            drop(pni.write().unwrap());
            tx.send(Outcome::IndexWriterDone).unwrap();
        })
    };
    thread::sleep(QUEUE_GRACE / 5);
    go_tx.send(()).unwrap();

    let mut outcomes = Vec::new();
    let overall_deadline = Instant::now() + PROBE_TIMEOUT * 3;
    while outcomes.len() < 4 {
        let remaining = overall_deadline.saturating_duration_since(Instant::now());
        match outcome_rx.recv_timeout(remaining) {
            Ok(o) => outcomes.push(o),
            Err(_) => break,
        }
    }
    let _ = handler.join();
    let _ = writer.join();
    let _ = index_writer.join();
    let _ = hook_thread.join();
    outcomes
}

#[test]
fn tantivy_index_hook_never_holds_index_read_across_store_reads() {
    let store = seed_store();
    // Wide subtree under the indexed block → compute_subtree_size performs
    // ~800 store reads, which is the window the detector needs to catch.
    let kids: Vec<String> = (0..800).map(|i| format!("leaf-{i}")).collect();
    let kid_refs: Vec<&str> = kids.iter().map(String::as_str).collect();
    insert_block(
        &store,
        "child-1",
        "child content [[Demo Page]]",
        Some("page-1"),
        &kid_refs,
    );
    for k in &kids {
        insert_block(&store, k, "leaf", Some("child-1"), &[]);
    }

    let (tx, _rx) = tokio::sync::mpsc::channel(1);
    let writer = WriterHandle::from_sender(tx);
    let inh = Arc::new(RwLock::new(InheritanceIndex::new()));
    let pni = Arc::new(RwLock::new(PageNameIndex::new()));
    {
        let mut p = pni.write().unwrap();
        p.set_pages_container_id(Some("pages".to_string()));
        p.add_existing_page("Demo Page", "page-1", 1);
    }
    let hook: Arc<dyn BlockHook> = Arc::new(TantivyIndexHook::with_page_index(
        writer,
        inh,
        Arc::clone(&pni),
    ));

    let mut batch = BlockChangeBatch::new();
    batch.push(BlockChange::ContentChanged {
        id: "child-1".to_string(),
        old_content: "old".to_string(),
        new_content: "child content [[Demo Page]]".to_string(),
        origin: Origin::Remote,
    });

    let outcomes = run_tantivy_probe(store, pni, hook, batch);
    assert_no_cycle(4, &outcomes, "TantivyIndexHook");
}
