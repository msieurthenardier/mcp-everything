# Leg: hat-and-alignment

**Status**: completed
**Flight**: [Contained Network and Isolation Runtime](../flight.md)

## Objective
The operator, in their own client, sees and accepts what this flight does. It covers:
- containment off, then on;
- their existing projects contained at startup;
- a contained install;
- a refusal fixed with `set_project_hosts`;
- the Trivy scanner's hosts measured;
- optionally, a local service allowed with `MCPE_LOCAL_ACCESS`.

The operator also decides the open items. Issues found are fixed as they come.

## Context
- **Interactive leg** (the operator opted in, 2026-11-22). The Flight Director guides one step at a time.
  - A look-and-feel fix rides inline.
  - Anything that adds behavior goes through the fix-vs-feature gate, with a scoped design review first.
- **The operator's client** is this Claude Code session. mcp-everything runs from this checkout's `dist/index.js`, as in flight 1's HAT. `npm run build` and a reconnect put the flight's commit (`070486a`) in front of it.
- **The operator's current configuration** (flight 1's HAT): `MCPE_SCAN=on` (warn), with Trivy 0.76.2 pinned in `~/.config/mcp-everything/scanners.json`.
  - **Under `MCPE_NETWORK=contained`, a scanner with `"network": true` and no `hosts` is a startup error** (leg 1).
  - So Trivy's hosts are added before containment is turned on, and then measured from its refusals. That closes leg 11's open item: no real Trivy run under containment had been made.
- **The operator's existing projects are real**: seven under installation `bde0aedf` and older ones. No step uninstalls or reinstalls one of them unless the operator chooses. The startup pass will contain any whose record says network on.
- **Open items for the operator's decision**:
  - the anonymous volumes this flight's test runs left (ids in the flight log);
  - squawk 0052 (deferred housekeeping);
  - whether the `docker-gvisor` job stays advisory;
  - npm's slow failure on a refused registry (DD9 finding);
  - the two standing gaps (pre-ownership sandboxes, labelled sandboxes with no record);
  - whether the client's mcp-everything stays contained after the HAT.

## Acceptance Criteria (verification steps, one at a time)
- [x] 1. **Built and reconnected, containment off.** `npm run build`, then reconnect mcp-everything. `set_project_hosts` appears in the tool list. The server's instructions say networks are not contained, and how to turn containment on. `project_info` of one existing project shows `network: off | open` from Docker's view.
- [x] 2. **Trivy's hosts.** In `scanners.json`, add a first `hosts` list to the Trivy entry (candidates read from Trivy's own documentation at the time, not from memory). Then reconnect with `MCPE_NETWORK=contained` and run `check_project` on a small repository. Either Trivy's outcome is `ran`, or its failure text names the refused hosts, which are added, and the step repeats until it is `ran`. The final list is recorded for the README's Trivy example.
- [x] 3. **Containment on.** With `MCPE_NETWORK=contained`, the instructions say "contained". The startup log, and `project_info` of each project whose network was on, shows it contained. Their tools still run. A project whose server needs an outside API shows a refusal with the advisory hint.
- [x] 4. **A refusal fixed.** Where step 3 or a deliberate call shows a refused host, `set_project_hosts(add: [...])` makes the call work, with no reinstall. `project_info` lists the host. The operator judges that the hint's wording is advisory, not instructive.
- [x] 5. **A contained install.** A throwaway project, chosen with the operator, installs under containment and its tool runs. `project_info` shows the network state, and no refusal warnings (or the expected ones).
- [x] 6. *(skipped, operator's choice)* **Local access** *(optional, the operator's choice)*. A service on the operator's machine (published port) is reached only by the repository named in `MCPE_LOCAL_ACCESS`, after a reconnect and turning the project's network on.
- [x] 7. **Back to the operator's chosen settings**, then reconnect. The throwaway project is removed. The operator's decisions on the open items are recorded.

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
