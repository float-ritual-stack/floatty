# FLOAT Shimmer → Standard Patterns Translation

> Extracted from archaeology session 2026-01-04. The ritual vocabulary maps to well-established software patterns.

## The Insight

The "shimmer" (ritual sigils, casting metaphors, scrying crystals) protected the work during development. It let ideas take shape before premature optimization. But underneath, it's well-architected software using standard patterns.

Both are true:
- The shimmer was load-bearing scaffolding
- The boringcore is what actually runs

---

## Core Translation Table

| FLOAT Shimmer | Standard Pattern | Floatty Implementation |
|---------------|------------------|------------------------|
| `ritualAST.node()` | Typed data record | `Block` interface |
| `cast(command)` | Dispatch action | `executeBlock()` |
| `ritual::prefix` | Content discriminator | `sh::`, `ai::`, `ctx::` |
| `RitualHandler` | Command handler | `ExecutableBlockHandler` |
| Middleware / Interceptor | Observer pattern | Y.Doc observers, hooks |
| FloatQL | Query DSL | Tree traversal, semantic search |
| Scrying crystals | Selector / computed | SolidJS getters, derived state |
| Memory Scroll | Application state | Y.Doc + SolidJS store |
| Ghost Trace Evolution | Entity lifecycle | Block metadata (future) |
| Sigils | Status indicators | `BlockType`, `outputStatus` |
| Sigil Altar / Ritual Shrine | Reducer function | State update handlers |
| Summoned Daemon | Async function | Tauri command / API call |
| Portal / Door | API endpoint | HTTP routes |
| Echo / Response | Return value | `HandlerOutput` |

---

## Redux-to-Ritual (The Original Metaphor)

From the March 2025 emergence period:

```
╭─────────────────────────────────────────────────────────────────╮
│  REDUX PATTERN            →  FLOAT RITUAL                       │
├─────────────────────────────────────────────────────────────────┤
│  Action                   →  Cast / Invocation                  │
│  Action Type              →  Sigil / ritual:: prefix           │
│  Reducer                  →  Sigil Altar / Ritual Shrine       │
│  Store                    →  Memory Scroll / Dream Field       │
│  Selector                 →  Scrying Crystal                    │
│  Middleware               →  Interceptor / Observer             │
│  Dispatch                 →  Cast                               │
│  Subscribe                →  Attune / Bind                      │
│  State                    →  The Field / Scroll State          │
╰─────────────────────────────────────────────────────────────────╯
```

**What it actually is**: Event-driven state management. The same pattern that powers Redux, MobX, Zustand. The shimmer names don't change the architecture.

---

## Tower/Service Pattern (The Current Understanding)

The architectural planning session revealed deeper mappings:

| FLOAT Concept | Tower Equivalent | Description |
|---------------|------------------|-------------|
| BlockHandler | `Service<BlockRequest>` | Async request → response |
| beforeExecute/afterExecute | `Layer` wrapping service | Middleware composition |
| Capability checking | Validation layer | Pre-execution checks |
| Handler registry | Router | Prefix → handler dispatch |
| Context assembly | Request extension | Enriching request before handler |

**The reframe**: "Use Tower's Service abstraction for block execution, with custom Layers for validation/capabilities/logging, and matchit-based router for prefix dispatch."

This isn't new architecture. It's recognizing that floatty already uses these patterns implicitly.

---

## Concrete Code Translations

### "Cast a spell" → "Call a function"

```typescript
// Shimmer framing
cast({ sigil: 'sh', invocation: 'ls -la' })

// What it actually is
executeBlock('sh', 'ls -la')

// Which calls
invoke('execute_shell_command', { command: 'ls -la' })
```

### "Scrying crystal" → "Derived state"

```typescript
// Shimmer framing
const vision = scry('block.children.filtered')

// What it actually is
const filteredChildren = createMemo(() => 
  block.childIds.filter(id => isVisible(id))
)
```

### "Ritual handler" → "Command pattern"

