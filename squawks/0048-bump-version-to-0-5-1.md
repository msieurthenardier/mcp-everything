# Squawk 0048: Bump the version to 0.5.1

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-17
**Completed**: 2026-11-17

## Report
The operator asked for a patch version bump with the turnaround of 2026-11-17: `0.5.0` to `0.5.1`. That turnaround repairs a regression in `v0.5.0` (squawk [0043](0043-library-line-on-stdout-for-a-server-without-tools-capability.md)) and a second fault in the same function (squawk [0044](0044-proxy-paging-loop-is-dead-under-the-v2-client.md)); the rest of it is tests and documentation. A build with the repair has to be distinguishable from the tagged one.

The version is stated in four places and all move together: the package manifest, the lockfile's two own-version lines, and the constant the server and its proxy client announce over MCP. Nothing else changes: no dependency version, no other line of the lockfile.

No tag is created by this squawk. Tagging `v0.5.1` on `main` is the operator's, or is done on the operator's word afterwards.

## Evidence
- `package.json` — `"version": "0.5.0"`
- `package-lock.json` — `"version": "0.5.0"` at the top level and in `packages[""]`
- `src/version.ts` — `export const VERSION = "0.5.0";`
- `test/version.test.ts`, "equals the version in package.json and in package-lock.json": fails if the four disagree
- `git tag` lists `v0.5.0` on `82faddc`

## Corrective Action
Changed the version from `0.5.0` to `0.5.1` in exactly four values: `package.json` line 3, `package-lock.json` line 3 (top level) and line 9 (`packages[""]`), and `src/version.ts` line 5 (`VERSION`). The lockfile lines were edited by hand, so no other line of it changed and no dependency was touched; `npm install` and `npm version` were not run. No tag was created.

## Verification
- Before editing: `grep -rn '0\.5\.0' README.md src test .github package.json` found only `package.json:3` and `src/version.ts:5`; `grep -n '"version": "0.5.0"' package-lock.json` found lines 3 and 9 only.
- Test does its job: with only `src/version.ts` bumped, `npx vitest run test/version.test.ts` failed (1 failed). After the other three values were bumped, it passed (1 passed).
- `git diff --stat` for the three files: 3 files changed, 4 insertions, 4 deletions; the lockfile diff is exactly lines 3 and 9.
- `npm run typecheck`: clean.
- `npm test`: 915 passed, 24 skipped (21 files passed, 1 skipped).
- `npm run build`, then `grep -n VERSION dist/version.js`: `5:export const VERSION = "0.5.1";`
- Built entry with `MCPE_DATA_DIR` set to a fresh `mktemp -d` directory, sent an `initialize` request: `serverInfo` is `{"name":"mcp-everything","version":"0.5.1"}`.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the batch's diff. It ran typecheck, the unit suite (915 passed, 24 skipped), the build, a real-pipe check of the built entry (every stdout line JSON; version `0.5.1`) and the Docker suite once (22 passed, 2 skipped, 210.8 s; the operator's four container ids the same before and after), and made sixteen trial changes to the source, each undone by editing. For this squawk it confirmed the diff is the four values and nothing else, and that `test/version.test.ts` fails when `src/version.ts` is put back to `0.5.0`.
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-17` on branch `squawk/turnaround-2026-11-17`, with squawks 0039 and 0043 to 0048. No tag was created.
