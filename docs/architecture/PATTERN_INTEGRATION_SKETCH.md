# Pattern Integration Sketch: Filters, Components, Routing

> Design exploration: How patterns from float-janky-shack-door and tauri-mast-year prototypes integrate with floatty's EventBus/Hook architecture.

## Overview

Three pattern categories to integrate:

1. **Filter Blocks** (Roam-inspired) - `filter::` syntax for querying blocks by metadata/markers
2. **MDX-like Components** - `:::Component` syntax for rich embedded views (Kanban, SystemStatus)
3. **Routing Rules** - Priority-based marker routing with conditions and patterns

All three leverage the existing EventBus/Hook system rather than creating parallel infrastructure.

---

## 1. Filter Blocks (Roam Query Pattern)

### Syntax

```
filter:: include(project::floatty) exclude(ctx::personal) limit(10)
```

Or multi-line for complex queries:

```
filter::
  include(project::*)
  include(mode::coding)
  exclude(status::archived)
  sort(created_at desc)
  limit(20)
```

### Block Type Detection

Extends existing `blockTypes.ts` pattern:

```typescript
// src/lib/blockTypes.ts
export const BLOCK_TYPES = {
  // ... existing
  filter: { prefix: 'filter::', icon: '🔍', color: 'var(--color-ansi-cyan)' },
};
```

### Query Parser

New parser for filter syntax:

```typescript
// src/lib/filterParser.ts
export interface FilterQuery {
  includes: FilterCondition[];
  excludes: FilterCondition[];
  sort?: { field: string; direction: 'asc' | 'desc' };
  limit?: number;
}

export interface FilterCondition {
  type: 'marker' | 'metadata' | 'content';
  key: string;        // e.g., 'project', 'mode', '*'
  pattern?: string;   // e.g., 'floatty', '*', 'float*'
  operator?: 'eq' | 'contains' | 'startsWith' | 'regex';
}

export function parseFilterQuery(content: string): FilterQuery {
  const query: FilterQuery = { includes: [], excludes: [] };

  // Match include(...) and exclude(...)
  const includePattern = /include\(([^)]+)\)/g;
  const excludePattern = /exclude\(([^)]+)\)/g;

  let match;
  while ((match = includePattern.exec(content)) !== null) {
    query.includes.push(parseCondition(match[1]));
  }
  while ((match = excludePattern.exec(content)) !== null) {
    query.excludes.push(parseCondition(match[1]));
  }

  // Match sort(field direction) and limit(n)
  const sortMatch = content.match(/sort\((\w+)\s+(asc|desc)\)/);
  if (sortMatch) {
    query.sort = { field: sortMatch[1], direction: sortMatch[2] as 'asc' | 'desc' };
  }

  const limitMatch = content.match(/limit\((\d+)\)/);
  if (limitMatch) {
    query.limit = parseInt(limitMatch[1], 10);
  }

  return query;
}

function parseCondition(expr: string): FilterCondition {
  // project::floatty → { type: 'marker', key: 'project', pattern: 'floatty' }
  // metadata.status::active → { type: 'metadata', key: 'status', pattern: 'active' }
  // content::"search term" → { type: 'content', key: '*', pattern: 'search term' }

  if (expr.includes('::')) {
    const [key, pattern] = expr.split('::');
    if (key.startsWith('metadata.')) {
      return { type: 'metadata', key: key.replace('metadata.', ''), pattern };
    }
    return { type: 'marker', key, pattern: pattern || '*' };
  }

  return { type: 'content', key: '*', pattern: expr };
}
```

### Hook Integration

Filter blocks use `execute:before` hook to query matching blocks:

