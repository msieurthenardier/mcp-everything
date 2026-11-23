# Flight: Contained Network and Isolation Runtime

**Status**: ready
**Mission**: [Vetted and Contained Installs](../../mission.md)

> **Planned with the operator on 2026-11-22.** Decisions taken in that conversation are marked "(operator, 2026-11-22)". Before the questions were asked, the Flight Director ran the trials flight 1's debrief asked for, on the operator's daemon, in throwaway containers and networks that were removed afterwards; their results are under **Trials** and every design decision that rests on one cites it.
>
> **Design review 1** (Architect, 2026-11-22): approve with changes. Its high issues are folded in, along with the medium ones:
> - a forward target named by a network alias resolved to the proxy itself (measured by the Flight Director, T11–T13, and fixed in DD10);
> - the startup sweep would have removed every project's proxy and network (DD2);
> - an existing sandbox could run uncontained during the startup pass, and nothing restarted a missing proxy (DD2, DD8);
> - proxy replacement had no lock (DD2), and sessions with different environments could fight over a proxy (DD8);
> - `hosts` could be lost by two record writers (DD6);
> - the order of a contained sandbox's creation was unstated (DD7);
> - the proxy listened where open containers could reach it (DD4);
> - IP literals bypassed the name allowlist (DD4);
> - the CI trigger could miss the pull request that changes the code (DD13).
>
> Two legs were split (the Docker layer; the after-install work), and the runtime leg moved ahead of the first leg that starts a container.
>
> **Design review 2** (Architect, 2026-11-22, the last pass the method allows): approve with changes. Folded in:
> - a full table of what the startup pass does for each combination of record and Docker state. A sandbox whose record says off but is on `bridge` is taken off, not contained (DD8);
> - containment, its wait and its repair, as one hook inside the Docker layer that every exec and start passes through, so no call site can miss it (DD2);
> - the proxy's configuration label split into what the record decides and what the session decides, so sessions with different environments do not fight on every use (DD2, DD8);
> - replacement built under its lock from a fresh read (DD2);
> - record writers that keep `hosts` (DD6);
> - DD11's trial container specified;
> - Docker's address pools (DD15);
> - orphaned project objects (DD8);
> - forward port collisions (DD10).
>
> Two questions went to the operator (2026-11-22):
> - **An existing sandbox created under another runtime is refused, with "reinstall it"**, once a runtime is named (DD11).
> - **The flight branch is pushed and a draft pull request opened at leg 4**, so that the native-Linux measurements run before legs 5–9 depend on them (DD13).

