# Agentic Runtime (Alignment Layer)

This folder does not define new architecture.
It formalizes runtime roles and execution boundaries on top of the existing architecture corpus, especially:

- `docs/architecture/BBS_OUTLINE_CONVERGENCE.md`
- `docs/architecture/PHILOSOPHY.md`

## Core truths

- The outline is the shared substrate.
- Y.Doc / outline state is canonical.
- Agents may persist memory, but durable memory should live as outline-native structure.
- Projections are not source of truth.
- Attribution matters more than commit ceremony.

## Runtime split

There are two distinct agent ecologies:

### Outline-native agents
Operate directly on the outline as a cognitive / coordination substrate.

Examples:
- Clerk
- Librarian
- Gardener
- Renderer

### External execution agents
Operate primarily in shell, repos, external tools, and codebases.

Examples:
- Claude Code in xterm
- repo-working implementation agents
- debugging / test-running / git-driving agents

Rule:
Outline-native agents organize and interpret work.
External execution agents perform work.
Floatty complements execution surfaces; it does not replace them.

## Pipeline

```text
input -> clerk -> outline (canonical state)
               -> librarian (read/query)
               -> gardener (refine/mutate)
               -> renderer (projection)
```

Execution agents may write traces, summaries, issues, plans, and artifacts back into the outline, but they are not reduced to outline-native roles.
