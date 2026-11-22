# Leg: build-hooks

**Status**: completed
**Flight**: [Checking a Project's Own Code Before It Runs](../flight.md)

## Objective
Add the built-in check's analysis: given the recipe a project will be built with and the build files read from its checkout, report the common places where that recipe runs the repository's own code, raise a fixed set of red-flag patterns in that code to warnings, and say plainly what the check cannot see — as a pure, unit-tested function that nothing calls yet.

## Context
- Flight DD5. Operator decision (2026-11-21): list what runs, plus a few red flags; nothing above `warning`.
- Split out of `scan-rules` (leg 2) at that leg's design review. Its own first design review (2026-11-22) found further mechanisms by which build tools run repository code. **Scope call by the Flight Director**: this check is a reading aid, not a model of every build tool. It reports the common entry points each recipe uses; a file that configuration points at (a `build = "x.rs"`, a hatch hook `path`, a gemspec's `extensions`) is reported by name as **not read**, not chased; and what it does not cover is stated in `notes`. The flight's acceptable variations allow this, provided the README (leg 7) lists what is checked.
- Leg 2 provides the types. This leg adds one field to leg 2's `BuildWalk` (below), agreed before leg 2 is implemented.
- Leg 4 (`clone-walk`) produces the `BuildWalk`, reading exactly the files `BUILD_FILE_PATTERNS` (this leg) names.
- Every path and every byte of content is repository-controlled and may reach the agent.

## Inputs
- Leg 2 landed: `src/scan/types.ts` (`Finding`, `CheckOutcome`, `BuildFile` with `truncated`, `BuildWalk`, `emptyCounts`); `oneLine` in `src/util/text.ts`.
- `src/install/recipes.ts`: `NODE` (pnpm on `pnpm-lock.yaml`, yarn on `yarn.lock`, else npm; then `$run build` when the root `package.json` has `scripts.build`); `PYTHON` (`pip install .` when `pyproject.toml`, `setup.py` or `setup.cfg` exists, falling back to `pip install -r requirements.txt` if that fails; `pip install -r requirements.txt` as the primary path when only it exists); `RUST` (`cargo build --release`); `GO` (`go install` of main packages; `make` in the root only when an install failed, `/opt/mcpe/bin` is empty and a root Makefile exists); `RUBY` (`bundle install` when `Gemfile` exists; `gem build` of the first root `*.gemspec`, then `gem install`); `CMAKE`; `AUTOTOOLS` (`autoreconf -fi` when `configure` is not executable, then `./configure`, `make`); `MAKE`. `PRELUDE` runs no repository code.

## Outputs
- `src/scan/types.ts` — `BuildWalk` gains `skippedLinks?: string[]` (paths of build files the walk skipped because they are symbolic links; the recipe would follow them, so the check cannot vouch for them).
- `src/scan/build-hooks.ts` — `analyzeBuildHooks(ecosystem: Ecosystem, walk: BuildWalk): CheckOutcome` and `BUILD_FILE_PATTERNS`.
- `test/scan-build-hooks.test.ts` — new.

## Acceptance Criteria

**Shape**
- [ ] `name: "build-hooks"`, `kind: "builtin"`. `status` is `incomplete` when `walk.incomplete` is set, when `walk.skippedLinks` names a file whose kind (by `fileKind`, below) this ecosystem's analysis reads, when such a file has `truncated: true`, or when such a root TOML file (`pyproject.toml`, `hatch.toml`, `Cargo.toml`, `.cargo/config*`) cannot be parsed (`smol-toml` may reject what the build tool accepts, and hooks could be hidden) — except the generated autotools files (`configure`, `Makefile.in`, `*.m4`, `ltmain.sh`, `config.guess`, `config.sub`), whose truncation is a note-level finding naming the file and how much was read, since a committed `configure` is routinely larger than the walk's per-file cap. Otherwise `ran`. Findings from what was read are reported either way; `notes` says what was incomplete and why.
- [ ] Findings at most 20, ordered by level then input order, with `omitted`; `counts` exact. Every message **and every location** (which carries a repository path) goes through `oneLine`: message 200, location 120, rule id 80.
- [ ] `notes` always includes: the ecosystem analysed; that the check is a heuristic reading aid, not a guarantee, and does not detect obfuscation (`\x63url`, a command split across variables); that dependencies' build code is not listed; that files a hook invokes, and files configuration points at, are not read; that after the build mcp-everything runs the project's executables for discovery (`--help`), so "before any of its code runs" covers the build. Plus the ecosystem-specific notes below.

