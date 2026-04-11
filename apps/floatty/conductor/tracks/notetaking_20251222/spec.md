# Track Specification: Block-Based Integrated Outliner

## Overview
Integrate a high-performance, hierarchical block-based outliner into Floatty. This system is "not your typical notes"—everything is a block, and blocks can be typed via prefixes (e.g., `sh::`, `ai::`, `ctx::`). These outliner panes will live alongside terminal panes in the recursive split-pane layout.

## Core Concepts
- **Universal Block:** The fundamental unit of information. A block contains text, parent/child relationships, and a type.
- **Prefix-Based Typing:**
    - `text` (default): Standard hierarchical text.
    - `sh::` or `term::`: Executes as a shell command, displaying output in a sub-block.
    - `ai::` or `chat::`: Sends content to a local LLM (Ollama), displaying the response.
    - `ctx::`: Captures context for AI workflows.
    - `web::`: Embeds a web view.
- **Recursive Panes:** Outliner panes view a specific "root block" and display its entire subtree.

## Requirements
- **Data Persistence:** Blocks stored in SQLite with parent-child hierarchy.
- **Real-time Sync:** Local-first synchronization using Yjs (CRDTs) for potentially multi-window or shared use.
- **High Density UI:** A minimalist, high-density outliner interface using SolidJS.
- **Keyboard-Centric UX:** Outliner-standard shortcuts (Tab/Shift-Tab, Enter, Arrow keys, Cmd+Enter to execute).
- **Layout Integration:** Outliner panes must be first-class citizens in the `PaneLayout` system.

## Architecture
- **Backend (Rust):**
    - SQLite schema for `blocks` (id, content, parent_id, type, metadata).
    - Yjs server/provider using `yrs` for CRDT synchronization.
    - Tauri commands for direct block manipulation and execution.
- **Frontend (SolidJS):**
    - `useBlockStore`: Zustand store backed by a Yjs document.
    - `Outliner`: Root component for a note pane.
    - `BlockItem`: Recursive component for rendering individual blocks and their children.
    - `PlateBlock`: Rich text editor integration for block content.