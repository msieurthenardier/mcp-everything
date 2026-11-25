# Leg: split-docker-and-containment

**Status**: completed
**Flight**: [Groundwork, and Leaving Old Sandboxes Alone](../flight.md)

## Objective
Split `src/sandbox/docker.ts` and `src/network/containment.ts` into modules by concern, with no change in behavior.
- `docker.ts`'s top-level declarations move into four modules.
- The `Docker` class becomes a chain of three classes in three files.
- `containment.ts`'s project lock moves into a module of its own.

The only changes allowed inside a moved body are the visibility and call-site edits this leg lists.

## Context
- Flight DD5, with the Architect review's boundaries corrected by the call-graph analysis below. Flight 2's debrief, recommendation 2.
- **High risk for its size:** 2,900 and 1,250 lines move, and a split that is wrong only in visibility or initialization order would show up as runtime differences. The leg gets a Developer design review.
- **Starts after leg 2 lands.** Leg 2 deleted the restart-after-swap fallback and made the source-text tests read a list of files:
  - `test/sources.ts`, or whatever leg 2 named it;
  - `test/docker-bypass.test.ts`'s `{ file, className }` list and prototype-chain walk.

  This leg changes those lists, not their logic.
- **Reference copies:** the Flight Director saves copies of `src/sandbox/docker.ts`, `src/network/containment.ts` and `src/server.ts` as they are after leg 2, to `/tmp/claude-1000/-home-cprch-projects-mcp-everything/af8c3a2b-d50f-4f71-82a3-12dc354df1cd/scratchpad/leg3-ref/`. The normalized diff runs against these.
- Docker baseline (2026-11-23): 66 passed, 5 skipped, 0 failed.

## Call-graph analysis (Flight Director, 2026-11-23, on `5a5f3fa`)
Every `this.<member>` call inside class `Docker` was extracted and checked for cycles and for upward calls under the Architect's three ranges (base ≈877–1339, network ≈1340–2210, lifecycle after that). Findings:
- **One cycle**: `assertRuntime`, `checkRuntime`, `runOnce`, `readResolvers`, `readUpstreamResolvers` and `runBehindProxy` call each other. They must sit in one class.
- **Upward calls** under the Architect's ranges:
  - `runOnce` (base) calls `runBehindProxy` (network);
  - `checkRuntime` (base) calls `runOnce`;
  - `detachProjectProxy` (network) calls `disconnectForce` (lifecycle).
- **Corrected assignment, with no upward call:**
  - `assertRuntime`, `checkRuntime` and `runOnce` move up into the network class;
  - `disconnectForce` moves down into it.

  That gives 28 methods in the base class, 46 in the network class and 29 in `Docker`.
- **`private` to `protected`.** Under that assignment, 27 private methods are used from a higher class and must become `protected`: `afterStarted`, `hooked`, `hookCached`, `ask`, `isNotThere`, `isNetworkNotThere`, `unreadable`, `inspectContainer`, `refuseRuntimeMismatch`, `runtimeRefusal`, `inspectVolume`, `containerFacts`, `volumeFacts`, `refuseUnless`, `resolveContainer`, `startId`, `doesNotExist`, `imagePath`, `limits`, `runCreated`, `findContainedNetwork`, `needsRestartToChangeNetwork`, `whileStopped`, `rmProxy`, `rmNetwork`, `projectObjects` and `disconnectForce`. The same goes for the private fields used above the base: `runtimeOk`, `runtimeCheck`, `daemonDefaultRuntime`, `upstreamResolvers` and `hook`, and the constructor's `cfg` and `log` if used above. The design review re-derives this list on the post-leg-2 code, with the TypeScript compiler as the judge.

## Design review resolutions (2026-11-23)
A Developer reviewed this leg against the code after leg 2 and approved it with changes. Its scripts are in the scratchpad's `leg3-review/`.
- **Confirmed:**
  - the call graph, the cycle, the 28/46/29 assignment with no upward call, and the 27 methods that become `protected`;
  - the constructor's `cfg` and `log` also become `protected`, because both are used above the base;
  - `afterStartHook`, `hookCache`, `hookGeneration` and `checkRuntime` stay `private`;
  - no field initializer reads another field;
  - `Docker["inspectVolume"]` compiles unchanged. Open Questions 2 and 3 are closed.
