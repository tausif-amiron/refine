# ADR 0002: Code decides pass or fail

- Status: accepted
- Date: 2026-11-09

## Context

Models report success that has not happened. Every gate in the loop needs a verdict nobody can talk past.

## Decision

Every gate is a script with an exit code: scope, checks, seen-red, mutation, owed.yaml, IR schema and
anchors, plan coverage, CI. A model's statement is never a gate. Model output is parsed and validated
(JSON schema) before use.

## Consequences

Gates must be kept fast and correct; a wrong gate blocks good work. Gate changes go through review like code.
