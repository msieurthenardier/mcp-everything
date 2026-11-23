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
| `install_project` | Clone, build and generate tools for a repository. When scanning is on (see [Checking projects before they run](#checking-projects-before-they-run)), the repository is checked first, and the install can be blocked or can go ahead with the findings reported. Its `hosts` parameter (up to 64 entries) adds hosts the project may reach under network containment; see [Network containment](#network-containment). |
| `check_project` | Clone and check a repository without installing it: the built-in check and the operator's scanners, whatever the scanning setting. Reports what an install would do now. Nothing from the repository is built or run. |
| `list_projects` / `project_info` | What is installed, its status, warnings, and its published tools. `list_projects` states this installation's id; `project_info` also says whose its sandbox container is, according to Docker, and the sandbox's network as Docker shows it (`off`, `contained`, `open` or `unknown`); for a contained one it adds the hosts it may reach and the proxy's latest refusals. |
| `find_project_tools` | Search every generated tool, published or not, by keyword. |
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
   [Checking projects before they run](#checking-projects-before-they-run).
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

Scanning is **off by default**: with nothing configured, installs behave as
they always have, and the server's instructions, every install result and
`project_info` say that projects are not scanned. The operator turns scanning
on from mcp-everything's environment; the agent cannot turn it on or off, add
or remove a scanner, or change the policy.

**With scanning on** (`MCPE_SCAN` set to `on`, `warn` or `block`),
`install_project` does this in order:

1. A throwaway container clones the repository into a new *staging* volume
   (never into an installed project's volume) and reads the build files named
   below, within the limits stated below.
2. The built-in check and the operator's scanners run over that clone. Nothing
   from the repository is built or run by the check. Scanners are the
   operator's own images and do read the repository's files.
3. The policy decides. Under `block`, findings at or above the threshold end
   the install: nothing is built and the result says why. Under `warn`,
   findings are reported and the build goes ahead.
4. If the build goes ahead, the checked staging volume is copied into the
   project's new volume and the build runs on that copy: the build runs on
   exactly the bytes that were checked, not on a second clone.

A **reinstall** (`reinstall: true`, or an install of a project that exists but
is not ready) is checked
before anything of it is touched: its sandbox, volume, record and tools stay
as they were until the check passes. A blocked reinstall changes one thing in
the existing record, a warning saying that a reinstall at that commit was
blocked on that (UTC) date. If the check cannot be made (for example the clone
fails), the existing project is left as it was. `install_project` on a
repository that is already installed and ready, without `reinstall`, returns
the existing project and checks nothing.

**`check_project`** clones and checks a repository at any time, whatever
`MCPE_SCAN` says, without installing it: nothing is built, no installed
project is changed, and the staging volume is removed afterwards. It runs the
built-in check and every configured scanner, and says what an install would
do under the current setting (blocked, built with the findings reported, not
blocked, or that scanning is off).

What the agent sees: the report lists each check with its status (`ran`,
`incomplete`, `failed` or `not-run`), its counts per level, up to 20 findings
per check (highest level first, with how many were not shown) and its notes.
`list_projects`, `project_info` and the install result show a `security:` line for each
project, saying whether it was scanned at install, at which commit, under
which mode, the counts, and what scanning is now; `project_info` and the install result also list
the stored checks. Findings and scanner output are text from the repository:
they are cleaned to one line and capped (message 200 characters, location 120,
rule id 80), and the agent is told to treat them as data.

Docker objects. A check makes a staging volume and one-shot containers (clone,
scanner, copy), each owned like a sandbox (labelled with the installation's id,
and with `mcp-everything.role` set to `staging`, `clone`, `scan` or `copy`) and
removed when no longer needed: the containers when they end, the staging volume
after the copy or when the check ends without an install. If the server is killed mid-check, the next start
removes this installation's leftovers once they are old enough that no live
check of it can own them (the clone's 600 seconds, `MCPE_SCAN_TIMEOUT`, the
copy's 300 seconds and 1800 seconds more); it logs what it removed.

### Turning it on

Set these in the environment of the mcp-everything process, as with every
other `MCPE_*` setting. They are read once, at startup, so a change needs a
reconnect. An invalid value is refused at startup.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCPE_SCAN` | `off` | `off`; `on` or `warn` (the same: check, report, always build); `block` (check, and do not build when the policy blocks). |
| `MCPE_SCAN_BLOCK_AT` | `error` | Under `MCPE_SCAN=block` only (setting it under any other value is refused at startup): the lowest level that blocks, `error`, `warning` or `note`. |
| `MCPE_SCAN_TIMEOUT` | `900` | Whole seconds, 60 to 3600: the overall time budget for all of one check's scanners, image pulls included. |
| `MCPE_SCANNERS` | none | Path to a JSON file of your own scanners (below). A regular file of at most 1,000,000 bytes. It may be set while scanning is `off`: `check_project` uses it. |

What blocks. The built-in check reports its red flags (below) at level
`warning` and everything else it lists at level `note`; it reports nothing
at `error`. So with no scanner of your own, `MCPE_SCAN=block` with the default
`MCPE_SCAN_BLOCK_AT=error` can never block anything; the startup log and the
server's instructions say so. At `warning` a project with a red
flag is blocked. At `note` every project is blocked, because the built-in
check always has notes (even for a project with no lifecycle script) and notes count at
that level. Only checks that ran or came out incomplete count; a check that
failed or did not run is reported and never counts, so a scanner that fails
or times out never blocks an install.

### Adding a scanner

`MCPE_SCANNERS` names a JSON file:

```json
{
  "scanners": [
    {
      "name": "trivy",
      "image": "aquasec/trivy@sha256:<digest of the version you chose>",
      "command": ["fs", "--quiet", "--format", "sarif", "/scan/repo"],
      "network": true,
      "hosts": ["mirror.gcr.io", "ghcr.io"],
      "timeout_seconds": 300,
      "env": []
    }
  ]
}
```

- `name` (required): lower-case letters, digits and hyphens, up to 32,
  starting with a letter or digit, unique; `build-hooks` is reserved for the
  built-in check. `image` and `command` (1 to 64 strings) are required.
  `entrypoint` (optional) replaces the image's entrypoint: a string of at
  most 256 characters, and `""` clears it so `command` is the whole command
  line. `network` defaults to `false`; `timeout_seconds` to 300 (10 to 1800);
  `env` to none. `hosts` (1 to 64 strings) names what a scanner with `network:
  true` may reach under `MCPE_NETWORK=contained`; see
  [Scanners' hosts](#scanners-hosts). At most 16 scanners. Any other key is
  refused at startup (`stage` is accepted with the value `"source"` and has no
  effect today).
- **Pin the image by digest**, as the example does, and bump the digest
  yourself when you choose a newer version: a tag can be moved. mcp-everything
  pins the images it chooses itself (`MCPE_PROBE_IMAGE`) the same way.
- The image runs with its own entrypoint, and `command` is the arguments it is
  given. So for the example the container runs `trivy fs --quiet --format
  sarif /scan/repo`. (The `trivy` entrypoint and options in the example come
  from Trivy's documentation, not from this project's tests.)
- **The scanner must write SARIF 2.1.0 to standard output.** Standard error
  is its log: a tail of it appears in the report only when the scanner failed.
  The exit code is ignored (scanners exit non-zero when they find something).
  Output over 8 MB is a failure. SARIF results that are suppressed, or whose
  `kind` is `pass`, `notApplicable` or `informational`, are not counted; a
  result with no level of its own (and no default level on its rule) counts as `warning`.
- A scanner that can write SARIF only to a file, or that needs a pre-step,
  needs a wrapper, and the command is not run through a shell. Set
  `entrypoint` to a shell the image has and put the script in `command`:

  ```json
  {
    "name": "filescan",
    "image": "example/filescan@sha256:<digest>",
    "entrypoint": "sh",
    "command": ["-c", "filescan -o /tmp/r.sarif /scan/repo >&2; cat /tmp/r.sarif"]
  }
  ```

  The container runs `sh -c '...'`; the report goes to the container's own
  writable layer (the checkout is read-only) and `cat` prints it. `""` clears
  the image's entrypoint, so `command` can start with the program itself
  (`["sh", "-c", "..."]`). The image must contain the program you name. The
  override mechanics (an `entrypoint` replacing the image's, and `""` clearing
  it) are exercised by this project's tests with a shell script that prints
  SARIF; the example's `filescan` is made up. Building your own image with the
  wrapper as its `ENTRYPOINT` also works.
- The checkout is mounted **read-only** at `/scan` (the repository is
  `/scan/repo`, which is also the working directory); the scanner cannot
  change what is built. Its network is **off** unless `network` is `true`.
  Vulnerability scanners usually download a database, so they need it, and a
  scanner with its network on can reach the internet and your local network
  (see below), unless you turn on `MCPE_NETWORK=contained`, which narrows it to
  the scanner's own `hosts` (see [Scanners' hosts](#scanners-hosts)). Each scanner runs in its own container with a sandbox's
  memory, CPU and process limits, all capabilities dropped, `no-new-privileges`
  and `MCPE_DOCKER_RUNTIME` when set, and the container is
  removed afterwards.
- `env` lists names of variables in mcp-everything's own environment whose
  values the scanner is given, for a credential it needs (for example a
  registry token). Values are never stored: they go to Docker in a private
  temporary file (mode 0600, in the data directory's `tmp`) that is removed
  as soon as the scanner ends, not on the command line. A variable that is not set,
  or whose value cannot be passed (it contains a line break), makes that one
  scanner `failed`. Values of four or more characters are **redacted** from the
  scanner's output, its error tail and its findings before the agent sees them.
  That removes the value as given (and with its whitespace collapsed); it does
  not recognize an encoded form of it, and a scanner with its network on can
  send a credential anywhere.
- Scanners run one at a time, in the file's order, after the built-in check.
  Each gets the smaller of its own `timeout_seconds` and what is left of
  `MCPE_SCAN_TIMEOUT`; a scanner that would have under 10 seconds is not
  started and it and the ones after it are reported as `not-run`. A scanner
  that fails (the image cannot be pulled, a variable is missing, it times out,
  its output is not complete SARIF) is reported as `failed` with a short
  reason and **never blocks**. The clone itself has its own 600-second limit
  before the budget starts.

### The built-in check

The check named `build-hooks` always runs, with no configuration. It reads the
build files of the repository and lists where the install recipe for the
detected build system runs the repository's own code. It analyses only the
build system the install would use (the detected one, or `ecosystem` when
given), not every build system a repository might contain. It is a **reading
aid, not a verdict**: it tells you what to look at; a result with no findings
does not mean the project is safe.

What it lists, for each build system (`note` level unless marked):

| Build system | What is listed |
| --- | --- |
| `node` | The root `package.json` scripts `preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`, `prepare`, `postprepare`, and `prebuild`, `build`, `postbuild` when a `build` script exists (those the package manager may or may not run are marked "if"); `preinstall`, `install` and `postinstall` of nested `package.json` files (workspace packages); a `binding.gyp` beside a `package.json` with no install script; `.pnpmfile.cjs` with a `pnpm-lock.yaml`; `yarnPath`/`plugins` in `.yarnrc.yml` and `yarn-path` in `.yarnrc` with a `yarn.lock`; `script-shell`, `node-options`, `git` and `node-gyp` in `.npmrc`, and its `registry` (as a note about where packages come from). |
| `python` | `setup.py`; in `pyproject.toml`: `backend-path`, build requirements given as URLs or paths, hatch custom hooks and a `code` version source, a poetry build script, a pdm `setup-script`, setuptools `attr:` imports (also in `setup.cfg`); for maturin, setuptools-rust, meson-python and scikit-build-core, the cargo, meson or cmake files they run; `hatch.toml`; in `requirements.txt`: editable installs, local paths, included files (named, not read) and index options (as a note about where packages come from). |
| `rust` | `build.rs` (or the file `build =` names), proc-macro crates, the same for nested `Cargo.toml` files (marked as running only if built as a member or dependency); in a root `.cargo/config.toml` or `.cargo/config`: `rustc-wrapper`, `rustc-workspace-wrapper`, `rustc`, `rustdoc`, `target.*.linker` and `ar`, `-C linker=` in `rustflags`, `registry.credential-provider`, and `[source]` and `[patch]` (as notes about where code comes from). |
| `go` | `go install` runs nothing from the repository (stated as a note); a root `Makefile`, which the recipe runs only if `go install` fails and installed nothing. |
| `ruby` | `Gemfile`; the root `*.gemspec` and the extension files it names; any `extconf.rb` or `Rakefile` found, marked as running only if a gemspec names it. |
| `cmake` | the root `CMakeLists.txt`; nested `CMakeLists.txt` and `*.cmake` files, marked as running only if reached. |
| `autotools` | `configure`, `configure.ac`, `Makefile.am`, `Makefile.in`, `*.m4` and the root `Makefile`; a `configure` or `Makefile.in` or `*.m4` read only in part is a note, not an incomplete check. |
| `make` | the root makefile (`GNUmakefile`, `makefile` or `Makefile`, as GNU make picks); nested makefiles and `*.mk` files, marked as running only if reached. |
| `generic` | nothing is built, so nothing runs; stated as a note. |

Each finding names the file and line. **Red flags** (level `warning`) are
searched in the files above that were reported (the whole file; for
`package.json`, only the script strings that were listed):

- `build-hooks/download-exec`: `curl` or `wget` feeding a shell or another
  interpreter that reads it as its program, or inside `$(...)` run by one.
- `build-hooks/decode-exec`: a decoder (`atob(`, `b64decode`, `base64 -d`,
  `fromhex`, `unhexlify`, `Buffer.from` of base64 or hex) and an executor
  (`eval`, `exec(`, `execSync`, `child_process`, `Function(`, `| sh`,
  `sh -c`) within 10 lines of each other (on the same line in makefiles and
  autotools files).
- `build-hooks/write-outside`: a write to a shell start-up or credential file
  outside the project (under `~`, `$HOME` or `/root`: `.bashrc`, `.bash_profile`,
  `.profile`, `.zshrc`, `.gitconfig`, `.netrc`, `.pypirc`, `.ssh/`, `.aws/`; and
  `/etc/profile`, `/etc/cron…`, `/etc/sudoers`, `/etc/ld.so…`, `/etc/passwd`,
  `/etc/shadow`, `/etc/environment`), by a redirect, `tee`, a file-write call,
  or `cp`, `mv`, `install` or `ln` whose last argument is the target.

The other rule ids are `build-hooks/runs` (code the build runs),
`build-hooks/source` (where code or packages come from) and
`build-hooks/truncated`.

Known false positives: a red flag is a pattern match in text, not a trace of
what runs. A line in a comment, a string, a documentation `echo` or a branch
that never executes can match; installers that deliberately add a line to
`~/.bashrc`, and the common `curl … | sh` in a makefile target the install
never runs, are reported.

Approximations and what it does not cover (each is also a note in the report):

- It does not detect obfuscation, such as `\x63url` or a command split across
  variables, and a download saved to a file and run later is not detected.
- Files that a hook invokes (for example the script a `postinstall` runs) and
  files that configuration points at are named, not read, unless the walk
  happened to read them; the red-flag search covers only files with a finding.
- `.npmrc`, `.yarnrc` and `setup.cfg` are read line by line for the keys named
  above; `pyproject.toml`, `hatch.toml` and `Cargo.toml` are read as TOML, so a file the
  TOML parser rejects is not analysed (a root one, or a root `.cargo` config, also makes the check
  `incomplete`; a nested one is only noted);
  continuation lines in `requirements.txt` are not joined.
- Python build-backend files are listed only when they were walked or a
  configuration names them.
- Build code of dependencies (a dependency's `build.rs`, install scripts of
  npm packages, `setup.py` of a dependency) is not listed. `corepack`, cmake
  `FetchContent`/`ExternalProject`, and the helper scripts of autotools
  (`config.guess`, `install-sh` and others) also fetch or run code that is not
  analysed.

How much of the repository is read. The clone container walks the checkout and
reads files of the kinds above within these limits: at most 200 files, 64 KB
of each (a larger one is cut), 2 MB in all, and 40 per file pattern. Files that
are only needed for their presence (`pnpm-lock.yaml`, `yarn.lock`) are not
counted. Root-only files are looked for at the root; other kinds are looked
for down to 8 path components deep. When any limit is hit, a name contains a line break,
a file of a kind the build system reads is a symbolic link (links are
never followed or read), a file of such a kind was cut, a root TOML file could
not be parsed, or the walk itself failed, the check has status **`incomplete`**
and its note says why: what was found is reported, and what was not read is
not covered. An `incomplete` check still counts for the policy, and the
absence of findings in it is not a clean result.

Pruned directories: the walk does not enter `.git`, `node_modules`, `target`,
`vendor`, `.venv`, `venv` or `__pycache__` at any depth, so a hostile file
inside one of them is not seen. Submodules are cloned and checked only when
`submodules: true` is given.

### What none of this protects against

- **A hostile agent.** The checks look at a project, not at the agent that
  uses it. Once a project is installed, `sandbox_exec` runs anything in its
  sandbox, including changing what a checked tool does.
- **Evasion.** Scanners and the built-in check find known patterns and known
  advisories; an author who knows them can write around them.
- **Dependencies' build code**, which this version does not list (above).
- **The network is contained only if you turn it on.** With `MCPE_NETWORK=open`
  (the default) nothing restricts where a build, a sandbox with its network on,
  the clone, or a scanner with `network: true` can connect: the internet,
  services on your host and your local network are reachable from each. With
  `MCPE_NETWORK=contained` they reach only the hosts described in
  [Network containment](#network-containment), which also lists
  [what containment does not stop](#what-containment-does-not-stop).
- **Discovery runs the built programs.** After the build, mcp-everything runs
  the project's executables with `--help` (and their subcommands) to generate
  tools; the check covers what the build runs, not that.
- **Image pulls** are done by the Docker daemon, not inside a container, from
  whatever registries the image names, so nothing here constrains them. That
  covers the clone image, the sandbox images and your scanners' images.
- **A scanner you configure is trusted code** that reads the repository's
  files, and a credential you give it is available to it.

Stronger isolation of the containers (including the clone and the scanners) is
available by setting `MCPE_DOCKER_RUNTIME` (for example `runsc`), which also
requires it (see [The isolation runtime](#the-isolation-runtime)); the server's
instructions name the runtime, or say that Docker's default is in use.

## Network containment

Containment is **off by default**. With `MCPE_NETWORK=open` (or nothing set)
networks behave as they always have, and the server's instructions tell the agent
that sandbox networks are not contained and that the operator turns containment
on with `MCPE_NETWORK=contained`. With it on, the instructions say what is
contained and how it is changed. The agent cannot turn containment on or off.

What it does not mean: a hostile agent is still out of scope (`sandbox_exec`
runs anything inside a sandbox; containment bounds where that code can connect),
and image pulls stay outside it. See [What containment does not stop](#what-containment-does-not-stop).

### Turning it on

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

### How it works

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

### What each stage reaches

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

### The default hosts

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

### A project's hosts

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

### Local access (`MCPE_LOCAL_ACCESS`)

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

### Scanners' hosts

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

### What reaches outside services

With scanning on, these reach outside services (and without containment, any
host): the clone container (the repository's forge); a scanner with `network:
true`; and the Docker daemon, which pulls the clone, sandbox, scanner and proxy
images from whatever registries the image names. Under containment the clone
reaches only the forge and a scanner only its `hosts`; the daemon's pulls are
not narrowed. A credential given to a scanner through `env` can be sent by
that scanner to any host it is allowed.

### When something is refused

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

### Upgrading, and switching from open to contained

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
- **Not contained by the pass** (see below): a sandbox from before ownership
  labels, and a labelled sandbox with no record. A sandbox created before
  `MCPE_DOCKER_RUNTIME` was named must be reinstalled
  ([The isolation runtime](#the-isolation-runtime)).

### What containment does not stop

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
- **Sandboxes from before ownership labels, and labelled sandboxes with no
  record, stay uncontained** under `contained`: the pass does not list the first
  and leaves the second as it is. A project of the first kind needs a
  reinstall to be contained.
- **Leftover proxies** of stopped sandboxes, and of an uninstall that crashed,
  are not removed yet (squawk 0052). A proxy keeps running when its sandbox's
  idle timeout stops the sandbox. A leftover proxy listens only on its own
  network, so the cost is memory and clutter, not a way in.
- **A refused package registry** makes a build fail only at its timeout (above).

## Security model

Installing a project means running its build scripts and its code. This server
confines that to Docker; it does not make untrusted code safe. With scanning
turned on, it also checks the repository's own build code before any of it
runs (see [Checking projects before they run](#checking-projects-before-they-run)),
which narrows what a careless install can do and does not close it: that
section says what the checks cannot see.

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
  reaches only what [Network containment](#network-containment) says, and that
  section lists [what containment does not stop](#what-containment-does-not-stop).
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

### The isolation runtime

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
  (see [Network containment](#network-containment)).
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
checked because Docker did not answer. It never fails because of that question,
but it can wait for the answer: when the daemon hangs, `project_info` can take
up to 30 seconds.
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
| `GITHUB_TOKEN` / `GH_TOKEN` | none | GitHub API token (search rate limit: 10/min anonymous). |
| `GITLAB_TOKEN` | none | GitLab API token. |
| `MCPE_EXTRA_HOSTS` | none | More forges to allow, e.g. `gitlab.gnome.org=gitlab,git.example.com=gitlab`. |
| `MCPE_DATA_DIR` | `$XDG_DATA_HOME/mcp-everything`, else `~/.local/share/mcp-everything` | Where the project registry and the `installation-id` file are stored. The default follows `XDG_DATA_HOME` when it is set. Copying the directory copies the id, and two installations with one id cannot be told apart; see [Several installations on one Docker daemon](#several-installations-on-one-docker-daemon). A registry written by a newer version of mcp-everything is refused and left untouched; upgrade, or move `registry.json` aside to start with an empty registry (the sandboxes of the projects in it stay in Docker). |
| `MCPE_DOCKER_BIN` | `docker` | The Docker client command, run on the host. |
| `MCPE_MEMORY` / `MCPE_CPUS` / `MCPE_PIDS_LIMIT` | `4g` / `2` / `1024` | Per-sandbox limits; a zero memory or CPU value (which Docker reads as unlimited) falls back to the default. |
| `MCPE_DOCKER_RUNTIME` | Docker's default | Container runtime, e.g. `runsc`. Naming one requires it: installs and checks refuse to start when Docker cannot run it. See [The isolation runtime](#the-isolation-runtime). |
| `MCPE_NETWORK` | `open` | `open` (networks as they always were) or `contained` (every network mcp-everything uses has no route out except through a proxy that allows named hosts). Anything else is refused at startup. See [Network containment](#network-containment). |
| `MCPE_LOCAL_ACCESS` | none | Local services a repository's sandbox may reach under `MCPE_NETWORK=contained`, as `<repository>=<host name>:<port>[,<host name>:<port>][;<repository>=...]`. Only the operator can set it. See [Local access](#local-access-mcpe_local_access). |
| `MCPE_PROXY_IMAGE` | `node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a` | Image the network proxies run in (needs `node`). The default is pinned by digest; pin your own the same way. |
| `MCPE_PROBE_IMAGE` | `alpine/git:2.54.1@sha256:29cff25811f790b9f72fc266bf8009a5a911714c0e03c31c47339c50909d9aef` | Image of the throwaway container that clones a repository, lists its manifests and build files before the build, and (with scanning on) copies the checked clone (needs `sh`, `git` and `cp`). The default is pinned by digest; pin your own the same way. |
| `MCPE_SCAN` | `off` | Check repositories before they build: `off`, `on` or `warn` (report, always build), or `block`. See [Checking projects before they run](#checking-projects-before-they-run). |
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
  [the built-in check](#the-built-in-check).
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
  - Under gVisor (`runsc`), register the runtime with **`--overlay2=none`**
    (`sudo runsc install -- --overlay2=none`, then restart Docker). gVisor's
    default root-filesystem overlay discards writes outside volumes when a
    container exits, and a sandbox's build output lives in the container's
    layer, so an idle-stopped sandbox would lose the tools it built. With
    `MCPE_DOCKER_RUNTIME=runsc` mcp-everything logs one warning at startup when
    Docker's registration of `runsc` lacks it; it does not refuse.
  - Under `MCPE_NETWORK=contained`, the project's proxy is not stopped with
    its sandbox; see [What containment does not stop](#what-containment-does-not-stop).
- Under `MCPE_NETWORK=contained`, every project network and every networked
  clone or scanner takes an address range from Docker's own pools, and a stopped
  sandbox's network keeps its range. When Docker has none left, the error names
  `default-address-pools` in the daemon's configuration; turning a project's
  network off releases its range. The pools can overlap your local network;
  they are Docker's, and mcp-everything does not choose ranges.
- The default hosts of build systems other than Go and npm have not been
  measured under containment; see [The default hosts](#the-default-hosts).

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
src/scan/        the checks that run before a build: built-in analysis, scanner
                runs, SARIF parsing, the policy
src/server.ts   MCP server: built-in tools and dispatch to generated tools
```

## License

[MIT](LICENSE)
