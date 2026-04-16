# No PII, Secrets, or Internal Identifiers in Committed Code

Real production data in test fixtures AND hardcoded credentials in source files are both fast tracks to leaking sensitive information into a public GitHub repo.

This rule exists because:
- **[[FLO-633]]** (2026-04-15): test fixture shipped with real names, grief note, bank status, `/Users/evan/` paths. Git history rewrite + force-push.
- **PR #237** (2026-04-16): lift-and-shift of two apps copied hardcoded API keys (`floatty-1890872e6255d2d0`), internal client names (`rangle/pharmacy`), and ngrok URLs from their private dev repos into the public monorepo. Same root cause, different shape. Git history rewrite + force-push.

## The Rule

**Never commit test fixtures from live user data OR source files with hardcoded credentials without sanitizing first.** "It's just my private repo" / "it's just a dev key" is not an exception — branches get shared, forks get created, PRs get indexed by search engines before anyone reads the bot comments.

## When this applies

Any file added under these paths with content derived from a running floatty server, real user outline, conversation export, dispatch transcript, or session log:

- `src-tauri/*/tests/fixtures/`
- `src-tauri/*/tests/data/`
- `apps/floatty/src/**/__fixtures__/`
- `apps/floatty/test/`
- `tests/` at any level
- Any `include_str!` / `include_bytes!` target in Rust test code
- Any `fs.readFileSync` / fixture import in Vitest test code
- Any file named `*-fixture.*`, `*.fixture.*`, `sample-*.json`, `example-*.json`, `real-*.json`

## The Checklist

**Before `git add`ing a new fixture, run this grep against the staged content:**

```bash
# Catches the canonical classes of leaked PII in FLO-633 and similar cases.
# Add your own real-world leakers to this list when you catch them.
grep -iE 'stephen|ken|scott|marco|jane|ismcast|anetha|yegge|grief|adopt|bank|/Users/[a-z]+|agentSessionId.*[0-9a-f]{8}|@.*\.(com|org|net)' <staged-fixture-file>
```

Any hit → stop, sanitize, re-grep. If the grep is clean, also eyeball the file for:

1. **Names of real people** (colleagues, family, acquaintances). Replace with `Demo Alice`, `Demo Bob`, `Demo Carol`.
2. **Schedule information** (`Wed night Apr 15–16`, calendar invites, meeting times). Keep the *shape* of timestamps, neutralize the content — `"Demo cutover Wed night"` is fine, `"Ken driving Stephen's meeting"` is not.
3. **Health / financial / legal details**. Bank-account status, grief notes, medical references, NDA-covered work. Never. No exceptions.
4. **Internal project identifiers**. Pharmacy PR numbers (`#2113`, `#2126`), client project codenames, internal Slack channel names. If it's not public, replace it.
5. **Absolute filesystem paths**. `/Users/evan/.floatty/...` leaks username. Replace with `/path/to/floatty/...` or strip entirely.
6. **Real UUIDs that could be session / block / user IDs**. Use `00000000-0000-4000-8000-0000000000NN` synthetic UUIDs.
7. **Terminal control sequences** (`\u001b]1337;...`, ANSI escapes). These often contain the CWD from the capture machine. Strip or replace with a placeholder string.

## How to Sanitize

Two valid strategies:

### Strategy 1: Synthesize from scratch

Best when the fixture is small enough (≤1000 lines) and you care about deterministic assertions. Write a minimal synthetic fixture that exercises the same code paths:

- **Same JSON/TOML/YAML shape** (keys, nesting, array cardinality)
- **Same element types / enum variants** (so the parser walks the same branches)
- **Same prop presence** (so Option::is_some() branches fire)
- **Neutral strings**: `"Demo Alpha"`, `"Section A"`, `"Example content"`, `"PR #101"`, `"FLO-100"`
- **Synthetic UUIDs** in the `00000000-0000-4000-8000-000000000001` pattern

