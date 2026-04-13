# Outline State Model

This makes explicit what is already implied by the architecture.

## States

### raw
- unstructured input
- clerk domain

### normalized
- markers resolved
- links created
- entities identified

### refined
- reorganized
- deduped
- enriched
- gardener domain

### projected
- UI / exports / AI render / artifacts
- not source of truth

## Invariant

Y.Doc / outline state is canonical.

These are not separate systems.
They are states inside the same substrate.

## Memory model

Agent memory is not a separate memory product.
Durable agent memory is usually:

- owned subtree
- branch
- task page
- queue
- artifact draft
- work log

Memory = outline-native structure.
