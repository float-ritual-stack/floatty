# Agent Roles (Runtime Formalization)

These roles are behavioral constraints over the shared outline substrate.
They do not define separate systems.

## Clerk
Boundary: chaos -> structure

Responsibilities:
- parse markers (`::`, `[[ ]]`, `[ ]`)
- detect intent
- resolve or create entities
- write initial blocks
- attach minimal attribution
- dispatch follow-up actions

Clerk turns noise into work.

## Librarian
Boundary: query -> context

Responsibilities:
- retrieval
- graph walking
- backlinks / connections
- historical resurfacing
- context packets

Librarian finds and connects what already exists.

## Gardener
Boundary: structure -> better structure

Responsibilities:
- refine
- reorganize
- prune
- deduplicate
- normalize metadata / shape

Gardener improves existing structure.

## Renderer
Boundary: structure -> projection

Responsibilities:
- build views
- produce json-render specs
- generate artifacts / dashboards / inspectors
- surface alternate representations of outline state

Renderer changes presentation, not truth.

## Rule

No agent spans roles unless explicitly composed.

## Execution note

These are outline-native roles.
They are distinct from external execution agents that work in shell/repo contexts.
