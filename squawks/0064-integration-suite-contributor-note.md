# Squawk 0064: The integration suite's conventions are not written down

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-25
**Completed**: 2026-11-25 (squawk turnaround 2026-11-25)

## Report
Every describe in the Docker suite that makes or removes Docker objects follows one convention, and nothing tells a contributor what it is:
- its own data directory under the temporary directory, and so its own installation id;
- every object labelled with that id and named under the suite's prefix;
- cleanup by the owner-label filter, and only through the checked removers that insist on the prefix.

Flight 4's debrief also left open a note on the three test entry points: `npm test` (the `default` project), `npm run test:slow`, and `npm run test:docker`.

## Evidence
- Flight 5's new describe ("the check after the build") and the scan-mode cases in `test/integration/docker.test.ts` both follow the convention: `removeContainerChecked`, `removeVolumeChecked`, `assertNameCheckBehaves`, and `isUnderTmp`.
- No `test/integration/README.md` exists. `CLAUDE.md` has only "## Flight Operations".
- `vitest.config.ts`'s comment describes the two vitest projects; `package.json:29-30` defines the Docker scripts.
- Flight 4's debrief, Action Items: "a contributor note on the three test entry points and where the ownership gate lives".

## Corrective Action
New `test/integration/README.md`: the entry points (`npm test`, `npm run test:slow`, `npm run test:docker`, `npm run test:docker:pressure`) and what each runs, that skips in `npm test` are the Docker-gated describes, and the own-installation, label, prefix and checked-removal convention with the helpers `mayRemove`, `removeContainerChecked`, `removeContainerWithVolumesChecked`, `removeVolumeChecked`, `removeNetworkChecked`, `assertNameCheckBehaves` and `isUnderTmp`. `CLAUDE.md` is unchanged.

## Verification
Grep of `test/integration/docker.test.ts` finds every named helper (lines 87-130); the scripts are in `package.json`. `test/readme.test.ts` reads only the root `README.md`, not this file, and passes (`npm test`: 2961 passed, 72 skipped).

## Sign-Off
Reviewer (Sonnet), 2026-11-25: `[HANDOFF:confirmed]` for the batch, scoped to the diff, with mutation trials (0051, 0067, 0061 and 0049 each made a test fail). Unit: 3,076 passed (both projects). Docker suite: 67 passed, 5 skipped, 0 failed (1,665 s), run by the Flight Director, with object lists unchanged apart from another tool's transient containers.

## Disposition
Logged at mission 03 flight 05's debrief. Carry it to the next squawk turnaround.
