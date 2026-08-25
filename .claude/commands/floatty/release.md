---
description: Release workflow - bump version, update changelog, tag, push, and publish GitHub Release
argument-hint: <patch|minor|major|x.y.z>
allowed-tools: Bash(git *), Bash(pnpm *), Bash(jq *), Bash(date *), Bash(grep *), Bash(gh *), Read, Edit, Write
---

# Floatty Release

Run the full release workflow for floatty.

**One gate**: changelog approval. After that, ship end-to-end (version bumps, commit, tag, push, GitHub Release) in a single motion. The push and GitHub-Release steps are predictable yes-es when the changelog is right; gating them is theater.

## Arguments

- `$ARGUMENTS` - Version bump type (`patch`, `minor`, `major`) or explicit version (`0.13.7`)
- Default: `patch` if not specified

## Layout reminder (monorepo)

All version-bearing files live under `apps/floatty/` — NOT the repo root.

| File | Path |
|---|---|
| `package.json` | `apps/floatty/package.json` |
| `Cargo.toml` | `apps/floatty/src-tauri/Cargo.toml` (TWO `version =` lines: `[workspace.package]` + `[package]`) |
| `tauri.conf.json` | `apps/floatty/src-tauri/tauri.conf.json` |
| `CHANGELOG.md` | `apps/floatty/CHANGELOG.md` |

**Use the Edit tool for JSON edits**, NOT `jq … > tmp.json && mv tmp.json file.json`. Edit is atomic, doesn't litter `/tmp`, and produces a clean diff.

---

## Phase 1 — Silent prep (no user interaction)

Run all of these without prompting; abort only if something fails.

### 1a. Preconditions

```bash
git branch --show-current        # must be main (warn-and-continue if not)
git status --porcelain           # must be clean (untracked harness files like .claude/scheduled_tasks.lock are OK)
pnpm --filter float-pty test     # must pass
```

### 1b. Drift check (FLO-317) — scoped to release diff only

Pre-existing patterns aren't release blockers; only NEW drifts since the last tag are. Run each grep against the release diff:

```bash
LAST_TAG=$(git describe --tags --abbrev=0)
git diff $LAST_TAG..HEAD apps/floatty/src-tauri/ -- '*.rs' | grep -E '^\+.*\.join\(".floatty'           # hardcoded paths
git diff $LAST_TAG..HEAD apps/floatty/src-tauri/ -- '*.rs' | grep -E '^\+.*(data_dir|config_path|default_.*path)'
git diff $LAST_TAG..HEAD apps/floatty/src/ -- '*.ts' '*.tsx' | grep -E '^\+(let |const.*= new )'        # module-level state
git diff $LAST_TAG..HEAD apps/floatty/src/ | grep -E '^\+.*blockEventBus\.subscribe'                   # new subscribers
git diff $LAST_TAG..HEAD apps/floatty/src/hooks/useBlockStore.ts | grep -E '^\+.*(removeChildId|rootIds\.delete)'
```

Reference: `@.claude/commands/floatty/references/symmetry-check-patterns.md` for the full pattern catalog. If any release-diff hit surfaces a real issue, abort before phase 2.

### 1c. Determine new version

```bash
CURRENT=$(jq -r '.version' apps/floatty/package.json)
```

If `$ARGUMENTS` is `patch`/`minor`/`major`, calculate the bump. If explicit (`0.14.0`), use that.

### 1d. Gather changelog raw material

```bash
git log $LAST_TAG..HEAD --oneline --no-merges     # commits in scope
git diff $LAST_TAG..HEAD --stat                   # file scope
head -90 apps/floatty/CHANGELOG.md                # format reference (read recent entries)
```

### 1e. Draft the changelog entry

Standard sections (omit unused): `### ✨ Features` / `### ✨ Performance` / `### 🐛 Fixes` / `### ♻️ Refactors` / `### 📝 Docs` / `### 🧪 Tests`.

Each release opens with a **2-4 sentence narrative paragraph naming the user-visible symptom in plain language** — not "we did X" but "this fixes Y." Bullets carry `(commit-sha / [[PR #N]] / [[FLO-N]] — file paths)` refs. Group meaningfully — don't just list commits.

---

## Phase 2 — The single gate

Show the proposed changelog entry to the user with this framing:

> **Any changes to the changelog? Otherwise shipping end-to-end (version bumps → commit → tag → push → GitHub Release).**

Iteration is fine: if the user wants edits, apply them and re-ask. Once the user approves (or says "looks good" / "ship it" / similar), proceed to phase 3 without further gates.

If the user explicitly opts out of push or GitHub Release ("hold off on the push" / "skip the release page"), respect that — but don't ask preemptively. The default is end-to-end.

---

## Phase 3 — Ship end-to-end (one motion, no further gates)

