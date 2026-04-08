# Eval Criteria for Prompt Improver

Binary yes/no checks for scoring improved prompts. Designed for Karpathy-style
autoresearch iteration: run the skill N times, score each output, mutate, keep/revert.

## Core Evals (always apply)

### EVAL 1: Scope Preservation
**Question**: Does the improved prompt preserve the original task without inflating scope?
**Pass**: The original ask is clearly present. No new features/refactors added beyond what was asked.
**Fail**: The improved prompt adds work not implied by the original request, or changes what was asked for.

### EVAL 2: Floatty Specificity
**Question**: Does the improved prompt use floatty-specific terminology instead of generic language?
**Pass**: Uses at least 2 floatty-specific terms (panes, blocks, Y.Doc, doors, childIds, etc.) where relevant.
**Fail**: Uses generic terms like "the application", "the state", "the database" when floatty terms exist.

### EVAL 3: Actionable Risks
**Question**: Are the listed risks specific to THIS request, not generic?
**Pass**: Each risk names a specific subsystem, function, or interaction that could break.
**Fail**: Risks are generic ("may cause regressions", "could affect performance") or missing entirely.

### EVAL 4: Validation Proportionality
**Question**: Is the suggested validation proportional to the task complexity?
**Pass**: Simple task → 1-2 checks. Complex task → specific test cases. No over-engineering.
**Fail**: One-line fix gets a 10-step validation plan, OR risky change gets no validation.

### EVAL 5: No Hallucinated Files
**Question**: Are all referenced files real or appropriately hedged?
**Pass**: Files exist in the repo OR are prefixed with "likely in" / "check for".
**Fail**: References specific file paths that don't exist without hedging.

### EVAL 6: Classification Accuracy
**Question**: Is the request correctly classified (bug_fix, feature, refactor, etc.)?
**Pass**: Classification matches the actual intent of the original request.
**Fail**: Misclassification (e.g., calling a bug fix a "feature", calling a refactor "architecture").

## Stretch Evals (for tight iteration)

### EVAL 7: Brevity
**Question**: Is the improved prompt under 300 words (excluding the example/context sections)?
**Pass**: Core prompt section is concise. Context is separated, not inline.
**Fail**: Prompt is bloated with repeated context or unnecessary explanation.

### EVAL 8: Don't-Touch Boundaries
**Question**: Does the prompt specify what should NOT be changed?
**Pass**: At least one "don't regress" or "don't touch" boundary for non-trivial requests.
**Fail**: No scope boundaries for a request that touches multiple subsystems.

## Test Inputs for Iteration

Use these varied inputs to test the skill across different request types:

1. **Vague bug**: "pane linking is broken sometimes"
2. **Feature request**: "add a way to search by date range in the command bar"
3. **Refactor ask**: "clean up the block input handling, it's getting messy"
4. **Architecture**: "should we move metadata extraction to the server?"
5. **Simple fix**: "the breadcrumb doesn't update when I zoom"
6. **Multi-system**: "make doors work with linked panes"

## Autoresearch Notes

When running autoresearch on this skill:
- The skill's output is structured (classification + prompt + risks + validation)
  so evals can check each section independently
- "Scope preservation" is the hardest eval — the skill has a natural tendency to
  add context that shades into scope expansion. Watch for this.
- The example in SKILL.md may cause overfitting if all test inputs are navigation-related.
  Use diverse inputs.
- The high-risk surfaces table is the most likely section to go stale as the codebase
  evolves. Update it when architecture changes.
