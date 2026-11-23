# Mission: Vetted and Contained Installs

**Status**: active

> **Drafted with the operator on 2026-11-21**, from a conversation that began with "what can we do about security scanning projects before we mcp-afy them". Decisions taken in that conversation are recorded under Constraints with the date. No alignment flight, by the operator's choice.
>
> **Viability**: checked by the Architect on 2026-11-21 against the code, without running Docker: feasible with caveats. The caveats are folded into the criteria, constraints, open questions and flights below; the reinstall finding was confirmed by the Flight Director against `Installer.install`.
>
> **Network containment made opt-in on 2026-11-21**, after the viability check, by the operator: everything this mission adds is off until the operator turns it on, and the agent is told what is off. The operator-only exception for local addresses was added with it.
>
> **Approved by the operator on 2026-11-21**, with the staging clone as the lean for a blocked reinstall; status set to `active`.

## Outcome
An operator can let an agent install open source projects knowing that, when they turn the protections on, each project is checked before any of its code runs by scanners the operator chose, and whatever a project runs can reach only the hosts it needs, never the operator's machine or local network; and that the agent can always see how well protected an install is when it decides whether to go ahead. Out of the box, mcp-everything works as it does today and says plainly that these protections are off.

## Context
Installing a project means running its own code: the build runs `postinstall` scripts, `setup.py`, `build.rs`, Makefiles and whatever they call, as root, with the network on. Choosing what to install is shared between the agent, which finds and installs projects, and the operator, who runs mcp-everything and owns the machine. The operator's words: security is critical.

What a build can do today (read from the code; not run):

- **Privileges**: `--cap-drop ALL`, `no-new-privileges`, memory, CPU and process limits (`src/sandbox/docker.ts`, `limits()`). No seccomp option is set, so Docker's default profile applies unless the daemon is configured otherwise.
- **Network**: the Docker bridge, so everything the host can reach: the internet, the local network, services on the host, the Windows side under WSL, and a cloud machine's metadata endpoint. The clone container is on the same bridge. After an install, successful or not, the sandbox goes offline, but `install_project(network: true)` and `set_project_network` put it back on the full bridge, and that sandbox may hold the operator's `<slug>__<NAME>` values. "Offline" today means the container is on no network at all; the record keeps it as a boolean.
- **Kernel**: shared with the host, unless the operator sets `MCPE_DOCKER_RUNTIME` (for example gVisor's `runsc`). `limits()` applies it to the clone container and the sandbox alike.
- **Secrets**: none during the build. Values of `<slug>__<NAME>` are given only when an MCP server starts.
- **Images**: pulled by the Docker daemon, not by a container, so outside anything a container's network settings decide.
- **Checks**: none. `search_projects` returns stars, license and whether a project is archived; the agent is not told anything about risk, and there is nothing to tell it.

What was found while scoping:

- **Forge-side scanners cannot be borrowed.** Dependabot, code scanning and secret scanning alerts answer 401 to anyone who does not maintain the repository. What is public on GitHub: the dependency graph as an SBOM (`/dependency-graph/sbom`, package URLs, no clone needed), published repository security advisories, and OpenSSF Scorecard for the repositories it happens to cover (it answered 404 for `astral-sh/ruff` and `modelcontextprotocol/servers`). The SBOM can be checked against OSV, which also lists known-malicious packages (`MAL-` entries). GitLab has no public equivalent. All of these are about a project's dependencies; none looks at what the repository's own build runs.
- **There is a natural place for a check.** The clone happens in a throwaway container and leaves the source in a volume; the build happens later, in the sandbox container. A check of the source fits between the two without restructuring the install (`Installer.install`, `src/install/installer.ts`).
- **But a reinstall removes the old sandbox before it clones.** When a reinstall keeps the same names, `Installer.install` destroys the container and volume at those names first and clones into the fresh volume after. A check placed after the clone would find a hostile new version only once the working old one is gone. Keeping the old one when the check blocks needs the check to run before that removal (open question below).
- **What a build produced is not on the volume.** Only `/workspace` is a volume; `/opt/mcpe` (the virtualenv, `/opt/mcpe/bin`), `/root/.cargo`, `/usr/local/go` and gem installs are in the container's own layer (`src/sandbox/docker.ts`, the constants at the top and the sandbox's `PATH`). Mission 02 met the same fact. Checking what a build installed needs that to change.
- **Tools appear after an install too**: `discover_tools`, `refresh_mcp` and `connect_mcp_server` add tools, and their descriptions reach the agent. A proxied MCP server's tool descriptions come from a server that is already running, so a check there reads text; it cannot undo code that has run.

