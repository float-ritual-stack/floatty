---
description: Continue a work track — reorient from STATE.md, work, verify, bank evidence
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

The first word of `$ARGUMENTS` is the **track name**. Everything after it is
**session context** — steering from the user (what merged since last time, what
to focus on, a decision made elsewhere, a paste of relevant material). Fold it
into reorientation before touching anything; it may invalidate parts of STATE.md.

Track file: `.float/work/<track>/STATE.md` — the single reorientation artifact,
designed so a fresh session (or a subagent) can rebuild working context from one
read. It is the ONLY required file. Don't create ARCHITECTURE.md, WORK_UNITS.md,
or handoffs/ — if the track genuinely outgrows one file, grow a section into a
sibling file at that moment, not before. Design docs live in
`apps/floatty/docs/design/` (committed); STATE.md links to them, never
duplicates them.

## Precedence — the arbiters (invariant)

```
git         → truth for CODE state
Linear      → truth for TICKET status
running app → truth for RUNTIME behavior (dev, port 33333, + its JSONL logs)
STATE.md    → memory. Reorients. Arbitrates NOTHING.
```

Sessions fork, restart, and resume from stale snapshots — conversation memory
is disposable. When your context and an arbiter disagree, the arbiter wins
(proven 2026-07-17: a session resumed from a pre-merge conversation fork and
reoriented entirely from STATE.md + git; nothing was lost).

## If the track doesn't exist

Ask one question — "what's the goal, and is there a design doc?" — then write
STATE.md in the canonical shape and start working. No size interview, no
template scaffolding.

If the track has prior art (an old `.float/work/` track, a spike branch,
session history), dispatch subagents to mine it and seed Ground Truth from what
they find. Spike code is evidence; plan docs are intent — when they disagree,
the spike wins.

## STATE.md canonical shape

STATE.md is a SKILL for the track — same rules as a skill file: past ~100
lines it POINTS at things rather than containing them. **The grep rule**:
agents read `head -100` then grep — every line must be independently
meaningful; a grep hit that doesn't self-identify is a fragment. **Top 40
lines stand alone**: Now + PR Ledger above the fold — a truncated read must
still produce correct behavior.

```markdown
# <track> — <goal one-liner>

**Branch**: <branch>  ·  **Design**: [[<design-doc>]]  ·  **Updated**: <date @ time from `date`>

## Now            ← 3 LINES, HARD CAP. Position · NEXT action · THEN queue.
                    Anything that isn't the next action isn't Now.

## PR Ledger      ← one row per unit: | PR | Status | In it |. Answers the
                    highest-frequency question — "did X ship?" — which no
                    other section owns. A PR moves THROUGH the ledger: rows
                    change status IN PLACE, never logged twice; Session Log
                    keeps the evidence. Merged-to-main ≠ in the release
                    build — note the release tag when one carries it.

## Ground Truth (do not re-investigate)
<banked facts with file:line evidence — things a fresh session would burn 20
minutes rediscovering. Corrections earn an entry the moment they happen. When
new evidence CONTRADICTS a banked claim, suspect BOTH are mis-scoped
compressions of a conditional system: bank the conditional ("X happens WHEN
<condition>"), never swap a one-liner for its opposite.>

## Volatile (re-verify at reorient)
<moving-world claims, each with an as-of time — PR states, ticket statuses,
what release carries what. Reorientation walks THIS list against the
arbiters; an edited-but-unchecked claim reads as verified.>

## Session Log
| Date | What shipped | Evidence |
<one row per session/unit, ONE LINE per cell — a table whose cells wrap 15
lines is a wall with pipes in it; detail lives in commits/PRs. Evidence is a
commit hash, test count, curl output, PR link. No evidence, no row.>

## Links
<design docs, PRs, [[FLO-xxx]], BBS posts — wikilinked. Refresh whatever the
loop itself changed; ticket-status lines go stale on arrival otherwise.>
```

## The loop

