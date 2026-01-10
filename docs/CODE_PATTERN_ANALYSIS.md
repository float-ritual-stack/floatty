# Floatty Code Pattern Analysis Report

**Date**: 2026-01-10
**Analyzer**: Claude Code Pattern Analysis
**Codebase**: floatty (Tauri v2 terminal emulator with outliner)

---

## Executive Summary

The floatty codebase demonstrates **mature architectural patterns** with excellent separation of concerns. The codebase follows a consistent "Event → Handler → Transform → Project" philosophy documented in CLAUDE.md. Key findings:

- **21 code clones** detected (2.47% duplication) - relatively low
- **Strong singleton pattern usage** for state management
- **Clean command/service separation** in Rust backend
- **Well-established naming conventions** with minor inconsistencies
- **Minimal technical debt markers** (only 3 active TODO/FIXME items in source code)

---

## 1. Design Patterns Detected

### 1.1 Singleton Pattern (Heavily Used)

| Location | Purpose | Implementation Quality |
|----------|---------|------------------------|
| `src/lib/terminalManager.ts:959` | Terminal lifecycle management | **Excellent** - Explicit singleton, survives framework reactivity |
| `src/hooks/useSyncedYDoc.ts:111` | Y.Doc CRDT state | **Excellent** - Ref-counted singleton with documented lifecycle |
| `src/hooks/useBlockStore.ts:184` | Block tree state | **Good** - Singleton via createRoot pattern |
| `src/hooks/useLayoutStore.ts:415` | Layout state | **Good** - createRoot singleton |
| `src/hooks/useTabStore.ts:187` | Tab state | **Good** - createRoot singleton |
| `src/hooks/useThemeStore.ts:102` | Theme state | **Good** - createRoot singleton |
| `src/lib/handlers/registry.ts:58` | Handler registry | **Good** - Simple module-level singleton |
| `src/hooks/useWorkspacePersistence.ts:210` | Persistence layer | **Good** - Lazy singleton pattern |

**Assessment**: The singleton pattern is intentionally used to manage state that must survive SolidJS component lifecycle. This is a **documented architectural decision** (see CLAUDE.md:272) to avoid framework reactivity issues.

### 1.2 Registry/Strategy Pattern

**HandlerRegistry** (`src/lib/handlers/registry.ts`):
```typescript
export class HandlerRegistry {
  private handlers: BlockHandler[] = [];
  register(handler: BlockHandler): void { ... }
  findHandler(content: string): BlockHandler | null { ... }
}
```

**Handlers registered**:
- `sh::` / `term::` → Shell command execution
- `ai::` / `chat::` → LLM prompt execution
- `daily::` → Daily view renderer

**Assessment**: **Excellent** implementation of Strategy pattern. Clean interface (`BlockHandler`), centralized registration, prefix-based routing. Allows easy extension without modifying core code.

### 1.3 Observer Pattern

**Y.Doc Observers** (`src/hooks/useBlockStore.ts:215-278`):
- `observeDeep()` on blocks map for CRDT sync
- Singleton observers survive component remount
- Ref-counted attachment/detachment

**Terminal Semantic State** (`src/lib/terminalManager.ts:58-64`):
- Callback-based observer for PTY events
- `onPtySpawn`, `onPtyExit`, `onTitleChange`, `onSemanticStateChange`

**Assessment**: **Good** - Observer pattern used appropriately for reactive updates. The singleton observer pattern in Y.Doc prevents the classic "too many observers" bug.

### 1.4 Dependency Injection (Context Pattern)

**WorkspaceContext** (`src/context/WorkspaceContext.tsx`):
```typescript
export function WorkspaceProvider(props: WorkspaceProviderProps) {
  const value: WorkspaceContextValue = {
    blockStore: props.blockStore ?? realBlockStore,
    paneStore: props.paneStore ?? realPaneStore,
  };
  return <WorkspaceContext.Provider value={value}>...</WorkspaceContext.Provider>;
}
```

**Mock factories for testing**:
- `createMockBlockStore()` - Block store mock
- `createMockPaneStore()` - Pane store mock

**Assessment**: **Excellent** - Clean DI implementation enabling store-first testability. Production uses real singletons; tests inject mocks.

### 1.5 Command/Service Pattern (Rust Backend)

**Layer separation**:
```
commands/     → Thin Tauri wrappers (3-10 lines each)
  ↓ delegate to
services/     → Pure Rust business logic (testable without Tauri)
```

**Example flow**:
```rust
// commands/execution.rs
pub async fn execute_shell_command(...) -> Result<String, String> {
    execution::execute_shell(&config, &command).await
}

// services/execution.rs
pub async fn execute_shell(config: &AggregatorConfig, command: &str) -> Result<String, String> {
    // Actual logic here
}
```

