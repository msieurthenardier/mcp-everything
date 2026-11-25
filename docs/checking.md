# Checking projects before they run

Part of mcp-everything's documentation; see the [README](../README.md).

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
2. The built-in checks and the operator's scanners run over that clone. Nothing
   from the repository is built or run by the checks. Scanners are the
   operator's own images and do read the repository's files. The
   `dependencies` check runs at the same time as the clone, and asks GitHub
   and OSV about the repository's dependencies (see
   [The dependency check](#the-dependency-check)).
3. The policy decides. Under `block`, findings at or above the threshold end
   the install: nothing is built and the result says why. Under `warn`,
   findings are reported and the build goes ahead.
4. If the build goes ahead, the checked staging volume is copied into the
   project's new volume and the build runs on that copy: the build runs on
   exactly the bytes that were checked, not on a second clone.
5. After a build that exited 0, and before the network policy is applied and
   tools are discovered, the operator's scanners that have `"stage": "build"`
   run over the sandbox's volume (see [Adding a scanner](#adding-a-scanner)).
   This step runs only when at least one scanner has that stage. The policy
   judges their findings on their own. Under `block`, findings at or above the
   threshold leave the project `failed` and offline with no tools, and
   `discover_tools`, `refresh_mcp`, `connect_mcp_server` and
   `disconnect_mcp_server` refuse it until it is reinstalled. Under `warn` the
   findings are reported and the install goes on. The report is stored with the
   project and shown after the source stage's under `after the build:`, in the
   install result and in `project_info`. It is a snapshot from install:
   `discover_tools`, `refresh_mcp` and `sandbox_exec` do not refresh it, only
   a reinstall does.

A **reinstall** (`reinstall: true`, or an install of a project that exists but
is not ready) is checked
before anything of it is touched: its sandbox, volume, record and tools stay
as they were until the check passes. A blocked reinstall changes one thing in
the existing record, a warning saying that a reinstall at that commit was
blocked on that (UTC) date. If the check cannot be made (for example the clone
fails), the existing project is left as it was. This holds for the check
before the build only: the check after the build cannot keep the previous
version, because the reinstall has replaced it by then. A reinstall blocked
there leaves the project `failed`, and the result and the record's error say
that the previous version was replaced before the build and is not restored. `install_project` on a
repository that is already installed and ready, without `reinstall`, returns
the existing project and checks nothing.

**`check_project`** clones and checks a repository at any time, whatever
`MCPE_SCAN` says, without installing it: nothing is built, no installed
project is changed, and the staging volume is removed afterwards. It runs the
built-in check and every configured scanner that runs at the source stage, and
says what an install would do under the current setting (blocked, built with
the findings reported, not blocked, or that scanning is off). Nothing is built,
so scanners with `"stage": "build"` are not run; when any are configured, the
result names them and says so.

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

## Turning it on

Set these in the environment of the mcp-everything process, as with every
other `MCPE_*` setting. They are read once, at startup, so a change needs a
reconnect. An invalid value is refused at startup.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCPE_SCAN` | `off` | `off`; `on` or `warn` (the same: check, report, always build); `block` (check, and do not build when the policy blocks). |
| `MCPE_SCAN_BLOCK_AT` | `error` | Under `MCPE_SCAN=block` only (setting it under any other value is refused at startup): the lowest level that blocks, `error`, `warning` or `note`. |
| `MCPE_SCAN_TIMEOUT` | `900` | Whole seconds, 60 to 3600: the overall time budget for all of one check's scanners, image pulls included. |
| `MCPE_SCANNERS` | none | Path to a JSON file of your own scanners (below). A regular file of at most 1,000,000 bytes. It may be set while scanning is `off`: `check_project` uses it. |

What blocks. The `build-hooks` check reports its red flags (below) at level
`warning` and everything else it lists at level `note`; it reports nothing
at `error`. The `dependencies` check (see [The dependency check](#the-dependency-check))
reports a known-malicious dependency at `error` and a known-vulnerable one at
`warning`. So with no scanner of your own, `MCPE_SCAN=block` with the default
`MCPE_SCAN_BLOCK_AT=error` blocks only on a known-malicious dependency of a
GitHub repository; the startup log and the server's instructions say so. The
`tool-descriptions` check (see [The tool-description check](#the-tool-description-check))
never blocks an install, whatever the level: under `block` it withholds tools.

**Blocking at `warning`** also blocks any GitHub repository with a
known-vulnerable dependency, which is common, as well as a project with a red
flag. **Blocking at `note`** blocks every project, because `build-hooks` always
has notes (even for a project with no lifecycle script) and notes count at
that level; it also blocks a repository whose dependency graph lists versions
that were not looked up (ranges) or has more advisories than were read.
Only checks that ran or came out incomplete count; a check that
failed or did not run is reported and never counts, so a scanner that fails
or times out never blocks an install, and neither does a dependency check
that GitHub or OSV could not answer.

## Adding a scanner

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
  [Scanners' hosts](containment.md#scanners-hosts). At most 16 scanners. Any other key is
  refused at startup.
- `stage` (optional) is `"source"` (the default) or `"build"`. A `"source"`
  scanner runs over the clone before the build, as described below. A
  `"build"` scanner runs after the build, over what the build produced (see
  the end of this list). Each entry runs at one stage, so a scanner wanted at
  both is listed twice, under two names.
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
  the scanner's own `hosts` (see [Scanners' hosts](containment.md#scanners-hosts)). Each scanner runs in its own container with a sandbox's
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
- **A `"build"` scanner** sees the sandbox's volume **read-only** at `/scan`,
  with working directory `/scan`, not the staging volume. The build's output
  is at `/scan/.mcpe` (the executables are in `/scan/.mcpe/bin`), Rust's and
  CMake's build trees are at `/scan/target` and `/scan/build`, the checkout is
  at `/scan/repo`, and the agent's scratch space is at `/scan/work`. Its
  network, `hosts`, `env`, redaction and SARIF output are as for any scanner.
  Build-stage scanners have their own `MCPE_SCAN_TIMEOUT` budget, separate
  from the source stage's, so an install can spend up to twice that on
  scanners.

## The built-in check

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

## The dependency check

The check named `dependencies` asks two outside services about a repository on
**github.com**: GitHub for its dependency graph, and OSV (`api.osv.dev`) for
which exact versions in it are known to be malicious or vulnerable. It is
reported first in the report, before `build-hooks`. It runs in mcp-everything's
own process, at the same time as the clone, so it does not go through the
sandbox's containment.

- **When it runs.** At a checked install (scanning `on`, `warn` or `block`), and
  in `check_project` **whatever `MCPE_SCAN` says**, including `off`: an install
  with scanning off sends nothing, but `check_project` is an explicit request
  to check, and it sends. Another forge gets `not-run` (it has no public
  dependency graph), and nothing is sent.
- **What it asks.** GitHub: the repository's owner and name, to read its
  dependency graph (`/dependency-graph/sbom`). OSV: the name and exact version of
  each package in the graph, in batches. Nothing from the clone is sent. The
  report says which services were contacted, and how many packages were sent.
- **Levels.** A package with a known-malicious advisory (an OSV `MAL-` id) is an
  `error` (rule `malicious-package`); one with other known advisories is a
  `warning` (rule `vulnerable-package`). One finding per package, with
  its advisory ids and, when OSV gives them, a summary and GitHub's severity
  label. Counts cover every affected package; at most 20 findings are shown.
- **Ranges are not looked up.** Without a lockfile on the default branch, GitHub's
  graph lists version ranges (`^1.2.0`), and a range is not a version. Packages
  without an exact version are counted in a note, the check is `incomplete`, and
  they are not sent to OSV. Workflow actions (`.github/workflows`) are not
  checked. At most 5000 packages are looked up.
- **A pinned `ref`.** The graph describes the default branch only. With a `ref`
  that is not the default branch, the check is `not-run` and says so; checking
  it costs one more GitHub call (to read the default branch's name), and nothing
  goes to OSV. Check without a `ref` to see the default branch's dependencies.
- **A clone that fails** after the lookup sent something still says what was
  sent, in the reason it reports.
- **Limits.** GitHub's unauthenticated limit is 60 requests an hour (a different
  limit from the one `search_projects` meets); `GITHUB_TOKEN` (or `GH_TOKEN`)
  raises it, and `search_projects` uses the same token. The token is sent
  to `api.github.com` only, never to OSV. A rate limit is a `failed` check, which
  never blocks. Each request has a 15-second limit and the check 60 seconds;
  nothing is followed through a redirect.

## The tool-description check

The check named `tool-descriptions` reads the text that the tools generated for
a project carry to the agent, and flags text that looks like an attempt to
steer the agent. It runs in mcp-everything's own process and does no I/O.

- **When it runs.** At the end of every discovery, while `MCPE_SCAN` is not
  `off`: after an install, `discover_tools`, `refresh_mcp`,
  `connect_mcp_server` and `disconnect_mcp_server`. `select_project_tools`
  does not run it and keeps what the last discovery recorded.
  `check_project` does not run it either: it installs nothing, so there are no
  generated tools to read.
- **What it reads.** Only text that came from the project, not
  mcp-everything's own wording. For a proxied MCP server's tool: the upstream
  tool's name and description, the server's name, and every string of its input
  schema (including property names). For a command-line tool: its help summary,
  usage, subcommand names, options (flags, descriptions, choices) and aliases.
  For the helper tools: the module, package, script and Makefile target names
  that went into them. It covers every tool in the catalog, published or not.
- **What it flags.**
  - `error`: hidden characters (Unicode tag characters and bidirectional
    overrides); text that tells the reader to ignore its instructions or to hide
    something from the user; text that names one of mcp-everything's own tools
    that change trust or reach (`install_project`, `set_project_hosts`,
    `sandbox_exec` and the like). A proxied server's own tool name is exempt
    from the last rule (a project that is itself an MCP server may own such a
    name); its description is not.
  - `warning`: invisible characters (isolates and zero-width characters; they
    occur in genuine right-to-left text, so only a warning, and a joiner inside
    an emoji is not flagged); directives aimed at the agent (`<important>`,
    "before using this tool", "you must first read"); and a credential or secret
    file (`~/.ssh`, `id_rsa`, `.env`, `mcp.json`, `api key`) in the same
    sentence as a sending verb (send, upload, attach, forward, transmit,
    exfiltrate, or post to a URL). A bare mention, as in `--env-file`, is
    ordinary help text and is not flagged.
- **What the agent is told.** Findings never quote the text they matched, and
  the property or tool names that carried it are not repeated: each finding
  names the generated tool, the rule, and a position in the tool's text.
  `project_info` shows a `tool descriptions:` line (the date, the mode the
  check ran under, the counts and the withheld tools); with `verbose` it lists
  the findings kept. A project installed before this check says `not
  checked` until its next discovery.
- **Under `warn`**, every tool is published and the findings are reported.
  **Under `block`**, a tool with a finding at or above `MCPE_SCAN_BLOCK_AT` is
  **withheld**: it is removed from the catalog, so it is not published, not found
  by `find_project_tools`, and a call to it answers that it was withheld. Its
  project's other tools stay usable, and the install is not blocked.
  `select_project_tools` cannot bring a withheld tool back. The next discovery
  recomputes everything: a project that fixes its text gets its tool back at
  the next `refresh_mcp`. The check failing never withholds anything.
- **Sessions with other settings.** Every session shares one registry, and each
  checks under its own setting. A discovery in a session with scanning `off` or
  `warn` republishes what a `block` session withheld (and an `off` one removes
  the record of the check).
- **A reading aid, not a guarantee.** Patterns can be evaded, and they can
  misfire on a security tool that documents prompt injection or on a project
  that is itself about mcp-everything's tools.

## What none of this protects against

- **A hostile agent.** The checks look at a project, not at the agent that
  uses it. Once a project is installed, `sandbox_exec` runs anything in its
  sandbox, including changing what a checked tool does.
- **Evasion.** Scanners and the built-in checks, tool-descriptions included, find
  known patterns and known advisories; an author who knows them can write around them.
- **Dependencies' build code**, which this version does not list (above).
- **What the dependency graph misses.** The graph is GitHub's reading of the
  default branch's manifests, development dependencies included; it misses what a
  build resolves by itself (a package manager that fetches without a lockfile,
  vendored code, anything a build script downloads), and a version OSV has no
  advisory for is not flagged.
- **The network is contained only if you turn it on.** With `MCPE_NETWORK=open`
  (the default) nothing restricts where a build, a sandbox with its network on,
  the clone, or a scanner with `network: true` can connect: the internet,
  services on your host and your local network are reachable from each. With
  `MCPE_NETWORK=contained` they reach only the hosts described in
  [Network containment](containment.md#network-containment), which also lists
  [what containment does not stop](containment.md#what-containment-does-not-stop).
- **Discovery runs the built programs.** After the build, mcp-everything runs
  the project's executables with `--help` (and their subcommands) to generate
  tools; the check covers what the build runs, not that.
- **Image pulls** are done by the Docker daemon, not inside a container, from
  whatever registries the image names, so nothing here constrains them. That
  covers the clone image, the sandbox images and your scanners' images.
- **A scanner you configure is trusted code** that reads the repository's
  files, and a credential you give it is available to it.
- **A process the build left running** can change files after the check after
  the build, and so can anything that runs later.
- **Building by hand, then `discover_tools`.** What the agent builds itself
  with `sandbox_exec` is not checked again; a project blocked after its build
  is refused by `discover_tools` until it is reinstalled, but one that was never
  blocked is not looked at again.
- **Go's module cache and Cargo's registry** are seen only through the binaries
  built from them.
- **An image with its own `/opt/mcpe`** keeps the build's output off the
  volume, so the check after the build does not see it.
- **Older sandboxes** are checked after the build only once reinstalled.
- **A block after the build on a reinstall** leaves no working sandbox: the
  previous version is gone.
- **The build network during the scan.** While build-stage scanners run, the
  sandbox is still on its build network (or its build allowlist under
  containment), so a process the build left running keeps that reach for up to
  `MCPE_SCAN_TIMEOUT`.
- **Files hidden by mode 000.** A scanner runs with all capabilities dropped,
  so a file the build made unreadable is hidden from it, and a scanner that
  fails for that reason never blocks.
- **Code installed outside the volume** is not seen: `npm install -g` of pnpm
  or yarn, and system packages from `apt-get` (the CMake and autotools
  recipes' needs).
- **Absolute symlinks that dangle.** Absolute symlinks under `/scan/.mcpe`
  (the executables `link_elves` makes, Ruby's executables, the venv's
  `python`) dangle inside the scanner. Their targets are on the volume under
  `/scan/repo` or `/scan/build`, or in the image.

**Upgrading.** Projects installed before the check after the build existed
keep working. Their build output was never checked. Once build-stage scanners
are configured, `project_info` says "build output not checked at install" for
them; reinstalling checks it.

Stronger isolation of the containers (including the clone and the scanners) is
available by setting `MCPE_DOCKER_RUNTIME` (for example `runsc`), which also
requires it (see [The isolation runtime](security-model.md#the-isolation-runtime)); the server's
instructions name the runtime, or say that Docker's default is in use.
