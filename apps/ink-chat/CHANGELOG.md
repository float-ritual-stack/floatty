# ink-chat · personal log

Newest first. No semver, no ceremony — just "hey, what's changed."

Format: date · headline · PR. Bullets describe what's NEW or DIFFERENT after the change, written so future-Evan can scan and remember.

(Origin context at the bottom — yoinked from `json-render/examples/ink-chat` in April 2026 and built on since.)

---

## [[2026-04-22]] · render-door package precedent docs · [[PR #262]] follow-up (041ca8d)

- Cross-package precedent note added to ink-chat CLAUDE.md — when ink-chat's catalog grows a peer-app consumer, follow the [[PR #262]] playbook (extract to `packages/`, see `feedback_door_extraction_pattern.md`).
- The ink-chat-side note landed as direct commit `041ca8d` on main, separate from [[PR #262]] itself (which was the render-door extraction). Going forward: even small follow-ups should land via PR so the changelog can wikilink them cleanly.

## [[2026-04-19]] · FLO-636 + FLO-637 — wikilink + daily-add fixes · [[PR #246]], [[PR #248]]

- **Wikilink resolver** ([[FLO-637]] / [[PR #246]]): prefer exact page-name match over fuzzy. Honours exact match even when the page is a stub (referenced but not created).
- **Daily-add parent resolution** ([[FLO-636]] / [[PR #248]]): switched to `GET /api/v1/daily/:date` instead of fuzzy-resolving the daily note. Pairs with the [[FLO-652]] semantic API arc.

## [[2026-04-16]] · Monorepo intake + sanitization · [[PR #237]]

- **Colocated** into `apps/ink-chat/` from the previous standalone repo where it lived as a json-render example consumer.
- `workspace:*` refs swapped to npm `^0.17.0` — ink-chat no longer pulls from json-render's pnpm workspace.
- Embedded `.git` from the source repo removed.
- CLAUDE.md added.
- **Sanitization**: PII + secrets scrubbed during the lift (real names → `Demo Alice/Bob`, hardcoded API keys → env, internal client refs neutralised). See `feedback_test_fixtures_no_pii.md` lessons codified post-incident.

---

## Origin

`ink-chat` started life as `examples/ink-chat` inside the json-render monorepo — a small Ink (React-for-the-terminal) example consuming `@json-render/core` + `@json-render/ink`. Once it grew floatty-API integration (chat tool that calls `floattyFetch`, blocks-to-spec converter, daily-add tool) it stopped being a generic example and got yoinked into this repo as its own thing.

The pre-yoink history is in the source json-render repo. The vestigial `0.1.1` "Updated dependencies" entry from the changesets pipeline lives at the bottom of git for posterity but isn't load-bearing here — changesets isn't wired in this repo.