**Assessment**: **Excellent** - Clear architectural boundary. Commands are adapters; services contain logic. Each service module has unit tests (`use super::*` pattern).

---

## 2. Anti-Patterns & Technical Debt

### 2.1 TODO/FIXME/HACK Comments

| File | Line | Comment | Severity |
|------|------|---------|----------|
| `src/components/BlockItem.tsx` | 50 | `TODO: AUTO-EXECUTE for external blocks` | Low - Feature placeholder |
| `src-tauri/Cargo.toml` | 66 | `TODO: Replace with crates.io version` | Low - Dependency note |
| `.claude/prompts/nested-ymap-refactor.md` | 84 | `THE HACK: Parse stringified JSON` | N/A - Historical doc |

**Assessment**: Only **2 active TODOs** in production code. Excellent technical debt hygiene.

### 2.2 Large File Analysis (Potential God Objects)

| File | Lines | Assessment |
|------|-------|------------|
| `terminalManager.ts` | 960 | **Justified** - Single responsibility (terminal lifecycle), extracted from components to avoid reactivity issues |
| `useBlockStore.ts` | 902 | **Moderate concern** - Could extract Y.Doc helpers to separate module |
| `useSyncedYDoc.ts` | 728 | **Justified** - Complex sync logic with extensive documentation |
| `Terminal.tsx` | 686 | **Moderate concern** - Tab orchestration + keybinds could split |
| `BlockItem.tsx` | 646 | **Acceptable** - Complex keyboard handling with many edge cases |
| `api.rs` (server) | 915 | **Moderate concern** - REST API could split by resource |

**Recommendations**:
1. Extract Y.Doc primitive helpers from `useBlockStore.ts` to `lib/ydocUtils.ts`
2. Consider splitting `Terminal.tsx` keybind logic to `useTerminalKeybinds.ts`

### 2.3 Coupling Analysis

**Low coupling detected**:
- `src/lib/` modules have minimal cross-dependencies
- Hooks don't import from components
- Handlers only depend on types and utils

**Potential concern**:
- `terminalManager.ts` imports from multiple Tauri plugins (PTY, clipboard, OS)
- This is **acceptable** as it's an integration point

---

## 3. Naming Convention Analysis

### 3.1 File Naming

| Pattern | Convention | Consistency |
|---------|------------|-------------|
| React components | `PascalCase.tsx` | 100% |
| Hooks | `useXxx.ts` | 100% |
| Pure libs | `camelCase.ts` | 100% |
| Test files | `*.test.ts(x)` | 100% |
| Rust modules | `snake_case.rs` | 100% |

### 3.2 Code Naming

| Category | Convention | Consistency | Examples |
|----------|------------|-------------|----------|
| Functions | camelCase | 99% | `findNode`, `createBlock`, `splitPane` |
| Constants | SCREAMING_SNAKE | 95% | `TERMINAL_RESERVED_KEYS`, `MAX_RETRIES` |
| Classes | PascalCase | 100% | `TerminalManager`, `HandlerRegistry`, `HttpClient` |
| Interfaces | PascalCase | 100% | `BlockHandler`, `ExecutorActions`, `TerminalInstance` |
| Types | PascalCase | 100% | `KeyboardAction`, `LayoutNode`, `FocusDirection` |
| Rust structs | PascalCase | 100% | `CtxMarker`, `ServerState`, `WatcherConfig` |
| Rust functions | snake_case | 100% | `execute_shell`, `get_ctx_markers` |

**Minor inconsistencies**:
- Some regex constants use UPPER_CASE (`TV_PATTERN`), others use PascalCase context (`COMBINED_CTX`)
- Acceptable variation

**Assessment**: **Excellent** naming consistency across both TypeScript and Rust codebases.

---

## 4. Code Duplication Report

### 4.1 Summary Statistics

| Metric | Value |
|--------|-------|
| Files analyzed | 78 |
| Total lines | 13,662 |
| Clones found | 21 |
| Duplicated lines | 337 (2.47%) |
| Duplicated tokens | 2,997 (2.64%) |

**Industry benchmark**: <5% duplication is considered healthy. Floatty at **2.47%** is well within acceptable range.

### 4.2 Significant Duplications

#### High Priority: Handler Duplication

**Files**: `src/lib/handlers/ai.ts` ↔ `src/lib/handlers/sh.ts`

| Clone | Lines | Tokens |
|-------|-------|--------|
| TV resolution block | 15 | 122 |
| Placeholder creation | 18 | 159 |
| Output parsing | 30 | 286 |

**Total**: 63 lines of nearly identical code between the two handlers.

