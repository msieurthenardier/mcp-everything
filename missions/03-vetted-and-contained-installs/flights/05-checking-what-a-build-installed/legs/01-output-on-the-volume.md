# Leg: output-on-the-volume

**Status**: completed
**Flight**: [Checking What a Build Installed](../flight.md)

## Objective
A new sandbox keeps its build output on its existing volume.
- `/opt/mcpe` is a symlink to `/workspace/.mcpe`, made afresh by every build attempt.
- Ruby gems go to `/opt/mcpe/gems`.

Every path the code uses stays the same, and sandboxes created before this leg are untouched.

## Context
- **Flight DD1:** output on the volume through a symlink, cleared per attempt; an image with its own `/opt/mcpe` is warned about and left alone.
- **DD2:** `GEM_HOME` on the volume; Go's and Cargo's caches are not moved.
- **DD3:** older sandboxes are not migrated.
- **The premise was verified at planning** (flight Open Questions): a Python venv with a pip console script, and Ruby gems from `bundle install` and `gem install`, work through the symlink.
- **Leg 2** depends on this one. Its build-stage scanner reads `/scan/.mcpe`.
- **What the Architect checked:** every recipe works through the link, and nothing writes `/opt/mcpe` before the recipe. Only these run before it:
  - `createContainer`;
  - containment;
  - `CLEAN_SCRIPT` on a retry (`src/install/installer.ts`, `buildAttempts`).
- **gVisor.** Under gVisor's default overlay, writes outside volumes are lost when a container exits (`docs/security-model.md`, "Register `runsc` with `--overlay2=none`"). The symlink is such a write, so `--overlay2=none` is still needed. The output itself now survives on the volume.

## Inputs
- `main` at `1034afb`, plus the flight's planning commit (`e2c1765`) on `flight/05-checking-what-a-build-installed`.
- `src/install/recipes.ts` `PRELUDE` begins `set -e` then `mkdir -p ${BIN_DIR} ${WORK_DIR}`.
- `src/sandbox/scripts.ts` defines `WORKSPACE`, `REPO_DIR`, `WORK_DIR`, `PREFIX`, `BIN_DIR` and `VENV_DIR`.
- In `src/sandbox/docker.ts`, `createContainer` builds the `path` and `env` passed with `-e`.

## Outputs
- **`src/sandbox/scripts.ts`:** new exported constants `OUTPUT_DIR = "/workspace/.mcpe"` and `GEM_DIR = "/opt/mcpe/gems"`, built from `WORKSPACE` and `PREFIX`.
- **`src/install/recipes.ts`:** the prelude's output step.
- **`src/sandbox/docker.ts`:** `GEM_HOME` and `${GEM_DIR}/bin` on `PATH` in `createContainer`.
- **Tests:** `test/docker.test.ts` (unit), and `test/integration/docker.test.ts` (Docker suite).
- **`docs/security-model.md`:** the gVisor passage updated.

## Acceptance Criteria
- [ ] **The prelude** (`recipeFor(e)` for every ecosystem) contains the output step after `set -e` and before `mkdir -p ${BIN_DIR}`. In order:
  1. `rm -rf /workspace/.mcpe` and `mkdir -p /workspace/.mcpe /opt`, always;
  2. then, if `/opt/mcpe` is a directory that is not a symlink, print a line starting `MCPE_WARN `, saying the image has its own `/opt/mcpe` and so the build output is not on the sandbox's volume, where the check after the build looks. Leave `/opt/mcpe` alone; the empty `/workspace/.mcpe` stays;
  3. otherwise `ln -sfn /workspace/.mcpe /opt/mcpe`.

  Paths come from the constants, never from the repository.
- [ ] **The clearing (step 1) runs even when `/opt/mcpe` is the image's own directory.** A retry on such an image must not leave the first attempt's output on the volume.
- [ ] **A new sandbox's container is created with:**
  - `-e GEM_HOME=/opt/mcpe/gems`;
  - a `PATH` of `/opt/mcpe/bin:/opt/mcpe/gems/bin:/opt/mcpe/venv/bin:/root/.cargo/bin:/usr/local/go/bin:<image PATH>`, in that order.