What the mission does **not** take, each stated as a limit in the README:

- **A hostile agent.** The checks protect against a hostile project, not against the agent: `sandbox_exec` can run anything once a project is installed, including changing what a checked tool does.
- **Running builds as a non-root user.** Deferred by the operator on 2026-11-21: it touches every build recipe, and a container escape is addressed here by the isolation runtime instead.
- **Catching everything.** Scanners find known patterns and known advisories; a determined author can evade them. Network containment narrows what an evasion can do; it does not close it (see Constraints on allowed hosts).

## Success Criteria
- [ ] With nothing configured, installs behave as they do today, and the agent is told so: the server's instructions, every install result and `project_info` say that projects are not scanned and their network is not contained. Whether scanning is on, which scanners run, whether network containment is on, and which isolation runtime is in use are always visible to the agent.
- [ ] The operator turns scanning on from the environment and can add scanners of their own choice without a change to mcp-everything. The agent cannot add, remove or change scanners, and cannot change or bypass the policy.
- [ ] With scanning on, a repository is checked before any of its code runs. The agent is told which scanners ran, what they found, and which of them failed. Under a blocking policy, a project with findings at or above the operator's threshold is not built, and a project already installed under that slug is left working as it was. A scanner that fails or times out is reported and does not block.
- [ ] With scanning on and no scanner of the operator's own configured, the operator still gets a list of everything the repository's build will run from the repository itself, and, for GitHub repositories, its dependencies that are known to be vulnerable or malicious.
- [ ] The agent can have a repository checked without installing it, and gets the same findings an install would. Nothing from the repository runs.
- [ ] With scanning on, what a build installed is checked before its tools are published, and generated tool descriptions, including those of tools added after the install, are checked before they are published.
- [ ] The operator can turn network containment on from the environment. With it on, no clone, build or sandbox can reach the host it runs on, the local network or link-local addresses, whatever its network setting, except addresses the operator has allowed for that project. A clone reaches only its forge; a build reaches only what its build system needs plus hosts added for that project; a sandbox with its network on reaches only hosts added for that project. The agent can add hosts to a project, but not local addresses. *(Observable only against real Docker: flagged for a behavior test or the Docker-gated suite at the flight that owns it.)*
- [ ] With containment on, projects whose builds fetch only from their package registries install as they do today. A build or sandbox refused a host fails with a message that names the host and how to allow it.
- [ ] When the operator names a stronger isolation runtime, everything mcp-everything runs in a container uses it, and the operator can require it, so that no install or check starts if Docker does not have it. *(Observable only against real Docker with the runtime installed.)*
- [ ] The README describes what is checked and when, how an operator adds a scanner and sets the policy, how to turn containment on, what it allows and how to change that, the isolation runtime, what reaches outside services when scanning is on, what existing projects need after upgrading, and what none of this protects against.

## Stakeholders
- **The operator**, who owns the machine and network mcp-everything runs on, and who carries the consequences of a hostile project. The primary stakeholder.
- **The agent**, which chooses projects to install and needs to know how protected an install is to make that choice responsibly.
- Anyone running mcp-everything from the README, who keeps today's out-of-the-box behavior, is told what is off, and can turn each protection on from the environment.

