---
description: Review feature/plan against documented architecture patterns
argument-hint: <feature description or implementation to review>
---

# Architecture Review: $ARGUMENTS

Launch a fresh-context agent to evaluate this against Floatty's documented patterns.

## What This Does

1. **Fresh context** - Agent starts clean, reads architecture docs first
2. **Classifies the feature** - Uses Five Questions from PHILOSOPHY.md
3. **Checks for existing infrastructure** - Finds what should be reused
4. **Pattern matches** - Compares to Applied Examples
5. **Calls out bypasses** - Explicitly surfaces architecture shortcuts

## Invoke

Use the Task tool with subagent_type `architecture-reviewer`:

```
Review the following feature/implementation for architecture alignment:

$ARGUMENTS

Start by reading docs/architecture/PHILOSOPHY.md, then classify using the Five Questions,
check for existing infrastructure to reuse, and provide a verdict.
```

## Why This Exists

Prevents the pattern:
1. Build architecture (EventBus, Hooks, Projections)
2. Want to build feature using architecture
3. "Simpler" to do it without architecture
4. Do it without, suggest deleting architecture
5. Architecture atrophies, becomes "ghost spec"

The reviewer ensures we **USE** what we built.

## When to Use

- Before implementing a new feature
- When reviewing a PR that adds functionality
- When you suspect a shortcut is bypassing patterns
- When unsure if something should be Handler/Hook/Projection/Renderer
