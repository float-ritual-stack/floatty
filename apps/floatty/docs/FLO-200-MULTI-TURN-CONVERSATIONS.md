# FLO-200: Multi-Turn LLM Conversations

> **STATUS: ASPIRATIONAL SPEC — NOT IMPLEMENTED** — Current `ai::` blocks are single-turn only.
> No conversation state tracking, no role system (`user`/`assistant`/`system`), no TTL directives,
> no conversation tree structure. This spec describes planned behavior for a future milestone.

> Transform Floatty's outliner into a native environment for multi-turn LLM conversations where the conversation IS the outline.

---

**Status**: Draft
**Created**: 2026-01-13
**Author**: evan + claude

---

## Executive Summary

Transform Floatty's outliner into a native environment for multi-turn LLM conversations where:
- **The conversation IS the outline** - each message is a block, threads are trees
- **Everything is editable** - revise any message, branch conversations, fork history
- **Context is intelligent** - TTL-based inclusion, section linking, token awareness
- **The system learns** - hooks index conversations for search and retrieval

This is "ChatGPT but the chat IS the document."

---

## 1. Problem Statement

### Current State
- `ai::` blocks execute single-turn prompts via `createCommandDoor()`
- No conversation memory between invocations
- Context is manual (copy-paste or `[[wikilinks]]`)
- Can't edit and re-run with modified history
- Output uses same `ai::` prefix as input (confusing roles)

### Desired State
- Natural multi-turn conversations in outline structure
- Edit any message and re-send from any point
- Intelligent context expansion with TTL management
- Conversations searchable and linkable like any other content
- Clear visual distinction between user and assistant messages

---

## 2. User Stories

### Core Flow
```
As a user, I want to:
1. Type `ai:: Tell me about quantum computing` and press Enter
2. See the assistant's response appear as a child block
3. Type my follow-up question as a child of that response
4. Press Cmd+Enter (or type `/send`) to continue the conversation
5. Have the full history sent to the LLM automatically
```

### Branching
```
As a user, I want to:
1. Navigate to an earlier message in a conversation
2. Type an alternative follow-up
3. Send it to create a branch
4. Have both conversation paths preserved
```

### Context Management
```
As a user, I want to:
1. Reference `[[API Docs/Authentication]]` in my prompt
2. Have just that section expanded (not the whole page)
3. Control how long that context stays in the conversation
4. See what context was actually sent (debug view)
```

---

## 3. Data Model

### 3.1 Role Detection

Roles are inferred from block content and structure:

