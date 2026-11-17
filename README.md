# mcp-everything

An MCP server that turns open source repositories into tools.

Point it at a project on GitHub or GitLab and it will clone it into a Docker
sandbox, build it, find the executables it produced, read their `--help`
output, and publish one typed MCP tool per command and subcommand. The tools
appear in your client's tool list while the session is running.

```
search_projects("fast python linter")
install_project("astral-sh/ruff")        # clone → sandbox → build → generate tools
ruff__ruff_check({ args: ["."], output_format: "json" })
```

## Requirements

- Node.js 22.12+
- Docker (the daemon must be reachable by the user running the server)

## Setup

No checkout is needed: `npx` can run the server straight from GitHub. For
Claude Code:

```sh
claude mcp add mcp-everything -- npx -y github:msieurthenardier/mcp-everything
```

Or in any client's MCP configuration:

```json
{
  "mcpServers": {
    "mcp-everything": {
      "command": "npx",
      "args": ["-y", "github:msieurthenardier/mcp-everything"],
      "env": { "GITHUB_TOKEN": "optional, raises the search rate limit" }
    }
  }
}
```

The first launch downloads and builds the server, which takes a few seconds;
later launches reuse npm's cache. This form follows the default branch, so a
new commit there is picked up the next time the server starts. To stay on a
version you have looked at, pin a commit or tag:
`github:msieurthenardier/mcp-everything#<commit-or-tag>`.

### From a checkout

```sh
git clone https://github.com/msieurthenardier/mcp-everything.git
cd mcp-everything
npm install        # also builds dist/
claude mcp add mcp-everything -- node "$PWD/dist/index.js"
```

## Built-in tools

| Tool | What it does |
| --- | --- |
| `search_projects` | Search GitHub and GitLab; returns ids, stars, language, license. |
| `install_project` | Clone, build and generate tools for a repository. |
| `list_projects` / `project_info` | What is installed, its status, warnings, and its published tools. `list_projects` states this installation's id; `project_info` also says whose its sandbox container is, according to Docker. |
| `find_project_tools` | Search every generated tool, published or not, by keyword. |
| `select_project_tools` | Choose which of a project's tools are published in the tool list. |
| `call_project_tool` | Call a generated tool by name, for clients that do not refresh their tool list. |
| `sandbox_exec` | Run a shell command in a project's sandbox. |
| `sandbox_read_file` / `sandbox_write_file` | Move text in and out of a sandbox. |
| `set_project_network` | Turn a sandbox's outbound network on or off. |
| `discover_tools` | Regenerate tools, optionally for executables you built by hand. |
| `connect_mcp_server` / `disconnect_mcp_server` | Proxy an MCP server that runs inside a project's sandbox. |
| `refresh_mcp` | Stop a project's MCP servers and run discovery again, e.g. after giving a server its environment variables. Reports what started and what did not. |
| `uninstall_project` | Delete a project's container, volume and tools. A sandbox that is another installation's, or was not created by mcp-everything, is never touched: the project's record and tools go, the sandbox stays in Docker, and the result says which parts were left and whose they are. |

Repositories can be given as `owner/name` (GitHub), `github:owner/name`,
`gitlab:group/sub/name`, or an `https://` URL. `ref` pins a branch, tag or
commit.

## How installation works

1. **Clone.** A throwaway container clones the repository (shallow) into a
   fresh Docker volume and reports the root listing and manifest files.
2. **Detect.** The manifests decide the build system, and the runtime
   version the project asks for decides the image (see below).
3. **Build.** A long-lived sandbox container runs a fixed recipe for that
   build system, with network access so dependencies can be downloaded.
4. **Go offline.** The sandbox is disconnected from the network unless you
   passed `network: true`. A failed install always leaves the sandbox
   offline, whatever `network` was; use `set_project_network` to go online.
5. **Discover.** Executables the build produced are collected: console
   scripts of the installed Python distribution, `bin` entries of
   `package.json` (including workspace packages), Cargo and Go binaries,
   gem executables, and anything installed to `/opt/mcpe/bin`. Names that
   resolve to the same file and print the same help are folded into one
   command with aliases.
6. **Proxy.** Commands that turn out to be MCP servers are connected to
   (see below).
7. **Generate.** Each executable is run with `--help` (the top-level command
   also with `-h` and `help`), and so is each subcommand it lists, two levels
   deep. Options become typed properties, value choices become enums, and
   every tool also accepts `args`, `stdin`, `cwd` and `timeout_seconds`.
