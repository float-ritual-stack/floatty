---
title: Boot sequence audit — what actually happens between double-click and first block
date: 2026-07-12
status: recon
related: "[[ADR-007]] [[2026-06-26-offline-and-fast-boot]] [[FLO-762]] [[FLO-317]] [[FLO-387]] [[ADR-006]]"
measured-against: v0.21.0, release, remote authority (float-box), 18,184 blocks
---

# Boot sequence audit

Recon for fast-boot Phase 1. Maps the current bootstrap end-to-end with
file:line evidence and real measured timings, then argues about what's wrong.
No code was changed.

**Headline, three findings:**

1. The outline first paints **77 seconds** after the HTTP client connects — on a
   boot where the client had a complete 27.5 MB copy of the outline sitting in
   IndexedDB the entire time, which it read, decoded, used only to compute a
   push-diff, ignored for the read path, and then **deleted**. The *uncached* boot
   is measurably **faster** (71.5 s). The cache is net negative.
2. `App.tsx:444-445` (the outermost `<Show when={!serverError()}>` gate) gates
   the *entire* application — **terminals included** — behind
   server reachability. An unreachable float-box replaces the app with an error
   screen while a full local copy of the outline sits unused on disk. Meanwhile a
   working boot-from-cache path **already exists** at `useSyncedYDoc.ts:2091-2105`
   and cannot be reached, because the gate fires first.
3. A **third, unnamed brick**: on two real failure paths the app hangs on
   `Loading workspace...` **forever, with no error and no retry** — because
   `useSyncedYDoc`'s `error` signal is populated and then **rendered by nothing**
   (§4c).

Findings 2 and 3 are cheaper to fix than [[ADR-007]] assumes and do not depend on
the fast-boot track. Finding 1 is the track.

---

## 1. Phase-by-phase table

Everything numbered 1–17 runs on the main thread inside `run()`
(`src-tauri/src/lib.rs:238-637`). The window does not exist until `.run(context)`
at `lib.rs:635`. **All of it blocks the window.**

### Rust — Tauri process

| # | Phase | What it does | file:line | Blocks window? | Failure mode | User sees |
|---|---|---|---|---|---|---|
| 1 | Paths | `DataPaths::resolve()` — `FLOATTY_DATA_DIR` → `~/.floatty-dev` (debug) / `~/.floatty` (release) | `lib.rs:240` → `paths.rs:46-53,76-88` | yes | infallible | — |
| 2 | **Preflight ([[FLO-317]])** | dev build must not land on `~/.floatty`; release must not land on `~/.floatty-dev` | `lib.rs:243-250` | yes | **panic!** — no log, no window | silent death / crash dialog |
| 3 | mkdir | `ensure_dirs()` — root, logs, search_index, doors | `lib.rs:253` → `paths.rs:102-108` | yes | `eprintln!` + **continue** (`lib.rs:254`) | nothing; logging then also fails |
| 4 | **Logging init** | `setup_logging()` — rolling JSONL appender, `EnvFilter` | `lib.rs:258` → `lib.rs:166-235` | yes | `eprintln!` + **`return;`** (`lib.rs:169`, `:183`) → **app runs with zero logging, no warning** | nothing |
| 5 | first log line | `"Floatty starting"` | `lib.rs:260-264` | yes | — | — |
| 6 | Tauri context | `generate_context!()` | `lib.rs:266` | yes | panic | — |
| 7 | Config | `AggregatorConfig::load_from()` | `lib.rs:269` → `config.rs:192-223` | yes | **silent degrade to defaults** (`config.rs:201`) — a typo'd `remote_server_url` silently drops you into **local spawn mode** | wrong outline, no explanation |
| 8 | **Server fork ([[FLO-762]])** | `remote_server_url` set → `connect_remote_server`; else `spawn_server` | `lib.rs:277-285` | yes | `Option<ServerState>`; `None` = no server | — |
| 8a | └ local spawn | probe → kill stale → spawn → `wait_for_server_health` **30 × (1 s + 100 ms) ≈ 33 s worst case** | `server.rs:264-370`, `:355`, `:655-670` | yes — window hostage to server bind | `None` | frozen dock icon |
| 8b | └ **remote (split-brain guard)** | 3 × (2 s curl timeout + 500 ms) **≈ 7.5 s worst case**, then `return None` | `server.rs:387-467`, guard at **`:408-415`** | yes | **`return None`** — no local spawn (correct), no offline state (fatal) | see §4 |
| 9 | SQLite | `FloattyDb::open_at()` — `ctx_markers.db`, WAL | `lib.rs:288` → `db.rs:149-171` | yes | `inner = None`, continue | ctx sidebar dead |
| 10 | legacy migration | `system_state.ydoc` → `ydoc_updates` | `lib.rs:291-334` | yes | log + continue | — |
| 11 | **Local Y.Doc replay** | `YDocStore::new()` — replays the entire local update log | **`lib.rs:339`** → `store.rs:296-421` | yes | `log::error!` + **`return;` — no window at all** (`lib.rs:342-344`) | silent death |
| 12–14 | ctx setup | `WatcherConfig`, `CtxWatcher::new`, `CtxParser::new` | `lib.rs:349-373` | yes (trivial) | `inner = None`, continue | — |
| 15 | ctx threads | `watcher.start()`, `parser.start()` | `lib.rs:376-377` | **no** — OS threads | parser runtime fail → **silent thread exit** (`ctx_parser.rs:169-171`), markers stay `pending` forever | ctx never parses, no error |
| 16 | Tauri builder | `.manage(state)`, plugins, `invoke_handler` | `lib.rs:415-513` | yes | `.expect` panic | — |
| 17 | **`.run(context)`** | **window/webview appears** | **`lib.rs:635`** | — | panic | — |
| — | orphan detector | `spawn` → sleep 30 s → hourly | `lib.rs:587-604` | no | `warn!` + return | — |
| — | door watcher | `thread::spawn` | `lib.rs:607-610` | no | `warn!` | — |

