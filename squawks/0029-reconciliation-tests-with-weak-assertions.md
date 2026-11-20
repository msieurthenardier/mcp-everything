# Squawk 0029: Two reconciliation tests have assertions that cannot fail or fail too loosely

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-19

## Report
Two of the cases flight 02 added for the startup reconciliation assert less than their names say. Found by the Developer in the [flight 02 debrief](../missions/01-maintenance/flights/02-install-failure-paths/flight-debrief.md), after the flight's Reviewer said it had not read the file closely. Nothing is broken in the product; the tests would not notice if it were.

- "writes nothing when the record was replaced during the detach": the registry file's mtime is read **after** the reconciliation and then compared with itself, so the check that nothing was written cannot fail. Capture the mtime inside the `onSetNetwork` hook, right after the second registry's write, as the next case ("does not rewrite the file when the record changed during the detach") already does; or drop the dead lines if that case makes this one redundant.
- "changes nothing and logs once when Docker does not answer, and reconciles at a later start": `expect(log[0]).toContain("2")` passes on any line with a 2 in it. Assert on the count as the message words it.

Test file only. To show each assertion now bites, break the behavior it names once and watch the case fail.

## Evidence
- `test/installer.test.ts:825` — the case; `:832 — "const written = mtime();"` followed by `expect(other().refresh()).toBe(true); expect(mtime()).toBe(written);`.
- `test/installer.test.ts:768 — 'expect(log[0]).toContain("2");'`. The line it reads is built at `src/install/installer.ts:344 — "${stale.length} interrupted install(s) not reconciled, Docker is not reachable: …"`.

## Corrective Action
Both changes are in `test/installer.test.ts`; nothing under `src/`.

- "writes nothing when the record was replaced during the detach": `mtime()` is now captured inside the `onSetNetwork` hook right after the second registry's `put(newer)`, and the case asserts `mtime()` still equals that value after the reconciliation (plus `written > 0`, so an unset capture cannot pass). The dead `other().refresh()` and the after-the-fact `written` read were removed. The case was kept rather than dropped: the neighbour "does not rewrite the file when the record changed during the detach" covers a status change, while this one covers a record replaced by a newer install (different `installedAt`, `network: true`), which takes the other branch of the guard in the locked write.
- "changes nothing and logs once when Docker does not answer...": `expect(log[0]).toContain("2")` became `expect(log[0]).toMatch(/^2 interrupted install\(s\) not reconciled, Docker is not reachable/)`, anchoring the count to the start of the message as `reconcileStale` words it.

## Verification
Each break was made by editing `src/install/installer.ts`, run with `npx vitest run test/installer.test.ts`, and undone by editing; `git diff --stat` afterwards showed only the test file and this squawk.

- Count assertion: changed the message to `${stale.length + 1} interrupted install(s)...`. "changes nothing and logs once when Docker does not answer..." failed: `expected '3 interrupted install(s) not reconcil…' to match /^2 interrupted install\(s\) not recon…/`. (The old `toContain("2")` would have passed on a line like "3 ... 2".)
- mtime assertion: added a registry rewrite when the guarded write is refused (`if (!wrote) { ... this.registry.put({ ...c }); }`) so the call still returns `[]` but the file is written. "writes nothing when the record was replaced during the detach" failed: `expected 1795150507271.8062 to be 1795150507271.578`; the neighbour failed the same way. A first, cruder break (dropping the guard) failed only on the returned-slugs assertion, so it did not exercise the mtime line; the second break does.
- `npm run typecheck`: clean. `npm test`: 21 files passed, 1 skipped; 916 tests passed, 24 skipped.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the batch's diff. It ran typecheck and the unit suite (921 passed, 24 skipped), confirmed nothing under `src/` changed, and broke the source behind every new or changed test, each undone by editing; every one failed. The Docker suites were not run: nothing here touches the sandbox. For this squawk: changing the count in the Docker-unreachable message failed the log case; a registry rewrite after a refused guarded write failed the replaced-record case on its mtime. Keeping that case rather than dropping it was judged justified (it covers a different branch of the guard).
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-19` on branch `squawk/turnaround-2026-11-19`, with squawks 0029, 0035 and 0037.
