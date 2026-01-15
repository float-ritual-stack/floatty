# Feature Exploration: Backlinks & TTL Directives

> **Status**: EXPLORATION - Design thinking, not yet implemented.
> See [current architecture](../guides/EVENT_SYSTEM.md) for what exists today.

Exploring how to implement backlinks loading and skip/TTL directives in floatty, comparing hook-based vs direct approaches.

**Reference**: FLOAT Block V2.3 (Drafts.app script)
**Date**: 2026-01-15

---

## Features Under Consideration

### 1. TTL/Skip Directives

Control which `[[wikilinks]]` get expanded into context, and for how long:

```markdown
## user
skip::0 [[Changelog]]        ← permanent skip, never expand
skip::3 [[API Reference]]    ← include for 3 turns, then stop
skip:: [[Notes/Old Section]] ← permanent skip for specific heading

Tell me about the authentication flow
```

**Behavior**:
- `skip::0` or `skip::` = permanent exclusion
- `skip::N` = include for N turns, then exclude
- Can target whole pages or specific headings (`[[Page/Heading]]`)
- TTL decrements each conversation turn

### 2. Backlinks Loading

When zoomed into a page, show and optionally include blocks that reference it:

```markdown
# API Authentication              ← Zoomed into this page

[Content of page...]

---
## Linked References (3)

[[Meeting Notes]] mentions this:
  "discussed [[API Authentication]] flow changes"

[[TODO List]] mentions this:
  "review [[API Authentication]] before release"

[[Architecture Doc/Security]] mentions this:
  "see [[API Authentication]] for token handling"
```

**Behavior**:
- Find all blocks containing `[[Page Name]]`
- Group by source page
- Optionally include in LLM context (with TTL)

---

## Feature 1: TTL/Skip Directives

### Implementation A: Without Hooks (Direct in Handler)