| Pattern | Role | Notes |
|---------|------|-------|
| `ai:: ...` | user | Conversation root (initiates conversation) |
| `user:: ...` | user | Explicit user message |
| `assistant:: ...` | assistant | LLM response |
| `system:: ...` | system | Injected system prompt |
| No prefix, child of assistant | user | Implicit continuation |
| No prefix, child of user | assistant | (shouldn't happen normally) |

### 3.2 Conversation Structure

```
ai:: Tell me about quantum computing          ← root (user, turn 0)
  - model::sonnet                             ← config (not a message)
  - maxTokens::4096                           ← config
  - context::2 [[Quantum Basics]]             ← context directive
  └─ assistant:: Quantum computing uses...    ← turn 1
      ├─ user:: What about qubits?            ← turn 2, branch A
      │   └─ assistant:: Qubits are...        ← turn 3
      │       └─ user:: How do they decohere? ← turn 4
      │           └─ assistant:: ...          ← turn 5
      └─ user:: Compare to classical          ← turn 2, branch B (fork!)
          └─ assistant:: Classical vs...      ← turn 3
```

### 3.3 Block Metadata (via Hook)

```typescript
interface ConversationMeta {
  conversationId: string;      // Block ID of conversation root
  role: 'user' | 'assistant' | 'system';
  turnNumber: number;          // Distance from root (in message pairs)
  branchId?: string;           // If forked, which branch
}
```

### 3.4 Inline Configuration

Config blocks are children of the conversation root with `::` syntax:

```typescript
interface ConversationConfig {
  model?: string;              // 'sonnet' | 'opus' | 'haiku' | full model name
  maxTokens?: number;          // Default: 4096
  temperature?: number;        // Default: 0.7
  expandDepth?: number;        // Wikilink expansion depth, default: 1
  expandHistory?: boolean;     // Expand links in history too, default: false
  debugMode?: boolean;         // Show debug output, default: false
}
```

Parsed from blocks like:
```markdown
- model::sonnet
- maxTokens::4096
- temperature::0.7
```

---

## 4. Context System

### 4.1 Wikilink Expansion

When building conversation context, expand `[[wikilinks]]`:

| Syntax | Behavior |
|--------|----------|
| `[[Page]]` | Expand full page content |
| `[[Page/Heading]]` | Expand only that section |
| `[[Page/Heading/Subheading]]` | Nested section extraction |

### 4.2 Context TTL (Time-To-Live)

Control how long referenced content stays in context:

```markdown
- context:: [[Always Included]]           # No TTL = permanent
- context::3 [[API Reference]]            # Include for 3 more turns
- context::1 [[Quick Note]]               # Just this turn (ephemeral)
- context::0 [[Changelog]]                # Permanent exclude
```

**TTL Mechanics:**
- TTL decrements each turn (user + assistant = 1 turn)
- When TTL reaches 0, content is no longer expanded
- `context::0` creates a permanent skip (never expand)
- TTL state persists for the conversation lifetime

### 4.3 Section Extraction Algorithm

```typescript
function extractSection(content: string, heading: string): string | null {
  const lines = content.split('\n');
  let capturing = false;
  let captureLevel = 0;
  const result: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();

      if (!capturing) {
        // Looking for our heading
        if (title.toLowerCase() === heading.toLowerCase()) {
          capturing = true;
          captureLevel = level;
          result.push(line);
        }
      } else {
        // Check if we've hit a same-or-higher level heading
        if (level <= captureLevel) {
          break; // Done capturing
        }
        result.push(line);
      }
    } else if (capturing) {
      result.push(line);
    }
  }

  return capturing ? result.join('\n') : null;
}
```

### 4.4 Context Expansion Order

When building the messages array:

1. **Parse TTL directives** from conversation root
2. **Update TTL state** (decrement existing, add new)
3. **For each message:**
   - Extract `[[wikilinks]]` from content
   - Filter by TTL (skip if expired or excluded)
   - Resolve page/section content
   - Recursively expand nested links (up to `expandDepth`)
   - Inject as context blocks

### 4.5 Context Injection Format

Structured for the LLM:
```typescript
{
  role: 'user',
  content: `[Context from [[API Reference/Authentication]]:
${extractedContent}
---
${userMessage}`
}
```

---

## 5. Commands & Triggers

### 5.1 Command Reference

| Command | Trigger | Action |
|---------|---------|--------|
| Send | `Cmd+Enter` or `/send` | Build context, send to LLM, create response block |
| Retry | `/retry` | Re-send same context, replace last response |
| Fork | `/fork` | Create new branch from current point |
| Debug | `/debug` | Show what would be sent (dry run) |
| Clear | `/clear` | Start fresh conversation (new root) |
| Model | `/model sonnet` | Change model for this conversation |

### 5.2 Keyboard Shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| `Cmd+Enter` | In ai:: tree | Send/continue conversation |
| `Cmd+Shift+Enter` | In ai:: tree | Send and keep focus on current block |
| `Cmd+R` | After assistant:: | Retry (regenerate response) |
| `Opt+Enter` | In ai:: tree | Fork conversation |

### 5.3 Slash Command Parsing

```typescript
function parseSlashCommand(content: string): SlashCommand | null {
  const match = content.match(/^\/(\w+)(?:\s+(.*))?$/);
  if (!match) return null;

  return {
    command: match[1].toLowerCase(),
    args: match[2]?.trim() || null
  };
}
```

---

## 6. Execution Flow

### 6.1 `/send` Flow

```
┌─────────────────────────────────────────────────────────────┐
│ User types message, presses Cmd+Enter                       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. Find conversation root (walk up to ai:: block)          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Parse config from root's children (model::, etc.)       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Parse TTL directives, update TTL state                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Walk path from root to current block                     │
│    - Collect messages in order                              │
│    - Infer role for each block                              │
│    - Expand wikilinks (respecting TTL)                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. Create response block (child of current)                 │
│    - Content: "assistant:: ..."                             │
│    - Status: 'running'                                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 6. Send to LLM (Ollama or configured backend)              │
│    - System prompt (default or from system:: block)         │
│    - Messages array                                         │
│    - Model + params from config                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 7. Stream response into response block                      │
│    - Update content progressively                           │
│    - Set status: 'complete' when done                       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ 8. Create empty user block for next turn                    │
│    - Focus moves to new block                               │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Building Messages Array

```typescript
interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  blockId: string;  // For debugging/reference
}

function buildConversation(
  currentBlockId: string,
  getBlock: (id: string) => Block | undefined,
  getParentId: (id: string) => string | undefined,
  config: ConversationConfig,
  ttlState: TTLManager
): ConversationMessage[] {

  // 1. Find root
  const root = findConversationRoot(currentBlockId, getBlock, getParentId);
  if (!root) throw new Error('Not in a conversation');

  // 2. Get path from root to current
  const path = getPathToBlock(root.id, currentBlockId, getBlock);

  // 3. Convert to messages
  const messages: ConversationMessage[] = [];
  let parentRole: string | undefined;

  for (const blockId of path) {
    const block = getBlock(blockId);
    if (!block) continue;

    // Skip config blocks
    if (isConfigBlock(block.content)) continue;

    // Skip TTL directive blocks
    if (isContextDirective(block.content)) continue;

    const role = inferRole(block.content, parentRole);
    let content = stripRolePrefix(block.content);

    // Expand wikilinks
    content = expandWikilinks(content, config, ttlState);

    messages.push({ role, content, blockId });
    parentRole = role;
  }

  return messages;
}
```

### 6.3 Role Inference Logic

```typescript
const ROLE_PREFIXES = {
  'ai::': 'user',        // Conversation root
  'user::': 'user',      // Explicit user
  'assistant::': 'assistant',
  'system::': 'system',
};

function inferRole(
  content: string,
  previousRole?: string
): 'user' | 'assistant' | 'system' {
  const trimmed = content.trim().toLowerCase();

  // Check explicit prefixes
  for (const [prefix, role] of Object.entries(ROLE_PREFIXES)) {
    if (trimmed.startsWith(prefix)) {
      return role as 'user' | 'assistant' | 'system';
    }
  }

  // Infer from structure: alternate roles
  if (previousRole === 'assistant') return 'user';
  if (previousRole === 'user') return 'assistant';

  // Default to user
  return 'user';
}
```

---

## 7. Handler Implementation

### 7.1 Conversation Handler (New)

This replaces the simple `aiHandler` from `commandDoor.ts`:

```typescript
// src/lib/handlers/conversation.ts

import type { BlockHandler, ExecutorActions } from './types';
import { invoke } from '@tauri-apps/api/core';

interface ConversationActions extends ExecutorActions {
  getParentId: (id: string) => string | undefined;
  getChildren: (id: string) => string[];
}

export const conversationHandler: BlockHandler = {
  prefixes: ['ai::', 'chat::'],

  async execute(
    blockId: string,
    content: string,
    actions: ExecutorActions
  ): Promise<void> {
    // Cast to get conversation-specific actions
    const convActions = actions as ConversationActions;

    // 1. Find conversation root
    const rootId = findConversationRoot(blockId, convActions);
    if (!rootId) {
      // This is the root block - execute as single turn (legacy behavior)
      return executeSingleTurn(blockId, content, actions);
    }

    // 2. Parse config from root
    const config = parseConversationConfig(rootId, convActions);

    // 3. Initialize/update TTL state
    const ttlState = getTTLState(rootId, convActions);

    // 4. Build messages array
    const messages = buildConversation(
      blockId,
      convActions.getBlock,
      convActions.getParentId,
      config,
      ttlState
    );

    // 5. Create response block
    const responseId = actions.createBlockInside(blockId);
    actions.updateBlockContent(responseId, 'assistant:: Thinking...');
    actions.setBlockStatus?.(responseId, 'running');

    try {
      // 6. Send to backend
      const response = await invoke<string>('execute_ai_conversation', {
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        model: config.model,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        system: getSystemPrompt(rootId, convActions),
      });

      // 7. Update response block
      actions.updateBlockContent(responseId, `assistant:: ${response}`);
      actions.setBlockStatus?.(responseId, 'complete');

      // 8. Create continuation block for next user input
      const nextId = actions.createBlockInside(responseId);
      // Leave empty, user will type here

    } catch (err) {
      actions.updateBlockContent(responseId, `error:: ${String(err)}`);
      actions.setBlockStatus?.(responseId, 'error');
    }
  }
};
```

### 7.2 Helper Functions

```typescript
// src/lib/handlers/conversation/builder.ts

export function findConversationRoot(
  blockId: string,
  actions: ConversationActions
): string | undefined {
  let currentId: string | undefined = blockId;

  while (currentId) {
    const block = actions.getBlock?.(currentId) as Block | undefined;
    if (!block) break;

    const content = block.content.trim().toLowerCase();
    if (content.startsWith('ai::') || content.startsWith('chat::')) {
      return currentId;
    }

    currentId = actions.getParentId(currentId);
  }

  return undefined;
}

export function getPathToBlock(
  rootId: string,
  targetId: string,
  getBlock: (id: string) => Block | undefined
): string[] {
  // BFS or DFS to find path from root to target
  // Returns array of block IDs in order from root to target
  // ... implementation
}

export function parseConversationConfig(
  rootId: string,
  actions: ConversationActions
): ConversationConfig {
  const children = actions.getChildren(rootId);
  const config: ConversationConfig = {};

  for (const childId of children) {
    const block = actions.getBlock?.(childId) as Block | undefined;
    if (!block) continue;

    const content = block.content.trim();

    // Parse config:: prefixed blocks
    const modelMatch = content.match(/^model::(.+)$/i);
    if (modelMatch) config.model = modelMatch[1].trim();

    const tokensMatch = content.match(/^maxTokens::(\d+)$/i);
    if (tokensMatch) config.maxTokens = parseInt(tokensMatch[1]);

    const tempMatch = content.match(/^temperature::([\d.]+)$/i);
    if (tempMatch) config.temperature = parseFloat(tempMatch[1]);

    // ... other config patterns
  }

  return config;
}
```

### 7.3 TTL Manager

```typescript
// src/lib/handlers/conversation/ttl.ts

export class TTLManager {
  private state: Map<string, TTLEntry> = new Map();

  constructor(private rootId: string) {}

  addReference(pageKey: string, ttl: number | 'never' | 'excluded') {
    this.state.set(pageKey, {
      expiresAtTurn: ttl === 'never' ? Infinity :
                    ttl === 'excluded' ? -1 :
                    this.currentTurn + ttl,
    });
  }

  isIncluded(pageKey: string): boolean {
    const entry = this.state.get(pageKey);
    if (!entry) return true; // Not tracked = include
    if (entry.expiresAtTurn === -1) return false; // Excluded
    return entry.expiresAtTurn >= this.currentTurn;
  }

  advanceTurn() {
    this.currentTurn++;
  }

  private currentTurn = 0;
}

interface TTLEntry {
  expiresAtTurn: number; // -1 = excluded, Infinity = never expires
}
```

---

## 8. Backend Implementation

### 8.1 Rust Command: `execute_ai_conversation`

```rust
// src-tauri/src/commands/ai.rs

#[derive(Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct ConversationRequest {
    pub messages: Vec<ChatMessage>,
    pub model: Option<String>,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f32>,
    pub system: Option<String>,
}

