# Leg: status-and-docs

**Status**: completed
**Flight**: [Contained Network and Isolation Runtime](../flight.md)

## Objective
Make what the agent is told, and what the README says, match what flight 02 built: network containment, local access, scanners' hosts and the isolation runtime. State every limit and residual route the flight recorded, and keep the README and the code provably in agreement through `test/readme.test.ts`.

## Context
- **Tiered low-risk** (Flight Director, 2026-11-23). This is additive text in established places: the generated security paragraph, the instructions head, the README and its agreement test. There is no separate design review; the flight-end Reviewer reads it.
- **Mission criteria this leg closes**:
  - "With nothing configured … the agent is told so" (now including containment and runtime status);
  - the README criterion: containment on, what it allows and how to change it, the runtime, upgrading, what none of this protects against, what reaches outside services.
- **What legs 1–10 already changed**: leg 9 changed `project_info`'s network line, `describe()`'s `network (recorded)` label, `set_project_network` and `set_project_hosts` wording, and the instructions sentence mentioning `set_project_hosts`. This leg does not redo those; it reads them so the README matches.
- **Sources of truth for every statement**: the flight spec (DD1–DD15), the flight log (trials T1–T15, the native-Linux measurements, legs' decisions and deviations, the standing gaps) and the code as landed. **No statement from memory.** Each README claim about behavior cites, in the flight log entry for this leg, the code symbol or measurement it rests on.

## Inputs
- `src/server.ts`: `securityParagraph`, `INSTRUCTIONS_HEAD`, `buildInstructions`.
- `README.md`:
  - `## Checking projects before they run`, and its `### What none of this protects against`;
  - `## Security model`;
  - `## Configuration`;
  - `## Limitations`;
  - `## Built-in tools`.
- `test/readme.test.ts`; `test/server.test.ts` (the instructions pins).
- The flight log: measurements, decisions, deviations and standing gaps. Squawk 0052.

## Outputs
- `src/server.ts`: the security paragraph's containment and runtime lines.
- `README.md`: a new `## Network containment` section, plus updates to the sections listed.
- `test/readme.test.ts`, `test/server.test.ts`: agreement cases.

## Acceptance Criteria

**The security paragraph** (`securityParagraph(cfg)`, synchronous, from configuration only):
- [ ] **`MCPE_NETWORK=open`**: keeps today's sentence ("Sandbox networks are not contained: a build, and a sandbox with its network on, can reach the internet and the local network.") and adds "the operator turns containment on with MCPE_NETWORK=contained".
- [ ] **`MCPE_NETWORK=contained`**: "Sandbox networks are contained: …" Then, in short sentences:
  - **clones** reach only the repository's forge;
  - **builds** reach their package registries, GitHub and the project's `hosts`;
  - **a sandbox with its network on** reaches its registries and its `hosts`;
  - **local addresses** are reachable only where the operator allows a repository (`MCPE_LOCAL_ACCESS`), and the agent cannot add them;
  - **`set_project_hosts`** changes a project's hosts;
  - **refused hosts** are reported. A refused host was chosen by the project's code, so allow it only if expected.
- [ ] **The runtime line**:
  - "Isolation runtime: Docker's default runtime." when none is named;
  - otherwise: "Isolation runtime: <name>, required: installs and checks refuse to start if Docker cannot run it, and sandboxes created under another runtime must be reinstalled."
  - The name is cleaned as today.
- [ ] **Unit cases** pin both containment variants and both runtime variants, and the instructions-head pins move only where named.

**The README** (no claim beyond what was built and measured):
- [ ] **A new `## Network containment` section**, after `## Checking projects before they run` and before `## Security model`. It covers:
  - **turning it on**: `MCPE_NETWORK=contained`; Docker must support a network with no gateway. Say "Docker 29.4.2 (Linux) and 29.8.2 (Docker Desktop) were tested; the minimum version is not established", per DD3 and the measurements;
  - **what each stage reaches**: the clone, the build (the default table by build system; GitHub included), the sandbox after install;
  - **the proxy**: its own small program, one per project; it resolves names itself and refuses local addresses by the address it connects to;
  - **plain HTTP is GET and HEAD only**;
  - **`hosts` and `set_project_hosts`**, the grammar's refusals, and that defaults cannot be removed per project;
  - **`MCPE_LOCAL_ACCESS`**:
    - its syntax and examples;
    - keyed by repository;
    - names only, not IP literals, and why;
    - how the name points at the proxy;
    - Docker Desktop's `host.docker.internal` measured working with published ports;
    - native Linux's `host-gateway` reaching services on all addresses or `docker0`, not `127.0.0.1` only;
    - a reconnect is needed after a change;
  - **scanners' `hosts`** (operator file; may be local; required for a networked scanner under containment);
  - **refusal messages**, and why their hints are advisory;
  - **switching from open to contained**: existing projects are contained at the next start of mcp-everything; a session never loosens another's containment;
  - **sessions with different settings**: the last to start or change a project decides its local-access and resolver configuration.
- [ ] **A `### What containment does not stop` subsection**, listing each residual route the flight recorded:
  - an allowed host is a way out as well as in (GitHub releases, registries reachable by a running server);
  - DNS lookups of arbitrary labels under a wildcard;
  - the Docker host's own public addresses and published ports;
  - Azure's `168.63.129.16`;
  - IPv6 forms not decoded (ISATAP, nonstandard NAT64);
  - image pulls (done by the daemon);
  - processes started without the proxy variables, and clients that resolve names themselves (busybox `wget`), fail closed with unhelpful messages;
  - the window during a proxy replacement in which a removed host is still allowed;
  - sandboxes from before ownership labels, and labelled sandboxes with no record, stay uncontained: reinstall them;
  - leftover proxies of stopped sandboxes and of crashed uninstalls are not swept yet (squawk 0052);
  - a build refused its package registry fails only at the install timeout, because npm retries.
- [ ] **`## Configuration`** gains `MCPE_NETWORK`, `MCPE_LOCAL_ACCESS` and `MCPE_PROXY_IMAGE`, with their defaults; the proxy image's default is the exact pinned reference.
- [ ] **The runtime**, in `## Security model` (where `MCPE_DOCKER_RUNTIME` is described today):
  - naming it requires it (refusal before anything starts; existing sandboxes under another runtime must be reinstalled);
  - name it as `docker info` lists it (the `io.containerd.runc.v2` caveat);
  - the probe image must contain `true`;
  - "behavior under gVisor is tested in CI (leg 12)". This sentence is written only once leg 12 lands. Until then it says what is tested, and leg 12 updates it.
- [ ] **`## Security model` and `### What none of this protects against`** are corrected where they now say the network is not contained without qualification. They state both modes.
- [ ] **`## Built-in tools`** lists `set_project_hosts` and the `hosts` parameter of `install_project`.
- [ ] **What reaches outside services when scanning is on**: confirm it is stated (flight 1), and add that containment narrows scanner egress to the scanner's `hosts`.

**The agreement test** (`test/readme.test.ts`):
- [ ] **Every variable**: each `MCPE_NETWORK*`, `MCPE_LOCAL_ACCESS` and `MCPE_PROXY_IMAGE` read in `src/config.ts` appears in the Configuration table, and vice versa.
- [ ] **Defaults**: the table states the defaults `loadConfig` gives (`open`; the proxy image's exact reference).
- [ ] **Section order**: the `## Network containment` section exists, between `## Checking projects before they run` and `## Security model`.
- [ ] **Tools**: `set_project_hosts` is named in `## Built-in tools`.
- [ ] **The default host table**: every host in `src/network/defaults.ts` appears in the README's table, and the README lists no host the code lacks. This is computed from the module, not a snapshot file.

**Overall:**
- [ ] `npm run typecheck`, `npm test` and `npm run build` pass. No Docker run is needed for this leg.
- [ ] **The flight-log entry lists, for each README behavior claim, its source** (DD, trial, measurement or code symbol).

## Verification Steps
- `npx vitest run test/readme.test.ts test/server.test.ts`, then `npm test`.
- Read the new README section against the flight log's measurements and decisions; each claim is traceable.
- **Trials**. Weaken, confirm a test fails, restore by editing:
  - remove one default host from the README table;
  - remove `MCPE_LOCAL_ACCESS` from the Configuration table.

## Implementation Guidance
1. The security paragraph, with its unit cases.
2. The README sections, written from the flight log and the code, not from memory.
3. The agreement test.
4. The source list in the flight log.

## Edge Cases
- **A README sentence the code contradicts**: fix the README, never the code, in this leg. Report it, since it may be a defect.
- **Unmeasured build systems** (Debian `need`/`apt-get`, Python, Rust, Ruby, CMake/autotools, `pnpm`/`yarn`): listed in the table as defaults, with a note that only Go and npm were measured under containment.

## Files Affected
- `src/server.ts`, `README.md`, `test/readme.test.ts`, `test/server.test.ts`.

## Citation Audit
Checked on 2026-11-23:
- `README.md` sections at lines 338 (`## Checking projects before they run`), 602 (`### What none of this protects against`), 627 (`## Security model`), 913 (`## Configuration`), 943 (`## Limitations`) and 66 (`## Built-in tools`).
- `test/readme.test.ts` has the `section()` helper, the scan-variable agreement and the section-order pattern to extend.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
