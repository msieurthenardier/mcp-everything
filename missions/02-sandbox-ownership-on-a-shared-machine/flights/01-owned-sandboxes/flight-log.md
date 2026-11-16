# Flight Log: Owned Sandboxes

**Flight**: [Owned Sandboxes](flight.md)

## Summary
Logged on 2026-11-16 as sortie 04, "Ownership on a Shared Machine", to be picked up after mission 01. Picked up the same day, escalated to [mission 02](../../mission.md), and moved here as its first flight. Not designed: no objective, decisions or legs yet.

### Flight Director Notes
- 2026-11-16: The operator, on merging flight 02 of mission 01: "Log the sortie we can pick it up after this mission, we need to account for multiple agentic systems working on the same machine, so owner, unique ids, location of registry, etc." This is the design work mission 01 set aside (inspection findings 1b, 2 and 3), widened by the operator to several agentic systems on one machine.
- Logged with `/mission-control:sortie` as far as creating the artifact. The skill's qualification gate was checked and two criteria are in doubt ("fits one flight", "no cross-cutting architecture change"). The skill says to stop and recommend a mission when a criterion fails. It was logged as a sortie anyway because the operator asked for exactly that, nothing is being planned yet, and the doubt is written at the top of the artifact with the instruction to re-check at pickup and escalate if it fails. The charter gate and flight design have not been run.

- 2026-11-16, later: the flight 03 debrief and the mission 01 debrief each added inputs to the artifact. The mission debrief's Architect judged this a mission, not a sortie, agreeing with the doubt recorded above; the artifact now says to escalate before planning. Still not planned, and the charter is still a draft.

- 2026-11-16, pickup and escalation. Prerequisites were met (mission 01 completed; squawks 0034 and 0036 completed). The qualification gate was re-checked against the draft charter and the code, and three criteria failed:
  - **One cluster of design decisions**: failed. Owner identity, project ids, where the registry lives and its defaults, liveness, and variables and sharing are separate clusters, with a format migration besides.
  - **Fits one flight**: failed. The mission 01 debrief's Architect had sketched five flights for the charter as drafted.
  - **No cross-cutting architecture change**: failed. The slug is the identity in seven source files, and the draft needed a registry format version 2 and changed defaults.

  The operator agreed to escalate (`/mission-control:sortie escalate 04`). No code had been written, so the artifact was moved, not copied.
- What the mission interview found. The operator's real case is two installations on one machine (one inside WSL, one on Windows), with registries in different places that cannot see each other, sharing one Docker daemon and one set of container names. That is narrower than the draft charter and has a different centre: the only state the two share is Docker, so ownership has to be on the sandbox. The operator decided: an owner is an installation; separate sandboxes with no sharing; existing projects keep working; protection against accidents. Coordination between sessions on one registry, slug identity over time, and sharing were left out. The Architect's viability check (feasible with caveats, Docker not run) found that the registry's format need not change and that no restructuring is needed, and weakened two criteria. The mission was agreed with two flights and no alignment flight.
- What moved. `sorties/04-ownership-on-a-shared-machine/` became `missions/02-sandbox-ownership-on-a-shared-machine/flights/01-owned-sandboxes/` with `git mv`. In `flight.md` the charter was replaced by the mission link and the criteria this flight contributes to, the title changed to match the flight's scope, and the open questions were sorted into this flight's and those set aside. Four links to the old path were repointed (mission 01's `mission.md`, flight 02's flight log, squawk 0036, the maintenance report); the words "sortie 04" in mission 01's artifacts are left as written, since they were true when written.
- Sortie number 04 was this artifact. The `sorties/` directory now ends at 03, so a scan for the next number would give 04 again; the next sortie should take 05 so that "sortie 04" in mission 01's records keeps one meaning.

---

## Reconnaissance Report
2026-11-16, at flight design, by the Flight Director. Sources: finding 3 and 3a of the maintenance report of 2026-11-15; the Architect's viability report for mission 02 (its claims about the code, which it marked as read and not run); the inputs carried in the flight artifact. Each row was checked against the code at `412be5f`. "Read" means the cited lines were read; "ran" means a command was run. The only commands run were read-only: `docker version`, `docker ps -a` and `docker volume ls` filtered on the label, and a listing of slug, container name and status from the two registries.

