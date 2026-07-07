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
            an outcome that cites a commit hash, test output, or equivalent
            tool-result evidence from this session?

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

## If the track doesn't exist

Ask one question — "what's the goal, and is there a design doc?" — then write
STATE.md in the canonical shape and start working. No size interview, no
template scaffolding.

If the track has prior art (an old `.float/work/` track, a spike branch,
session history), dispatch subagents to mine it and seed Ground Truth from what
they find. Spike code is evidence; plan docs are intent — when they disagree,
the spike wins.

## STATE.md canonical shape

```markdown
# <track> — <goal one-liner>

**Branch**: <branch>  ·  **Design**: [[<design-doc>]]  ·  **Updated**: <date @ time>

## Now
<current position in 1-3 sentences, then the next 1-3 actions. Top of file =
first thing a fresh session reads.>

## Ground Truth (do not re-investigate)
<banked facts with file:line evidence. Things a fresh session would otherwise
burn 20 minutes rediscovering. Corrections earn an entry the moment they happen.>

## Session Log
| Date | What shipped | Evidence |
<one row per session/unit — evidence is a commit hash, test count, curl output,
PR link. No evidence, no row.>

## Links
<design docs, PRs, [[FLO-xxx]], BBS posts — wikilinked>
```

## The loop

1. **Reorient.** Read STATE.md top to bottom, read the linked design doc, fold
   in the invocation's session context. Then drift-check:
   `git log --oneline --since="<last updated>" --all` — **git wins over STATE.md
   claims**. Correct STATE.md before working, not after.

2. **Work.** Take the next action from `## Now`. Units are PR-sized — one
   green-gated, reviewable increment per unit. Existing rules apply by
   reference: `do-not.md`, canonical paths in CLAUDE.md, `lint-discipline.md`.
   New feature? Name its layer (handler / hook / projection / renderer) and grep
   for the existing pattern before building. Discovered a gap? Bank it in Ground
   Truth or `## Now` — and file a Linear issue if it's real future work.

3. **Verify.** At each unit boundary: the completion gate
   (`lint-discipline.md` §4 — quote real output, not "should pass"), runtime
   verification in the running dev app when the unit has runtime behavior
   (unit tests are necessary, not sufficient), and a **fresh-context verifier
   subagent** — give it the design doc + the diff, tell it to argue the unit is
   NOT done, and have it check against `do-not.md` and CLAUDE.md's Four Bug
   Categories. If the unit introduces a new primitive (new entity, storage
   topology, cross-cutting abstraction, public API surface), dispatch
   `architecture-reviewer` before committing to it.

4. **Bank.** Update STATE.md: evidence-linked Session Log row, new Ground
   Truths, refreshed `## Now`. Commit at the unit boundary before starting
   anything else. Before reporting progress, audit each claim against a tool
   result from this session — unverified work is reported as unverified.

5. **Wrap.** Capture to evna (`ctx:: … [mode::loop] track::<track>`). Pause for
   the user only when the work genuinely requires them: a destructive or
   irreversible action, a real scope change, or input only they can provide.

## Invariants

- **Dev surface only** — port 33333 / `~/.floatty-dev/`. Never touch port 8765 /
  `~/.floatty/` (the release build the user depends on).
- **Evidence rule** — no claim without a tool result behind it; STATE.md rows
  cite commits/tests or they don't exist.
- **Track artifacts survive branches** — `.float/` is gitignored; STATE.md is
  the memory, git is the truth.
