# Work Log Model (Attribution Layer)

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