```typescript
// src/lib/handlers/hooks/filterQueryHook.ts
import { hookRegistry } from '../../hooks/hookRegistry';
import { parseFilterQuery, matchesQuery } from '../../filterParser';
import type { Block } from '../../blockTypes';

hookRegistry.register({
  id: 'filter-query-execution',
  event: 'execute:before',
  filter: (block) => block.content.startsWith('filter::'),
  priority: 0,

  handler: (ctx) => {
    const query = parseFilterQuery(ctx.content);
    const store = ctx.store;

    // Query all blocks, filter by conditions
    const allBlocks = Object.values(store.blocks);
    const matches = allBlocks.filter(block => matchesQuery(block, query));

    // Apply sort
    if (query.sort) {
      matches.sort((a, b) => {
        const aVal = getFieldValue(a, query.sort!.field);
        const bVal = getFieldValue(b, query.sort!.field);
        const cmp = aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
        return query.sort!.direction === 'desc' ? -cmp : cmp;
      });
    }

    // Apply limit
    const limited = query.limit ? matches.slice(0, query.limit) : matches;

    return {
      context: {
        queryResults: limited,
        queryMeta: {
          total: matches.length,
          returned: limited.length,
          query,
        },
      },
    };
  },
});
```

### Matching Logic

```typescript
// src/lib/filterParser.ts (continued)
export function matchesQuery(block: Block, query: FilterQuery): boolean {
  // Must match ALL includes
  for (const condition of query.includes) {
    if (!matchesCondition(block, condition)) {
      return false;
    }
  }

  // Must match NONE of excludes
  for (const condition of query.excludes) {
    if (matchesCondition(block, condition)) {
      return false;
    }
  }

  return true;
}

function matchesCondition(block: Block, condition: FilterCondition): boolean {
  switch (condition.type) {
    case 'marker': {
      // Check for marker:: pattern in content
      const markerPattern = new RegExp(
        `${escapeRegex(condition.key)}::${patternToRegex(condition.pattern)}`,
        'i'
      );
      return markerPattern.test(block.content);
    }

    case 'metadata': {
      const value = block.metadata?.[condition.key];
      if (value === undefined) return false;
      return matchesPattern(String(value), condition.pattern);
    }

    case 'content': {
      return matchesPattern(block.content, condition.pattern);
    }
  }
}

function patternToRegex(pattern: string | undefined): string {
  if (!pattern || pattern === '*') return '[^\\s]*';
  // Convert glob-like patterns: float* → float[^\s]*
  return escapeRegex(pattern).replace(/\\\*/g, '[^\\s]*');
}
```

### EventBus Integration for Live Updates

Filter blocks can subscribe to block changes for live updates:

```typescript
// src/components/FilterBlockDisplay.tsx
import { blockEventBus, EventFilters } from '../lib/events';

export function FilterBlockDisplay(props: { block: Block; queryResults: Block[] }) {
  const [results, setResults] = createSignal(props.queryResults);

  // Subscribe to block changes that might affect query
  createEffect(() => {
    const unsubscribe = blockEventBus.subscribe(
      (envelope) => {
        // Re-run query when blocks change
        // Debounced to avoid thrashing on rapid edits
        debouncedRequery();
      },
      {
        filter: EventFilters.any(
          EventFilters.creates(),
          EventFilters.updates(),
          EventFilters.deletes()
        ),
        name: `filter-block-${props.block.id}`,
      }
    );

    onCleanup(unsubscribe);
  });

  return (
    <div class="filter-results">
      <For each={results()}>
        {(block) => <FilterResultCard block={block} />}
      </For>
    </div>
  );
}
```

---

## 2. MDX-like Components (:::Component Pattern)

### Syntax

```markdown
:::Kanban
columns:
  - id: todo
    title: To Do
  - id: doing
    title: In Progress
  - id: done
    title: Done
source: filter:: include(type::task)
:::
```

Or inline parameters:

```markdown
:::SystemStatus services="api,db,cache" refresh=30:::
```

### Component Registry

