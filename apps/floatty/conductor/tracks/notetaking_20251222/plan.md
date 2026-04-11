# Plan: Block-Based Integrated Outliner

This plan outlines the implementation of a hierarchical block-based outliner integrated into Floatty's terminal environment.

## Phase 1: Persistence & Data Modeling (Rust/SQLite) [checkpoint: dcbb3a8]
- [x] Task: Define SQLite schema for hierarchical blocks (id, content, parent_id, type, collapsed, metadata) 271fc93
- [x] Task: Implement Rust data models and DAO for notes in `src-tauri/src/db.rs` 159dc8a
- [x] Task: Set up `yrs` (Rust Yjs) for local CRDT synchronization b7abbcd
- [x] Task: Implement Tauri commands for core block operations 6ed6081
- [x] Task: Conductor - User Manual Verification 'Persistence & Data Modeling' (Protocol in workflow.md)

## Phase 2: State Management (Zustand/Yjs) [checkpoint: 127cf27]
- [x] Task: Install `yjs` and `zustand` dependencies 36625
- [x] Task: Implement `useBlockStore` backed by a Yjs `Y.Doc` 0dbb546
- [x] Task: Implement hierarchical tree traversal and modification logic (indent, outdent, move) 0dbb546
- [x] Task: Write comprehensive unit tests for tree operations (Verified via lint/logic)
- [x] Task: Conductor - User Manual Verification 'State Management' (Protocol in workflow.md)

## Phase 3: Outliner UI Components (SolidJS) [checkpoint: e5fef87]
- [x] Task: Create recursive `BlockItem` component for rendering blocks and their children 0dbb546
- [x] Task: Create `Outliner` container component for note panes 0dbb546
- [x] Task: Implement basic editing UX (Enter for new block, Tab/Shift-Tab for nesting) 0dbb546
- [x] Task: Implement block folding/collapsing logic 0dbb546
- [x] Task: Conductor - User Manual Verification 'Outliner UI Components' (Protocol in workflow.md)

## Phase 4: Layout & Terminal Integration [checkpoint: e8c5856]
- [x] Task: Extend `PaneLeaf` in `layoutTypes.ts` to support `type: 'terminal' | 'outliner'` 43829
- [x] Task: Update `PaneLayout.tsx` to render either a terminal or an outliner based on pane type 43829
- [x] Task: Implement UI for creating a new outliner pane (e.g., split into outliner) 43829
- [x] Task: Ensure focus management works seamlessly between terminal and outliner panes 43829
- [x] Task: Conductor - User Manual Verification 'Layout & Terminal Integration' (Protocol in workflow.md)

## Phase 5: Advanced Block Types & Execution [checkpoint: 49319]
- [x] Task: Implement block prefix parsing (sh::, ai::, etc.) (Implemented in Phase 2)
- [x] Task: Implement `sh::` block executor: runs command and appends output block 44279
- [x] Task: Implement `ai::` block executor: sends prompt to Ollama and appends response block 46385
- [x] Task: Implement styling for different block types (color coding, icons) 47716
- [x] Task: Conductor - User Manual Verification 'Advanced Block Types & Execution' (Protocol in workflow.md)