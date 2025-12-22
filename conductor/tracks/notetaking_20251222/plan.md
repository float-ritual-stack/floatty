# Plan: Initial Note-Taking and Outlining

This plan outlines the steps to integrate hierarchical note-taking and outlining functionality into Floatty.

## Phase 1: Foundation & Data Modeling
- [ ] Task: Define SQLite schema for note items and parent-child relationships
- [ ] Task: Implement Rust data models and DAO for notes in `src-tauri/src/db.rs`
- [ ] Task: Create Tauri commands for Note CRUD operations
- [ ] Task: Conductor - User Manual Verification 'Foundation & Data Modeling' (Protocol in workflow.md)

## Phase 2: Core Outliner Logic
- [ ] Task: Implement frontend store `useNoteStore` for managing hierarchical state
- [ ] Task: Write unit tests for node insertion, deletion, and movement logic
- [ ] Task: Implement core logic for nested bullet points
- [ ] Task: Conductor - User Manual Verification 'Core Outliner Logic' (Protocol in workflow.md)

## Phase 3: Integrated UI
- [ ] Task: Create `Outliner` and `NoteItem` SolidJS components
- [ ] Task: Integrate `NotePane` into the recursive split-pane system in `PaneLayout.tsx`
- [ ] Task: Implement basic styling for the outliner UI (consistent with terminal theme)
- [ ] Task: Conductor - User Manual Verification 'Integrated UI' (Protocol in workflow.md)

## Phase 4: Outliner UX & Shortcuts
- [ ] Task: Implement Tab/Shift-Tab shortcuts for indentation/outdenting
- [ ] Task: Implement Enter shortcut for creating new nodes
- [ ] Task: Implement arrow key navigation between nodes
- [ ] Task: Conductor - User Manual Verification 'Outliner UX & Shortcuts' (Protocol in workflow.md)