#[tauri::command]
pub async fn execute_ai_conversation(
    request: ConversationRequest,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let config = state.config.read().map_err(|e| e.to_string())?;

    let model = request.model
        .unwrap_or_else(|| config.default_model.clone())
        .unwrap_or_else(|| "llama3".to_string());

    let max_tokens = request.max_tokens.unwrap_or(4096);
    let temperature = request.temperature.unwrap_or(0.7);

    let client = reqwest::Client::new();
    let ollama_url = config.ollama_url();

    let mut ollama_messages: Vec<serde_json::Value> = vec![];

    // Add system message if provided
    if let Some(system) = &request.system {
        ollama_messages.push(json!({
            "role": "system",
            "content": system
        }));
    }

    // Add conversation messages
    for msg in &request.messages {
        ollama_messages.push(json!({
            "role": msg.role,
            "content": msg.content
        }));
    }

    let response = client
        .post(&format!("{}/api/chat", ollama_url))
        .json(&json!({
            "model": model,
            "messages": ollama_messages,
            "stream": false,
            "options": {
                "num_predict": max_tokens,
                "temperature": temperature
            }
        }))
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Ollama error {}: {}", status, body));
    }

    let result: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Parse error: {}", e))?;

    let content = result["message"]["content"]
        .as_str()
        .unwrap_or("(no response)")
        .to_string();

    Ok(content)
}
```

### 8.2 Registration

```rust
// src-tauri/src/lib.rs

