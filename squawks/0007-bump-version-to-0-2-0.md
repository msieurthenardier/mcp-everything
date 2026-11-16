# Squawk 0007: Bump the version to 0.2.0

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-15
**Completed**: 2026-11-15

## Report
The operator asked for a minor version bump for the work on this branch (sandbox idle timeout, the fork-failure fix, and the squawk turnaround): `0.1.0` to `0.2.0`. The version is stated in four places and all of them move together: the package manifest, the lockfile, and the two places the server and its proxy client announce themselves over MCP.

No tag exists in the repository, and none is created by this squawk; tagging and publishing are the operator's.

## Evidence
- `package.json` — `"version": "0.1.0"`
- `package-lock.json` — `"version": "0.1.0"` at the top level and under `packages[""]`
- `src/server.ts` — `{ name: "mcp-everything", version: "0.1.0" }` in the MCP `Server` constructor
- `src/proxy/mcp-proxy.ts` — `new Client({ name: "mcp-everything", version: "0.1.0" }, …)`
- No test or README text mentions `0.1.0`; `git tag` is empty

## Corrective Action
Changed the four literals from `0.1.0` to `0.2.0` by direct edit: `package.json`, `package-lock.json` (top level and `packages[""]` only), `src/server.ts` and `src/proxy/mcp-proxy.ts`. No `npm version`/`npm install`, no tag, no other change.

## Verification
No `0.1.0` remains in `package.json`, `package-lock.json`, `src/`, `test/` or `README.md`. The lockfile diff is exactly its two own-version lines; no dependency entry changed. `npm test`: 270 passed, 14 skipped. `npm run typecheck` and `npm run build`: clean. Both files parse and agree on `0.2.0`. No tag was created. Docker tests were not run; nothing here touches container behavior.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the diff
**Verdict**: confirmed
**Commit**: `squawk/0007: bump version to 0.2.0` on branch `sortie/01-sandbox-idle-timeout` (no separate squawk branch or pull request, by the operator's direction that this work stay on one branch)