- **R1 — the lock's dependencies.** The lock section also uses:
  - the error classes `ContainmentError`, `ContainmentBusyError`, `ContainmentDeadlineError` and `ContainmentLockLostError`;
  - `LIMITS`, `Clock`, `realClock` and `sha256`.

  All are defined in `containment.ts`, so importing them back from `project-lock.ts` would be a value cycle. Fix:
  - these move to a new **`src/network/containment-core.ts`**, together with the other `Containment*Error` classes, so that the errors keep one home;
  - `project-lock.ts` and `containment.ts` import from it;
  - `containment.ts` **re-exports** exactly the moved names (the error classes, `Clock`, `realClock`, `LIMITS`), so `src/server.ts`, `src/network/startup.ts` and the tests that import them from `containment.js` stay unchanged. This is the only re-export in the leg.
  - `sha256` is exported from `containment-core.ts`; it is also used at `containment.ts` ≈250 and ≈255.
- **R2 — two more permitted test edits.**
  - `test/docker.test.ts` ≈1437, `own()`, uses `Object.getOwnPropertyNames(Docker.prototype)`. It becomes a call to a shared prototype-chain helper added to `test/sources.ts`, the same walk the bypass test uses.
  - `test/docker-bypass.test.ts` ≈408 and ≈410 name `src/sandbox/docker.ts` as the home of the `cfg.docker.bin` users (`assertAvailable`, `ask`, `docker`). They name `src/sandbox/docker-base.ts` instead.
- **R3 — `export` is a permitted edit.** A top-level declaration that becomes exported because another module now needs it is normalized away. Examples: `clean`, `LABEL_MAX`, `ROLE_LABEL`, `DEFAULT_PATH`, `WATCHDOG_SCRIPT`, `proxyNetworkSpec`, `lowerHalf`, `OWN_HOST_NAMES`, `HOSTS_NAME`, `FULL_ID`, `ContainerFacts`, `ONESHOT_NET_ROLE`, `PROJECT_NET_ROLE`.
- **R4 — placements, checked for value cycles across all modules by the reviewer.** They replace the Outputs list below wherever the two differ:
  - **`scripts.ts`:** the paths (`WORKSPACE` to `VENV_DIR`), `DEFAULT_PATH`, `MANIFESTS`, `CLONE_SCRIPT`, `WALK_SEPARATOR`, `walkArguments`, `WALK_SCRIPT`, `PROBE_SCRIPT`, `WATCHDOG_SCRIPT`, `watchdogPollSec`, `isStoppedExecFailure`, `INCOMPLETE_REASONS`, `ProbeData` and `parseProbeOutput` (`ProbeData` and `parseProbeOutput` move together).
  - **`ownership.ts`:** the labels (`GENERIC_LABEL`, `OWNER_LABEL`, `PROJECT_LABEL`, `ROLE_LABEL`, `SANDBOX_LABEL`), `SandboxClass`, `classifySandbox`, `OwnershipReport`, `SandboxFacts`, `SandboxInspectFacts`, `LABEL_MAX`, `clean`, `OWNER_SHOWN`, `describeFacts`, `refusalMessage` and `SandboxRefusedError`.
  - **`errors.ts`:** the other seven error classes. `RuntimeMismatchError` imports `clean` from `ownership.ts`, which is the only cross-edge among the bottom modules.
  - **`network-spec.ts`:** `proxyAddress`, `proxyMac`, `proxyNetworkSpec`, `isRuncRuntime`, `parseSubnet`, `dotted`, `lowerHalf`, `LOCAL_ACCESS_MARK`, `LOCAL_ACCESS_SCRIPT`, `OWN_HOST_NAMES`, `HOSTS_NAME`, `PROXY_KINDS`, `PROXY_REASONS`, `ProxyRefusalRow`, `ProxyReport`, `MAX_REPORT_ROWS`, `isCount`, `parseProxyReport`, `parseResolvConf`, `projectNetworkName`, `networkModeOf`, `newProjectProxyName` and `NetworkMode`.
  - **`docker-base.ts`:** `NOT_THERE`, `NETWORK_NOT_THERE`, `FULL_ID`, `UNKNOWN_RUNTIME`, `networkIdsOf`, `NETWORKS`, `RUNTIME`, `NAME`, `BASE_FORMAT`, `FULL_FORMAT`, `ContainerFacts`, the hook types (`ContainmentHookMode`, `ContainmentHook`, `AfterStartHook`), `SandboxRef` (the interface), `ONE_SHOT_ROLES`, `OneShotRole`, `OneShotCap`, `OneShotSpec`, `OneShotResult`, and `class DockerBase`.
  - **`docker-network.ts`:** `EXTRA_CAPS`, `ONESHOT_NET_ROLE`, `ISOLATED_BRIDGE_NEEDS`, `PROJECT_NET_ROLE`, `PROJECT_PROXY_ROLE`, `RESERVED_LABELS`, `NETWORK_FORMAT`, `networkInspectArgs`, `POOLS_EXHAUSTED`, `POOL_OVERLAPS`, `POOL_RETRIES`, `ContainedNetwork`, `ProjectProxy`, `NetworkCheck`, `foreignNetworkRefusal`, and `class DockerNetwork`.
  - **`docker.ts`:** `ENV_NAME_PATTERN`, `envFlags`, `ExecOptions`, `ExecResult`, `makeRef`, `Target`, and `class Docker`.
  - A name the reviewer did not place goes to the lowest module that uses it, and is recorded in the flight log.