1. **Reorient.** Read STATE.md top to bottom, read the linked design doc, fold
   in the invocation's session context. Then drift-check against the arbiters:
   `git log --oneline --since="<last updated>" --all` plus
   `git status --porcelain` — committed history AND uncommitted worktree state.
   (`--all` is deliberate: tracks span branches — squash-merges land on main
   while the track branch lives elsewhere.) **Walk every `## Volatile` entry**
   against its arbiter (PR claims → `gh pr view`; ticket claims →
   `~/.float/linear-issues/` export or API; runtime claims → the dev app).
   Correct STATE.md before working, not after.

2. **Work.** Take the next action from `## Now`. Units are PR-sized — one
   green-gated, reviewable increment per unit. Existing rules apply by
   reference: `do-not.md`, canonical paths in CLAUDE.md, `lint-discipline.md`,
   `personal-tool-pr-scope.md`. New feature? Name its layer (handler / hook /
   projection / renderer) and grep for the existing pattern before building.
   Discovered a gap? Bank it in Ground Truth or `## Now` — and file a Linear
   issue if it's real future work.
   **Fan-out threshold**: an investigation crossing two-plus unknowns
   (env × code × content) → read-only subagents immediately, in parallel;
   solo spelunking past ~10 minutes is the smell.

3. **Verify.** At each unit boundary: the completion gate
   (`lint-discipline.md` §4 — quote real output, not "should pass"), runtime
   verification in the running dev app when the unit has runtime behavior
   (unit tests are necessary, not sufficient — hermetic scenarios via
   `FLOATTY_DATA_DIR` scratch dirs + a config shaped for the case under test),
   and a **fresh-context verifier subagent** — give it the current STATE.md,
   the design doc + the diff, tell it to argue the unit is NOT done, and have
   it check against banked Ground Truth, `do-not.md`, and CLAUDE.md's Four Bug
   Categories. If the unit introduces a new primitive (new entity, storage
   topology, cross-cutting abstraction, public API surface), dispatch
   `architecture-reviewer` before committing to it.

4. **Bank.** Update STATE.md: evidence-linked Session Log row, PR-Ledger row
   moved IN PLACE, new Ground Truths, refreshed `## Now` + `## Volatile` +
   `## Links`. Commit at the unit boundary before starting anything else —
   and **every git mutation starts with an explicit `cd` to the intended
   checkout and ends with `git log --oneline -2`** (the parent hash is the
   cheapest wrong-tree detector; the shell cwd persists across tool calls AND
   resets on session resume — both have landed git operations in the wrong
   checkout). Before reporting progress, audit each claim against a tool
   result from this session — unverified work is reported as unverified.

5. **Wrap.** TWO surfaces, TWO audiences ("my eyes don't grep"):
   - **STATE.md = agents** — dense, file:line, exhaustive; the user should
     never NEED to read it.
   - **Floatty outline = Evan** — post a session block under TODAY's day page:
     `## loop · <track> — <one-line outcome>` with only the lines that matter
     as nested `shipped::` / `gem::` / `open::` / `your-call::` children (ONE
     fact per line, native bullets; never draw trees across blocks). Use
     `POST /api/v1/daily/<date>/append` — daily pages resolve by PLAIN name;
     a `# `-prefixed name mints a stray duplicate.
   - `ctx:: … [mode::loop] track::<track>` capture to evna.
   Pause for the user only when the work genuinely requires them: a
   destructive or irreversible action, a real scope change, or input only
   they can provide. A question that needs them is SELF-CONTAINED (context +
   every option spelled out — never "1, 2 or 3?" with undefined options), and
   the chat message ENDS with a single `🚦 your call:` line — last thing
   read, never buried mid-stream.

## Invariants

- **Dev surface only** — port 33333 / `~/.floatty-dev/`. Never touch port 8765 /
  `~/.floatty/` (the release build the user depends on).
- **Merge ≠ felt change** — nothing reaches the user's daily driver until a
  release ships (`/floatty:release`) and the app is rebuilt. Never report
  branch-landed work as "shipped"; the PR Ledger carries the distinction.
- **Evidence rule** — no claim without a tool result behind it; STATE.md rows
  cite commits/tests or they don't exist.
- **Track artifacts survive branches** — `.float/` is gitignored; STATE.md is
  the memory, git is the truth.
