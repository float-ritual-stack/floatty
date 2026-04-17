# Archived Doors

Source snapshots of doors that were once part of floatty but aren't currently living under `apps/floatty/doors/` as active source. Preserved here as design + implementation reference — not compiled, not loaded at runtime.

## What's in here

### `weekly-zine-w10/`

A "This Week in Float" zine door from 2026-W10 (March). Full Vite + Tailwind project with its own `SPEC.md` design doc. Retired when the `render::` door (which can render arbitrary specs) subsumed the weekly-zine use case — a dedicated door was no longer needed for this shape of output.

Preserved files: `SPEC.md`, `src/`, and build config (`package.json`, `vite.config.ts`, `tailwind.config.ts`, `tsconfig.json`, `postcss.config.js`, `index.html`). `node_modules/` and `dist/` are **not** preserved — regenerate with `npm install` + `npm run build` if reviving.

## Not archived here — recovered as active source

During this housekeeping pass, four hand-written JS doors (`digest`, `floatctl`, `linear`, `portless`) that were only living as compiled `index.js` in `~/.floatty/doors/` got copied back into `apps/floatty/doors/<name>/index.js` as first-class repo source. They were written directly as JS (not TSX → transform → JS), so the deployed artifact *is* the source — no separate `.tsx` exists.

The `session-garden` door was multi-file TSX source that got dropped during the `apps/floatty/` monorepo shift; restored from pre-monorepo commit [[69d9255]] into `apps/floatty/doors/session-garden/`.

## Not preserved at all

- `daily::` door — planned for removal in a follow-up PR (replaced by `render::`). The daily:: `BlockType` variant in Rust + ts-rs bindings is still live until that PR ships.
- `dailylog::` door — removed outright (replaced by `render::`).
- `claude-mem` door — explicitly removed as dead ([[PR #240]]). No preservation.
- `reader` door — archived to `~/.floatty/doors-archive/reader/` only. Source in git at commit [[34fc7c5]], recoverable via `git show` if the `read::` sidebar use case ever returns.
- `stub` door — 907-byte test placeholder, not real work.