```typescript
// src/lib/components/componentRegistry.ts
export interface MdxComponent {
  name: string;
  render: (props: Record<string, unknown>, children: Block[]) => JSX.Element;
  parseProps: (yaml: string) => Record<string, unknown>;
  defaultProps?: Record<string, unknown>;
}

class ComponentRegistry {
  private components: Map<string, MdxComponent> = new Map();

  register(component: MdxComponent): void {
    this.components.set(component.name.toLowerCase(), component);
  }

  get(name: string): MdxComponent | undefined {
    return this.components.get(name.toLowerCase());
  }

  has(name: string): boolean {
    return this.components.has(name.toLowerCase());
  }
}

export const componentRegistry = new ComponentRegistry();
```

### Block Type Detection

```typescript
// Extend inlineParser.ts or create componentParser.ts
export function parseComponentBlock(content: string): ComponentBlock | null {
  // Match :::ComponentName ... :::
  const match = content.match(/^:::(\w+)\s*([\s\S]*?):::$/);
  if (!match) return null;

  const [, name, body] = match;

  // Check if component is registered
  if (!componentRegistry.has(name)) {
    return null;
  }

  // Parse YAML props from body
  const component = componentRegistry.get(name)!;
  const props = component.parseProps(body);

  return {
    type: 'component',
    name,
    props,
    raw: content,
  };
}
```

### Built-in Components

#### Kanban Component

```typescript
// src/lib/components/builtins/Kanban.tsx
import { componentRegistry } from '../componentRegistry';
import { parseFilterQuery, matchesQuery } from '../../filterParser';

interface KanbanColumn {
  id: string;
  title: string;
  filter?: string;  // Additional filter for this column
}

interface KanbanProps {
  columns: KanbanColumn[];
  source: string;  // Base filter query
  cardField?: string;  // Field to display as card title (default: content)
}

componentRegistry.register({
  name: 'Kanban',

  parseProps: (yaml: string): KanbanProps => {
    // Parse YAML into props
    const parsed = parseYaml(yaml);
    return {
      columns: parsed.columns || [],
      source: parsed.source || 'filter:: include(*)',
      cardField: parsed.cardField || 'content',
    };
  },

  render: (props: KanbanProps, children: Block[]) => {
    const baseQuery = parseFilterQuery(props.source);

    // Get blocks matching base query
    const store = useBlockStore();
    const baseBlocks = () => {
      const all = Object.values(store.blocks);
      return all.filter(b => matchesQuery(b, baseQuery));
    };

    // Group by column (using metadata.status or marker)
    const columnBlocks = (columnId: string) => {
      return baseBlocks().filter(block => {
        // Check metadata.status or status:: marker
        const status = block.metadata?.status ||
          extractMarkerValue(block.content, 'status');
        return status === columnId;
      });
    };

    return (
      <div class="kanban-board">
        <For each={props.columns}>
          {(column) => (
            <div class="kanban-column">
              <div class="kanban-column-header">{column.title}</div>
              <div class="kanban-column-cards">
                <For each={columnBlocks(column.id)}>
                  {(block) => (
                    <KanbanCard
                      block={block}
                      displayField={props.cardField}
                    />
                  )}
                </For>
              </div>
            </div>
          )}
        </For>
      </div>
    );
  },
});
```

#### SystemStatus Component

```typescript
// src/lib/components/builtins/SystemStatus.tsx
componentRegistry.register({
  name: 'SystemStatus',

  parseProps: (yaml: string) => ({
    services: yaml.match(/services="([^"]+)"/)?.[1]?.split(',') || [],
    refresh: parseInt(yaml.match(/refresh=(\d+)/)?.[1] || '30', 10),
  }),

  render: (props: { services: string[]; refresh: number }) => {
    const [statuses, setStatuses] = createSignal<Record<string, 'up' | 'down' | 'unknown'>>({});

    // Poll service health
    createEffect(() => {
      const checkHealth = async () => {
        const results: Record<string, 'up' | 'down' | 'unknown'> = {};
        for (const service of props.services) {
          try {
            // This would call a Tauri command or health endpoint
            const status = await invoke('check_service_health', { service });
            results[service] = status ? 'up' : 'down';
          } catch {
            results[service] = 'unknown';
          }
        }
        setStatuses(results);
      };

      checkHealth();
      const interval = setInterval(checkHealth, props.refresh * 1000);
      onCleanup(() => clearInterval(interval));
    });

    return (
      <div class="system-status">
        <For each={props.services}>
          {(service) => (
            <div class={`status-item status-${statuses()[service] || 'unknown'}`}>
              <span class="status-indicator" />
              {service}
            </div>
          )}
        </For>
      </div>
    );
  },
});
```

