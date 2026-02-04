# MDX-lite: Component Blocks via Outline Hierarchy

A pattern where blocks with recognized prefixes render their children as structured component props, using the outline hierarchy as the container syntax.

## The Insight

Floatty doesn't need `:::` delimiters for multi-block components. **The outline hierarchy IS the container syntax.**

```
kanban:: Sprint Board
  groupBy:: status
  columns:: backlog, doing, review, done
  source:: project::pharmacy
```

Parent block = component type + title
Children = props, config, or content slots

## Why This Works

1. **Each block is still a CRDT atom** — no special multi-block sync
2. **Indent/outdent restructures naturally** — move config in/out of component
3. **Collapse/expand works** — hide component internals
4. **Children are independently editable** — change one prop without touching others

## Pattern Categories

### Config Children (Kanban, Filters)

Children are key-value config parsed by the handler:

```
filter:: Active Pharmacy Work
  include(project::pharmacy)
  include(status::active)
  exclude(archived::true)
```

Handler reads children, interprets as filter rules.

### Content Slots (Grids, Layouts)

Children are content that flows into slots:

```
grid:: 2-col
  ## Left Column
    content here...
  ## Right Column
    other content...
```

Handler renders children into a 2-column layout.

### Hybrid (Cards in Kanban)

Some children are config, some are content:

```
kanban:: Quick Tasks
  columns:: todo, doing, done
  ---
  ## Todo
    - [ ] Fix the thing
  ## Doing
    - [ ] Review PR
```

`---` or similar delimiter separates config from content sections.

## Implementation Approach

### Handler Responsibilities

1. Parse the parent block content for title/inline config
2. Read child blocks as structured props
3. Set `outputType` + `output` with parsed structure
4. View component renders from the structured data

```typescript
export const kanbanHandler: BlockHandler = {
  prefixes: ['kanban::'],

  async execute(blockId, content, actions) {
    const title = content.replace(/^kanban::\s*/, '').trim();
    const block = actions.getBlock(blockId);

    // Parse children as config
    const config = parseChildrenAsConfig(block.childIds, actions);

    // Query blocks matching source filter
    const cards = queryBlocks(config.source, actions);

    actions.setOutput(blockId, {
      outputType: 'kanban-board',
      outputStatus: 'complete',
      output: { title, config, cards },
    });
  },
};
```

### Child Parsing Utility

```typescript
function parseChildrenAsConfig(
  childIds: string[],
  actions: HandlerActions
): Record<string, string> {
  const config: Record<string, string> = {};

  for (const id of childIds) {
    const child = actions.getBlock(id);
    const match = child.content.match(/^(\w+)::\s*(.+)$/);
    if (match) {
      config[match[1]] = match[2];
    }
  }

  return config;
}
```

### View as Picker Pattern

Since kanban cards are draggable/editable, use Picker pattern (not Output):

```typescript
// Kanban needs internal focus for card editing
<div ref={kanbanRef} tabIndex={0} onKeyDown={handleKanbanKeyDown}>
  <For each={columns()}>
    {(col) => (
      <KanbanColumn
        cards={col.cards}
        onCardMove={handleCardMove}
        focusedCardId={focusedCardId()}
      />
    )}
  </For>
</div>
```

## Acceptance Criteria for MDX-lite Feature

1. Handler parses children as config
2. Config changes (edit child) trigger re-render
3. Drag/drop updates card metadata
4. Keyboard nav within board (arrows between cards)
5. `onNavigateOut` at board boundaries
6. Pattern documented for adding new component types

## Future Component Ideas

| Prefix | Children As | Output |
|--------|-------------|--------|
| `kanban::` | columns + source filter | Draggable card board |
| `grid::` | content slots | Multi-column layout |
| `poll::` | options list | Interactive poll |
| `chart::` | data + config | Rendered chart |
| `form::` | field definitions | Input form |
| `timeline::` | events | Visual timeline |

## See Also

- [KEYBOARD_CONTROL_PATTERNS.md](KEYBOARD_CONTROL_PATTERNS.md) - Picker pattern for editable components
- [RICH_OUTPUT_HANDLER_GUIDE.md](RICH_OUTPUT_HANDLER_GUIDE.md) - Handler implementation details
- [FLOATTY_HANDLER_REGISTRY.md](FLOATTY_HANDLER_REGISTRY.md) - Registry internals
