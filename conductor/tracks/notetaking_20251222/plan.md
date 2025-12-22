# Plan: Block-Based Integrated Outliner

This plan outlines the implementation of a hierarchical block-based outliner integrated into Floatty's terminal environment.

## Phase 1: Persistence & Data Modeling (Rust/SQLite)
- [ ] Task: Define SQLite schema for hierarchical blocks (id, content, parent_id, type, collapsed, metadata)
- [ ] Task: Implement Rust `Block` struct and SQLite DAO in `src-tauri/src/db.rs`
- [ ] Task: Set up `yrs` (Rust Yjs) for local CRDT synchronization
- [ ] Task: Implement Tauri commands for core block operations
- [ ] Task: Conductor - User Manual Verification 'Persistence & Data Modeling' (Protocol in workflow.md)

## Phase 2: State Management (Zustand/Yjs)
- [ ] Task: Install `yjs` and `zustand` dependencies
- [ ] Task: Implement `useBlockStore` backed by a Yjs `Y.Doc`
- [ ] Task: Implement hierarchical tree traversal and modification logic (indent, outdent, move)
- [ ] Task: Write comprehensive unit tests for tree operations
- [ ] Task: Conductor - User Manual Verification 'State Management' (Protocol in workflow.md)

## Phase 3: Outliner UI Components (SolidJS)
- [ ] Task: Create recursive `BlockItem` component for rendering blocks and their children
- [ ] Task: Create `Outliner` container component for note panes
- [ ] Task: Implement basic editing UX (Enter for new block, Tab/Shift-Tab for nesting)
- [ ] Task: Implement block folding/collapsing logic
- [ ] Task: Conductor - User Manual Verification 'Outliner UI Components' (Protocol in workflow.md)

## Phase 4: Layout & Terminal Integration
- [ ] Task: Extend `PaneLeaf` in `layoutTypes.ts` to support `type: 'terminal' | 'outliner'`
- [ ] Task: Update `PaneLayout.tsx` to render either a terminal or an outliner based on pane type
- [ ] Task: Implement UI for creating a new outliner pane (e.g., split into outliner)
- [ ] Task: Ensure focus management works seamlessly between terminal and outliner panes
- [ ] Task: Conductor - User Manual Verification 'Layout & Terminal Integration' (Protocol in workflow.md)

## Phase 5: Advanced Block Types & Execution
- [ ] Task: Implement block prefix parsing (sh::, ai::, etc.)
- [ ] Task: Implement `sh::` block executor: runs command and appends output block
- [ ] Task: Implement `ai::` block executor: sends prompt to Ollama and appends response block
- [ ] Task: Implement styling for different block types (color coding, icons)
- [ ] Task: Conductor - User Manual Verification 'Advanced Block Types & Execution' (Protocol in workflow.md)