- **R5 — importers, Open Question 1 settled.** Option B, with no barrel for the docker modules: importers are edited in `src/` (13 files) and in `test/` (17 files, 28 import statements), mechanically. The only re-export is R1's, in `containment.ts`.
- **R6 — the size cap.** `docker-network.ts` will be about 1,100–1,150 lines. That is accepted; `network-spec` helpers stay out of it.
- **R7 — source lists.**
  - `DOCKER_SOURCES` lists all seven `src/sandbox/` files: the four bottom modules, `docker-base`, `docker-network` and `docker`.
  - `CONTAINMENT_SOURCES` lists `containment.ts`, `containment-core.ts` and `project-lock.ts`.
  - The checks that depend on list order (`slice(indexOf("private async checkRuntime"))`) and on exact text (`export type OneShotRole = (typeof ONE_SHOT_ROLES)[number];`) must still pass.
- **Extra mutation:** a method added to a class that `DOCKER_CLASSES` does not list fails the prototype/source equality check.

## Inputs
- `src/sandbox/docker.ts` after leg 2. Top-level declarations ≈ lines 1–876. `class Docker` from ≈877.
- `src/network/containment.ts` after leg 2. The project lock is:
  - `interface HeldLock`;
  - the `tails` map;
  - `lockPath`, `withProjectLock`, `acquireMutex`, `removeIfStale` and `acquireFile` (≈471–626 on `5a5f3fa`; the `// --- locks ---` section).

  It uses `this.tails`, `this.clock` and `this.opts.dataDir`. `withProjectLock` is called 5 times in `Containment`.
- About 32 importers of `src/sandbox/docker.js` in `src/` and `test/`.
- The source-text test lists from leg 2.

## Outputs
- **New files under `src/sandbox/`** (names may differ if the review prefers; the boundaries are what matters):
  - `scripts.ts`: `WORKSPACE`, `REPO_DIR`, `WORK_DIR`, `PREFIX`, `BIN_DIR`, `VENV_DIR`, `DEFAULT_PATH`, `MANIFESTS`, the clone, walk, probe and watchdog scripts, `walkArguments`, `watchdogPollSec`, `isStoppedExecFailure`, `parseProbeOutput`, `ProbeData`;
  - `ownership.ts`: the labels, `SandboxClass`, `classifySandbox`, `OwnershipReport`, `SandboxFacts`, `describeFacts`, `refusalMessage`, `SandboxRefusedError`, `OWNER_SHOWN`;
  - `errors.ts`: `VolumeNotUsableError`, `DockerUnavailableError`, `RuntimeUnavailableError`, `ContainmentUnavailableError`, `ProxyStartError`, `CloneFailedError`, `RuntimeMismatchError`;
  - `network-spec.ts`: `proxyAddress`, `proxyMac`, `proxyNetworkSpec`, `isRuncRuntime`, subnet helpers, `LOCAL_ACCESS_*`, `parseResolvConf`, `parseProxyReport`, the proxy report types, `projectNetworkName`, `networkModeOf`, `newProjectProxyName`, `NetworkMode`;
  - `docker-base.ts`: `class DockerBase`;
  - `docker-network.ts`: `class DockerNetwork extends DockerBase`.
