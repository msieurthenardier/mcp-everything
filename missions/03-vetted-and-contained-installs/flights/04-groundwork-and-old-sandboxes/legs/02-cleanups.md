# Leg: cleanups

**Status**: completed
**Flight**: [Groundwork, and Leaving Old Sandboxes Alone](../flight.md)

## Objective
Make the small changes the split will carry, before it, so that leg 3's move stays a pure move:
- squawks 0054, 0055 and 0056;
- one accessor for withheld tools in `src/server.ts`;
- the in-process outbound note in `src/network/containment.ts`;
- the slow unit tests out of the default run;
- the tests that read `docker.ts` and `containment.ts` as text made to read a list of files.

## Context
- Flight DD3, including the Architect review's additions. Low risk: no runtime behavior changes. One fallback that was switched off is deleted, and output must stay byte-identical.
- Leg 1 (`docs-split`) changes `README.md`, `docs/`, `package.json` `files` and `test/readme.test.ts`. This leg edits `package.json` `scripts` too; leave leg 1's `files` change alone.
- Baseline at `5a5f3fa`: 2988 passed, 71 skipped (`npx vitest run`), plus leg 1's new tests.

## Inputs
- **Squawk 0054** (`squawks/0054-whilestopped-stop-failure-untested.md`): `Docker.whileStopped` (`src/sandbox/docker.ts` ≈1698, "if (stopped.code !== 0 && !this.isNotThere(stopped)) { throw new Error(`Failed to stop sandbox …") has no test for a failed stop.
- **Squawk 0055** (`squawks/0055-remove-dormant-restart-after-swap.md`), all in `src/network/containment.ts`:
  - `RESTART_AFTER_SWAP` (≈137) and `restartAfterSwap` (≈143);
  - `restartForSwap` (≈763), called once in the replacement path (≈745, `await this.restartForSwap(s);`);
  - `restartAfterRestore` (≈779) and `Docker.restartSandbox` (`docker.ts` ≈1713) **stay**, for the T18 rollback;
  - tests in `test/containment.test.ts`: the imports (≈23–24), the "switch is off" test (≈1487), and `describe("restartAfterSwap, the named fallback (leg 14)")` (≈1774);
  - the doc comments of `restartSandbox` (`docker.ts` ≈1709–1712) and its table entry in `test/docker-bypass.test.ts` (≈133–135) both describe the fallback.
- **Squawk 0056** (`squawks/0056-bypass-test-shared-line.md`): `test/docker-bypass.test.ts:282` holds two `expect` statements on one line.
- **Withheld tools in `src/server.ts`.** These places read `ProjectRecord.toolCheck`'s `withheld`, `withheldNames`, `withheldOmitted` or `allWithheldServers`:
  - `findGenerated` (≈817–821);
  - `toolCheckLines` (≈1015–1028), used by `describe`;
  - `find_project_tools` (≈1501–1515);
  - `discover_tools` (≈1612);
  - `connect_mcp_server` (≈1644–1647);
  - `refresh_mcp` (≈1666–1676).

  Types are in `src/types.ts` (≈164–187).
- **Slow tests:**
  - `test/proxy-server.test.ts` (real sockets, ≈17 s);
  - `test/docker.test.ts` `describe("the walk script, in a local shell")` (≈1723) and `describe("the whole probe script, in a local shell")` (≈1925). These describes are self-contained: they use `WALK_SCRIPT`, `PROBE_SCRIPT`, `MANIFESTS`, `WALK_SEPARATOR`, `walkArguments` and `parseProbeOutput`, and local `put`, `walkOf` and `withDir`, but no `ScriptedDocker`. Measured 2026-11-23: these 16 cases take ≈13 s of the file's ≈16 s.
  - There is no vitest config file. Vitest is 5.1.0.
  - `package.json` `"test": "vitest run"`, `"test:docker": "MCPE_DOCKER_TESTS=1 vitest run test/integration"`.
  - CI (`.github/workflows/ci.yml`, "Unit tests") runs `npm test -- --reporter=default --reporter=json --outputFile.json=…`, then a passed-test floor of 867.
  - `docker-gvisor.yml` runs `npx vitest run test/integration …`.
  - `tsconfig.json` `"include": ["src", "test"]`.
- **Source-text readers of the files leg 3 splits:**
  - `test/docker-bypass.test.ts`: `DOCKER_TS` (≈15), `dockerClass()` (≈169), `members()`, `memberNames()`, `sites()`, `callers()` (≈281), and `Object.getOwnPropertyNames(Docker.prototype)` (≈250);
  - `test/docker.test.ts` ≈2410 (`role: "runtime-check"` count, the `checkRuntime` slice), ≈2901 (`export type OneShotRole`), ≈5569–5586 (`--alias`, `network connect` shapes, `mcpe-proxy` in `docker.ts` and `containment.ts`).