### Hook for Component Blocks

```typescript
// src/lib/handlers/hooks/componentRenderHook.ts
hookRegistry.register({
  id: 'component-block-detection',
  event: 'block:create',
  filter: (block) => block.content.startsWith(':::'),
  priority: 10,

  handler: (ctx) => {
    const parsed = parseComponentBlock(ctx.content);
    if (!parsed) return {};

    // Store component metadata for renderer
    return {
      context: {
        componentType: parsed.name,
        componentProps: parsed.props,
      },
    };
  },
});
```

### BlockDisplay Integration

```typescript
// In BlockDisplay.tsx, add component rendering path
<Show when={block.metadata?.componentType}>
  {(componentType) => {
    const Component = componentRegistry.get(componentType());
    return Component ? (
      <Component.render
        {...block.metadata?.componentProps}
        children={getChildren(block.id)}
      />
    ) : (
      <div class="component-error">Unknown component: {componentType()}</div>
    );
  }}
</Show>
```

---

## 3. Routing Rules (Marker Dispatch Pattern)

### Concept

Routing rules define how markers are processed - which handlers run, with what priority, and under what conditions.

```typescript
// src/lib/routing/routingTypes.ts
export interface RoutingRule {
  id: string;
  name: string;
  priority: number;  // Lower = earlier (like hooks)

  conditions: {
    match: 'any' | 'all' | 'none';
    rules: ConditionRule[];
  };

  actions: RoutingAction[];

  enabled: boolean;
}

export interface ConditionRule {
  type: 'marker' | 'metadata' | 'content' | 'origin';
  field: string;
  operator: 'eq' | 'neq' | 'contains' | 'startsWith' | 'regex' | 'exists';
  value?: string;
}

export interface RoutingAction {
  type: 'handler' | 'transform' | 'metadata' | 'emit' | 'log';
  handler?: string;        // Handler ID to invoke
  transform?: string;      // Content transformation
  metadata?: Record<string, unknown>;  // Metadata to set
  event?: string;          // Event to emit
}
```

### Example Rules

```typescript
// Example routing rules (would be stored in config or Y.Doc)
const defaultRules: RoutingRule[] = [
  {
    id: 'ctx-to-evna',
    name: 'Sync ctx:: markers to EVNA',
    priority: 50,
    conditions: {
      match: 'all',
      rules: [
        { type: 'marker', field: 'ctx', operator: 'exists' },
        { type: 'origin', field: 'origin', operator: 'eq', value: 'user' },
      ],
    },
    actions: [
      { type: 'emit', event: 'evna:context:capture' },
      { type: 'metadata', metadata: { synced: true, syncedAt: '{{now}}' } },
    ],
    enabled: true,
  },

  {
    id: 'dispatch-ai',
    name: 'Route dispatch:: to AI handler',
    priority: 10,
    conditions: {
      match: 'any',
      rules: [
        { type: 'marker', field: 'dispatch', operator: 'exists' },
        { type: 'content', field: '*', operator: 'startsWith', value: '::dispatch' },
      ],
    },
    actions: [
      { type: 'handler', handler: 'ai' },
      { type: 'metadata', metadata: { handlerType: 'ai', dispatchedAt: '{{now}}' } },
    ],
    enabled: true,
  },

  {
    id: 'sh-exec-children',
    name: 'sh:: output goes to children',
    priority: 20,
    conditions: {
      match: 'all',
      rules: [
        { type: 'marker', field: 'sh', operator: 'exists' },
      ],
    },
    actions: [
      { type: 'handler', handler: 'shell' },
      { type: 'metadata', metadata: { outputMode: 'children' } },
    ],
    enabled: true,
  },
];
```

