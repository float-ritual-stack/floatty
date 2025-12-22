# Track Specification: Initial Note-Taking and Outlining

## Overview
This track focuses on integrating basic note-taking and outlining capabilities into the Floatty terminal environment. The goal is to allow users to capture thoughts, structure information in an outline format, and have these notes live alongside their terminal panes.

## Requirements
- **Integrated UI:** Note-taking panes should be able to occupy slots in the existing recursive split-pane system.
- **Outline Format:** Support for a hierarchical list structure (bullets, indentation).
- **Persistence:** Notes must be saved locally (likely using the existing SQLite database).
- **Reactivity:** Real-time updates as the user types, leveraging SolidJS primitives.
- **Keyboard Navigation:** Support for common outliner shortcuts (Tab/Shift-Tab for indentation, Enter for new items).

## Architecture
- **Frontend:** New `Outliner` and `NotePane` components in `src/components/`.
- **State Management:** Integration with a new `useNoteStore` or expansion of existing stores.
- **Backend:** New database table in SQLite for storing note items and their relationships.
- **IPC:** New Tauri commands for CRUD operations on notes.