Test assertions should match the new neutral content, not the original.

### Strategy 2: Redact in place

Best when the fixture is too large to hand-synthesize (or you need exact cardinality for a perf test). Run the captured file through a redaction pass:

- `jq` walks for string fields + regex-based replacement
- Find-replace real names against a map: `Stephen → Demo Alice`, `Ken → Demo Bob`
- Strip `.agentRaw` / `.agentSessionId` / `.terminalTranscript` entirely (replace with placeholder)
- Normalize all absolute paths to `/path/to/...`
- Re-run the grep checklist after redaction

Document the redaction in a comment at the top of the fixture file so future contributors know it's sanitized and why.

## Commit Hygiene

- The commit that introduces a fixture should have a one-line note in the commit body: `Fixture sanitized per .claude/rules/test-fixtures-no-pii.md` (or a link to this file).
- If you discover an already-committed PII fixture on a feature branch, the fix is:
  1. Replace the fixture with a sanitized version
  2. Interactive rebase to amend the commit that introduced it
  3. Force-push the feature branch (never force-push main)
  4. For deeper history rewrites or main-branch leaks, use `git filter-repo` and warn collaborators
  5. Be aware: GitHub retains orphaned blobs for ~30–90 days after force-push until GC runs. For sensitive leaks, contact GitHub support to purge the blob from storage.

## When captured-from-real-data is unavoidable

Some tests genuinely need the exact shape of real-world data that's too complex to hand-synthesize (e.g., reproducing a parser edge case from a specific user's export). In that case:

1. Get explicit consent from the data owner (if it's not you).
2. Sanitize before committing anyway — the edge case is almost certainly reproducible with neutral names.
3. If the edge case *depends* on the specific bytes of a real value (unlikely but possible), put the fixture in `.gitignore`d directory and reference it via an env var: `TEST_FIXTURE_PATH=/path/to/private.json cargo test`. The test should skip (not fail) when the env var is unset.

## Source Files: No Hardcoded Credentials

When colocating, forking, or lifting code from private repos into public ones, scan for:

1. **Hardcoded API keys / tokens** (even "dev" keys). Use `process.env.X` with fail-closed validation — never `|| "default-key"`.
2. **Internal client / project identifiers** (`rangle/pharmacy`, client codenames). Replace with neutral placeholders (`client/project-a`).
3. **Remote URLs with baked-in auth** (`https://service.ngrok.app`). Require via env var, don't default.
4. **Fallback credentials that silently authenticate** (`process.env.KEY || "hardcoded"`). These are the most dangerous — they work invisibly on every clone.

**Expanded grep** (run on `.ts`/`.tsx`/`.json` source files, not just fixtures):

```bash
grep -rn 'floatty-[0-9a-f]\{8\}\|sk-ant-\|vck_\|ngrok\.app\|rangle/pharmacy\|pharmonline' apps/ --include='*.ts' --include='*.tsx' --include='*.json' | grep -v node_modules | grep -v '.next'
```

## Prior Incidents

- **[[FLO-633]]** (2026-04-15): `spec-7f5ef11c.json` committed with real names, grief note, bank-account status, `/Users/evan/` paths, real agent session UUID. CodeRabbit flagged as `🟠 Major`. Fix required git history rewrite + force-push.
- **PR #237** (2026-04-16): ink-chat + outline-explorer colocated into monorepo with hardcoded API key `floatty-1890872e6255d2d0`, internal client name `rangle/pharmacy`, and `https://floatty.ngrok.app` fallback URL in committed source. CodeRabbit flagged key as `🔴 Critical`, Greptile flagged client name as P2. Fix required git history rewrite + force-push. Root cause identical to FLO-633: files crossed a repo boundary without sanitization.

## The Grep (Keep It Updated)

When you catch a new class of leaker, add its pattern to the grep command at the top of this file. The rule gets stronger every time it catches something.