## Outputs
- `src/sandbox/docker.ts`: `restartSandbox`'s comment updated. Nothing else changes.
- `src/network/containment.ts`: the fallback removed, and the outbound note added.
- `src/server.ts`: the accessor.
- `test/containment.test.ts`, `test/docker.test.ts`, `test/docker-bypass.test.ts`; a new `test/docker-shell.test.ts`; a new shared test module for source lists (e.g. `test/sources.ts`).
- `vitest.config.ts` (new), `package.json` `scripts`, `tsconfig.json` `include`, `.github/workflows/ci.yml`.
- `squawks/0054`, `0055`, `0056`: status `in-progress`, with Corrective Action and Verification filled in. The Flight Director completes them at the flight's commit.

## Acceptance Criteria
- [ ] **0054.** A new unit test in `test/docker.test.ts` drives `whileStopped` through a public method, for example `setNetwork` on a running sandbox under a non-runc runtime, or `restartSandbox`. In the test, `docker stop` fails with a non-zero code and stderr that is not "No such container". The test asserts:
  - the call rejects with `/Failed to stop sandbox/`;
  - no `network connect`, `network disconnect` or `start` was issued after the stop.

  Mutation: replacing that `throw` with nothing makes the test fail (Verification 3).
- [ ] **0055.**
  - `RESTART_AFTER_SWAP`, `restartAfterSwap` and `restartForSwap` are gone from `src/`, along with the call at ≈745.
  - `restartAfterRestore`, `ContainmentDocker.restartSandbox` and `Docker.restartSandbox` remain. Their comments no longer mention the fallback; `restartSandbox` is described as the T18 rollback's restart.
  - In `test/containment.test.ts`, the `describe("restartAfterSwap, …")` block and the imports are removed.
  - The test at ≈1487 keeps its behavioral assertion (a replacement of a running sandbox's proxy restarts nothing) and drops `expect(RESTART_AFTER_SWAP)`. It is renamed to say what it now pins, e.g. "a replacement of a running sandbox's proxy restarts nothing".
  - The bypass table entry for `restartSandbox` is reworded.
  - `grep -rn "RESTART_AFTER_SWAP\|restartAfterSwap\|restartForSwap" src test` returns nothing.
- [ ] **0056.** The two statements at `test/docker-bypass.test.ts:282` are on separate lines, and their content is unchanged.
- [ ] **Withheld-tool accessor.**
  - One private method in `src/server.ts` (e.g. `withheldOf(p: ProjectRecord)`) returns a read-only view of what was withheld: the names, the entry for a name, the count, the count on one server, whether the list was cut (`withheldOmitted`), and the set of servers with every tool withheld.
  - Every place listed in Inputs uses it.
  - After the change, `grep -n "withheldNames\|withheldOmitted\|allWithheldServers\|\.withheld\b" src/server.ts` matches only inside the accessor.
  - Every tool result and error text is byte-identical. The existing `test/server.test.ts` and tool-check tests pass unchanged.
  - The accessor's doc comment states the contract: a withheld tool is absent from the tool list, `find_project_tools`, and `call_project_tool` (which answers "withheld"), and `project_info` names it. A withheld tool is not in the stored catalog, so `select_project_tools` cannot offer it. Confirm this by reading the code, and say so in the comment only if it is true. Any new place that lists tools reads it through this accessor.
- [ ] **The outbound note.** The module comment of `src/network/containment.ts` gains a short paragraph. It says:
  - the dependency lookup (`src/scan/dependencies.ts`) is mcp-everything's own outbound traffic (GitHub's API and OSV), not a container's, and does not go through the proxy;
  - a new stage that calls an outside service follows its pattern: inert unless injected in `src/index.ts`, `contacted` recorded on the outcome, and a sent-statement rendered.

  Comment only.
- [ ] **Slow tests out of the default run.**
  - **`vitest.config.ts`** defines two `projects`:
    - `default`: every `test/**/*.test.ts` except `test/proxy-server.test.ts` and `test/docker-shell.test.ts`. It still includes `test/integration/**`, which stays gated by `MCPE_DOCKER_TESTS`.
    - `slow`: exactly those two files.
  - **The two shell describes** move unchanged, apart from imports, from `test/docker.test.ts` into `test/docker-shell.test.ts`.
  - **`package.json`:**
    - `"test": "vitest run --project default"`;
    - new `"test:slow": "vitest run --project slow"`;
    - `test:docker` and `test:docker:pressure` still run their integration files (check that a path filter with projects still selects them).
  - **`tsconfig.json`** `include` adds `vitest.config.ts`.
  - **CI** (`ci.yml`, "Unit tests") runs both projects in one invocation (`npx vitest run --reporter=default --reporter=json --outputFile.json=…`), so the passed-test floor counts all of them.
  - **Results:**
    - `npm test` is faster than the baseline, with time recorded;
    - `npm run test:slow` passes;
    - a bare `npx vitest run` gives the same passed and skipped totals as before this leg, apart from 0054's and 0055's stated deltas;
    - no test is deleted or weakened, other than 0055's.
