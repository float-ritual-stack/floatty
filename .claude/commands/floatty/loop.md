---
description: Continue a work track — reorient from STATE.md, work PR-sized units, verify, bank evidence
argument-hint: <track> [session context — what merged, what to focus on, steering]
hooks:
  Stop:
    - hooks:
        - type: prompt
          prompt: |
            You are validating whether a floatty loop session may end.
            Invocation: $ARGUMENTS

            ONE check: if this session changed code or docs (Edit/Write tools or
            git commits appear in the transcript), was the track's STATE.md
            (.float/work/<track>/STATE.md) updated with an evidence-linked entry —
            an outcome that cites a commit hash, PR link, test output, or
            equivalent tool-result evidence from this session?

            Always allow:
            - User explicitly pausing ("stopping for now", "picking up later")
            - Read-only session (no Edit/Write, no commits)
            - STATE.md updated with evidence-linked outcome

            Otherwise:
            {"ok": false, "reason": "STATE.md not updated with an evidence-linked outcome for this session"}
          timeout: 30
---

# Loop: $ARGUMENTS

First word of `$ARGUMENTS` = **track name**. The rest = **session context** —
steering from Evan (what merged, what to focus on, a decision made elsewhere,
a paste). Fold it into reorientation before touching anything; it may
invalidate parts of STATE.md.

Track file: `.float/work/<track>/STATE.md` — the single reorientation
artifact. `.float/` is gitignored: STATE.md is the memory, git is the truth.
It is the ONLY required file — grow siblings only when a section genuinely
outgrows it, at that moment, not before. Design docs live in
`apps/floatty/docs/design/` (committed); STATE.md links to them, never
duplicates them.

## Precedence — the arbiters (invariant)

```
git         → truth for CODE state
Linear      → truth for TICKET status (FLO-*)
running dev → truth for BEHAVIOR (unit tests necessary, not sufficient)
lake/BBS    → truth for DECISIONS (check before re-deciding; drift, not debate)
STATE.md    → memory. Reorients. Arbitrates NOTHING.
```

## If the track doesn't exist

Ask one question — "what's the goal, and is there a design doc?" — then write
STATE.md in the canonical shape and start. Mine prior art (old tracks, spike
branches, session history) via subagents to seed Ground Truth. Spike code is
evidence; plan docs are intent — when they disagree, the spike wins.

## STATE.md canonical shape

STATE.md is a SKILL for the track — same rules as a skill file: past ~100
lines it POINTS at things rather than containing them.

**The grep rule**: agents read `head -100` then grep — every line must be
independently meaningful. A grep hit that doesn't self-identify is a fragment.
Format: term owns a line · facts scan · citations trail. No wrapped prose.

**Top 40 lines stand alone**: Now + section map + hard boundaries above the
fold — a truncated read must still produce correct behavior.

```markdown
# <track> — <goal one-liner>

**Branch**: <...>  ·  **Design**: [[<design-doc>]]  ·  **Updated**: <date @ time from `date`>

## Now            ← 3 LINES, HARD CAP. Position · NEXT action · THEN queue.
                    Anything that isn't the next action isn't Now → Parked.

## PR Ledger      ← MANDATORY, directly under Now. One row per slice:
                    | PR | Status | In it |. Answers "did X ship?" — which no
                    other section owns. Plus a "Testable NOW: dev=…" line.
                    Merged-to-main ≠ in the release build — note the release
                    tag when one carries it.
                    INVARIANT: a PR moves THROUGH the ledger — rows change
                    status in place, never logged twice; the Session Log keeps
                    the evidence. Wrap updates the row. Scoped future-PR
                    pickups live IN their row's "In it".

## Not in any PR yet ← where "I'm testing and don't see X" gets answered for
                       the unassigned: parked design flags, someday items

## Boundaries     ← the hard constraints a truncated read must not miss
                    (dev-surface-only, do-not.md pointers, parked sends…)

## Ground Truth (do not re-investigate) — sub-headed by KIND:
### Contracts     ← POINTER + the one guard line, never the design restated
                    (a design fact in two places = drift pathology)
### Mechanisms    ← discovered-BY-DOING, worth full lines: not in the design
                    doc, not in the lake, hours to rediscover
### Decisions     ← who/when/where-recorded, one line each
### Probe data    ← field shapes, file:line anchors, raw pointers

## Volatile (re-verify at reorient)
<moving-world claims, each with as-of time; reorient walks THIS list>

## Session Log
| Date | What shipped | Evidence |
<ONE LINE per cell — a table whose cells wrap is a wall with pipes in it.
Detail → a ### section below, or dropped (commits/floatty hold it). No
evidence, no row.>

## Links
<design docs, PRs, [[FLO-xxx]], BBS posts — REFRESH what the loop itself
changes (ticket status lines go stale on arrival otherwise)>
```

**Evan/agent split — cut by "does the next agent need this to ACT?"**, not by
topic: mechanisms and scoped ponders stay here (agent-shaped, grep-shaped);
narrative, provenance, and unscoped ponders go to the floatty outline at wrap.
Overlap is fine; accretion is not.

## The loop

