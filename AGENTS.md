# AGENTS.md

## MANDATORY: Use td for Task Management

Run td usage --new-session at conversation start (or after /clear). This tells you what to work on next.

Sessions are automatic (based on terminal/agent context). Optional:
- td session "name" to label the current session
- td session --new to force a new session in the same context

Use td usage -q after first read.

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