- [ ] **Source-text readers made file-list aware.**
  - A shared test module exports the source lists, e.g. `DOCKER_SOURCES = ["src/sandbox/docker.ts"]` and `CONTAINMENT_SOURCES = ["src/network/containment.ts"]`, with a reader that concatenates them.
  - `test/docker-bypass.test.ts` collects class members from every class in a list of `{ file, className }` entries; today the list holds only `{ docker.ts, Docker }`. `sites()` and `callers()` work over all of them.
  - The prototype check collects own names along `Docker`'s prototype chain up to `Object.prototype`, so it stays true after leg 3's chain.
  - `test/docker.test.ts` ≈2410, ≈2901 and ≈5569–5586 read through the shared reader.
  - Every assertion is unchanged in meaning and passes. With one file per list, the behavior is the same as today.
- [ ] **Checks.** `npm run typecheck` is clean, `npm run build` succeeds, and these pass:
  - `npm test`;
  - `npm run test:slow`;
  - `npx vitest run` (both projects).
- [ ] **Squawks.** Squawks 0054, 0055 and 0056 are set to `in-progress`, with Corrective Action and Verification filled in.

## Verification Steps
1. `npx vitest run` before and after, totals recorded. Explain the delta: 0054's new test minus 0055's removed tests.
2. `time npm test` and `time npm run test:slow`, recorded in the flight log next to the baseline (≈18 s).
3. **0054 mutation.**
   - Note `git diff --stat`.
   - Replace the `throw` in `whileStopped` with nothing, by editing.
   - Run the new test and see it fail.
   - Restore by editing, and check `git diff --stat` is as noted.
4. **Accessor mutation.** Make the accessor return an empty name list, run `npx vitest run test/server.test.ts` and see failures, then restore. Do the same for the bypass test: add a dummy method to `Docker`, see the bypass test fail, then restore.
5. The `grep` commands in the criteria, with their output.
6. **Shell describes.** `git diff test/docker.test.ts` shows the two describes removed. A diff of their old text (`git show 5a5f3fa:test/docker.test.ts`, the line ranges) against `test/docker-shell.test.ts` differs only in imports.

## Implementation Guidance
1. Squawks 0056, then 0055, then 0054, then the outbound note.
2. The accessor: introduce it, move each place over one at a time, and run `npx vitest run test/server.test.ts` after each.
3. The source lists: add the shared module, then convert the readers. Check that the bypass test still finds every method and the same `callers` lists.
4. The slow-test split:
   - create `test/docker-shell.test.ts` from the two describes (copy, don't retype);
   - remove them from `test/docker.test.ts`;
   - add `vitest.config.ts`;
   - update the scripts, `tsconfig.json` and `ci.yml`;
   - check `npm run test:docker -- --help`-free behavior by listing: `MCPE_DOCKER_TESTS= npx vitest list test/integration` should list the integration files under `default` (they are skipped without the variable).
5. Update the three squawk artifacts and the flight log.

## Edge Cases
- **Vitest 5 `projects`.** Use the inline `test.projects` form, each with a `name` and an `include` or `exclude`. The default project's `exclude` must keep vitest's default excludes, such as `node_modules`; spread `configDefaults.exclude`. If `--project` does not combine with a file filter as expected, record what does work, and make `test:docker` select its files correctly.
- **Shared setup.** If `test/proxy-server.test.ts` or the shell file relies on any global setup, keep it working in the `slow` project.
- **Integration files.** These must stay in a project, or `npm run test:docker` would find no files.
- **The CI floor (867)** stays. The count it sees does not drop, because both projects run.
- **Bypass test, after leg 3.** With several classes, a method name defined in two classes of the chain (an override) would appear twice. The member collection dedupes by name, as `memberNames` already does with a `Set`. Today there are none; leg 3 must not add any.
- **`restartForSwap` was called inside the replacement's `try`.** Removing the call changes nothing when the switch is off (it returned at once). The rollback path still calls `restartAfterRestore`.
- **Accessor and `findGenerated`.** The lookup searches all candidate projects, not only the owner (`a` and `a__b`). Keep that.

## Files Affected
- `src/server.ts`, `src/network/containment.ts`, `src/sandbox/docker.ts` (one comment)
- `test/containment.test.ts`, `test/docker.test.ts`, `test/docker-bypass.test.ts`, `test/docker-shell.test.ts` (new), `test/sources.ts` (new; any name)
- `vitest.config.ts` (new), `package.json`, `tsconfig.json`, `.github/workflows/ci.yml`
- `squawks/0054-…`, `0055-…`, `0056-…`

## Citation Audit
Checked 2026-11-23 against `5a5f3fa` (with leg 1 in progress in the working tree, which touches none of these files except `package.json` `files`). Every line number above was confirmed by `sed -n` or `grep -n` during design:
- `whileStopped` at 1698 and `restartSandbox` at 1713;
- `RESTART_AFTER_SWAP` at 137, `restartForSwap` at 763 and its call at 745;
- the containment tests at 23–24, 1487 and 1774;
- the bypass test at 15, 133–135, 169 and 282;
- `docker.test.ts` source reads at 2410, 2901 and 5569–5586, and the shell describes at 1723 and 1925;
- the `server.ts` places at 817, 1015, 1501, 1612, 1644 and 1666.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
