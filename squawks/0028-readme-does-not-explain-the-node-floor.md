# Squawk 0028: The README gives the Node floor without saying why or what changed

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: —

## Report
Flight 01 raised the stated Node floor from 20 to 22.12. The README now gives the number and nothing else. A reader on Node 20 who gets an `engines` warning cannot tell from the README that the floor moved, or that 22.12 is what the test toolchain needs and is the only line the project is tested on. From the [flight 01 debrief](../missions/01-maintenance/flights/01-ci-gate/flight-debrief.md).

Add a short note beside the requirement: the floor follows the toolchain the project is built and tested with, the hosted check runs the current Node 22, and Node 20 is no longer supported. Documentation only. If the operator later decides to test the floor itself (a debrief recommendation), the note follows that decision; do not wait for it.

## Evidence
- `README.md:18 — "- Node.js 22.12+"`; `grep -n "22.12\|Node.js" README.md` on 2026-11-16 finds no other statement about the floor.
- `node_modules/vitest/package.json` — `"engines": {"node": "^22.12.0 || ^24.0.0 || >=26.0.0"}`.
- Flight 01's design decision records the reason and the trade-off (an `engines` warning on Node 20).

## Corrective Action
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