8. **Publish.** A subset of the generated tools is advertised in the MCP tool
   list; the rest stay searchable and callable (see below).

| Detected by | Built with | Image |
| --- | --- | --- |
| `Cargo.toml` | `cargo build --release` | `rust:1` |
| `go.mod` | `go install` of each main package (falls back to `make`) | `golang:1` |
| `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt` | `pip install .` into a virtualenv | `python:3.13` |
| `package.json` | npm / pnpm / yarn install, then the `build` script | `node:lts` |
| `Gemfile`, `*.gemspec` | `bundle install`, `gem build` + `gem install` | `ruby:3` |
| `CMakeLists.txt` | configure, build, install to `/opt/mcpe` | `buildpack-deps:stable` |
| `configure`, `configure.ac` | `./configure && make && make install` | `buildpack-deps:stable` |
| `Makefile` | `make`, then `make install` | `buildpack-deps:stable` |
| none of the above | nothing (clone only) | `buildpack-deps:stable` |

Besides command tools, a project gets helpers where they apply:
`<slug>__python` (run code in the project's virtualenv), `<slug>__node` (run
JavaScript in the checkout), `<slug>__npm_run` (package scripts) and
`<slug>__make` (Makefile targets).

Inside a sandbox the checkout is `/workspace/repo` and `/workspace/work` is
scratch space, which is the default working directory of generated tools.

### Choosing the runtime version

The image tag follows what the repository declares, in this order:

1. **An exact pin**: `.nvmrc`, `.node-version`, `volta` in `package.json`,
   `.python-version`, `.ruby-version`, the `ruby` line of a `Gemfile`, or
   `.tool-versions`. A pin of Node 24.22.1 selects `node:24`.
2. **A declared range**: `engines.node`, or `requires-python` (also read from
   Poetry, `setup.cfg` and `setup.py`). For Node the newest supported release
   line inside the range is used; for Python the default line if the range
   allows it, otherwise the nearest one that does.
3. **The default image** from the table above.

A pin wins over a range because a range is a claim and a pin is what the
project's own CI runs. If a build chosen from a range fails, it is rebuilt
once on the next version the range allows. `project_info` shows which rule
picked the image, and `install_project(image: ...)` overrides all of it.

Rust and Go keep their default image and resolve versions themselves: rustup
installs the toolchain named in `rust-toolchain.toml`, and the `go` command
downloads the toolchain `go.mod` asks for.

### Which tools are published

Everything generated for a project goes into its catalog, but only up to
`MCPE_MAX_TOOLS_PER_PROJECT` tools (default 40) are advertised to the client,
since every advertised tool costs context in every conversation. The budget
is spent in this order:

1. each command's top-level tool and the project helpers, which can reach
   everything the command can do;
2. each proxied MCP server, but only as a whole. If a server's tools do not
   all fit, none are advertised: a slice of a server is rarely a usable set;
3. subcommand tools, with what is left.

Nothing unpublished is lost:

```
find_project_tools(query: "open binary")          # search the whole catalog
call_project_tool(tool: "rea__open_binary", arguments: { path: "/bin/ls" })
select_project_tools(project: "rea", include: ["open_binary", "list_*"])
```

`select_project_tools` replaces the default with your own choice (patterns
with `*`, an `exclude` list, and a per-project `max_tools`), and
`reset: true` goes back. The choice is kept across reinstalls.

### Projects that are MCP servers

If the installed project is itself an MCP server, it is started inside its
sandbox and its tools are republished here under the project's prefix:

```
install_project("modelcontextprotocol/servers")
servers__read_graph({})                 # tool of mcp-server-memory, proxied
servers__get_sum({ a: 2, b: 40 })       # tool of mcp-server-everything, proxied
```

Detection is by handshake: a launch command is started in the sandbox and
offered an MCP `initialize` over stdio. Candidates are tried in order of
evidence, and a command is left alone once one of them answers:

1. what the repository declares in `server.json` (the MCP registry manifest)
   or `mcp.json` / `.mcp.json`. Those describe the published package
   (`npx -y pkg mcp`), which is mapped onto the command built from the
   checkout (`pkg mcp`). Entries with placeholders to fill in are skipped;
2. the bare command, when the package that provides it depends on an MCP SDK
   (`@modelcontextprotocol/*` or `fastmcp` on npm, `mcp` or `fastmcp` on
   PyPI), or when the repository's manifests or name point to MCP;
