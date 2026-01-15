---
description: Classify a feature as Handler, Hook, Projection, or Renderer
argument-hint: <feature description>
---

# Classify: $ARGUMENTS

Determine what architectural primitive this feature should be.

## The Five Questions

Answer each to narrow down:

### Q1: Who initiates?

```
User types a prefix and wants a result?     → HANDLER
System detects a change and should react?   → HOOK or PROJECTION
```

Answer: ________________

### Q2: Does it own the block?

```
Yes - transforms content, creates children  → HANDLER
No - reads, enriches, but doesn't modify    → HOOK
No - builds derived state from many blocks  → PROJECTION
```

Answer: ________________

### Q3: When does it run?

```
Once, on explicit trigger (Enter key)       → HANDLER
Every time a handler executes (pipeline)    → HOOK (execute:before/after)
Every time blocks change (observer)         → HOOK (block:*) or PROJECTION
```

Answer: ________________

### Q4: Is it in the critical path?

```
Yes - user is waiting for result            → HANDLER or sync HOOK
No - can happen in background               → PROJECTION (async, batched)
```

Answer: ________________

### Q5: Does it need other hooks' output?

```
Yes - needs enriched context                → HOOK (with priority ordering)
No - standalone operation                   → HANDLER
```

Answer: ________________

---

## Pattern Match Against Examples

Compare with known decisions:

| Feature | Classification | Why |
|---------|----------------|-----|
| `filter:: include(status::*)` | HANDLER | User types, expects results as children |
| `ctx::3 [[Page]]` | HOOK | Directive that enriches context for another handler |
| `:::Kanban` | RENDERER | Not executed, rendered differently by type |
| Backlink index | PROJECTION | Background, batched, builds derived state |
| Wikilink expansion for AI | HOOK | Part of execute:before pipeline, priority 5 |

Does **$ARGUMENTS** match any of these patterns?

---

## Classification Summary

Based on the questions above:

```
┌─────────────────────────────────────────────────────────────────┐
│  HANDLER          User asks, handler delivers                   │
│  ───────────────────────────────────────────                    │
│  Use when: Prefix triggers action, output visible to user       │
│  Examples: sh::, ai::, search::, filter::                       │
├─────────────────────────────────────────────────────────────────┤
│  HOOK             Enrich, validate, or react                    │
│  ───────────────────────────────────────────                    │
│  Use when: Intercept execution, add context, can abort          │
│  Examples: sendContextHook, ttlDirectiveHook, wikilinkHook      │
├─────────────────────────────────────────────────────────────────┤
│  PROJECTION       Background derived state                      │
│  ───────────────────────────────────────────                    │
│  Use when: Expensive, batched, builds indexes                   │
│  Examples: backlinkIndex, searchIndex (Tantivy), pageNameIndex  │
├─────────────────────────────────────────────────────────────────┤
│  RENDERER         Display block type specially                  │
│  ───────────────────────────────────────────                    │
│  Use when: Block has pattern (:::X), not executed, visualized   │
│  Examples: KanbanRenderer, ChartRenderer, MermaidRenderer       │
└─────────────────────────────────────────────────────────────────┘
```

## Verdict

**$ARGUMENTS** is a: [ ] Handler  [ ] Hook  [ ] Projection  [ ] Renderer

**Rationale**: ________________

**Next steps**:
- If Handler: Add to `src/lib/handlers/`, register in index
- If Hook: Add to `src/lib/hooks/`, set priority appropriately
- If Projection: Add to ProjectionScheduler with debounce timing
- If Renderer: Add detection hook + display component

See `docs/architecture/PHILOSOPHY.md` for full decision framework and mental models.