- **`src/sandbox/docker.ts`:** `class Docker extends DockerNetwork`, plus what fits nowhere else: `ExecOptions`, `ExecResult`, `envFlags`, `SandboxRef`, `makeRef`, the hook types, `OneShotSpec` and so on. Declarations shared by several modules go to the lowest module that needs them, so no import cycle arises at runtime.
- **`src/network/project-lock.ts`** (new): `class ProjectLocks` and `interface HeldLock`.
- The importers in `src/` import from the new homes. Whether `docker.ts` re-exports is settled at the design review (see Open Question 1).
- Tests change only in imports and in leg 2's source lists.

## Acceptance Criteria
- [ ] **The class chain.**
  - `class DockerBase` (`docker-base.ts`), `class DockerNetwork extends DockerBase` (`docker-network.ts`) and `class Docker extends DockerNetwork` (`docker.ts`) hold every member of today's `Docker` exactly once, with the method assignment above or a corrected one recorded in the flight log.
  - No method in a lower class calls a member defined only in a higher one: the typecheck enforces this, because a lower class cannot see a higher one's members.
  - Only `Docker` is instantiated anywhere in `src/`.
  - The constructor and every field initializer live in `DockerBase`.
- [ ] **Bodies unchanged.** Ignoring these normalizations, every moved method body, field and top-level declaration is identical to the reference copy:
  - `private` → `protected`;
  - import lines;
  - the class headers;
  - in `project-lock.ts`, `this.opts.dataDir` → `this.dataDir` and `this.clock`/`this.tails` as the new class's own fields;
  - in `Containment`, `this.withProjectLock(` → `this.locks.withProjectLock(` plus one field and its construction;
  - `export` added to a top-level declaration (R3);
  - R1's re-export line in `containment.ts`.

  The Flight Director's normalized diff (Verification 1) is empty. Any other edit, such as `Docker["inspectVolume"]` in `requireVolumes`, is listed in the flight log with its reason.
- [ ] **No import cycle at module load.** `node -e "import('./dist/sandbox/docker.js')"` after `npm run build` loads without error, and so do the server and `src/index.ts`'s output. Type-only imports may cross freely; value imports go downward:
  - `scripts`, `ownership`, `errors` and `network-spec` at the bottom;
  - then `docker-base`, `docker-network` and `docker`.
- [ ] **`containment.ts`.**
  - `ProjectLocks` holds the five lock methods and `tails`.
  - `Containment` builds one in its constructor from `opts.dataDir` and its clock, and calls `this.locks.withProjectLock` at the five sites.
  - The startup registration (`registerStartup`, `registerStartupGate`, `waitFor`, `startups`, `gate`, `gateCleared`) stays in `Containment`.
- [ ] **Tests change only in imports, lists, and R2's two edits.**
  - `test/docker-bypass.test.ts` lists the three classes and files.
  - The prototype walk from leg 2 finds every method.
  - `callers(...)` gives the same lists as before.
  - The source-text reads in `test/docker.test.ts` list the new files.
  - `git diff` of `test/` against the post-leg-2 state shows only `import` lines, those lists, the shared prototype-chain helper in `test/sources.ts`, and R2's two edits.
- [ ] **Checks:**
  - `npm run typecheck` is clean and `npm run build` succeeds;
  - `npx vitest run` gives exactly leg 2's totals;
  - `npm run test:docker` gives 66 passed, 5 skipped, 0 failed, or the baseline's result;
  - no Docker object is left behind (the Flight Director diffs the lists).
- [ ] **Sizes:** no new file exceeds about 1,200 lines. `docker.ts`, `docker-base.ts` and `docker-network.ts` are recorded in the flight log.

## Verification Steps
1. **Normalized diff (the Flight Director runs it too).**
   - For each method, field and top-level declaration in the reference copies, find its new home and compare the text. Ignore leading `private`/`protected` and the listed call-site edits.
   - A script in the scratchpad may do this: it extracts members by name from both sides and diffs each one.
   - Record the result, and the list of any non-visibility edits.
