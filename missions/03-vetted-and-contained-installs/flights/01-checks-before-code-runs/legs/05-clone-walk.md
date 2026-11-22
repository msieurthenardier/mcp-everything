# Leg: clone-walk

**Status**: completed
**Flight**: [Checking a Project's Own Code Before It Runs](../flight.md)

## Objective
Have the clone also read the repository's build files that `BUILD_FILE_PATTERNS` (leg 3) names, within fixed budgets, marking anything it could not read, and return them as `ProbeData.walk` — so the built-in check never mistakes a partial read for a clean one.

## Context
- Flight DD5 (the walk) and design reviews 1–2 of the flight. Split from the first draft of this leg at its design review (2026-11-22), which ran busybox 1.37 (alpine) checks and found: the newline test missed directory names; one `find` cannot count per pattern; `-type f` cannot see links; `head -c` cannot tell truncation; `-maxdepth` is a silent gap; the clone's `"$@"` loop would iterate the walk's arguments; and `set -eu` does not see a failing `find` inside a pipeline. Each is answered below.
- Leg 4 has made the clone a one-shot owned container with a 16 MB stdout cap. Leg 3 provides `BUILD_FILE_PATTERNS` (`{ kind: "name" | "glob" | "path"; pattern; rootOnly; ecosystems }`), `PRUNE_DIRS` and `fileKind`. Leg 2 provides `BuildWalk { files; incomplete?; skippedLinks? }` and `BuildFile { path; content; truncated? }`.
- The walk reads the union of all patterns: detection runs after the clone, from its output, so the ecosystem is not known yet.
- Budgets: at most 200 files, 64 KB per file, 2 MB in total (counting each file's bytes as read, so a truncated file counts 64 KB), at most 40 files per pattern.

## Inputs
- Legs 2–4 landed.
- `src/sandbox/docker.ts`: `PROBE_SCRIPT` (`set -eu`; `url="$1"; ref="$2"; submodules="$3"; shift 3`; clone; `HEAD`, `ENTRY` lines; then `for f in "$@"` printing `FILE` lines for the manifests), `parseProbeOutput`, `ProbeData`, `probe`.
- `ProbeData` literals in `test/detect.test.ts` and `test/toolchain.test.ts` (and any others found).

## Outputs
- `src/sandbox/docker.ts` — the walk fragment, the argument split, `ProbeData.walk`, the parser branches, and an exported function generating the walk's arguments from `BUILD_FILE_PATTERNS`.
- Tests: unit cases in `test/docker.test.ts`; `walk` defaults where `ProbeData` literals exist; one integration case.

## Acceptance Criteria

**Arguments**
- [ ] The clone script's arguments become: url, ref, submodules, the manifests, a separator argument (`--walk--`), then the walk's arguments as **quadruples** `kind pattern rootOnly presenceOnly` (`kind` one of `name`, `glob`, `path`; the flags `1` or `0`). The manifest loop consumes arguments only up to the separator (printing `FILE` lines as today) and shifts past it; the walk fragment then reads them with `shift 4`. The walk's arguments are data: `find` expressions are built from them with `set --` and quoted `"$@"`, never with `eval`, never interpolated into the script text, and never left unquoted where a glob would expand.
- [ ] An exported function builds the walk's arguments from `BUILD_FILE_PATTERNS`; a unit test pins its exact output, including a `path` entry and a root-only `path` entry (`.cargo/config.toml`, which goes through `[ -f ]`, not `find`), and asserts no pattern contains a shell-special character other than the glob `*`. `PRUNE_DIRS` is passed the same way (a fixed count first, then the names) or embedded as a constant list; the Developer chooses and says which.

**The walk** (a separate shell constant appended to the clone script, so it can also be run alone for test)
- [ ] **Presence-only entries**: `pnpm-lock.yaml` and `yarn.lock` (root-only `node` entries leg 3 added, since the recipe's package manager depends on them) are read for presence only: the table entry gains `presenceOnly: true` (a field added to leg 3's table in `src/scan/build-hooks.ts`; nothing else there changes), the walk passes it as a fourth element of the entry's arguments, and prints `BUILD <path> 0 ` with empty content; such entries count toward no budget and are never truncated. A test shows a 5 MB `pnpm-lock.yaml` neither truncates nor uses the byte budget.
- [ ] **Root-only entries** are read with `[ -L ./<name> ]` (a link → `LINK`) then `[ -f ./<name> ]`, and are excluded from the `find` runs, so no root file is read twice.
- [ ] **Other entries**: one `find .` per pattern, pruning `.git` and every `PRUNE_DIRS` name, `-maxdepth 8`, matching `\( -type f -o -type l \)` and the entry's `-name` or `-path` test. Each pattern's output is sorted and cut at 41 lines; 41 lines means the pattern hit its cap of 40: print `INCOMPLETE pattern` and drop the extra. The union is de-duplicated (`sort -u`) before reading.
- [ ] **Read order**: root-only entries first, then root-level matches of the other patterns, then the rest in sorted order — so a deep tree cannot exhaust the budgets before the root files are read. A test shows the root `package.json` is read when nested files exceed the file budget.
- [ ] **Links**: a path that is a link (`[ -L ]`, checked before `[ -f ]`) is not read; it is printed as `LINK <base64 path>`.
- [ ] **Newlines**: before the per-pattern runs, one `find .` over the whole tree (same pruning) with `-path "$(printf '*\n*')"` prints `INCOMPLETE newline` if anything matches (this catches a directory name with a newline, which `-name` does not). In the read loop (`while IFS= read -r line`), the `#WALKFAIL` marker is checked first; then any line not starting with `./` is treated as a newline case and skipped.
- [ ] **Depth**: a `find . -mindepth 9` (same pruning) that matches any of the patterns prints `INCOMPLETE depth`, so files below the depth limit are never silently missing.
- [ ] **Truncation**: a file larger than 64 KB (`wc -c` greater than 65536) is read with `head -c 65536` and printed with flag `1`; others with flag `0`.
- [ ] **Budgets** enforced in the read loop (its counters live in that loop's subshell, so the loop prints the marker): 200 files → `INCOMPLETE files`; 2 MB → `INCOMPLETE bytes`; reading stops there.
- [ ] **Output**: `BUILD <base64 path> <0|1> <base64 content>`, paths relative to the checkout without `./`; an empty file gives an empty fourth part.
- [ ] **Failures**: each `find` runs as `{ find … || echo '#WALKFAIL'; }`, and the loop turns that marker into `INCOMPLETE walk`; nothing in the walk can make the script exit non-zero once the clone has succeeded (a test shows that a `head` closing a pipe early still leaves exit 0).

**Parsing**
- [ ] `parseProbeOutput` gains exact branches: `BUILD` with exactly four space-separated parts (no trimming; an empty fourth part is valid), `LINK` with two, `INCOMPLETE` with two and a reason from the fixed set (`pattern`, `newline`, `depth`, `files`, `bytes`, `walk`). Other lines are ignored. `FILE` and `files` are unchanged.
- [ ] `ProbeData.walk: BuildWalk` is always present: `files` (content decoded as UTF-8, `truncated` from the flag), `skippedLinks`, `incomplete` from the first reason seen, and `incomplete: "output"` when `run()` reports the stdout truncated, in which case the last line (possibly a partial `BUILD` line) is dropped.
- [ ] Every `ProbeData` literal in tests gains an empty `walk`.

**Tests**
- [ ] Unit: the argument generator; the parser for each new line, malformed lines, an empty file, truncated output; `probe` passing the separator and walk arguments after the manifests.
- [ ] Integration (suite prefix; gated on its first run, as in leg 4): the walk fragment run alone in the pinned clone image (leg 4's pin), with `--network none`, over a fixture volume the case builds with a plain `docker run --rm --network none` of the pinned `alpine` writing files under `/workspace/repo` (the walk works from there), the walk run with `--entrypoint sh` (the image's entrypoint is `git`); the volume is suite-prefixed and removed through `removeVolumeChecked`. The fixture holds: a root and a nested `package.json`; one inside `node_modules` (pruned); a link named `setup.py`; a 70 KB `configure`; a directory whose name contains a newline, holding a `package.json`; a `Makefile` nine levels deep; 41 `*.cmake` files. Asserted: the nested `package.json` read, the pruned one absent, `LINK setup.py`, `configure` truncated, and `INCOMPLETE newline`, `INCOMPLETE depth` and `INCOMPLETE pattern` reported (the parser keeps the first; the case checks the raw lines).
- [ ] A clone of `tomnomnom/gron` (leg 4's case, extended) returns a `walk` without `incomplete`; its raw stdout has each `FILE` name at most once and no `FILE` line for a name outside `MANIFESTS` (this is what observes the separator split), and is well under 16 MB.
- [ ] `npx vitest run` passes; typecheck clean; build succeeds; after the gate, the Docker suite passes and the operator's containers and volumes are unchanged.

## Verification Steps
- `npx vitest run`; `npm run typecheck`; `npm run build`; gate; `npm run test:docker` saved whole.
- Trials (exact edits, undone by editing, compared after each undo): (1) use `-name` instead of `-path` in the newline check; (2) drop the separator split (manifest loop over all arguments) — observed only by the gron case's raw-stdout assertion, so run that case for this trial after the gate; (3) use `-type f` only; (4) let the parser trim lines; (5) read in plain sorted order (root files not first). Report each outcome.

## Implementation Guidance
1. Write the walk fragment and run it by hand in the pinned image over a scratch fixture before wiring it in; keep what you ran.
2. Then the argument split, the generator, the parser and `ProbeData.walk`.
3. Then the tests; stop at the gate.

## Edge Cases
- A pattern with no matches: no output, no marker.
- `sort -u` across patterns: a file matching two patterns is read once.
- A link that points outside the checkout: never followed (`[ -L ]` first).
- A repository whose clone fails: the walk does not run (the script has already exited non-zero).

## Files Affected
- `src/sandbox/docker.ts`; `test/docker.test.ts`; `test/detect.test.ts`; `test/toolchain.test.ts` (literals only); `test/integration/docker.test.ts`.

## Citation Audit
Checked by the Flight Director on branch `flight/01-checks-before-code-runs`: `PROBE_SCRIPT`'s `shift 3` and `for f in "$@"` manifest loop; `parseProbeOutput`'s `FILE` branch requiring three parts and a name in `MANIFESTS`. The first draft's design review (2026-11-22) verified in busybox 1.37 (alpine): `find -maxdepth`, `-mindepth`, `-prune`, `-path` (with `*` crossing `/`) and `head -c` work; `-name` with a newline pattern misses a directory name containing a newline, `-path` catches it; `ProbeData` literals exist in `test/detect.test.ts:5` and `test/toolchain.test.ts:5`.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