**What each recipe runs** — `note` findings, `ruleId: "build-hooks/runs"`, location `path:line`. "Conditional" means the message says when it runs. "Not read" means the finding names a file the walk does not read.
- [ ] **node**
  - Root `package.json`: `preinstall`, `install`, `postinstall`, `prepublish`, `preprepare`, `prepare`, `postprepare`; and, when it has `build`: `prebuild`, `build`, `postbuild`. Messages for `pre*`/`post*` and `prepublish` say "if the package manager runs it".
  - Nested `package.json`: the install lifecycle scripts, conditional on being an installed workspace package.
  - `binding.gyp` beside a `package.json` with no `install`/`preinstall` script: conditional ("npm may run `node-gyp rebuild`").
  - Root `.pnpmfile.cjs` when `pnpm-lock.yaml` exists; root `.yarnrc.yml` setting `yarnPath` or `plugins`, and root `.yarnrc` setting `yarn-path`, when `yarn.lock` exists (the named file is reported not read); root `.npmrc` setting `script-shell`, `node-options`, `git` or `node-gyp`.
  - Root `.npmrc` `registry` or `@…:registry`: a finding saying it changes where packages come from.
  - `notes`: corepack and a `packageManager` field may fetch the package manager itself.
- [ ] **python**
  - Root `setup.py`, when the recipe's `pip install .` path applies. Nested `setup.py` not reported.
  - Root `pyproject.toml`: `build-backend` named in `notes`; `backend-path` (in-tree backend) a finding; any `custom` hook table under `[tool.hatch…]` (build, metadata, or target-scoped; in `pyproject.toml` or root `hatch.toml`) a finding naming its `path` or the default `hatch_build.py`; `[tool.hatch.version] source = "code"` a finding naming its `path`; `[tool.poetry.build] script` (or legacy `[tool.poetry] build`) and `[tool.pdm.build] setup-script` findings naming the script; a backend whose name starts with `maturin`, `mesonpy` or `scikit_build_core` makes `Cargo.toml`/`build.rs` (or `[tool.maturin] manifest-path`), `meson.build` (with `meson.options` / `meson_options.txt`), or `CMakeLists.txt` (or `cmake.source-dir`) findings; `setuptools-rust` in `build-system.requires` makes `Cargo.toml`/`build.rs` findings; a `build-system.requires` entry that is a URL or `@ file:` a finding.
  - `attr:` in `setup.cfg`, or `{ attr = … }` under `[tool.setuptools.dynamic]` in `pyproject.toml`: a finding saying setuptools "may import" the named module.
  - Root `requirements.txt`, worded as the primary path when only it exists and as the fallback when `pip install .` fails: lines with `-e`; a local path (`.`, `./…`, `../…`, `/…`, a bare `dir/`, `file:`, `name @ file:`); `-r`/`-c` (the included file not read); `--index-url`, `--extra-index-url`, `-i`, `--find-links`, `-f`, `--trusted-host` (change where packages come from).
  - `notes`: an external backend runs its own code and may run repository scripts it is configured to.
- [ ] **rust**
  - Each `build.rs` beside a `Cargo.toml` unless that manifest sets `build = false`, `autobuild = false`, or `build = "<another path>"` (then that path runs instead of `build.rs`, and is reported, not read unless it is a walked file); each crate with `proc-macro = true`. A virtual workspace manifest has no build script of its own; nested crates' build scripts are conditional on being built members. When a `Cargo.toml` cannot be parsed, a `build.rs` beside it is still reported, with a note.
  - Root `.cargo/config.toml` or `.cargo/config`: `build.rustc-wrapper`, `build.rustc-workspace-wrapper`, `build.rustc`, `build.rustdoc`, any `target.*.linker` or `target.*.ar`, `registry.credential-provider`, and `-C linker=` in `rustflags` are findings; `[source]` and `[patch]` are findings saying they change where code comes from. (`runner` is not reported: `cargo build` does not use it.)
