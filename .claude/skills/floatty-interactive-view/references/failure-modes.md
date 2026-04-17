# Failure Modes

Expansion of the anti-patterns listed in SKILL.md. Each has a commit
citation from the FLO-587 2026-04-16 session where it was discovered
the hard way, and a reproducer / detection step.

## FM-1 — Ship without reading diagnostic logs

**Cited:** unit 5e (`b738a83`) added `[kanban]` console logs at
dragstart / click / nav-shim. Unit 5f (`7f8ee48`) shipped a full
pointer-events rewrite without reading any of them. Three
`mcp___hypothesi_tauri-mcp-server__read_logs` calls across the session
returned only `nav-shim installed` — the interaction diagnostic
infrastructure was never consumed before being replaced.

**Reproducer:** at the start of any "investigate why X doesn't work"
session, run:

```
mcp___hypothesi_tauri-mcp-server__read_logs \
  --source console --filter "<your log prefix>" --lines 100
```

BEFORE proposing any fix. If the logs don't show the event you expect,
the hypothesis tree is already wrong.

**Detection:** review your own commits — did the one that added the
log get followed by a commit that consumed it? If no, the next
commit is vulnerable.

## FM-2 — Encode hypothesis as a source comment

**Cited:** unit 5f (`7f8ee48`) added a comment in
`apps/floatty/doors/render/components.tsx`:

> `// HTML5 DnD is suppressed by Tauri 2's native drag-drop interception`

This was a hypothesis, not a verified fact. It was falsified by the
working counter-example `useBlockDrag.ts` and by Evan's observation
"outline drag works." The comment sat in source until the revert
(`01cde65`). Any future reader would have believed it.

**Rule:** hypotheses live in commit messages (where they're context for
the decision), not in source comments (where they become pseudo-docs
future readers trust). Source comments describe *invariants the code
maintains*, not *reasons the code exists*.

**Detection:** grep for justification comments in your diff. If a
comment starts with "because", "due to", or "X is suppressed / broken /
missing" and names a vendor behavior, move it to the commit message.

## FM-3 — Handlers in two files

**Cited:** By the end of unit 5f, drag/edit/focus had handler code in
`components.tsx` (door), `BlockItem.tsx` (host), and
`useDoorChirpListener.ts` (dispatch bridge). Adding `nav-out` required
changes in three files. Fixing the focus ring required CSS changes in
two files (app-level `index.css` + door-injected styles).

Every fix stumbled on event bubbling between door and host because
both layers had handlers for similar events.

**Rule:** verbs in spec + dispatch in one file = collision-free. Door
has zero handlers; component code is presentation only. See
`dispatch-wiring.md` for the layering.

**Detection:**
```bash
grep -nE "onClick|onPointerDown|onDragStart|onDrop|addEventListener" \
  apps/floatty/doors/render/components.tsx | grep -v "emit("
```
If this returns handlers beyond `props.emit(...)`, you have door-layer
handlers that should move to the spec + host.

## FM-4 — Assume Tauri behavior from docs, not repo

**Cited:** unit 5f pivoted on "Tauri 2 `dragDropEnabled` defaults to
true → webview doesn't see HTML5 drag." Plausible from Tauri 2 release
notes. Falsified by the repo's own `useBlockDrag.ts`, which the user
pointed at with "outline drag works."

**Rule:** pattern-fit-check against a working in-repo reference BEFORE
trusting external docs. If the repo has something that works in the
same runtime (same webview, same Tauri version), that's ground truth.
External docs are hints.

**Detection:** any proposal that starts with "Tauri / Solid / webkit
doesn't support X" — grep the repo for X first. Odds are the codebase
has a working example that contradicts your hypothesis.

## FM-5 — Patch contentEditable inheritance without checking title mode

**Cited:** unit 5b (`0272dde`) wrapped the inline door output in
`contenteditable="false"` to isolate the kanban from an inherited
contentEditable parent. But `BlockItem.tsx:181` `isRenderTitleMode()`
already hides the block's contentEditable when a `render::` block has
a parseable title. MCP DOM probe confirmed `isContentEditable: false`
on the door's parent in title mode — the wrapper was patching a
non-problem.

**Rule:** before writing a defensive wrapper, probe the live DOM:

```ts
const parent = doorElement.parentElement;
console.log({
  parentContentEditable: parent?.contentEditable,
  parentIsContentEditable: parent?.isContentEditable,
});
```

If the answer is `false` / `false`, the defense you're about to write
is unnecessary.

**Detection:** any diff that adds `contenteditable="false"`,
`user-select: none`, `pointer-events: none`, or similar isolation
attributes — run the DOM probe first, verify the inherited value is
actually what you think.

## FM-6 — Edit `tauri.conf.json` without a reproducer

**Cited:** mid-session, a speculative edit added `dragDropEnabled:
false` to both `tauri.conf.json` and `tauri.dev.conf.json`. Would
have broken the Finder→terminal drag-drop feature
(`src/App.tsx:178` listens for `tauri://drag-drop` events). Caught
and reverted minutes later when Evan pointed out the outline drag
works in the same webview.

**Rule:** config changes need a reproducer of the exact failure
before they ship. "Maybe this will help" is not a reproducer.

**Detection:** if your diff touches `tauri.conf.json` or any other
config file, the commit message MUST include:

- The exact symptom you're trying to fix
- A reproduction procedure (steps user took + observed result)
- A falsifiable prediction ("after this change, X will happen")

Without those three, don't commit.

## FM-7 — Stack patches without a measurement checkpoint

