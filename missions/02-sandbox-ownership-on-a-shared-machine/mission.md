# Mission: Sandbox Ownership on a Shared Machine

**Status**: active

> **Agreed with the operator on 2026-11-16.** Escalated the same day from sortie 04, which failed three of the four sortie criteria at pickup and is now this mission's [first flight](flights/01-owned-sandboxes/flight.md). No alignment flight, by the operator's choice.
>
> **Viability**: checked by the Architect on 2026-11-16 against the code, without running Docker: feasible with caveats. The caveats are folded into criteria 2, 4 and 5, the constraints and the open questions below.

## Outcome
Two agentic systems on one machine, each running its own mcp-everything against the same Docker, can install, update and remove projects without touching each other's sandboxes.

## Context
The operator runs mcp-everything twice on one Windows machine: once inside WSL for Claude, and once on Windows for a second agentic system. Each has its own registry, in a different place, and neither can see the other's. Both reach the same Docker daemon and both name a project's container and volume `mcpe-<slug>`. So the two registries share one set of sandboxes without either knowing it, and one system can update or tear down a sandbox that the other's registry lists as ready.

What the code does today (read by the Flight Director and again by the Architect; not run):

- A sandbox is identified by its name alone. `exec`, start and the hand-off of variables act on whatever container has the name; only removal checks anything, and what it checks is a label every mcp-everything sandbox carries (`mcp-everything=1`), whoever made it. (Maintenance report [2026-11-15](../../maintenance/2026-11-15.md), finding 3.)
- An install begins by destroying the container and volume with its target name, and its failure path does the same. A slug is checked for collisions against the installing registry only. So when both systems install a repository that gets the same slug, the second install destroys the first system's sandbox, and the first registry still says `ready`.
- The name prefix is a per-process setting with one shared default (`MCPE_NAME_PREFIX`, default `mcpe-`). Two installations that set nothing collide.
- The maintenance inspection found two containers in Docker that the inspected registry did not list, which this explains.

This mission was first logged as sortie 04 with a wider draft charter: several agentic systems, owners, unique ids, where the registry lives, sharing. At the mission interview on 2026-11-16 the operator narrowed it:

- **An owner is an installation**: one registry in one data directory. Every session that uses that registry is the same owner.
- **Separate sandboxes, no sharing.** Each installation builds its own sandbox for a project, even when both use the same project.
- **Existing projects keep working** without a reinstall.
- **The protection is against accidents.** Both systems are the operator's.

It does **not** take, and each is left as it is today, documented as a limit:

- **Sharing a sandbox between installations**, by default or by choice.
- **How several sessions on one registry coordinate**: the registry lock that can be taken from a live writer after five seconds, the seven-hour rule for an interrupted install, and sessions that disagree about a project's variables. Candidates for a follow-up mission; the mission 01 [debrief](../01-maintenance/mission-debrief.md) holds the inputs.
- **What a slug identifies over time** (finding 2): a project installed later under a slug used before still receives the variables set for that slug.
- **A system that interferes on purpose.** Anything that can reach the Docker daemon can go around mcp-everything.
- **Restructuring `Installer` or `server.ts`, or gathering startup work into one place.** The Architect's reading is that neither is needed: the change sits in the Docker layer and in how an install names its sandbox.

## Success Criteria
- [ ] Two installations that share one Docker daemon and install the same repository each end up with their own working sandbox, and neither install changes the other's. *(Behavior-test-backed: observable only against real Docker with two data directories.)*
- [ ] An installation acts only on sandboxes it owns. Asked to start, run a command in, hand variables to, reinstall over, change the network of or remove a sandbox it does not own, it refuses and says so; this holds for each of those operations, not only removal. A sandbox made before this change belongs to nobody until an installation claims it.
- [ ] Both of the above hold for two installations that configured nothing.
- [ ] A project installed before this change keeps working, without a reinstall, in the installation that claims its sandbox; an installation claims a sandbox its registry lists when it first uses it. When two installations list the same sandbox, the claim succeeds for exactly one. The other reports that the project must be reinstalled, and its reinstall builds a new sandbox and leaves the claimed one and its data intact.
- [ ] For every sandbox made or claimed after this change, the operator can find out which installation owns it; a sandbox from before the change that nobody has claimed shows as unowned.
- [ ] The README says: what an installation is and where its data directory is by default on Linux and on Windows; how sandboxes are named and kept apart; what an upgrade does to existing sandboxes, and that every installation on the machine should be upgraded; and what the protection does not cover.

## Stakeholders
The operator, who runs two agentic systems against one Docker daemon; and anyone who runs mcp-everything from more than one client with separate data directories, which the defaults produce whenever the clients run as different users or on different sides of WSL.