- [ ] **go**: no finding for Go code; `notes` says `go install` runs nothing from the repository (cgo C sources are compiled, not run). The root Makefile that GNU make would pick (`GNUmakefile`, then `makefile`, then `Makefile`) is a conditional finding ("only if a `go install` fails and nothing was installed") and is scanned for red flags.
- [ ] **ruby**: root `Gemfile` (Ruby code evaluated by `bundle install`, including any `gemspec`, `eval_gemfile` or `plugin` it names); the first root `*.gemspec` in name order (others not reported); files named in that gemspec's `extensions` (not read unless walked); `extconf.rb` and `Rakefile` files, conditional on being named as extensions.
- [ ] **cmake**: root `CMakeLists.txt`; nested `CMakeLists.txt` and `*.cmake` conditional on being reached by `add_subdirectory` or `include`. `notes`: `FetchContent`/`ExternalProject` fetch outside code.
- [ ] **autotools**: when `configure` is present, both `configure` (conditional: "runs if executable") and `configure.ac`, `Makefile.am`, `*.m4` (conditional: "run through `autoreconf` if `configure` is not executable"); when it is absent, `configure.ac`, `Makefile.am`, `*.m4` unconditionally. Root `Makefile.in` and Makefile variants. `notes`: configure's helper scripts (`config.guess`, `config.sub`, `install-sh`, `missing`) and nested `configure` scripts run too and are not analysed.
- [ ] **make**: the root Makefile GNU make picks (`GNUmakefile`, then `makefile`, then `Makefile`); other root variants are not reported; nested Makefiles and `*.mk` conditional on being reached by recursion or `include`. `notes`: included files are not read unless walked.
- [ ] **generic**: no finding; `notes` says nothing is built.

