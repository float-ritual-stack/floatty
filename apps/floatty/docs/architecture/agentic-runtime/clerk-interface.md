# Clerk Interface (Ingestion DSL)

Clerk is not only a role. It is also an interaction surface.

## Forms of input

1. freeform text
2. inline markers (`::`, `[[ ]]`, `[ ]`)
3. commands (`/util:*`, `floatctl *`, similar)
4. hybrid input (text + markers + commands)

## Example

Input:

`this annoying thing [[sysop::note]] check if issue exists`

Possible clerk result:

- note block created
- sysop tag attached
- issue lookup performed
- existing issue linked or new issue requested
- follow-up block emitted

## Command layer

Semantic commands are not a separate system.

They compile into:
- block writes
- marker dispatches
- hook triggers
- task / issue / note creation
- trace events

## Design principle

Clerk is a fuzzy compiler:

messy human input -> structured graph mutations