// Add to generate_handler! or command registration:
.invoke_handler(tauri::generate_handler![
    // ... existing commands
    execute_ai_conversation,
])
```

---

## 9. UI/UX

### 9.1 Visual Distinction

```css
/* Conversation root */
.block[data-conv-role="root"] {
  border-left: 3px solid var(--color-ansi-magenta);
}

/* Assistant messages */
.block[data-conv-role="assistant"] {
  background: var(--bg-muted);
  border-left: 3px solid var(--color-ansi-blue);
}

/* User messages in conversation */
.block[data-conv-role="user"] {
  /* Subtle or no distinction - user is "default" */
}

/* System messages */
.block[data-conv-role="system"] {
  background: var(--bg-warning);
  border-left: 3px solid var(--color-ansi-yellow);
  font-style: italic;
}

/* Config blocks */
.block[data-conv-config="true"] {
  opacity: 0.7;
  font-size: 0.9em;
}

/* Streaming indicator */
.block[data-status="running"]::after {
  content: " ●";
  color: var(--color-ansi-blue);
  animation: pulse 1s infinite;
}
```

### 9.2 Debug View

When `/debug` is triggered:

```
debug:: Conversation Context
  - **Model:** llama3
  - **Max Tokens:** 4,096
  - **Turn:** 4
  - **Messages:** 7
  - **Estimated Tokens:** ~2,847 (69% of max)
  - **Context Expanded:**
    - [[API Reference]] → 1,204 chars (TTL: 2 remaining)
    - [[Quick Note/Setup]] → 340 chars (TTL: 1 remaining)
  - **Context Excluded:**
    - [[Changelog]] (TTL expired)
    - [[Old Docs]] (permanent skip)
