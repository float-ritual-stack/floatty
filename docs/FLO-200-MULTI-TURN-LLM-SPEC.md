---
title: "FLO-200: Multi-Turn LLM Conversations"
type: prd
status: draft
created: 2026-01-13
author: evan + claude
---

# Multi-Turn LLM Conversations in Floatty

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
- `ai::` blocks execute single-turn prompts
- No conversation memory between invocations
- Context is manual (copy-paste or `[[wikilinks]]`)
- Can't edit and re-run with modified history

### Desired State
- Natural multi-turn conversations in outline structure
- Edit any message, re-send from any point
- Intelligent context expansion with TTL management
- Conversations searchable and linkable like any other content

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
| `ai:: ...` | user | Conversation root |
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

```markdown
--- Context: API Reference / Authentication ---
[extracted content here]
--- End Context ---
```

Or structured for the LLM:
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
  config: ConversationConfig,
  ttlState: TTLManager
): ConversationMessage[] {

  // 1. Find root
  const root = findConversationRoot(currentBlockId, getBlock);
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

---

## 7. Hook Integration

### 7.1 ConversationMetadataHook

```rust
pub struct ConversationMetadataHook;

impl BlockHook for ConversationMetadataHook {
    fn name(&self) -> &'static str { "conversation_metadata" }
    fn priority(&self) -> i32 { 40 }

    fn on_change(&self, change: &BlockChange, ctx: &HookContext) -> HookResult {
        // Only process conversation-related blocks
        if !is_conversation_block(&change.content) {
            return Ok(());
        }

        let role = infer_role(&change.content);
        let conv_root = find_conversation_root(change.block_id, ctx)?;
        let turn_number = count_turns_to_block(conv_root, change.block_id, ctx)?;

        // Update search index
        ctx.search.index_document(SearchDocument {
            block_id: change.block_id.clone(),
            content: strip_role_prefix(&change.content),
            metadata: json!({
                "type": "conversation",
                "conversation_id": conv_root,
                "role": role,
                "turn": turn_number,
            }),
        })?;

        // Extract and index any mentioned topics
        for link in extract_wikilinks(&change.content) {
            ctx.page_index.add_backlink(link, change.block_id.clone());
        }

        Ok(())
    }
}
```

### 7.2 TTL State Storage

TTL state needs to persist for the conversation lifetime:

```typescript
// Option A: Store in Y.Doc metadata on root block
interface ConversationRootMeta {
  ttlState: {
    [pageKey: string]: {
      expiresAtTurn: number | 'never' | 'excluded';
      heading?: string;
    }
  };
  currentTurn: number;
}

// Option B: Compute from context:: blocks each time
// (Simpler but less efficient for long conversations)
```

---

## 8. UI/UX

### 8.1 Visual Distinction

```css
/* Conversation root */
.block[data-conv-role="root"] {
  border-left: 3px solid var(--accent-purple);
}

/* Assistant messages */
.block[data-conv-role="assistant"] {
  background: var(--bg-assistant);
  border-left: 3px solid var(--accent-blue);
}

/* User messages in conversation */
.block[data-conv-role="user"] {
  /* Subtle or no distinction - user is "default" */
}

/* System messages */
.block[data-conv-role="system"] {
  background: var(--bg-system);
  border-left: 3px solid var(--accent-orange);
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
  color: var(--accent-blue);
  animation: pulse 1s infinite;
}
```

### 8.2 Debug View

When `/debug` is triggered or `debugMode::true`:

```markdown
debug:: Conversation Context
  - **Model:** claude-3-sonnet-20240229
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

### 8.3 Token Estimation

```typescript
function estimateTokens(messages: ConversationMessage[]): number {
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  // Rough estimate: ~4 chars per token for English
  return Math.ceil(totalChars / 4);
}

function getTokenWarning(estimated: number, max: number): string | null {
  const ratio = estimated / max;
  if (ratio > 0.9) return 'Warning: Near token limit, consider reducing context';
  if (ratio > 0.75) return 'Note: Using 75%+ of token budget';
  return null;
}
```

---

## 9. Backend Implementation

### 9.1 Rust Command: `execute_ai_conversation`

```rust
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

### 9.2 Streaming (Phase 2)

```rust
// Future: Return a stream instead of complete response
#[tauri::command]
pub async fn stream_ai_conversation(
    request: ConversationRequest,
    state: State<'_, AppState>,
    window: Window,
) -> Result<(), String> {
    // Similar setup...

    let response = client
        .post(&format!("{}/api/chat", ollama_url))
        .json(&json!({
            "model": model,
            "messages": ollama_messages,
            "stream": true,  // Enable streaming
        }))
        .send()
        .await?;

    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&chunk);

        // Parse Ollama streaming format (newline-delimited JSON)
        for line in text.lines() {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(content) = json["message"]["content"].as_str() {
                    window.emit("ai-stream-chunk", content)?;
                }
                if json["done"].as_bool() == Some(true) {
                    window.emit("ai-stream-done", ())?;
                }
            }
        }
    }

    Ok(())
}
```

---

## 10. File Structure

```
src/
├── lib/
│   ├── conversation/
│   │   ├── index.ts              # Re-exports
│   │   ├── builder.ts            # buildConversation, message assembly
│   │   ├── context.ts            # TTL manager, wikilink expansion
│   │   ├── parser.ts             # Role inference, config parsing
│   │   └── types.ts              # Interfaces
│   ├── handlers/
│   │   ├── conversation.ts       # /send, /retry, /fork handlers
│   │   └── index.ts              # Register conversation handler
│   └── ...
├── hooks/
│   └── useConversation.ts        # SolidJS hook for conversation state
└── components/
    └── views/
        └── DebugView.tsx         # Debug output rendering

src-tauri/
├── src/
│   └── commands/
│       ├── ai.rs                 # execute_ai_conversation
│       └── mod.rs                # Register command
└── floatty-core/
    └── src/
        └── hooks/
            └── conversation.rs   # ConversationMetadataHook
```

---

## 11. Implementation Phases

### Phase 1: Core Multi-Turn (MVP)
- [ ] `buildConversation()` - walk tree, collect messages
- [ ] Role inference from content/structure
- [ ] `/send` handler - build and send
- [ ] `execute_ai_conversation` Rust command
- [ ] Response block creation with `assistant::` prefix
- [ ] Basic keyboard shortcut (Cmd+Enter)

### Phase 2: Configuration
- [ ] Inline config parsing (`model::`, `maxTokens::`, etc.)
- [ ] Config UI or block-based config
- [ ] Model selection

### Phase 3: Context System
- [ ] `[[Page/Heading]]` section extraction
- [ ] Basic wikilink expansion in prompts
- [ ] `context::` directive parsing
- [ ] TTL state management

### Phase 4: Polish
- [ ] Streaming responses
- [ ] Debug view (`/debug` command)
- [ ] Token estimation + warnings
- [ ] Visual styling for roles
- [ ] `/retry`, `/fork` commands

### Phase 5: Hook Integration
- [ ] ConversationMetadataHook
- [ ] Conversation search indexing
- [ ] Backlink extraction from conversations

---

## 12. Testing Strategy

### Unit Tests
```typescript
describe('conversation/builder', () => {
  it('builds messages from linear conversation', () => {});
  it('handles branched conversations (picks correct path)', () => {});
  it('infers roles correctly from prefixes', () => {});
  it('infers roles from alternating structure', () => {});
  it('skips config blocks', () => {});
});

describe('conversation/context', () => {
  it('expands [[Page]] wikilinks', () => {});
  it('expands [[Page/Heading]] to section only', () => {});
  it('respects TTL expiration', () => {});
  it('handles permanent excludes', () => {});
  it('decrements TTL each turn', () => {});
});

describe('conversation/parser', () => {
  it('parses model:: config', () => {});
  it('parses context:: directives', () => {});
  it('strips role prefixes', () => {});
});
```

### Integration Tests
```typescript
describe('conversation flow', () => {
  it('creates response block on /send', async () => {});
  it('includes full history in API call', async () => {});
  it('handles API errors gracefully', async () => {});
  it('streams response into block', async () => {});
});
```

---

## 13. Success Criteria

### P0 (Must Have)
- [ ] Multi-turn conversation with history
- [ ] Edit any message and re-send
- [ ] Response appears as child block
- [ ] `Cmd+Enter` triggers send

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

---

## 15. References

- FLOAT Block V2.3 (Drafts.app) - TTL system, section extraction, inline config
- Existing `ai::` handler - `src/lib/handlers/ai.ts`
- Handler registry pattern - `src/lib/handlers/`
- Hook system - `floatty-core/src/hooks/`
- Y.Doc sync - `src/hooks/useSyncedYDoc.ts`

---

## Appendix A: Message Format Examples

### Simple Conversation
```
Input:
ai:: What is quantum computing?
  └─ assistant:: Quantum computing is...
      └─ What about qubits?

Output messages:
[
  { role: "user", content: "What is quantum computing?" },
  { role: "assistant", content: "Quantum computing is..." },
  { role: "user", content: "What about qubits?" }
]
```

### With Context Expansion
```
Input:
ai:: Explain this API
  - context::2 [[API Docs/Auth]]
  └─ assistant:: The API uses...
      └─ How do I get a token?

Output messages:
[
  {
    role: "user",
    content: "Explain this API\n\n--- Context: API Docs / Auth ---\n[section content]\n--- End Context ---"
  },
  { role: "assistant", content: "The API uses..." },
  { role: "user", content: "How do I get a token?" }
]
```

### With System Override
```
Input:
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