| Item | Classification | Evidence | Recommendation |
|------|----------------|----------|----------------|
| R1. Finding 3: only removal checks ownership, and it checks the generic label | confirmed-live | Read: `src/sandbox/docker.ts:411-418` (`removeContainer`), `424-434` (`destroy`); both compare `mcp-everything` to `1` | In scope |
| R2. Finding 3: `exec`, start and the hand-off of variables act on whatever has the name | confirmed-live | Read: `docker.ts:331-374` (`exec`, `execOnce`, `state`, `ensureRunning`), `388-408` (`setNetwork`); `src/proxy/mcp-proxy.ts:109-126` (the connector's own `docker exec`) | In scope |
| R3. Finding 3: the `mcp-everything.project` label is written and never read | confirmed-live | Read: written at `docker.ts:307`; no reader in `src/` | In scope: the owner label is new; this one may be read for messages |
| R4. Finding 3: two containers in Docker that the inspected registry does not list; cause not established | explained | Ran: Docker holds five sandboxes, all named `mcpe-<slug>`. The registry inside WSL lists two (`gron`, `rea`); the registry on the Windows side lists four (`cowsay`, `rea`, `ha_googlehome`, `schoolopy`). Every sandbox is listed by at least one registry, so none is orphaned. **`rea` is listed by both, as `ready`, with the one container `mcpe-rea`**: the case this mission exists for, live on the operator's machine | Retire as a finding; `rea` is the test case for flight 2 and for the HAT |
| R5. Finding 3: the integration suite's prefix `mcpe-it-<pid>-` begins with the product default | confirmed-live | Read: `test/integration/docker.test.ts:22` | In scope where the suite's names change |
| R6. Finding 3a: an invalid `MCPE_NAME_PREFIX` silently falls back to `mcpe-` | already-satisfied | Read: `src/config.ts:143-150` throws on an invalid value (squawk 0015, completed) | Retire |
| R7. Architect: an install destroys the same-named container and volume, and so does its failure path | confirmed-live | Read: `src/install/installer.ts:183-185` (slug checked against this registry only; `container = prefix + slug`; `volume = container`), `212` and `324` (`destroy`). The Architect's line numbers for `docker.ts` had drifted (it cited 396-405 and 289; the code is at 411-434 and 306-308); the substance holds. Not run | In scope |
| R8. Architect: about twenty call sites through nine methods | confirmed-live | Read: 22 calls by name outside the Docker layer: `installer.ts` 173, 212, 215, 260, 261, 263, 267, 307, 324, 393, 405, 785; `mcp-proxy.ts` 177, 215, 224, 227; `server.ts` 488, 542, 819, 832, 847, 861. Plus the connector | The check goes in the Docker layer, not at the call sites |
| R9. Architect: the connector runs `docker exec` itself, and is covered only because `open()` calls `ensureRunning` first | confirmed-live | Read: `mcp-proxy.ts:109-126`, `214-217` | In scope: the launch should not depend on a caller remembering |
| R10. Architect, aside: if a labelled volume is gone, `docker run -v` creates an unlabelled one, which `destroy` then refuses to remove | needs-human-recheck | Inferred from Docker's behavior with named volumes; not run | Closed as a side effect if creating a container requires that its volume exists and is this installation's; otherwise leave |
| R11. Architect: the unit suite's fixtures hard-code `mcpe-<slug>` | partially-satisfied (smaller than stated) | Read: `test/helpers.ts:14-15` and most uses build a stored record, which stays valid as a record from before the change. Only assertions about the name of a newly installed sandbox must change: `test/installer.test.ts` (`mcpe-widget`, about fifteen lines from 196 to 674) and `test/integration/docker.test.ts:95` | Scope to those |
| R12. Carried: `Docker.state` answers "missing" both when there is no container and when Docker could not be asked | confirmed-live | Read: `docker.ts:359-363`; `setNetwork` handles it for the disable case only (`391-399`) | In scope as far as the ownership check is built on an inspect: it must tell "not there", "not mine" and "could not find out" apart |
| R13. Viability: only `/workspace` is in the volume; installed tools are in the container's own layer | confirmed-live | Read: `docker.ts:6-11`, `281`, `315` | Flight 2's concern |

Also measured for planning: Docker 29.8.2 is reachable from the project. One sandbox (`gron`) has an empty `idle-timeout` label, so it predates sortie 01; sandboxes of several ages exist.

---

## Design Notes
2026-11-16, flight design.

**The operator's decisions at the crew interview**
- A sandbox from before the change behaves as today until flight 2 (DD5), accepting that `rea`, listed by both registries, stays exposed until then.
- The id alone; no readable name for an installation (DD1).
- No HAT leg.
- A scripted test in the Docker-gated suite, not a behavior test (DD10). The mission's note on its first criterion was corrected.

**Design review, first pass**: approve with changes. The Architect read the code and ran one read-only `docker ps`; it did not run the unit suite. What it changed:
- **Reinstall order (high).** As first drafted, a reinstall would have written the record with new names and then removed whatever was at the new names: nothing. The old sandbox would have stayed, running and unlisted, and the startup reconciliation would have looked for it at the new names. Now DD6: old names until the old sandbox is gone, then new names.
- **An install clears its own target names before it builds (high).** Otherwise a volume left by an attempt that died would fail the guard "this name is free" on every retry.
- **Refusals were going to be swallowed (high).** Eight places in discovery turn a failed command into "no commands found"; taking a failed install offline turns any failure into "may still be online"; the proxy's kill and reaping swallow everything. Now DD8: two error types, and those places let them through.
- **One check per operation, not per command (medium).** A guard inside `exec` would have added a second inspect to every tool call. Now a checked reference is carried through one operation (DD4).
- **Inspect by type (medium).** A project's container and volume have the same name; an untyped inspect can match either.
- **`project_info` only for the class of a sandbox (medium).** A project's description is built without asking Docker; only the name goes there (DD9).
- **Flight 2's claim (medium).** A renamed sandbox keeps its labels, so the class "from before" would still fit it. The classification is specified as one function of labels and name, for flight 2 to extend (DD4). Not settled here; it is flight 2's first design question.
- **A behavior change named.** With Docker not answering, uninstall today deletes the record and leaves the sandbox. After the sixth class it fails and keeps the record (DD4).
- **"Not ours" follows "another's"** for uninstall and reinstall (DD7); today such a record can never be uninstalled.
- **A reinstall that cannot remove the old sandbox keeps its record** (DD6), where today it deletes it.
- **The Docker suite's rules tightened**: the case with no prefix removes `MCPE_NAME_PREFIX` from the environment it builds from, and asserts its id before its first Docker call; the operator's five container ids are recorded before and compared after (DD10).
- **Test fallout estimated** at forty to fifty cases, and a new scripted double plus a coverage test over the Docker layer's methods added to the plan.

**Design review, second pass** (a different Architect, on the revised spec): approve with changes. It read the code and ran nothing. This was the second of the two passes the method allows, so what it raised was put into the spec and goes to the operator with the spec; it has not been reviewed again.
- **A stale write could undo a reinstall (high).** Discovery, refresh, connect and `set_project_network` write back a whole record built from an earlier read. Names never changed before, so losing that race cost a tool list. With names that change, it would put the old names back and leave the new sandbox named by no record. The review proposed making those writes conditional, and the spec carried that as DD11 when it went to the operator. **Declined by the operator**: "im really not worried about the race condition, this project is one day old and im the only one useing it". DD11 was removed; the race is recorded as an accepted limit in DD6 and goes into the README.
- **Where the checked reference comes from and goes (high).** The first revision said "one check per operation" without saying how the reference reaches discovery's commands and the proxy, or what an install checks before its container exists. DD4 now lists each: out of `sandbox()` and `requireSandbox`, into `execFor`, discovery and the proxy; an install's reference comes from creating the container and is replaced on a rebuild.
- **The failure branch of an install needs phases (medium).** One flag chooses between two outcomes today. DD6 now has three: before the record takes new names (put the old record back, with a warning), after that and before a container exists (remove and delete, as today), and once a container exists (offline and failed, as today).
- **Any install over an existing record is a reinstall (medium)**, not only `reinstall: true`: a `failed` record, and one that says `installing`. DD6 says so.
- **The proxy's kill must keep swallowing errors (medium).** The first revision had it let the new errors rise, which would have let closing a project's sessions stop an uninstall. The errors arise only where a name is resolved (DD8).
- **A limit for flight 2 to inherit (medium).** "A verdict about an id holds for the container's life" stops being true once a claim changes what the name says. A reference taken before a claim keeps working. Recorded in DD4 and in the mission's open questions.
- **The id file's temporary file (medium)**: removed in every case, named so the registry's sweep does not match it, swept by its own module, and the fallback tested by forcing the link to fail (DD1).
- **Leg 2 was too large.** Split in two: the guard and the reference; then what each operation does with a refusal, the two-installation tests and the README. Three legs.
- Smaller: a mixed pair (container another's, volume this installation's) is left whole and the message names both (DD7); the second removal is skipped when the names did not change (DD6); "not ours" means the generic label absent or not `1` (DD4); a command on a held reference that fails because Docker stopped answering stays a plain failure, as today (DD4).

**Approval, 2026-11-16.** The operator approved the flight after declining DD11 (above), and the flight was set to `ready`. With the same reasoning (a day-old project, one user, five sandboxes) the operator agreed to drop the mission's second flight, which would have let an installation claim an existing sandbox in place: reinstalling each existing project once gives it an owned sandbox. This flight is now the mission's only one and contributes to every criterion; the mission's fourth criterion was reworded with the operator, and the README's part about upgrading moved into this flight's third leg. In the spec, what was written for the second flight's benefit was removed: the classification is a function of labels alone, and the note on references held across a claim is gone.

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