### Routing Engine

```typescript
// src/lib/routing/routingEngine.ts
import { blockEventBus, EventFilters } from '../events';

class RoutingEngine {
  private rules: RoutingRule[] = [];

  constructor() {
    // Subscribe to block events
    blockEventBus.subscribe(
      (envelope) => {
        for (const event of envelope.events) {
          this.processBlock(event.block, event.type);
        }
      },
      {
        filter: EventFilters.any(
          EventFilters.creates(),
          EventFilters.updates()
        ),
        name: 'routing-engine',
      }
    );
  }

  loadRules(rules: RoutingRule[]): void {
    this.rules = rules
      .filter(r => r.enabled)
      .sort((a, b) => a.priority - b.priority);
  }

  processBlock(block: Block, eventType: string): void {
    for (const rule of this.rules) {
      if (this.matchesConditions(block, rule.conditions)) {
        this.executeActions(block, rule.actions);
        // Note: Don't break - multiple rules can match
      }
    }
  }

  private matchesConditions(
    block: Block,
    conditions: RoutingRule['conditions']
  ): boolean {
    const results = conditions.rules.map(rule =>
      this.evaluateCondition(block, rule)
    );

    switch (conditions.match) {
      case 'all': return results.every(r => r);
      case 'any': return results.some(r => r);
      case 'none': return results.every(r => !r);
    }
  }

  private evaluateCondition(block: Block, rule: ConditionRule): boolean {
    let value: string | undefined;

    switch (rule.type) {
      case 'marker':
        value = extractMarkerValue(block.content, rule.field);
        break;
      case 'metadata':
        value = String(block.metadata?.[rule.field] ?? '');
        break;
      case 'content':
        value = block.content;
        break;
      case 'origin':
        value = block.metadata?.origin;
        break;
    }

    switch (rule.operator) {
      case 'exists': return value !== undefined && value !== '';
      case 'eq': return value === rule.value;
      case 'neq': return value !== rule.value;
      case 'contains': return value?.includes(rule.value ?? '') ?? false;
      case 'startsWith': return value?.startsWith(rule.value ?? '') ?? false;
      case 'regex': return new RegExp(rule.value ?? '').test(value ?? '');
    }
  }

  private executeActions(block: Block, actions: RoutingAction[]): void {
    for (const action of actions) {
      switch (action.type) {
        case 'handler':
          // Invoke handler via executor
          executeHandler(block.id, action.handler!);
          break;

        case 'metadata':
          // Update block metadata
          const resolved = resolveTemplates(action.metadata!);
          updateBlockMetadata(block.id, resolved);
          break;

        case 'emit':
          // Emit custom event
          blockEventBus.emit({
            type: action.event as any,
            blockId: block.id,
            block,
          });
          break;

        case 'log':
          console.log(`[Routing] ${action.handler}:`, block.id);
          break;
      }
    }
  }
}

export const routingEngine = new RoutingEngine();
```

### Hook Integration

Routing rules can also be implemented as hooks for tighter integration:

```typescript
// src/lib/routing/routingHooks.ts
// Convert routing rules to hooks at registration time

export function registerRoutingRuleAsHook(rule: RoutingRule): void {
  hookRegistry.register({
    id: `routing-${rule.id}`,
    event: ['block:create', 'block:update'],
    priority: rule.priority,

    filter: (block) => {
      // Use routing engine's condition matching
      return routingEngine.matchesConditions(block, rule.conditions);
    },

    handler: (ctx) => {
      // Execute actions as hook results
      const contextUpdates: Record<string, unknown> = {};

      for (const action of rule.actions) {
        if (action.type === 'metadata') {
          Object.assign(contextUpdates, action.metadata);
        }
        if (action.type === 'handler') {
          contextUpdates.targetHandler = action.handler;
        }
      }

      return { context: contextUpdates };
    },
  });
}
```

