# Leg: split-install

**Status**: completed
**Flight**: [Checking a Project's Own Code Before It Runs](../flight.md)

## Objective
Split `Installer.install` into the three pieces mission 02's debrief named — retiring the old sandbox, the build attempts, settling a failure — with its install state held as one value, and with no change in behavior.

## Context
- Flight DD9: mission 02's flight debrief (`missions/02-sandbox-ownership-on-a-shared-machine/flights/01-owned-sandboxes/flight-debrief.md`, "What Could Be Improved → Technical", second bullet) recommends this split before the next change to the method, with no change in behavior: "retiring the old sandbox; the build attempts; settling a failure", and "one state value in place of `phase`, `sandboxCreated` and `sandbox`". Its Process section adds: the method was edited in three legs, and the one false statement of that flight came from two variables for one fact set in different legs.
- This flight's leg 5 (`check-before-build`) will add a checked install that reuses these pieces and adds a state before `old` (DD6's `checking`). This leg only leaves room for it: it does **not** add the state, a new entry point, or any scanning code.
- The scan-off path must stay exactly as it is: leg 5 and the flight's DD8 rely on `install()` keeping its contract (it returns the record) and on its ~100 unit cases staying as they are.

## Inputs
- `src/install/installer.ts` — `Installer.install` (starts at `async install(params: InstallParams, log: Logger = () => {}): Promise<ProjectRecord>`, line 224, 222 lines long), with three install-state variables: `let phase: "old" | "new"`, `let sandboxCreated = false`, `let sandbox: SandboxRef | undefined`.
- Unit baseline at flight start: 22 files passed, 1 skipped; 950 passed, 24 skipped.
- Nothing from this flight is implemented yet.

## Outputs
- `src/install/installer.ts` — `install()` reads as the sequence, calling three private methods; one state value replaces the three variables.
- No other source file changes. No test file changes.