After phase-2 approval, execute steps 3a–3g in a single batch.

### 3a. Update version files

| File | Approach |
|---|---|
| `apps/floatty/package.json` | `Edit` tool — single `"version": "..."` line |
| `apps/floatty/src-tauri/Cargo.toml` | `Edit` tool with `replace_all: true` — TWO `version = "..."` lines (workspace.package + package) |
| `apps/floatty/src-tauri/tauri.conf.json` | `Edit` tool — single `"version": "..."` line |

### 3b. Sync Cargo.lock

```bash
(cd apps/floatty/src-tauri && cargo update --workspace)
```

Without this, `Cargo.lock` keeps the old workspace versions and a fresh checkout of the tag produces a dirty working tree on first `cargo build` (drift caught in v0.13.7).

### 3c. Update CHANGELOG.md

Prepend the approved phase-2 entry between `## [Unreleased]` and the previous release section. Header: `## [x.y.z] - YYYY-MM-DD` (use `date "+%Y-%m-%d"`).

### 3d. Verify all 5 locations synced

```bash
echo "package.json:        $(jq -r '.version' apps/floatty/package.json)"
echo "tauri.conf.json:     $(jq -r '.version' apps/floatty/src-tauri/tauri.conf.json)"
echo "Cargo.toml count:    $(grep -c '^version = \"$NEW_VERSION\"' apps/floatty/src-tauri/Cargo.toml) (expected 2)"
echo "Cargo.lock float-pty:    $(grep -A1 '^name = \"float-pty\"$' apps/floatty/src-tauri/Cargo.lock | grep '^version')"
echo "Cargo.lock floatty-server: $(grep -A1 '^name = \"floatty-server\"$' apps/floatty/src-tauri/Cargo.lock | grep '^version')"
grep "^## \[$NEW_VERSION\]" apps/floatty/CHANGELOG.md
```

### 3e. Commit

```bash
git add apps/floatty/package.json \
        apps/floatty/src-tauri/Cargo.toml \
        apps/floatty/src-tauri/Cargo.lock \
        apps/floatty/src-tauri/tauri.conf.json \
        apps/floatty/CHANGELOG.md
git commit -m "chore: release v$NEW_VERSION — <one-line headline matching CHANGELOG narrative>"
```

### 3f. Annotated tag (substantive body)

The body matters — `gh release create --notes-from-tag` reads it back to populate the GitHub Release page. Bare `-m "Release vX.Y.Z"` produces empty Release pages.

```bash
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION

<2-4 sentence narrative summary of the release>

<bullet list of major changes — same shape as CHANGELOG bullets but compressed>

<refs to PRs / Linear issues>"
```

### 3g. Push + GitHub Release (no gate — phase 2 already approved)

```bash
git push origin main --tags
gh release create v$NEW_VERSION \
  --notes-from-tag \
  --title "v$NEW_VERSION — <one-line headline>"
gh release view v$NEW_VERSION --json url,publishedAt,name | jq
```

---

## Final report

After phase 3 completes, emit:

- Version: old → new
- Files changed
- Commit hash
- Tag SHA + push status
- GitHub Release URL

The release is *published*. Phase 4 is what makes it *running*.

---

## Phase 4 — Deploy (local app, laptop staging, float-box server)

Learned end-to-end on v0.23.0 (2026-07-16). Three deploy surfaces; decide which apply from the changelog itself.

### 4a. Does float-box need this release? (decide FIRST, not last)

Grep the release diff for server-side changes:

```bash
git diff $LAST_TAG..HEAD --stat -- apps/floatty/src-tauri/floatty-server/ | tail -1
```

- **No server changes** → changelog says "float-box needs nothing", skip 4d.
- **Server changes** (new endpoints, wire shapes) → the changelog MUST carry a
  "⚠️ float-box needs the new floatty-server" callout, and 4d is part of the
  release. Know the degradation story: v0.23.0's client fell back gracefully
  against the old server (delta pull failed → status error → full resync),
  but "graceful" still meant a 13.4s background haul per warm boot until the
  server flipped. Ship both sides same-day.

### 4b. Local app (Evan's daily driver)

`apps/floatty/scripts/rebuild.sh` is the whole flow: kill app → build server
sidecar → build app → install to /Applications → **stage dmg + doors to
laptop-setup inbox (step 5)** → launch → health check.

- **Claude CAN run this with declared intent** (hook refined 2026-07-19):
  `protect-release-server.sh` passes any command prefixed with
  `INTENTIONAL_FLOATTY_KILL=1`, and narrow pid-specific `kill <PID>` passes
  without it. Two conditions before doing so: (1) Evan has authorized the
  deploy in this session, and (2) **verify this Claude session is not itself
  hosted in a release-floatty terminal** — rebuild.sh kills the app, which
  kills its terminals (the FLO-146 friction). When in doubt, build the
  bundles autonomously (`scripts/build-server.sh` +
  `pnpm --filter float-pty tauri build` — touches nothing live) and hand
  Evan the `rebuild.sh` invocation (it rebuilds warm, fast).
