# Network containment

Part of mcp-everything's documentation; see the [README](../README.md).

Containment is **off by default**. With `MCPE_NETWORK=open` (or nothing set)
networks behave as they always have, and the server's instructions tell the agent
that sandbox networks are not contained and that the operator turns containment
on with `MCPE_NETWORK=contained`. With it on, the instructions say what is
contained and how it is changed. The agent cannot turn containment on or off.

What it does not mean: a hostile agent is still out of scope (`sandbox_exec`
runs anything inside a sandbox; containment bounds where that code can connect),
and image pulls stay outside it. See [What containment does not stop](#what-containment-does-not-stop).

## Turning it on

Set `MCPE_NETWORK=contained` in the environment of the mcp-everything process.
It is read once, at startup, so a change needs a reconnect, and an invalid value
is refused at startup.

- **Docker must be able to make a network with no gateway.** mcp-everything
  creates each network `--internal` with
  `com.docker.network.bridge.gateway_mode_ipv4=isolated` and IPv6 off, then
  inspects what Docker made and refuses to use it unless it is internal, has no
  IPv6, has exactly one IPv4 subnet and no gateway. A Docker that ignores the
  option is caught by that check, not by a version number. When the check fails,
  installs, checks that clone, and turning a sandbox's network on refuse with a
  message that names what Docker must support; mcp-everything never falls back
  to Docker's default bridge. Projects whose network is off are unaffected.
- **Tested Docker versions.** Docker 29.4.2 (Linux, on a GitHub-hosted runner)
  and 29.8.2 (Docker Desktop) were tested. The minimum version is not
  established.
- **The proxy image.** The proxies run in `MCPE_PROXY_IMAGE` (a digest-pinned
  `node:22-alpine` by default), which the Docker daemon pulls like any image.

## How it works

- **Every network is its own.** Each project gets a Docker network of its own
  (named after its sandbox, with `-net`), and each networked clone or scanner
  gets one for the length of its run. These networks have no gateway and no
  route anywhere, and Docker's embedded DNS answers nothing for outside names.
  A contained sandbox is on its own network and no other, so two contained
  projects cannot reach each other. A sandbox whose network is off is on no
  network at all, as before.
- **The proxy is the only way out.** For each project (and for each networked
  clone or scanner) a proxy container sits on that network and on Docker's
  default bridge. It is a small program of mcp-everything's own, run with
  `node -e` in `MCPE_PROXY_IMAGE`: read-only, all capabilities dropped, a
  non-root user, nothing published, and under `MCPE_DOCKER_RUNTIME` when one is
  named. It listens only on its address on the project's network, so containers
  on the bridge cannot use it. The sandbox reaches it **by address, not by
  name**: the proxy is connected to its network at the last usable host address
  of the network's subnet (for `172.22.0.0/16`, `172.22.255.254`), port 3128.
  Each network is made with that subnet pinned and an IP range in its lower half,
  so Docker never hands the address to anything else. Nothing depends on
  Docker's embedded DNS (a name for the proxy would, and gVisor's network stack
  cannot reach it).
- **What the sandbox's commands get.** Every command mcp-everything starts in a
  contained sandbox gets `HTTP_PROXY`, `HTTPS_PROXY` (and the lower-case
  forms, each `http://<the proxy's address>:3128`), `NO_PROXY` empty, and
  `NODE_USE_ENV_PROXY=1` (Node's `fetch` ignores
  the variables otherwise). They are given per command, not at creation, so an
  existing sandbox can be contained without a reinstall. In the npm build
  sandbox that was measured (Node 26.13.1, npm 11.20.0), `fetch` used the proxy
  and npm installed through it; with `NODE_USE_ENV_PROXY` unset, `fetch` failed
  closed. Which other clients (pip, cargo, gem, apt) honor the variables was
  not measured. A process the project
  starts itself with the variables unset, and a client that ignores them, has
  no route.
