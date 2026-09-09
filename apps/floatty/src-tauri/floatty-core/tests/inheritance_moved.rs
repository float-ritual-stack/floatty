//! Effective markers follow a move — `InheritanceIndexHook` on `BlockChange::Moved`.
//!
//! Query-views brief D §3 asked for proof: the hook matches `Deleted` and
//! `CollapsedChanged` by name and replans "everything else"
//! (`inheritance_index.rs`, `process`), so `Moved` was never named and never
//! tested. This harness reparents a block from under a `[project::alpha]`
//! ancestor to under a `[project::beta]` ancestor, dispatches the `Moved` the
//! store would emit for that reparent (`Store::compute_changes` for a CRDT
//! drag, `block_service::update_block_locked` for `PATCH parentId`), and
//! asserts the block's EFFECTIVE (inherited) markers flip.
//!
//! Same harness style as `flo927_lock_order.rs`: the REAL hooks, the REAL
//! store, dispatched through the REAL `HookRegistry` so priority order
//! (Metadata 10 → PropStamp 12 → Inheritance 15) is the one production uses.

use std::sync::Arc;

use floatty_core::hooks::{HookRegistry, InheritanceIndexHook, MetadataExtractionHook};
use floatty_core::{BlockChange, BlockChangeBatch, Origin, YDocStore};
use tempfile::{tempdir, TempDir};
use yrs::{Array, ArrayPrelim, Map, Transact, WriteTxn};

const ALPHA: &str = "00000000-0000-4000-8000-000000000011";
const BETA: &str = "00000000-0000-4000-8000-000000000012";
const CARD: &str = "00000000-0000-4000-8000-000000000013";
const LEAF: &str = "00000000-0000-4000-8000-000000000014";

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

