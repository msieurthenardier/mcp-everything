# Flight: Owned Sandboxes

**Status**: planning
**Mission**: [Sandbox Ownership on a Shared Machine](../../mission.md)

> **Not designed yet.** This artifact was logged on 2026-11-16 as sortie 04, "Ownership on a Shared Machine", with a draft charter. At pickup the same day it failed three of the four sortie criteria and was escalated; the charter became the starting point of the mission, which the operator narrowed and agreed, and the artifact was moved here as the mission's first flight. Design it with `/mission-control:flight`. The file's history holds the charter as it was drafted.

## Contributing to Criteria
For sandboxes made after this flight. Sandboxes that exist already are flight 2's.

- [ ] Two installations that share one Docker daemon and install the same repository each end up with their own working sandbox, and neither install changes the other's.
- [ ] An installation acts only on sandboxes it owns, and refuses each operation on one it does not own, not only removal.
- [ ] Both of the above hold for two installations that configured nothing.
- [ ] For every sandbox made after this change, the operator can find out which installation owns it.
- [ ] The README says what an installation is, where its data directory is by default, how sandboxes are named and kept apart, and what the protection does not cover. (What an upgrade does to existing sandboxes is flight 2's part.)

---

## Pre-Flight

### Objective
Not designed yet. From the mission's flight list: an installation has an identity; sandboxes it makes carry it and get names that cannot collide; every operation checks ownership before acting; the README describes the model.

### Open Questions
None is settled. The first five are this flight's, from the mission's open questions, where the leans and their reasons are written out.

- [ ] **How an installation knows itself.** The operator's lean: a short generated id that lives with the registry, not a value from the environment. Lean on where: its own file in the data directory, written once, because every build to date rewrites `registry.json` without fields it does not know. Whether an installation may also have a readable name, for display only.
- [ ] **How names stop colliding by default**, and what `MCPE_NAME_PREFIX` then means for those who set it.
- [ ] **Where the ownership check goes.** About twenty call sites through nine methods of the Docker layer, plus the proxy's own `docker exec`. Lean: inside the Docker layer, resolving a name to a container id and its owner once.
- [ ] **What a sandbox from before the change is to this flight's build**, until flight 2 lets an installation claim it. The mission's second criterion says it belongs to nobody. A build that refuses to act on it would break every existing project between the two flights; a build that acts on it by name leaves today's exposure in place for those sandboxes. Decide which, and whether the two flights may be released apart.
- [ ] **Tests that assume today's names**: the unit suite's helpers and the Docker suite assert `mcpe-<slug>` or a prefix that starts with the product default.

**Carried from the debriefs of mission 01, and still this flight's concern** (inputs, not decisions)
- **The registry lock is not a guard.** A waiter takes it from a live writer after 5 seconds. Nothing in this flight may rest on it for exclusion; squawk 0036 fixed only the release.
- **Rules for work at startup on a directory several processes share**: check again immediately before acting; do nothing when the answer is unknown; give tests a promise to await; say in a comment what a rule does not cover. Creating the installation's id is such work: two sessions may start at once.
- **A value that answers "no" for both "there is none" and "I could not find out" will be read as "there is none".** `Docker.state` and the inspect inside `setNetwork` still answer that way, and an ownership check is built on an inspect.
- **Structure.** The sortie 03 debrief asked that the next feature touching the launch environment give it its own collaborator outside `Installer`. The Architect's reading at the mission's viability check is that this flight does not touch the launch environment and needs no restructuring.

**Set aside at escalation** (collected when this was sortie 04; outside this mission by the operator's decision, kept here so they are not lost)
- What identifies a project over time, and variables that bind to a slug (finding 2).
- One shared registry with owners in it; two owners using one sandbox.
- Whose environment decides a project's variables when several sessions can launch its servers.
- Liveness, and replacing the seven-hour rule; taking the lock from a live writer.
- A registry format version 2, its migration, a read-only mode for older builds, and what happens to a session on the old format when a new build writes.
- One owner for startup work, which is in four places.
- The inconsistencies the Architect found in what mission 01 added (the mission 01 [debrief](../../../01-maintenance/mission-debrief.md), "What Could Be Improved").
- The test of two real processes on one data directory writing to the registry while a third reconciles.

The full text of these is in the [flight 03 debrief](../../../01-maintenance/flights/03-local-state-and-secret-handoff-tests/flight-debrief.md) and the [mission debrief](../../../01-maintenance/mission-debrief.md) of mission 01.

### Design Decisions
None yet.

### Prerequisites
- [x] Mission 01 (Maintenance) completed.
- [x] Squawks 0034 and 0036 (both in `src/registry.ts`) completed.
- [x] Mission 02 agreed with the operator (2026-11-16).

### Pre-Flight Checklist
- [ ] All open questions resolved
- [ ] Design decisions documented
- [ ] Prerequisites verified
- [ ] Validation approach defined
- [ ] Legs defined

---

## In-Flight

### Technical Approach
Not designed yet.

### Checkpoints
Not designed yet.

### Adaptation Criteria
Not designed yet.

### Legs
Not designed yet.

---

## Post-Flight

### Completion Checklist
- [ ] All legs completed
- [ ] Code merged
- [ ] Tests passing
- [ ] Documentation updated

### Verification
Not designed yet.