```typescript
// src/lib/handlers/send.ts (no hooks)

interface TTLState {
  noteTTL: Map<string, number>;      // note → expiresAtTurn
  headingTTL: Map<string, Map<string, number>>;  // note → heading → expiresAtTurn
  noteSkips: Set<string>;            // permanent note skips
  headingSkips: Map<string, Set<string>>;  // note → Set<heading>
}

// Global state per conversation (keyed by root block ID)
const ttlStates = new Map<string, TTLState>();

export const sendHandler: BlockHandler = {
  prefixes: ['/send', '::send'],

  async execute(blockId: string, content: string, actions: ExecutorActions): Promise<void> {
    const store = actions.getStore();

    // ═══════════════════════════════════════════════════════
    // CONTEXT ASSEMBLY (mixed with TTL logic)
    // ═══════════════════════════════════════════════════════

    const startIds = store.zoomedRootId ? [store.zoomedRootId] : store.rootIds;
    const allBlockIds = getBlocksInDocumentOrder(startIds, store.getBlock);
    const sendIndex = allBlockIds.indexOf(blockId);

    // Find conversation root for TTL state
    const conversationRoot = findConversationRoot(blockId, store);
    let ttl = ttlStates.get(conversationRoot);
    if (!ttl) {
      ttl = {
        noteTTL: new Map(),
        headingTTL: new Map(),
        noteSkips: new Set(),
        headingSkips: new Map()
      };
      ttlStates.set(conversationRoot, ttl);
    }

    // Count current turn
    const currentTurn = countTurns(allBlockIds, store.getBlock);

    // Build messages, parsing TTL directives along the way
    const messages: Message[] = [];
    let currentRole: 'user' | 'assistant' = 'user';
    let currentContent: string[] = [];

    const flushContent = () => {
      if (currentContent.length > 0) {
        let content = currentContent.join('\n');

        // Expand wikilinks (respecting TTL)
        content = expandWikilinksWithTTL(content, ttl, currentTurn, store);

        messages.push({ role: currentRole, content });
        currentContent = [];
      }
    };

    for (let i = 0; i < sendIndex; i++) {
      const block = store.getBlock(allBlockIds[i]);
      const text = block?.content.trim();
      if (!text) continue;

      // Parse TTL directives
      const ttlDirective = parseTTLDirective(text);
      if (ttlDirective) {
        applyTTLDirective(ttl, ttlDirective, currentTurn);
        continue; // Don't include directive in message
      }

      if (text.toLowerCase() === '## user') {
        flushContent();
        currentRole = 'user';
      } else if (text.toLowerCase() === '## assistant') {
        flushContent();
        currentRole = 'assistant';
      } else {
        currentContent.push(text);
      }
    }
    flushContent();

    // Validation...
    if (messages.length === 0) {
      actions.updateBlockContent(blockId, 'error:: No content to send');
      return;
    }

    // ═══════════════════════════════════════════════════════
    // EXECUTION
    // ═══════════════════════════════════════════════════════

    // ... rest of handler (LLM call, response handling) ...
  }
};

// Helper: Parse skip::N [[Target]] or skip:: [[Target/Heading]]
function parseTTLDirective(line: string): TTLDirective | null {
  const match = line.match(/^[\s-]*skip::(\d*)\s*\[\[([^\]]+)\]\]/);
  if (!match) return null;

  const ttlStr = match[1];
  const target = match[2].trim();

  // Parse target: "Note" or "Note/Heading"
  const slashIdx = target.indexOf('/');
  const note = slashIdx === -1 ? target : target.slice(0, slashIdx).trim();
  const heading = slashIdx === -1 ? null : target.slice(slashIdx + 1).trim();

  // TTL value: empty or 0 = permanent skip, N = N turns
  const ttl = ttlStr === '' ? 0 : parseInt(ttlStr, 10);

  return { note, heading, ttl, permanent: ttl === 0 };
}

function applyTTLDirective(state: TTLState, directive: TTLDirective, currentTurn: number): void {
  const noteKey = directive.note.toLowerCase();

  if (directive.permanent) {
    if (directive.heading) {
      if (!state.headingSkips.has(noteKey)) {
        state.headingSkips.set(noteKey, new Set());
      }
      state.headingSkips.get(noteKey)!.add(directive.heading.toLowerCase());
    } else {
      state.noteSkips.add(noteKey);
    }
  } else {
    const expiresAt = currentTurn + directive.ttl;
    if (directive.heading) {
      if (!state.headingTTL.has(noteKey)) {
        state.headingTTL.set(noteKey, new Map());
      }
      state.headingTTL.get(noteKey)!.set(directive.heading.toLowerCase(), expiresAt);
    } else {
      state.noteTTL.set(noteKey, expiresAt);
    }
  }
}

function shouldInclude(state: TTLState, note: string, heading: string | null, currentTurn: number): boolean {
  const noteKey = note.toLowerCase();
  const headKey = heading?.toLowerCase();

  // Check permanent skips
  if (state.noteSkips.has(noteKey)) return false;
  if (headKey && state.headingSkips.get(noteKey)?.has(headKey)) return false;

  // Check TTL expiration
  const noteExpire = state.noteTTL.get(noteKey);
  if (noteExpire !== undefined && currentTurn > noteExpire) return false;

  if (headKey) {
    const headExpire = state.headingTTL.get(noteKey)?.get(headKey);
    if (headExpire !== undefined && currentTurn > headExpire) return false;
  }

  return true;
}

function expandWikilinksWithTTL(
  text: string,
  ttl: TTLState,
  currentTurn: number,
  store: BlockStore
): string {
  const wikilinks = extractWikilinks(text);
  const expansions: string[] = [];

  for (const link of wikilinks) {
    const { note, heading } = parseWikilinkTarget(link.target);

    if (!shouldInclude(ttl, note, heading, currentTurn)) {
      continue; // Skip this link
    }

    const page = findPage(note, store);
    if (!page) continue;

    let content: string;
    if (heading) {
      content = extractSection(page.content, heading) || `_Section '${heading}' not found_`;
    } else {
      content = page.content;
    }

    // Get TTL status for annotation
    const status = getTTLStatus(ttl, note, heading, currentTurn);
    const annotation = status.remaining !== undefined
      ? ` (TTL: ${status.remaining} turns remaining)`
      : '';

    const label = heading ? `${note} / ${heading}` : note;
    expansions.push(`\n--- Context: ${label}${annotation} ---\n${content}\n--- End: ${label} ---`);
  }

  return expansions.length ? text + '\n' + expansions.join('\n') : text;
}
```

**Lines**: ~200+ in handler (TTL parsing, state management, expansion all interleaved)

### Implementation B: With Hooks (Separated Concerns)

