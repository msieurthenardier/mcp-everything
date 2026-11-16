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

- Node.js 20+
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
| `list_projects` / `project_info` | What is installed, its status, warnings, and its published tools. |
| `find_project_tools` | Search every generated tool, published or not, by keyword. |
| `select_project_tools` | Choose which of a project's tools are published in the tool list. |
| `call_project_tool` | Call a generated tool by name, for clients that do not refresh their tool list. |
| `sandbox_exec` | Run a shell command in a project's sandbox. |
| `sandbox_read_file` / `sandbox_write_file` | Move text in and out of a sandbox. |
| `set_project_network` | Turn a sandbox's outbound network on or off. |
| `discover_tools` | Regenerate tools, optionally for executables you built by hand. |
| `connect_mcp_server` / `disconnect_mcp_server` | Proxy an MCP server that runs inside a project's sandbox. |
| `refresh_mcp` | Stop a project's MCP servers and run discovery again, e.g. after giving a server its environment variables. Reports what started and what did not. |
| `uninstall_project` | Delete a project's container, volume and tools. |

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
   passed `network: true`.
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

- The agent never sees the values, and nothing is stored: the variables are
  read from mcp-everything's environment each time a server is started.
- A server that is already published picks up a changed value the next time
  it starts after the reconnect. `refresh_mcp` is needed when a server could
  not start without the variable, or lists different tools once it has it.
  It stops the project's MCP servers and runs the same discovery as
  `discover_tools` (without extra executables). Its result says how many MCP
  servers and proxied tools the project has, names the variables applied
  (names only), and lists the servers that did not start with the reason, the
  ones recorded before that are gone, and the launches that did not answer.
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

- One container and one volume per project. No host directory or Docker socket
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
  handed to Docker through a private temporary file, not the command line, and
  mcp-everything itself never writes a value into a tool result, an error
  message or its diagnostics log; `project_info` shows names only. That
  promise covers what mcp-everything writes, not what a server prints (see the
  last point below).
- **Variables given to a project's MCP servers are exposed to more than those
  servers.**
  - Any code running in the project's sandbox can read a running server's
    variables (for example through `/proc/<pid>/environ`); "MCP servers only"
    describes what they are handed to, not an isolation boundary inside the
    sandbox.
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
  - Several mcp-everything processes can share a data directory. Give them the
    same `<slug>__<NAME>` variables: one that lacks a variable drops the tools
    of servers that need it when it next runs discovery (including
    `discover_tools`, `connect_mcp_server` and `refresh_mcp`), until a process
    that has it refreshes again.
- **License is reported, not enforced.** The license found in the repository
  is shown at install time with a warning when none is found; the server does
  not verify that a repository is open source.

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `GITHUB_TOKEN` / `GH_TOKEN` | none | GitHub API token (search rate limit: 10/min anonymous). |
| `GITLAB_TOKEN` | none | GitLab API token. |
| `MCPE_EXTRA_HOSTS` | none | More forges to allow, e.g. `gitlab.gnome.org=gitlab,git.example.com=gitlab`. |
| `MCPE_DATA_DIR` | `~/.local/share/mcp-everything` | Where the project registry is stored. |
| `MCPE_MEMORY` / `MCPE_CPUS` / `MCPE_PIDS_LIMIT` | `4g` / `2` / `1024` | Per-sandbox limits. |
| `MCPE_DOCKER_RUNTIME` | Docker's default | Container runtime, e.g. `runsc`. |
| `MCPE_INSTALL_TIMEOUT` | `900` | Build time limit, seconds. |
| `MCPE_TOOL_TIMEOUT` | `120` | Default time limit of a tool call, seconds. |
| `MCPE_MAX_TOOLS_PER_PROJECT` | `40` | Cap on tools published per project (the catalog is not capped). |
| `MCPE_MCP_STARTUP_TIMEOUT` | `30` | Seconds a proxied MCP server may take to answer the handshake. |
| `MCPE_MCP_IDLE_TIMEOUT` | `600` | Seconds of inactivity before a proxied MCP server is stopped. |
| `MCPE_SANDBOX_IDLE_TIMEOUT` | `1800` | Seconds without activity before a project's sandbox container stops itself; `0` disables this. Applies to sandboxes created after it is set. Not `MCPE_MCP_IDLE_TIMEOUT`, which stops proxied MCP servers, not sandboxes. |
| `MCPE_MAX_OUTPUT_BYTES` | `100000` | Cap on captured stdout and stderr, each. |
| `MCPE_IMAGE`, `MCPE_IMAGE_<ECOSYSTEM>` | see table | Override sandbox images. Images need `sh`, `git` and coreutils `timeout`. |
| `MCPE_NAME_PREFIX` | `mcpe-` | Prefix of container and volume names. |
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
    The container is named `MCPE_NAME_PREFIX` (default `mcpe-`) plus the
    project's slug; `docker ps -a --filter label=mcp-everything=1` lists them
    all. A number is the idle seconds it stops after, `0` means it was
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