**Pre-subscriber window (answers the `eprintln!` question):** exactly three calls
precede `setup_logging()` — `DataPaths::resolve()` (`lib.rs:240`), the two
[[FLO-317]] `panic!` guards (`lib.rs:243-250`), and `ensure_dirs()`
(`lib.rs:253`). That is the whole window. One straggler: `find_server_binary()`
still uses `eprintln!` at `server.rs:554` and `server.rs:596` despite running
*post*-subscriber — in a bundled `.app` those lines go to a stderr nobody reads.

### Rust — floatty-server process (local mode only; on float-box in remote mode)

| Phase | file:line | Blocks? | Failure |
|---|---|---|---|
| `ServerConfig::load()` | `floatty-server/src/main.rs:208` | yes | pre-subscriber → `eprintln!` |
| mkdir logs | `main.rs:228-234` | yes | **panic!** |
| OTLP endpoint resolution (env → env → config) | `main.rs:235-242` | yes | — |
| `setup_logging()` + `init_otlp_logs/traces` | `main.rs:243`, `:52-74`, `:87-120` | yes (build only) | **degrades** — `eprintln!` + `None` layer (`main.rs:63`, `:109`) | 
| Y.Doc store replay → `phase=ydoc_store_ready` | `main.rs:301-312` | yes | — |
| hook system → `search_init_complete`, `cold_start_rehydration_complete` | `main.rs:316-321`, `hooks/system.rs:132-137`, `:148-155` | yes | — |
| bind → `phase=server_ready` | `main.rs:451-455`, `:477` | — | — |

**(c) OTLP does not block and does not fail startup.** The Tauri process has no
OTLP at all (`opentelemetry=off` in its filter, `lib.rs:221-227`). In
floatty-server, `init_otlp_*` only *builds* a batch exporter — no connect, no
network I/O. An unreachable collector drops exports on the floor; file logging is
unaffected. This one is correct as designed.

### Frontend (SolidJS)

| # | Phase | file:line | Blocks paint? | Failure | User sees |
|---|---|---|---|---|---|
| F1 | `connectServer()` → `initHttpClient()` | `App.tsx:55-64`, `httpClient.ts:291-338` | yes | 6 retries `[500,1000,1500,2000,3000]` then **throws** | — |
| F2 | `setServerError()` on throw | `App.tsx:71-74` | — | — | **§4: whole app replaced** |
| F3 | **outermost render gate** | **`App.tsx:444-445`** | — | `serverError()` non-null → error screen | **§4** |
| F4 | workspace load gate → `Loading...` | **`App.tsx:472`** | — | — | **§3 (a)** — unstyled div |
| F5 | `loadInitialState()` | `useSyncedYDoc.ts:1864` | — | — | — |
| F6 | read IDB backup (27.5 MB) | `:1928` | — | — | — |
| F7 | epoch lineage check (`getStateHash`) | `:1944-1966` | — | fail-closed, pull-only | — |
| F8 | `getStateVector()` + `Y.diffUpdate(backup, SV)` | `:1981-1985` | — | — | — |
| F9 | push local diff | `:1990-1998` | — | — | — |
| F10 | **`getState()` — full ~31 MB fetch** | **`:2001`** | — | — | — |
| F11 | **`Y.applyUpdate(doc, serverState)` — main thread** | **`:2006`** | **yes — this is the 77 s** | — | **§3 (a)** |
| F12 | **`clearBackup()`** | **`:2023`** | — | — | cache deleted |
| F13 | offline boot-from-cache branch | **`:2091-2105`** | — | — | **unreachable in the common case — see §4** |
| F14 | `sharedDocLoaded = true` → `connectWebSocket()` | `:2107`, `:2126` | — | — | — |
| F15 | `initFromYDoc()` — **second** full-doc main-thread walk | `Outliner.tsx:118-122` → `useBlockStore.ts:410-421` | **yes** | — | still `Loading workspace...` |
| F16 | outliner loading gate | **`Outliner.tsx:861`** | — | `sharedDocError` set but **never rendered** | **§3 (a)** — `Loading workspace...` for 77 s, or **forever** (§4c) |

