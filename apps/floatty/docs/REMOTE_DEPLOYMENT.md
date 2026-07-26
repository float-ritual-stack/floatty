# Remote Deployment — float-box authority + thin clients

How to build/deploy the floatty-server to **float-box** and build the **client**
for the desktop + laptop, so one shared outline lives behind a single authority
(FLO-762). This is the operational runbook; the design rationale is in
[[FLO-762]] and `.claude/rules/config-and-logging.md`.

## The shape

```
            ┌──────────────────────────────┐
            │ float-box (Hetzner, Ubuntu)  │
            │  floatty-server (Axum)       │   ← the ONE Y.Doc authority
            │  SQLite + Tantivy            │      (never file-synced)
            │  bind 100.78.124.84:8765     │
            └──────────────┬───────────────┘
                  tailnet (CRDT over WS + REST, Bearer key)
        ┌────────────────────┴────────────────────┐
   ┌────┴─────┐                              ┌─────┴────┐
   │ desktop  │  remote_server_url           │  laptop  │
   │ float-pty│  → float-box                 │ float-pty│   ← thin clients,
   └──────────┘  (no local server)           └──────────┘     no local DB
```

- **One authority.** float-box owns the canonical Y.Doc (SQLite + Tantivy). It is
  **never** file-synced (WAL SQLite + append-only `.ydoc` corrupt under byte-level
  multi-host sync). CRDT-over-WebSocket is the sync layer.
- **Thin clients.** Each Mac sets `remote_server_url` in `config.toml`; the app
  connects to float-box and does **not** spawn a local server. Edits propagate
  bidirectionally; offline edits merge on reconnect (no conflict files).
- **Auth.** The client's local `[server].api_key` must match float-box's
  `[server].api_key`. Every REST call + WS upgrade carries it.

Current facts (2026-06): float-box tailnet IP `100.78.124.84`, port `8765`,
deploy checkout `/opt/float/floatty-deploy`, data dir `/opt/float/floatty-data`.

---

# Part 1 — float-box server

## 1.1 First-time build

float-box is amd64 Ubuntu 24.04 with Rust, git, and `libssl`/`pkg-config`
already present.

```bash
ssh float-box
git clone git@github.com:float-ritual-stack/floatty.git /opt/float/floatty-deploy
cd /opt/float/floatty-deploy/apps/floatty/src-tauri
git checkout main
cargo build -p floatty-server --release      # → target/release/floatty-server
```

Only `floatty-server` is built on float-box — not the Tauri app. (If the build
complains about system libs: `sudo apt install build-essential pkg-config libssl-dev`.)

## 1.2 Config

`/opt/float/floatty-data/config.toml` (the data dir is the source of truth and is
**never synced**):

```toml
server_port = 8765

[server]
bind = "100.78.124.84"     # tailnet IP — tighter than 0.0.0.0; see gotcha G5
port = 8765
api_key = "floatty-<SHARED-KEY>"   # MUST equal each client's [server].api_key
auth_enabled = true
```