- [ ] **The step is rendered by one exported function** in `src/install/recipes.ts`, such as `outputStep({ output, prefix })`.
  - It derives the parent with `path.posix.dirname(prefix)`.
  - It single-quotes every path.
  - `PRELUDE` calls it with `OUTPUT_DIR` and `PREFIX`.
- [ ] **New unit tests** in `test/docker.test.ts`. No existing test pins the `PATH`, the environment or the prelude text: the review grepped for them.
  - Using the existing `runArgs` helper, the `-e` pairs give `GEM_HOME=/opt/mcpe/gems`, and `PATH` in the order above.
  - In the rendered `PRELUDE`, these appear in this order: `set -e` < `rm -rf` < `[ -d` < `ln -sfn` < `mkdir -p /opt/mcpe/bin`.
- [ ] **A real shell runs the renderer's output** with `sh -ec`, over paths under a fresh `os.tmpdir()` directory. The case goes in `test/docker-shell.test.ts` (the `slow` project). Each case first seeds `<output>/stale`:
  - (a) no prefix: the prefix becomes a symlink to the output directory, and `stale` is gone;
  - (b) the prefix is an existing symlink, dangling or to another directory: it is replaced, and `stale` is gone;
  - (c) the prefix is a regular file: it is replaced by the symlink (`ln -sfn`), and `stale` is gone;
  - (d) the prefix is a real directory: it is left as it is, with its contents; stdout has one line starting `MCPE_WARN `; the output directory exists, empty.
- [ ] **The Docker suite's first uncontained gron install** (`test/integration/docker.test.ts`, "installs a Go CLI, generates a typed tool and runs it offline") asserts, right after the first `install_project` and before the second, that:
  - `readlink /opt/mcpe` in the sandbox prints `/workspace/.mcpe`;
  - `/workspace/.mcpe/bin/gron` exists and is executable.
- [ ] **The contained gron install** ("installs tomnomnom/gron (Go): the sandbox is created on bridge, contained…") makes the same two assertions, and its existing `buildWarnings(log)` assertion stays empty: the prelude warns about nothing on `golang:1`.
- [ ] **The retry test** (`FailsFirstBuild` and "replaces the container, cleans the checkout and builds again"):
  - its debris line becomes `mkdir -p /workspace/.mcpe/bin && touch /workspace/.mcpe/bin/stale && chmod +x …`. The faked first attempt never runs the prelude, so the directory does not exist yet;
  - the existing assertion, that `ls /opt/mcpe/bin` shows only `gron`, still holds after the retry;
  - `readlink /opt/mcpe` after the retry is `/workspace/.mcpe`.

  This proves the per-attempt clearing.
- [ ] **`docs/security-model.md`'s `runsc` passage** says:
  - new sandboxes keep their build output on the volume;
  - the `/opt/mcpe` link itself, `/root/.cargo`, `/usr/local/go` and system packages are in the container's layer;
  - so `--overlay2=none` is still needed.
- [ ] **Checks:** `npm run typecheck`, `npm run build`, `npm test` and `npm run test:slow` pass. `npm run test:docker` passes, run by the Flight Director.

## Verification Steps
- **Prelude and environment:** `npx vitest run test/docker.test.ts test/docker-shell.test.ts`.
- **Everything else:** `npm run typecheck && npm run build && npm test && npm run test:slow`.
- **Docker suite:** run by the Flight Director, not the Developer, with object lists diffed before and after: `npm run test:docker` (timeout 1800 s).

## Implementation Guidance

1. **Constants.**
   - In `src/sandbox/scripts.ts`, add `OUTPUT_DIR` (`${WORKSPACE}/.mcpe`) and `GEM_DIR` (`${PREFIX}/gems`), with a one-line comment each.
   - DD1 in the flight says why the output is on the volume.

2. **Prelude.** In `src/install/recipes.ts`, add the step to `PRELUDE` between `set -e` and `mkdir -p ${BIN_DIR} ${WORK_DIR}`. A shape that satisfies the criteria:
   ```sh
   rm -rf ${OUTPUT_DIR}
   mkdir -p ${OUTPUT_DIR} /opt
   if [ -d ${PREFIX} ] && [ ! -L ${PREFIX} ]; then
     echo "MCPE_WARN the image has its own ${PREFIX}; the build output is not on the sandbox's volume"
   else
     ln -sfn ${OUTPUT_DIR} ${PREFIX}
   fi
   ```
   - The `warn` function is defined later in the prelude, so use `echo "MCPE_WARN …"` here, or move this step after `warn()`'s definition but before the `mkdir`. Either satisfies "before `mkdir -p ${BIN_DIR}`".
   - Keep `/opt` as the parent of `PREFIX`. Derive it, or state it as a literal with a comment that `PREFIX` is `/opt/mcpe`.
   - Update the recipe contract comment at the top of the file: executables are left in `/opt/mcpe/bin`, which is on the volume.

