# Clerk (Ingestion Boundary)

## Definition

Clerk is the ingestion boundary between raw human/agent input and structured outline state.

## Inputs

- scratch notes
- meeting dumps
- session wraps
- inline commands
- mixed markers
- issue references
- sysop notes
- semi-structured noise

## Outputs

- blocks
- links
- tags
- issue lookups / creation requests
- follow-up dispatches
- initial structure

## Responsibilities

- parse markers
- classify intent
- resolve entities
- create usable structure quickly
- attach enough context for later refinement

## Rules

- fast > perfect
- lossy allowed
- partial success is valid
- do not block on deep reasoning
- produce something editable and useful

## Important distinction

Clerk is not Librarian.

Librarian asks:
- what exists?

Clerk asks:
- what do we do with this mess?

## Interface note

Clerk is both:
- a role
- an interaction surface / fuzzy compiler

Human input, commands, and markers compile into graph mutations.