- Known false negative: rebuild.sh's final health check polls `127.0.0.1:8765`,
  which always fails in remote mode (FLO-762).

### 4c. Laptop-setup staging (coupled to rebuild.sh!)

The dmg + door set land in `/opt/float/bbs/inbox/evan/floatty-laptop-setup/`
ONLY via rebuild.sh step 5. If the app was installed any other way (manual
.dmg open, direct .app copy), staging silently didn't happen — replicate it:

```bash
LAPTOP_SETUP="/opt/float/bbs/inbox/evan/floatty-laptop-setup"
cp apps/floatty/src-tauri/target/release/bundle/dmg/float-pty_${NEW_VERSION}_aarch64.dmg "$LAPTOP_SETUP/"
rm -rf "$LAPTOP_SETUP/doors" && cp -R "$HOME/.floatty/doors" "$LAPTOP_SETUP/doors"
```

### 4d. float-box server (when 4a says yes)

The server runs from a deploy checkout **built on the box** — there is no
binary shipping. Supervision: **none** (ad-hoc daemon, PPID 1). Launch recipe
recovered from `/proc/<pid>/environ` on 2026-07-16:

```bash
# BUILD (safe — Claude can do this; doesn't touch the running process):
ssh float-box "cd /opt/float/floatty-deploy && git fetch --tags && git checkout vX.Y.Z \
  && cd apps/floatty/src-tauri && ~/.cargo/bin/cargo build --release -p floatty-server"

# SWAP (Claude may run it once Evan authorizes the deploy — the pid-specific
# kill passes protect-release-server.sh; prefix INTENTIONAL_FLOATTY_KILL=1
# if a broader shape is ever needed. Hook refined 2026-07-19):
ssh float-box 'kill <running-pid> 2>/dev/null; sleep 2; \
  FLOATTY_DATA_DIR=/opt/float/floatty-data \
  RUST_LOG=floatty_server=info,floatty_core=info,floatty_startup=info,tower_http=warn,hyper=warn,reqwest=warn,opentelemetry=off \
  nohup /opt/float/floatty-deploy/apps/floatty/src-tauri/target/release/floatty-server \
  > /opt/float/floatty-data/logs/server-stdout.log 2>&1 & \
  sleep 4; curl --fail --show-error --silent --connect-timeout 5 --max-time 15 http://100.78.124.84:8765/api/v1/health'
# verify: {"version":"X.Y.Z"} in the health response
```

**Verify on the TAILNET IP, not `127.0.0.1`.** floatty-server on float-box binds
`100.78.124.84:8765` (the tailnet interface) ONLY — `ss -tlnp` shows a single
`LISTEN 100.78.124.84:8765`, no `0.0.0.0`, no loopback. `curl 127.0.0.1:8765`
returns EMPTY on the box (connection refused), which reads as "swap failed" when
the swap actually succeeded. This is the same class of false-negative as the
rebuild.sh local check (4b) — wrong interface, not a broken deploy. The bind is
tailnet-only *by design* (G5: never expose floatty on `0.0.0.0`); public reach
comes through Caddy, below.

Find the running PID with `ssh float-box "ps aux | grep floatty-server | grep -v grep"`.

**NEVER run the binary with `--version` to check it** — the flag is
unsupported and the binary BOOTS (spawned a stray server against the live
data dir on 2026-07-16; the hook then blocks killing your own stray). Check
the version via the health endpoint of a running instance, or `strings`/
`git -C /opt/float/floatty-deploy describe` on the checkout.

**Public access path — Caddy front door (`floatty.floatbbs.net`).** float-box's
floatty-server is NOT only reached over the tailnet. A Caddy reverse proxy
(`/etc/caddy/Caddyfile`, stood up 2026-07-20 alongside the Robot firewall) fronts
it publicly:

```caddy
floatty.floatbbs.net {          # public HTTPS :443, Let's Encrypt certs
    reverse_proxy 100.78.124.84:8765   # → the tailnet IP the deploy swaps
}
```

This is the path **claude.ai web + Claude Desktop (Desktop Daddy)** use — they hit
public `:443`, Caddy terminates TLS and proxies to the tailnet interface. Two
consequences for deploys:

- The swap you just did DOES reach the public path — Caddy points at the same
  `100.78.124.84:8765` you replaced, so `floatty.floatbbs.net` serves the new
  version the instant the process comes up. No Caddy reload needed.
