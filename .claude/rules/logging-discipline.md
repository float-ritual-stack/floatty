# Logging Discipline

Rules for writing log lines in `floatty-server`, `floatty-core`, `src-tauri/src`. Read before adding any `tracing::` or `eprintln!` call.

## 1. Secrets never flow through `tracing::`

**Rule**: user-configurable fields (API keys, URLs from config/env, auth headers, DB connection strings, bearer tokens, file paths with usernames) are sensitive by default. Never format them into `tracing::` events — they ship to the OTLP collector.

**Mask at source**. Log metadata (length, source, existence), not the value.

```rust
// ❌ WRONG — ships full key to OTLP
tracing::info!("API key: {}", api_key);

// ❌ WRONG — URL may contain userinfo, tokens, internal hostnames
tracing::info!(endpoint = %otlp_endpoint, "otlp_log_export_enabled");

// ✅ CORRECT
tracing::info!(source = api_key_source, length = api_key.len(), "API key configured");

// ✅ CORRECT — presence, no value
tracing::info!(target: "floatty_startup", "otlp_log_export_enabled");
```

**Safe**: `127.0.0.1:N` (local, no auth), version strings, commit SHA, error messages without the secret, deep link URLs (user-shareable by design), build/path constants.

**Heuristic**: if the field would go in `config.toml` or an env var, it's sensitive.

## 2. Use the right sink for the situation

| Situation | Use | Never use |
|---|---|---|
| Pre-`setup_logging()` errors (config parse, bootstrap) | `eprintln!` | `tracing::*` — subscriber not up, drops silently |
| Post-init lifecycle events | `tracing::info!` | `println!`, `eprintln!` |
| Hot-path events (ws broadcast, observer fires, per-keystroke) | `tracing::debug!` | `tracing::info!` |
| Recoverable failures | `tracing::warn!` | — |
| Secrets | Mask → log metadata (rule 1) | `tracing::*` with the value |
| Dev discovery hints (curl examples with keys) | `#[cfg(debug_assertions)] eprintln!` | `tracing::*` |
| Fatal source-of-truth failures | `panic!` with context | Silent degradation |
| Optional remote feature failures (OTLP, backup, Ollama) | `eprintln!` + continue | `panic!` |

**Pre-init call graph** (functions that run before `setup_logging()` — must use `eprintln!`):
- `ServerConfig::load()` at `main.rs:142`
- Any helper `ServerConfig::load()` calls internally

Add new entries to this list when extending the bootstrap path.

## 3. Align failure modes per subsystem

Pick once per subsystem. Apply to every failure point in it.

| Subsystem | Mode |
|---|---|
| Local JSONL file layer (log dir, appender) | **Fail fast** — panic with context |
| Primary Y.Doc store open | **Fail fast** |
| FLO-317 data dir preflight | **Fail fast** |
| OTLP exporter (build + runtime export) | **Degrade** — `eprintln!` + return `None` |
| Backup daemon | **Degrade** |
| ctx parser / Ollama network | **Degrade** |
| Search index init | **Degrade** (derived state, rebuildable) |

**Mixed failure modes in one subsystem is a bug.** `[[PR #223]]` round 2 caught this: log dir creation degraded but appender panicked. Align upward.

**Decision rule**: "would running without this hide the next class of bug we're trying to diagnose?" → yes = panic, no = degrade.

## 4. Comments match the sink mechanism exactly

Name the sink explicitly. Grep-friendly strings: `stdout`, `stderr`, `eprintln`, `via subscriber`, `via tracing::`, `JSONL file`, `OTLP`, `bypass subscriber`, `cfg(debug_assertions)`.

```rust
// ❌ WRONG — drift. Code uses eprintln! (stderr)
// Printed to stdout for local discovery only.
eprintln!(...);

// ✅ CORRECT
// Printed to stderr via eprintln! — bypasses the tracing subscriber, so
// never reaches the JSONL file or OTLP collector.
#[cfg(debug_assertions)]
eprintln!(...);
```

Comments describing intent without mechanism rot. Prefer mechanism.

## 5. `target:` overrides require filter entries

`EnvFilter` matches target string, not crate path. `floatty_core=info` does NOT match `tracing::info!(target: "floatty_startup", ...)`.

**Rule**: every `target:` override in the codebase needs a corresponding entry in the filter default.

**Existing overrides** (update when adding new):
- `floatty_startup` — `floatty-core::hooks::system` + `floatty-core::store` startup phases

## 6. Filter defaults (canonical)

**`floatty-server` (`src-tauri/floatty-server/src/main.rs` `setup_logging`)**:
```
floatty_server=info,floatty_core=info,floatty_startup=info,tower_http=warn,hyper=warn,reqwest=warn,opentelemetry=off
```

**Tauri process (`src-tauri/src/lib.rs` `setup_logging`)**:
```
info,tauri_plugin_pty=warn,hyper=warn,reqwest=warn,opentelemetry=off
```

**Required silencers** (don't remove — prevent telemetry-induced-telemetry loops when OTLP ships):
- `hyper=warn`
- `reqwest=warn`
- `opentelemetry=off`

Both filter defaults must be updated in lockstep when adding shared target overrides.

## Review checklist (run before committing logging changes)

- [ ] Any user-configurable field formatted into `tracing::*`? → Mask per rule 1.
- [ ] Any call runs before `setup_logging()`? → Use `eprintln!` per rule 2.
- [ ] Failure mode matches the subsystem's alignment? → Rule 3.
- [ ] Comment near the call names the exact sink mechanism? → Rule 4.
- [ ] New `target:` override added? → Update both filter defaults per rules 5+6.
- [ ] High-volume event added at `info`? → Demote to `debug` unless it's lifecycle.

## See also

- @.claude/rules/do-not.md — "Tracing / OTLP" section (specific anti-patterns)
- @.claude/rules/config-and-logging.md — paths, config, OTLP wiring
- @docs/architecture/LOGGING_STRATEGY.md — tier/phase tracking