**Recommendation**: Extract a `createCommandHandler()` factory function:
```typescript
function createCommandHandler(options: {
  prefixes: string[];
  invokeCommand: string;
  outputPrefix: string;
  pendingMessage: string;
  logPrefix: string;
}): BlockHandler
```

#### Medium Priority: useBlockStore Internal Duplication

| Pattern | Occurrences | Lines |
|---------|-------------|-------|
| Block creation logic | 4 | ~50 |
| Y.Map mutation pattern | 3 | ~30 |

**Recommendation**: These are mostly template patterns with slight variations. Consider extracting:
- `createBlockAt(position: 'before' | 'after' | 'inside' | 'insideTop', referenceId: string)`

#### Low Priority: Internal File Duplication

- `terminalManager.ts` - WebGL addon setup repeated twice (13 lines)
- `useTreeCollapse.ts` - Expand/collapse logic mirrored (17 lines)
- `inlineParser.ts` - Bracket parsing repeated (17 lines)

These are acceptable as they represent similar-but-different logic paths.

---

## 5. Architectural Boundary Review

### 5.1 Layer Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (SolidJS)                            │
├─────────────────────────────────────────────────────────────────────────┤
│  components/        │  hooks/              │  lib/                      │
│  ├── Terminal.tsx   │  ├── useBlockStore   │  ├── terminalManager      │
│  ├── Outliner.tsx   │  ├── useSyncedYDoc   │  ├── handlers/            │
│  ├── BlockItem.tsx  │  ├── useLayoutStore  │  ├── keybinds            │
│  └── ...            │  └── ...             │  └── ...                  │
├─────────────────────┴──────────────────────┴────────────────────────────┤
│                           IPC BOUNDARY (Tauri)                          │
├─────────────────────────────────────────────────────────────────────────┤
│                           BACKEND (Rust)                                │
├─────────────────────────────────────────────────────────────────────────┤
│  commands/          │  services/           │  core modules/             │
│  ├── ctx.rs         │  ├── ctx.rs          │  ├── db.rs                │
│  ├── execution.rs   │  ├── execution.rs    │  ├── ctx_watcher.rs       │
│  ├── workspace.rs   │  ├── workspace.rs    │  ├── ctx_parser.rs        │
│  └── ...            │  └── ...             │  └── ...                  │
└─────────────────────────────────────────────────────────────────────────┘
```

### 5.2 Boundary Violations Detected

| Violation | Severity | Location | Assessment |
|-----------|----------|----------|------------|
| None | - | - | - |

**Clean boundaries observed**:
1. `src/lib/` has **zero** SolidJS imports (pure logic)
2. `src/hooks/` has **zero** Tauri imports (services handle IPC)
3. Commands are thin wrappers delegating to services
4. Components only interact with stores via context

### 5.3 Dependency Flow

**Correct flow** (no violations):
```
Components → Context → Hooks → Lib
                         ↓
                    invoke() → Commands → Services → Core modules
```

**Exception (acceptable)**:
- `terminalManager.ts` directly calls `invoke()` for PTY operations
- This is documented in CLAUDE.md as intentional (performance-critical path)

---

## 6. Quality Metrics Summary

| Category | Score | Notes |
|----------|-------|-------|
| Design Patterns | **A** | Consistent use of Singleton, Registry, Observer, DI |
| Code Duplication | **A-** | 2.47% - Handler duplication should be addressed |
| Naming Conventions | **A** | Excellent consistency across TS and Rust |
| Architectural Boundaries | **A+** | No violations detected |
| Technical Debt | **A** | Only 2 TODOs in production code |
| Documentation | **A** | Extensive CLAUDE.md, inline comments |

**Overall Grade: A**

---

## 7. Recommendations

### High Priority
1. **Refactor handler duplication** - Extract shared logic from `sh.ts` and `ai.ts` into a factory or base handler

### Medium Priority
2. **Extract Y.Doc helpers** - Move primitive operations from `useBlockStore.ts` to `lib/ydocUtils.ts`
3. **Consider splitting Terminal.tsx** - Extract keybind handling to dedicated hook

### Low Priority
4. **Consolidate inline parser duplication** - Unify bracket-counting logic between `inlineParser.ts` and `wikilinkUtils.ts`
5. **Document the singleton patterns** - Add JSDoc explaining why singletons are used (reference CLAUDE.md)

---

## Appendix: Files Analyzed

**TypeScript/TSX**: 78 files (13,662 lines)
**Rust**: 23 files (src-tauri/src/ + plugins)
**Test Coverage**: Extensive test files with 268 tests

**Tools Used**:
- jscpd (code duplication detection)
- Manual grep/ast pattern analysis
- Architectural dependency tracing