---

## 4. Unified Context Stream

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Unified Context Stream                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐             │
│  │ EVNA MCP    │  │ Claude Code │  │ Outline     │             │
│  │ (Supabase)  │  │ (JSONL)     │  │ (Y.Doc)     │             │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘             │
│         │                │                │                     │
│         ▼                ▼                ▼                     │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Context Event Normalizer                       ││
│  │  - Normalize to common ContextEntry format                  ││
│  │  - Add source tag (evna, claude_code, outline)              ││
│  │  - Generate content hash for deduplication                  ││
│  └─────────────────────────────────────────────────────────────┘│
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              Deduplication Layer                            ││
│  │  - Content hash comparison                                  ││
│  │  - Time window collapse (30s)                               ││
│  │  - Source priority (outline > claude_code > evna)           ││
│  └─────────────────────────────────────────────────────────────┘│
│                           │                                     │
│                           ▼                                     │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              EventBus Emission                              ││
│  │  type: 'context:unified'                                    ││
│  │  envelope: { entries, source, dedupedCount }                ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Types

```typescript
// src/lib/context/contextTypes.ts
export interface ContextEntry {
  id: string;
  source: 'evna' | 'claude_code' | 'outline';
  sourceId: string;  // Original ID from source system

  // Content
  raw: string;
  parsed?: ParsedCtx;  // Same structure as ContextSidebar

  // Metadata
  timestamp: string;
  project?: string;
  mode?: string;
  cwd?: string;
  gitBranch?: string;

  // Deduplication
  contentHash: string;
  dedupeKey: string;  // Hash of normalized content for matching
}

export interface UnifiedContextEvent {
  type: 'context:unified';
  entries: ContextEntry[];
  source: 'evna' | 'claude_code' | 'outline' | 'merged';
  dedupedCount: number;
  timestamp: string;
}
```

### Context Stream Service