Get the shared key from the desktop (don't print it into logs):
`awk -F'"' '/^\[server\]/{s=1} s&&/^[[:space:]]*api_key/{print $2; exit}' ~/.floatty/config.toml`

## 1.3 Run as a systemd unit (survives reboot)

Until this lands, the server runs as a bare `nohup` process and dies on reboot.
`/etc/systemd/system/floatty-server.service` (needs `sudo` on float-box):

```ini
[Unit]
Description=floatty-server (Y.Doc authority)
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=evan
Environment=FLOATTY_DATA_DIR=/opt/float/floatty-data
Environment=RUST_LOG=floatty_server=info,floatty_core=info,floatty_startup=info,hyper=warn,reqwest=warn,opentelemetry=off
ExecStart=/opt/float/floatty-deploy/apps/floatty/src-tauri/target/release/floatty-server
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now floatty-server
curl -s http://100.78.124.84:8765/api/v1/health      # health is unauthed
# authed sanity (catches key mismatch):
curl -s -H "Authorization: Bearer floatty-<SHARED-KEY>" http://100.78.124.84:8765/api/v1/stats
```

**Manual run (no systemd, dev/testing only):**
```bash
cd /opt/float/floatty-deploy/apps/floatty/src-tauri
FLOATTY_DATA_DIR=/opt/float/floatty-data nohup ./target/release/floatty-server > /tmp/floatty-server.log 2>&1 &
```

## 1.4 Seed the outline (do ONCE, before pointing clients at an empty server)

Never start float-box empty and let a client push into it (empty-authority race).
Seed it from the real outline:

```bash
# On a client (has the real outline) — export:
KEY=$(awk -F'"' '/^\[server\]/{s=1} s&&/^[[:space:]]*api_key/{print $2; exit}' ~/.floatty/config.toml)
curl -s -H "Authorization: Bearer $KEY" http://127.0.0.1:8765/api/v1/export/binary -o /tmp/seed.ydoc

# Import into float-box via the restore endpoint (binary-import.ts supports --url):
<repo>/apps/floatty/node_modules/.bin/tsx <repo>/apps/floatty/scripts/binary-import.ts \
  /tmp/seed.ydoc --url http://100.78.124.84:8765 --key "$KEY"
# prints "Verification PASSED: N blocks match export"
```

## 1.5 Updating the server (new release)

```bash
ssh float-box
cd /opt/float/floatty-deploy && git checkout main && git pull --ff-only
cd apps/floatty/src-tauri && cargo build -p floatty-server --release
sudo systemctl restart floatty-server     # or: kill the nohup PID + relaunch (1.3)
curl -s http://100.78.124.84:8765/api/v1/health   # confirm version bumped
```

**Unattended restarts (agent-driven deploys)**: `sudo systemctl restart` needs an
interactive password, so a remote agent can't complete the deploy on its own — the
v0.19.0 deploy stalled exactly here. (At the time the kill-based workaround was
also blocked by `protect-release-server.sh`; since the 2026-07-19 hook refinement,
a narrow pid-specific `kill <PID>` passes, and broader shapes pass with the
`INTENTIONAL_FLOATTY_KILL=1` intent marker — deploy authorization from Evan still
required, per `.claude/commands/floatty/release.md` §4d.) The sudoers route below
remains the cleanest for systemd-managed setups. Allow this ONE command
passwordless with a drop-in sudoers rule (on float-box):

```bash
# Write to a temp file and validate BEFORE installing — a typo or interrupted
# write must never land in /etc/sudoers.d live. visudo -cf validates the
# candidate file without touching the active configuration.
echo 'evan ALL=(root) NOPASSWD: /usr/bin/systemctl restart floatty-server' > /tmp/floatty-restart
sudo visudo -cf /tmp/floatty-restart && \
  sudo install -m 0440 -o root -g root /tmp/floatty-restart /etc/sudoers.d/floatty-restart
rm /tmp/floatty-restart
```

Scope is deliberately the full literal command — no wildcards, no `stop`, no other
units — so the blast radius of a compromised agent session stays "restart the
floatty server" and nothing else.

The data dir (`/opt/float/floatty-data`) is untouched by updates — the outline
persists across rebuilds (SQLite + `.ydoc` snapshots in `backups/`).

> **Note:** as of this writing float-box is still on the `feat/flo-762-remote-server-url`
> branch (now merged). Switch it to `main` on the next update.

---

# Part 2 — the client (desktop + laptop)

Both Macs run the same `float-pty.app`, just pointed at float-box. As of v0.17.0
the macOS ATS exception is **baked into the build** (no manual `Info.plist`
surgery needed — see gotcha G1).

## 2.1 Build the .dmg (on a machine with the toolchain — e.g. the desktop)

```bash
cd <repo>
git checkout main && git pull --ff-only
bash apps/floatty/scripts/build-server.sh         # builds the bundled sidecar
pnpm --filter float-pty tauri build               # → target/release/bundle/dmg/float-pty_<ver>_aarch64.dmg
```

The build is **native arm64** and **unsigned**. It runs on any Apple Silicon Mac
after stripping the Gatekeeper quarantine (G2). For an Intel Mac you'd need a
universal build (`rustup target add x86_64-apple-darwin` + `--target universal-apple-darwin`).

## 2.2 The client config — REQUIRED fields (read this; it's the #1 footgun)

`~/.floatty/config.toml` on each client. The Tauri app's `AggregatorConfig` has
**no serde defaults** for the first six fields — omit any and the whole config
fails to parse, the app falls back to defaults (`remote_server_url = None`), and
**silently spawns a local empty outline** (G3). Include all of them:

```toml
watch_path = "~/.claude/projects"
ollama_endpoint = "http://localhost:11434"
ollama_model = "qwen2.5:7b"
poll_interval_ms = 2000
max_retries = 3
max_age_hours = 72

remote_server_url = "http://100.78.124.84:8765"

[server]
api_key = "floatty-<SHARED-KEY>"   # MUST equal float-box's [server].api_key
```

## 2.3 Install

```bash
# mount, copy to /Applications, strip quarantine (unsigned build), launch:
hdiutil attach float-pty_<ver>_aarch64.dmg -nobrowse
cp -R "/Volumes/float-pty/float-pty.app" /Applications/
hdiutil detach "/Volumes/float-pty"
xattr -dr com.apple.quarantine /Applications/float-pty.app
open -a float-pty
```

On launch it connects to float-box; the outline appears (first sync of a large
outline takes a bit — see G4). Verify: title bar shows the version + commit;
`~/.floatty/logs/floatty.<date>.jsonl` shows `Connected to floatty-server at http://100.78.124.84:8765`.

## 2.4 Laptop-via-drop-folder pattern

For a machine without the toolchain (or to avoid re-running the build), stage a
self-contained folder in a synced location (e.g. `/opt/float/bbs/inbox/evan/floatty-laptop-setup/`)
containing the `.dmg`, a ready `config.toml`, and an `install.sh` that mounts +
copies + de-quarantines + drops the config + launches. Run `./install.sh` on the
target Mac. (Built during FLO-762; reuse/update it per release.)

## 2.5 Updating a client (new release)

1. Build the new `.dmg` (2.1) on the toolchain machine.
2. On each Mac: quit float-pty, replace `/Applications/float-pty.app` (the install
   steps in 2.3 are idempotent), `xattr -dr com.apple.quarantine`, relaunch.
   The config doesn't change between releases.

---

# Gotchas & known issues

- **G1 — macOS ATS (FIXED in v0.17.0).** WKWebView blocks plain-HTTP to non-localhost.
  The build now ships `NSAllowsArbitraryLoadsInWebContent` in `Info.plist`, so the
  webview can reach `http://<tailnet-ip>`. Pre-0.17.0 builds showed `TypeError:
  Load failed` / "server isn't up". The cleaner long-term path is TLS via
  `tailscale serve` (then `remote_server_url = https://float-box.<tailnet>.ts.net`),
  which removes the need for the ATS exception entirely.
- **G2 — unsigned build → Gatekeeper.** `xattr -dr com.apple.quarantine /Applications/float-pty.app`
  (or right-click → Open the first time).
- **G3 — client config must carry all six no-default fields** (§2.2). Missing any →
  silent fall-back to a local empty outline.
- **G4 — slow cold start ([[FLO-764]] A).** Every launch currently does a full
  `getState` of the whole outline (~tens of MB), and a flaky single-shot fetch can
  drop to the 2-min health-resync. Known; fix is incremental-from-backup.
- **G5 — bind tailnet IP, not `0.0.0.0`.** float-box has a public IP; `0.0.0.0`
  would expose floatty to the internet. Binding the tailnet IP means `127.0.0.1`
  is **not** bound on float-box, so on-box tooling must use the tailnet IP (or
  `tailscale serve`). The `floatty-backend` skill (v0.8.1+) honors `remote_server_url`.
- **G6 — search index doesn't drop client-deleted blocks ([[FLO-764]] C).** After a
  big prune from a client, search returns `(content unavailable)` orphans until you
  `POST /api/v1/search/reindex` on float-box (rebuilds the index from the Y.Doc).
- **G7 — `img::` attachments are server-side.** They render from float-box's
  `__attachments/`. Copy referenced files over once:
  `rsync -a ~/.floatty/__attachments/ float-box:/opt/float/floatty-data/__attachments/`
  (or only the outline-linked subset). `artifact::` needs nothing (blob from block content).

# Quick reference

| Task | Command |
|---|---|
| Health (unauthed) | `curl -s http://100.78.124.84:8765/api/v1/health` |
| Block count | `curl -s -H "Authorization: Bearer $KEY" .../api/v1/stats \| jq .totalBlocks` |
| Reindex search (after prune) | `curl -X POST -H "Authorization: Bearer $KEY" .../api/v1/search/reindex` |
| Update server | `git pull` → `cargo build -p floatty-server --release` → `systemctl restart floatty-server` |
| Build client | `bash apps/floatty/scripts/build-server.sh && pnpm --filter float-pty tauri build` |
| Backups on float-box | `/opt/float/floatty-data/backups/*.ydoc` (hourly snapshots) |
