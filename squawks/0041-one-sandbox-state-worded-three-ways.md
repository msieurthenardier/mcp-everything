# Squawk 0041: A sandbox from before ownership is worded two ways, and an owner label is cut to two lengths

**Status**: open
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: —

## Report
Three places put a sandbox's class into words for the operator, and they do not agree. A refusal from the Docker layer says a sandbox "is from before sandboxes had owners". The installer's warnings and the `project_info` line say it "was made before ownership was recorded". An operator who reads a refusal and then asks `project_info` sees two descriptions of one state. The same three places cut a shown owner label to 64, 40 and 40 characters, so the same label can appear whole in one message and cut in another. Found by both interviews of the [debrief of mission 02's flight 01](../missions/02-sandbox-ownership-on-a-shared-machine/flights/01-owned-sandboxes/flight-debrief.md).

Use one wording for the state and one length for a shown owner label. "Was made before ownership was recorded" is the wording in two of the three places and in the README. Text only: which class a sandbox is given, and what is done about it, do not change. Tests that quote the changed words change with them.

## Evidence
- `src/sandbox/docker.ts`, `describeFacts` — `` `${what} is from before sandboxes had owners (treated as this installation's${project})` ``; labels through `clean`, which is `oneLine(v, LABEL_MAX)` with `LABEL_MAX = 64`. Also `createContainer`'s `` `Volume … is from before sandboxes had owners; it cannot hold a new container` ``.
- `src/install/installer.ts`, `describeLeftPart` — `` `${what} was made before ownership was recorded` ``; the owner through `oneLine(f.owner ?? "", OWNER_SHOWN)` with `OWNER_SHOWN = 40`.
- `src/server.ts`, `ownerLine` — `` `… was made before ownership was recorded; it is treated as this installation's.` ``; the owner through `oneLine(r.owner ?? "", 40)`.
- Read, not run.

## Corrective Action
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
