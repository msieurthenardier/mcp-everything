# Squawk 0038: The README leaves out three things about the installation id and `project_info`

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: —

## Report
The README's section "Several installations on one Docker daemon" was read against the code at `df7fa8d` by both interviews of the [debrief of mission 02's flight 01](../missions/02-sandbox-ownership-on-a-shared-machine/flights/01-owned-sandboxes/flight-debrief.md). What it says is accurate. Three things are missing:

1. **A refused `installation-id` file.** The process stops when the file exists and does not hold a valid id, and the error says to restore it or delete it. The README says only that the file is never rewritten. Say that the file must hold exactly eight lowercase hexadecimal characters and at most one line feed, that an invalid one stops startup, and what each remedy costs: a restored id keeps the installation's sandboxes; a deleted file gives a new id that owns none of them.
2. **A lost id file with the registry kept.** The README covers a registry copied without its id file. Deleting or losing the id file in place has the same result and is not named: a new id is made at the next start, every project made since ownership was recorded is then refused, an uninstall leaves its sandbox and a reinstall builds beside it. The commands already in that section find the sandboxes left behind.
3. **`project_info` can wait.** It asks Docker one question and never fails because of it, as the README says; when the daemon hangs, the answer can take up to 30 seconds.

README only. If squawk [0040](0040-id-file-reader-rejects-windows-line-endings.md) is completed first, describe the file's form as that fix leaves it.

## Evidence
- `src/installation.ts`, `parse` and the invalid-file error — `"Restore it from a backup or, if no sandbox belongs to this data directory, delete it so a new one is made."`.
- `src/installation.ts`, `loadInstallationId` — a missing file is created with a new id; nothing compares it with the names in the registry.
- `src/server.ts`, the comment on `ownerLine` — `"The inspect has a 30 s limit, so a daemon that hangs can delay project_info by that long."`.
- `README.md`, "Several installations on one Docker daemon" — "never rewritten"; the copied-registry limit under "What this does not cover"; "It never fails because of that question."

## Corrective Action
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