```

### 9.3 Token Estimation

```typescript
function estimateTokens(messages: ConversationMessage[]): number {
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  // Rough estimate: ~4 chars per token for English
  return Math.ceil(totalChars / 4);
}

function getTokenWarning(estimated: number, max: number): string | null {
  const ratio = estimated / max;
  if (ratio > 0.9) return 'Near token limit, consider reducing context';
  if (ratio > 0.75) return 'Using 75%+ of token budget';
  return null;
}
```

---

## 10. File Structure

```
src/lib/
├── handlers/
│   ├── conversation.ts          # Main conversation handler
│   ├── conversation/
│   │   ├── builder.ts           # buildConversation, message assembly
│   │   ├── context.ts           # Wikilink expansion, section extraction
│   │   ├── ttl.ts               # TTL manager
│   │   ├── parser.ts            # Role inference, config parsing
│   │   └── types.ts             # ConversationConfig, ConversationMessage
│   ├── commandDoor.ts           # Keep for sh:: (ai:: moves to conversation)
│   ├── index.ts                 # Register conversationHandler
│   └── ...
├── ...

src-tauri/
├── src/
│   ├── commands/
│   │   ├── ai.rs                # execute_ai_conversation
│   │   └── mod.rs               # Register command
│   └── ...
└── ...
```

---

## 11. Implementation Phases

### Phase 1: Core Multi-Turn (MVP)
- [ ] `buildConversation()` - walk tree, collect messages
- [ ] Role inference from content/structure (`inferRole()`)
- [ ] `conversationHandler` - replaces current `aiHandler`
- [ ] `execute_ai_conversation` Rust command
- [ ] Response block creation with `assistant::` prefix
- [ ] Basic keyboard shortcut (Cmd+Enter for send)

### Phase 2: Configuration
- [ ] Inline config parsing (`model::`, `maxTokens::`, etc.)
- [ ] `parseConversationConfig()` helper
- [ ] Model selection (fall back to config defaults)
- [ ] System prompt from `system::` block

### Phase 3: Context System
- [ ] `[[Page/Heading]]` section extraction
- [ ] Wikilink expansion in prompts
- [ ] `context::` directive parsing
- [ ] TTL state management (`TTLManager`)

### Phase 4: Polish
- [ ] Streaming responses (WebSocket or SSE)
- [ ] Debug view (`/debug` command)
- [ ] Token estimation + warnings
- [ ] Visual styling for roles (CSS data attributes)
- [ ] `/retry`, `/fork` commands

### Phase 5: Hook Integration
- [ ] ConversationMetadataHook (Rust-side)
- [ ] Conversation search indexing
- [ ] Backlink extraction from conversations

---

## 12. Testing Strategy

### Unit Tests

```typescript
// src/lib/handlers/conversation/builder.test.ts
describe('conversation/builder', () => {
  it('builds messages from linear conversation', () => {});
  it('handles branched conversations (picks correct path)', () => {});
  it('infers roles correctly from prefixes', () => {});
  it('infers roles from alternating structure', () => {});
  it('skips config blocks', () => {});
  it('skips context directive blocks', () => {});
});

