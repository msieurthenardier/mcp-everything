# Squawk 0013: Bump the version to 0.3.0

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-15
**Completed**: 2026-11-15

## Report
The operator asked for a minor version bump for the work on this branch ([sortie 03](../sorties/03-mcp-env-passthrough/flight.md): `{slug}__{NAME}` variables for proxied MCP servers and the new `refresh_mcp` tool): `0.2.0` to `0.3.0`. The version is stated in four places and all of them move together: the package manifest, the lockfile's two own-version lines, and the two places the server and its proxy client announce themselves over MCP.

The lockfile also holds a dependency whose own version happens to be `0.2.0`; that line is not ours and must not change. The tag `v0.2.0` exists; no tag is created by this squawk. Tagging and publishing are the operator's.

## Evidence
- `package.json` — `"version": "0.2.0"`
- `package-lock.json` — `"version": "0.2.0"` at the top level (line 3) and under `packages[""]` (line 9). A third occurrence at line 1440 belongs to a dependency entry.
- `src/server.ts` — `{ name: "mcp-everything", version: "0.2.0" }` in the MCP `Server` constructor
- `src/proxy/mcp-proxy.ts` — `new Client({ name: "mcp-everything", version: "0.2.0" }, …)`
- No test or README text mentions `0.2.0` (searched `test/` and `README.md`); `git tag` lists `v0.2.0`

## Corrective Action
Changed `0.2.0` to `0.3.0` by direct line edit in five lines across four files: `package.json` (line 3), `package-lock.json` (lines 3 and 9, our own version only), the MCP `Server` constructor in `src/server.ts`, and the proxy `Client` in `src/proxy/mcp-proxy.ts`. Edited by hand rather than with `npm version` or `npm install` so the lockfile is not rewritten and no tag or commit is created; the `forwarded` dependency entry at line 1440 stays at `0.2.0`.

## Verification
- `git diff` of `package-lock.json`: exactly two changed lines (3 and 9), both our own version.
- `package.json` and `package-lock.json` parse as JSON; top-level and `packages[""]` versions all read `0.3.0`.
- Search for `0.2.0`: nothing in `package.json`, `src/`, `test/` or `README.md`; in `package-lock.json` only the `forwarded` dependency entry (line 1440, plus its resolved URL and a dependents reference).
- `npx vitest run --testTimeout 20000`: 340 passed, 16 skipped.
- `npm run typecheck` and `npm run build`: clean.
- No tag created; Docker suites not run (no container behavior touched).

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the diff
**Verdict**: confirmed
**Commit**: `squawk/0013: bump version to 0.3.0` on branch `sortie/03-mcp-env-passthrough` (no separate squawk branch or pull request: the bump ships with the work it is for, in pull request #4, as the bump to 0.2.0 did with sortie 01)