2. `npm run typecheck && npm run build && npx vitest run`: the counts equal leg 2's.
3. **Load check:** `node --input-type=module -e "await import('./dist/sandbox/docker.js'); await import('./dist/server.js'); console.log('ok')"`.
4. **Bypass test mutation.** Add a dummy method that calls `this.startId(...)` to `DockerNetwork`, see the bypass test fail, then remove it by editing.
5. **Docker suite.** The Flight Director runs `npm run test:docker` after the leg lands, with the Docker object lists diffed before and after. The Developer does not run it.

## Implementation Guidance
1. **Top-level declarations first:** move them into the four modules, fix imports, and run the typecheck.
2. **Create `DockerBase`:** move the fields, constructor and base methods, then make `Docker extends DockerBase`, and run the typecheck. The compiler then names every private member that has to become `protected`. Change only those.
3. **Create `DockerNetwork`** the same way.
4. **`ProjectLocks`:** move the lock methods and `tails`, then add the field and the five call-site edits.
5. **Imports:**
   - Update the importers in `src/`.
   - Update test imports, and leg 2's lists.
   - Decide on re-exports per Open Question 1.
6. **Build, then run the checks and the load check.**

## Open Questions (for the design review)
1. **Re-export or not.**
   - **Option A:** `docker.ts` re-exports every name it exported before. No importer changes, but `docker.ts` becomes a barrel.
   - **Option B:** importers import from the new homes. About 32 import edits, and the modules stay honest.
   - **Lean: B for `src/`, and A for nothing.** The design review checks the importer count and any test that imports `docker.js` for many names.
2. **The `requireVolumes` type.** `Awaited<ReturnType<Docker["inspectVolume"]>>`: with `inspectVolume` in `DockerBase`, `Docker["inspectVolume"]` still resolves, because the member is inherited and `protected` is visible in indexed access types inside the class. Keep it if it typechecks; otherwise use `DockerBase["inspectVolume"]` and list that edit.
3. **Field initialization order.** Fields in a base class are initialized before a subclass's. With every field in `DockerBase`, the order is unchanged. Confirm that no field initializer reads another field that would move.

## Edge Cases
- **Test doubles subclass `Docker`** and override `protected docker()`, `clock()`, `runOnce` and others: `FakeDocker` (`test/helpers.ts:51`), `ScriptedDocker` (`test/docker.test.ts` ≈97) and others. An override of a method now defined in `DockerNetwork`, such as `runOnce`, still works through the chain.
  - Check that no double overrides a member that was `private`. TypeScript forbids that, so it would be a compile error today.
- **`instanceof` checks** on the moved error classes must still match. One class object exists per module, so `errors.ts` must be the only definition, with no copies.
- **`Object.getOwnPropertyNames(Docker.prototype)`** in other tests: grep `test/` for it, besides the bypass test.
- **`test/docker.test.ts`'s source reads**, such as `src.slice(src.indexOf("private async checkRuntime"))`: `checkRuntime` stays `private`, since it is used only within `DockerNetwork`. If the review makes it `protected`, the slice's search text changes too, and that is a list or text edit to state.
- **Comments move with their code.** Section banner comments such as `// --- locks ---` go to the file that holds the section.

## Files Affected
- `src/sandbox/docker.ts`, plus new `src/sandbox/{scripts,ownership,errors,network-spec,docker-base,docker-network}.ts`
- `src/network/containment.ts`, plus new `src/network/project-lock.ts` and `src/network/containment-core.ts` (R1)
- Importers in `src/` (≈32 lines)
- `test/`: imports and leg 2's source lists only

## Citation Audit
Checked 2026-11-23 against `5a5f3fa`, before leg 2:
- the call graph was computed from `git show 5a5f3fa:src/sandbox/docker.ts`;
- the constructor is at 899, `requireVolumes`' type at 2274, and the lock section at 471–626;
- `this.withProjectLock(` occurs 5 times;
- the lock methods use `this.tails`, `this.clock` and `this.opts`.

Line numbers shift after leg 2, which removes the fallback from `containment.ts` and rewords a comment in `docker.ts`. The design review re-checks every citation by symbol.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
