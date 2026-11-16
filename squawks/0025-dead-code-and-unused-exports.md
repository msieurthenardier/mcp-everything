# Squawk 0025: Two unused functions and six exports nothing imports

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-16

## Report
Two functions in `src/util/text.ts` are called from nowhere. Six other names are exported and used only inside their own file; no other source file and no test imports them. With no linter configured, nothing reports either. Finding 18a of the [2026-11-15 maintenance report](../maintenance/2026-11-15.md).

Delete the two functions. Drop the `export` keyword from the six. If a test for one of the six is wanted instead, that is a separate item, not this one.

## Evidence
- `src/util/text.ts` — `export function truncateMiddle(…)` and `export function shq(…)`: a search of `src/` and `test/` on 2026-11-16 finds no use of either beyond its definition.
- Exported, used only in the defining file: `NODE_LINES`, `PYTHON_LINES` (`src/install/toolchain.ts`); `searchGitHub`, `searchGitLab` (`src/forge/search.ts`); `publishedTools`, `scoreTool` (`src/server.ts`). Same search.

## Corrective Action
Repeated the search over `src/` and `test/` for all eight names before editing; results matched the evidence (no new users from earlier squawks in this batch, no references in template strings or shell scripts).
- `truncateMiddle`, `shq` (`src/util/text.ts`): deleted. The file had no imports, so none became unused.
- `NODE_LINES`, `PYTHON_LINES` (`src/install/toolchain.ts`): `export` dropped.
- `searchGitHub`, `searchGitLab` (`src/forge/search.ts`): `export` dropped.
- `publishedTools`, `scoreTool` (`src/server.ts`): `export` dropped.
Nothing else changed in those files.

## Verification
Ran `npm run typecheck`: clean. Ran `npx vitest run --testTimeout 20000`: 366 passed, 17 skipped (same as before the change). A search of `src/` and `test/` for `truncateMiddle` and `shq` finds nothing.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-16` (trailer `Squawks: 0008, 0009, 0010, 0011, 0012, 0014, 0015, 0016, 0017, 0018, 0019, 0020, 0021, 0022, 0023, 0024, 0025`) on branch `squawk/turnaround-2026-11-16`
