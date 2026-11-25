# Flight Log: Checking What a Build Installed

**Flight**: [Checking What a Build Installed](flight.md)

## Summary
Planned 2026-11-25. Not yet started.

---

## Reconnaissance Report

Items from earlier debriefs that touch this flight's scope, checked against `main` at `1034afb` on 2026-11-25.

| Item | Classification | Evidence | Recommendation |
|---|---|---|---|
| Flight 4 debrief, rec. 1a: the build-output volume goes through `classifySandbox` and `refuseUnless` | confirmed-live, reshaped | DD1 adds no new volume. The new Docker call that mounts the sandbox's volume for a scanner is the new surface; `requireVolumes` (`src/sandbox/docker.ts`) is the gate it goes through | Carried as DD8 |
| Flight 4 debrief, rec. 1b: a new way to obtain a `SandboxRef`, and the bypass tables updated in the same leg | confirmed-live | No new `SandboxRef` source is planned. The scanner method takes a volume name. `test/sources.ts` and `test/docker-bypass.test.ts` list the Docker calls | Carried as DD8, leg 2 |
| Flight 4 debrief, rec. 1c: decide what a reinstall does over a `before` sandbox | already-satisfied | `retireOldSandbox`, `src/install/installer.ts:676-686`: a `before` sandbox always has the old-style name, so `renamed` is true; the refusal is caught, the sandbox left in place, and `leftInPlaceWarning` added. Tested in `test/installer.test.ts` ("leaves it alone, builds under its own names…", the `before` volume case) | Retired; recorded in the flight's Open Questions. Presented to the operator at planning |
| Flight 4 debrief, rec. 5: call graph and normalized diff for split or move legs | not applicable | This flight has no split or move leg | None |
| Flight 4 debrief, action item: trim `mission.md`'s flight 5 entry of the old flight 4 text | confirmed-live | `mission.md`, Flights, flight 5 entry | Done at planning |
| Flight 3 debrief, rec. 3: state the in-process outbound path for a new stage | satisfied by design | The build stage calls no outside service from mcp-everything; a scanner's network is its own `network` and `hosts`, as at the source stage (DD4) | None |
| Flight 3 debrief, rec. 4: sample data shapes at planning | done | Python venv and Ruby gems through the symlink probed in throwaway containers on 2026-11-25 (flight Open Questions); Go and npm are installed by the Docker suite | None |
| Mission open question: "Moving build output onto a volume" | resolved here | DD1–DD3 | Check it off in `mission.md` when the flight lands |

Known from earlier debriefs, for this flight's runs:
- **Docker suite:** about 670–725 s.
- **One intermittent unit failure** has not been named (flight 4 debrief, recommendation 4). Note any failure's name if it recurs.
- **The CI floor** is still 867 passing tests (squawk 0062, open).

---

## Leg Progress

---

## Decisions

---

## Deviations

---

## Anomalies

---

## Session Notes

### Flight Director Notes
- **2026-11-25, planning.** The operator asked for the smallest shape ("I don't want to over engineer it"). They chose:
  - accepting a build-stage block on a reinstall;
  - moving Ruby gems too;
  - no HAT.
- **2026-11-25, premise checks.** The Flight Director's own containers, run with `--rm` and anonymous volumes. Volume and container lists were the same before and after.
- **2026-11-25, design review 1** (Architect, Sonnet): approve with changes. All applied.
  - **High: a build-stage block is undone by `discover_tools`.** It has no status gate, and `finish()` sets the record `ready`. The server's own advice suggests that path. Confirmed by the FD in `src/server.ts` and `src/install/installer.ts`. This became DD10.
  - **Medium:** applied as follows.
    - The build stage's working directory is `/scan`, not `/scan/repo` (DD4).
    - The source stage gets only source-stage scanners (DD4).
    - `runScanner` picks the role from `spec.stage` (DD4, DD8).
    - `securityLine` gives the build stage's counts, and says when the build output was not checked (DD7).
  - **Low:** applied as follows.
    - The prelude's sequence is pinned (DD1).
    - The block branch keeps the build's refusal warnings (DD6).
    - Four limits were added (DD9).
    - The retry test proves the clearing.
  - **Not applied: splitting leg 2.** That would split by task type.
  - **Kept: `unreachableBlock`.** Its behavior is now stated deliberately.
  - **Answers to the Architect's questions:**
    - a `warn` finding needs no extra warning, because the `security:` line carries the counts;
    - the job display stays "installing" during the build stage.
- **2026-11-25, design review 2** (Architect, Sonnet): approve with changes. All applied. This is the second and last review cycle.
  - **Medium:**
    - DD10's check moved into the installer: `assertNotBlocked` at the top of `rediscover`, `refreshMcp`, `connectMcp` and `disconnectMcp`.
    - The server instruction at `src/server.ts:39` is added to the text that changes.
  - **Low:**
    - `ScannerSpec.stage` is optional, and absent means `source`.
    - DD5 skips the stage when `record.scan` is unset.
  - **Question answered:** `set_project_network` on a blocked project stays allowed (DD10).
- **Status → `ready`**, pending the operator's approval of the spec.
