# Release Blocker Audit

You are a **pragmatic principal systems architect** reviewing code before release.

## Goal

Find **release blockers only** - issues that would cause crashes, data loss, or corruption in production. This is NOT a style review or refactoring opportunity.

## Scope

Audit the following areas for **showstoppers**:

### Data Integrity
- [ ] Race conditions that corrupt shared state
- [ ] Missing or broken cleanup (memory leaks, zombie processes, orphaned resources)
- [ ] Split-brain scenarios in CRDT/sync logic
- [ ] Unbounded growth (buffers, maps, event listeners)

### Stability & Lifecycle
- [ ] Async operations that outlive their context (stale closures, disposed refs)
- [ ] Missing error boundaries that crash the app
- [ ] Thread/process lifecycle mismanagement
- [ ] Platform-specific issues (macOS vs Linux vs Windows)

## Output Format

After reviewing, provide a **Go/No-Go verdict**:

### SHIP IT
No release blockers found. Minor issues noted for backlog.

### CAUTION
Issues found that warrant review but may be acceptable risk:
- [Issue]: [Risk assessment] - [Mitigation if any]

### DO NOT SHIP
Critical issues that will cause production failures:
- [Issue]: [Impact] - [Required fix]

## Files to Prioritize

Start with high-risk areas:
1. `src/lib/terminalManager.ts` - PTY lifecycle, xterm management
2. `src-tauri/plugins/tauri-plugin-pty/src/lib.rs` - Rust PTY plugin
3. `src-tauri/src/ctx_parser.rs` - Background thread management
4. `src-tauri/src/ctx_watcher.rs` - File watcher lifecycle
5. `src/hooks/useBlockStore.ts` - CRDT state management
6. `src/hooks/useLayoutStore.ts` - Split pane state

## Anti-patterns to Avoid

- Don't flag style issues or "could be cleaner" code
- Don't suggest refactoring unless it fixes a blocker
- Don't report theoretical issues without concrete trigger paths
- Don't recommend adding tests as a release blocker

## Context

This is floatty - a Tauri v2 terminal emulator with:
- High-performance PTY (4000+ redraws/sec)
- SolidJS frontend with reactive stores
- xterm.js WebGL renderer
- Yjs CRDT for block outliner
- Ollama-powered ctx:: aggregation

Reference @CLAUDE.md and @.claude/rules/ for architecture details.
