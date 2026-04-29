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

## Reference: prior incidents

- 2026-04-28 outline-explorer MCP work: Initial proposal was a 4-PR stack (dual-shape → write tools → neighbourhood → bulk). Reality: 1 coherent TypeScript-only PR (the dual-shape + write tools + estimate_subtree bundle) + 1 coherent Rust API PR (neighbourhood + bulk endpoints, separate, parallel). The "stack" was invented by treating bot review as team review.
- See memory: `feedback_default_to_bundling.md`, `feedback_decision_branching_is_stall.md` — same lesson, project-scoped form here.

## Composes with

- `lint-discipline.md` §3 sweep-class threshold (>10 occurrences across >3 files outside the PR's working set) — same numeric threshold for "this is genuinely too big to bundle."
- `symmetry-check.md` — when bundling exposes sibling drift, fix the siblings in the same PR; don't file follow-ups.