3. **Container environment.** In `createContainer` (`src/sandbox/docker.ts`):
   - add `GEM_HOME: GEM_DIR` to `env`;
   - insert `${GEM_DIR}/bin` into `path` after `BIN_DIR`.
   - Older sandboxes are unaffected: their environment was fixed when they were created.

4. **Real-shell test.** Use the renderer from the criteria. A string `replace` on `PRELUDE` does not work: `/opt` occurs inside `/opt/mcpe`. Run the renderer's output with `execFileSync("/bin/sh", ["-ec", step])` under a fresh `os.tmpdir()` directory, as the other cases in `test/docker-shell.test.ts` run real shells (the `slow` project, `vitest.config.ts`).

5. **Docker suite.** Add the assertions to the two gron installs and change the retry test's debris, as in the criteria.
   - Use `docker.exec(record.container, ["sh", "-c", "readlink /opt/mcpe; test -x /workspace/.mcpe/bin/gron && echo ok"], { timeoutSec: 30 })`, or the existing `run("docker", ["exec", …])` helper where the test already uses it.
   - The sandbox is offline at the end of these tests; `exec` starts it if stopped.

6. **Docs.** Edit only `docs/security-model.md`'s `runsc` passage (about lines 142–150). Leg 2 writes the build stage's docs.

7. **Flight log.** Add a leg entry under Leg Progress.

## Edge Cases
- **A retry on the fallback image:** step 1 clears the first attempt's output. `CLEAN_SCRIPT` runs before the recipe and cleans the checkout, `target` and `build`. Leave `CLEAN_SCRIPT` as is; the prelude owns `.mcpe`.
- **An image that already has a symlink at `/opt/mcpe`** (a retry in the same container never happens, but an operator's image might): `ln -sfn` replaces it.
- **An image whose `/opt/mcpe` is a real directory:** warned about and left alone. Its output is then in the layer, as before this leg.
- **`set -e`:** every command in the step must succeed on a normal image. `rm -rf` of a missing path, `mkdir -p` of an existing one and `ln -sfn` all do.
- **An idle-stopped sandbox restarted later** keeps the link, since it is in its container layer, except under gVisor without `--overlay2=none`, as the docs say.
- **The repository cannot influence the step:** it runs before `cd ${REPO_DIR}` reads anything, and interpolates only constants.

## Files Affected
- `src/sandbox/scripts.ts`: `OUTPUT_DIR`, `GEM_DIR`.
- `src/install/recipes.ts`: the prelude's output step, and possibly a small exported renderer.
- `src/sandbox/docker.ts`: `GEM_HOME`, and `PATH` in `createContainer`.
- `test/docker.test.ts`: the environment and prelude pins.
- `test/docker-shell.test.ts`: the real-shell cases.
- `test/integration/docker.test.ts`: the gron assertions and the retry debris.
- `docs/security-model.md`: the `runsc` passage.
- The flight log.

## Citation Audit
Checked 2026-11-25 against `e2c1765`:
- `PRELUDE` at `src/install/recipes.ts:14-34`;
- constants at `src/sandbox/scripts.ts:4-11`;
- `createContainer`'s `path` and `env` at `src/sandbox/docker.ts:393-411`;
- `CLEAN_SCRIPT` at `src/install/installer.ts:134`;
- `FailsFirstBuild` at `test/integration/docker.test.ts:504-546`, its debris line at `:508`;
- the uncontained gron test at `:231`, the contained one at `:2540`;
- the `createContainer` helpers (`runArgs`) at `test/docker.test.ts:355-398`. They pin flags, not the environment, so no existing test pins the `PATH` or the prelude;
- the `runsc` passage at `docs/security-model.md:142-150`.

---

## Post-Completion
Completion steps (status transitions, flight-log update, checking off in the parent flight, and commit) are Flight Control protocol, driven by the execution workflow. Not repeated here.
