# Squawk 0040: The id file's reader rejects Windows line endings, and a failed cleanup can fail a creation that succeeded

**Status**: open
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: —

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
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