## Acceptance Criteria
- [ ] `Installer.install` keeps its exported signature and contract: `install(params: InstallParams, log?: Logger): Promise<ProjectRecord>`, the same records written to the registry in the same order, the same errors thrown with the same messages, the same Docker calls in the same order with the same arguments, the same `log` lines.
- [ ] The three pieces are private methods of `Installer` named `retireOldSandbox`, `buildAttempts` and `settleFailure`, each with a doc comment stating what it does, what it may throw, and what it leaves behind on failure. `discover` stays a prototype method looked up at call time (tests replace it by assignment); no helper shadows or captures it.
  - **retiring the old sandbox** (`retireOldSandbox`): the part that, for a reinstall, closes proxied servers and removes the previous sandbox (the renamed branch with its refusal handling and record write) and then the sandbox at the install's own names — today the block from `if (before && renamed) {` through `await this.docker.destroy(container, volume);` and the `phase = "new"` that follows;
  - **the build attempts** (`buildAttempts`): the `for` loop over `attempts` (image pull with its fallback, container creation, the clean script on a rebuild, the recipe, warning collection, the retry decision), returning `{ res, tail, sandbox }` and writing every change of the install state to the holder `install()` owns as it happens (see the state criterion), so that a throw after `createContainer` leaves the holder naming the container it made;
  - **settling a failure** (`settleFailure`, returning `Promise<ProjectRecord>`; its only throws are the `old` branch's two, documented): the body of the `catch (e)` block — the `phase === "old" && before` branch that puts the old record back and throws, and the branch that marks the record failed and either takes the sandbox offline or rolls back the install's new names.
- [ ] `phase`, `sandboxCreated` and `sandbox` are replaced by one state value whose type is a discriminated union, so that "a sandbox was created" and "which sandbox" can no longer disagree. Its shape leaves room for a later state before `old` without changing the existing members (a union to which a member can be added). `sandboxCreated` disappears: it is true exactly when a sandbox reference is held. The `old` member carries `before`, so the failure branch needs no separate `&& before` check. **The state lives in a mutable holder local to `install()`** (a plain object, `{ current: InstallState }`), never an instance field: concurrent installs share the `Installer`. `retireOldSandbox` may return the new state (on a throw the state is correctly still `old`), but `buildAttempts` must write to the holder, because it can throw after creating a container and a returned value would then be lost.
- [ ] No definite-assignment `!` remains on `res`, `tail` or `sandbox` (today `let res!:`, `let tail!:`, and `sandbox!` after the loop); `ExecResult` and `Tail` are still used.
- [ ] The failure-before-the-loop path is unchanged: today a failure after `phase = "new"` but before any container exists (clone failure, image failure) rolls back with `this.docker.destroy(container, volume).catch(() => {})` and `this.registry.delete(slug)`.
- [ ] No file under `test/` is modified. `npx vitest run` passes with exactly 950 passed and 24 skipped (the flight-start baseline). `npm run typecheck` is clean. `npm run build` succeeds.
- [ ] The Docker suite (`npm run test:docker`) passes with the same pass/skip counts as before the leg. Run it once before the change (to record the baseline) and once after.
- [ ] The operator's containers and volumes listed in the flight log's flight-start notes are unchanged after the Docker suite runs (same ids, same names).
- [ ] `install()` is at most 120 lines (from its signature line to its closing brace), with the code after the loop (the failed-recipe block, the network, discovery, ready) left in it. The design review counted about 112–118 lines for that shape; 120 is the limit, and a fourth method is not wanted.

## Verification Steps
- `git diff --stat -- src test` shows only `src/install/installer.ts`.
- `npx vitest run` → 950 passed, 24 skipped.
- `npm run typecheck`; `npm run build`.
- Before the change: `npm run test:docker 2>&1 | tee <scratch>/docker-before.txt`; after: the same to `docker-after.txt`; compare the summary lines. Save the whole output, not a `tail` of it (mission 02's debrief: the test ids it prints are needed afterwards).
- `docker ps -a --format '{{.ID}} {{.Names}}'` and `docker volume ls` compared against the flight log's list.
- Read `install()` top to bottom: it reads as clone → detect → choose image → build attempts → take offline or set network → discover → ready, with the catch delegating to the failure method.
- Count lines of `install()`.
- **Behavior-preservation by trial**: make each of these source changes in turn, run `npx vitest run test/installer.test.ts`, confirm a failure, and undo the change by editing (the flight's code work is uncommitted; save `git diff -- src` before the trials and compare it after each undo): (1a) swap `takeOffline` and `registry.put` in the failed-recipe block that stays in `install()` (expected to be caught by the on-disk `network` check in `test/installer.test.ts`, about line 1318); (1b) the same swap in `settleFailure`'s sandbox-was-created branch (the design review expects **no** test to catch it, since `registry.put` stores the object by reference and the on-disk checks of that path read only `status` and `container`); (2) drop the `registry.put` of the renamed branch in `retireOldSandbox` (expected: caught around lines 1068–1081); (3) in `buildAttempts`, skip the clean script on a rebuild (expected: caught around 263–264 and 1366–1375); (4) make `buildAttempts` return its sandbox without writing the holder (expected: caught by the recipe-failure and second-attempt-removal cases around 672–681). Report each trial's outcome. A trial that does not fail is reported as such, not "fixed" by editing tests: 1b's outcome is information for the flight.

## Implementation Guidance

1. **Record the Docker-suite baseline first**, before touching the source. The suite runs against the operator's daemon; it has run on every flight since mission 02 with its guards unchanged, so it is cleared to run as it is.

2. **The state value.** For example:
   ```ts
   /** Where an install is, for its failure branch. */
   type InstallState =
     | { phase: "old" }                          // a reinstall whose old sandbox has not been retired yet
     | { phase: "new"; sandbox?: SandboxRef };   // the old sandbox is gone (or there was none); `sandbox` once a container exists
   ```
   (with `before` carried in the `old` member, per the criteria). Held as `const state = { current: <initial> }`. Initial value: `{ phase: "old", before }` when `before` exists, else `{ phase: "new" }`. The places that set `phase = "new"`, `sandbox = made; sandboxCreated = true`, and `sandbox = undefined; sandboxCreated = false` (on a rebuild) become assignments of the state value. Pass the holder to `buildAttempts` and `settleFailure`; do not make it an instance field (concurrent installs share the `Installer`).

3. **Retire the old sandbox.** Move the block named in the criteria into a private method taking what it needs (`before`, `renamed`, `record`, `container`, `volume`) and returning the new state (`{ phase: "new" }`). Keep the order of its statements exactly: the renamed branch's `proxy.closeProject(before.container)`, `docker.destroy` with the `SandboxRefusedError` handling, the warning push, `registry.put(record)`; then `proxy.closeProject(container)`, `docker.destroy(container, volume)`. Its errors propagate as today, so `install()`'s catch sees them with the state still `old`.

4. **The build attempts.** Move the `for` loop into a private method. It needs `record`, `attempts`, `choice`, `defaultImage`, `params`, `container`, `volume`, `timeoutSec`, `log`, and the state; it returns `{ res, tail, sandbox }`, and writes the holder at each point the old code assigned `sandbox`/`sandboxCreated` (after `removeContainer` on a rebuild: no sandbox; after `createContainer`: the new one), so the holder is right whenever it throws. Keep the comments that explain why (one retry at most; a missing version tag must not sink the install; the first attempt's container is gone until `createContainer` returns).

5. **Settle a failure.** Move the `catch` body into a private method taking `e`, `before`, `record`, `slug`, `container`, `volume` and the state; it either throws (the `old` branch, both messages unchanged) or returns the record (the failed branch). Keep every comment that states a rule (why the rollback swallows every error; why the proxy is closed best-effort).

6. Keep `install()`'s remaining body as the readable sequence, with the code after the loop (`res.code !== 0` handling, network, discover, ready) left in it, using the `sandbox` `buildAttempts` returned in place of `sandbox!`.

7. Run the trials in the Verification Steps, then the suites.

## Edge Cases
- **A rebuild that throws after removing the first container**: today `sandbox = undefined; sandboxCreated = false` happen right after `removeContainer`, before `createContainer`. If `createContainer` then throws, the failure branch sees no sandbox and rolls back the names. The state value must reproduce exactly that.
- **A refusal in the renamed branch** is caught there and becomes a warning; the install continues. Any other error from it propagates with the state `old`.
- **`res` and `tail` definite assignment**: today they are `let res!:` / `let tail!:` assigned in the loop. Returning them from `buildAttempts` removes the need for `!`; `attempts` cannot be empty (it always holds `choice.image`), so say so in a comment rather than adding a branch.
- **Call counts tests rely on**: the `closeProject` mock in the unit tests (about line 747) lets only its first call through, so the failure branch's `closeProject` must remain the second call; `removeContainer` precedes `createContainer` on a rebuild; a rebuild whose `createContainer` throws still ends with the two `destroy` calls the tests expect.
- **`this.proxy.closeProject(container).catch(() => {})`** in the failure branch stays best-effort.

## Files Affected
- `src/install/installer.ts` — `Installer.install` and three (possibly four) new private methods; one new local type.

## Citation Audit
Checked against the working tree at branch `flight/01-checks-before-code-runs`, commit `40abfb5`, by the Flight Director: `async install(` at line 224; `let phase: "old" | "new" = before ? "old" : "new";` at 263; `let sandboxCreated = false;` and `let sandbox: SandboxRef | undefined;` at 273–275; the renamed branch `if (before && renamed) {` at 277; `await this.docker.destroy(container, volume);` at 292; the `for (let i = 0; i < attempts.length; i++)` loop at 327; the outer `} catch (e) {` at 403 through the method's closing brace at 445 (the inner `catch (e)` at 281 is the renamed branch's refusal handling; the one at 332 is the image-pull fallback). Line numbers drift; the quoted snippets are authoritative. `takeOffline` at 512. All present as cited. Developer design review (2026-11-22) re-checked them: accurate; the method is 222 lines (224–445).

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