```typescript
// src/lib/context/unifiedContextStream.ts
import { blockEventBus, EventFilters } from '../events';
import type { ContextEntry, UnifiedContextEvent } from './contextTypes';

class UnifiedContextStream {
  private entries: Map<string, ContextEntry> = new Map();
  private dedupeWindow: Map<string, ContextEntry> = new Map();
  private readonly DEDUPE_WINDOW_MS = 30000;  // 30 seconds

  constructor() {
    this.subscribeToSources();
  }

  private subscribeToSources(): void {
    // 1. Subscribe to outline ctx:: blocks via EventBus
    blockEventBus.subscribe(
      (envelope) => {
        for (const event of envelope.events) {
          if (event.block?.content.includes('ctx::')) {
            const entry = this.normalizeOutlineEntry(event.block);
            this.addEntry(entry);
          }
        }
      },
      {
        filter: EventFilters.contentPrefix('ctx::'),
        name: 'context-stream-outline',
      }
    );

    // 2. Subscribe to EVNA MCP active context
    // This would use the MCP client to poll or subscribe
    this.subscribeToEvna();

    // 3. Subscribe to Claude Code watcher (existing CtxWatcher)
    // Bridge from Rust events to this stream
    this.subscribeToClaudeCode();
  }

  private async subscribeToEvna(): Promise<void> {
    // Poll EVNA active context every 30s
    // Or use WebSocket subscription if available
    const pollEvna = async () => {
      try {
        // Use EVNA MCP tool
        const result = await mcp__evna_remote__active_context({
          query: 'recent context',
          limit: 20,
          synthesize: false,
        });

        if (result.entries) {
          for (const entry of result.entries) {
            const normalized = this.normalizeEvnaEntry(entry);
            this.addEntry(normalized);
          }
        }
      } catch (e) {
        console.warn('[ContextStream] EVNA poll failed:', e);
      }
    };

    // Initial poll, then every 30s
    pollEvna();
    setInterval(pollEvna, 30000);
  }

  private subscribeToClaudeCode(): void {
    // Listen to Tauri events from CtxWatcher
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      listen('ctx-marker-added', (event: { payload: CtxMarker }) => {
        const entry = this.normalizeClaudeCodeEntry(event.payload);
        this.addEntry(entry);
      });
    }
  }

  private addEntry(entry: ContextEntry): void {
    // Check dedupe window
    const existing = this.dedupeWindow.get(entry.dedupeKey);
    if (existing) {
      // Prefer outline > claude_code > evna
      const priority = { outline: 3, claude_code: 2, evna: 1 };
      if (priority[entry.source] <= priority[existing.source]) {
        return;  // Skip lower priority duplicate
      }
    }

    // Add to dedupe window
    this.dedupeWindow.set(entry.dedupeKey, entry);
    setTimeout(() => {
      this.dedupeWindow.delete(entry.dedupeKey);
    }, this.DEDUPE_WINDOW_MS);

    // Add to main entries
    this.entries.set(entry.id, entry);

    // Emit unified event
    blockEventBus.emit({
      type: 'context:unified' as any,
      entries: [entry],
      source: entry.source,
      dedupedCount: 0,
      timestamp: new Date().toISOString(),
    });
  }

  private normalizeOutlineEntry(block: Block): ContextEntry {
    const content = block.content.replace(/^ctx::\s*/, '');
    return {
      id: `outline-${block.id}`,
      source: 'outline',
      sourceId: block.id,
      raw: block.content,
      parsed: parseCtxContent(content),
      timestamp: block.metadata?.createdAt || new Date().toISOString(),
      project: extractMarkerValue(content, 'project'),
      mode: extractMarkerValue(content, 'mode'),
      contentHash: hashContent(content),
      dedupeKey: hashContent(normalizeForDedupe(content)),
    };
  }

  private normalizeEvnaEntry(entry: unknown): ContextEntry {
    // Map EVNA active_context entry to ContextEntry
    // Implementation depends on EVNA response format
    return {
      id: `evna-${entry.id}`,
      source: 'evna',
      sourceId: entry.id,
      raw: entry.message || entry.content,
      timestamp: entry.timestamp,
      project: entry.project,
      contentHash: hashContent(entry.message),
      dedupeKey: hashContent(normalizeForDedupe(entry.message)),
    };
  }

  private normalizeClaudeCodeEntry(marker: CtxMarker): ContextEntry {
    return {
      id: `claude-${marker.id}`,
      source: 'claude_code',
      sourceId: marker.id,
      raw: marker.raw_line,
      parsed: marker.parsed,
      timestamp: marker.created_at,
      cwd: marker.cwd,
      gitBranch: marker.git_branch,
      contentHash: hashContent(marker.raw_line),
      dedupeKey: hashContent(normalizeForDedupe(marker.raw_line)),
    };
  }

  getEntries(limit = 50): ContextEntry[] {
    return Array.from(this.entries.values())
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);
  }
}

// Normalize content for deduplication comparison
function normalizeForDedupe(content: string): string {
  return content
    .replace(/\d{4}-\d{2}-\d{2}/g, 'DATE')  // Normalize dates
    .replace(/\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?/gi, 'TIME')  // Normalize times
    .replace(/\s+/g, ' ')  // Normalize whitespace
    .toLowerCase()
    .trim();
}

function hashContent(content: string): string {
  // Simple hash for deduplication
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

export const unifiedContextStream = new UnifiedContextStream();
```

### Updated ContextSidebar

