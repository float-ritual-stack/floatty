# AGENTS.md

Instructions for AI agents working with this codebase.

## btca

When you need up-to-date information about technologies used in this project, use btca to query source repositories directly.

**Available resources**: solidJs, xterm, yjs, vite, vitest, tinykeys, tauri, yrs, tokio, tracing, rusqlite, ollama

### Usage

```bash
btca ask -r <resource> -q "<question>"
```

Use multiple `-r` flags to query multiple resources at once:

```bash
btca ask -r yjs -r yrs -q "How do I observe deep changes in a Y.Map?"
btca ask -r solidJs -q "What's the difference between createSignal and createStore?"
btca ask -r tauri -q "How do I create a custom IPC command with channels?"
```
