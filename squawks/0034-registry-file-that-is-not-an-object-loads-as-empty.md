# Squawk 0034: A registry file whose top level is not an object loads as an empty registry

**Status**: completed
**Type**: defect
**Severity**: grounding
**Reported**: 2026-11-16
**Completed**: 2026-11-16

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
In `Registry.refresh()` in `src/registry.ts`, after `JSON.parse`, a parsed value that is not a plain object (`null`, an array, or not of type object) now throws `Registry file <path> is unreadable: not a registry: expected an object`. This happens before `version` is read and before the in-memory map and `mtimeMs` are assigned, so nothing is loaded and, since every write refreshes first, nothing is written. A top-level `null` still ends as unreadable, now with that plain reason. A second check was included: `projects`, when present, must also be a plain object, else `Registry file <path> is unreadable: not a registry: expected "projects" to be an object`. It is the same line and the same loss: `"projects": []` loaded as empty and `"projects": "abc"` loaded three records keyed "0", "1", "2", and the next write replaced the file. A missing `projects` still loads as an empty registry. The version check and its two messages are unchanged. A small `isPlainObject` helper was added.

## Verification
Tests were written first in `test/registry.test.ts` (new describe block beside the corrupt-file case) and run against the unchanged code: 8 of the 10 new cases failed. On the unchanged code, `[]` did not throw from `refresh()`, and after one `put` the file held `{"version":1,"projects":{"y":...}}`, the original content gone. The `{"version":1}` and `{}` cases passed before and after, as intended.

Mutation check: with the top-level check disabled, 7 new cases failed (the five top-level values, the `[]` put/delete/update case, the held-records case). With the `projects` check disabled, both `projects` cases failed. Each experiment was restored by editing, and `git diff src/registry.ts` was identical to the pre-experiment diff. No new case survived its check's removal.

`npm run typecheck` clean; `npx vitest run --testTimeout 20000`: 511 passed, 18 skipped (was 500 passed, 18 skipped). Every existing case passes unmodified.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff. It tried to break each new test by changing the source (six mutations, each undone by editing) and found none that could not fail, apart from the cases that pin behavior which already held. Docker suite run once on the reviewed tree: 16 passed, 2 skipped, 0 failed.
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-16` (trailer `Squawks: 0034, 0036`) on branch `squawk/turnaround-2026-11-16-2`