/// Reparent in the Y.Doc exactly as an applied CRDT update would leave it:
/// `parentId` on the block, `childIds` on both parents.
fn reparent(store: &YDocStore, id: &str, old_parent: &str, new_parent: &str) {
    let doc = store.doc();
    let doc_guard = doc.write().unwrap();
    let mut txn = doc_guard.transact_mut();
    let blocks = txn.get_or_insert_map("blocks");
    let block: yrs::MapRef = blocks.get_or_init(&mut txn, id);
    block.insert(&mut txn, "parentId", yrs::Any::String(new_parent.into()));
    for (parent, keep) in [(old_parent, false), (new_parent, true)] {
        let parent_map: yrs::MapRef = blocks.get_or_init(&mut txn, parent);
        let mut ids: Vec<String> = match parent_map.get(&txn, "childIds") {
            Some(yrs::Out::YArray(arr)) => arr
                .iter(&txn)
                .filter_map(|v| match v {
                    yrs::Out::Any(yrs::Any::String(s)) => Some(s.to_string()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        };
        ids.retain(|c| c != id);
        if keep {
            ids.push(id.to_string());
        }
        let any: Vec<yrs::Any> = ids
            .into_iter()
            .map(|c| yrs::Any::String(c.into()))
            .collect();
        parent_map.insert(&mut txn, "childIds", ArrayPrelim::from(any));
    }
}

/// Two project roots and a card (with one leaf child) under alpha.
fn seed_store() -> (TempDir, Arc<YDocStore>) {
    let dir = tempdir().unwrap();
    let store = YDocStore::open(&dir.path().join("moved.db"), "test").unwrap();
    insert_block(
        &store,
        ALPHA,
        "# Alpha board [project::alpha]",
        None,
        &[CARD],
    );
    insert_block(&store, BETA, "# Beta board [project::beta]", None, &[]);
    insert_block(&store, CARD, "card [issue::DEMO-1]", Some(ALPHA), &[LEAF]);
    insert_block(&store, LEAF, "leaf under the card", Some(CARD), &[]);
    (dir, Arc::new(store))
}

fn created(id: &str, content: &str, parent: Option<&str>) -> BlockChange {
    BlockChange::Created {
        id: id.to_string(),
        content: content.to_string(),
        parent_id: parent.map(str::to_string),
        origin: Origin::Remote,
    }
}

fn inherited(hook: &InheritanceIndexHook, id: &str) -> Vec<(String, String, String)> {
    hook.index()
        .read()
        .unwrap()
        .get(id)
        .iter()
        .map(|m| {
            (
                m.marker_type.clone(),
                m.value.clone(),
                m.source_block_id.clone(),
            )
        })
        .collect()
}

#[test]
fn effective_markers_follow_a_move_between_project_ancestors() {
    let (_dir, store) = seed_store();

    let registry = HookRegistry::new();
    let inheritance = Arc::new(InheritanceIndexHook::new());
    registry.register(Arc::new(MetadataExtractionHook));
    registry.register(inheritance.clone());

    // Seed: Created for the whole tree in one batch — extraction populates
    // `metadata.markers` on the roots, inheritance derives the card's chain.
    let mut batch = BlockChangeBatch::new();
    batch.push(created(ALPHA, "# Alpha board [project::alpha]", None));
    batch.push(created(BETA, "# Beta board [project::beta]", None));
    batch.push(created(CARD, "card [issue::DEMO-1]", Some(ALPHA)));
    batch.push(created(LEAF, "leaf under the card", Some(CARD)));
    registry.dispatch(&batch, Arc::clone(&store));

    assert_eq!(
        inherited(&inheritance, CARD),
        vec![("project".into(), "alpha".into(), ALPHA.into())],
        "card inherits project=alpha before the move"
    );
    let leaf_before = inherited(&inheritance, LEAF);
    assert!(
        leaf_before.contains(&("project".into(), "alpha".into(), ALPHA.into())),
        "leaf inherits project=alpha through the card: {leaf_before:?}"
    );
    assert!(
        leaf_before.contains(&("issue".into(), "DEMO-1".into(), CARD.into())),
        "leaf inherits the card's own issue marker: {leaf_before:?}"
    );

    // The move: Y.Doc first (what an applied update looks like), then the
    // single `Moved` the store diffs out of it. No ContentChanged — the
    // hook must react to Moved alone.
    reparent(&store, CARD, ALPHA, BETA);
    let mut batch = BlockChangeBatch::new();
    batch.push(BlockChange::Moved {
        id: CARD.to_string(),
        old_parent_id: Some(ALPHA.to_string()),
        new_parent_id: Some(BETA.to_string()),
        origin: Origin::Remote,
    });
    registry.dispatch(&batch, Arc::clone(&store));

    assert_eq!(
        inherited(&inheritance, CARD),
        vec![("project".into(), "beta".into(), BETA.into())],
        "card's effective project flips alpha → beta on Moved"
    );
    let leaf_after = inherited(&inheritance, LEAF);
    assert!(
        leaf_after.contains(&("project".into(), "beta".into(), BETA.into()))
            && !leaf_after.iter().any(|(_, value, _)| value == "alpha"),
        "descendants of the moved block follow it: {leaf_after:?}"
    );
}

#[test]
fn moving_to_root_drops_inherited_markers() {
    let (_dir, store) = seed_store();
    let registry = HookRegistry::new();
    let inheritance = Arc::new(InheritanceIndexHook::new());
    registry.register(Arc::new(MetadataExtractionHook));
    registry.register(inheritance.clone());

    let mut batch = BlockChangeBatch::new();
    batch.push(created(ALPHA, "# Alpha board [project::alpha]", None));
    batch.push(created(CARD, "card [issue::DEMO-1]", Some(ALPHA)));
    registry.dispatch(&batch, Arc::clone(&store));
    assert_eq!(inherited(&inheritance, CARD).len(), 1);

    // To root: clear parentId, drop from alpha's childIds.
    {
        let doc = store.doc();
        let doc_guard = doc.write().unwrap();
        let mut txn = doc_guard.transact_mut();
        let blocks = txn.get_or_insert_map("blocks");
        let block: yrs::MapRef = blocks.get_or_init(&mut txn, CARD);
        block.remove(&mut txn, "parentId");
        let alpha: yrs::MapRef = blocks.get_or_init(&mut txn, ALPHA);
        alpha.insert(
            &mut txn,
            "childIds",
            ArrayPrelim::from(Vec::<yrs::Any>::new()),
        );
    }
    let mut batch = BlockChangeBatch::new();
    batch.push(BlockChange::Moved {
        id: CARD.to_string(),
        old_parent_id: Some(ALPHA.to_string()),
        new_parent_id: None,
        origin: Origin::User,
    });
    registry.dispatch(&batch, Arc::clone(&store));
    assert!(
        inherited(&inheritance, CARD).is_empty(),
        "a root block inherits nothing"
    );
}