```typescript
// ═══════════════════════════════════════════════════════════════
// src/lib/handlers/hooks/ttlDirectiveHook.ts
// Parses skip:: directives and updates TTL state
// ═══════════════════════════════════════════════════════════════

interface TTLState {
  noteTTL: Map<string, number>;
  headingTTL: Map<string, Map<string, number>>;
  noteSkips: Set<string>;
  headingSkips: Map<string, Set<string>>;
  currentTurn: number;
}

// Conversation-scoped TTL state
const ttlStates = new Map<string, TTLState>();

export const ttlDirectiveHook: Hook = {
  id: 'ttl-directive-parser',
  event: 'execute:before',
  priority: 2,  // Early, before wikilink expansion

  filter: (block) => {
    const content = block.content.trim().toLowerCase();
    return content.startsWith('/send') || content.startsWith('ai::');
  },

  handler: (ctx: HookContext): HookResult => {
    const { block, store } = ctx;

    // Find conversation root for state scoping
    const conversationRoot = findConversationRoot(block.id, store);
    if (!conversationRoot) return {};

    // Get or create TTL state
    let state = ttlStates.get(conversationRoot);
    if (!state) {
      state = {
        noteTTL: new Map(),
        headingTTL: new Map(),
        noteSkips: new Set(),
        headingSkips: new Map(),
        currentTurn: 0
      };
      ttlStates.set(conversationRoot, state);
    }

    // Count current turn
    const startIds = store.zoomedRootId ? [store.zoomedRootId] : store.rootIds;
    const allBlockIds = getBlocksInDocumentOrder(startIds, store.getBlock);
    state.currentTurn = countTurns(allBlockIds, store.getBlock);

    // Scan for TTL directives
    const sendIndex = allBlockIds.indexOf(block.id);
    for (let i = 0; i < sendIndex; i++) {
      const b = store.getBlock(allBlockIds[i]);
      const text = b?.content.trim();
      if (!text) continue;

      const directive = parseTTLDirective(text);
      if (directive) {
        applyDirective(state, directive);
      }
    }

    // Pass TTL state to subsequent hooks
    return {
      context: {
        ttlState: state,
        currentTurn: state.currentTurn
      }
    };
  }
};

function parseTTLDirective(line: string): TTLDirective | null {
  const match = line.match(/^[\s-]*skip::(\d*)\s*\[\[([^\]]+)\]\]/);
  if (!match) return null;

  const ttlStr = match[1];
  const target = match[2].trim();
  const slashIdx = target.indexOf('/');

  return {
    note: slashIdx === -1 ? target : target.slice(0, slashIdx).trim(),
    heading: slashIdx === -1 ? null : target.slice(slashIdx + 1).trim(),
    ttl: ttlStr === '' ? 0 : parseInt(ttlStr, 10),
    permanent: ttlStr === '' || ttlStr === '0'
  };
}

function applyDirective(state: TTLState, d: TTLDirective): void {
  const noteKey = d.note.toLowerCase();

  if (d.permanent) {
    if (d.heading) {
      if (!state.headingSkips.has(noteKey)) state.headingSkips.set(noteKey, new Set());
      state.headingSkips.get(noteKey)!.add(d.heading.toLowerCase());
    } else {
      state.noteSkips.add(noteKey);
    }
  } else {
    const expiresAt = state.currentTurn + d.ttl;
    if (d.heading) {
      if (!state.headingTTL.has(noteKey)) state.headingTTL.set(noteKey, new Map());
      state.headingTTL.get(noteKey)!.set(d.heading.toLowerCase(), expiresAt);
    } else {
      state.noteTTL.set(noteKey, expiresAt);
    }
  }
}

// Export for use by other hooks
export function shouldInclude(
  state: TTLState,
  note: string,
  heading: string | null
): boolean {
  const noteKey = note.toLowerCase();
  const headKey = heading?.toLowerCase();

  if (state.noteSkips.has(noteKey)) return false;
  if (headKey && state.headingSkips.get(noteKey)?.has(headKey)) return false;

  const noteExpire = state.noteTTL.get(noteKey);
  if (noteExpire !== undefined && state.currentTurn > noteExpire) return false;

  if (headKey) {
    const headExpire = state.headingTTL.get(noteKey)?.get(headKey);
    if (headExpire !== undefined && state.currentTurn > headExpire) return false;
  }

  return true;
}
```

