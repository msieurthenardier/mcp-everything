# Squawk 0041: A sandbox from before ownership is worded two ways, and an owner label is cut to two lengths

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-19

## Report
Three places put a sandbox's class into words for the operator, and they do not agree. A refusal from the Docker layer says a sandbox "is from before sandboxes had owners". The installer's warnings and the `project_info` line say it "was made before ownership was recorded". An operator who reads a refusal and then asks `project_info` sees two descriptions of one state. The same three places cut a shown owner label to 64, 40 and 40 characters, so the same label can appear whole in one message and cut in another. Found by both interviews of the [debrief of mission 02's flight 01](../missions/02-sandbox-ownership-on-a-shared-machine/flights/01-owned-sandboxes/flight-debrief.md).

Use one wording for the state and one length for a shown owner label. "Was made before ownership was recorded" is the wording in two of the three places and in the README. Text only: which class a sandbox is given, and what is done about it, do not change. Tests that quote the changed words change with them.

## Evidence
- `src/sandbox/docker.ts`, `describeFacts` — `` `${what} is from before sandboxes had owners (treated as this installation's${project})` ``; labels through `clean`, which is `oneLine(v, LABEL_MAX)` with `LABEL_MAX = 64`. Also `createContainer`'s `` `Volume … is from before sandboxes had owners; it cannot hold a new container` ``.
- `src/install/installer.ts`, `describeLeftPart` — `` `${what} was made before ownership was recorded` ``; the owner through `oneLine(f.owner ?? "", OWNER_SHOWN)` with `OWNER_SHOWN = 40`.
- `src/server.ts`, `ownerLine` — `` `… was made before ownership was recorded; it is treated as this installation's.` ``; the owner through `oneLine(r.owner ?? "", 40)`.
- Read, not run.

## Corrective Action
One wording and one owner length, text only; no class or handling changed.
- `src/sandbox/docker.ts`: `describeFacts` now says `... was made before ownership was recorded (treated as this installation's...)` and `createContainer` says `Volume ... was made before ownership was recorded; it cannot hold a new container` (was "is from before sandboxes had owners"). The doc comment on `classifySandbox` is reworded to match. New exported `OWNER_SHOWN = 64`; `describeFacts` cuts the owner with `oneLine(f.owner ?? "", OWNER_SHOWN)`. `LABEL_MAX` stays at 64 for every other text from Docker (sandbox names, project labels, messages), so only the owner cut is shared.
- `src/install/installer.ts`: the local `OWNER_SHOWN = 40` is removed; it imports the shared one.
- `src/server.ts`: `ownerLine` imports `OWNER_SHOWN` in place of the literal 40.
- 64 was chosen because it is the Docker layer's existing bound and is at least as long as any installation id, so a real owner label is never cut.
- Tests: `test/docker.test.ts` updated to the new wording.

## Verification
- `npm run typecheck` clean; `npm test` 950 passed, 24 skipped.
- New cases cut a 300-character owner label and expect `OWNER_SHOWN - 1` characters plus an ellipsis in a Docker-layer refusal (`test/docker.test.ts`), an installer warning (`test/installer.test.ts`) and `project_info` (`test/server.test.ts`).
- Proved to bite: with the `server.ts` cut set back to 40 the `project_info` case failed; with the `docker.ts` cut set back to 40 the Docker case failed; with the old "from before sandboxes had owners" phrase restored in `createContainer` the volume-message test failed. Each undone by editing.
- `grep` of `src/`, `test/` and `README.md` finds no "before sandboxes had owners" left.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the batch's diff. In a separate worktree with the whole change applied and `@types/node` 22.20.5 installed, it ran typecheck, the unit suite (950 passed, 24 skipped), the build, the built entry with an invalid setting and with an invalid id file (one line each, exit 1), and the Docker suite once (22 passed, 2 skipped; the operator's 15 containers the same before and after). It made trial changes to the source behind every new or changed test, each undone by editing; every one failed. The fork-pressure cases were not run: the watchdog script and default images are unchanged. For this squawk: no "before sandboxes had owners" phrasing remains in `src/`, `test/` or `README.md`, and `LABEL_MAX`'s other uses are unchanged. The installer's owner-cut case, which the Developer had not mutated, was: a cut of 40 failed it, as the same change did in `server.ts` and `docker.ts`.
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-19-2` on branch `squawk/turnaround-2026-11-19-2`, with squawks 0026, 0027, 0028, 0030, 0032, 0033, 0038, 0040 and 0041.