## Constraints
- The operator's decision of 2026-11-16 stands: an agent is trusted with the variables of a project it can run commands in.
- Tool names (`<slug>__<tool>`) and variable names (`<slug>__<NAME>`) do not change. They come from the slug, not from the sandbox's name, and are already private to an installation; a client's saved permissions and an operator's environment depend on them.
- A single installation that shares Docker with nobody sees no change in behavior beyond what its sandboxes are called in Docker (existing ones change name when they are claimed) and a small added cost per operation for the ownership check.
- The registry's format does not change unless a flight shows it must. A record already stores its sandbox's names, and an installation's identity can be kept beside the registry. A change would bump `version`, need a migration run under a lock that can be taken from a live writer, and lock out sessions on older builds.
- The registry lock is not a guard as it stands. Nothing here may rest on it for exclusion; a claim two installations might race for must be settled by Docker.
- The protection holds between installations whose builds have it. An installation on an older build still treats every sandbox named `mcpe-<slug>` as its own. The mission accepts this and documents it; it does not try to defend a carried-forward sandbox against an older build.
- The work is verifiable on one Linux host with two data directories and one Docker daemon. No criterion depends on a Windows machine, and the README claims no more than was tested: file permissions on a Windows data directory and the Windows Docker client are not verified here.
- Snapshot or golden-file baselines are not committed (operator's standing rule); none is expected.

## Environment Requirements
- Node 22.12 or later; Docker for the integration suite (`npm run test:docker`) and for the behavior test.
- The hosted check runs on Linux without Docker; what needs Docker is run locally before a pull request is marked ready, as in mission 01.

## Open Questions
For the flights. None is settled; each lean is the Architect's unless it says otherwise, and none has been run.

- [ ] **How an installation knows itself.** The operator's lean (2026-11-16): a short generated id that lives with the registry, not a value set in the environment. A value from the environment alone cannot meet the third criterion, since two installations that set nothing would have the same one; it is how `MCPE_NAME_PREFIX` works today. Lean on where it is kept: its own file in the data directory, written once, and not a field of `registry.json`. Every build to date rewrites that file as `version` and `projects` only (`Registry.persist`), so one write by a session on an older build would drop the id, and the installation would come back with a new one and own none of its sandboxes. Open: whether the operator may also give an installation a readable name, for display only, so a refusal can say whose a sandbox is in words. Limits to state: a copied data directory gives two installations one id, which cannot be detected; a deleted one leaves sandboxes whose owner is gone for good.
- [ ] **How names stop colliding by default.** The default name has to differ per installation, so it has to carry the id. What `MCPE_NAME_PREFIX` then means for those who set it: a prefix before the id, or in place of it?
- [ ] **Where the ownership check goes.** About twenty call sites act on a sandbox by name, through nine methods of the Docker layer plus the proxy's own `docker exec`. Lean: inside the Docker layer, resolving a name to a container id and its owner once and acting on the id; the proxy's launch is covered today only because it starts the sandbox through that layer first.
- [ ] **How an existing sandbox is claimed.** Docker fixes a container's and a volume's labels at creation, so it cannot be marked. Lean: rename the container to the installation's own name. A rename is settled by Docker, so of two installations only one succeeds, and the other finds the old name gone, which it already reports as "reinstall". The owner of a claimed sandbox is then readable from its name and not from a label. To be run before anything is designed on it.
- [ ] **The volume of a claimed sandbox.** A volume cannot be renamed, so it keeps its old name and the generic label, and is owned only through the container that mounts it. A build with this change must not remove a volume by its label alone. Whether Docker itself refuses to remove a volume a container still mounts is the Flight Director's recollection, not a finding: run it.
- [ ] **Why not rebuild the container over its volume?** Because only `/workspace` is in the volume; installed binaries and environments are in the container's own layer, so that would be a reinstall. (Read from paths, not from the recipes.)
- [ ] **What is left behind.** A reinstall that builds a new sandbox for a project whose old one someone else claimed; the two sandboxes the inspection found; a container left when a create fails late. Telling whose they are is a criterion; removing them is not decided.
- [ ] **Tests that assume today's names.** The unit suite's helpers and the Docker suite assert `mcpe-<slug>` or a prefix that starts with the product default.

## Known Issues
N/A

## Flights

> **Note:** These are tentative suggestions, not commitments. Flights are planned and created one at a time as work progresses. This list will evolve based on discoveries during implementation.

- [ ] Flight 1: [Owned sandboxes](flights/01-owned-sandboxes/flight.md) — an installation has an identity; sandboxes it makes carry it and get names that cannot collide; every operation checks ownership before acting; the README describes the model. Reaches criteria 1, 2, 3 and 5 for new sandboxes. Sortie 04, re-homed.
- [ ] Flight 2: Carrying existing sandboxes forward — an installation claims the sandboxes its registry lists, two installations settle one that both list, a volume follows its container, and the README says what an upgrade does. Its own flight because it acts on sandboxes that already hold the operator's work and is hard to undo.
