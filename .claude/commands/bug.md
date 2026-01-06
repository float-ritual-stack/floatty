---
description: Fix a bug with relevant safety checks
---

# Bug: $ARGUMENTS

## Category Check

Which of the four bug categories might this involve?

- [ ] **Re-Parenting Trap**: xterm.js/WebGL context issues on layout change
- [ ] **Sync Loop**: Y.Doc observer triggering itself via signals
- [ ] **PTY Zombies**: Process not cleaned up on close/crash
- [ ] **Split Brain**: Stale state after CRDT sync

## Investigation Steps

1. **Reproduce**: Can you trigger the bug reliably?
2. **Locate**: Which file/function is involved?
3. **Trace**: Follow the event → handler → transform → project chain
4. **Identify**: Where does the chain break or misbehave?

## Common Fixes

### If sync loop:
```typescript
if (origin === 'remote') return;  // Add origin check
```

### If stale reference:
```typescript
const block = store.getBlock(id);  // Re-fetch, don't use cached
```

### If PTY zombie:
```typescript
this.disposing.add(id);  // Guard before async operations
```

### If re-parenting:
```typescript
instance.webglAddon?.dispose();  // Dispose BEFORE re-open
```

## Validation

After fix:
- [ ] Original bug no longer reproduces
- [ ] Related functionality still works
- [ ] No new console errors/warnings
- [ ] Tests pass (`npm run test`)
