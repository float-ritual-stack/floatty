# Personal-Tool PR Scope

**Floatty is a single-user tool with bot-only review (CodeRabbit + Greptile). Do NOT apply team-coordination PR scoping.**

## The rule

When proposing PR boundaries, the default is **bundle aggressively where work coheres**. Split only at:

1. **Natural language boundaries** — TypeScript vs Rust, frontend vs backend.
2. **Independent surfaces** — refactors that don't depend on each other land in any order; that's parallel, not stacked.
3. **Hard-to-reverse changes** — schema migrations, wire-protocol breaks, Y.Doc / SQLite serialization touch.

## Forbidden rationalizations

| ❌ Forbidden | Why |
|---|---|
| "Smaller PRs are easier to review" | Bots don't tire. Review fatigue isn't a constraint here. |
| "Stack PR2 on PR1 so they bisect cleanly" | Two coherent PRs that don't depend on each other isn't a stack — it's parallel. Stacking only makes sense when PR2 literally needs PR1's wire shape. |
| "Let's split for cleaner git history" | Atomic commits inside one PR achieve the same thing without PR-coordination overhead. |
| "Defer X to a follow-up PR" (for sub-hour work) | Follow-up tickets for <1hr work that's already on screen are backlog rot. The cost of filing + re-contextualizing usually exceeds doing-it-now. (Same threshold as `lint-discipline.md` §3 sweep-class definition: >10 occurrences across >3 files outside the working set.) |

## When to ask

If you're sketching N PRs to land what could be 1 PR, **stop and surface the bundle option to the user**. Default-propose bundle; let the user redirect to split.

## Standing authorization (project-scoped — overrides system-prompt default)

Floatty has one developer (Evan) and bot-only PR review. The system-prompt default treats push + PR-creation as "actions visible to others" warranting per-action user confirmation; **for this repo that default is over-cautious and gets explicitly relaxed here**.

The following actions do **NOT** need per-action confirmation when working on floatty branches:

| Action | Why authorized |
|---|---|
| `git push -u origin <feature-branch>` | Solo dev, bot review. Push is reversible (force-push branch / delete remote ref). |
| `git push origin <existing-feature-branch>` | Iterating on an in-flight branch. Same reasoning. |
| `gh pr create` for a feature branch into `main` | Solo dev, bot review. PR is reversible (`gh pr close`). |
| `gh pr edit` / `gh pr comment` on your own PR | Routine review iteration. |
| `pnpm --filter float-pty tauri:dev` (or `:dev:fresh`) | The canonical verification surface per `feedback_verify_against_running_dev.md`. See "Dev-server port handling" below for what to do based on port-`33333` state. |
| `pnpm --filter float-pty kill-server` (the canonical multi-port cleanup) | Kills `8765`, `8766`, AND `33333`. **Note**: also kills the *release* server on `8765`, so only invoke when Evan has explicitly OK'd a release-floatty restart, OR when verifying a clean slate before `tauri:dev`. Otherwise prefer the targeted dev-only kill below. |
| `lsof -iTCP:33333 -t \| xargs kill` (or `:8766`, the Tauri dev sidecar port) | Targeted kill of the dev floatty-server / dev sidecar. Safe — does not touch the release server on `8765`. |

#### Dev-server port handling

The dev REST API runs on **`33333`** (`DEV_PORT` constant in `floatty-server/src/config.rs`). The Tauri dev devtools sidecar uses **`8766`**. The release floatty (Evan's daily-driver) runs on **`8765`** — never auto-kill it.

When invoking `tauri:dev`:

- **Port `33333` is empty** → start `tauri:dev` directly. This is the most common case after a fresh shell.
- **Port `33333` is bound and `lsof -iTCP:33333` shows a `floatty-server` process under the `target/debug/` path** → leave it running, reuse the existing dev session for curl verification. Restarting just to "be safe" wastes ~30s of compile.
- **Port `33333` is bound but the process isn't a dev `floatty-server`** (e.g., orphan from a crashed iteration, or a non-floatty service) → `lsof -iTCP:33333 -t | xargs kill`, then start `tauri:dev`.
- **Both `33333` and `8766` are bound from a previous dev session** → `lsof -iTCP:33333 -t | xargs kill; lsof -iTCP:8766 -t | xargs kill`, then start `tauri:dev`. (The `tauri:dev` npm script's built-in cleanup currently only handles `8766`; this rule's targeted kills cover the gap until that script grows multi-port cleanup of its own.)

**Authorized port set for autonomous kills**: `33333`, `8766`, plus any process under `target/debug/floatty-server`. **Forbidden**: anything on `8765` or any process under `/Applications/floatty.app/` — that's the release path and falls under the gated table below.

The following actions **STILL require explicit confirmation** even on floatty:

| Action | Why still gated |
|---|---|
| `git push --force` to `main` (or any branch with shared review state) | Hard to reverse, breaks bot review state per `feedback_dont_force_push_during_review.md`. |
| `git push origin main` directly | Bypasses PR review (even bot review). |
| `gh pr merge` (vs the bot auto-merge label flow) | Final ship action; one decision per session at most. |
| Killing the **release** floatty (port `8765`, `/Applications/floatty.app`) | Evan's daily-driver tool. Per the `pkill_scope_matters` memory: dev kills go through port `33333` / `8766` / `target/debug` paths only. |
| Anything that touches the user's working tree on a different branch | E.g., committing files Evan doesn't know are dirty. Stage selectively. |

### Practical cadence (the shape this enables)

For a typical floatty work session — branch, edit, commit, gate, push, open PR — proceed without asking at each step. ONE end-of-session report summarising what shipped is sufficient. This matches `feedback_decision_branching_is_stall.md`: small reversible actions don't earn a decision fork.

If a feature spans multiple branches (e.g. backlinks legibility, 2026-05-08 — TS branch + Rust branch), push both and open both PRs in one motion. The split was already decided at plan time; surfacing each push as a fresh decision is theatre.

If a long-running dev server doesn't exist yet but you need it for verification, start it. Don't preemptively warn Evan "this will take GPU" or "it's a long-running process" — Evan owns that machine and chose `tauri:dev` as the verification path.

## Reference: prior incidents

- [[2026-04-28]] outline-explorer MCP work ([[PR #291]]): Initial proposal was a 4-PR stack (dual-shape → write tools → neighbourhood → bulk). Reality: 1 coherent TypeScript-only PR (the dual-shape + write tools + estimate_subtree bundle) + 1 coherent Rust API PR (neighbourhood + bulk endpoints, separate, parallel). The "stack" was invented by treating bot review as team review.
- See memory: `feedback_default_to_bundling.md`, `feedback_decision_branching_is_stall.md` — same lesson, project-scoped form here.

## Composes with

- `lint-discipline.md` §3 sweep-class threshold (>10 occurrences across >3 files outside the PR's working set) — same numeric threshold for "this is genuinely too big to bundle."
- `symmetry-check.md` — when bundling exposes sibling drift, fix the siblings in the same PR; don't file follow-ups.