```typescript
// ═══════════════════════════════════════════════════════════════
// src/lib/handlers/hooks/wikilinkExpansionHook.ts
// Expands [[wikilinks]], respecting TTL state from previous hook
// ═══════════════════════════════════════════════════════════════

import { shouldInclude } from './ttlDirectiveHook';

export const wikilinkExpansionHook: Hook = {
  id: 'wikilink-expansion',
  event: 'execute:before',
  priority: 5,  // After TTL parsing (priority 2)

  filter: (block) => {
    const content = block.content.trim().toLowerCase();
    return content.startsWith('/send') || content.startsWith('ai::');
  },

  handler: (ctx: HookContext): HookResult => {
    // Get messages from sendContextHook (priority 0)
    const hookContext = ctx as unknown as {
      messages?: Message[];
      ttlState?: TTLState;
      currentTurn?: number;
    };

    if (!hookContext.messages) return {};

    const ttlState = hookContext.ttlState;
    const currentTurn = hookContext.currentTurn ?? 0;

    // Expand wikilinks in messages
    const expandedMessages = hookContext.messages.map(msg => {
      const wikilinks = extractWikilinks(msg.content);
      if (wikilinks.length === 0) return msg;

      const expansions: string[] = [];

      for (const link of wikilinks) {
        const { note, heading } = parseWikilinkTarget(link.target);

        // Check TTL state (if available)
        if (ttlState && !shouldInclude(ttlState, note, heading)) {
          continue;
        }

        const page = findPage(note, ctx.store);
        if (!page) continue;

        let content: string;
        if (heading) {
          content = extractSection(page.content, heading) || `_Section '${heading}' not found_`;
        } else {
          content = page.content;
        }

        // Annotate with TTL info
        let annotation = '';
        if (ttlState) {
          const noteKey = note.toLowerCase();
          const headKey = heading?.toLowerCase();
          const expire = heading
            ? ttlState.headingTTL.get(noteKey)?.get(headKey!)
            : ttlState.noteTTL.get(noteKey);
          if (expire !== undefined) {
            annotation = ` (TTL: ${expire - currentTurn} turns remaining)`;
          }
        }

        const label = heading ? `${note} / ${heading}` : note;
        expansions.push(`\n--- Context: ${label}${annotation} ---\n${content}\n--- End: ${label} ---`);
      }

      if (expansions.length === 0) return msg;

      return {
        ...msg,
        content: msg.content + '\n' + expansions.join('\n')
      };
    });

    return {
      context: {
        messages: expandedMessages,
        expandedCount: expandedMessages.filter((m, i) =>
          m.content !== hookContext.messages![i].content
        ).length
      }
    };
  }
};
```

```typescript
// ═══════════════════════════════════════════════════════════════
// src/lib/handlers/send.ts (with hooks)
// Handler stays focused on execution
// ═══════════════════════════════════════════════════════════════

export const sendHandler: BlockHandler = {
  prefixes: ['/send', '::send'],

  async execute(blockId: string, _content: string, actions: ExecutorActions): Promise<void> {
    const hookContext = (actions as any).hookContext as {
      messages?: Message[];
      ttlState?: TTLState;
      expandedCount?: number;
    } | undefined;

    if (!hookContext?.messages?.length) {
      actions.updateBlockContent(blockId, 'error:: No messages');
      return;
    }

    const { messages } = hookContext;

    // Handler just does execution - no TTL logic here
    actions.updateBlockContent(blockId, '## assistant');
    actions.setBlockStatus?.(blockId, 'running');

    const responseId = actions.createBlockInside(blockId);
    actions.updateBlockContent(responseId, 'Thinking...');

    // ... LLM call and response handling ...
  }
};
```

**Lines**:
- `ttlDirectiveHook.ts`: ~90 lines
- `wikilinkExpansionHook.ts`: ~80 lines (uses TTL state)
- `send.ts`: ~45 lines

**Hook chain**:
```
sendContextHook (priority 0)     → messages
    ↓
ttlDirectiveHook (priority 2)    → messages, ttlState
    ↓
wikilinkExpansionHook (priority 5) → messages (expanded), ttlState
    ↓
sendHandler                       → consumes expanded messages
```

### Analysis: TTL Feature

| Aspect | Direct | With Hooks |
|--------|--------|------------|
| **TTL logic isolation** | Mixed with message building | Separate, testable |
| **Wikilink expansion** | Interleaved with TTL checks | Separate hook, composable |
| **Reuse** | TTL logic locked in handler | `shouldInclude()` exported, reusable |
| **Testing** | Mock entire handler | Test TTL parsing as pure function |
| **Feature flag** | `if` statements in handler | Register/unregister hooks |
| **Understanding flow** | Read one file top-to-bottom | Trace through hook chain |

