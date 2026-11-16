# Squawk 0007: Bump the version to 0.2.0

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-15
**Completed**: —

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
*(written at completion)*

## Verification
*(written at completion)* Expected: no `0.1.0` left in `package.json`, `package-lock.json`, `src/` or `test/`; no dependency entry in the lockfile changed; `npm test`, `npm run typecheck` and `npm run build` pass.

## Sign-Off
*(written at completion)*
**Reviewer**:
**Verdict**:
**Commit**:
