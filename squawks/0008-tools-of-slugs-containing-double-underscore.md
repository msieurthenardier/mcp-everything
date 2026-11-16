# Squawk 0008: Tools of a project whose slug contains `__` cannot be called

**Status**: open
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-15
**Completed**: —

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
*(written at completion)*

## Verification
Expected: a unit test that a tool of a project with a slug containing `__` is found and called, and a unit test that `makeSlug` no longer returns a slug containing `__` for the three inputs above. Registries written before the fix may already hold such a slug, so the lookup has to work for them whatever `makeSlug` does afterwards.

## Sign-Off
*(written at completion)*
