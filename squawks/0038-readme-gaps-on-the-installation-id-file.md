# Squawk 0038: The README leaves out three things about the installation id and `project_info`

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-19

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
README only. Under "Several installations on one Docker daemon": the opening paragraph now gives the id file's accepted form (id, optional one `\n` or `\r\n`, optional leading BOM), says an invalid file stops startup with one line and exit status 1, and states the cost of each remedy (restore keeps the sandboxes; delete gives a new id that owns none). A new item under "What this does not cover" describes a lost id file with the registry kept. The `project_info` paragraph now says it can take up to 30 seconds when the daemon hangs.

## Verification
- Form: `parse` in `src/installation.ts` (optional leading BOM, body, optional one `\n` or `\r\n`, tested against `^[0-9a-f]{8}$`); created file is `${id}\n`.
- Refusal and remedies: `invalid()` error text in `loadInstallationId`; `ConfigError` handling per squawk 0027 (one line, status 1, as stated in the brief); `loadInstallationId` never writes over an existing file, and creates a new id when the file is absent without comparing the registry.
- 30 s: `ownerLine` comment in `src/server.ts`; `docker.ownership` inspects with `30_000` ms in `src/sandbox/docker.ts` (lines 377, 403).
- README text was re-read against the neighbouring paragraphs for duplication and for the cross-reference.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the batch's diff. In a separate worktree with the whole change applied and `@types/node` 22.20.5 installed, it ran typecheck, the unit suite (950 passed, 24 skipped), the build, the built entry with an invalid setting and with an invalid id file (one line each, exit 1), and the Docker suite once (22 passed, 2 skipped; the operator's 15 containers the same before and after). It made trial changes to the source behind every new or changed test, each undone by editing; every one failed. The fork-pressure cases were not run: the watchdog script and default images are unchanged. For this squawk: every README statement checked against the code, including the 30 s inspect limit and the one-line exit from the built entry.
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-19-2` on branch `squawk/turnaround-2026-11-19-2`, with squawks 0026, 0027, 0028, 0030, 0032, 0033, 0038, 0040 and 0041.
