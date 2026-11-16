# Squawk 0022: Three tool schemas do not state limits their handlers enforce

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-16

## Report
A caller learns a tool's limits from its schema descriptions. Three limits are enforced by the handlers and stated nowhere a caller can see, and one parameter has no description at all. Other tools already do this properly (`sandbox_exec` says "max 3600"). Finding 15 of the [2026-11-15 maintenance report](../maintenance/2026-11-15.md).

Description text only; no handler changes.

## Evidence
- `install_project.timeout_seconds` — schema: "Build time limit (default 900)."; handler: `num(args, "timeout_seconds", 900, 30, 7200)`.
- `sandbox_read_file.max_bytes` — schema: "Read at most this many bytes (default 100000)."; handler: `num(args, "max_bytes", 100_000, 1, 2_000_000)`.
- `sandbox_write_file.content` — handler: `if (content.length > 5_000_000) throw new ToolInputError("content is larger than 5 MB")`; the schema does not mention a size.
- `set_project_network.enabled` — no description.
- All in `src/server.ts` (`META_TOOLS` and `App.callMeta`). Read.

## Corrective Action
Description strings only, in `META_TOOLS` in `src/server.ts`. Each number was checked against `App.callMeta`; `num()` clamps silently, so descriptions state limits as min/max rather than as rejections.
- `install_project.timeout_seconds`: "Build time limit in seconds (default 900, min 30, max 7200)."
- `sandbox_read_file.max_bytes`: "Read at most this many bytes (default 100000, max 2000000)."
- `sandbox_write_file.content`: "File contents (up to 5000000 characters)." (the handler checks `content.length`, i.e. characters)
- `set_project_network.enabled`: "true to allow outbound network access, false to cut it off."
- Same omission found and fixed: `install_project.wait_seconds` is clamped to 0..3600 by the handler; now "How long this call waits for the build, in seconds (default 600, max 3600)."

## Verification
Ran `npx vitest run --testTimeout 20000` and `npm run typecheck` : 364 passed, 17 skipped; typecheck clean. No test or README text pinned the old descriptions; neither was changed.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff
**Verdict**: confirmed; description strings only, each number checked against its handler
**Commit**: `squawk: turnaround 2026-11-16` (trailer `Squawks: 0008, 0009, 0010, 0011, 0012, 0014, 0015, 0016, 0017, 0018, 0019, 0020, 0021, 0022, 0023, 0024, 0025`) on branch `squawk/turnaround-2026-11-16`