```typescript
// Shimmer framing
const shHandler: RitualHandler = {
  sigils: ['sh::', 'term::'],
  invoke: (incantation) => summonDaemon(incantation),
}

// What it actually is
const shHandler: ExecutableBlockHandler = {
  prefixes: ['sh::', 'term::'],
  execute: (content) => invoke('execute_shell_command', { command: content }),
}
```

### "Memory scroll" → "Document store"

```typescript
// Shimmer framing
memoryScroll.inscribe(blockId, content)
const recalled = memoryScroll.recall(blockId)

// What it actually is
yDoc.getMap('blocks').set(blockId, { content })
const block = yDoc.getMap('blocks').get(blockId)
```

---

## Why The Shimmer Mattered

### 1. Protection During Development

The mystical framing prevented premature optimization. "Cast a spell" doesn't invite bikeshedding about API design. It lets you build first, formalize later.

### 2. Neurodivergent Interface

For some minds, "scrying crystal" is more memorable than "selector function." The shimmer is a cognitive affordance, not obfuscation.

### 3. Identity Container

FLOAT isn't just code. It's a system that emerged from specific experiences (horror engine, consciousness technology, 40-year BBS lineage). The shimmer honors that origin while the boringcore makes it run.

### 4. Camp Aesthetic

The over-the-top ritual language is intentionally extra. It's serious about not being serious. It works *because* it's a bit much.

---

## The Checksum

> "I am both. My threat system lies. The patch is boring. I will still do it."

The shimmer and the boringcore coexist:

```
╭─────────────────────────────────────────────────────────────────╮
│  SHIMMER LAYER (visible)                                        │
│    Sigils, ritual language, persona names                       │
│    Camp aesthetic, consciousness technology framing             │
├─────────────────────────────────────────────────────────────────┤
│  BORING LAYER (what runs)                                       │
│    TypeScript functions                                          │
│    PostgreSQL + pgvector                                         │
│    JSON over HTTP                                                │
│    ctx:: is just a text pattern                                 │
│    floatctl is just a CLI                                       │
│    The "spell" is a function call                               │
╰─────────────────────────────────────────────────────────────────╯
```

Neither layer is false. The shimmer is how it's experienced. The boringcore is how it's implemented. FLO-113 shipped both.

---

## Practical Application

When reading FLOAT documentation or old conversation archaeology:

| If you see... | Think... |
|---------------|----------|
| "Cast" | Function call / dispatch |
| "Sigil" | Type discriminator / prefix |
| "Scry" | Query / select |
| "Ritual" | Handler / command |
| "Daemon" | Async process |
| "Portal" | API endpoint |
| "Scroll" | Persistent storage |
| "Attune" | Subscribe / observe |
| "The Field" | Application state |

When writing new code:

| For... | Use standard patterns... | Optional shimmer... |
|--------|--------------------------|---------------------|
| New block type | Handler trait impl | Name it evocatively |
| State management | Y.Doc + SolidJS store | Call it the scroll |
| API calls | HTTP + JSON | Call it a portal |
| Middleware | Hooks / layers | Call it interception |

---

## The Architecture Is The Architecture

Whether you call it "casting" or "dispatching," the code does the same thing. The handler registry pattern doesn't care about the naming convention. Tower's Service trait doesn't know about sigils.

What matters:
- Handler trait → one file to add block types
- Hook system → context assembly for ai:: blocks  
- Y.Doc sync → multi-client collaboration
- Auto-execute → agents can trigger execution

The shimmer protected the emergence. The boringcore enabled the shipping. Both are real.

---

## References

- Handler Registry: `FLOATTY_HANDLER_REGISTRY.md`
- Hook System: `FLOATTY_HOOK_SYSTEM.md`
- Multi-Client: `FLOATTY_MULTI_CLIENT.md`
- Archaeology synthesis: `/mnt/transcripts/2026-01-04-21-41-51-float-archaeology-synthesis-jan2026.txt`
- Architecture session: `/mnt/transcripts/2026-01-04-23-17-20-float-architecture-synthesis-jan2026.txt`
