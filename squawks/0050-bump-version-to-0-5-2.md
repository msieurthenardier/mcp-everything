# Squawk 0050: Bump the version to 0.5.2

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-19
**Completed**: 2026-11-19

## Report
The operator asked for a patch version bump after the second turnaround of 2026-11-19 merged (#25): `0.5.1` to `0.5.2`. That turnaround changes runtime behavior since `v0.5.1` (startup errors print one line, a failed install closes proxied sessions, the connector removes its env file on a throw, the id file accepts a byte-order mark and `\r\n`, one wording for an unowned sandbox), so a build with it has to be distinguishable from the tagged one.

The version is stated in four places and all move together: the package manifest, the lockfile's two own-version lines, and the constant the server and its proxy client announce over MCP. Nothing else changes: no dependency version, no other line of the lockfile.

No tag is created by this squawk. Tagging `v0.5.2` on `main` is the operator's, or is done on the operator's word afterwards.

## Evidence
- `package.json` — `"version": "0.5.1"`
- `package-lock.json` — `"version": "0.5.1"` at the top level and in `packages[""]`
- `src/version.ts` — `export const VERSION = "0.5.1";`
- `test/version.test.ts`, "equals the version in package.json and in package-lock.json": fails if the four disagree
- `git tag` lists `v0.5.1`; `main` is at `624b786` (#25)

## Corrective Action
Changed the version from `0.5.1` to `0.5.2` in exactly four values: `package.json` line 3, `package-lock.json` line 3 (top level) and line 9 (`packages[""]`), and `src/version.ts` line 5 (`VERSION`). The lockfile lines were edited by hand, so no other line of it changed and no dependency was touched; `npm install`, `npm version` and `npm run build` were not run in this checkout. No tag was created.

## Verification
- Before editing: `grep -rn '0\.5\.1' README.md src test .github package.json` found only `package.json:3` and `src/version.ts:5` (plus `src/sandbox/docker.ts:116`, a comment about dash 0.5.12, unrelated); `grep -n '"version": "0.5.1"' package-lock.json` found lines 3 and 9 only.
- Test does its job: with only `src/version.ts` bumped, `npx vitest run test/version.test.ts` failed (1 failed). After the other three values were bumped, it passed (1 passed).
- `git diff --stat` for the three files: 3 files changed, 4 insertions, 4 deletions.
- `npm run typecheck`: clean.
- `npm test`: 950 passed, 24 skipped (22 files passed, 1 skipped).
- Built outside this checkout: a detached `git worktree` of HEAD with the three changed files copied in, `npm ci && npm run build`, then the built entry with `MCPE_DATA_DIR` set to a fresh `mktemp -d` directory and an `initialize` request on stdin: `serverInfo` is `{"name":"mcp-everything","version":"0.5.2"}`. The worktree was removed with `git worktree remove --force`; `git worktree list` shows only the main checkout. This checkout's `node_modules/` and `dist/` were not written.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the diff. It confirmed the diff is the four values and nothing else (no other lockfile line), found no other occurrence of the old version, showed `test/version.test.ts` failing with `src/version.ts` put back to `0.5.1` (restored by editing), and ran typecheck and the unit suite (950 passed, 24 skipped). It did not repeat the isolated build; the `serverInfo` result above is the Developer's record.
**Verdict**: confirmed
**Commit**: `squawk/0050: bump the version to 0.5.2` on branch `squawk/0050-bump-version-to-0-5-2`. No tag was created.