3. an MCP mode the command's own help advertises (`--mcp`, `mcp`,
   `--stdio`).

Launches that do not answer are reported in a warning. A command that is an
MCP server only when given an argument keeps its command line tools too.

mcp-everything speaks the 2025 handshake to a server in a sandbox, whatever
revision its own client uses (see [Protocol revisions](#protocol-revisions)). A
server that refuses that handshake cannot be proxied.

Servers that need arguments or a different entry point are registered by hand:

```
connect_mcp_server(project: "servers",
                   command: ["mcp-server-filesystem", "/workspace/work"])
```

#### Giving a server its environment

A server that needs an API key or another variable to start can be given it
in two ways. The first is the default; the second is generally unsafe.

**Route 1 (the default): `<slug>__<NAME>` in mcp-everything's own
configuration.** To give `NAME` to the MCP servers of the project with slug
`some_api_server`, set `some_api_server__NAME` in the environment of the
mcp-everything process, which in practice means the `env` of its entry in your
client's configuration. The placeholder below is not a real key:

```json
{
  "mcpServers": {
    "mcp-everything": {
      "command": "npx",
      "args": ["-y", "github:msieurthenardier/mcp-everything"],
      "env": { "some_api_server__API_KEY": "replace-with-your-key" }
    }
  }
}
```

Then reconnect mcp-everything in your client (a running process cannot have
its environment changed, so the client has to start it again) and call
`refresh_mcp(project: "some_api_server")`.

- Nothing is stored: the variables are read from mcp-everything's
  environment each time a server is started, and mcp-everything never writes
  a value into a tool result, an error message or its log. That is not
  protection from the agent. Every MCP server of the project gets the values,
  and so can anything that has `sandbox_exec`, `sandbox_write_file` or
  `connect_mcp_server` on that project, including the agent: it can read a
  running server's environment, replace the code a server runs, or register a
  command of its own whose output comes back to it. The agent is trusted with
  a project's variables. Do not set a variable for a project the agent is
  not trusted with.
- A server that is already published picks up a changed value the next time
  it starts after the reconnect. `refresh_mcp` is needed when a server could
  not start without the variable, or lists different tools once it has it.
  It stops the project's MCP servers and runs the same discovery as
  `discover_tools` (without extra executables). Its result says how many MCP
  servers and proxied tools the project has, names the variables applied
  (names only), and lists the servers that did not start with the reason, the
  ones recorded before that are gone, and the launches that did not answer.
  Because it is a full discovery, it is quick on a small project and takes
  longer on one with many commands.
  It is flagged as an error when a registered server did not start, when a
  server recorded before is gone, or when the project has no proxied tool
  afterwards. It works on a project that is `ready`; one that is installing or
  failed is refused.
- The prefix is the project's slug exactly as `list_projects` shows it, in
  lower case, followed by two underscores. Matching is exact and case-sensitive.
  An empty value counts as set.
- The variables go to every MCP server of the project, and only to them: not
  to its command line tools, not to `sandbox_exec`, not to the install.
- A value from the configuration wins over one stored for the same name by
  `connect_mcp_server`. `project_info` lists the names a project receives (never
  the values) and marks a stored name that is overridden.
- A value with a line break or a NUL character is rejected: the call that
  would have used it fails with a message that names the variable.

**Route 2: `connect_mcp_server(env: …)`.**

```
connect_mcp_server(project: "some_api_server",
                   command: ["node", "build/index.js"],
                   env: { "API_KEY": "replace-with-your-key" })
```

A value an agent passes in a tool call is in the conversation transcript, and
is stored in plain text in the registry. That is generally unsafe, and it is
not the way to give a server a secret. The one exception is an agentic system
with proper secrets management, which injects the value at run time outside
the agent's session. Use `connect_mcp_server` for arguments and entry points,
and route 1 for secrets.

How it behaves:

- A server process is started on first use with `docker exec -i`, shared by
  later calls, stopped after `MCPE_MCP_IDLE_TIMEOUT` seconds without use, and
  restarted on the next call. It is also stopped, inside the sandbox, when a
  call exceeds `MCPE_TOOL_TIMEOUT`.
- The sandbox's network policy applies: a server that calls an external API
  needs `set_project_network(project, true)`.
- Only tools are proxied, over stdio. Upstream resources, prompts, sampling
  and HTTP transports are not.
- Arguments are forwarded as given and validated by the upstream server. Of
  its results, text, images and audio are passed on; embedded text resources
  become text; everything else is dropped.
- A server's tools are published together or not at all (see "Which tools
  are published"); either way they are all callable.

### When the automatic build is not enough

Many projects need a system package, a code generation step, or a build system
this server has no recipe for. The install then ends as `failed`, or as `ready`
with a warning that no executables were found, and the sandbox is kept. The
agent can finish the job itself:

```
set_project_network(project, true)
sandbox_exec(project, "apt-get update && apt-get install -y python3-yaml && make")
set_project_network(project, false)
discover_tools(project, executables: ["/workspace/repo/loccount"])
```

`install_project` also accepts `ecosystem` and `image` to override detection.

## Security model

Installing a project means running its build scripts and its code. This server
confines that to Docker; it does not make untrusted code safe.

What the sandbox does:

- One container and one volume per project, named and labelled with the
  installation's id so that installations sharing a Docker daemon do not
  touch each other's (see [Several installations on one Docker daemon](#several-installations-on-one-docker-daemon)). No
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
  `set_project_network` turns it on.
- Commands are passed as argument vectors, never assembled into shell
  strings, and are killed inside the container when they time out.
- Only `https` clone URLs on allow-listed hosts are accepted.

What it does not do:

- **The build has network access**, on Docker's default bridge. Code running
  then (and whenever you enable the network) can reach the internet and
  services on your host and local network.
- **Container isolation is not a security boundary against a determined
  attacker.** A kernel or runtime escape reaches your host. For stronger
  isolation set `MCPE_DOCKER_RUNTIME=runsc` (gVisor) or run the Docker daemon
  in a VM.
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
    installations (see [Several installations on one Docker daemon](#several-installations-on-one-docker-daemon)). Give them
    the same `<slug>__<NAME>` variables: one that lacks a variable drops the tools
    of servers that need it when it next runs discovery (including
    `discover_tools`, `connect_mcp_server` and `refresh_mcp`), until a process
    that has it refreshes again.
  - At startup, an install left unfinished for more than seven hours (by
    default) is marked failed and its sandbox is taken off the network, unless
    the sandbox is not this installation's: that one is left alone and the
    project's warnings say so (see [Several installations on one Docker daemon](#several-installations-on-one-docker-daemon)). If Docker is not reachable, this waits for the next start. Until it is marked
    failed, `project_info` says the install was started by another session or
    was interrupted.
- **License is reported, not enforced.** The license found in the repository
  is shown at install time with a warning when none is found; the server does
  not verify that a repository is open source.

## Several installations on one Docker daemon

An installation is one data directory: the registry (`registry.json`) and a
file named `installation-id` beside it. The id is eight lowercase hexadecimal
characters, generated the first time a server starts on that directory and
never rewritten. `list_projects` prints it as `Installation id: <id>`, also
when no project is installed. Two copies of mcp-everything that share a Docker
daemon (a Linux shell and a Windows desktop client, say) are two installations,
and they need two data directories. Where the directory is by default:

- Linux: `~/.local/share/mcp-everything/`, or `$XDG_DATA_HOME/mcp-everything/`
  when `XDG_DATA_HOME` is set. The id is in `installation-id` there.
- Windows: `C:\Users\<your user name>\.local\share\mcp-everything\`. There is
  no Windows-specific default; it is the home directory plus `.local\share`.
- `MCPE_DATA_DIR` replaces either.

**Names and labels.** A sandbox made by this version is named
`<MCPE_NAME_PREFIX><id>-<slug>` (with nothing configured, `mcpe-1a2b3c4d-gron`),
for its container and its volume alike. Both carry the labels
`mcp-everything=1` and `mcp-everything.owner=<id>`. The name is for people; the
label is what the code checks. To list every mcp-everything sandbox on the
daemon with its owner:

```sh
docker ps -a --filter label=mcp-everything=1 --format '{{.Names}}\t{{.Label "mcp-everything.owner"}}'
docker volume ls --filter label=mcp-everything=1 --format '{{.Name}}\t{{.Label "mcp-everything.owner"}}'
```

An empty owner means the sandbox was made by an earlier version, which wrote
no owner label.

**What an installation does with a sandbox that is not its own.** A container
or volume is not this installation's when its owner label is another id, or
when it lacks the `mcp-everything=1` label altogether. For such a sandbox the
installation will not start it, run a command in it, give its servers
variables, change its network or remove it. The first four fail with a message
that names the sandbox and its owner, for example
`container "<name>" is another installation's (owner label "<id>")`; removal
is described next. A mixed pair is treated as a whole: if either the container
or the volume a record names is not this installation's, neither is removed.

- `uninstall_project` still completes. It removes the project's record and
  tools, leaves the sandbox in Docker, and says so: "Its sandbox was left in
  place, because it is not this installation's to remove", with each part left
  and whose it is. This is not an error. A removal that fails for another
  reason (Docker did not answer, a failed `docker rm`) keeps the record, as
  before.
- `install_project` with `reinstall: true` leaves that sandbox where it is,
  builds a new one under this installation's own names and ends `ready`, with
  a warning on the project beginning "The previous sandbox of this project was
  left in place, untouched". The old sandbox now has no record; remove it in
  Docker if it is not wanted. A reinstall also fails when the names it needs are
  themselves held by a sandbox that is not this installation's. If the project
  already has this version's names, that is met before anything is removed: the
  record is kept as it was and the error says to remove or rename that sandbox
  by hand. If the names are changing (a project installed before this version,
  or a record that named another sandbox), its old sandbox has already been
  removed or let go by then, so the install fails like any install that fails
  before a container exists: what it created at the new names is removed and
  the record is deleted.
- At startup, the reconciliation of an interrupted install leaves such a
  sandbox alone and says so in the project's warnings.

A sandbox with `mcp-everything=1` and no owner label (made before this
version) is treated as this installation's, because its registry names it:
it is started, used, reinstalled over and removed as it was before.

**`project_info`** ends with one line about the project's container, asked of
Docker at that moment: `Sandbox owner: ...` says it is this installation's, was
made before ownership was recorded, is another installation's (with the owner
label), was not created by mcp-everything, does not exist, or could not be
checked because Docker did not answer. It never fails because of that question.
`list_projects` and the results of an install ask Docker nothing.

**On upgrading.**

- Projects installed before this version keep working with no change. To give
  one an owner, reinstall it (`install_project` with `reinstall: true`): the
  old sandbox is removed and a new one is built under the new names.
- When two installations both list a project that was installed before this
  version, they share the one old sandbox (`mcpe-<slug>`), and neither is
  protected from the other until that project has been reinstalled. The first
  installation to reinstall it removes the shared sandbox; the other then finds
  its sandbox gone and must reinstall it too.
- Upgrade every installation on the machine. An installation still on an
  earlier version does not read labels.
- A reinstall changes a project's sandbox name. Another session of the same
  installation that has a proxied MCP server open on the old sandbox loses it,
  and the server opens again on the next call, on the new sandbox.

**What this does not cover.**

- Anything that can reach the Docker daemon can remove any sandbox. The
  labels are checked by mcp-everything, not enforced by Docker.
- An installation still on an earlier version treats every `mcpe-<slug>`
  sandbox as its own and will remove it.
- A copied data directory is two installations with one id. They cannot be told
  apart and protect nothing from each other. Copying `registry.json` alone,
  without `installation-id`, gives the copy an id of its own; its records then
  name sandboxes that are the other installation's, and are refused as above.
- A deleted data directory leaves sandboxes whose owner is gone. Find them with
  the two commands above (the owner label is an id no installation has) and
  remove them by hand.
- Two sessions of one installation racing a reinstall of the same project: one
  can write the old names back to the registry after the other has built the
  new sandbox, which then has no record. The two commands above find it.
- Windows. Nothing was tested there.

**What was tested.** Linux, one Docker daemon, two data directories. The
Docker suite (`npm run test:docker`) runs two installations as two `App`
instances in one test process, each on its own temporary data directory with
`MCPE_NAME_PREFIX` unset. Both install `tomnomnom/gron` under
their own names and labels, and the first's container is unchanged by the
second's install. With the second's record pointed at the first's sandbox, a
generated tool, `sandbox_exec` and `set_project_network` are each refused and
the first's container keeps its id, running state and networks; a reinstall
builds beside it and warns; an uninstall leaves it and says so. A sandbox made
by hand with the earlier labels is run in, described and removed. The startup
reconciliation and the discovery paths are covered by unit tests only. No test
ran two separate processes, two machines or Windows.

## Protocol revisions

mcp-everything serves two revisions of the MCP protocol: `2026-07-28`, and the
2025 handshake (`initialize`), which it negotiates up to `2025-11-25`.

The client's opening message decides. A client that opens with `server/discover`
or sends its requests with the `2026-07-28` envelope is served in `2026-07-28`.
A client that opens with `initialize` is served in the 2025 handshake, and
that includes one that asks for `2026-07-28` in it: `2026-07-28` has no
`initialize`, so it is answered `2025-11-25`.

Two things differ for a `2026-07-28` client. It is told that the tool list
changed (after an install, an uninstall, a refresh and so on) only if it
subscribed with `subscriptions/listen`; a 2025 client is told without asking.
And tool listings are sent as not cacheable (`ttlMs` 0, private), so a client
that asks again gets the current list.

For each connection, mcp-everything writes one line to stderr naming the
revision it is served in, in this form:

```
[mcp-everything] connection: MCP protocol 2026-07-28
```

For a 2025 client it is written when the handshake completes; for a
`2026-07-28` client, at its first `tools/list` or `tools/call`.

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `GITHUB_TOKEN` / `GH_TOKEN` | none | GitHub API token (search rate limit: 10/min anonymous). |
| `GITLAB_TOKEN` | none | GitLab API token. |
| `MCPE_EXTRA_HOSTS` | none | More forges to allow, e.g. `gitlab.gnome.org=gitlab,git.example.com=gitlab`. |
| `MCPE_DATA_DIR` | `$XDG_DATA_HOME/mcp-everything`, else `~/.local/share/mcp-everything` | Where the project registry and the `installation-id` file are stored. The default follows `XDG_DATA_HOME` when it is set. Copying the directory copies the id, and two installations with one id cannot be told apart; see [Several installations on one Docker daemon](#several-installations-on-one-docker-daemon). A registry written by a newer version of mcp-everything is refused and left untouched; upgrade, or move `registry.json` aside to start with an empty registry (the sandboxes of the projects in it stay in Docker). |
| `MCPE_DOCKER_BIN` | `docker` | The Docker client command, run on the host. |
| `MCPE_MEMORY` / `MCPE_CPUS` / `MCPE_PIDS_LIMIT` | `4g` / `2` / `1024` | Per-sandbox limits; a zero memory or CPU value (which Docker reads as unlimited) falls back to the default. |
| `MCPE_DOCKER_RUNTIME` | Docker's default | Container runtime, e.g. `runsc`. |
| `MCPE_PROBE_IMAGE` | `alpine/git:latest` | Image of the throwaway container that clones a repository and lists its manifests before the build (needs `sh` and `git`). |
| `MCPE_INSTALL_TIMEOUT` | `900` | Build time limit, seconds. |
| `MCPE_TOOL_TIMEOUT` | `120` | Default time limit of a tool call, seconds. |
| `MCPE_HELP_TIMEOUT` | `10` | Time limit of one `--help` call during tool discovery, seconds. |
| `MCPE_MAX_TOOLS_PER_PROJECT` | `40` | Cap on tools published per project (the catalog is not capped). |
| `MCPE_MCP_STARTUP_TIMEOUT` | `30` | Seconds a proxied MCP server may take to answer the handshake. |
| `MCPE_MCP_IDLE_TIMEOUT` | `600` | Seconds of inactivity before a proxied MCP server is stopped. |
| `MCPE_SANDBOX_IDLE_TIMEOUT` | `1800` | Seconds without activity before a project's sandbox container stops itself; `0` disables this. Applies to sandboxes created after it is set. Not `MCPE_MCP_IDLE_TIMEOUT`, which stops proxied MCP servers, not sandboxes. |
| `MCPE_MAX_OUTPUT_BYTES` | `100000` | Cap on captured stdout and stderr, each. |
| `MCPE_IMAGE`, `MCPE_IMAGE_<ECOSYSTEM>` | see table | Override sandbox images. Images need `sh`, `git` and coreutils `timeout`. |
| `MCPE_NAME_PREFIX` | `mcpe-` | Prefix of container and volume names, followed by the installation's id and the project's slug (`mcpe-<id>-<slug>`); an invalid value is refused at startup. The prefix does not separate installations; the id does. |
| `<slug>__<NAME>` | none | Sets `NAME` in the environment of the MCP servers of the project with that slug (lower case, as `list_projects` shows it), for example an API key. Read at each launch, never stored; apply with a reconnect and `refresh_mcp`. See "Giving a server its environment". |

## Limitations

- Tool generation is heuristic. It reads conventional `--help` output; a
  program that documents itself differently gets a single pass-through tool
  that takes `args`. Positional arguments are never modelled, only described
  by the usage line in the tool description.
- Every installed project adds its published tool schemas to your client's
  context. Uninstall what you are not using, narrow it with
  `select_project_tools`, or lower `MCPE_MAX_TOOLS_PER_PROJECT`.
- Version detection reads the repository root only, and trusts it. A project
  that declares nothing gets the default image; one whose declarations are
  wrong may need `install_project(image: ...)`.
- Subcommand tools are generated for at most 25 subcommands per command and
  two levels of nesting. The rest are reachable through the command's
  top-level tool.
- Only the repository root is built. Monorepos with several independent
  projects, Java, .NET, PHP and other ecosystems without a recipe need the
  manual path above.
- A proxied MCP server is always spoken to in the 2025 handshake, whatever
  revision your client uses; a server that refuses that handshake cannot be
  proxied.
- GUI programs, daemons and anything interactive are out of scope: tools run
  to completion and return their output.
- Files go in and out as text through `sandbox_write_file` and
  `sandbox_read_file`; there is no host file mount.
- A sandbox with no activity for `MCPE_SANDBOX_IDLE_TIMEOUT` seconds (30
  minutes by default) stops itself; its volume and installed tools are kept
  and it is restarted on first use, as it is after a reboot. Its network
  setting is unchanged by this. Things to know:
  - The timeout is fixed when the sandbox is created, so projects installed
    before this setting existed need a reinstall (`install_project` with
    `reinstall: true`) to get it.
  - To check a sandbox, run `docker inspect --format
    '{{index .Config.Labels "mcp-everything.idle-timeout"}}' <container>`.
    A sandbox made by this version is named `MCPE_NAME_PREFIX` (default
    `mcpe-`), then the installation's id, then the project's slug, for example
    `mcpe-1a2b3c4d-gron`; one made by an earlier version is the prefix plus
    the slug (`mcpe-gron`). `project_info` shows a project's sandbox name, and
    `docker ps -a --filter label=mcp-everything=1 --format '{{.Names}}\t{{.Label "mcp-everything.owner"}}'`
    lists them all with their owners (an empty owner is a sandbox from before
    owners were recorded; see [Several installations on one Docker daemon](#several-installations-on-one-docker-daemon)).
    A number is the idle seconds it stops after, `0` means it was
    created with the timeout disabled, and empty output means it predates
    the setting and needs the reinstall above.
  - A running tool call, an install, a live proxied MCP server (until
    `MCPE_MCP_IDLE_TIMEOUT` closes it) or a process a tool leaves running
    keeps its sandbox up.
  - A sandbox stops up to about half a minute after the timeout.
  - A sandbox at its process limit (`MCPE_PIDS_LIMIT`) keeps running: the
    watchdog retries its failed fork rather than exiting. While it is at the
    limit it may use up to one CPU's worth of the sandbox's own CPU limit
    retrying, until a process slot frees; idle stopping then resumes with the
    same timeout and latency as above. It logs one line to the container's
    stderr the first time this happens.
  - Idle stopping has not been verified under gVisor (`runsc`).

## Development

```sh
npm test              # unit and protocol tests, no Docker needed
npm run test:docker   # end-to-end against real Docker and github.com
npm run test:docker:pressure  # the slow fork-pressure cases only
npm run typecheck
```

`npm run test:docker` skips the fork-pressure cases; run them with `npm run test:docker:pressure` when the idle watchdog (the sandbox entrypoint script) or its tests change.

Every pull request and every push to `main` runs install, typecheck, the unit tests and the build on GitHub Actions; the Docker suite is not part of it and is run locally.

Layout:

```
src/forge/      repository reference parsing, GitHub/GitLab search
src/sandbox/    Docker wrapper: probe, container lifecycle, exec, network
src/install/    build system and runtime version detection, recipes, orchestration
src/toolgen/    --help parser, help crawler, tool naming and publication,
                argv construction, MCP launch detection
src/proxy/      client sessions to MCP servers running inside sandboxes
src/registry.ts persistent project registry (shared between sessions)
src/server.ts   MCP server: built-in tools and dispatch to generated tools
```

## License

[MIT](LICENSE)
