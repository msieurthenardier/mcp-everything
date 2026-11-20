# Squawk 0040: The id file's reader rejects Windows line endings, and a failed cleanup can fail a creation that succeeded

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-19

## Report
Two weaknesses in how `src/installation.ts` handles its file, both likely to show first on Windows, where one of the operator's two installations runs. **Inferred from the code** by the Architect at the [debrief of mission 02's flight 01](../missions/02-sandbox-ownership-on-a-shared-machine/flights/01-owned-sandboxes/flight-debrief.md); neither was run, and nothing in this project has run on Windows.

1. **Reading.** A valid file is the id with at most one trailing line feed. A file restored or written by hand with a Windows line ending (`\r\n`), or with a byte-order mark at its start, holds a valid id and is refused as invalid, which stops the process. The error for an invalid file tells the operator to restore it, which is how such a file comes to exist. Accept a byte-order mark before the id and a carriage return and line feed after it. Anything else stays invalid; the id is still never regenerated and the file is still never rewritten.
2. **Cleanup.** The temporary file is removed in a `finally` after the id file has been created. `force: true` ignores a missing file and nothing else, so a removal that fails because another program briefly holds the file (a scanner, on Windows) throws out of a creation that succeeded, and the process does not start. The next start finds the id file and works. A failed removal of the temporary file should not fail the load; the module's own sweep removes a stale one later.

## Evidence
- `src/installation.ts`, `parse` — `const body = content.endsWith("\n") ? content.slice(0, -1) : content; return INSTALLATION_ID_PATTERN.test(body) ? body : undefined;`.
- `src/installation.ts`, the invalid-file error — `"Restore it from a backup or, if no sandbox belongs to this data directory, delete it so a new one is made."`.
- `src/installation.ts`, the creation — `} finally { fs.rmSync(temp, { force: true }); }`.
- `test/installation.test.ts` has cases for nine characters, an uppercase character, a non-hexadecimal character and two line feeds; none for `\r\n` or a byte-order mark, and none where removing the temporary file fails.
- Read, not run.

## Corrective Action
`src/installation.ts` only.
1. `parse` now accepts one optional UTF-8 byte-order mark (U+FEFF) before the id and one line ending after it, either `\n` or `\r\n`. A lone `\r`, a second line ending, a byte-order mark anywhere else, whitespace, uppercase or any other character stays invalid. The id is still never regenerated and the file never rewritten.
2. The removal of the temporary file in the creation's `finally` is best effort: a failure (for example EBUSY) is swallowed, so it neither fails a creation that succeeded nor masks an earlier error. `sweepTemps` removes a stale leftover on a later load. A failure before the id file exists (opening the temporary file, writing it, the in-place fallback) still throws as before.

## Verification
- `test/installation.test.ts`: new cases accept `\r\n`, a BOM, BOM + `\n` and BOM + `\r\n` (file left untouched); new cases refuse a lone `\r`, `\r\n\r\n`, `\n\r\n`, a leading `\r`, two BOMs, a BOM after the id, a trailing space and an uppercase id with `\r\n` (immediately, file unchanged); new cases where removing the temporary file throws EBUSY: the load returns the new id and the file holds it, and a creation that failed earlier still reports its own error.
- Proved to bite: reverting the `parse` change failed the four accept cases; reverting the cleanup change failed both removal cases. Both reverts undone by editing.
- `npm run typecheck` clean; `npm test` passes (947 passed, 24 skipped).
- Not run on Windows.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the batch's diff. In a separate worktree with the whole change applied and `@types/node` 22.20.5 installed, it ran typecheck, the unit suite (950 passed, 24 skipped), the build, the built entry with an invalid setting and with an invalid id file (one line each, exit 1), and the Docker suite once (22 passed, 2 skipped; the operator's 15 containers the same before and after). It made trial changes to the source behind every new or changed test, each undone by editing; every one failed. The fork-pressure cases were not run: the watchdog script and default images are unchanged. For this squawk: the accepted and refused forms match the Report; dropping `\r\n` failed two accept cases and dropping the byte-order mark three; a rethrowing cleanup failed both removal cases; a failure before the id file exists still fails.
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-19-2` on branch `squawk/turnaround-2026-11-19-2`, with squawks 0026, 0027, 0028, 0030, 0032, 0033, 0038, 0040 and 0041.
