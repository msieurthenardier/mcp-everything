# Squawk 0023: A second `install_project` for a running install drops its options without saying so

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-16

## Report
When `install_project` is called for a repository whose install is still running, the server attaches the call to the running job. That is right. But the second call's `network`, `image`, `ref`, `ecosystem` and `reinstall` are dropped, and the response reads as if the call had been honored. A caller that asked for `network: false` the second time gets the first call's setting and is not told. Finding 16 of the [2026-11-15 maintenance report](../maintenance/2026-11-15.md).

Response text only: when a call joins a running job, say that it joined an install already in progress and that the options of this call were not applied. Do not change which job runs.

## Evidence
- `src/server.ts:App.callMeta`, case `install_project` — `let job = this.jobs.get(key); if (!job) { … this.installer.install({ repo, … }) … }`; the options are parsed before the lookup and used only inside the `if`.
- Read, not run.

## Corrective Action
In `src/server.ts`, case `install_project`, a `joined` flag records whether a job already existed for the repository when the call arrived. A joining call now prefixes its result with a notice, in all three shapes (still installing after the wait, finished ready, finished with failure): "Note: <repo> was already being installed, so this call joined that install. Its options (other than wait_seconds) were not applied; the running install keeps the ones it started with. To change them, wait for it to finish, then call install_project again with reinstall: true." `wait_seconds` is excepted because it applies per call. The job tracker, `Job` type and which job runs are unchanged; no option values are compared. The tool description and README say nothing about re-calling during a build, so neither changed.

## Verification
Added `install_project joining a running install` (2 cases) in `test/server.test.ts`, with the installer stubbed behind a gate: a first call returns "Still installing" without the notice; a second call while it runs carries it (still-installing and finished-ready shapes); a joiner of an install that fails carries it and the starter does not; the installer is called once. With the fix disabled both cases failed; with it they pass. `npx vitest run --testTimeout 20000`: 366 passed, 17 skipped (was 364). `npm run typecheck`: clean.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-16` (trailer `Squawks: 0008, 0009, 0010, 0011, 0012, 0014, 0015, 0016, 0017, 0018, 0019, 0020, 0021, 0022, 0023, 0024, 0025`) on branch `squawk/turnaround-2026-11-16`
