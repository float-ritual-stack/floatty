# Image System Rewrite — Design Spec

**Date**: 2026-06-24
**Status**: Proposed (captured; implementation deferred to a fresh session)
**Scope**: Rewrite floatty's image/attachment block (`img::` / `ImgView`) — caching,
display/UX, paste-to-upload, and a future R2 + optimization + AI-alt-text arc.

## Motivation

The current `img::` block (`components/views/ImgView.tsx`, an output block with
`outputType: 'img-view'`) has accumulated real friction:

- **No caching at any layer.** `ImgView` fetches → blob URL on mount, **revokes on
  unmount**, re-fetches on remount. The server
  (`floatty-server/src/api/discovery.rs::get_attachment`) returns only
  `Content-Type` — no `Cache-Control` / `ETag` / `Last-Modified`. So closing +
  reopening a block re-downloads the full file. With 6 MB images and 16–25 MB PDFs
  served from float-box over the tailnet (remote mode), that's a noticeable lag on
  every open. (Diagnosed 2026-06-24.)
- **No alignment or sizing.** No left / center / right / full-bleed / explicit
  width. The only control is a right-edge drag that sets `max-width` in a
  component-local signal — lost on reload (never persisted).
- **Broken interactions.** The block move/drag handle doesn't work on image
  blocks; resize only works from the right border (not corners/other edges).
- **Poor focus/keyboard.** Arrowing onto an image block shows no focus indication;
  when a ring does appear it doesn't match the rendered image bounds (the
  output-block focus wrapper doesn't wrap the image).

## Storage decision (the anchor)

Per-image display settings live in a **`block.imgConfig`** field, mirroring the
proven **`block.tableConfig`** pattern (`lib/blockTypes.ts`):

> `tableConfig` is *"Stored in Y.Doc but not synced to Rust (UI-only state like
> output fields)"* — it CRDT-syncs **between clients** through the shared Y.Doc
> (float-box authority), with **no Rust / ts-rs schema change**. Confirmed in
> practice: resizing table columns on one Mac syncs to the other within ~1 s.

```ts
interface ImgConfig {
  align?: 'left' | 'center' | 'right' | 'full';
  width?: number; // percentage of the content column
}
```

- Persisted via a `store.updateImgConfig(id, cfg)` helper (mirror
  `store.updateTableConfig`), written to the Y.Doc block field.
- The `img:: <path>` **content stays clean** — no display markers in the editable
  text.
- Syncs across machines for free (same mechanism as table column widths).

Rejected alternatives: content markers (`[align::center] [width::55%]`) — works but
clutters the editable content; `block.output.data` — output is client-only, won't
persist or sync.

## Reference patterns (lean on these — don't reinvent)