**Verdict**: Hooks make more sense here because:
1. TTL state is conversation-scoped (needs to persist across executions)
2. Wikilink expansion and TTL filtering are separable concerns
3. Other features (debug view, token estimation) need access to TTL state

---

## Feature 2: Backlinks Loading

### What Floatty Already Has

`LinkedReferences.tsx` already shows backlinks when zoomed into a page:

```typescript
// src/components/LinkedReferences.tsx (existing)
export function LinkedReferences(props: Props) {
  const backlinks = createMemo(() => {
    return extractBacklinks(props.pageTitle, props.store);
  });

  return (
    <div class="linked-references">
      <h3>Linked References ({backlinks().length})</h3>
      <For each={backlinks()}>
        {(backlink) => (
          <div class="backlink-item" onClick={() => props.onNavigate(backlink.sourceId)}>
            <span class="backlink-source">{backlink.sourcePage}</span>
            <blockquote>{backlink.context}</blockquote>
          </div>
        )}
      </For>
    </div>
  );
}
```

### Enhancement: Include Backlinks in LLM Context

The FLOAT script's insight: when asking about a page, the LLM should know what OTHER pages reference it. This provides bidirectional context.

### Implementation A: Without Hooks (Direct)

```typescript
// src/lib/handlers/send.ts (no hooks, with backlink loading)

export const sendHandler: BlockHandler = {
  prefixes: ['/send', '::send'],

  async execute(blockId: string, content: string, actions: ExecutorActions): Promise<void> {
    const store = actions.getStore();

    // ═══════════════════════════════════════════════════════════
    // CONTEXT ASSEMBLY
    // ═══════════════════════════════════════════════════════════

    // ... existing message building logic ...

    // ═══════════════════════════════════════════════════════════
    // BACKLINK LOADING (new)
    // ═══════════════════════════════════════════════════════════

    // Detect if we're asking about a specific page
    const pageReferences = detectPageReferences(messages);

    for (const pageRef of pageReferences) {
      // Find blocks that link TO this page
      const backlinks = findBacklinks(pageRef.title, store);

      if (backlinks.length > 0) {
        const backlinkContext = formatBacklinksForLLM(backlinks, pageRef.title);

        // Inject backlink context into the last user message
        const lastUserIdx = findLastUserMessageIndex(messages);
        if (lastUserIdx >= 0) {
          messages[lastUserIdx].content += backlinkContext;
        }
      }
    }

    // ═══════════════════════════════════════════════════════════
    // EXECUTION
    // ═══════════════════════════════════════════════════════════

    // ... LLM call ...
  }
};

function detectPageReferences(messages: Message[]): PageReference[] {
  const refs: PageReference[] = [];

  for (const msg of messages) {
    // Detect explicit page mentions
    const wikilinks = extractWikilinks(msg.content);
    for (const link of wikilinks) {
      refs.push({ title: link.target, explicit: true });
    }

    // Detect "tell me about X" patterns
    const aboutMatch = msg.content.match(/(?:about|regarding|for)\s+\[\[([^\]]+)\]\]/i);
    if (aboutMatch) {
      refs.push({ title: aboutMatch[1], explicit: true, isPrimaryTopic: true });
    }
  }

  return refs;
}

function findBacklinks(pageTitle: string, store: BlockStore): Backlink[] {
  const backlinks: Backlink[] = [];
  const titleLower = pageTitle.toLowerCase();

  // Scan all blocks for references to this page
  for (const blockId of store.getAllBlockIds()) {
    const block = store.getBlock(blockId);
    if (!block) continue;

    const wikilinks = extractWikilinks(block.content);
    for (const link of wikilinks) {
      if (link.target.toLowerCase() === titleLower) {
        backlinks.push({
          sourceBlockId: blockId,
          sourcePage: getPageForBlock(blockId, store),
          context: extractSurroundingContext(block.content, link.position),
          linkText: link.raw
        });
      }
    }
  }

  return backlinks;
}

function formatBacklinksForLLM(backlinks: Backlink[], pageTitle: string): string {
  if (backlinks.length === 0) return '';

  let output = `\n\n--- Backlinks to [[${pageTitle}]] (${backlinks.length} references) ---\n`;

  // Group by source page
  const byPage = new Map<string, Backlink[]>();
  for (const bl of backlinks) {
    const page = bl.sourcePage || 'Unknown';
    if (!byPage.has(page)) byPage.set(page, []);
    byPage.get(page)!.push(bl);
  }

  for (const [page, links] of byPage) {
    output += `\nFrom [[${page}]]:\n`;
    for (const link of links) {
      output += `  "${link.context}"\n`;
    }
  }

  output += `--- End Backlinks ---\n`;
  return output;
}
```

