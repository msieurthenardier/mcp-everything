# Squawk 0028: The README gives the Node floor without saying why or what changed

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-19

## Report
Flight 01 raised the stated Node floor from 20 to 22.12. The README now gives the number and nothing else. A reader on Node 20 who gets an `engines` warning cannot tell from the README that the floor moved, or that 22.12 is what the test toolchain needs and is the only line the project is tested on. From the [flight 01 debrief](../missions/01-maintenance/flights/01-ci-gate/flight-debrief.md).

Add a short note beside the requirement: the floor follows the toolchain the project is built and tested with, the hosted check runs the current Node 22, and Node 20 is no longer supported. Documentation only. If the operator later decides to test the floor itself (a debrief recommendation), the note follows that decision; do not wait for it.

## Evidence
- `README.md:18 — "- Node.js 22.12+"`; `grep -n "22.12\|Node.js" README.md` on 2026-11-16 finds no other statement about the floor.
- `node_modules/vitest/package.json` — `"engines": {"node": "^22.12.0 || ^24.0.0 || >=26.0.0"}`.
- Flight 01's design decision records the reason and the trade-off (an `engines` warning on Node 20).

## Corrective Action
Added a short note under the README Requirements list: the Node floor follows the build/test toolchain (vitest engines), the hosted check runs the current Node 22 from `.nvmrc`, Node 20 is no longer supported (npm `engines` warning), and `@types/node` is on the 22 line. README only.

## Verification
- vitest engines: `node_modules/vitest/package.json` reads `^22.12.0 || ^24.0.0 || >=26.0.0`.
- Hosted check: `.github/workflows/ci.yml` uses `node-version-file: .nvmrc`; `.nvmrc` is `22`.
- Floor: `package.json` engines `>=22.12`; README still says 22.12+.
- `@types/node` `^22.20.5` in `package.json` (squawk 0026).
- Engines warning on Node 20 follows from npm's engines check against `>=22.12`.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the batch's diff. In a separate worktree with the whole change applied and `@types/node` 22.20.5 installed, it ran typecheck, the unit suite (950 passed, 24 skipped), the build, the built entry with an invalid setting and with an invalid id file (one line each, exit 1), and the Docker suite once (22 passed, 2 skipped; the operator's 15 containers the same before and after). It made trial changes to the source behind every new or changed test, each undone by editing; every one failed. The fork-pressure cases were not run: the watchdog script and default images are unchanged. For this squawk: each statement checked against vitest's `engines`, `.nvmrc` and `package.json`.
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-19-2` on branch `squawk/turnaround-2026-11-19-2`, with squawks 0026, 0027, 0028, 0030, 0032, 0033, 0038, 0040 and 0041.
