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

## Leg Progress

---

## Decisions

---

## Deviations

---

## Anomalies

---

## Session Notes
