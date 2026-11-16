# Squawk 0021: The version is written out in three places

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-16

## Report
The version appears as a literal in the package manifest and in the two places the server and its proxy client announce themselves over MCP. Two bumps so far (squawks 0007 and 0013) each had to find all of them by hand. One missed, and the version a client is told disagrees with the package. Finding 12 of the [2026-11-15 maintenance report](../maintenance/2026-11-15.md).

Keep one constant in `src/` that both announcements use, and one test that it equals the version in `package.json`, so a bump that forgets it fails. A constant is suggested over reading `package.json` at run time because the build's `rootDir` is `src`.

## Evidence
- `package.json:3` — `"version": "0.3.0"`
- `src/server.ts` — `{ name: "mcp-everything", version: "0.3.0" },` in the MCP `Server` constructor
- `src/proxy/mcp-proxy.ts` — `new Client({ name: "mcp-everything", version: "0.3.0" }, { capabilities: {} })`
- `tsconfig.build.json` — `"rootDir": "src"`

## Corrective Action
Added `src/version.ts` exporting `VERSION = "0.3.0"`; `src/server.ts` (MCP `Server`) and `src/proxy/mcp-proxy.ts` (proxy `Client`) now use it. Added `test/version.test.ts`, which reads `package.json` and `package-lock.json` (top level and `packages[""]`) and asserts all equal `VERSION`. A constant rather than a run-time read of `package.json`, since the build's `rootDir` is `src` and only `dist` ships. Version unchanged; `package.json` and lockfile untouched. No docs describe bumping, so none changed.

## Verification
Temporarily set the constant to 9.9.9: the new test failed (expected '9.9.9' to be '0.3.0'); restored. `npx vitest run --testTimeout 20000`: 364 passed, 17 skipped (was 363). `npm run typecheck` clean. `tsc -p tsconfig.build.json` to a fresh temp directory compiled; directory deleted. A search of `src/` for `0.3.0` finds only `src/version.ts`.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-16` (trailer `Squawks: 0008, 0009, 0010, 0011, 0012, 0014, 0015, 0016, 0017, 0018, 0019, 0020, 0021, 0022, 0023, 0024, 0025`) on branch `squawk/turnaround-2026-11-16`
