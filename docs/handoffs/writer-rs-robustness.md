# writer.rs Robustness Follow-up

**Source**: PR #78 CodeRabbit review
**Priority**: Medium (search works, these are polish)
**File**: `src-tauri/floatty-core/src/search/writer.rs`

---

## Issue 1: Silent Actor Panics (line 176)

**Problem**: Spawned actor task's JoinHandle is discarded. If actor panics, callers only see `WriterClosed` errors with no visibility into root cause.

**Fix**:
```rust
let task_handle = tokio::spawn(async move {
    actor.run().await;
});

// Monitor actor health
tokio::spawn(async move {
    if let Err(e) = task_handle.await {
        error!(error = ?e, "Writer actor panicked");
    }
});
```

**Alternative**: Return JoinHandle alongside WriterHandle so caller can monitor.

---

## Issue 2: Lost Writes on Channel Close (line 246)

**Problem**: If all WriterHandles are dropped without explicit Shutdown, `pending_ops` are lost because loop exits without commit.

**Fix**: Add final commit after the `while let` loop:
```rust
async fn run(mut self) {
    let mut pending_ops = 0u64;

    while let Some(msg) = self.rx.recv().await {
        // ... existing match ...
    }

    // Channel closed without explicit shutdown: best-effort flush
    if pending_ops > 0 {
        if let Err(e) = self.writer.commit() {
            warn!(error = %e, pending_ops, "Failed to commit on channel close");
        } else {
            debug!(pending_ops, "Index committed on channel close");
        }
    }

    info!("Writer actor stopped");
}
```

---

## When to Address

These are robustness improvements, not bugs. Current behavior:
- Search works correctly in normal operation
- Edge cases (panics, dropped handles) have degraded observability

Good candidates for Work Unit 4.x cleanup pass.
