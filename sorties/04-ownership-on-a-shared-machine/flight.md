# Sortie: Ownership on a Shared Machine

**Status**: planning

> **Logged, not yet planned.** The operator asked on 2026-11-16 for this to be recorded now and picked up after [mission 01 (Maintenance)](../../missions/01-maintenance/mission.md) completes. The charter below is a **draft** and has not been through the charter gate; the flight is not designed. Start with `/mission-control:sortie` on this artifact when mission 01 is done.
>
> **Qualification, as checked at logging**: one outcome (yes, as drafted), one cluster of design decisions (yes: who owns what, and how it is identified). **Two criteria are in doubt and must be re-checked at pickup**: "fits one flight" (a registry schema change with a migration, identity and ownership each look like a leg of their own) and "no cross-cutting architecture change" (ownership touches the registry, the installer, the proxy's launch environment and container naming). If either fails, this escalates to a mission seeded with this charter; it should not be widened in place.

## Charter

### Outcome
Several agentic systems on one machine can each run mcp-everything without one reading, changing or mistaking another's projects, sandboxes or variables, unless the operator chose to share them.

### Why Now
The operator's words on 2026-11-16: "we need to account for multiple agentic systems working on the same machine, so owner, unique ids, location of registry, etc."

mcp-everything was built for one operator and one client. It already runs as several processes on one data directory, and each piece of work since has met the same gap from a different side:

- The 2026-11-15 maintenance inspection left three findings for design instead of fixing them: who may read a project's variables (1b), what a slug identifies (2), and who owns a sandbox (3). Mission 01 says they go to one sortie after it.
- Flight 02 of mission 01 had to tell a dead install from a neighbor's live one and could only guess by age (seven hours), because a registry record carries no owner. Its [debrief](../../missions/01-maintenance/flights/02-install-failure-paths/flight-debrief.md) recommends an owner in the record and notes that a process id alone is not enough. It also sorted one defect here as needing this design: a container that can be left with no record when a create fails late.
- The registry's location and the container name prefix are per-process settings with shared defaults (`MCPE_DATA_DIR`, `MCPE_NAME_PREFIX`). Two systems that set neither share one registry and one set of container names without having chosen to.
- A project's `{slug}__{NAME}` variables come from the environment of whichever process launches its server, so processes sharing a registry can disagree about what a project receives (the README documents this as a limit).

### Success Criteria
Draft, to be agreed at the charter gate.

- [ ] Every registry record and every sandbox names its owner, and a process changes (reconciles, reinstalls, uninstalls, detaches) only what it owns or what the operator has shared with it.
- [ ] A project's identity is unique for its lifetime: a name used again later does not inherit an earlier project's sandbox, tools or variables.
- [ ] Where the registry lives and who shares it is an explicit, documented choice; two systems that did not choose to share do not see each other's projects or collide on container names.
- [ ] A registry written before this change is carried forward without loss, and one written after it is refused by an older version (the check flight 03 of mission 01 adds).

### Constraints
Draft.

- The operator's decision of 2026-11-16 stands: an agent is trusted with the variables of a project it can run commands in (README, "the agent is trusted with…"; squawk 0014). This sortie decides **which** agents and processes that is, not whether.
- A change to the registry's format bumps its `version` and comes with a migration.
- Not started before mission 01 completes: flights 02 and 03 of that mission are the tests this work will rely on.

---

## Pre-Flight

### Objective
Not designed yet.

### Open Questions
Collected at logging, for the planning conversation. None is settled.

- [ ] **Owner.** What is an owner: a client installation, an agentic system, an operating-system user, a named instance the operator configures? How does a process know its own identity across restarts, and what happens to records whose owner is gone for good?
- [ ] **Unique ids.** What identifies a project: the slug, the repository, or a generated id that the slug merely displays? Tool names (`<slug>__<tool>`), container and volume names, and variable names (`<slug>__<NAME>`) are all derived from the slug today.
- [ ] **Location of the registry.** One shared registry with owners in it, or one registry per system with sharing as the exception? What should the defaults be so that two systems that configured nothing do not collide?
- [ ] **Sandboxes.** Can two owners use one sandbox? Who may reinstall, uninstall or change the network of a sandbox someone else installed?
- [ ] **Variables.** When several processes can launch a project's servers, whose environment decides what the server receives?
- [ ] **Liveness.** Is an owner enough to tell a dead install from a live one, or is a heartbeat needed as well? (Flight 02's reconciliation and its seven-hour rule are what this would replace.)
- [ ] **Containers with no record**, and records with no container: who cleans them up, and on what evidence?
- [ ] **Structure.** The sortie 03 debrief said the next feature touching launch environment should give it its own collaborator outside `Installer`. Is this that feature?

### Design Decisions
None yet.

### Prerequisites
- [ ] Mission 01 (Maintenance) completed.

### Pre-Flight Checklist
- [ ] Charter agreed with the operator
- [ ] Qualification re-checked (the two criteria in doubt above)
- [ ] Flight designed and reviewed

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
