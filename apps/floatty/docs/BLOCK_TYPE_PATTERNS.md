# Block Type Patterns

How to add new `prefix::` block types to floatty.

## Two Patterns

### Pattern A: Type-Based Rendering

The block type changes based on content prefix. Special rendering happens inline.

**Use when**: Display-only styling (headings, quotes, bullets)

**Example**: `# Heading` → type `h1` → styled differently

**Files touched**:
- `src/lib/blockTypes.ts` - Add to `parseBlockType()`
- `src/components/BlockItem.tsx` - Add rendering case

**Trade-off**: Type changes cause `<Show>` to remount contentEditable → focus loss if user is typing. Only use for prefixes that are "set once" (headings, bullets), not typed mid-edit.

### Pattern B: Child-Output Blocks (Recommended for Executors)

Parent block stays `text` type. Output spawns as child block(s).

**Use when**: Executable blocks with async output (sh::, ai::, daily::)

**Example**: `sh:: ls -la` → stays type `text` → child block with `output::` content

**Files touched**:
- `src/lib/executor.ts` - Add handler to `handlers` array, OR
- `src/lib/[name]Executor.ts` - Create dedicated executor
- `src/components/BlockItem.tsx` - Wire up Enter key to execute

**Why this pattern**:
1. No type mutation → no contentEditable remount → no focus loss
2. Output is collapsible (collapse parent = hide output)
3. Re-running can replace or append children
4. Consistent with sh::/ai:: mental model

## Adding a New Executor (Pattern B)

### Step 1: Detection

```typescript
// In your executor file
const PREFIX = 'mytype::';

export function isMyTypeBlock(content: string): boolean {
  return content.trim().toLowerCase().startsWith(PREFIX);
}

export function extractArg(content: string): string {
  const trimmed = content.trim();
  const prefixEnd = trimmed.toLowerCase().indexOf(PREFIX) + PREFIX.length;
  return trimmed.slice(prefixEnd).trim();
}
```

### Step 2: Execution

```typescript
export interface MyTypeActions {
  createBlockInside: (parentId: string) => string;
  updateBlockContent: (id: string, content: string) => void;
  setBlockOutput: (id: string, output: unknown, outputType: string) => void;
  setBlockStatus: (id: string, status: 'running' | 'complete' | 'error') => void;
  deleteBlock?: (id: string) => void;  // For replacing output
}

export async function executeMyTypeBlock(
  blockId: string,
  content: string,
  actions: MyTypeActions
): Promise<void> {
  const arg = extractArg(content);

  // Create output child
  const outputId = actions.createBlockInside(blockId);
  actions.updateBlockContent(outputId, 'output::Loading...');
  actions.setBlockStatus(outputId, 'running');

  try {
    const result = await doTheWork(arg);

    // Option A: Simple text output
    actions.updateBlockContent(outputId, `output::${result}`);

    // Option B: Structured output for custom view
    actions.setBlockOutput(outputId, result, 'mytype-view');
    actions.setBlockStatus(outputId, 'complete');
  } catch (err) {
    actions.updateBlockContent(outputId, `error::${err}`);
    actions.setBlockStatus(outputId, 'error');
  }
}
```

### Step 3: Wire Up in BlockItem

```typescript
// In handleKeyDown, inside Enter handling:
if (isMyTypeBlock(content)) {
  e.preventDefault();
  executeMyTypeBlock(props.id, content, {
    createBlockInside: store.createBlockInside,
    updateBlockContent: store.updateContent,
    setBlockOutput: store.setBlockOutput,
    setBlockStatus: store.setBlockStatus,
    deleteBlock: store.deleteBlock,
  });
  return;
}
```

### Step 4: Custom View (Optional)

If your output needs special rendering beyond `output::` text:

```typescript
// In BlockItem.tsx, in the children area:
<Show when={block()?.outputType === 'mytype-view'}>
  <MyTypeView data={block()!.output as MyTypeData} />
</Show>
```

## Pattern B Variant: Auto-Execute on Appear

For **idempotent, display-only** blocks, skip the Enter key entirely. Execute when the content pattern is complete.

**Use when**: Block just fetches/renders data, no side effects

**Example**: `daily::today` → auto-executes when argument is present

**Implementation** (in BlockItem.tsx):

```typescript
createEffect(() => {
  const currentBlock = block();
  if (!currentBlock) return;

  // Only auto-execute matching blocks with an argument
  if (!isMyTypeBlock(currentBlock.content)) return;

  const arg = extractArg(currentBlock.content);
  if (!arg) return;  // Still typing

  // Check for existing output (prevents re-execution loop)
  const hasOutput = currentBlock.childIds.some((id) => {
    const child = store.blocks[id];
    return child?.outputType === 'mytype-view';
  });
  if (hasOutput) return;

  executeMyTypeBlock(props.id, currentBlock.content, actions);
});
```

**When to use**:
- `daily::` - just displays daily note data
- `web::` / `embed::` - just renders iframe
- `query::` - just fetches and displays results

**When NOT to use** (keep Enter-to-execute):
- `sh::` - runs shell commands (side effects!)
- `ai::` - expensive API calls
- `dispatch::` - triggers agent actions

## Decision Tree

```text
Is this prefix typed once and left alone?
├─ Yes → Pattern A (type-based)
│        Examples: # heading, > quote, - bullet
│
└─ No, user might type it mid-edit OR it has async output
   │
   └─ Pattern B (child-output)
      │
      ├─ Is it idempotent (safe to run automatically)?
      │  └─ Yes → Auto-execute on appear
      │           Examples: daily::, web::, query::
      │
      └─ Has side effects or expensive?
         └─ No → Require Enter to execute
                 Examples: sh::, ai::, dispatch::
```

## Focus Loss Gotcha

If you use Pattern A for something users type mid-edit:

```text
User types: "daily::"
→ parseBlockType() returns 'daily'
→ block.type changes from 'text' to 'daily'
→ <Show when={type === 'daily'}> mounts
→ <Show when={type !== 'daily'}> unmounts
→ contentEditable is destroyed and recreated
→ Focus is lost
→ User has to click back in
```

Pattern B avoids this entirely - the parent block never changes type.
