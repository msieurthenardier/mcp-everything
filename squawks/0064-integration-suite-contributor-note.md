# Squawk 0064: The integration suite's conventions are not written down

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-25
**Completed**: —

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
*(to be filled in on completion)*: add a short `test/integration/README.md`, or a "Testing" section in `CLAUDE.md`. It covers the three entry points, what each runs, and the destructive-case convention above, with the helper names.

## Verification
*(to be filled in on completion)*: the note names helpers and scripts that exist (check by grep), and `test/readme.test.ts` still passes if it checks links.

## Sign-Off
*(to be filled in on completion)*

## Disposition
Logged at mission 03 flight 05's debrief. Carry it to the next squawk turnaround.
