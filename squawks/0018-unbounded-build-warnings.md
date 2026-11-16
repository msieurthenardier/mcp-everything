# Squawk 0018: The number of warnings taken from build output has no limit

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-16

## Report
Every line a build prints in the form `MCPE_WARN <message>` becomes a project warning. Each is cut to 300 characters; their number is not limited, and the output they are taken from can be several megabytes. The recipes print these lines, and so can anything the untrusted build runs. All of them are stored in the registry and printed by `install_project`, `project_info` and `list_projects`, so a repository can flood the client and the registry file. Finding 10 of the [2026-11-15 maintenance report](../maintenance/2026-11-15.md).

Keep the first 20 and add one line saying how many more were dropped.

## Evidence
- `src/install/installer.ts:Installer.install` — `const warnings = [...text.matchAll(/^MCPE_WARN (.+)$/gm)].map((m) => cleanTerminalText(m[1]!).slice(0, 300));`
- `src/install/recipes.ts` — `warn() { echo "MCPE_WARN $*"; }`, the intended source.
- Read, not run.

## Corrective Action
In `Installer.install` (`src/install/installer.ts`), the build-output warnings are now capped at the new constant `MAX_BUILD_WARNINGS = 20`; the rest are replaced by one line, "N more build warnings were dropped." The line is added after the cut, so it is not counted among the 20. Only the last image attempt's warnings are stored (an earlier failed attempt contributes just its first warning to the rebuild note), so the cap applies to each attempt on its own and at most 21 lines are stored per install. The line is unique, so the later de-duplication does not affect it. README states nothing about a warning limit; unchanged.

## Verification
Added a case to `test/installer.test.ts`: a build printing 100 `MCPE_WARN` lines gives 20 warnings plus "80 more build warnings were dropped." With the cap raised to 1000 the case failed; with 20 it passes. `npx vitest run --testTimeout 20000`: 351 passed, 17 skipped (was 350); `npm run typecheck` clean. Existing warning tests unchanged.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-16` (trailer `Squawks: 0008, 0009, 0010, 0011, 0012, 0014, 0015, 0016, 0017, 0018, 0019, 0020, 0021, 0022, 0023, 0024, 0025`) on branch `squawk/turnaround-2026-11-16`