**Red flags** — `warning` findings, at most **one per file and rule**, at the first matching line, searched in the whole of every file reported above, except `package.json`, where only the reported script strings are searched. The message counts further matching lines in the same file ("and 3 more lines"):
- [ ] `build-hooks/download-exec`: `curl` or `wget` feeding an interpreter that reads it **as its program**. Detected without a length limit or gap bound: a joined line is split into segments at `|`, `;`, `&&`, `||`, `$(`, `<(` and backticks; it matches when a segment contains a `curl`/`wget` word and the segment it feeds (the next one after `|`, or the command enclosing a `$(…)`/`<(…)`) is an interpreter. Interpreters: piped (`|`) into `sh`, `bash`, `zsh`, `dash`, `ash`, `ksh`, `busybox sh`, `/bin/sh`, `/bin/bash`, `python`, `python3`, `node`, `perl`, `ruby`, `php`, `deno` or `bun`, optionally through `sudo` (with flags) or `env` (with assignments) or a path prefix (`/usr/bin/env bash`); process substitution (`bash <(curl …)`, `source <(curl …)`, `. <(curl …)`); command substitution (`sh -c "$(curl …)"`, `eval "$(curl …)"`, and the `wget` forms). The interpreter counts only when it reads the download as its program: followed by end of segment, `-`, or option flags other than `-c`, `-e`, `-m` and a script or file argument; so `curl api | python3 -c 'import json…'`, `| node -e …` and `| python -m json.tool` do **not** match (negative tests). Lines ending in `\` are joined with the next. `notes` (always): a download saved to a file and run later is not detected.
- [ ] `build-hooks/decode-exec`: a decoder (`base64 -d`, `base64 --decode`, `atob(`, `Buffer.from(` with `'base64'`, `"base64"` or `'hex'`, `b64decode`, `fromhex`, `unhexlify`) and an executor (`eval`, `exec(`, `execSync`, `Function(`, `new Function`, `sh -c`, `| sh`, `| bash`, `child_process`) within 10 lines in the same file, or in the same script string; executor words matched as words. In Makefiles, `*.mk`, `configure` and `*.m4`, decoder and executor must be on the same line (bare `eval` and `$(eval …)` are everyday there). A test pins that `exec(open("version.py").read())` with no decoder near it does not match.
- [ ] `build-hooks/write-outside`: a write **directly to** a persistence target — a redirect (`>`, `>>`) or `tee` followed by the path after optional whitespace, with or without quotes around the path or its variable (`> "$HOME/.bashrc"`, `>"$HOME"/.bashrc`), or the path as the last argument of `cp`, `mv`, `install` or `ln`, or as the first argument of `writeFile`/`writeFileSync`/`appendFile` or `open(` with a `w`/`a` mode. Targets: in the home directory (`~/`, `$HOME/`, `${HOME}/`, `"$HOME"/`, `$(HOME)/`, `/root/`) the files `.bashrc`, `.bash_profile`, `.profile`, `.zshrc`, `.gitconfig`, `.netrc`, `.pypirc` and the directories `.ssh/`, `.aws/` (`.npmrc` is left out: build scripts write auth tokens there for ordinary reasons); and `/etc/` entries `profile*`, `cron*`, `sudoers*`, `passwd`, `shadow`, `ld.so*`, `environment`. Ordinary writes (`~/.cache`, `~/.cargo`, `/etc/os-release` read) do not match.
- [ ] **Linear and unbypassable by length**: no line-length cap and no windows (design review 2: windows miss a match longer than their overlap). download-exec uses the segment split above; decode-exec finds decoder and executor tokens per line by non-backtracking search and pairs them by line index; write-outside's patterns have only fixed, small gaps (optional whitespace and one quote). Tests: a payload at column 5000 of a long line, and `curl` followed by 300 characters of flags and URL before `| sh`, are both found; adversarial 1 MB lines of repeated `curl `, `base64 `, `$HOME/.`, `> /etc/` and a 100,000-line file alternating decoders and non-executors each finish under a generous bound (under 1 s, or a ratio against a small input).

**Parsing hostile files**
- [ ] `package.json`: BOM stripped; a parse error, a non-object, or a non-object `scripts` is a note on that file; non-string script values skipped; a truncated file that does not parse makes the outcome `incomplete`.
- [ ] TOML (`Cargo.toml`, `pyproject.toml`, `hatch.toml`, `.cargo/config*`) parsed with `smol-toml`, catching **every** exception including `RangeError` from deep nesting (tested for JSON and for each of the three TOML families); an unparseable root TOML file makes the outcome `incomplete` (Shape, above). `.npmrc`, `.yarnrc`, `.yarnrc.yml` and `setup.cfg` read line by line (no YAML or INI library), matching only the keys named above.
- [ ] A script's line is found by searching from the `"scripts"` key onward for its quoted key (line 1 if not found). Line numbers are right with `\r\n`.

**`BUILD_FILE_PATTERNS`**
- [ ] One exported table of file kinds, and from it a `fileKind(path)` helper and `BUILD_FILE_PATTERNS`, a structured list `{ kind: "name" | "glob" | "path"; pattern: string; rootOnly: boolean; ecosystems: Ecosystem[] }[]`; the `incomplete` rules and the tests use the same table, so they cannot drift apart. It covers every file the analysis reads: `package.json`, `binding.gyp`, `.pnpmfile.cjs`, `.yarnrc.yml`, `.yarnrc`, `.npmrc`; `setup.py`, `setup.cfg`, `pyproject.toml`, `hatch.toml`, `hatch_build.py`, `requirements.txt`, `meson.build`, `meson.options`, `meson_options.txt`; `Cargo.toml`, `build.rs`, `.cargo/config.toml`, `.cargo/config` (kind `path`); `CMakeLists.txt`, `*.cmake`; `configure`, `configure.ac`, `Makefile.am`, `Makefile.in`, `*.m4`; `Makefile`, `makefile`, `GNUmakefile`, `*.mk`; `Gemfile`, `*.gemspec`, `extconf.rb`, `Rakefile`. Each entry's `ecosystems` names the recipes it matters to (Python backends make `Cargo.toml`, `build.rs`, `meson.build` and `CMakeLists.txt` matter to `python` too).
- [ ] A test asserts, for a fixture of every file kind, that `fileKind` classifies it and that it appears in `BUILD_FILE_PATTERNS` for the ecosystems whose analysis reads it; and that every entry is expressible as a busybox `find -name` / `-path` test or a root `[ -f ]` check (no regex-only patterns).
- [ ] `PRUNE_DIRS` is exported (`.git`, `node_modules`, `target`, `vendor`, `.venv`, `venv`, `__pycache__`); leg 4 owns pruning the walk with it.

**General**
- [ ] Only `src/scan/build-hooks.ts`, its test, and the `skippedLinks` field in `src/scan/types.ts` change; nothing in `src/` calls the analysis yet.
- [ ] `npx vitest run` passes with legs 1–2's counts plus this leg's new cases; typecheck clean; build succeeds.

## Verification Steps
- `npx vitest run test/scan-build-hooks.test.ts`, then the whole suite; `npm run typecheck`; `npm run build`.
- Trials (each change made, the test file run, a failure confirmed, the change undone by editing; `git diff -- src` compared with a copy saved before): (1) report nested `setup.py`; (2) drop the `sudo` form from download-exec; (3) remove the word boundary on `eval`; (4) mark a truncated, unparseable `package.json` as `ran`; (5) stop searching a line after its first 4096 characters; (6) stop cleaning locations; (7) let `write-outside` match `~/.cache`; (8) make a truncated `configure` mark the outcome `incomplete`. Report each outcome.

## Implementation Guidance
1. One function per ecosystem returning raw items `{ rule, level, path, line, message }`; one helper turns them into bounded, cleaned findings and the outcome.
2. Shared helpers: line splitting (`\r\n`), continuation joining for red flags, the segment splitter, `fileKind`, `isRoot(path)` (no `/`), `scriptLine`, a GNU-make pick of the root Makefile.
3. Red-flag patterns as module-level constants with a comment each, every one with positive and negative tests, including benign look-alikes (`curl -o f.tgz url`; `base64` only encoding; `evaluate(`; `cat /etc/os-release`; `mkdir -p ~/.cache`; `$(eval X := 1)` in a Makefile).
4. Recipe claims as comments beside the code that makes them, naming the recipe constant in `src/install/recipes.ts`.

## Edge Cases
- "Root" means no `/` in the path.
- A `package.json` with 10,000 scripts or a 1 MB script string: linear matching and the 20-finding cap.
- Two root `*.gemspec`: only the first in name order.
- `configure`'s executable bit is not known to the analysis (the walk reads content); hence both conditional findings when it is present.
- A file named by configuration that the walk also happened to read (for example `build.rs`) is reported as read and red-flag scanned, not "not read".

## Files Affected
- `src/scan/types.ts` — `BuildWalk.skippedLinks`.
- `src/scan/build-hooks.ts` — new.
- `test/scan-build-hooks.test.ts` — new.

## Citation Audit
Checked by the Flight Director against `src/install/recipes.ts` on branch `flight/01-checks-before-code-runs`, and by this leg's first design review (2026-11-22), which confirmed: `NODE` lockfile choice and `$run build` (`recipes.ts:53–72`); `PYTHON` paths (`:36–51`; `requirements.txt` primary at `:48–49`, fallback at `:40–47`); `RUST` (`:75–77`, copies only after the build); `GO`'s `make` condition (`:96`); `RUBY` (`:104–107`); `AUTOTOOLS` (`:127–131`); `PRELUDE` runs no repository code (`:14–34`). Tool behaviors outside this repository (pnpm, yarn, npm config keys; Cargo config keys; Python backends; hatch, poetry, pdm hooks; setuptools `attr:`) are from that review, which marked `.npmrc` `node-options` and `binding.gyp` for the root package as less certain; both are worded conditionally here, and `onload-script` was dropped. Design review 2 (2026-11-22) re-checked the recipe claims the rewrite touched (PYTHON, GO, RUBY, AUTOTOOLS): accurate.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