**Lines**: ~80 additional lines in handler

### Implementation B: With Hooks (Separated)

```typescript
// ═══════════════════════════════════════════════════════════════
// src/lib/handlers/hooks/backlinkContextHook.ts
// Loads backlinks for referenced pages and adds to context
// ═══════════════════════════════════════════════════════════════

export const backlinkContextHook: Hook = {
  id: 'backlink-context',
  event: 'execute:before',
  priority: 8,  // After wikilink expansion, before token estimation

  filter: (block) => {
    const content = block.content.trim().toLowerCase();
    return content.startsWith('/send') || content.startsWith('ai::');
  },

  handler: (ctx: HookContext): HookResult => {
    const hookContext = ctx as unknown as {
      messages?: Message[];
      ttlState?: TTLState;
    };

    if (!hookContext.messages) return {};

    // Detect pages being discussed
    const pageRefs = detectPageReferences(hookContext.messages);
    if (pageRefs.length === 0) return {};

    // Find backlinks for each referenced page
    const allBacklinks: Map<string, Backlink[]> = new Map();

    for (const ref of pageRefs) {
      // Skip if TTL says to exclude this page
      if (hookContext.ttlState && !shouldIncludeBacklinks(hookContext.ttlState, ref.title)) {
        continue;
      }

      const backlinks = findBacklinks(ref.title, ctx.store);
      if (backlinks.length > 0) {
        allBacklinks.set(ref.title, backlinks);
      }
    }

    if (allBacklinks.size === 0) return {};

    // Format backlinks for injection
    const backlinkContext = formatBacklinksForLLM(allBacklinks);

    // Inject into last user message
    const messages = [...hookContext.messages];
    const lastUserIdx = messages.findLastIndex(m => m.role === 'user');

    if (lastUserIdx >= 0) {
      messages[lastUserIdx] = {
        ...messages[lastUserIdx],
        content: messages[lastUserIdx].content + backlinkContext
      };
    }

    return {
      context: {
        messages,
        backlinksLoaded: Array.from(allBacklinks.keys()),
        backlinkCount: Array.from(allBacklinks.values()).reduce((sum, arr) => sum + arr.length, 0)
      }
    };
  }
};

function detectPageReferences(messages: Message[]): PageReference[] {
  const refs: PageReference[] = [];
  const seen = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== 'user') continue;

    const wikilinks = extractWikilinks(msg.content);
    for (const link of wikilinks) {
      const key = link.target.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        refs.push({ title: link.target });
      }
    }
  }

  return refs;
}

function findBacklinks(pageTitle: string, store: HookBlockStore): Backlink[] {
  const backlinks: Backlink[] = [];
  const titleLower = pageTitle.toLowerCase();

  // Use store.blocks for full scan
  for (const [blockId, block] of Object.entries(store.blocks)) {
    const wikilinks = extractWikilinks(block.content);
    for (const link of wikilinks) {
      if (link.target.toLowerCase() === titleLower) {
        backlinks.push({
          sourceBlockId: blockId,
          sourcePage: getPageForBlock(blockId, store),
          context: extractContext(block.content, link.position, 100)
        });
      }
    }
  }

  return backlinks;
}

function formatBacklinksForLLM(backlinks: Map<string, Backlink[]>): string {
  let output = '\n\n';

  for (const [pageTitle, links] of backlinks) {
    output += `--- Backlinks to [[${pageTitle}]] (${links.length}) ---\n`;

    // Group by source
    const bySource = groupBy(links, bl => bl.sourcePage || 'Unknown');

    for (const [source, sourceLinks] of Object.entries(bySource)) {
      output += `From [[${source}]]:\n`;
      for (const link of sourceLinks) {
        output += `  • "${link.context}"\n`;
      }
    }

    output += `--- End Backlinks ---\n\n`;
  }

  return output;
}

// Allow TTL to control backlink inclusion
function shouldIncludeBacklinks(ttlState: TTLState, pageTitle: string): boolean {
  // Could add skip::backlinks [[Page]] syntax
  // For now, respect page-level skips
  return !ttlState.noteSkips.has(pageTitle.toLowerCase());
}
```

