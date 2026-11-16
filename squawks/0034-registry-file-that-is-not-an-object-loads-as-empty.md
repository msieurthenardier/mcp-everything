# Squawk 0034: A registry file whose top level is not an object loads as an empty registry

**Status**: open
**Type**: defect
**Severity**: grounding
**Reported**: 2026-11-16
**Completed**: —

## Report
`Registry.refresh()` reports a file that is not valid JSON as unreadable and leaves it alone. A file that **is** valid JSON but whose top level is an array, a number or a string is not caught: it has no `projects`, so it loads as an empty registry, and the next write replaces the file with that empty registry plus whatever was just added. Found by the design review of flight 03's second leg (mission 01), which adds a check of the file's `version` in the same lines and was not chartered to change this.

Treat a parsed value that is not a plain object the way a corrupt file is treated: the existing "unreadable" error, nothing loaded, nothing written. A top-level `null` already ends there (by an exception on the property access).

Raised from `routine` to `grounding` by the operator on 2026-11-16, at the flight 03 debrief: it is to be completed before any further work on `src/registry.ts`, sortie 04 included. It sits in the method that flight edited and is the same kind of data loss as the finding that flight fixed.

No known way to produce such a file other than by hand or by another program writing to the path. Same family as squawk 0017.

## Evidence
- `src/registry.ts`, `Registry.refresh` — `const parsed = JSON.parse(…) as RegistryFile; this.projects = new Map(Object.entries(parsed.projects ?? {}));`. For `[]`, `7` or `"x"`, `parsed.projects` is `undefined` and the map is empty.
- `src/registry.ts`, `mutate` and `update` — both re-read through `refresh()` and then `persist()` the in-memory map over the file.
- Read, not run. `test/registry.test.ts`, "reports a corrupt registry file instead of silently discarding it", is the neighboring case; one more beside it with `[]` in the file would show it.

## Corrective Action
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
