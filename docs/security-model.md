# Security model

Part of mcp-everything's documentation; see the [README](../README.md).

Installing a project means running its build scripts and its code. This server
confines that to Docker; it does not make untrusted code safe. With scanning
turned on, it also checks the repository's own build code before any of it
runs (see [Checking projects before they run](checking.md#checking-projects-before-they-run)),
which narrows what a careless install can do and does not close it: that
section says what the checks cannot see.

What the sandbox does:

- One container and one volume per project, named and labelled with the
  installation's id so that installations sharing a Docker daemon do not
  touch each other's (see [Several installations on one Docker daemon](../README.md#several-installations-on-one-docker-daemon)). No
  host directory or Docker socket
  is mounted. The only values passed into a sandbox are the environment
  variables of the project's MCP servers: the `<slug>__<NAME>` variables an
  operator set for that project (see "Giving a server its environment") and
  whatever `connect_mcp_server(env: …)` stored. mcp-everything itself never
  stores the former. Forge tokens stay in the server process and are only sent
  to their own forge's API.
- All capabilities are dropped except the six needed to run package managers
  as root inside the container (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `FSETID`,
  `SETUID`, `SETGID`); `no-new-privileges` is set; memory, CPU and process
  counts are limited.
- Outbound network is removed after the build, and stays off until
  `set_project_network` (or `network: true` on the install) turns it on. Off
  means the sandbox is on no Docker network at all, in either mode.
- Commands are passed as argument vectors, never assembled into shell
  strings, and are killed inside the container when they time out.
- Only `https` clone URLs on allow-listed hosts are accepted.

What it does not do:

- **The network is contained only when you turn containment on.** With
  `MCPE_NETWORK=open` (the default) the build has network access on Docker's
  default bridge: code running then (and whenever you enable the network) can
  reach the internet and services on your host and local network, and so can
  the clone container and any scanner configured with `network: true`.
  Scanning does not change this. With `MCPE_NETWORK=contained` each of those
  reaches only what [Network containment](containment.md#network-containment) says, and that
  section lists [what containment does not stop](containment.md#what-containment-does-not-stop).
- **Container isolation is not a security boundary against a determined
  attacker.** A kernel or runtime escape reaches your host. For stronger
  isolation set `MCPE_DOCKER_RUNTIME=runsc` (gVisor) or run the Docker daemon
  in a VM. The runtime applies to the clone, scanner and copy containers and
  the network proxies as well as the sandboxes, naming it requires it, and the
  server's instructions tell the agent which runtime is named (or that Docker's
  default is in use); see [The isolation runtime](#the-isolation-runtime).
- **Disk usage is not limited.** A build can fill the Docker data directory.
- **Tool output and tool descriptions come from the project.** Descriptions
  are length-capped, flattened to one line and prefixed with
  `[sandboxed <repo>]`, but a malicious project can still put misleading text
  in front of the model. Review what you install, and keep approval prompts
  on for generated tools.
- **Proxied MCP servers describe themselves.** Their tool descriptions are
  bounded and labelled like generated ones, but their argument schemas are
  passed through as the server wrote them, including any text inside.
- **Values given to `connect_mcp_server(env: …)` are stored in plain text** in
  the registry file (`registry.json`, readable only by you) so the server can
  be restarted. `disconnect_mcp_server` or `uninstall_project` removes them.
  Values from `<slug>__<NAME>` variables are never stored. Both kinds are
  handed to Docker through a private temporary file, not the command line (a
  file left there by a crash is removed at a later start, once it is more than
  an hour old), and
  mcp-everything itself never writes a value into a tool result, an error
  message or its diagnostics log; `project_info` shows names only. That
  promise covers what mcp-everything writes, not what a server prints (see the
  last point below).
- **Variables given to a project's MCP servers are exposed to more than those
  servers.**
  - Any code running in the project's sandbox can read a running server's
    variables (for example through `/proc/<pid>/environ`); "MCP servers only"
    describes what they are handed to, not an isolation boundary inside the
    sandbox. That includes the agent's own tools: `sandbox_exec`,
    `sandbox_write_file` and `connect_mcp_server` each give it the values of
    the project they are used on.
  - The Docker client that starts a server inherits mcp-everything's whole
    environment, so every project's `<slug>__<NAME>` variables are in that
    client's environment on the host for each launch. They do not reach a
    sandbox that way.
  - Discovery and `refresh_mcp` run the project's commands with the variables.
    That is online whenever the sandbox's network is on, and at install it
    follows the network setting the install was asked for.
  - The variables bind to a slug, not to a repository. If a project is
    uninstalled and a different repository is later installed under the same
    slug, it receives the variables set for that slug. `install_project` and
    `project_info` list the names a project receives.
  - A server can print its own variables. What it writes on stderr, returns
    from a call, or puts in a protocol error message reaches the tool error
    returned to the agent and the diagnostics log, and a protocol error
    message or a tool description also reaches the registry. mcp-everything
    does not scrub server output.
  - Several mcp-everything processes can share a data directory; they are
    sessions of one installation (one `installation-id`), not several
    installations (see [Several installations on one Docker daemon](../README.md#several-installations-on-one-docker-daemon)). Give them
    the same `<slug>__<NAME>` variables: one that lacks a variable drops the tools
    of servers that need it when it next runs discovery (including
    `discover_tools`, `connect_mcp_server` and `refresh_mcp`), until a process
    that has it refreshes again.
  - At startup, an install left unfinished for more than seven hours (by
    default) is marked failed and its sandbox is taken off the network, unless
    the sandbox is not this installation's: that one is left alone and the
    project's warnings say so (see [Several installations on one Docker daemon](../README.md#several-installations-on-one-docker-daemon)). If Docker is not reachable, this waits for the next start. Until it is marked
    failed, `project_info` says the install was started by another session or
    was interrupted.
- **License is reported, not enforced.** The license found in the repository
  is shown at install time with a warning when none is found; the server does
  not verify that a repository is open source.

## The isolation runtime

`MCPE_DOCKER_RUNTIME` names the container runtime for everything mcp-everything
runs in a container: the clone, the scanners, the copy, the sandboxes and the
network proxies. **Naming a runtime requires it.** There is no separate switch,
because Docker refuses an unregistered runtime and does not fall back.

- Before an install, a check, or any other container starts, mcp-everything
  asks Docker whether it lists the runtime (`docker info`) and runs a trial
  container under it: the command `true`, from the clone image
  (`MCPE_PROBE_IMAGE`), with no network, within 60 seconds. If either fails,
  the call is refused before anything is created, with: `MCPE_DOCKER_RUNTIME
  names <runtime>, but Docker cannot run containers with it (<Docker's first
  line>); install it and register it with Docker, or unset
  MCPE_DOCKER_RUNTIME.` A success is remembered for the life of the process; a
  failure is not, and is asked again at the next call.
- **Name it as `docker info` lists it.** The comparison is exact. Naming
  `io.containerd.runc.v2` is refused for sandboxes that Docker reports as
  `runc`, and the refusal says so.
- **The clone image must contain `true`.** The default one does (BusyBox
  provides it). An `MCPE_PROBE_IMAGE` without it fails the trial with Docker's
  "executable file not found".
- **Sandboxes created under another runtime are refused.** Docker cannot change
  a container's runtime. Once a runtime is named, executing in or starting a
  sandbox whose runtime differs is refused with `Sandbox <name> was created
  before MCPE_DOCKER_RUNTIME=<runtime> was set; Docker reports its runtime as
  <other>. Reinstall the project to run it under <runtime>.` Nothing is
  started. `set_project_network` with `enabled: false` still works on such a
  sandbox.
- **Register `runsc` with `--overlay2=none`:** `sudo runsc install --
  --overlay2=none`, then restart Docker. gVisor's default root-filesystem
  overlay (`--overlay2=root:self`) discards writes outside volumes when a
  container exits, and a sandbox's build output (`/opt/mcpe`, `/root/.cargo`,
  `/usr/local/go`) lives in the container's layer, so an idle-stopped sandbox
  would lose its built tools. When the named runtime is `runsc` and Docker's
  registration of it does not carry `--overlay2=none`, mcp-everything logs one
  warning when it checks the runtime; it does not refuse, because the
  registration is yours.
- **Containment does not use Docker's embedded DNS.** gVisor's network stack
  does not honor the rules that reach it, so contained containers reach their
  proxy by address and local-access names come from the sandbox's `/etc/hosts`
  (see [Network containment](containment.md#network-containment)).
- **Containing a running sandbox restarts it.** gVisor's network stack does
  not see a network that is joined to a sandbox while it runs. Under a runtime
  other than `runc`, putting a running sandbox on its project network (and
  taking it off `bridge`) therefore stops it, changes its networks and starts
  it again; processes in it do not survive. Every proxy is created with a fixed
  address and MAC on its network, so replacing a proxy does not need a restart.
  Under `runc` the change is made while the sandbox runs, as before.
- **A stopped sandbox whose project network was removed is recreated.** `runsc`
  cannot clean up a container whose start failed ("stale containerd task"),
  so such a sandbox cannot be started again on a new network; reinstall the
  project.
- **At startup** the runtime is checked in the background and one line is
  logged ("Docker runs it", or why not). It does not fail the start, because
  Docker may not be up yet. The server's instructions say which runtime is named
  and that it is required, or that Docker's default is in use.
- **What is tested.** The check, its caching, the refusal messages and the
  comparison with an existing sandbox's runtime are tested against a test
  double of Docker. Behavior under gVisor is tested in CI on Linux
  (`.github/workflows/docker-gvisor.yml`, advisory, run on demand or for
  changes under `src/sandbox`, `src/network`, `src/install` and
  `test/integration`): the Docker suite runs with
  `MCPE_DOCKER_RUNTIME=runsc` (gVisor registered with `--overlay2=none`),
  including contained installs and local access, and a runtime proof checks
  that every container mcp-everything starts runs under gVisor. Two pressure
  cases and the stopped-sandbox recreation case above are skipped under
  `runsc`. Containment is also tested under `runc` on native Linux. Not tested:
  Docker Desktop with gVisor. A build that gVisor refuses (a syscall it does
  not support) for a project the tests do not install would show up only when
  you run it.