## Contributing to Criteria
- [ ] With nothing configured, installs behave as they do today, and the agent is told so. *(This flight replaces flight 1's fixed "not contained" line with the real state, and states the runtime truthfully.)*
- [ ] The operator can turn network containment on from the environment. With it on, no clone, build or sandbox can reach the host it runs on, the local network or link-local addresses, whatever its network setting, except addresses the operator has allowed for that project. A clone reaches only its forge; a build reaches only what its build system needs plus hosts added for that project; a sandbox with its network on reaches only hosts added for that project. The agent can add hosts to a project, but not local addresses. *(Amended by the operator, 2026-11-22: a sandbox with its network on also reaches its build system's registries, DD6.)*
- [ ] With containment on, projects whose builds fetch only from their package registries install as they do today. A build or sandbox refused a host fails with a message that names the host and how to allow it.
- [ ] When the operator names a stronger isolation runtime, everything mcp-everything runs in a container uses it, and the operator can require it, so that no install or check starts if Docker does not have it. *(Naming it is requiring it, DD11.)*
- [ ] README: how to turn containment on, what it allows and how to change that, the isolation runtime, what existing projects need after upgrading, and what none of this protects against. *(Flight 2's part.)*

---

## Pre-Flight

### Objective
Give the operator one switch that contains every network mcp-everything uses. Each project, and each clone or networked scanner, gets a Docker network of its own, with no route anywhere and no address on the host. A small proxy of mcp-everything's own is the only way out. The proxy:
- resolves every name itself;
- refuses the host, local and link-local addresses, whatever a name resolves to;
- allows only the sites the build system needs, the hosts added for that project, and the exact local addresses the operator allowed for that repository.

With the switch off, networks behave as today and the agent is told so. Alongside it, a runtime the operator names is checked before anything starts. A new CI job on plain Linux, with gVisor installed, proves that every container runs under it.

### Trials (2026-11-22, operator's daemon: Docker Desktop on WSL2, server 29.8.2)
The trials used throwaway objects named `mcpe-plan-<n>`, all of them removed. The trial script and proxy live in the session scratchpad, not the repository.
- **T1 — an `--internal` network has no way out and no outside names.**
  - The container has one route: its own subnet.
  - `nslookup example.com` and `nslookup host.docker.internal` both get SERVFAIL from Docker's embedded DNS.
  - TCP to `1.1.1.1:443` gets ENETUNREACH.
- **T2 — but its gateway is the host.**
  - TCP to the gateway address (`172.22.0.1`) on ports 22, 80 and 2375 gets **ECONNREFUSED**, so a host network stack answered. Anything on the Docker host listening on all addresses is reachable from an internal network.
  - `192.168.65.254`, `172.17.0.1` and `169.254.169.254` get ENETUNREACH.
- **T3 — `-o com.docker.network.bridge.gateway_mode_ipv4=isolated` removes it.**
  - The network has no gateway (`IPAM.Config` has no `Gateway`).
  - A container on it took `.1` itself, and containers on the network still reach each other.
  - `inhibit_ipv4=true` also leaves no gateway.
  - Neither was tried on an older daemon, which may ignore an option it does not know. DD3 therefore checks the result, not the version.
- **T4 — a CONNECT proxy on both networks works.**
  - The proxy was about 25 lines of Node: a CONNECT proxy in `node:22-alpine`, on the bridge and on the internal network.
  - From the internal network, `alpine/git` with `HTTPS_PROXY` set cloned `tomnomnom/gron` with only `github.com` allowed. The proxy logged `200 github.com:443 -> 140.82.114.3`.
- **T5 — the proxy must refuse what Docker Desktop exposes.**
  - From the bridge, `host.docker.internal` resolves to `fdc4:f303:9324::254` (IPv6 unique-local) and `gateway.docker.internal` to `fdc4:f303:9324::1`.
  - From the default bridge, `host.docker.internal:80`, `192.168.65.254:80` and `172.17.0.1:80` answer ECONNREFUSED, so they are reachable.
- **T6 — clients that resolve before proxying fail closed.** busybox `wget` with `https_proxy` set answered `bad address` on the internal network, because it resolves the target itself. The result is closed, but the message does not help.
- **T7 — the default bridge is shared.** Today every sandbox with its network on is on `bridge` and can reach every other's addresses. Per-project networks end that.
- **T8 — the sandbox sees a network alias, and the alias survives a restart.**
  - With `docker network connect --alias host.docker.internal --alias db.lan <net> <proxy>`, both names resolve to the proxy's address in a sandbox on that network, also after `docker restart` of the sandbox.
  - Writing `/etc/hosts` inside the sandbox instead does not survive a restart, because Docker rewrites it.
- **T9 — an unknown runtime is refused by Docker.** `docker create --runtime runsc …` fails with `unknown or invalid runtime name: runsc`, exit 1. There is no fallback.
- **T10 — runtimes registered here**: `io.containerd.runc.v2`, `nvidia`, `runc` (`docker info --format '{{json .Runtimes}}'`). No `runsc`.
- **T11 — an alias on the project network poisons the proxy's own lookups** (after review 1).
  - Once the proxy has joined the internal network, its resolver is `127.0.0.11` (on the bridge alone it was `192.168.65.7`).
  - `host.docker.internal` and `db.lan` then resolve to the proxy's own address, through `getent` and Node's `dns.lookup` alike.
- **T12 — the alias poisons them wherever it sits.** A separate container on the network holding the alias still made the proxy's `dns.lookup("host.docker.internal")` return that container's address. Docker's embedded DNS answers an alias for the whole network.
- **T13 — two ways around it, both measured on Docker Desktop.**
  - (a) A proxy created with `--add-host host.docker.internal:host-gateway` has `192.168.65.254` and `fdc4:f303:9324::254` in its own `/etc/hosts`. `getaddrinfo` reads files first, so `dns.lookup` returned those, not the alias, while the sandbox still saw the alias.
  - (b) A Node `dns.Resolver` set to the bridge's upstream server resolved `host.docker.internal` to `192.168.65.254` and `github.com` normally. The server was `192.168.65.7`, read from a one-shot container on `bridge`.

### Open Questions
- [x] Where the proxy lives, and how many → DD2 (one per project, and one beside each networked one-shot; operator).
- [x] How the proxy decides → DD4 (resolve, refuse by resolved address, connect to the checked address; our own program; operator).
- [x] What each build system needs → DD5 (a starting table, measured in leg 6).
- [x] What has no route → DD4, DD9 (fails closed; T6; messages).
- [x] The network's three states, registry `version` → DD7 (no bump; "contained" vs "open" read from Docker).
- [x] Existing sandboxes after upgrading → DD8 (contained at startup; never loosened; operator).
- [x] Requiring the runtime → DD11 (naming it is requiring it; operator).
- [x] Agent's hosts → DD6 (`hosts` on install, `set_project_hosts`; operator).
- [x] Operator's local exceptions → DD10 (`MCPE_LOCAL_ACCESS`, by repository; operator).
- [x] Scanners under containment → DD12 (`hosts` per scanner; cache stays deferred; operator).
- [x] Proving gVisor → DD13 (GitHub Actions job on plain Linux; operator: "if we are going to advertise gvisor we should probably prove it works").
- [x] HAT leg → yes (operator, 2026-11-22).
- [x] How the proxy resolves a forward target that is also an alias → DD10 (T11–T13).
- [ ] The minimum Docker version for the README. DD3 does not depend on it, because it checks the network it made. It is measured or read from Docker's release notes in leg 4, never stated from memory.

### Design Decisions

**DD1 — The switch.** `MCPE_NETWORK`: `open` (default) | `contained` (operator, 2026-11-22).
- It is read at startup like every `MCPE_*` setting, and an invalid value is a startup error (squawk 0015's rule).
- `open` is today's behavior exactly, with the agent told the network is not contained.
- No tool parameter can change it (mission constraint).
- Rationale: one variable, with room for a later value without a rename.
- Trade-off: no per-project switch; a project that must be open needs an installation with `MCPE_NETWORK=open`.

**DD2 — One proxy per project** (operator, 2026-11-22).
- **A project with its network on, under containment.**
  - Its sandbox is on a network of its own (`<sandbox name>-net`) and on no other.
  - A proxy container (`<sandbox name>-proxy`) is on that network and on `bridge`, and is the sandbox's only way out (T1, T4).
  - Names cannot collide: slugs never contain `-` (`src/sandbox/docker.ts`, the comment at the one-shot names), and Docker networks have their own namespace.
  - "Off" stays what it is today: the sandbox on no network at all, and no proxy.
- **The sandbox reaches the proxy by a name, not an address.** The proxy holds the network alias `mcpe-proxy`, and the sandbox's commands get `HTTPS_PROXY=http://mcpe-proxy:3128` (DD5). A replacement can therefore come up beside the old proxy before the old one goes.
- **Its configuration is fixed when it is created.** Two canonical (sorted) hashes are carried in labels (review 2):
  - **`mcp-everything.proxy-record`** covers what the record decides: the project's ecosystems, its `hosts`, and the phase (build or after install).
  - **`mcp-everything.proxy-session`** covers what the session's environment decides: the `MCPE_LOCAL_ACCESS` entries for its repository, `MCPE_EXTRA_HOSTS`, and the upstream resolver list (DD4).
  - **Both include** the proxy program's version, the default host table's version, the refused-range table's version and the image digest, so an upgrade of mcp-everything replaces old proxies.
- **A change replaces the proxy.** Changes include hosts added, the operator's local access, and the end of an install (DD7).
- **Replacement, in order:**
  1. **Ensure the image** (no pull happens under the lock).
  2. **Take the project's lock.** This is an in-process mutex per slug plus a lock file beside the registry: `<registry>.proxy-<slug>.lock`, created exclusively, with a token, waited for **asynchronously**, and stale after 120 s.
     - The registry's own lock is neither reused nor imitated: it busy-waits synchronously and treats a lock older than 10 s as stale (`src/registry.ts:99-130`).
     - A lock file left by a crash is taken over at the next use. Lock files of slugs that no longer have a record are removed by the startup pass (DD8).
  3. **Force a fresh read of the record** (`registry.update`'s re-read, not the 5-second refresh at `src/server.ts:552`) and **build the configuration from it**, never from a record held by the caller.
  4. **Compare the labels.** If they match, release and stop.
  5. **Create** `<sandbox name>-proxy-<hex>`, holding the alias `mcpe-proxy`, and wait until it accepts connections. **If it never does, remove it and keep the old one.** The record stays ahead, and the next use retries.
  6. **Remove every proxy of the project except the one just built.** This also clears a second proxy left by a lock stolen from a live holder. Repair treats more than one proxy as a fault and does the same.
  7. Release.

  Writers write the record first (`registry.update`), then replace. A crash between the two leaves the record ahead of the proxy, which the labels show, and the next use repairs it.
- **During the overlap of steps 5 and 6**, both proxies hold `mcpe-proxy`. Docker's embedded DNS returns both addresses, and musl clients take the first, so traffic may still reach the old proxy. **A tightening** (a host removed, the end of an install's wider allowlist) is therefore effective only at step 6. The window is bounded by the readiness wait, and the README states it. Connections in flight through the old proxy are cut at step 6. The overlap is not yet measured: leg 4 measures a two-holder alias, and leg 5 has a case for it.
- **Lifecycle.**
  - The proxy is created with its sandbox's network turning on, and removed with it turning off, or with the project (classified first, like its container and volume).
  - It carries the owner and project labels mission 02 defined, and `mcp-everything.role=project-proxy` (its network: `project-net`).
  - **It does not idle out**: it is stateless and about 30–40 MB.
  - When the sandbox's own watchdog stops an idle sandbox, its proxy keeps running until the next startup. The startup pass (DD8) stops proxies of stopped sandboxes. Their networks stay, and hold an address range (DD15).
- **Containment, its wait and its repair are one hook inside the Docker layer** (review 2).
  - **Why one hook.** The Docker class has no record, no `hosts` and no `MCPE_LOCAL_ACCESS`, so it cannot build a proxy's configuration. Starting a sandbox happens in several places: `acquire`, `ensureRunning`, the restart inside `exec` (`startIfStopped`, `src/sandbox/docker.ts:1079`) and the MCP connector. `exec` with a `SandboxRef` does no inspect at all (`:1062-1076`). Call sites hold only references:
    - `src/server.ts:640` (`sandbox()`), `:696`, `:1118`, `:1131`, `:1146`;
    - `src/install/installer.ts:253` (`execFor`), `:624`, `:627`, `:804`;
    - `src/proxy/mcp-proxy.ts:247`, `:259`, `:262`.
  - **What it is.** The Docker class takes an injected `ensureContained(ref)` hook, provided by the server, which knows the registry and the session's configuration. It runs before every exec and every start, in `acquire`, `ensureRunning`, `startIfStopped` and the connector's start, and is never called from individual call sites. It:
    1. waits for that slug's startup step (DD8);
    2. reads Docker's view of the sandbox's networks;
    3. if contained, repairs **in this order**:
       - the network: a missing `-net` is recreated, and the stopped sandbox reconnected to it, because a sandbox whose network was removed cannot start;
       - then the proxy: started, or replaced when missing, more than one, or carrying a differing **record** label (the session label is not compared here; DD8);
       - then the sandbox start;
    4. returns the environment for the exec.
  - **The exec environment comes from Docker's view, never from `MCPE_NETWORK`.** A contained sandbox gets the proxy variables whichever session execs into it; an open or offline one gets none.
  - **A test asserts that there is no exec or start path that bypasses the hook.** The new Docker methods go in the coverage test's guarded table (`test/docker.test.ts:634`).
- **One-shots that need a network** (the clone, a networked scanner) get a one-shot network and a one-shot proxy beside them.
  - Roles are `oneshot-proxy` and `oneshot-net`, with names in flight 1's one-shot form `<prefix><id>-<role>-<hex>` and no project label.
  - **The proxy image is ensured before any network is made.** Readiness is a TCP connect, not a sleep.
  - **Teardown order** is container, then proxy, then network. Each step is independent and tolerant, like `runOnce`'s `finally`.
  - **A proxy that could not start** is reported as such ("the network proxy did not start: …"), never as a refused host.
  - Trade-off accepted: two more Docker objects per clone, and their failure modes. A shared one-shot proxy per installation was offered by review 1 and not taken: it would be a second lifecycle to build and test for a saving of about a second.
- **The startup sweep** (flight 1 DD6) gains `oneshot-proxy` and `oneshot-net` only.
  - It still requires the owner label equal to this installation, and it now **also requires the absence of a project label**. A project's proxy or network can never match.
  - Networks are new to it: `docker network ls --filter label=…`, with age from `network inspect`'s `Created`.
  - Containers go first, then networks, and a network that still has endpoints is skipped.
  - Unit case: an aged `project-proxy` and `project-net` survive the sweep.
  - **Classification is by labels only, never by name.** A project with the slug `oneshot` names its replacement proxy `<prefix><id>-oneshot-proxy-<hex>`, which has the same form as a one-shot proxy. Unit case.
- **Hardened like everything else**: `limits()` (so the named runtime applies, DD11), `--cap-drop ALL` with no added capabilities, `--read-only` with a small tmpfs, no volume, never `--publish`, never `--network host`. A unit case asserts the create arguments; a Docker case asserts `HostConfig.NetworkMode`.
- Rationale: the containment boundary is the ownership boundary mission 02 built. A bug in one proxy exposes one project's allowlist, and "add a host" means "replace the proxy".
- Trade-off: one more small container per online project.
- Rejected: one proxy per installation on every project's network (shared state across projects, all networks cut on its restart, live reconfiguration).

**DD3 — The networks.**
- Every network mcp-everything creates under containment is `--internal` with `-o com.docker.network.bridge.gateway_mode_ipv4=isolated`. IPv6 is explicitly off, and it carries the owner label (and project, for a project's).
- **After creating one, mcp-everything inspects it and refuses to use it unless it has no gateway and no IPv6** (T3). A daemon that ignores the option is caught by what it made, not by a version number.
- **A daemon that cannot** (the check fails):
  - The network is removed, and the operation refuses with a message naming what Docker must support.
  - mcp-everything never falls back to `bridge` (operator, 2026-11-22).
  - Installs, networked checks and turning a network on refuse; projects whose network is off keep working.
  - Startup logs it, and the security paragraph says "containment is on but Docker cannot provide it".
- Rationale: T2 showed that `--internal` alone leaves the host reachable. Checking the result is the only thing that survives version drift.

**DD4 — The proxy is our own program** (operator, 2026-11-22: option A).
- A few hundred lines of Node shipped inside mcp-everything. It runs with `node -e` (like `PROBE_SCRIPT` and `WATCHDOG_SCRIPT` today) in a digest-pinned `node:<lts>-alpine` image.
- Its configuration is passed as one JSON argument: allowlist, forwards, the upstream resolver, the project's identity. No secret is ever in it.
- **Where it listens**: only on its address on the project's (or one-shot's) internal network. It reads the network's CIDR from its configuration and binds the matching interface address. It never listens on its `bridge` address, so open sandboxes and other containers on `bridge` cannot use it. Docker case: from a container on `bridge`, the proxy's bridge address on 3128 and on each forward port is refused.
- **What it does**:
  1. HTTP `CONNECT host:port` for allowed hosts.
  2. Plain HTTP forwarding of absolute-URI requests for allowed hosts on port 80, which Debian's `apt` uses. It routes by the request URI's authority, never the `Host` header. It re-checks the destination for every request on a keep-alive connection and never follows redirects.
  3. **It resolves every name itself, refuses if the address it would connect to is in a refused range, and connects to exactly that literal address.** It never passes a name to `net.connect`, which would resolve again.
  4. The operator's TCP forwards (DD10).
  5. A bounded list of refusals (DD9).

  Everything else is refused: other methods, malformed requests, and a name that resolves only to refused addresses.
- **Name resolution** goes through a `dns.Resolver` set to the bridge's upstream servers (T13b), never Docker's embedded DNS, whose answers include aliases on the project's network (T11, T12).
  - The upstream servers are read by mcp-everything from a one-shot container on `bridge` (`/etc/resolv.conf`), once per process, and passed in the configuration.
  - The list is part of the session label (DD2), so every restart of mcp-everything replaces online proxies whose resolver changed.
  - Within a process, it is re-read and the proxy replaced when a repair finds the proxy reporting repeated resolver failures. A network change on the host (VPN, Wi-Fi) is therefore picked up at the next startup or the next repair after it starts failing.
  - On native Linux with systemd-resolved, Docker replaces loopback servers in a bridge container's `resolv.conf` with public ones, so split-DNS names (`db.lan`) may not resolve. This is measured on the runner (leg 4) and stated in the README.
  - The one exception is DD10's `host.docker.internal`, which comes from the proxy's own `/etc/hosts` (T13a).
- **Its control endpoint** listens on loopback inside the proxy only, which the sandbox cannot reach. mcp-everything reads it with `docker exec <proxy> node -e …` to get the refusal list (DD9) and the configuration it actually carries (DD8). The container is `--read-only` and keeps nothing on disk.
- **IP literals** in a request are refused unless that literal is itself an allowed entry (in `hosts` or DD5's table) and outside the refused ranges. The allowlist is by name, so an address must not bypass it.
- **Refused ranges**:
  - IPv4: `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, `224/4`, `240/4`, `255.255.255.255`.
  - IPv6: `::/128`, `::1`, `::/96` (IPv4-compatible), `fc00::/7` (T5), `fec0::/10`, `fe80::/10`, `ff00::/8`.
  - Judged by their embedded IPv4: IPv4-mapped `::ffff:0:0/96`, NAT64 `64:ff9b::/96` and `64:ff9b:1::/48`, 6to4 `2002::/16`, and Teredo `2001::/32` (whose client address is stored inverted).
  - The proxy's own addresses and the subnets of the networks it is on are refused by the same rule.
  - The table is unit-tested case by case (mission open question).
- **Residual routes the table cannot cover**, stated in the README: the Docker host's own public or global IPv6 addresses and its published ports, which are reachable as ordinary internet addresses. The proxy is on `bridge`, so its refusal table is the entire boundary.
- **Allowed host matching**:
  - an exact name, or `*.example.com` for subdomains (not `example.com` itself);
  - case-insensitive, with a trailing dot removed, and IDNs compared in their ASCII form;
  - ports 443 and 80, unless the entry names one (`example.com:8443`).
- **Hostile input**: everything the proxy reads comes from the project's code.
  - Request lines and headers are bounded in size, count and time to first byte.
  - A refused or malformed request gets a status, and the connection is closed.
  - The refusal list is bounded, and its strings are cleaned before mcp-everything shows them (flight 1 DD3's rule).
- Rationale: the rules are the flight's security boundary. They should be code with unit tests, not a configuration of a third-party proxy (Squid, Tinyproxy) whose resolve-then-connect behavior we would have to trust.
- Trade-off: we own a network program's bugs. Hence the proxy is its own leg, with an attack-minded design review (flight 1 debrief: one leg per kind of risk).

**DD5 — What a build reaches by default.** The proxy for a build allows the project's build-system hosts, GitHub and its download hosts, and the project's own `hosts` (DD6). The starting table below comes from the recipes (`src/install/recipes.ts`). It is **measured in leg 6** by installing the test suites' projects through the proxy, as the mission asks.

| Build system | Hosts |
|---|---|
| Every build | Debian's package servers (`deb.debian.org`, `security.debian.org`, for the recipes' `need` → `apt-get`); `github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com` |
| Python | `pypi.org`, `files.pythonhosted.org` |
| Node | `registry.npmjs.org`, `nodejs.org`, `repo.yarnpkg.com`, `registry.yarnpkg.com` |
| Rust | `crates.io`, `index.crates.io`, `static.crates.io`, `static.rust-lang.org` |
| Go | `proxy.golang.org`, `sum.golang.org` |
| Ruby | `rubygems.org`, `index.rubygems.org` |
| CMake / Make / autotools | (every build's row only) |

- **GitHub is in by default for builds** (operator, 2026-11-22). Git dependencies and prebuilt binaries are common, and anyone can host anything there, as on npm or PyPI. The README says so (mission constraint on allowed hosts).
- **The clone** reaches only the repository's forge: `github.com`, `gitlab.com`, or a host named in `MCPE_EXTRA_HOSTS`. Submodules on another forge are refused, and the message names the forge.
- **Clients.**
  - The sandbox's commands get `HTTP_PROXY`, `HTTPS_PROXY`, their lower-case forms, `NO_PROXY=` (empty) and `NODE_USE_ENV_PROXY=1` (Node's own `fetch` ignores the variables otherwise).
  - These are passed **per `docker exec`**, not at container creation, so an existing sandbox can be contained without a reinstall (DD8). `ExecOptions` has no `env` today (`src/sandbox/docker.ts`, `execOnce` at :1086), so it gains one, and the MCP connector (`src/proxy/mcp-proxy.ts:113`) adds the same `-e` flags. These are the only two places a sandbox command starts (review 1, verified).
  - `NODE_USE_ENV_PROXY` needs Node 24 (or 22.21+). The sandbox images' Node versions, and which clients honor the variables (npm, pip, cargo, go, git, gem, apt), are measured in leg 6, not assumed.
  - T6 shows that a client that ignores them fails closed. Processes the project starts itself with the variables unset fail the same way, and the README says so.

**DD6 — The agent's hosts** (operator, 2026-11-22).
- **`install_project` gains `hosts`** (a list), for the build and for the sandbox afterwards.
- **A new tool, `set_project_hosts(project, add, remove)`**, uses add/remove, not replace, so two sessions cannot wipe each other's changes. It writes with `registry.update` (locked and re-read). If the project's network is on and contained, its proxy is then replaced (DD2).
- **The list is a new optional field `hosts` on the record**, shown by `project_info`.
  - It is **kept by a reinstall**: `openInstall` carries it from `existing` beside `selection` (`src/install/installer.ts`, around :437), with a unit case.
  - With `MCPE_NETWORK=open` it is recorded, and the tool says it has no effect until containment is on.
- **`hosts` belongs to its own writers, and every other writer keeps what the file holds** (review 2).
  - `set_project_network` stops doing `registry.put({ ...project, network })` with a record read before its Docker call (`src/server.ts:1161`) and uses `registry.update`.
  - The installer's writers of an in-hand record (`src/install/installer.ts:529`, `:542`, `:573`, `:681`, `:702`, `:815`, `:898`) hold that record across minutes of build, or across a sandbox call. They go through one helper that writes under the lock and takes `hosts` from the current file.
  - The only writers of `hosts` are `set_project_hosts`, and `openInstall` from `existing` plus the install's `hosts` parameter.
  - Unit cases: a `set_project_hosts` landing during an install, a rediscovery and a `set_project_network` is not lost.
- **`hosts` on a reinstall is merged**: the install's `hosts` parameter adds to the hosts the project already has. Removing goes through `set_project_hosts`.
- **Entries**: DD4's grammar. The tool refuses:
  - a bare `*`;
  - a wildcard on a public suffix (`*.com`, `*.co.uk`);
  - an IP literal in a refused range;
  - anything that is not a host name or `host:port`.

  Names that **resolve** to refused addresses are refused by the proxy at connect time (mission constraint).
- **The record is re-validated when a proxy is built.** The registry parses JSON without validating fields (`src/registry.ts`), so a hand-edited or older record could hold a refused entry. An entry that fails DD4/DD6's rules is dropped with a warning, never baked in.
- **With its network on after install, a sandbox also reaches its build system's registries**: DD5's rows for its ecosystems, without GitHub unless added (operator, 2026-11-22). This keeps the "turn the network on and rerun the install by hand" repair working. The README states the trade-off: a running server can reach its registry, which is a way out as well as in.

**DD7 — The three states, no registry `version` bump.**
- **The record keeps `network: boolean` as on or off.** Whether "on" is **contained** or **open** is read from Docker, from which networks the container is on:
  - none → off;
  - its own `-net` only → contained;
  - `bridge` (alone, or with its `-net`, a half-finished move) → **open**, corrected at the next containment step.
- The record gains only optional fields (`hosts`), as records did before (`mcpServers`, `published`, `selection`, `scan`).
- `hasNetwork` (no caller outside tests, review 1) becomes the three-valued state.
- `setNetwork(target, mode)` becomes "off", "contained" (own network plus proxy) or "open" (`bridge`). The caller chooses from `MCPE_NETWORK`. Its four callers (`installer.ts:536`, `:782`, `server.ts:1160`, and the takeOffline path) are updated.
- **"Off" disconnects every network the container is on, then removes its proxy and its `-net`.** Today it disconnects `bridge` only, so an older build's "off" on a contained sandbox fails with an error. `set_project_network` writes the record from Docker's result, not from what it asked for.
- **A contained install's order.**
  1. With `MCPE_NETWORK=contained`, the sandbox is created on its `-net` (not `bridge`; `createContainer` hard-codes `--network bridge` at `src/sandbox/docker.ts:1012`), with the build's proxy (DD5's allowlist) up first.
  2. The build runs, including every attempt of `buildAttempts` (new image, retry), with the same network and proxy.
  3. At the end, the proxy is replaced with the after-install allowlist (DD6) if `network: true`, or removed with the `-net` if not.
  4. Every failure path, `takeOffline` (`installer.ts:777`) included, removes the proxy and `-net` and never leaves a `bridge` membership.
- **With `MCPE_NETWORK=open` the install sequence is today's**, so the existing tests that pin `--network bridge` and `network connect|disconnect bridge` (`test/docker.test.ts:139-141`, `:236`, `:401`, `:791-794`, `:1094`, `:1779`) still describe `open` and stay. The exception is the "off" case, which changes deliberately as above. Contained behavior gets new cases.
- When a sandbox's network changes, its proxied MCP servers are closed, so their next start gets the new variables (they are `docker exec` processes).
- `set_project_network` says what it did. For contained: "contained: it can reach <registries>, <hosts>; local addresses only as the operator allows". For open: today's warning.
- `describe()` and `project_info` show Docker's view of the network (off / contained / open), not the record's boolean. They differ, for instance, mid-install, when the record says off while the build runs contained.

**DD8 — Existing sandboxes: contained at startup; never loosened** (operator, 2026-11-22).
- **At startup with `MCPE_NETWORK=contained`**, beside the reconciliation, a pass looks at every sandbox of this installation. It goes by **Docker's view** together with the record, never by the record alone:

  | Record | Docker: sandbox's networks | Proxy | Action |
  |---|---|---|---|
  | `installing`, younger than flight 1's age floor (another session's build may be live) | any | any | **skip** |
  | on | `bridge` | — | contain: `-net` and proxy, then off `bridge` |
  | on | `bridge` and `-net` (half-finished move) | any | off `bridge`, then repair |
  | on | `-net` only | running; record label matches | nothing; the session label is compared and the proxy replaced if it differs |
  | on | `-net` only | stopped, missing, more than one, or record label differs | repair (DD2's order) |
  | on | none | — | contain; the record's "on" is the intent, and contained is the tightest "on" |
  | off | none | none | nothing |
  | off | `bridge` | — | **take off every network and keep the record off**, with a warning. This is the fail-safe: it may come from a failed `takeOffline`, and a turn-on lost in a crash only costs a retry (review 2) |
  | off | `-net` | any | take off; remove its proxy and `-net` |
  | (no record, no container) | — | project proxy or `-net` of this installation | remove (orphans of a renamed project or a crashed uninstall), owner-checked |

  - Proxies of stopped sandboxes are stopped.
  - Lock files (DD2) of slugs with no record are removed.
  - Each row has a unit case. The Docker cases name the row they exercise.
- **Nothing runs uncontained meanwhile.** The pass is asynchronous (`src/server.ts:545`). Under `contained`, DD2's `ensureContained` hook, which every exec and start goes through, first awaits that sandbox's own step (a per-slug promise), so no call site has to remember it. A sandbox whose step failed refuses with the reason.
- **A session never loosens what another tightened.** A session with `open` leaves a contained sandbox contained, and makes a sandbox open only when it is itself turning that sandbox's network on. Every status line reports what Docker shows.
- **Sessions with different environments.** They are of one installation but have different `MCPE_LOCAL_ACCESS`, `MCPE_EXTRA_HOSTS` or resolver settings.
  - Each compares the **session** label only at its startup pass and when it itself changes that project. Repair on use compares the **record** label only (DD2).
  - So they do not replace each other's proxies on every use. The project's session-derived configuration is that of the last session to start or to change it. This is accepted and stated as a limit.
  - `project_info` reports the configuration the proxy actually carries (from its label and the proxy's own report), not the session's.
- Another installation's sandboxes and records are never touched (mission 02).
- A failure to contain one sandbox (Docker refuses, DD3's check fails) takes that sandbox off every network and records a warning. It never leaves it on `bridge`.

**DD9 — What the agent is told when something is refused.**
- Each proxy keeps the last 50 refusals: host, port, why and time, cleaned and bounded.
- mcp-everything reads them with `docker exec <proxy> …`, only on a failure, so there is no log-driver dependency (flight 1's lesson about `docker logs`).
  - **A failed install**: "The build was refused: `cdn.example.com:443`. To allow it, reinstall with `hosts: ["cdn.example.com"]`."
  - **A failed tool call with the network on**: the same, with `set_project_hosts`.
  - **`project_info`**: the latest refusals, or "no refusals recorded since the proxy started at <time>".
  - **A refused local address**: "only the operator can allow this, with `MCPE_LOCAL_ACCESS`" (DD10).
  - **A proxy that did not start** is reported as that, never as a refusal (DD2).
- The list lives in the proxy and goes when the proxy is replaced, including by the `set_project_hosts` that fixes it. That is stated, not worked around.

**DD10 — The operator's local access** (operator, 2026-11-22).
- **The variable.** `MCPE_LOCAL_ACCESS="acme/postgres-mcp=host.docker.internal:5432;acme/redis-mcp=db.lan:6379,db.lan:6380"`.
  - Keys are **repositories**, never slugs: `owner/repo` for GitHub; `gitlab.com/owner/repo` and hosts from `MCPE_EXTRA_HOSTS` otherwise. `makeSlug` (`src/toolgen/naming.ts`) takes the repository's name and not its owner, so `evil/postgres-mcp` installed after `acme/postgres-mcp` would get the same slug.
  - Values are exact `host:port` pairs. A malformed value is a startup error.
  - **These are also startup errors** (review 2):
    - **two targets on one port for one repository** (`host.docker.internal:5432` and `db.lan:5432`). Both names lead to the proxy's one listener on that port, and it cannot tell which was dialed;
    - **a forward on the proxy's own port** (3128).
- **How it works without the program knowing about the proxy.**
  - For each pair, the project's proxy listens on that port and forwards raw TCP.
  - The proxy joins the project's network with the **name as a network alias** (`--alias host.docker.internal`; T8). A Postgres client connecting to `host.docker.internal:5432` reaches the proxy, which passes it on.
  - No reinstall is needed, and the sandbox is not touched.
- **How the forward target is resolved.**
  - Never through Docker's embedded DNS, which would return the alias, that is, the proxy itself (T11, T12).
  - `host.docker.internal` resolves from the proxy's own `/etc/hosts`, written by `--add-host host.docker.internal:host-gateway` at its creation (T13a). On Docker Desktop that is the Desktop host. On native Linux it is the host's address on `bridge`, to be measured in leg 4 on the CI runner.
  - Every other name goes through DD4's upstream resolver (T13b). Re-resolution happens per connection, so a DHCP change is picked up.
  - On native Linux, `host-gateway` reaches services listening on all addresses or on `docker0`, not those bound to `127.0.0.1` only. The README says so.
- **Scoped to its entry.** The refused-range exemption applies only to connections arriving on that forward's port, to the addresses its name resolves to. It is not a general local exemption: a `CONNECT db.lan:6379` through the HTTP side is still refused (unit case).
- **Changes take effect** after the operator reconnects mcp-everything (environment variables are read at startup). That startup's pass (DD8) rebuilds the proxy of an online, contained project with the new forwards, so no further step is needed. For a project whose network is off, they apply when it is turned on.
- It applies to the sandbox with its network on, not to builds or clones.
- **Self-hosted forges** named in `MCPE_EXTRA_HOSTS` may resolve to local addresses for clones of their repositories. The operator already vouched for them, so there is no second setting.
- The agent cannot add local addresses (mission constraint). `set_project_hosts` refuses them, and a refusal of one points at the operator (DD9).

**DD11 — Naming a runtime is requiring it** (operator, 2026-11-22). There is no separate switch: T9 shows Docker refuses an unknown runtime and never falls back. What the flight adds:
- **Before any container starts** (clone, scan, copy, sandbox, proxy), mcp-everything checks that the named runtime is usable:
  - it is listed by `docker info --format '{{json .Runtimes}}'`, **and**
  - a trivial container runs under it. A runtime that is registered but broken, such as a mis-installed gVisor, is not shown by `docker info`.
- **The trial container** is itself a container start, so it is made like any one-shot:
  - role `runtime-check`, in the sweep's allowlist;
  - the owner label and the one-shot name form;
  - `--network none`, with `limits()` including the runtime under test;
  - the pinned clone image, ensured (pulled) beforehand, not inside the trial;
  - a 60 s bound, and removal by id whatever happens;
  - command `true`.

  Concurrent first callers share one in-flight check, and the cache key is the runtime's name.
- **An existing sandbox created under another runtime is refused** (operator, 2026-11-22).
  - Docker cannot change a container's runtime, and the criterion says everything runs under the named one.
  - When a runtime is named, DD2's hook compares the sandbox's `HostConfig.Runtime` before any exec or start. A mismatch refuses with: "this sandbox was created before `MCPE_DOCKER_RUNTIME=runsc` was named and runs under runc; reinstall the project to run it under runsc."
  - `project_info` says the same, and the security paragraph counts such projects.
  - The `runsc` CI case includes a sandbox created under `runc` first.
- **If it fails, nothing is touched** and the refusal reads: "MCPE_DOCKER_RUNTIME names runsc, but Docker cannot run containers with it (<first line of Docker's answer>); install it and register it with Docker, or unset MCPE_DOCKER_RUNTIME."
- **Cache**: a positive answer is cached for the process; a negative one is not, and is asked again next time. A positive answer that goes stale (the daemon restarted without it) still cannot run anything uncontained, because Docker refuses (T9).
  - That error is recognized by a non-zero exit plus the substring `runtime`, and mapped to the same message.
  - Otherwise Docker's first line is shown as it is, so neither a version nor a locale change can hide it.
- **Startup** does not fail on it, because Docker may not be up yet: it logs. The security paragraph says "runsc (named; Docker runs it)" or "runsc is named but Docker cannot run it: nothing will be installed or checked".
- The mission's "the operator can require it" is satisfied by naming it. This is recorded as an amendment to that criterion's wording.

**DD12 — Scanners under containment** (operator, 2026-11-22).
- The scanners file gains an optional `hosts` list per scanner.
  - With containment on, a `network: true` scanner reaches only its `hosts`, through a one-shot proxy (DD2).
  - `network: true` with no `hosts` under `MCPE_NETWORK=contained` is a **startup error** naming the scanner.
  - With `open`, `hosts` is ignored.
- Because only the operator writes the file, a scanner's `hosts` may include local addresses (a scanning service on the operator's network).
- The README's Trivy example gets hosts verified by a real run (leg 6).
- **A scanner database cache stays deferred** (flight 1 DD2). A cache written by a scanner that has just read hostile content could poison later checks, and it is a speed issue, not a safety one.

**DD13 — Verification** (operator, 2026-11-22).
- **Unit, every push.**
  - The proxy's rules and request handling, run in-process against fake upstreams and a fake resolver on loopback (no Docker).
  - Configuration parsing and the state logic.
  - The Docker call sequences against the existing test double.
  - Every new Docker method goes into the coverage test's lists (`test/docker.test.ts`: the guarded table and its lists), guarded unless it acts only on what it created.
- **Docker-gated suite, locally (Docker Desktop).**
  - A contained install of `tomnomnom/gron` (Go) and of an npm project.
  - A build refused a host fails and names it.
  - From a contained sandbox, these are unreachable, **each with a positive control** showing the same target reachable from the open bridge (flight 1: test a capability's absence, not only its presence): the gateway, `host.docker.internal`, `192.168.65.254`, `172.17.0.1`, `169.254.169.254`, and another project's sandbox.
  - The proxy's bridge address is refused from `bridge`.
  - **The "local service" is a container on `bridge`**, named by its bridge address in `MCPE_LOCAL_ACCESS`. It is reached only when listed. This works on Desktop and on the runner alike.
  - `set_project_hosts` applies without a reinstall.
  - An online, open sandbox is contained at startup, and an exec during the pass waits for it.
  - The sweep removes old one-shot proxies and networks of this installation, and leaves project proxies and another owner's.
- **A new CI workflow, `docker-gvisor.yml`** (a file of its own, so `ci.yml`'s `check` job and its triggers are unchanged), on GitHub's `ubuntu-latest`, which has plain Linux Docker.
  - **Triggers**: `workflow_dispatch`, plus pull requests (opened, synchronized, ready for review) whose paths touch any of:
    - `src/sandbox/**`, `src/proxy/**`, `src/install/**`;
    - `src/config.ts`, `src/server.ts` (DD8's pass and the hook live there), `src/registry.ts`;
    - `package.json`;
    - `test/integration/**`;
    - the workflow itself.

    The proof therefore runs on the pull request that changes it.
  - **It lands early** (operator, 2026-11-22). At leg 4 the flight branch is pushed and a **draft pull request** opened. A pull request runs the branch's own version of the workflow, so it runs without being on `main` first. The workflow is minimal at that point: it measures DD3's check, T13a's `host-gateway`, the upstream resolver under systemd-resolved, and the two-holder alias, on native Linux. Leg 10 grows it into the full job. Pushes to the draft are the Flight Director's, at leg boundaries.
  - **Setup**:
    1. Print the daemon version and run DD3's network check.
    2. Install a **pinned gVisor release**, downloaded with its published SHA-512 checked, not an unpinned apt repository.
    3. Register it (`runsc install`, daemon restart).
  - **Cases**, with `MCPE_DOCKER_RUNTIME=runsc` and `MCPE_NETWORK=contained`:
    - every container mcp-everything started reports `HostConfig.Runtime == runsc`, and the kernel inside reports gVisor;
    - `gron` and an npm project install;
    - a second, unregistered runtime name refuses cleanly;
    - a sandbox created under `runc` before `runsc` was named is refused with "reinstall" (DD11);
    - the containment cases above, where the host is a real machine, including `host.docker.internal` through `host-gateway` (DD10).
  - It is the first CI job that runs Docker: it pulls images and clones public repositories. `ci.yml`'s unit job keeps the Docker-gated file skipped, and its minimum-tests floor is unaffected.
- **Guard**: new cases run under the suite's own `mcpe-it-<pid>-` prefix.
  - `mayRemove` (`test/integration/docker.test.ts:68`), which guards containers and volumes today, is extended deliberately to networks and the `-proxy`/`-net` names, with negative cases (the same names under the operator's prefix are refused).
  - Mission 02's rule holds: the first run of each new destructive case is gated on the Flight Director's reading, with the operator's container, volume and **network** ids recorded at the start of execution.
- No behavior-test spec: the Docker suite drives `App` through `callTool` and observes Docker directly, which covers the criteria. The HAT covers the operator's own client.

**DD15 — Docker's address pools** (review 2).
- Every project network and every one-shot network takes a subnet from the daemon's default address pools. On a stock daemon these allow about 31 networks, and a pool can overlap the operator's LAN. Today everything shares `bridge`.
- Under containment, the limit is roughly (online projects, plus stopped ones whose `-net` remains, plus concurrent one-shots).
- **What the flight does**:
  - Docker's error ("all predefined address pools have been fully subnetted") is mapped to a message that names the cause and the operator's fix: `default-address-pools` in the daemon's configuration, or turning off networks not in use.
  - Turning a network off removes its `-net` (DD7), so the subnet is released.
  - The README documents the limit and the overlap.
- mcp-everything does not allocate subnets itself. The pools are the daemon's, and so the operator's.

**DD14 — What is not changed.**
- Image pulls stay outside containment: the daemon pulls them (mission constraint, README).
- No change to build recipes, to the registry `version`, to tool names or to `<slug>__<NAME>` names.
- A hostile agent remains out of scope. `sandbox_exec` runs anything inside the sandbox; containment bounds where it can connect.

### Prerequisites
- [x] Docker reachable; Docker Desktop, server 29.8.2 (2026-11-22).
- [x] `gateway_mode_ipv4=isolated` leaves a network with no gateway on this daemon (T3).
- [x] A CONNECT proxy on both networks carries a real git clone (T4).
- [x] A forward target can be resolved past the project network's aliases (T13, on Docker Desktop).
- [ ] On `ubuntu-latest`: T13a's `host-gateway` on native Linux, DD3's check, the upstream resolver under systemd-resolved, and the two-holder alias. Leg 4's draft pull request runs them before leg 5 is designed.
- [ ] On the operator's daemon, before leg 5 is designed: the proxy bound to its internal address only, a read-only `node -e` proxy, and a two-holder alias (leg 4).
- [ ] The operator's agreement to a draft pull request at leg 4: given 2026-11-22. The push itself still happens at that leg.
- [ ] gVisor installs and registers on `ubuntu-latest` from a pinned release (measured in leg 10's first run).
- [ ] Digest of the proxy's `node:<lts>-alpine` image, read from the registry at execution.
- [ ] Unit and Docker suite baselines (counts and times) at the start of execution.
- [ ] The operator's containers, volumes and networks listed by id at the start of execution, before the first Docker-suite run.

### Pre-Flight Checklist
- [x] All open questions resolved (the minimum Docker version is a measurement, not a decision)
- [x] Design decisions documented
- [ ] Prerequisites verified (the open ones are execution-time by design)
- [x] Validation approach defined
- [x] Legs defined

---

## In-Flight

### Technical Approach
Legs are cut by kind of risk (flight 1 debrief):
- pure configuration;
- the runtime check, before anything else starts a container;
- the hostile-input proxy program;
- the one-shot network layer;
- the project proxy's lifecycle;
- the install path;
- the after-install tools;
- the startup pass over existing sandboxes;
- docs, CI and the HAT.

- **Leg 1 — `network-config`** (no Docker): `MCPE_NETWORK` (DD1), `MCPE_LOCAL_ACCESS` (DD10), scanner `hosts` and its startup rule (DD12), the host-entry grammar and its refusals (DD4, DD6), and the default host table as data (DD5). All pure and unit-tested; nothing calls them yet.
- **Leg 2 — `runtime-required`**: DD11's check before every container start (the trial container, its cache and shared in-flight check, the message, the mapped error), the comparison of an existing sandbox's runtime as a function that leg 5's hook calls (wired into `acquire` here, the hook's other paths in leg 5), and the startup log. It comes before the legs that start new kinds of container.
- **Leg 3 — `proxy-program`** (no Docker; hostile input): the proxy (DD4): range table, matching, resolver, resolve-then-connect, CONNECT, plain HTTP, the bind address, TCP forwards with their scoped exemption, bounds, and the refusal list (DD9). Unit cases run it in-process on loopback against fake upstreams and a fake resolver. Its design review is attack-minded.
- **Leg 4 — `contained-networks`** (Docker: one-shot layer).
  - Network creation with DD3's check; the upstream-resolver read; the one-shot network and proxy beside `runOnce` (roles, readiness, teardown order, the image ensured first); the exec environment (`ExecOptions.env`, the MCP connector's flags).
  - Sweep: the new roles, networks, and the project-label exclusion.
  - Coverage-test lists and `mayRemove`.
  - Docker cases: a one-shot behind its proxy reaches an allowed host and is refused the gateway, host addresses and a bridge container, with positive controls; the proxy's bridge address is refused; the sweep.
  - **Measurements before leg 5 is designed**, run first on the operator's daemon (gated as always) and recorded in the flight log:
    - the proxy bound to its internal-network address only;
    - a read-only `node -e` proxy;
    - a network alias held by two containers at once.
  - **The minimal `docker-gvisor.yml`**, then the flight branch pushed and a draft pull request opened (operator, 2026-11-22). It runs DD3's check, T13a's `host-gateway`, the resolver under systemd-resolved and the two-holder alias on native Linux, and its results are recorded before leg 5's design review.
  - The exec environment's plumbing (`ExecOptions.env`, the connector's `-e` flags) lands here, unused. Leg 5 wires it through the hook.
- **Leg 5 — `project-proxy-lifecycle`** (Docker: long-lived objects).
  - The project network and proxy; `setNetwork`'s three modes and `hasNetwork`'s state (DD7).
  - Replacement in DD2's order, with its locks and both labels.
  - **The `ensureContained` hook** (DD2): the per-slug wait (the promise; leg 8 fills it), the repair in its order, the exec environment from Docker's view, the runtime comparison (DD11), and the test that no exec or start path bypasses it.
  - Removal with the project; aliases and `host-gateway` (DD10).
  - Docker cases:
    - isolation from a peer project;
    - replacement without a reinstall, including the two-holder overlap;
    - repair after the proxy, and separately the `-net`, is removed by hand.
- **Leg 6 — `contained-install`** (install path).
  - Clone, build (every attempt), `check_project` and networked scanners through containment; the contained creation order and failure paths (DD7).
  - Refused-host messages on a failed install (DD9).
  - **The DD5 table measured** against the test projects and corrected; the clients and Node versions; the Trivy hosts.
  - Docker cases: contained `gron`, a contained npm project, a refused build host.
- **Leg 7 — `network-tools`** (after-install tools).
  - `set_project_network` three-way with its merged record write.
  - `hosts` on install, merged on a reinstall; `set_project_hosts` (DD6).
  - The record-writing helper that keeps `hosts` for the installer's seven writers (DD6).
  - Local access end to end, with its startup validation (DD10).
  - MCP servers closed on a change (DD7); refusals in tool errors and `project_info`, read through the control endpoint (DD9); `describe()`'s Docker view.
  - Docker cases: a host added applies without a reinstall; a local service is reached only when listed.
- **Leg 8 — `startup-containment`** (touches existing sandboxes).
  - DD8's pass, row by row of its table, with skipping of live installs, removal of orphans and lock files, and the session-label comparison; the per-slug promises that leg 5's hook awaits; stopping proxies of stopped sandboxes; DD15's error mapping.
  - Docker cases:
    - an open sandbox contained at startup;
    - a record-off sandbox on `bridge` taken off;
    - an exec during the pass waits;
    - an orphan proxy removed.
- **Leg 9 — `status-and-docs`**: the security paragraph's containment and runtime lines, `describe()`'s network line, `set_project_network` wording, and `INSTRUCTIONS_HEAD`'s network sentence. README: containment, defaults and how to change them, local access, scanners' `hosts`, the runtime, upgrading, and limits (DD4's residual routes, DD8's sessions, DD14, the mission constraints).
- **Leg 10 — `gvisor-ci`**: the `docker-gvisor.yml` workflow (DD13) and the case selection it runs.
- **Leg 11 — `hat-and-alignment`** *(optional, agreed)*.

### Checkpoints
- [ ] Leg 1: every configuration error has a unit case; the `open` default changes nothing.
- [ ] Leg 2: a named runtime that is missing or broken refuses before any Docker object exists.
- [ ] Leg 3: every refused range, IPv6 embedding, wildcard edge, IP literal and bound has a unit case; a name resolving to a refused address is refused and never connected; a CONNECT to a forward's host is refused.
- [ ] Leg 4: a one-shot behind its proxy is refused the host, gateway and a bridge container while the positive controls connect; a daemon whose network has a gateway is refused (unit, with the double); DD3 and T13a hold on the runner.
- [ ] Leg 5: two projects cannot reach each other; a replaced proxy carries the new configuration; a removed proxy or `-net` is repaired on the next exec; no exec or start path bypasses the hook.
- [ ] Leg 6: `gron` and an npm project install contained; a refused build host is named.
- [ ] Leg 7: a host added applies without a reinstall; a local service is reached only when listed.
- [ ] Leg 8: every row of DD8's table has a unit case; an open sandbox is contained at startup, and nothing execs into it uncontained; a record-off sandbox on `bridge` is taken off.
- [ ] Leg 9: with nothing configured, instructions, the install result and `project_info` say "not contained" and name the runtime truthfully.
- [ ] Leg 10: the CI job passes with gVisor, and every container reports `runsc`.
- [ ] Leg 11: the operator accepts.

### Adaptation Criteria

**Divert if**:
- A mainstream build client (npm, pip, cargo, go, git) cannot be made to use the proxy through environment variables, so that projects fetching only from their registries cannot install as today.
- The isolated-gateway network cannot be had, or verified, on GitHub's runner (the native Linux half of the proof).
- gVisor cannot run the sandbox's builds at all on the runner (the README would then advertise something unproven).
- Containing an existing sandbox in place (DD8) turns out to need its recreation.
- `host-gateway` on native Linux does not let a local-access forward reach the host (DD10 would need another resolution path).

**Acceptable variations**:
- The exact default hosts (DD5), the refusal list's size, the proxy's bounds and the lock's staleness, all tuned from measurement.
- `inhibit_ipv4` instead of `gateway_mode_ipv4=isolated`, if DD3's check holds for it.
- The CI job's case selection and path filters.
- README work moving between legs.

### Legs

> **Note:** These are tentative suggestions, not commitments. Legs are planned and created one at a time as the flight progresses. This list will evolve based on discoveries during implementation.

- [ ] `network-config` - `MCPE_NETWORK`, `MCPE_LOCAL_ACCESS`, scanner `hosts`, the host grammar, the default host table; no Docker
- [ ] `runtime-required` - The named runtime checked (listed and runnable) before any container starts
- [ ] `proxy-program` - The proxy: ranges, matching, resolver, resolve-then-connect, CONNECT, HTTP, bind address, TCP forwards, refusals; no Docker
- [ ] `contained-networks` - Networks with the gateway check, the one-shot proxy beside `runOnce`, the exec environment, the sweep
- [ ] `project-proxy-lifecycle` - The project network and proxy, three-way network state, replacement and its lock, repair, aliases
- [ ] `contained-install` - Clone, build, check and scanners through containment; default hosts measured; refused-host messages
- [ ] `network-tools` - `set_project_network`, `hosts` and `set_project_hosts`, local access, refusals reported
- [ ] `startup-containment` - Existing sandboxes contained at startup, exec waits, never loosen
- [ ] `status-and-docs` - Instructions, status lines, tool wording, README
- [ ] `gvisor-ci` - CI workflow on plain Linux with gVisor and containment
- [ ] `hat-and-alignment` *(optional)* - Guided HAT (human acceptance test) session with iterative fixes

---

## Post-Flight

### Completion Checklist
- [ ] All legs completed
- [ ] Code merged
- [ ] Tests passing (unit suite on the hosted check; Docker suite locally; `docker-gvisor` on the pull request)
- [ ] Documentation updated (README)

### Verification
- Unit suite: new cases pass; no existing case fails.
- Docker suite, locally:
  - contained installs succeed, and a refused host is named;
  - host, gateway and peer are unreachable, with positive controls;
  - the proxy is not reachable from `bridge`;
  - a local service is reached only when allowed;
  - hosts apply without a reinstall;
  - startup containment works, with exec waiting for it;
  - the sweep leaves project proxies alone.
- `docker-gvisor` job:
  - every container runs under `runsc`, and installs succeed under gVisor;
  - a missing runtime is refused;
  - containment holds on native Linux, including `host-gateway`.
- HAT: in the operator's own client, containment off then on, a refusal fixed with a host, a local service allowed, an online project contained.