---

## 2. Measured timeline (real logs, not estimates)

### Boot A — release, remote authority, 2026-07-12 19:20:26 → 19:21:47

Source: `~/.floatty/logs/floatty.2026-07-12.jsonl`. v0.21.0, 18,184 blocks.

| t | Event (verbatim) |
|---|---|
| 0.000 | `float_pty_lib: Floatty starting` |
| +0.002 | `float_pty_lib::config: Loaded config from "/Users/evan/.floatty/config.toml"` |
| +0.503 | `float_pty_lib::server: Remote floatty-server health check passed` |
| +1.212 | `float_pty_lib::server: Version skew between this app and the remote floatty-server` |
| +1.730 | `float_pty_lib::server: Connected to remote floatty-server (external mode, no local spawn)` |
| +1.746 | `floatty_core::store: [startup] db_open elapsed_ms=5` |
| **+2.325** | **`floatty_core::store: [startup] ydoc_replay_complete elapsed_ms=578 update_count=80 total_bytes=39164554`** |
| +2.328 | `float_pty_lib: ctx:: aggregation system initialized successfully` |
| +2.579 | `float_pty_lib: Window title set` ← **window appears** |
| +2.84 | `js/doors: Loaded 12/12 doors` |
| +3.273 | `js/httpClient: Connected to floatty-server at http://100.78.124.84:8765` |
| **+3.437** | **`js/idbBackup: Loaded backup: 27547432 bytes`** ← the cache IS read |
| +8.435 | `js/SyncHealth: Block count mismatch detected (1/2) \| Server: 18184 blocks \| Local: 0 blocks` |
| +32.58 | `float_pty_lib: Orphan detector: running initial check` ← runs against a 0-block store |
| **+80.59** | **`js/useSyncedYDoc: Reconciliation complete, seq: 14831, clearing backup`** |
| +80.59 | `js/WS: Connecting to ws://100.78.124.84:8765/ws` |
| +80.60 | `js/useSyncedYDoc: State looks healthy: 18184 blocks, 18 roots` |
| **+80.70** | `js/Outliner: [FLO-197] Applying initial_collapse_depth` ← **first outline paint** |
| +81.06 | `js/WS: Connected` |

**httpClient connect → outline on screen: 77.3 s.** Nothing outline-shaped is
rendered for the entire window. `Local: 0 blocks` at +8.4 s is the store still
being empty 5 s after a 27.5 MB cache was "loaded".

### Boot B — same day, 14:33:01 (no backup present)

```
14:33:01.056  js/httpClient: Connected to floatty-server at http://100.78.124.84:8765
14:34:12.577  js/useSyncedYDoc: Initial load complete, seq: 14340      ← +71.5 s
14:34:15.385  js/WS: Connected                                          ← +74.3 s
```

Boot B logged `Initial load complete` — a string that only exists in the
**no-backup** branch (`useSyncedYDoc.ts:2086`). Boot A logged
`Reconciliation complete` — the **backup** branch (`:2022`). So:

- **with** a cache: 77.3 s
- **without** a cache: 71.5 s

**The cache makes boot ~6 s slower.** It is not a fast path. It is added cost.

### Server-side phases (dev, local server, 2026-07-12 21:31:21)

Source: `~/.floatty-dev/logs/floatty.2026-07-12.jsonl`, `target: floatty_startup`.
These do not appear in release logs because in remote mode the server runs on
float-box.

```
21:31:21.469  [floatty_startup]      otlp_log_export_enabled
21:31:21.472  [floatty_core::store]  [startup] db_open elapsed_ms=2
21:31:22.606  [floatty_core::store]  [startup] ydoc_replay_complete elapsed_ms=1133 update_count=37 total_bytes=10778639
21:31:22.606  [floatty_core::store]  [startup] ydoc_store_open_complete elapsed_ms=1135
21:31:22.606  [floatty_startup]      phase=ydoc_store_ready
21:31:22.631  [floatty_startup]      search_init_complete                 ← +25 ms
21:31:22.648  [floatty_startup]      cold_start_rehydration_complete      ← +17 ms
21:31:22.648  [floatty_startup]      hook_system_init_complete
21:31:22.650  [floatty_startup]      phase=server_ready
21:31:22.671  [floatty_core::store]  [startup] db_open elapsed_ms=0       ← SECOND process
21:31:23.737  [floatty_core::store]  [startup] ydoc_replay_complete elapsed_ms=1065  ← SAME doc, again
```

Two things fall out:

1. **Server boot is 1.18 s, and 96 % of it is the Y.Doc replay** (1133 ms).
   `search_init` is 25 ms; hook system is ~2 ms. **Search and hooks are not the
   problem and never were.** Any effort aimed at them is misaimed.
2. **The same `ctx_markers.db` Y.Doc is replayed twice per boot** — once by
   floatty-server (1133 ms) and once by the Tauri process (1065 ms) — ~2.2 s of
   duplicated work in local mode.