// src/lib/handlers/conversation/context.test.ts
describe('conversation/context', () => {
  it('expands [[Page]] wikilinks', () => {});
  it('expands [[Page/Heading]] to section only', () => {});
  it('respects TTL expiration', () => {});
  it('handles permanent excludes', () => {});
  it('decrements TTL each turn', () => {});
});

// src/lib/handlers/conversation/parser.test.ts
describe('conversation/parser', () => {
  it('parses model:: config', () => {});
  it('parses context:: directives', () => {});
  it('strips role prefixes', () => {});
  it('handles missing config gracefully', () => {});
});
```

### Integration Tests

```typescript
// src/lib/handlers/conversation/integration.test.ts
describe('conversation flow', () => {
  it('creates response block on execute', async () => {});
  it('includes full history in API call', async () => {});
  it('handles API errors gracefully', async () => {});
  // Phase 4:
  it('streams response into block', async () => {});
});
```

---

## 13. Success Criteria

### P0 (Must Have)
- [ ] Multi-turn conversation with history
- [ ] Edit any message and re-send from that point
- [ ] Response appears as child block with `assistant::` prefix
- [ ] `Cmd+Enter` triggers send from any point in conversation

### P1 (Should Have)
- [ ] `[[Page]]` expansion in prompts
- [ ] Model selection per conversation
- [ ] Visual distinction for roles
- [ ] `/retry` command

### P2 (Nice to Have)
- [ ] `[[Page/Heading]]` section extraction
- [ ] TTL-based context management
- [ ] Streaming responses
- [ ] Debug view
- [ ] Fork/branch support

---

## 14. Open Questions

1. **Streaming UX**: How to handle user interaction during streaming? Disable editing? Show cancel button?

2. **Token Limits**: When context exceeds limits, auto-summarize older turns? Warn and let user trim? Silent truncation?

3. **System Prompts**: Per-conversation system prompt via `system::` block? Global default? Both?

4. **Persistence**: Should TTL state persist across app restarts? Or recompute from `context::` blocks?

5. **Branching UI**: How to visualize/navigate conversation branches? Tabs? Collapsible? Graph view?

6. **Backend Provider**: Start with Ollama only? Add Anthropic API / OpenAI support later?

---

## 15. References

- FLOAT Block V2.3 (Drafts.app) - TTL system, section extraction, inline config
- Existing `ai::` handler: `src/lib/handlers/commandDoor.ts`
- Handler registry pattern: `src/lib/handlers/registry.ts`
- Hook system spec: `docs/architecture/FLOATTY_HOOK_SYSTEM.md`
- Handler registry spec: `docs/architecture/FLOATTY_HANDLER_REGISTRY.md`
- Y.Doc patterns: `.claude/rules/ydoc-patterns.md`

---

## Appendix A: Message Format Examples

### Simple Conversation
```
Input tree:
ai:: What is quantum computing?
  └─ assistant:: Quantum computing is...
      └─ What about qubits?