## Constraints
- **Scanning is off by default** and turned on from the environment (operator, 2026-11-21). With it off, installs are not scanned and nothing is sent to an outside service for scanning; the agent is still told the status. The check tool is the exception: it runs whenever the agent calls it, scanning on or off (operator, 2026-11-21, at flight 1's design: an explicit request to check is not a weakening). Whether such a check may send anything to an outside service is for flight 3, which adds the first check that does.
- **Network containment is off by default** and turned on from the environment (operator, 2026-11-21: first agreed as on by default, changed the same day so that mcp-everything is easy to use out of the box). With it off, networks behave as today and the agent is told they are not contained.
- **Only the operator configures scanners, the policy, containment and the isolation runtime**, through mcp-everything's environment or a file it names. No tool parameter can turn any of them off, or add, skip or change a scanner.
- **The agent can add hosts to a project's allowlist freely** (operator, 2026-11-21), for builds and for a sandbox's network after install. While containment is on, the host machine, the local network and link-local addresses stay unreachable whatever the agent adds; that holds for a name that resolves to such an address, not only for an address given directly. The record of which hosts were added is visible.
- **Only the operator can let a project reach local addresses** while containment is on, per project, for MCP servers meant to talk to something local (a database on the host, a service on the local network).
- **A scanner that fails or times out never blocks** (operator, 2026-11-21); it is reported to the agent as a failed check.
- **Nothing new is installed on the host.** Scanners and anything containment needs run as containers; the isolation runtime is the operator's to install and to name, as `MCPE_DOCKER_RUNTIME` does today; mcp-everything does not switch to one on its own. Every new container mcp-everything starts gets the same limits and runtime as the sandbox.
- **Everything new that mcp-everything creates in Docker is owned as mission 02 defined.** Containers and networks added for checks or containment carry the installation's identity, are named so two installations cannot collide, and are never removed or changed by an installation that does not own them.
- **Images mcp-everything chooses are pinned by digest**; the README advises operators to pin their own scanners' images the same way.
- **What comes back from a scanner is the repository's text.** Findings quote strings from the repository and reach the agent; they are cleaned and bounded like other repository-derived text (squawk 0018 bounded build warnings).
- **Scanners read; they do not write.** A scanner sees the repository read-only and cannot change what is built. Its network is off unless the operator's configuration for that scanner turns it on; a credential it needs is passed by variable name from mcp-everything's environment, never stored. Scanner time is bounded, inside the install's own time limit.
- **Tool names and `<slug>__<NAME>` variable names do not change.** The registry format changes only if a flight shows it must; if it does, it bumps `version` under the rules mission 02 recorded. Containment may make one necessary: a sandbox's network has three states once it exists (off, contained, open when containment is off), where the record holds a boolean.
- **Allowed hosts are a way out as well as in.** Anyone can host a file on GitHub release downloads, which builds that fetch prebuilt binaries need, so payloads are not prevented. And a server given `<slug>__<NAME>` values can send them to any host its project allows. The README says both.
- **Image pulls are outside containment**: the Docker daemon pulls them, from registries the image names. The README says so.
- **The isolation runtime may refuse some builds** (raw sockets, unsupported system calls). Such a project fails visibly; the criterion on builds that install as today is measured without the runtime required.
- **Verifiable on one Linux host with Docker.** Nothing is claimed for Docker Desktop or Windows beyond what was tested; WSL2 and Docker Desktop reach the host differently. The isolation runtime is verified where it can be installed.
- Snapshot or golden-file baselines are not committed (operator's standing rule); none is expected.

## Environment Requirements
- Node 22.12 or later; Docker for the integration suite (`npm run test:docker`) and for any behavior test.
- gVisor (`runsc`) registered with the local Docker daemon, to verify the isolation-runtime criterion.
- Outbound access to GitHub's API and to OSV while developing and testing the built-in dependency check.
- The hosted check runs on Linux without Docker; what needs Docker is run locally before a pull request is marked ready, as in missions 01 and 02.

## Open Questions
- [ ] **A blocked reinstall.** The criterion says a project already installed stays working. Lean: a check clones into a staging volume of its own (which the check tool needs anyway), the install proceeds only if the policy lets it, and only then is the old sandbox removed. Whether the staging clone then becomes the project's volume or is thrown away.
- [ ] **Where the proxy lives, and how many.** A proxy inside the mcp-everything process means sandboxes have to reach the host, which is what containment forbids. Lean: a small proxy container, the only member of both an internal network and the bridge. Open: one per installation with per-source allowlists, or one per project; who creates and removes it; what happens after the daemon restarts.
- [ ] **How the proxy decides.** It resolves names itself and connects to the address it checked, so a name cannot resolve to an allowed address for the check and a forbidden one for the connection. Refused ranges include loopback, private ranges, carrier-grade NAT, link-local, IPv6 unique-local and IPv4-mapped IPv6, and the host gateway. Containers get no resolver of their own beyond what the proxy needs; whether Docker's embedded DNS answers outside names on an internal network is to be run, not assumed.
- [ ] **What each build system needs.** The default hosts per build system (npm, PyPI and its file host, crates.io and its index, the Go module proxy and checksum database, rubygems, forges for git dependencies), and those that self-hosted forges named in `MCPE_EXTRA_HOSTS` add. Measured against the projects the test suites install.
- [ ] **What has no route.** Tools that ignore proxy settings, raw TCP and git over SSH fail closed; the question is only how clear the message is, and whether any clone URL the repository parser accepts uses SSH.
- [ ] **The network's three states** in the Docker layer and the record, whether that bumps the registry's `version`, and what `set_project_network` says, which today warns that the code can reach "the internet and your local network".
- [ ] **Existing sandboxes after upgrading.** Whether containment applies to an existing sandbox the next time its network is turned on, or only after a reinstall as mission 02 chose for ownership. With reinstall, an existing sandbox with its network on keeps the full bridge until reinstalled.
- [ ] **Requiring the runtime.** How mcp-everything learns, before starting anything, whether the runtime is registered with Docker, and what it reports when it is not.
- [ ] **Moving build output onto a volume.** `/opt/mcpe`, `/root/.cargo`, `/usr/local/go` and gem installs; how existing sandboxes come across, probably by reinstalling, as in mission 02; and checking it only once the build has finished writing.
- [ ] **The scanner contract.** The configuration format; the stages (before the clone, after the clone, after the build, generated tools) and what each is given; the findings format (the lean is SARIF, which most scanners write already) and how its severities map to the policy's threshold; time limits.
- [ ] **The built-in checks under the same contract.** The list of what the build will run (lifecycle scripts, `setup.py`, `build.rs`, CMake, Makefiles) and the dependency check. The dependency graph describes the default branch, not a pinned `ref`, and includes test fixtures; what is reported when it does not apply (GitLab, a pinned ref, no graph).
- [ ] **Where the security status is shown.** Server instructions, install results, `project_info`, `list_projects`, and whether `search_projects` should say anything.

## Known Issues
N/A

## Flights

> **Note:** These are tentative suggestions, not commitments. Flights are planned and created one at a time as work progresses. This list will evolve based on discoveries during implementation.

- [x] Flight 1: [**Checking a project's own code before it runs**](flights/01-checks-before-code-runs/flight.md) — the scanner contract and its runner, the operator's opt-in and policy, the check after the clone and before the build (moved ahead of a reinstall's removal), the built-in list of what the build will run, the check tool, and reporting the security status to the agent. The machinery the other checks plug into; most of the design decisions are here and they are entangled.
- [x] Flight 2: [**Contained network and isolation runtime**](flights/02-contained-network-and-runtime/flight.md) — the operator's opt-in, the proxy and internal networks for clones, builds and sandboxes after install, the network's three states, the agent's per-project hosts and the operator's local-address exceptions, and reporting and requiring the isolation runtime. A risk point of its own: it replaces how every sandbox is put on and taken off the network, whether containment is on or not.
- [ ] Flight 3: [**Checking dependencies and tool descriptions**](flights/03-dependency-and-tool-checks/flight.md) — the dependency check before the clone (GitHub's dependency graph against OSV), and checks of generated tool descriptions, including tools added after the install, with flagged tools withheld under block. *(Split from the original flight 3, "Checking what a project brings with it", with the operator on 2026-11-23: it held three independent clusters of decisions.)*
- [ ] Flight 4: **Checking what a build installed** — build output moved onto a volume so what a build installed can be checked, and a scanner stage after the build. Preceded by the mechanical split of `src/sandbox/docker.ts` and `src/network/containment.ts` and the fix for sandboxes made before ownership labels (flight 2's debrief). The layout change is hard to reverse and changes what existing projects need.