**Lines**: ~100 lines in dedicated hook file

### Analysis: Backlinks Feature

| Aspect | Direct | With Hooks |
|--------|--------|------------|
| **Integration with TTL** | Manual coordination | Automatic via hook chain |
| **Feature isolation** | Mixed with message building | Separate, removable |
| **Testing** | Need to mock full handler | Test backlink finding separately |
| **Disable feature** | `if` statement or comment out | Unregister hook |
| **Token awareness** | Manual check before injection | Token hook sees full context |

**Verdict**: Hooks are beneficial here because:
1. Backlink loading interacts with TTL state (should respect skips)
2. Token estimation hook needs to see expanded context including backlinks
3. Feature can be disabled without touching core handler

---

## Combined Hook Chain

With both features implemented via hooks:

```
sendContextHook (priority 0)
├─ Builds base messages array from ## user / ## assistant markers
│
ttlDirectiveHook (priority 2)
├─ Parses skip:: directives
├─ Updates TTL state
├─ Passes state to subsequent hooks
│
wikilinkExpansionHook (priority 5)
├─ Expands [[wikilinks]] in messages
├─ Respects TTL state (skips expired/excluded)
├─ Annotates with TTL remaining
│
backlinkContextHook (priority 8)
├─ Detects pages being discussed
├─ Loads backlinks (respects TTL skips)
├─ Injects into last user message
│
tokenEstimationHook (priority 10)
├─ Calculates tokens for full expanded context
├─ Warns if approaching limit
│
sendHandler
└─ Receives fully assembled messages
   └─ Executes LLM call
```

### Direct Implementation Equivalent

```typescript
// Everything in one handler (~350 lines)
export const sendHandler: BlockHandler = {
  async execute(blockId, content, actions) {
    // 1. Build messages (~40 lines)
    // 2. Parse TTL directives (~30 lines)
    // 3. Apply TTL state (~20 lines)
    // 4. Expand wikilinks with TTL checks (~60 lines)
    // 5. Detect page references (~20 lines)
    // 6. Load backlinks (~40 lines)
    // 7. Format backlinks (~30 lines)
    // 8. Inject into messages (~10 lines)
    // 9. Estimate tokens (~20 lines)
    // 10. Execute LLM call (~40 lines)
    // 11. Handle response (~40 lines)
  }
};
```

---

## Honest Assessment

### When Direct Makes Sense

If floatty's chat feature were:
- A one-off experiment
- Never going to have TTL/backlinks/token estimation
- Maintained by one person who knows the code

Then **direct implementation is cleaner**. One file, linear flow, no abstraction layers.

### When Hooks Make Sense

For floatty's chat, hooks are justified because:

1. **Features interact**: TTL affects wikilink expansion AND backlink loading. With hooks, each feature declares its dependency (priority ordering) rather than manually coordinating.

2. **Debugging visibility**: When token count is too high, we can trace: which hook added what? Was it backlinks? Wikilink expansion? The hook chain provides observability.

3. **Feature flags are natural**: Production might have backlinks disabled while testing. Hooks make this trivial.

4. **Testing is cleaner**: Test `findBacklinks()` without mocking LLM. Test `parseTTLDirective()` without mocking anything.

5. **New features compose**: Want to add "include conversation summary"? Add a hook at priority 9. No handler modification.

### The Cost

- ~150 lines of hook infrastructure (registry, executor wrapper)
- Mental overhead of understanding hook chain
- Debugging requires tracing through multiple files
- Overkill if features stay simple

---

## Recommendation

For TTL directives and backlinks in floatty:

**Use hooks** because these features:
1. Have state that persists across executions (TTL)
2. Interact with each other (backlinks respect TTL)
3. Need to be observable (debug mode showing what was expanded)
4. May be feature-flagged (disable backlinks in some contexts)

The hook system already exists. The marginal cost of adding `ttlDirectiveHook` and `backlinkContextHook` is lower than the value they provide in separation and testability.

---

## Next Steps

1. **Implement TTL parsing** as a hook (priority 2)
2. **Modify wikilinkExpansionHook** to consume TTL state
3. **Implement backlinkContextHook** (priority 8)
4. **Add debug hook** (priority 100) to log what context was assembled
5. **Test each hook** in isolation
6. **Document the hook chain** for future maintainers
