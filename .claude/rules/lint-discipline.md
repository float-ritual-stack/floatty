<!--
Maintainer note (stripped from context per the Claude Code rules-loading
docs — block-level HTML comments outside code fences don't burn tokens):

This rule has no `paths:` frontmatter intentionally. Lint discipline is
repo-wide — it applies whenever any code is touched, regardless of which
file. Path-scoping it would create gaps (e.g. someone touches a Rust file
without the rule loading because the path glob excluded it).

Per https://code.claude.com/docs/en/memory#organize-rules-with-claude-rules,
rules without `paths:` "are loaded at launch with the same priority as
.claude/CLAUDE.md" — exactly what we want here. Keep this rule unscoped.

If this file ever grows past ~200 lines, the docs warn that adherence
drops; split a sub-topic into its own rule rather than scoping this one.
-->

# Lint Discipline

**Lint output you witnessed is lint output you own.** No more "predates this branch / not our problem / out of scope." Every PR keeps every surface at zero (with the documented carve-outs in §6).

Codified after the 2026-04-24 sweep that drove ESLint 64 → 0 (PRs #270, #271, #272, #273, #274), Clippy 131 → 0 (PRs #270, #275, #276), Cargo fmt 644 diffs → 0 (#270), and ts-rs proc-macro warnings 16 → 2 (#276 carve-outs). The floor is now set; this rule keeps it from dropping.

## 1. The surfaces

Every lint surface and the canonical command to verify it. **Run from repo root unless noted.**

| Surface | Command | Floor |
|---|---|---|
| ESLint (all packages via turbo) | `pnpm lint --force` | 0 errors, 0 warnings |
| TypeScript typecheck | `pnpm --filter float-pty typecheck` | clean |
| Cargo formatting | `cd apps/floatty/src-tauri && cargo fmt --all -- --check` | exit 0 |
| Cargo clippy (workspace, all targets) | `cd apps/floatty/src-tauri && cargo clippy --workspace --all-targets` | 0 warnings *except documented carve-outs in §6* |
| Cargo build (workspace, tests) | `cd apps/floatty/src-tauri && cargo build --workspace --tests` | clean |
| Cargo test | `cd apps/floatty/src-tauri && cargo test --workspace` | all passing |
| Vitest | `pnpm --filter float-pty test:run` | all passing |

**Why `--force` on `pnpm lint`**: turbo aggressively caches lint output by file hash. After a config change (e.g., adding a rule) or a tool upgrade, the cache may report stale clean output. `--force` re-runs even on cache hit. Skip `--force` only when you've made a code-only change since the last verified-clean run.

## 2. The owned-vs-ignored rule

If you ran a lint command and it surfaced output, **every error and warning in that output is in-scope for the current PR**, including pre-existing ones. `git blame` of who introduced the lint error is irrelevant.

The following rationalizations are **forbidden** (named explicitly so future-Claude doesn't re-derive them):

| ❌ Forbidden phrase | Why it's forbidden |
|---|---|
| "Not related to our changes" | The lint output landed on YOUR PR. Your PR is the reason this is being looked at. |
| "Predates this branch" | Discipline is forward-only; the past doesn't get a pass. |
| "Out of scope for this ticket" | The ticket is "code that lands"; lint is part of code. |
| "We'll file a follow-up" | Follow-ups for sub-hour work are backlog rot — the cost of filing + re-contextualising the ticket later usually exceeds doing it now. If genuinely large, the §3 escape hatch applies. |
| "Should be a separate PR" | If the fix is small AND mechanical, no. If genuinely large, escape hatch in §3 applies. |

## 3. Bounded-scope escape hatch

The rule above is absolute, with one explicit escape hatch.

**Sweep-class definition** — concrete numeric threshold, picked once so it's not re-litigated each PR:

> A finding is **sweep-class** when fixing it would require touching **more than 10 occurrences across more than 3 files** outside the current PR's working set.

**When sweep-class fires**:

1. Fix the occurrences inside files your PR has already touched (those are owned by definition — you have the file open).
2. File a Linear issue listing every remaining call site with `floatty` project + `lint-debt` label (label may need creating; first usage = first to create).
3. Link the Linear issue from the PR description under a "Sweep-class deferral" header so reviewers can see the deferred work.
4. The PR can land. The Linear issue is the credit; future-Claude picking it up gets the full context from the linked PR.

**Sub-threshold findings get fixed in the PR**, no exception. "Just one more file" doesn't qualify for the escape hatch.

## 4. Completion gate

"Done" means the gate in `superpowers:verification-before-completion` passed for every surface in §1.

The gate's required output for any task that touches code:

```text
Verified clean:
- pnpm lint --force         → 0 errors, 0 warnings
- pnpm --filter float-pty typecheck    → clean
- pnpm --filter float-pty test:run     → N/N passing
- cd apps/floatty/src-tauri:
  - cargo fmt --all -- --check         → exit 0
  - cargo clippy --workspace --all-targets → 2 warnings (carve-outs per §6)
  - cargo build --workspace --tests    → clean
  - cargo test --workspace             → all passing
```

Quote the actual stdout/stderr in completion summaries — not "tests pass" but the literal `Tests  1210 passed (1210)` line. Fabricated success claims are detectable and corrosive; specifics are not.

**No completion-gate language without the quotes.** "Should be clean" / "I think tests pass" / "lint should be fine" are all rejected — re-run the command and copy the output.

## 5. Enforcement points

| Where enforcement lives | Status | Why |
|---|---|---|
| ✅ Completion gate (Claude-side) | **Mandatory, always-on** | Discipline that survives across sessions and context loss. |
| ✅ Pre-push gate (manual or `.husky/pre-push`) | Recommended, opt-in | Catches gaps the completion gate missed. Setup is a separate decision; not auto-installed by adopting this rule. |
| ✅ CI gate | Deferred until CI exists | Outside this rule's scope; will inherit the surfaces in §1 when CI lands. |
| ❌ Edit-time hooks (`PostToolUse: Edit → lint`, save-on-lint) | **Forbidden** | Interrupts iteration flow. The right enforcement boundary is HANDOFF (push, completion), not iteration (edit). User has tried this, rejected it; do not propose it again under any framing. |
| ❌ Pre-commit hooks that lint or auto-fix | **Forbidden** | Same reason — commit is still an iteration boundary, not a handoff. |

When designing future automation, the menu is the ✅ rows. The ❌ rows are not "skip for now" — they are doctrine. **Do not propose them, do not list them as "options to weigh."**

## 6. Accepted noise (carve-outs)

Carve-outs are exceptions to "0 warnings everywhere." Each one names the source, the reason it can't be fixed at the call site, and the upstream blocker. **Adding a new carve-out requires a new entry here with all three.** Removing a carve-out (e.g., upstream fixes the issue) requires deleting its entry and confirming the warning is gone.

### 6.1 ts-rs `failed to parse serde attribute` for `deserialize_with`

| Field | Value |
|---|---|
| **Source** | `apps/floatty/src-tauri/floatty-core/src/metadata.rs` — `extracted_at` field uses `deserialize_with = "deserialize_timestamp_lenient"` |
| **Warning count** | 2 (one per compilation unit: lib + lib-test) |
| **Why irreducible** | ts-rs (any version) cannot reflect a custom deserializer into TypeScript output — deserializers are a runtime concept. The field already has `#[ts(type = "number \| null")]` so the bindings ARE correct; the warning is informational about the attribute being ignored. |
| **Upstream blocker** | No suppression mechanism exists in ts-rs (as of v12.0.1). |
| **Fix-on** | Future ts-rs version that adds a suppression knob, or a refactor that moves the lenient deserialization into a wrapper type whose serde attributes ts-rs can parse. |

## 7. Design doctrine surfaced during the sweep

The "narrowing > enumeration when input is open" lesson — surfaced from the typescript-advanced-types skill review during PR 4. Captured here so it survives.

**Use narrowing-at-use-site (`typeof x === 'string'`, type guards, `in` checks) instead of pre-enumerating the entire input space when the input is plugin-architected.** Floatty's json-render catalog is extensible — every door can declare new component types with their own prop schemas. A strict union of every component's props would block adding doors. Permissive types (`Record<string, unknown>`) plus narrowing where the value gets used puts the type guarantee where TS's narrower can verify it AND keeps the catalog extensible.

Counter-example: trying to enumerate `EventMap` for a closed event system IS the right call. The shape difference is whether the input *grows* during normal use (catalog: yes; closed event system: no).

Reference implementations in the codebase:

- `apps/floatty/src/lib/handlers/hooks/outputSummaryHook.ts` — `SpecElement.props: Record<string, unknown>` + `typeof === 'string'` narrowing at every prop access
- `apps/floatty/src/lib/handlers/doorTypes.ts` — `DoorEnvelope` discriminated union (closed: only 'view' or 'exec' kinds will ever exist)

## 8. Known gaps

Discoverable problems with the surrounding tooling that this rule **does not** fix but that future work should:

- No CI is configured. The completion gate (§4) is the only mechanical enforcement until CI exists.
- No `.husky/pre-push` hook is set up. Recommended, opt-in (see §5).

(The stale `npm run lint` / `cd src-tauri && cargo test` invocations in repo-root `CLAUDE.md` got fixed in this PR — the rule's own §2 "we'll file a follow-up = forbidden" applied to itself when Desktop Daddy reviewed the draft and pointed out that naming the gap without acting on it was the exact pattern §2 forbids. Fixed in the same commit; no follow-up needed.)

## See also

- [symmetry-check.md](symmetry-check.md) — sibling rule on drift prevention. Lint discipline IS symmetry-check applied to the lint surface.
- [do-not.md](do-not.md) — sibling rule on anti-patterns by layer. The forbidden rationalizations in §2 are this rule's contribution to the anti-pattern catalog.
- [pattern-fit-check.md](pattern-fit-check.md) — invoked during the sweep when adopting reference patterns (e.g., DoorEnvelope discriminated union in PR 4.5).
- `superpowers:verification-before-completion` — the completion-gate primitive §4 hooks into.

## Provenance

- 2026-04-24 sweep: PRs #270 → #276 drove every lint surface to its documented floor.
- Rule landed in PR 7 of the sweep (this PR), once every surface was honestly clean.
- Forbidden-rationalizations list distilled from real session transcripts where the discipline failed.
