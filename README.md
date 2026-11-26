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

The Node floor follows the toolchain the project is built and tested with:
vitest needs `^22.12.0 || ^24.0.0 || >=26.0.0`, and the hosted check runs the
current Node 22 (from `.nvmrc`). Node 20 is no longer supported; on it, npm
prints an `engines` warning. `@types/node` is pinned to the 22 line to match.

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

The first launch downloads and builds the server, which takes several seconds;
later launches reuse npm's cache. A client that gives up waiting before the
server is up can be served in an older revision; see
[Protocol revisions](#protocol-revisions). This form follows the default branch, so a
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
| `install_project` | Clone, build and generate tools for a repository. When scanning is on (see [Checking projects before they run](docs/checking.md#checking-projects-before-they-run)), the repository is checked first, and the install can be blocked or can go ahead with the findings reported. Its `hosts` parameter (up to 64 entries) adds hosts the project may reach under network containment; see [Network containment](docs/containment.md#network-containment). |
| `check_project` | Clone and check a repository without installing it: the built-in check and the operator's scanners, whatever the scanning setting. Reports what an install would do now. Nothing from the repository is built or run. |
| `list_projects` / `project_info` | What is installed, its status, warnings, and its published tools. `list_projects` states this installation's id; `project_info` also says whose its sandbox container is, according to Docker (a sandbox made before ownership was recorded is one whose owner cannot be told), and the sandbox's network as Docker shows it (`off`, `contained`, `open` or `unknown`); for a contained one it adds the hosts it may reach and the proxy's latest refusals. |
| `find_project_tools` | Search every generated tool, published or not, by keyword, except tools withheld by the tool-description check (see [The tool-description check](docs/checking.md#the-tool-description-check)). |
| `select_project_tools` | Choose which of a project's tools are published in the tool list. |
| `call_project_tool` | Call a generated tool by name, for clients that do not refresh their tool list. |
| `sandbox_exec` | Run a shell command in a project's sandbox. |
| `sandbox_read_file` / `sandbox_write_file` | Move text in and out of a sandbox. |
| `set_project_network` | Turn a sandbox's outbound network on or off. Under `MCPE_NETWORK=contained`, on means contained: only the project's registries and hosts. |
| `set_project_hosts` | Add or remove hosts a project may reach under network containment (`add`, `remove`), without a reinstall. Without containment the hosts are recorded and have no effect. It cannot add local addresses. |
| `discover_tools` | Regenerate tools, optionally for executables you built by hand. |
| `connect_mcp_server` / `disconnect_mcp_server` | Proxy an MCP server that runs inside a project's sandbox. |
| `refresh_mcp` | Stop a project's MCP servers and run discovery again, e.g. after giving a server its environment variables. Reports what started and what did not. |
| `uninstall_project` | Delete a project's container, volume and tools. A sandbox that is another installation's, or was not created by mcp-everything, is never touched: the project's record and tools go, the sandbox stays in Docker, and the result says which parts were left and whose they are. |

Repositories can be given as `owner/name` (GitHub), `github:owner/name`,
`gitlab:group/sub/name`, or an `https://` URL. `ref` pins a branch, tag or
commit.

## How installation works

1. **Clone.** A throwaway container clones the repository (shallow) into a
   fresh Docker volume and reports the root listing and manifest files. With
   scanning on, the volume is a staging volume, not the project's own.
2. **Check (only when scanning is on).** The built-in check and the
   operator's scanners run over the staging clone before anything of the
   repository is built or run. Under `block`, findings at or above the
   threshold end the install here. A reinstall's existing project stays
   untouched until the check passes; if the build goes ahead, it runs on a
   copy of exactly the checked clone. See
   [Checking projects before they run](docs/checking.md#checking-projects-before-they-run).
3. **Detect.** The manifests decide the build system, and the runtime
   version the project asks for decides the image (see below).
4. **Build.** A long-lived sandbox container runs a fixed recipe for that
   build system, with network access so dependencies can be downloaded.
5. **Go offline.** The sandbox is disconnected from the network unless you
   passed `network: true`. A failed install always leaves the sandbox
   offline, whatever `network` was; use `set_project_network` to go online.
6. **Discover.** Executables the build produced are collected: console
   scripts of the installed Python distribution, `bin` entries of
   `package.json` (including workspace packages), Cargo and Go binaries,
   gem executables, and anything installed to `/opt/mcpe/bin`. Names that
   resolve to the same file and print the same help are folded into one
   command with aliases.
7. **Proxy.** Commands that turn out to be MCP servers are connected to
   (see below).
8. **Generate.** Each executable is run with `--help` (the top-level command
   also with `-h` and `help`), and so is each subcommand it lists, two levels
   deep. Options become typed properties, value choices become enums, and
   every tool also accepts `args`, `stdin`, `cwd` and `timeout_seconds`.
9. **Publish.** A subset of the generated tools is advertised in the MCP tool
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

## Checking projects before they run

Scanning is off by default. When the operator turns it on, `install_project`
clones the repository into a staging volume and runs the built-in check and the
operator's own scanners over the clone before anything is built. Under `block`,
findings at or above the threshold end the install; otherwise they are reported
and the build goes ahead. Scanners the operator marks `"stage": "build"` run
again after the build, over what it produced, before tools are published.
`check_project` clones and checks a repository without installing it, whatever
the scanning setting.

The chapter covers how to turn scanning on, how to add a scanner (at the source
or the build stage), the check after the build, the built-in check, the
dependency check, the tool-description check, and what none of this protects
against.

Full chapter: [docs/checking.md](docs/checking.md)

## Network containment

Containment is off by default. When the operator turns it on, each project's
sandbox gets a network of its own with no route out except through a proxy,
which allows the default hosts of the project's build system, the project's own
`hosts`, and local services only as the operator allows. A hostile agent is
still out of scope, and image pulls stay outside containment.

The chapter covers how to turn it on, how it works, what each stage reaches, the
default hosts, a project's hosts, local access, scanners' hosts, what reaches
outside services, what a refusal looks like, upgrading, and what containment
does not stop.

Full chapter: [docs/containment.md](docs/containment.md)

## Security model

Installing a project means running its build scripts and its code. This server
confines that to Docker; it does not make untrusted code safe. The chapter says
what the sandbox does (one container and one volume per project, no host
directory or Docker socket mounted, capabilities dropped, outbound network
removed after the build) and what it does not do (container isolation is not a
boundary against a determined attacker, disk usage is not limited, tool output
and descriptions come from the project, and variables given to a project's MCP
servers are exposed to more than those servers). It ends with the isolation
runtime.

Full chapter: [docs/security-model.md](docs/security-model.md)

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

**The id file.** The file holds the id and one line ending (`\n` or `\r\n`) after it, which may
be left off; one UTF-8 byte-order mark before the id is also accepted.
Anything else (whitespace, capitals, another length, a second line ending)
makes the file invalid, and an invalid file stops startup: the server prints
one line naming the file and exits with status 1. It does not replace the
file. Restore the file from a backup, and the installation keeps its
sandboxes. Delete it, and the next start makes a new id that owns none of them
(see "What this does not cover" below).

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
no owner label; this version cannot tell whose it is and never acts on it.

**What an installation does with a sandbox that is not its own.** A container
or volume is not this installation's when its owner label is another id, when
it lacks the `mcp-everything=1` label altogether, or when it has that label and
no owner label (made before ownership was recorded). For such a sandbox the
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
  Docker if it is not wanted (one made before ownership was recorded is left to
  the operator, as above). A reinstall also fails when the names it needs are
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

A sandbox with `mcp-everything=1` and no owner label (made before ownership
was recorded) is never started, used, reinstalled over or removed by this
installation: it cannot be told whether it is its own, so it is refused
everywhere a sandbox that is not its own is. Every message about it says "Do not
remove it yourself; ask the operator". What the operator does: if they confirm
the sandbox is this installation's and not wanted, they remove its container
and its volume themselves (`project_info` prints the commands, `docker rm -f
<name>` and `docker volume rm <name>`; `uninstall_project` prints them too, for
a project whose record it deletes), then reinstall the project. An older
mcp-everything on the same daemon still treats such a sandbox as its own and
may remove it; this version cannot prevent that.

**`project_info`** ends with one line about the project's container, asked of
Docker at that moment: `Sandbox owner: ...` says it is this installation's, was
made before ownership was recorded (this installation cannot tell whether it is
its own and does not act on it, with the commands for the operator), is another
installation's (with the owner label), was not created by mcp-everything, does
not exist, or could not be checked because Docker did not answer. It never fails because of that question,
but it can wait for the answer: when the daemon hangs, `project_info` can take
up to 30 seconds.
`list_projects` and the results of an install ask Docker nothing.

**On upgrading.**

- A project installed before ownership was recorded no longer works: this
  version refuses its sandbox (its tools fail with a message saying so) until
  the operator removes that sandbox, using the commands `project_info` gives,
  and the project is reinstalled (`install_project` with `reinstall: true`,
  which builds a new sandbox under the new names and leaves the old one in
  place). Nothing here removes the old sandbox for you.
- When two installations both list a project that was installed before this
  version, they share the one old sandbox (`mcpe-<slug>`). This version acts on
  it for neither. An installation still on an earlier version removes it when
  it reinstalls the project; the other then finds its sandbox gone and must
  reinstall too.
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
- An `installation-id` file that is deleted or lost while `registry.json` stays
  has the same result as a copied registry without its id file: a new id is
  made at the next start, and every project made since ownership was recorded
  is refused as above. An uninstall leaves its sandbox and a reinstall builds
  beside it. The two commands above find the sandboxes left behind. Restoring
  the old file before the next start avoids all of it.
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

A connection writes no line if that moment never comes: a 2025 client that
sends `initialize` and never `notifications/initialized` and makes no tool
request, or a `2026-07-28` client that only sends `server/discover` or only
subscribes and never lists or calls a tool.

Some clients probe for `2026-07-28` first and fall back to `initialize` when
the probe gets no answer in time. How long they wait is the client's choice, not
a rule of the protocol (one client's SDK allows 10 s). On a first `npx` launch
the server can take several seconds to start. Such a client, if it gives up
before the server is up, falls back to the 2025 handshake and shows
`2025-11-25`, although the server supports `2026-07-28`.
The server has done nothing wrong: it answers the late probe and then serves
the `initialize` that follows. The `connection:` line shows the revision a
connection was actually served in. A second launch, which uses npm's warm
cache, or running from a checkout avoids the delay.

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `GITHUB_TOKEN` / `GH_TOKEN` | none | GitHub API token (search rate limit: 10/min anonymous; the dependency check's limit: 60/hour anonymous). Sent to `api.github.com` only. |
| `GITLAB_TOKEN` | none | GitLab API token. |
| `MCPE_EXTRA_HOSTS` | none | More forges to allow, e.g. `gitlab.gnome.org=gitlab,git.example.com=gitlab`. |
| `MCPE_DATA_DIR` | `$XDG_DATA_HOME/mcp-everything`, else `~/.local/share/mcp-everything` | Where the project registry and the `installation-id` file are stored. The default follows `XDG_DATA_HOME` when it is set. Copying the directory copies the id, and two installations with one id cannot be told apart; see [Several installations on one Docker daemon](#several-installations-on-one-docker-daemon). A registry written by a newer version of mcp-everything is refused and left untouched; upgrade, or move `registry.json` aside to start with an empty registry (the sandboxes of the projects in it stay in Docker). |
| `MCPE_DOCKER_BIN` | `docker` | The Docker client command, run on the host. |
| `MCPE_MEMORY` / `MCPE_CPUS` / `MCPE_PIDS_LIMIT` | `4g` / `2` / `1024` | Per-sandbox limits; a zero memory or CPU value (which Docker reads as unlimited) falls back to the default. |
| `MCPE_DOCKER_RUNTIME` | Docker's default | Container runtime, e.g. `runsc`. Naming one requires it: installs and checks refuse to start when Docker cannot run it. See [The isolation runtime](docs/security-model.md#the-isolation-runtime). |
| `MCPE_NETWORK` | `open` | `open` (networks as they always were) or `contained` (every network mcp-everything uses has no route out except through a proxy that allows named hosts). Anything else is refused at startup. See [Network containment](docs/containment.md#network-containment). |
| `MCPE_LOCAL_ACCESS` | none | Local services a repository's sandbox may reach under `MCPE_NETWORK=contained`, as `<repository>=<host name>:<port>[,<host name>:<port>][;<repository>=...]`. Only the operator can set it. See [Local access](docs/containment.md#local-access-mcpe_local_access). |
| `MCPE_PROXY_IMAGE` | `node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a` | Image the network proxies run in (needs `node`). The default is pinned by digest; pin your own the same way. |
| `MCPE_PROBE_IMAGE` | `alpine/git:2.54.1@sha256:29cff25811f790b9f72fc266bf8009a5a911714c0e03c31c47339c50909d9aef` | Image of the throwaway container that clones a repository, lists its manifests and build files before the build, and (with scanning on) copies the checked clone (needs `sh`, `git` and `cp`). The default is pinned by digest; pin your own the same way. |
| `MCPE_SCAN` | `off` | Check repositories before they build: `off`, `on` or `warn` (report, always build), or `block`. See [Checking projects before they run](docs/checking.md#checking-projects-before-they-run). |
| `MCPE_SCAN_BLOCK_AT` | `error` | With `MCPE_SCAN=block` only: the lowest level that blocks an install, `error`, `warning` or `note`. |
| `MCPE_SCAN_TIMEOUT` | `900` | Overall time for all of one check's scanners, in seconds (60 to 3600). |
| `MCPE_SCANNERS` | none | Path to a JSON file of the operator's own scanners (a regular file of at most 1,000,000 bytes). |
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
  wrong may need `install_project(image: ...)`. The built-in check of a
  repository's build files has its own limits on what it reads (files, bytes,
  depth, pruned directories); see
  [the built-in check](docs/checking.md#the-built-in-check).
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
    lists them all with their owners (an empty owner is a sandbox made before
    owners were recorded, which this version never acts on; see [Several installations on one Docker daemon](#several-installations-on-one-docker-daemon)).
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
  - Under gVisor (`runsc`), register the runtime with **`--overlay2=none`**
    (`sudo runsc install -- --overlay2=none`, then restart Docker). gVisor's
    default root-filesystem overlay discards writes outside volumes when a
    container exits, and a sandbox's build output lives in the container's
    layer, so an idle-stopped sandbox would lose the tools it built. With
    `MCPE_DOCKER_RUNTIME=runsc` mcp-everything logs one warning at startup when
    Docker's registration of `runsc` lacks it; it does not refuse.
  - Under `MCPE_NETWORK=contained`, the project's proxy is not stopped with
    its sandbox; see [What containment does not stop](docs/containment.md#what-containment-does-not-stop).
- Under `MCPE_NETWORK=contained`, every project network and every networked
  clone or scanner takes an address range from Docker's own pools, and a stopped
  sandbox's network keeps its range. When Docker has none left, the error names
  `default-address-pools` in the daemon's configuration; turning a project's
  network off releases its range. The pools can overlap your local network;
  they are Docker's, and mcp-everything does not choose ranges.
- The default hosts of build systems other than Go and npm have not been
  measured under containment; see [The default hosts](docs/containment.md#the-default-hosts).

## Development

```sh
npm test              # unit and protocol tests, no Docker needed
npm run test:slow     # the slow ones: real sockets, and the probe scripts in a local shell
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
src/scan/        the checks that run before a build: built-in analysis, scanner
                runs, SARIF parsing, the policy
src/server.ts   MCP server: built-in tools and dispatch to generated tools
```

## License

[MIT](LICENSE)