---

## 3. Does this still make sense?

Ordered by how badly it fails the "instant start-up" goal.

### 3.1 The IndexedDB cache is read, decoded, and then thrown away — while the full doc is fetched anyway

This is the central defect, and it is worse than [[ADR-007]] states. The ADR says
the cache is "paid for and discarded." Measured, the sequence is:

```
:1928  getLocalBackup()                       read 27.5 MB from IDB
:1981  httpClient.getStateVector()            HTTP
:1985  Y.diffUpdate(useBackup, serverSV)      DECODE the 27.5 MB backup
:1992  httpClient.applyUpdate(localDiff)      push (this is all the backup is for)
:2001  httpClient.getState()                  ← FULL ~31 MB FETCH ANYWAY
:2006  Y.applyUpdate(doc, serverState)        ← FULL APPLY, main thread, 70+ s
:2023  clearBackup()                          ← DELETE THE CACHE
```

The backup is used **solely as a push-diff source**. It is never used to avoid
the pull. The client already holds a near-complete copy of the outline and still
downloads and re-applies the whole thing. Then it deletes the copy, so the next
boot has to rebuild it — which the periodic `saveBackupIDB` (`:1333`, `:1381`)
duly does, at 27.5 MB a write, dozens of times a day.

**This is a closed loop that costs money every lap and returns nothing.** Boot B
proves it: the no-cache path is *faster*.

### 3.2 The whole app is gated on server reachability, including local terminals

`App.tsx:476` is the outermost `<Show>`. When `serverError()` is set, `<Terminal />`
never mounts. PTYs are spawned locally by Tauri and have **nothing to do with
float-box** — the offline design doc §6 asserts "Terminals are unaffected …
confirm this stays true." **It is not true today.** It is not true at the UI
layer, and it never was: the terminal tree is inside the failed `<Show>`.

### 3.3 An offline boot-from-cache path already exists — and is unreachable

`useSyncedYDoc.ts:2091-2105`:

```ts
// Boot-from-cache: server unreachable but a backup exists — hydrate
// from it instead of presenting an empty doc. The backup is NOT
// cleared; next successful connect reconciles. (Down-payment on the
// offline/fast-boot design's boot-from-cache behavior.)
if (!appliedServerState && localBackup && useBackup) {
  logger.warn('Server unreachable — hydrating from local backup (offline boot)');
  Y.applyUpdate(doc, localBackup, 'remote');
  setSyncStatus('error');
  setLastSyncError('Offline: loaded from local backup; will reconcile when the server is reachable.');
}
```

Someone already built the thing. It cannot fire in the case it was built for.
When float-box is unreachable at launch, `connect_remote_server` returns `None`
(`server.rs:414`) → `AppState.server = None` → `get_server_info` returns
`Err("Server not running")` (`lib.rs:66`) → `initHttpClient()` throws
(`httpClient.ts:338`) → `setServerError()` (`App.tsx:73`) → **`App.tsx:476`
replaces the tree before `useSyncedYDoc` ever mounts.**

`:2095` can only fire in the narrow case where the Tauri handshake *succeeded*
but a later `getState()` failed — i.e. float-box died between app launch and the
state fetch. The common case (float-box already down) never reaches it.

**Consequence for Phase 2 scoping: offline mode is substantially cheaper than
ADR-007 assumes.** The doc-hydration half exists. What's missing is the gate.

### 3.4 In remote mode, the Tauri process replays a 39 MB local Y.Doc it never uses

`lib.rs:339` `YDocStore::new()` is **unconditional** — not gated on the
remote/local fork at `lib.rs:277-285`. In remote-authority mode (the daily
driver) it costs a measured **578 ms** of blocking boot to produce a doc whose
only consumers are:

- `ctx_parser.rs:160` — `let _doc = Arc::clone(&self.doc); // Reserved for future Yjs sync` — bound to `_doc`, **never read again**.
- `commands/workspace.rs:48` → `services/workspace.rs:32` `clear(store: &YDocStore)` — the `clear_workspace` command.