- **`TableView` / `components/BlockDisplay.tsx`** — the config + resize loop:
  `tableConfig` field, `onTableConfigChange` → `store.updateTableConfig`, resize
  math that normalizes + writes. Copy this shape for `imgConfig` + resize.
  (Per the user: "we did a good job with that table component and should reference
  it more often.")
- **`.claude/rules/output-block-patterns.md`** — output blocks are keyboard dead
  zones without a focusable wrapper + focus-routing effect; embedded views must be
  display-only with a single focus point. The focus-ring fix lives here.
- **`PinShelfView.tsx` drag-reorder** (2026-06-24) — pointer-capture + 4 px
  move-threshold + edge auto-scroll; the image block's **move handle should route
  through the same block-reorder mechanism** (`store.moveBlock`).
- **Attachment caching analysis** (this session) — client fetches per-mount, server
  sends no cache headers; both must change.
- Before copying any of these, run `.claude/rules/pattern-fit-check.md` (the
  table-config invariants — per-block UI state, Y.Doc-synced, not in Rust schema —
  match the image's needs exactly; no compensation needed).

## Phases

Core (1–3) ship the immediate pain relief against the existing local-disk backend.
Future (4–6) evolve the backend; the Phase-3 **storage interface** is the seam that
makes them drop-ins, not rewrites.

### Phase 1 — Caching  *(smallest, highest pain relief, independent)*

- **Client**: a module-level LRU blob cache keyed by `serverUrl + filename`. On
  mount, reuse the cached blob URL; only `fetch()` on miss. Don't revoke cached
  entries on unmount; evict via LRU (cap ~30 entries **or** a total-bytes budget,
  e.g. 150 MB) and revoke the object URL on eviction. Attachments are immutable
  (filename = fixed bytes) so entries never go stale.
- **Server**: `get_attachment` adds `Cache-Control: public, max-age=31536000,
  immutable` (+ optional `ETag` from file hash/mtime) so WKWebView HTTP-caches too.
- **Verify**: reopen a large PDF → instant (no network). Memory bounded under the
  cap. (Caveat: WKWebView HTTP-cache behaviour for blob-producing `fetch()` is
  finicky — the client LRU is the deterministic layer; the header is the
  correct-citizen complement.)

### Phase 2 — Display rewrite

- `imgConfig {align, width}` field + `store.updateImgConfig`.
- Align controls: left / center / right / full-bleed / explicit %.
- Resize from **corners + edges** (not just the right border), writing
  `imgConfig.width`.
- **Move handle works**: route block-drag through `store.moveBlock` (like the
  pin-shelf drag).
- **Focus ring wraps the image**: fix the output-block focusable wrapper so the
  indicator matches the rendered image/iframe bounds; obvious indication when
  arrowed-onto.

### Phase 3 — Paste-to-upload  *(and the R2 seam)*

- Paste or drop an image/PDF onto the outline → upload → insert an `img:: <id>`
  block → warm the cache.
- **New server endpoint**: `POST /api/v1/attachments` (Rust) — accepts bytes,
  writes via a **storage interface**, returns the id/filename.
- **Storage interface** (the load-bearing future-proofing):

  ```rust
  trait AttachmentStore {
      async fn put(&self, bytes: Bytes, content_type: &str) -> Result<AttachmentId>;
      fn url(&self, id: &AttachmentId, width: Option<u32>) -> String; // width hint → Phase 5
  }
  ```

  Local-disk impl writes to `{data_dir}/__attachments`; `url` returns
  `/api/v1/attachments/<id>` (ignores `width`).

### Phase 4 — R2 backend  *(future)*

- Second `AttachmentStore` impl: `put` → Cloudflare R2 (S3-compatible); `url` → R2
  public/signed URL (or proxied through the server). No rewrite of Phase 3 if the
  interface is clean. (User has an R2 bucket available.)

### Phase 5 — Optimization  *(future)*

- `url(id, width)` returns a Cloudflare Image Resizing URL
  (`…/cdn-cgi/image/width=<w>/…`) sized to `imgConfig.width`. The **original stays
  in R2**; a smaller variant is served on the fly. **No server-side image
  processing.**

### Phase 6 — AI alt-text + indexing  *(definitely-not-now)*

- On upload (or a backfill pass), a vision model writes a description of the image
  → stored as alt-text **and** indexed (Tantivy) so images are **searchable by
  content**. Improves accessibility and lets `search::` find images by what's in
  them.

## Build order

`1 → 2 → 3` now (core, against local-disk). `4 → 5 → 6` as a later
backend-evolution arc. **Phase 1 is the clean fresh-session start** — smallest, and
it kills the worst pain (re-fetching 16–25 MB PDFs on every open).

## Open questions (resolve at implementation time)

- Align/resize controls: hover/focus toolbar vs keyboard-driven vs both? (Obvious
  keyboard focus indication is a requirement; active resize-via-keys is a
  nice-to-have.)
- Cache eviction policy: entry-count cap vs byte-budget vs both.
- `ETag` source for Phase 1: file mtime vs content hash.
- Phase 3 attachment id scheme: keep human-ish filenames vs content-hash ids
  (content-hash ids pair naturally with `immutable` caching + R2).