- The Hetzner firewall opens `22/80/443/2222` (default-discard), NOT `8765`.
  That is correct and intentional: external traffic enters on `443`, Caddy does
  the internal hop. **Do not "fix" the missing 8765 rule** — there is no public
  path to floatty except through Caddy, and adding a public 8765 bind/rule would
  break the G5 tailnet-only invariant. If asked to "give claude.ai access," the
  access already exists via Caddy; verify it (4e) rather than opening a port.

### 4e. Post-deploy verification

**Public front door serves the new version** (the end-to-end proof — this is the
path Desktop Daddy / claude.ai use, and it exercises Caddy + TLS + the proxy hop,
not just the local process):

```bash
# From ANY machine, no tailnet needed — this is public HTTPS:
curl --fail --show-error --silent --connect-timeout 5 --max-time 15 \
  https://floatty.floatbbs.net/api/v1/health \
  | jq -e '.status == "ok" and .version == "X.Y.Z"'   # ← replace X.Y.Z with the shipped version
# exit 0 ONLY when Caddy+TLS+proxy are up AND the running server is the version you shipped
# → {"status":"ok","version":"X.Y.Z",...}  ← version must be the one you shipped
```

An old version here after a swap can indicate Caddy is pointed elsewhere or the
process didn't come up — but also a stale DNS answer or an upstream/proxy cache.
An error/timeout can indicate Caddy down or cert expiry, or a DNS, network, or
firewall failure between you and the front door. Both are invisible to the
box-local tailnet health check, which is why this belongs in the release; when
either fires, confirm the tailnet check (4d) first to localise box vs. edge.

**Warm-boot phase timing** (local app, once it reconnects to the new server):

```bash
grep -o 'boot_phase=[a-z_]* elapsed_ms=[0-9]* [a-z_]*=[0-9]*' ~/.floatty/logs/floatty.$(date +%Y-%m-%d).jsonl | tail -8
```

Healthy v0.23.0+ warm boot: `cache_hydrate` (~1.1s @ 29MB) → `store_materialize`
(~55ms) → `pull_diff` (KBs). A `pull_full` after a cache boot = the client is
falling back — float-box is stale (4d didn't happen or didn't take).

---

## Important notes

- **One gate** (phase 2 — changelog approval). After that, end-to-end. Don't gate push or GitHub Release separately — those are predictable yes-es.
- The changelog entry should be substantive — narrative paragraph + categorized bullets with file:commit refs. Don't just list commits.
- Annotated tag body and CHANGELOG entry should be the same content, lightly compressed for the tag.
- If anything fails mid-phase-3, show what was done and what remains. Partial state is fine; resume by running the failing step manually. Don't auto-rollback.
- User can opt out of push or GitHub Release if they explicitly say so — but ask once at the changelog gate, not separately at each step.

## Drift history (so we don't relearn)

These have been wrong in past versions of this skill — fix-on-sight if any future drift returns:

- Paths that omit `apps/floatty/` prefix (pre-monorepo layout)
- `sed -i ''` for Cargo.toml versions (only catches first `version =` line; misses `[workspace.package]`)
- `npm run test -- --run` (wrong tool + wrong flag; canonical is `pnpm --filter float-pty test`)
- `jq … > tmp.json && mv tmp.json …` for JSON edits — use the Edit tool instead (atomic, clean diff)
- Bare `-m "Release vX.Y.Z"` tag bodies (breaks `--notes-from-tag` for GitHub Release)
- Missing GitHub Release step entirely
- Missing `Cargo.lock` sync (released v0.13.7 with manifest at 0.13.7, lockfile still at 0.13.6 — fresh checkout produces dirty working tree on first `cargo build`)
- **Multi-gate theater**: separate approval prompts for push and GitHub Release after the changelog was already approved. v0.14.1 release surfaced this — the answer is always yes after the changelog is right. One gate, end-to-end.
- **Missing deploy phase entirely** (v0.23.0, 2026-07-16): the skill ended at "the release is live" with the GitHub page published but the app not installed, the dmg not staged, and float-box running a 4-versions-old server — every deploy step re-derived from scratch. Phase 4 is the fix.
- **`floatty-server --version` to check a binary** — unsupported flag, the binary boots a stray server against the live data dir. Use the health endpoint or the checkout's `git describe`.
- **Server-side changes discovered at deploy time** instead of changelog time (v0.23.0's `/state-diff` callout was nearly missed) — 4a runs the server-diff check up front.
- **"Hook blocks Claude's kill even with user intent"** (v0.24.1, 2026-07-23): stale claim from before the 2026-07-19 hook refinement — `INTENTIONAL_FLOATTY_KILL=1` and pid-specific kills DO pass `protect-release-server.sh`. Evan had to point at the hook source. 4b/4d now carry the real contract (declared intent + the don't-kill-your-own-host-terminal check).