```typescript
// src/components/ContextSidebar.tsx (updated)
import { unifiedContextStream } from '../lib/context/unifiedContextStream';
import { blockEventBus } from '../lib/events';

export function ContextSidebar(props: { visible: boolean }) {
  const [entries, setEntries] = createSignal<ContextEntry[]>([]);

  createEffect(() => {
    if (!props.visible) return;

    // Load initial entries
    setEntries(unifiedContextStream.getEntries());

    // Subscribe to new entries
    const unsubscribe = blockEventBus.subscribe(
      (envelope) => {
        // Refresh from stream (already deduplicated)
        setEntries(unifiedContextStream.getEntries());
      },
      {
        filter: (event) => event.type === 'context:unified',
        name: 'context-sidebar',
      }
    );

    onCleanup(unsubscribe);
  });

  return (
    <aside class="ctx-sidebar">
      <div class="ctx-sidebar-header">
        Context Stream ({entries().length})
        <div class="ctx-source-legend">
          <span class="source-outline">outline</span>
          <span class="source-claude">claude</span>
          <span class="source-evna">evna</span>
        </div>
      </div>
      <div class="ctx-markers-list">
        <For each={entries()}>
          {(entry) => <UnifiedContextCard entry={entry} />}
        </For>
      </div>
    </aside>
  );
}
```

---

## Integration Summary

### How Patterns Connect

```
User types ctx:: in outliner
        │
        ▼
Y.Doc observer fires (useBlockStore.ts:250-374)
        │
        ├──► EventBus.emit('block:create', { content: 'ctx::...' })
        │         │
        │         ├──► RoutingEngine matches ctx:: rules
        │         │         │
        │         │         └──► Actions: emit('evna:capture'), set metadata
        │         │
        │         └──► UnifiedContextStream.addEntry()
        │                   │
        │                   └──► Dedupe, emit('context:unified')
        │
        └──► ProjectionScheduler (async)
                  │
                  └──► Search indexer batches ctx:: for Tantivy


User types filter:: in outliner
        │
        ▼
Block execution triggered
        │
        ├──► hookRegistry.run('execute:before')
        │         │
        │         └──► filterQueryHook matches filter::
        │                   │
        │                   └──► Returns { context: { queryResults: [...] } }
        │
        └──► FilterBlockDisplay renders query results
                  │
                  └──► Subscribes to EventBus for live updates


User types :::Kanban in outliner
        │
        ▼
Block created/updated
        │
        ├──► hookRegistry.run('block:create')
        │         │
        │         └──► componentRenderHook parses :::Kanban
        │                   │
        │                   └──► Stores componentType in metadata
        │
        └──► BlockDisplay detects componentType
                  │
                  └──► componentRegistry.get('kanban').render()
                            │
                            └──► Kanban internally uses filter:: query
```

### File Structure (New)

```
src/lib/
├── filterParser.ts              # Filter syntax parsing
├── routing/
│   ├── routingTypes.ts          # Routing rule types
│   ├── routingEngine.ts         # Rule matching and execution
│   └── routingHooks.ts          # Hook adapter for rules
├── components/
│   ├── componentRegistry.ts     # MDX component registry
│   ├── componentParser.ts       # :::Component syntax parser
│   └── builtins/
│       ├── Kanban.tsx
│       ├── SystemStatus.tsx
│       └── index.ts
├── context/
│   ├── contextTypes.ts          # Unified context types
│   └── unifiedContextStream.ts  # Multi-source aggregation
└── handlers/hooks/
    ├── filterQueryHook.ts       # Filter block execution
    └── componentRenderHook.ts   # Component detection
```

---

## Implementation Priority

| Phase | Feature | Effort | Dependencies |
|-------|---------|--------|--------------|
| **1** | Filter blocks (basic) | Medium | filterParser.ts, hook |
| **2** | Unified context stream | Medium | EVNA MCP, Tauri bridge |
| **3** | :::Component registry | Medium | componentRegistry, parser |
| **4** | Routing rules | Medium | routingEngine, hook adapter |
| **5** | Built-in components | Low | Per-component effort |

Each phase builds on floatty's existing EventBus/Hook infrastructure without creating parallel systems.