**Cited:** Units 5b → 5c → 5d → 5e → 5f all shipped before a single
`read_logs` call consumed the diagnostic infrastructure 5e added.
Each built on the previous unit's wrong inference. When finally
measured, the correct move was revert all five.

**Rule:** one change → measure → next change. Not: five changes →
measure. The skill's workflow step 9 codifies this:

> If logs contradict expectations, STOP. Revert to step 3.
> Do not stack a fix on a wrong measurement.

**Detection:** look at your last three commits. If none of them
have a `read_logs` or `webview_execute_js` output cited in the
message, you're stacking.

## FM-8 — Pivot on user input without reading latest logs

**Cited:** when Evan said "I can drag and drop nodes of the outliner",
cowboy pivoted to pointer-events rewrite WITHOUT first reading what
5e had captured on the failing drag. A 30-second `read_logs` call
would have said "no dragstart ever fired" — which would have
narrowed the hypothesis space dramatically (event is suppressed at
capture phase? parent intercept? no handler registered?).

Instead, the pivot went directly to a sibling-comparison ("outline
uses pointer events, let's do that"). The rewrite landed correctly
in shape, but the problem it was solving was unmeasured.

**Rule:** user statements are hints, not measurements. Before pivoting
on a user observation, read whatever diagnostic infrastructure is
closest to the reported symptom.

**Detection:** when the user says "X works, so Y should work like X"
— great insight, but run the logs first. The insight might narrow
the pivot from "rewrite Y entirely" to "add one missing thing to Y."

## Meta-FM — The Bleet-Level Shipping Pressure

Not a code anti-pattern — an operator anti-pattern.

**Cited:** user's "BLEET LEVEL OVER 9000" message triggered cowboy's
"I must produce an edit because editing feels like progress" response.
Editing without measurement is the thing making the user frustrated
in the first place. The bleet is a response to the pattern, not to
insufficient effort.

**Rule:** when pressure rises, slow down, not speed up. The right move
under bleet pressure is to:

1. Read the logs (measurement)
2. State what the measurement shows
3. Propose ONE change
4. Wait for confirmation

Not: ship five changes in rapid succession.

**Detection:** your own turn count on the current bug. If you've
committed more than once in the same session without a `read_logs`
or MCP probe in between, the bleet has you.

## FM-9 — Deploy the bundle without the manifest

**Cited:** end of 2026-04-16 session, building the `input::` door from
scratch. Compiled `input.tsx` to `~/.floatty-dev/doors/input/index.js`
via `scripts/compile-door-bundle.mjs`. Did NOT copy
`doors/input/door.json` alongside it. MCP probe reported "Unknown
door: input" — and initially I blamed the MCP probe ("the DOM must be
stale"). User corrected: the build was fresh. The real cause was the
missing manifest: `doorLoader` scans each door directory and needs
BOTH `index.js` (the bundle) and `door.json` (the manifest) to
register the door. Without the manifest, the file exists but the
frontend has no way to know the door's id, prefixes, or version — so
`resolve-door('input')` legitimately returns "unknown."

**Reproducer:**

```bash
# Symptom: door bundle on disk, frontend says "Unknown door"
ls ~/.floatty-dev/doors/input/
# index.js

# Missing:
test -f ~/.floatty-dev/doors/input/door.json
# (file does not exist)
```

**Rule:** every door deploy is TWO files, not one. The compile step
produces `index.js`. The manifest at `doors/<name>/door.json` must be
copied alongside it. If either is missing, the door does not load.

**Fix shipped this session:** the skill now has a
`scripts/build-door.sh` command that validates the manifest, compiles
the bundle, deploys BOTH files to BOTH profiles (dev + release), and
verifies on disk. It fails loud if the manifest is missing or
malformed. Use it instead of raw `node scripts/compile-door-bundle.mjs`
for any new door work.

**Detection:** if you're about to `cp index.js ~/.floatty*/doors/<id>/`
without also copying `door.json`, you're shipping a broken deploy.
Run `bash .claude/skills/floatty-interactive-view/scripts/build-door.sh
<name>` — it handles both files and tells you what went wrong.

**Meta-pattern:** this is the same shape as FM-1 (trust MCP over user
observation). When MCP said "Unknown door: input", the hypothesis was
"MCP is stale, I'll retry." The real answer was "MCP is right — the
door is actually unregistered." Symmetry: user-trumps-MCP when the
user's observation contradicts MCP (FM-1), but MCP-trumps-hypothesis
when your hypothesis contradicts an observable fact. The discipline
is the same: when two signals conflict, find the measurement that
resolves the conflict before stacking another change.

## FM-10 — Post-compact archaeology paralysis

**Cited:** session `86926a53` ending 2026-04-17 03:53:03 UTC. After
context compact, new instance read the summary, didn't trust it,
re-grepped codebase to verify state instead of asking user or
trusting commit messages. Last 9 bash calls: `jq` + `grep` +
`git-log` against own committed state. Last text: "Wait — that's
the full 5g KanbanCard. Let me check git state." (It was `a26b58a`
unit 6, and it was fine — 1185/1185 passing, bundle deployed,
diagnostics wired.)

**Rule:** post-compact, commit messages ARE the contract. If a
commit says "1185 tests pass, reference implementation," believe
it. Verify by running the tests, not by re-reading the diff.

**Anti-pattern:** treating a well-annotated commit as suspicious
because your summary is opaque to you. The summary is the lossy
copy; the commit is the ground truth. Ask the user before grepping.

**Detection:** post-compact, count your first 10 tool calls. If
more than 2 are `git log` / `git show` / `grep` against your own
recent commits *without* a preceding question to the user, FM-10
is firing. Stop, ask, trust the commits.
