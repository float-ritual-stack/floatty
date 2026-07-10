# Work Log Model (Attribution Layer)

> **STATUS: ASPIRATIONAL (design/vision — not implemented as of 2026-07-10).**
> No corresponding code exists yet; treat as direction, not description. If you
> implement part of this, update this banner with what shipped.

This is a formalization layer that adds vocabulary not fully spelled out in the architecture docs.

## Minimal fields

- actor
- role
- action
- scope
- timestamp

## Rich fields

- reason
- source
- external_ref
- session

## Purpose

Enable:

- traceability
- debugging
- historical reconstruction
- linkage between outline work and external artifacts

## Rule

Attribution should be lightweight and append-oriented.

This is not a heavy commit gate.
It is a trace discipline.