1. **Reorient.** Read STATE.md + the linked design doc, fold in session
   context. Drift-check against the arbiters:
   `git log --oneline --since="<updated>" --all` + `git status --porcelain`
   (`--all` is deliberate: squash-merges land on main while track branches
   live elsewhere) · Linear ticket status/comments **and the tracked issue's
   related tickets** (an urgent unassigned neighbor on the same surface is a
   question to raise, not background). Tool reads can be INCOMPLETE — before
   concluding something DIDN'T happen, re-query; Evan's word outranks a
   single query. **The `## Volatile` section IS the re-verify list** — walk
   every entry against its arbiter. An edited-but-unchecked claim reads as
   verified. Correct STATE.md before working, not after — and when new
   evidence CONTRADICTS a banked claim, suspect BOTH are mis-scoped
   compressions of a conditional system: bank the conditional, never swap a
   one-liner for its opposite. Ground Truth entries (file:line-anchored)
   re-check in seconds via git only when touched.
2. **Work.** Next action from `## Now`. Units are PR-sized — one green-gated,
   reviewable increment — and **self-approved PRs invert the slicing
   calculus**: fold ready work into the open PR unless revert-isolation
   argues otherwise; ask what a separate PR BUYS before cutting one. Existing
   rules apply by reference: `do-not.md`, canonical paths in CLAUDE.md,
   `lint-discipline.md`. New feature → name its layer (handler / hook /
   projection / renderer) and grep for the existing pattern before building.
   Gap discovered → bank it (Ground Truth or `## Now`) + Linear issue if it's
   real future work.
   **Live-testing mode** (Evan in the dev app while you build): keep the dev
   server up between fixes (SAY when a restart is needed and when it's back),
   fold his findings into the open unit as commits, and treat his hands-on
   pass as a verification channel — it beats a screenshot loop.
   **Fan-out threshold**: an investigation crossing two-plus unknowns →
   read-only agents immediately, in parallel; solo spelunking past ~10
   minutes is the smell.
3. **Verify.** Per unit: the completion gate (`lint-discipline.md` §4 — quote
   REAL output, not "should pass") — **the test gate is the ENTIRE relevant
   suite, never just the touched spec** (a passing subset can hide a
   suite-level leak) · runtime verification in the running dev app when the
   unit has runtime behavior (hermetic scenarios via `FLOATTY_DATA_DIR`
   scratch dirs; target instances via their `{data_dir}/mcp-bridge.json`,
   never a guessed port — `config-and-logging.md` §MCP) · fresh-context
   verifier subagent (STATE.md + design doc +
   diff; argue NOT done; check against Ground Truth, `do-not.md`, CLAUDE.md's
   Four Bug Categories) · new primitive (entity, storage topology,
   cross-cutting abstraction, public API) → `architecture-reviewer` before
   committing to it. Gates are MANDATED: run to completion before the turn
   ends — "run it now or later?" is permission theater that stalls the loop.
   Discovery after hand-over is a process failure.
4. **Bank.** STATE.md: evidence-linked Session Log row, PR-Ledger row status
   moved IN PLACE, new Ground Truths, refreshed `## Now` + `## Links`
   (refresh whatever the loop itself changed). Linear: status move + evidence
   comment when a ticket moved. Commit at the unit boundary — EVERY git
   mutation starts with an explicit `cd` to the intended repo and ends with
   `git log --oneline -2` (the parent hash is the cheapest wrong-repo
   detector). Audit each claim against a tool result before reporting —
   unverified work is reported as unverified.
5. **Wrap.** TWO surfaces, TWO audiences ("my eyes don't grep"):
   - **STATE.md = agents** (dense, file:line, exhaustive — Evan should never
     NEED to read it).
   - **Floatty outline = Evan**: post a session block under TODAY's day page —
     `## loop · <track> · session N — <one-line outcome>` with ONLY the few
     lines that matter as nested `shipped::` / `gem::` / `open::` /
     `your-call::` children (ONE fact per line). Multi-detail chat content
     he'll need again goes here too — chat scrolls away the moment he asks
     one question. Native bullets by default; a SHORT `├─` map inside ONE
     multi-line block is fine — never a tree ACROSS blocks or in a code
     fence. Block ids in chat.
   - **Day-closing session → ALSO seed TOMORROW's daily-note top** (boot
     lines): morning-Evan reads the TOP of that day's note — a block under
     today's page is invisible to him tomorrow. Daily pages resolve by PLAIN
     name (`/pages/2026-07-16`, never `# `-prefixed — that mints a stray
     duplicate).
   - `ctx:: … [mode::loop] track::<track>` capture to evna.
   Pause for Evan only on: destructive/irreversible actions, real scope
   changes, or input only he can provide.

## Questions to Evan — the ask discipline

Every question that needs Evan lands TWO places, same moment:
- **Floatty**: a `- [ ] question::` block under the loop's `## questions`
  section on today's page (create on first ask). SELF-CONTAINED: context and
  every option spelled out as nested children — never "1, 2 or 3" with no
  idea what they are. He answers with a `response::` child (async) or in
  chat; the block is the durable record either way — check it off when
  resolved.
- **Chat**: the message ENDS with a single `🚦 your call:` line pointing at
  the block — last thing he reads, never buried mid-stream.

## Invariants (survive compaction)

- **Dev surface only** — port 33333 / `~/.floatty-dev/`. Never touch port
  8765 / `~/.floatty/` (the release build Evan depends on). Release deploys
  are Evan's ritual, not the loop's.
- **Evidence rule** — no claim without a tool result behind it; STATE.md rows
  cite commits/tests/PRs or they don't exist.
- **State lives outside git's reach** — `.float/` is gitignored; git is the
  truth for code.
- The precedence table above.
