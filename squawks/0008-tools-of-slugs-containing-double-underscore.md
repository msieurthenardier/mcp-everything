# Squawk 0008: Tools of a project whose slug contains `__` cannot be called

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-15
**Completed**: 2026-11-16

## Report
A generated tool is named `<slug>__<tool>`, and the server finds the project of a tool by splitting the tool's name at its first `__`. `makeSlug` can return a slug that itself contains `__`. For such a project the lookup finds no project, and every generated tool of it fails with `Unknown tool`.

It takes a slug collision, or a generic repository name with a long owner, plus a `_` landing on the cut position, so it is rare. Found while planning [sortie 03](../sorties/03-mcp-env-passthrough/flight.md), outside its charter; sortie 03 matches variables from the known slug and does not depend on this being fixed.

To reproduce: install two repositories named `abc-defghij-klmnop` from different owners, then call any generated tool of the second.

## Evidence
- `src/server.ts:App.findGenerated` — `const slug = name.split("__")[0] ?? "";` followed by `this.registry.get(slug)`.
- `src/toolgen/naming.ts:makeSlug` — three places append `_` to a sliced string that may already end in `_`. Run on 2026-11-15 against `dist/toolgen/naming.js` (built after the last change to the source), Node v22.22.0, one call each:
  - `makeSlug("abc-defghij-klmnop", "owner2", taken)` with `abc_defghij_klmnop` taken returns `abc_defghij__owner`.
  - `makeSlug("cli", "abcdefghijk-lm", () => false)` returns `abcdefghijk__cli`.
  - `makeSlug("abcdefghijklm-nop", "owner", taken)` with `abcdefghijklm_nop` and `abcdefghijkl_owner` taken returns `abcdefghijklm__2`.
- The failing tool call itself was read from the code, not run.

## Corrective Action
- `App.findGenerated` (`src/server.ts`) now resolves the project as the one with the longest slug the tool name starts with (`<slug>__`), the same ownership rule as host variables (`ownedVariables`), instead of splitting at the first `__`. It works for slugs already in registries, whatever `makeSlug` does. Review follow-up: when one slug prefixes another (`abc` and `abc__def`), the longest-slug rule sent `abc__def__x`, a tool of `abc`, to `abc__def`. The lookup now takes the candidates (projects whose `<slug>__` prefixes the name), prefers, longest slug first, one whose tools contain the name, and otherwise keeps the longest slug, so the "Unknown tool" message is unchanged and projects without a prefix clash resolve as before. Not changing the split to the last `__` because truncated tool names (hash or `_N` suffix) can themselves end up containing `__`.
- `makeSlug` (`src/toolgen/naming.ts`) cuts through a new `cut` helper that drops trailing `_` after slicing. This covers the three places in the report and a fourth found on the way (the generic-name owner prefix, which is what produced `abcdefghijk__cli`). Only new slugs are affected; no stored slug or registry format changes.

## Verification
Added `test/server.test.ts` "tool lookup" (a project seeded with slug `abc__def`: its tool is found and executed directly and through `call_project_tool`) and `test/naming.test.ts` (the three Evidence inputs give `abc_defghij_owner`, `abcdefghijk_cli`, `abcdefghijklm_2`, none containing `__`). With the fix reverted both new tests failed; with it, `npx vitest run --testTimeout 20000` gave 342 passed, 16 skipped (was 340 passed, 16 skipped) and `npm run typecheck` was clean.

Review follow-up: a second `test/server.test.ts` case seeds `abc` (tool `abc__def__x`) and `abc__def` (tool `abc__def__build`); both calls succeed and run in their own project's container. Full suite and typecheck are recorded in the 0019 follow-up run (395 passed, 17 skipped; typecheck clean).

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff
**Verdict**: confirmed. The first review noted that with one slug a prefix of another (`abc`, `abc__def`) a tool could resolve to the wrong project; fixed in the same turnaround (prefer the project that owns the name) and re-reviewed
**Commit**: `squawk: turnaround 2026-11-16` (trailer `Squawks: 0008, 0009, 0010, 0011, 0012, 0014, 0015, 0016, 0017, 0018, 0019, 0020, 0021, 0022, 0023, 0024, 0025`) on branch `squawk/turnaround-2026-11-16`
