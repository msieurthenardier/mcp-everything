# Squawk 0042: Bump the version to 0.4.0

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-16

## Report
The operator asked for a minor version bump after [mission 02](../missions/02-sandbox-ownership-on-a-shared-machine/mission.md) merged (pull request #17, `a7eabc0`): `0.3.0` to `0.4.0`. Since the tag `v0.3.0` the product has gained behavior an operator sees: sandboxes are named and labelled with their installation's id, an operation on another installation's sandbox is refused, `list_projects` and `project_info` print new lines, and mission 01 changed what a failed or interrupted install leaves behind. The version a server announces is also how the operator can tell that both installations on a machine run a build with the ownership check.

The version is stated in four places and all move together: the package manifest, the lockfile's two own-version lines, and the constant the server and its proxy client announce over MCP. Nothing else changes: no dependency version, no other line of the lockfile.

No tag is created by this squawk. Tagging `v0.4.0` on the bump's commit on `main` is the operator's, or is done on the operator's word afterwards. Squawk [0040](0040-id-file-reader-rejects-windows-line-endings.md) is not part of this; it follows.

## Evidence
- `package.json` — `"version": "0.3.0"`
- `package-lock.json` — `"version": "0.3.0"` at the top level (line 3) and in `packages[""]` (line 9); no other line of the file holds `"version": "0.3.0"`
- `src/version.ts` — `export const VERSION = "0.3.0";`, used by `src/server.ts` (the MCP `Server`) and `src/proxy/mcp-proxy.ts` (the proxy `Client`)
- `test/version.test.ts`, "equals the version in package.json and in package-lock.json": fails if the four disagree
- No test, README text or workflow mentions `0.3.0` (searched `README.md`, `src/`, `test/`, `.github/`); `git tag` lists `v0.2.0` and `v0.3.0`

## Corrective Action
Changed the version from `0.3.0` to `0.4.0` in exactly four values: `package.json` line 3, `package-lock.json` line 3 (top level) and line 9 (`packages[""]`), and `src/version.ts` line 5 (`VERSION`). The lockfile lines were edited by hand, so no other line of it changed and no dependency was touched; `npm install` and `npm version` were not run. No tag was created.

## Verification
- Before the search: `grep -rn '0\.3\.0' README.md src test .github package.json` found only `package.json:3` and `src/version.ts:5`; the lockfile holds it on lines 3 and 9 only.
- Test does its job: with only `src/version.ts` bumped, `npx vitest run test/version.test.ts` failed (`expect(VERSION).toBe(pkg.version)`, 1 failed). After the other three values were bumped, it passed (1 passed).
- `npm run typecheck`: clean.
- `npm test -- --testTimeout=20000`: 833 passed, 24 skipped (19 files passed, 1 skipped).
- `npm run build`, then `grep -n 'VERSION' dist/version.js`: `5:export const VERSION = "0.4.0";`
- `git diff --stat`: 3 files changed, 4 insertions, 4 deletions. `git diff -- package-lock.json`: exactly two lines changed (lines 3 and 9).

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the diff. It confirmed the diff is the four values and nothing else, parsed the lockfile and ran `npm ls --depth=0`, searched for any other statement of the version, ran typecheck, the unit suite (833 passed, 24 skipped) and the build, and showed the guard failing by changing `VERSION` back and running `test/version.test.ts`, then undid that by editing.
**Verdict**: confirmed
**Commit**: `squawk/0042: bump the version to 0.4.0` on branch `squawk/0042-bump-version-to-0-4-0`