Output messages array:
[
  { role: "user", content: "What is quantum computing?" },
  { role: "assistant", content: "Quantum computing is..." },
  { role: "user", content: "What about qubits?" }
]
```

### With Context Expansion
```
Input tree:
ai:: Explain this API
  - context::2 [[API Docs/Auth]]
  └─ assistant:: The API uses...
      └─ How do I get a token?

Output messages array:
[
  {
    role: "user",
    content: "Explain this API\n\n[Context from [[API Docs/Auth]]:\n[section content]\n---"
  },
  { role: "assistant", content: "The API uses..." },
  { role: "user", content: "How do I get a token?" }
]
```

### With System Override
```
Input tree:
ai:: Help me write code
  - system:: You are a senior engineer. Be concise.
  - model::sonnet
  └─ assistant:: Sure, what would you like to build?

Output API call:
{
  model: "claude-3-sonnet-20240229",
  system: "You are a senior engineer. Be concise.",
  messages: [
    { role: "user", content: "Help me write code" },
    { role: "assistant", content: "Sure, what would you like to build?" }
  ]
}
```

---

## Appendix B: Migration from Current ai:: Handler

The current `aiHandler` in `commandDoor.ts` is a simple single-turn executor:

```typescript
export const aiHandler = createCommandDoor({
  prefixes: ['ai::', 'chat::'],
  backendCommand: 'execute_ai_command',
  paramName: 'prompt',
  outputPrefix: 'ai::',  // <-- Uses same prefix for output
  pendingMessage: 'Thinking...',
  logPrefix: 'ai',
});
```

**Migration steps:**

1. Keep `shHandler` in `commandDoor.ts`
2. Create new `conversationHandler` in `handlers/conversation.ts`
3. In `handlers/index.ts`, register `conversationHandler` instead of `aiHandler`
4. The `execute_ai_command` Rust command can remain for fallback
5. Add new `execute_ai_conversation` Rust command for multi-turn

**Breaking change**: Output prefix changes from `ai::` to `assistant::`. Existing single-turn `ai::` blocks will still work (treated as conversation roots with one turn).