- **The proxy decides by address, not by name.** It resolves every name itself,
  through the upstream resolvers it reads from a throwaway container on the
  bridge (never Docker's embedded DNS), refuses the host's, local and link-local addresses whatever a
  name resolves to, and connects to exactly the address it checked. If a name
  resolves to both a public and a refused address, the refused one is dropped
  and the public one used; if it resolves only to refused addresses, the
  request is refused.
  - Refused: IPv4 `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`,
    `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, multicast and
    reserved ranges, `255.255.255.255`, and the networks the proxy itself is
    on. IPv6 is an allowlist: only addresses in `2000::/3` pass, so
    loopback, unique-local, link-local and the rest are refused. IPv4-mapped,
    NAT64, 6to4 and Teredo addresses are judged by the IPv4 address inside them.
  - An IP literal in a request is refused unless it is itself an allowed entry
    (only a scanner's `hosts` can hold one). Hosts are otherwise matched by name.
  - **Plain HTTP is `GET` and `HEAD` only**, as an absolute URI to an allowed
    host. Every other method is refused. HTTPS goes through `CONNECT`.
  - Ports: 443 and 80, unless an entry names one (`example.com:8443`), in which
    case only that port.
- **Hosts are matched** by exact name, or `*.example.com` for names under it
  (not `example.com` itself), case-insensitively.
- **The proxy keeps at most 50 refusals** (host, port, reason). They are read
  with `docker exec` only when something failed, and they go when the proxy is
  replaced, including by the `set_project_hosts` that fixes them.
- **A change replaces the proxy.** A project's hosts, its stage (build or after
  install), the operator's local access and the resolvers decide its proxy's
  configuration, which is fixed when it is created. Two containers cannot hold
  one address, so a change takes the old proxy off the network first, makes the
  new one at the same address, waits until it answers, and then removes the old
  one. **A tightening is effective at once**, and connections through the old
  proxy drop; for a moment, until the new proxy is ready, the sandbox has no
  route (it fails closed). The sandbox's proxy variables are the same before and
  after (same address), so nothing is restarted for addressing. If the new proxy
  does not start, the old one is put back at its address; if that fails too, the
  project has no proxy until its next use repairs it, and its commands fail
  closed.

## What each stage reaches

| Stage | Reaches |
| --- | --- |
| The clone (`install_project`, `check_project`) | Only the repository's forge: `github.com`, `gitlab.com`, or a host named in `MCPE_EXTRA_HOSTS`. Submodules on another forge are refused. |
| The build | The default hosts of its build system and of every build ([below](#the-default-hosts)), plus the project's `hosts`. |
| A sandbox with its network on | The default hosts of its build system (not Debian's servers, not GitHub), plus the project's `hosts`; and local addresses only as the operator allows ([Local access](#local-access-mcpe_local_access)). |
| A sandbox with its network off | Nothing. It is on no network. |
| A scanner with `network: true` | Only its own `hosts` ([Scanners' hosts](#scanners-hosts)). A scanner without a network has none. |

A sandbox with its network on reaches its package registries so that turning
the network on and rerunning an install step by hand works. A running server can
therefore reach a registry, which is a way out as well as in.

## The default hosts

GitHub is in the default hosts of every build: git dependencies and prebuilt
binaries are common. Anyone can host anything there, as on the package registries.

| Build system | Hosts |
| --- | --- |
| Every build | `deb.debian.org`, `security.debian.org`, `github.com`, `codeload.github.com`, `objects.githubusercontent.com`, `release-assets.githubusercontent.com` |
| `python` | `pypi.org`, `files.pythonhosted.org` |
| `node` | `registry.npmjs.org`, `nodejs.org`, `repo.yarnpkg.com`, `registry.yarnpkg.com` |
| `rust` | `crates.io`, `index.crates.io`, `static.crates.io`, `static.rust-lang.org` |
| `go` | `proxy.golang.org`, `sum.golang.org` |
| `ruby` | `rubygems.org`, `index.rubygems.org` |
| `cmake`, `autotools`, `make`, `generic` | none beyond every build's |

This is a starting table. **Only Go (`tomnomnom/gron`) and npm (`piuccio/cowsay`)
were measured under containment**: both installed with no refused host. The
Debian rows (the recipes' `apt-get`), Python, Rust, Ruby, CMake and autotools,
and `pnpm` and `yarn` were not measured; a project that needs more fails with
the host named (below) and can be given it with `hosts`.

## A project's hosts

- `install_project` takes `hosts`, and `set_project_hosts` adds and removes
  them without a reinstall (the project's proxy is replaced, and its proxied MCP
  servers are closed so their next start has the new environment). A reinstall
  adds the new `hosts` to those the project has; removing goes through
  `set_project_hosts`. `project_info` shows the hosts a contained project may
  reach and the ones recorded for it.
- An entry is `host` or `host:port`, or `*.example.com`; up to 64 per list. The
  agent's entries are refused when they are: a bare `*`; a wildcard on a public
  suffix (`*.com`, `*.co.uk`; this is a heuristic list of two-label suffixes, not
  the public suffix list); an IP address in any form (including shorthand like
  `127.1`); a local name (ending in `localhost`, `local`, `internal`, `lan`,
  `home`, `arpa` or `localdomain`); or anything that is not a host name. The
  refusal names the step that failed.
- The defaults cannot be removed per project: `set_project_hosts` says so.
- Under `MCPE_NETWORK=open` the hosts are recorded and have no effect, and the
  tools say so.
- Entries are checked again when a proxy is built: one that fails (for example
  from a hand-edited registry) is dropped with a warning.

## Local access (`MCPE_LOCAL_ACCESS`)

Only the operator can let a sandbox reach a local service; the agent cannot, and
`set_project_hosts` refuses local addresses.

```sh
MCPE_LOCAL_ACCESS="acme/postgres-mcp=host.docker.internal:5432;acme/redis-mcp=db.lan:6379,db.lan:6380"
```

- **Syntax**: `<repository>=<host name>:<port>[,<host name>:<port>...]`, entries
  separated by `;`. A malformed value, a repository named twice, two targets on
  one port for one repository, a target on port 3128 (the proxy's own), and an
  IP literal are startup errors, in either mode.
- **Keyed by repository**, in any form `install_project` accepts (`owner/name`,
  `gitlab:group/name`, a URL, or a forge from `MCPE_EXTRA_HOSTS`), compared
  case-insensitively, never by slug: two repositories can share a slug.
- **Names only, not IP addresses.** A contained sandbox has no route to any
  address; it reaches a local service only through a name that resolves to its
  proxy.
- **How it works.** For each target the project's proxy listens on that port and
  forwards raw TCP, and mcp-everything writes one line per target name into the
  **sandbox's `/etc/hosts`**: `<the proxy's address> <name>   # mcpe-local-access`.
  The sandbox connects to `host.docker.internal:5432` and reaches the proxy. No
  network alias and no DNS server is involved. Docker rewrites `/etc/hosts` every
  time a sandbox starts, so the lines are written again after each start that
  mcp-everything makes (and checked when it uses a running sandbox), in one
  root `docker exec` that replaces only its own marked lines. They are taken out
  when the forwards become empty or the sandbox leaves its network. A sandbox you
  start by hand with `docker start` has no such lines until mcp-everything next
  uses it. Names that are the sandbox's own (`localhost`, its hostname) cannot be
  targets. The exemption from the refused
  addresses applies only to connections arriving on that port, to the addresses
  that name resolves to: a `CONNECT host.docker.internal:5432` through the HTTP
  side is still refused. The proxy carries the forwards for as long as the
  project has a proxy, including during its build.
- **`host.docker.internal`** is resolved from the proxy's own `/etc/hosts`
  (it is created with `--add-host host.docker.internal:host-gateway`); every
  other name goes through the upstream resolvers, once per connection.
  - On Docker Desktop, a container with that setting got `192.168.65.254` and
    an IPv6 address, and a published port of a container on your machine was
    reached; a sandbox allowed to reach it did, another repository's did not.
  - On native Linux, `host-gateway` was `172.17.0.1`, inside the bridge's own
    range, and a container on the bridge reached a host service listening on all
    addresses. A service bound only to `127.0.0.1` is not expected to be
    reachable that way (not measured). A full local-access forward has not been
    run on native Linux.
  - Names that only your host's split-DNS knows may not resolve for the proxy:
    on a Linux host with systemd-resolved, Docker gives containers the uplink's
    resolvers and not the stub.
- **A change needs a reconnect** (the variable is read at startup). The startup
  pass then rebuilds the proxy of an online, contained project with the new
  targets; for a project whose network is off they apply when it is turned on.
- A forge named in `MCPE_EXTRA_HOSTS` may resolve to local addresses for the
  clone of its repositories: you already vouched for it. A repository on one
  whose name your Docker's resolvers cannot resolve fails to clone with
  `resolve-failed`.

## Scanners' hosts

In the scanners file, a scanner with `network: true` takes a `hosts` list, in
the same entry form as above except that it may hold IP literals and local names
(only the operator writes the file). Under `MCPE_NETWORK=contained` it reaches
only those hosts, through a one-shot proxy that lives as long as the scanner
runs, and local addresses are allowed for them. **A scanner with `network: true`
and no `hosts` is refused at startup** under containment, naming the scanner.
Under `open`, `hosts` has no effect. The Trivy example above lists the hosts
measured on 2026-11-23 with Trivy 0.76.2 under `MCPE_NETWORK=contained`:
`check_project` on a Go repository and on a Node install both reported Trivy
`ran` with only these two. They are the registries of Trivy's default
`--db-repository`, `--java-db-repository` and `--checks-bundle-repository`
(`mirror.gcr.io` first, `ghcr.io` as the fallback). Those runs did not exercise
the Java DB download. A different Trivy version or different flags (a different
`--db-repository`, say) may need other hosts; a refused run names them.

## What reaches outside services

With scanning on, an install sends the repository's name to `api.github.com` and
the names and versions of its dependencies to `api.osv.dev` (the
[dependency check](checking.md#the-dependency-check)). This comes from mcp-everything's own
process, so it is not narrowed by containment. `check_project` does the same
whatever `MCPE_SCAN` says. Nothing from the clone is sent, and the GitHub token
goes only to GitHub.

With scanning on, these also reach outside services (and without containment, any
host): the clone container (the repository's forge); a scanner with `network:
true`; and the Docker daemon, which pulls the clone, sandbox, scanner and proxy
images from whatever registries the image names. Under containment the clone
reaches only the forge and a scanner only its `hosts`; the daemon's pulls are
not narrowed. A credential given to a scanner through `env` can be sent by
that scanner to any host it is allowed.

## When something is refused

- A failed install ends with what the build's proxy refused (at most 10 lines),
  and a build that finishes after a refusal carries a warning for each host
  refused as not allowed (at most five).
  A failed tool call (including `sandbox_exec` and a proxied MCP server's) in a
  contained sandbox with its network on adds the proxy's latest refusals, at
  most 3, marked as possibly including earlier calls. `project_info` shows them
  or says "no refusals recorded since the proxy started". A proxy that did not
  start is reported as that ("the network proxy did not start: ..."), never as a
  refusal.
- **The hints are advisory, on purpose.** The host a build asked for was chosen
  by the project's own code, and a hostile project can ask for a host whose name
  reads as an instruction. So a refused host is reported as `` `host:443` was
  refused `` followed by a caution (allow it only if you expect the project to need
  it), never as a ready-made `hosts` call, and host names are cut to name
  characters and shown in backticks. A clone's refusal says that submodules on
  other forges are not reachable, and a scanner's that only the operator can
  allow a host for it: the agent cannot. A refused local address says that
  only the operator can allow it (`MCPE_LOCAL_ACCESS`).
- A build refused its package registry fails only when the install times out,
  because npm retries without pause: in the one measurement, 3,155,582 refused
  connections in about 11 minutes, and a failure after 648 seconds at a
  600-second limit, with the correct host named.

## Upgrading, and switching from open to contained

- Nothing is reinstalled for projects mcp-everything has a record for. At the
  next start with `MCPE_NETWORK=contained`, a background pass looks at every
  sandbox of this installation by Docker's view together with its record. A
  sandbox whose record says the network is on and that is on the bridge or on no
  network gets its network and proxy and leaves the bridge (a stopped one stays
  stopped); one with its own network is repaired if need be. A sandbox whose
  record says off but that is on a network is taken off every network (with a
  warning on the project when it was on the bridge or a network mcp-everything
  does not manage). One whose record says on and that is on a network
  mcp-everything does not manage is not contained: commands in it are refused
  with that reason. A young install of another session is skipped.
- **Nothing runs uncontained meanwhile**: a command in a sandbox waits for the
  pass's step for that sandbox, and a failed step refuses the command with the
  reason. The pass is bounded at five minutes; steps it did not reach are
  refused. If Docker cannot list the sandboxes at all, commands are refused
  unless the sandbox is on no network or is already contained.
- **A session never loosens another's containment.** A session with
  `MCPE_NETWORK=open` leaves a contained sandbox contained, and
  `set_project_network` there leaves it so. It gives commands the proxy variables
  but does not repair the proxy.
- **Sessions with different settings.** Sessions of one installation may have
  different `MCPE_LOCAL_ACCESS`, `MCPE_EXTRA_HOSTS` or resolvers. The last to
  start or change a project decides its local-access and resolver
  configuration; on use, a session compares only what the record decides, so
  they do not replace each other's proxies. `project_info` says when the proxy
  carries a configuration other than this session's.
- **Not contained by the pass** (see below): a labelled sandbox with no record.
  (A sandbox made before ownership labels is never listed by the pass, and it
  never runs here either: every start of it is refused.) A sandbox created before
  `MCPE_DOCKER_RUNTIME` was named must be reinstalled
  ([The isolation runtime](security-model.md#the-isolation-runtime)).

## What containment does not stop

- **An allowed host is a way out as well as in.** A build can fetch from GitHub
  releases or a registry and a running server can reach its registry; a project
  can send data to any host it is allowed, and GitHub is in every build's list.
- **DNS under a wildcard.** A wildcard entry lets the sandbox cause lookups of
  arbitrary labels under it.
- **The Docker host's own public addresses and published ports** are reachable
  as ordinary internet addresses. The proxy is on the bridge, so its table of
  refused addresses is the whole boundary.
- **Azure's `168.63.129.16`** looks public and is not covered by the table.
- **IPv6 forms that are not decoded**: ISATAP addresses in a public prefix and
  non-standard NAT64 prefixes, reachable only where such a translator is on the
  path.
- **Image pulls** are done by the Docker daemon, outside every container.
- **Clients that do not use the proxy fail closed, with unhelpful messages.** A
  process started without the proxy variables, and a client that resolves
  names itself (busybox `wget`: `bad address`), gets no route.
- **The window during a replacement.** While a new proxy and the old one both
  exist, both answer; a host that was removed, or a stage's wider list, may
  still be allowed until the old proxy is removed. The two share one name, and
  in the measurements the answers alternated between them.
- **Labelled sandboxes with no record stay uncontained** under `contained`: the
  pass leaves them as they are. A sandbox made before ownership labels is not
  in this list because it does not run: this installation refuses to start it,
  so a project of that kind is removed by the operator, then reinstalled.
- **Leftover proxies** of stopped sandboxes, and of an uninstall that crashed,
  are not removed yet (squawk 0052). A proxy keeps running when its sandbox's
  idle timeout stops the sandbox. A leftover proxy listens only on its own
  network, so the cost is memory and clutter, not a way in.
- **A refused package registry** makes a build fail only at its timeout (above).