The `AppStateInner.store` doc comment at `lib.rs:43` ("Y.Doc sync now via server,
but store still needed for ctx_parser") is **factually wrong**; ctx_parser does
not use it.

Worse than dead: in remote mode `clear_workspace` **wipes the local shadow store
while the remote authority is untouched** — it silently targets the wrong
authority.

### 3.5 The sync health check races the boot and can amplify it

At +8.4 s the health check fires against a store that is still empty and reports
`Server: 18184 blocks | Local: 0 blocks (1/2)`. Two consecutive mismatches
trigger a full resync. The interval is ~120 s (measured: `12:41:45` → `12:43:44`).
Boot A finished at 80.6 s, so check #2 landed after the store was populated —
**by 40 seconds.** On the mac mini's measured 104 s boot, or on any slower/larger
future doc, **check #2 fires mid-boot and kicks off a full resync on top of the
in-flight one.** This is a latent amplification, currently masked by luck.

The orphan detector has the same shape: it runs its initial check at +32.6 s
against a 0-block store (`lib.rs:587-604`).

### 3.6 Failure modes that are silent but shouldn't be

| Failure | Current | Should be |
|---|---|---|
| `setup_logging()` fails | `eprintln!` + `return;` → **app runs with no logging at all**, no further warning (`lib.rs:169`, `:183`) | surface; logging is the diagnostic substrate for everything else |
| config parse error | `warn!` + **defaults** (`config.rs:201`) → a typo'd `remote_server_url` silently boots you into **local-spawn mode against a different outline** | hard-fail or loud in-UI banner — this is a split-brain vector the guard doesn't cover |
| ctx parser thread dies | `error!` ×2 + **silent thread exit** (`ctx_parser.rs:169-171`) → markers stay `pending` forever | surface in the ctx sidebar |
| `ensure_dirs()` fails | `eprintln!` + continue (`lib.rs:254`) | fail fast; per `logging-discipline.md` §3 the local file layer is a **fail-fast** subsystem, and this is mixed-mode |

§3.6 row 2 deserves emphasis: **the split-brain guard at `server.rs:408` protects
against an unreachable remote, but a mistyped config key walks straight past it
into a local spawn.** That is the exact failure the guard exists to prevent,
entered through the front door. It has already happened once — `config.toml`
carries the comment *"Restored 2026-06-24: a manual edit had dropped
remote_server_url + ctx fields."*

### 3.7 Three sequential HTTP round-trips before the window

`connect_remote_server` makes three separate `curl` shell-outs in series:
health probe (`server.rs:393`), version fetch (`:420`), authed probe (`:437`) —
measured **1.73 s** on a warm tailnet, all blocking the window. The version
fetch is pure diagnostics.

---

## 4. The two anchored complaints

### (a) "The loading state is ugly"

There are **two** loading states, and the ugly one is not the one you'd guess.

| | `App.tsx:503` | `Outliner.tsx:861` |
|---|---|---|
| markup | `<div class="loading">Loading...</div>` | `<div class="ctx-empty-state">Loading workspace...</div>` |
| gated on | `workspaceLoaded()` — tab layout | `isLoaded()` — the Y.Doc |
| shown for | ~0.1 s | **77 s** |
| CSS | **none — `.loading` has no rule in any stylesheet** | `index.css:157-163` (padding, mono, muted, centered) |

Verified: `grep -rn "\.loading\b" --include='*.css'` across `src/` returns
**zero matches**. `.error-screen` likewise has **no CSS rule** — only the inline
styles on its button and `<p>`. So `App.tsx:503` renders as a raw unstyled
browser default `<div>`: black text, top-left, default font.

But the state the user *stares at for 77 seconds* is `Outliner.tsx:861` —
`Loading workspace...`, 11 px muted grey, centered, **no progress, no block
count, no phase, no indication anything is happening.** It is indistinguishable
from a hang. It is "ugly" because it is a static string standing in for 77
seconds of invisible work.

**Minimal change (independent of the fast-boot track):**
1. Add a `.loading` rule, or delete the class and reuse `.ctx-empty-state`. One line.
2. Give `Outliner.tsx:861` something to say. The data already exists —
   `getStateHash()` is already called at `:1944` and returns the server block
   count; `SyncHealth` already logs `Server: 18184 blocks`. Render
   `Loading outline… 18,184 blocks` plus a phase label
   (`fetching` → `applying` → `indexing`). Cost: hours. It does not make boot
   faster, it makes it *legible* — which is most of the felt complaint.

Under [[ADR-007]] Phase 1 this UI is replaced anyway (boot-from-cache renders in
<1 s). So spend *little* here — but "little" is not "nothing", because Phase 1's
own honest estimate still leaves a multi-second cold-cache path.

### (b) "If it can't connect it just says 'can't connect'" — the brick

**Location: `App.tsx:474-500`.**

```tsx
return (
  <Show
    when={!serverError()}
    fallback={
      <div class="error-screen">
        <h2>Failed to connect to floatty-server</h2>
        <pre>{serverError()}</pre>
        ...
        <button onClick={...}>Try Again</button>
        <p>Server may still be starting. Try again in a few seconds.</p>
      </div>
    }
  >
    <ConfigProvider>
      ... <WorkspaceProvider><Terminal /></WorkspaceProvider>
    </ConfigProvider>
  </Show>
);
```

Full chain, remote unreachable:

```
server.rs:414   connect_remote_server → return None      (after ~7.5 s of probes)
lib.rs:417      AppState.server = None
lib.rs:66       get_server_info → Err("Server not running")
httpClient:305  6 retries [500,1000,1500,2000,3000]      (~8.5 s)
httpClient:338  throw
App.tsx:73      setServerError(String(err))
App.tsx:476     <Show when={!serverError()}> → FALLBACK  ← entire app replaced
```

**~16 s of unstyled `Loading...`, then the app is gone.** What the user loses:

- the outline — **despite a complete 27.5 MB copy sitting in IndexedDB**
- **every terminal** — local PTYs with zero dependency on float-box
- everything else

And the error text is **wrong** in remote mode. `"Server not running"` and
`"Server may still be starting. Try again in a few seconds."` are the *local
spawn* messages. In remote mode the local server was never going to start. The
UI advises the user to wait for something that does not exist, while the real
cause (tailnet down / float-box off) is stated nowhere. `Try Again` re-runs the
same doomed handshake.

**Minimal change, given §3.3:** the doc-side machinery exists. The change is at
the gate, not in the sync layer.

1. **`App.tsx:476` — stop gating the tree on `serverError()`.** Render the app
   regardless; demote the error to a **status pill / banner**. This single change
   restores terminals immediately and is independently correct — terminals should
   never have been behind this gate.
2. Let `useSyncedYDoc` mount so **`:2095` (which already exists) can fire** and
   hydrate the outline from the local backup.
3. For `:2095` to be *reachable*, `initHttpClient()` must not hard-throw. This
   is exactly [[ADR-007]] **Phase 0 item C** — return
   `{ remoteConfigured: true, reachable: false }` from Rust instead of collapsing
   unreachable into an error, so the frontend owns the offline decision.
4. Fix the error copy to distinguish remote-unreachable from local-not-started.

Note what this does **not** require: y-indexeddb, `/state-diff`, the `reconcile()`
extraction, or any storage change. It requires **Phase 0 item C plus deleting a
`<Show>` gate.** ADR-007 files the un-bricking under Phase 2; **most of it is
reachable at Phase 0 cost**, and it is the complaint that actually bites (a
53-minute float-box outage on 2026-06-26 meant 53 minutes of no floatty at all).

### (c) The brick Evan hasn't named yet — permanent, silent `Loading workspace...`

The error screen in (b) is at least *legible*. There is a strictly worse failure
mode that produces **no error at all**.

If `initHttpClient()` **succeeds** but `GET /api/v1/state` later fails (float-box
dies mid-boot, 401 after a key rotation, a 500) **and there is no IndexedDB
backup**:

```
:2069   httpClient.getState() throws
:2139   outer catch → sharedDocError = String(err); sharedDocLoaded stays FALSE
:2146   setIsLoaded(false)
        → Outliner.tsx:861 <Show when={isLoaded() && configReady()}> never opens
        → "Loading workspace..." FOREVER
```

- `loadInitialState()` runs **only** in `onMount` (`:2152`). `sharedDocLoadPromise`
  is nulled at `:2143` and **nothing ever re-invokes it.** No retry, no timeout.
- **`sharedDocError` is a dead signal.** `useSyncedYDoc` exposes `error`
  (`:1851`), and **no component in the codebase consumes it.** `Outliner.tsx:60`
  destructures `{ doc, isLoaded, undo, redo, clearUndoStack }` — `error` is not
  pulled out anywhere. The error is captured, stored, and rendered nowhere.
- Only `Cmd+R` escapes.

**A second instance of the same shape — CORRECTED 2026-07-13:** the config
path does NOT hang. `ConfigProvider` *rejects* the `configReady` promise on
`get_ctx_config` failure (`ConfigContext.tsx:66`), and `useSyncedYDoc.ts:1887`
catches the rejection and falls back to the `default` workspace name. Follow-up
work should target the dead `error` signal above, not add a config fallback
that already exists.

So the loading state in §4(a) is not merely ugly — it is **indistinguishable from
a permanent hang, because in two real failure modes it *is* one.** A user staring
at `Loading workspace...` at second 60 cannot tell whether they are 17 seconds
from an outline or infinitely far from one. That is the actual felt experience
behind "the loading state is ugly."

**Minimal change:** render the `error` signal. It already exists and is already
populated. `Outliner.tsx:861`'s fallback should branch on `error()` → message +
Retry button (calling `loadInitialState` again) instead of an indefinite string.
Cost: hours. This is a **strictly-now fix** — it is not on the fast-boot track at
all, and it is the difference between "slow" and "broken."

Note the asymmetry this creates today:

| | cache present | cache absent |
|---|---|---|
| server down at launch | **bricked** — `App.tsx:476` error screen (§4b) | **bricked** — same |
| server dies mid-boot | **graceful** — boot-from-cache `:2095`, red status dot, fully usable | **permanent silent hang** (§4c) |

The one cell that works is the one nobody planned for.

---

## 5. Recommendations, ranked by (user-visible impact / effort)

### Just fix it now — independent of the fast-boot track

| # | Change | file:line | Effort | Impact |
|---|---|---|---|---|
| **R1** | **Un-brick: move `serverError()` from the outermost `<Show>` to a status banner.** Terminals + cached outline survive an unreachable float-box. Pairs with Phase 0 item C. | `App.tsx:474-500` | **S** (+ Phase 0 C) | **Highest.** Removes the single worst failure mode. Turns a 53-min outage into a degraded-but-usable session. |
| **R2** | Gate `YDocStore::new()` on the local/remote fork. Audit `clear_workspace` — it targets the wrong authority in remote mode. Fix the stale `lib.rs:43` comment. | `lib.rs:339`, `lib.rs:277-285`, `commands/workspace.rs:48` | **S** | 578 ms off every remote boot; removes a wrong-authority write path. |
| **R2b** | **Render the `error` signal.** `useSyncedYDoc` exposes `error` (`:1851`), populates it (`:2141`), and **no component consumes it** — producing a permanent silent `Loading workspace...` on two real failure paths (§4c). Branch `Outliner.tsx:861`'s fallback on `error()` → message + Retry that re-invokes `loadInitialState`. | `Outliner.tsx:60`, `:861`, `useSyncedYDoc.ts:1851` | **S** | **Very high.** Converts an unrecoverable silent hang into a recoverable error. Strictly-now — not on the fast-boot track. |
| **R3** | Make the 77 s legible: block count + phase in the loading state; add the missing `.loading` CSS rule. Server block count is already fetched at `:1944`. | `Outliner.tsx:861`, `App.tsx:503`, `index.css` | **S** | Directly answers complaint (a). Cheap. Survives Phase 1 as the cold-cache path. |
| **R3b** | `configReady()` never flipping on a `get_ctx_config` failure also hangs the outliner forever (§4c). Give it a default-config fallback. | `ConfigContext.tsx:64-67`, `Outliner.tsx:861` | **XS** | Closes the second silent-hang path. |
| **R4** | Fix the remote-mode error copy ("Server not running" / "may still be starting" is false in remote mode). | `App.tsx:479-498`, `lib.rs:66` | **XS** | Stops actively misleading the user. |
| **R5** | Don't run the sync health check / orphan detector until `isLoaded()`. Today they fire against an empty store mid-boot and can trigger a resync **on top of** an in-flight boot. | `useSyncHealth.ts`, `lib.rs:587-604` | **S** | Removes a latent amplification currently masked by a 40 s margin. |
| **R6** | Config-parse failure must not silently fall back to local-spawn mode. This walks past the split-brain guard through the front door — and has already happened once. | `config.rs:201` | **S** | Closes a real split-brain vector the `server.rs:408` guard does not cover. |
| **R7** | `setup_logging()` failing → app runs with zero logging and no warning. Fail loudly (per `logging-discipline.md` §3, the file layer is fail-fast). | `lib.rs:169`, `:183`, `:254` | **XS** | Diagnostic integrity. |

### Fast-boot Phase 0 (foundation)

| # | Change | Note |
|---|---|---|
| **R8** | **Item C — Rust `{ remoteConfigured, reachable }` contract.** Promote this: it is the unlock for R1, the highest-impact item on the list. | `server.rs:387-467`, `lib.rs:60-67` |
| **R9** | `reconcile()` extraction. **Use the corrected site list: `:659`, `:1542-1716`, `:1864`.** ADR-007's `:1174` is a comment, not code — see §6.5. | `useSyncedYDoc.ts` |
| **R10** | `/state-diff` endpoint. | — |

### Fast-boot Phase 1 (the 77 s)

| # | Change | Note |
|---|---|---|
| **R11** | **Stop the pull when the cache is warm.** The single highest-value line change in the codebase: `useSyncedYDoc.ts:2001` full `getState()` runs *even when a valid backup was just decoded at `:1985`*. Boot-from-cache + `/state-diff` replaces it. | `:2001`, `:2006` |
| **R12** | **Stop `clearBackup()` at `:2023`.** The cache is deleted at the end of every successful boot, guaranteeing the next boot rebuilds 27.5 MB. | `:2023` |
| **R13** | y-indexeddb adoption (O(delta) writes). | ADR-007 D |
| **R14** | **Instrument the 77 s split** (`Y.applyUpdate` vs store materialization) before choosing history-GC vs virtualization. ADR-007 names this as the gate; it has **not been done**. Do it before spending on either. | `:2006` |

### Phase 2 (offline) — smaller than the ADR assumes

| # | Change | Note |
|---|---|---|
| **R15** | Reconnect/health-poll loop + `offline`/`reconnecting` status states. | The doc-hydration half already exists at `:2091-2105` — see §3.3. |

### Not the problem — do not spend here

- **Search index init: 25 ms.** **Hook system: ~2 ms.** Measured (§2). Both are noise. Any boot work aimed at them is misaimed.
- **OTLP**: correctly degrades, never blocks. Leave it.

---

## 6. Corrections to the existing fast-boot docs

Feeding these back so Phase 1 doesn't plan against stale facts:

1. **[[2026-06-26-offline-and-fast-boot]] Problem table** says the IDB cache is
   "**ignored on boot** (no `Loaded backup` line; full 104 s fetch instead)."
   **No longer true.** As of v0.21.0 the cache *is* loaded
   (`idbBackup: Loaded backup: 27547432 bytes`, +3.4 s) — it just doesn't help,
   because the full `getState()` at `:2001` runs anyway and the cache is cleared
   at `:2023`. The cached boot is measurably **~6 s slower** than the uncached
   one (77.3 s vs 71.5 s). The framing should change from *"the cache is ignored"*
   to *"the cache is read, decoded, used only for the push-diff, and then
   deleted — while the full doc is fetched regardless."*

2. **Design doc `clearBackup()` citation `useSyncedYDoc.ts:976`** is wrong for
   v0.21.0. The helper is defined at **`:1344`**; the boot-path call is at
   **`:2023`**; other call sites `:130`, `:828`, `:1001`.

3. **Design doc §6 "Terminals are unaffected … confirm this stays true"** —
   **it is not true.** `App.tsx:476` gates `<Terminal />` behind server
   reachability (§3.2).

4. **[[ADR-007]] phasing** files un-bricking under Phase 2. Per §3.3, the
   boot-from-cache hydration already exists at `:2091-2105`; what blocks it is
   `App.tsx:476` + the Rust unreachable contract (**Phase 0 item C**). The
   un-brick should be pulled forward — it is the complaint that actually bites.

5. **[[ADR-007]]'s reconcile citations are 2-for-3.** `:659` (`triggerFullResync`)
   and `:1864` (`loadInitialState`) **verify clean**. **`:1174` does not hold** —
   that line is a *comment* inside `applyWsMessage`'s restore-broadcast branch
   (`:1171-1181`). The real third push-pull site is the **WS-reconnect IIFE inside
   `connectWebSocket.onopen`, `:1542-1716`** (flush pending `:1551`, incremental
   `getUpdatesSince` paging `:1571-1618`, full-state fallback `GET /state` `:1628`
   + apply `:1634`). The ADR corrected `:378` → `:1174` and landed one line off a
   *different* wrong target. **Phase 0's `reconcile()` extraction must target
   `:1542-1716`, not `:1174`** — a Phase 0 PR that greps for the ADR's line number
   will refactor a comment.

6. **The `~78 s client-side` figure is confirmed and current**, not historical:
   measured 77.3 s (with cache) / 71.5 s (without) on 2026-07-12, v0.21.0,
   18,184 blocks. It is **two** sequential full-doc main-thread walks, not one:
   `Y.applyUpdate` (`:2006`/`:2074`) followed by `initFromYDoc`'s
   `blocksMap.forEach` + `batch(setState)` (`useBlockStore.ts:410-421`, triggered
   by `Outliner.tsx:118-122`). R14's instrumentation should split exactly there.

7. **`clearBackup()`-on-sync** — the design doc's `:976` means the
   `flushUpdatesModule` call site, which is at **`:828`** in v0.21.0.

8. **Stale comment:** `App.tsx:82` says the health check "polls every 30s".
   `POLL_INTERVAL = 120_000` (`useSyncHealth.ts:40`). The 120 s figure is what
   §3.5's race analysis uses.

---

## 7. Evidence index

| Claim | Evidence |
|---|---|
| 77.3 s to first paint | `~/.floatty/logs/floatty.2026-07-12.jsonl`, 19:20:30.135 → 19:21:47.561 |
| Cache loaded then cleared | same, 19:20:30.299 (`Loaded backup: 27547432 bytes`) → 19:21:47.447 (`clearing backup`) |
| Uncached boot is faster | same, 14:33:01.056 → 14:34:12.577 = 71.5 s |
| Store empty mid-boot | same, 19:20:35.297 `Server: 18184 blocks \| Local: 0 blocks` |
| 578 ms dead Y.Doc replay in remote mode | same, 19:20:29.187 `ydoc_replay_complete elapsed_ms=578 … total_bytes=39164554`; `lib.rs:339` unconditional |
| search 25 ms / hooks 2 ms | `~/.floatty-dev/logs/floatty.2026-07-12.jsonl`, 21:31:22.606 → 21:31:22.650 |
| double Y.Doc replay | same, `db_open` at 21:31:21.472 and again 21:31:22.671 |
| `.loading` has no CSS | `grep -rn "\.loading\b" --include='*.css' src/` → 0 matches |
| brick path (error screen) | `server.rs:414` → `lib.rs:66` → `httpClient.ts:338` → `App.tsx:73` → `App.tsx:476` |
| brick path (silent forever-load) | `useSyncedYDoc.ts:2069` throws → catch `:2139` → `sharedDocLoaded` false → `Outliner.tsx:861` never opens; `error` signal never consumed |
| `error` signal is dead | `useSyncedYDoc.ts:1851` exposes it; `Outliner.tsx:60` destructures `{doc, isLoaded, undo, redo, clearUndoStack}` — no consumer anywhere |
| offline path exists but unreachable | `useSyncedYDoc.ts:2091-2105`, gated out by `App.tsx:476` |
| ADR-007 `:1174` citation is a comment | `useSyncedYDoc.ts:1171-1181`; real site is `:1542-1716` |
| two full-doc main-thread walks | `Y.applyUpdate` `:2006`/`:2074`, then `initFromYDoc` `useBlockStore.ts:410-421` |
