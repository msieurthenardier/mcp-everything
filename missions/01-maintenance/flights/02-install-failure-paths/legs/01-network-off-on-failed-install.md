# Leg: network-off-on-failed-install

**Status**: completed
**Flight**: [Install Failure and Interruption Paths](../flight.md)

## Objective
Make every install that ends `failed` with its sandbox kept leave that sandbox off the network, with a record that says what is true, and pin each failure branch of `install` (and `uninstall`) with a unit test.

## Context
- Finding 4a (first half) and 4b of the [2026-11-15 maintenance report](../../../../../maintenance/2026-11-15.md), as restated in the flight's Technical Approach. The second half of 4a (records left `installing` by a process that died) is the next leg, `reconcile-stale-installs`. Do not start it here.
- Flight decision that binds this leg: **after a failed install the network is off, and recorded as off**, also when the caller asked for `network: true`. A caller who wants to debug online calls `set_project_network`.
- The flight allows folding 4b's test cases into the leg that changes the behavior they test. That is done here: this leg carries all of 4b.
- First leg of the flight. No prior leg outcomes.
- The operator's live mcp-everything instance runs from this checkout's `dist/` and `node_modules/`. Never run `npm install`, `npm ci` or `npm run build` here. The unit and Docker suites run from source through vitest and do not need a build.

Ground truth, read on 2026-11-16 at branch head `7257c17`:

- `src/install/installer.ts`, `Installer.install`:
  - The record starts as `network: true`, `status: "installing"` (`installer.ts:171 — "network: true,"`) and is stored before anything runs.
  - `installer.ts:184 — "let sandboxCreated = false;"`, set to `true` right after `createContainer` (`installer.ts:237`). `createContainer` starts the container on `bridge` (`src/sandbox/docker.ts:314 — '"--network", "bridge",'`).
  - The requested policy is applied once, after the build loop: `installer.ts:270-272 — "const wantNetwork = params.network === true; await this.docker.setNetwork(container, wantNetwork); record.network = wantNetwork;"`.
  - The recipe-failure branch (`installer.ts:274 — "if (res.code !== 0) {"`) runs after that, so a failed build with `network: true` is kept **online** and recorded `network: true`.
  - The `catch` (`installer.ts:289-301`): when `sandboxCreated`, it stores the record as `failed` and nothing else. `record.network` is whatever it was: `true` if the throw came before line 272. The container is still attached. Throws that reach it with a sandbox in place: the second attempt's `ensureImage` (both the version image and the default fail to pull), `removeContainer` or `createContainer` on the second attempt, the `CLEAN_SCRIPT` exec, the recipe exec itself, `setNetwork`, `discover`, `registry.put`.
  - When `sandboxCreated` is false the `catch` destroys the container and volume and deletes the registry entry. On a reinstall this also removes the earlier record, whose sandbox the install destroyed at its start (`installer.ts:187`).
- `src/sandbox/docker.ts`:
  - `hasNetwork` (`docker.ts:376`) returns `false` for three different states: the inspect succeeded and listed no network, the container does not exist, and the daemon could not be reached. `run` (`src/util/exec.ts`) rejects only when the binary cannot be spawned; a dead daemon and a host-side timeout both resolve with a non-zero or `null` code (confirmed in the design review).
  - `setNetwork` (`docker.ts:384`) returns without doing anything when `hasNetwork` already equals what was asked. So `setNetwork(container, false)` reports success when Docker could not be asked at all. With the daemon back (or with live-restore, never gone), the container is still attached and the record says it is not.
  - `assertAvailable` (`docker.ts:199`) is the existing reachability check (`docker version`, 15 s).
- `src/server.ts`:
  - `set_project_network` (`server.ts:830-837`) calls `docker.setNetwork` and stores `network: enabled`. It is the repair path for a record and a container that disagree, and it works in both directions as long as `setNetwork` tells the truth.
  - Failure advice after an install (`server.ts:698`): "The sandbox was kept. You can repair the build with sandbox_exec (enable set_project_network if it needs downloads) …". It already assumes the sandbox is offline.
  - `install_project` description (`server.ts:64`) ends "afterwards the sandbox is offline unless network is true", and its `network` property (`server.ts:73`) says "Keep outbound network enabled after install (default false)."
- Tests:
  - `test/helpers.ts` — `FakeDocker.setNetwork` records each call in `network: Array<[string, boolean]>`; `destroy` and `removeContainer` record in `destroyed`.
  - `test/installer.test.ts` — `ScriptedDocker` (extends `FakeDocker`) scripts a whole install: `probe` returns `probeData`, `ensureImage` throws for names in `missingImages`, `createContainer` records the image, `recipe` decides the build's result per image. `assertAvailable` is a no-op. No test in this file looks at `docker.network` today, and none makes `probe` throw.
  - `test/installer.test.ts:164` ("also retries when the recipe fails outright, but only once") and `:174` (the timeout case) cover the `failed` status and error text only.
  - `test/server.test.ts:177` and `:359` cover `uninstall_project` through the `App` (sandbox destroyed, record forgotten, servers stopped).
  - `test/docker.test.ts` — its own `ScriptedDocker` (not exported) overrides the protected `docker(args)`, so the real `setNetwork` can be unit-tested without a daemon. As it is, it answers everything except `image` and `exec` with exit 0 and empty output (`test/docker.test.ts:12-18`), which reads as "attached to nothing": it cannot yet make an inspect or the version probe fail.
  - `README.md:89-90` ("Go offline … unless you passed network: true") describes the successful flow. Nothing in the README says what the network is after a failed install.
  - `test/integration/docker.test.ts` — `FailsFirstBuild` (a real `Docker` whose first recipe exec is replaced) and the case under "docker integration: rebuilding on another image" show how to drive `Installer.install` against real Docker with one step swapped: own data directory, own name prefix, `tomnomnom/gron`, image `golang:1`, cleanup in `finally`.

## Inputs
- Branch `flight/02-install-failure-paths`, cut from `main` at `7257c17`.
- `npm run typecheck` clean; `npx vitest run` at 396 passed, 17 skipped.

## Outputs
- `src/install/installer.ts` — one place that takes a kept sandbox off the network after a failure, used by both failure exits.
- `src/sandbox/docker.ts` — `setNetwork(container, false)` no longer reports success when Docker could not be asked.
- `src/server.ts` — wording of the `install_project` description and its `network` property.
- `test/installer.test.ts`, `test/docker.test.ts`, `test/integration/docker.test.ts` — new cases.

## Acceptance Criteria
- [x] **Recipe failure.** When the install recipe exits non-zero or times out, the returned and the stored record have `status: "failed"`, `network: false`, and the last `setNetwork` call for the container is `false`. This holds when the caller passed `network: true`.
- [x] **Throw with a sandbox in place.** When any step throws after a container was created, the returned and the stored record have `status: "failed"`, `error` equal to the message of the error that was thrown, `network: false`, and `setNetwork(container, false)` was called. Shown for at least: the second attempt's image pull failing, `removeContainer` failing on the second attempt, and a throw after the requested policy was applied with `network: true`.
- [x] **The turn-off itself fails.** When taking the sandbox off the network throws, `install` still returns the `failed` record with the **original** `error`; the stored record has `network: true`; and its `warnings` contain one sentence saying the network could not be turned off and naming `set_project_network`. `install` does not throw.
- [x] **No sandbox was created.** A clone failure and an image failure before any container exists both return a `failed` record, leave no registry entry for the project, and call `destroy` a second time for the rollback (the install's opening `destroy` at `installer.ts:187` is the first, so one call proves nothing). A reinstall that fails this way leaves no entry for the earlier record either. (This is current behavior, now pinned.)
- [x] **Success is unchanged.** A successful install with `network: true` ends attached and recorded `network: true`; without it, detached and recorded `network: false`.
- [x] **`Docker.setNetwork(container, false)`** resolves without a `docker network disconnect` when the container does not exist and the daemon answers; rejects when the container's networks cannot be read and the daemon does not answer (a probe that times out counts as no answer); disconnects when the container has a network; makes neither a `disconnect` call nor a daemon probe when the inspect succeeded and listed none. `setNetwork(container, true)` and `hasNetwork` behave as before.
- [x] **`uninstall`**: when `destroy` throws, `Installer.uninstall` rejects and the registry entry is still there (one new case, calling `Installer.uninstall` directly). Its other three effects are already covered by `test/server.test.ts:177` and `:359` and need no new case.
- [x] **Docker suite.** One new case in `test/integration/docker.test.ts` drives a real install whose build step throws after the container is running, with `network: true` requested, and asserts that the container was attached while the build ran, that `docker.hasNetwork(container)` is `false` afterwards, and that the record is `failed` with `network: false`. It cleans up in `finally` and adds no more than about 20 seconds to the suite.
- [x] The `install_project` description and its `network` property say that a failed install leaves the sandbox offline whatever `network` was, and the README says the same in one sentence next to `README.md:89-90`. No other tool text changes.
- [x] `npm run typecheck` is clean. `npx vitest run --testTimeout 20000` passes with more than 396 passed and no new skip. The new Docker case passes when run alone.

## Verification Steps
- `npm run typecheck`.
- `npx vitest run --testTimeout 20000`. Record passed and skipped counts in the flight log.
- New unit cases, by name: `npx vitest run test/installer.test.ts test/docker.test.ts --testTimeout 20000`.
- For each new unit case that pins changed behavior (recipe failure, throw with a sandbox, turn-off failure, `setNetwork` with an unreachable daemon): confirm it fails against the code as it is at `7257c17`. Either write the test first and watch it fail, or stash the `src/` change and run the case. Record which cases were checked this way.
- The new Docker case alone: `MCPE_DOCKER_TESTS=1 npx vitest run test/integration -t '<its name>'`. Record the wall-clock time. Do not run the rest of the Docker suite in this leg; the full suite is run once at the end of the flight.
- `grep -n "offline" src/server.ts README.md` and read each hit: every statement about the network after an install is still true.
- `git status --short` shows only the files listed under Files Affected and this flight's artifacts.

## Implementation Guidance

1. **`Docker.setNetwork`** (`src/sandbox/docker.ts`). Today it cannot tell "attached to nothing" from "no such container" from "Docker did not answer", because it only sees `hasNetwork`'s boolean. Add a private helper that runs the same inspect and returns its exit code and output; make `hasNetwork` a wrapper over it with the same signature and meaning (the Docker suite calls it). In `setNetwork`, use the helper directly. For `enabled: false`: inspect succeeded with a network → disconnect as today; succeeded with none → return; inspect failed → find out whether the daemon is reachable (the `docker version` call `assertAvailable` makes is enough). Reachable means the container is gone and there is nothing to disconnect: return. Not reachable, or the probe timed out: throw, with a message in the style of the existing one (`Failed to disable network for <container>: …`). Do not parse Docker's error text to decide. The daemon probe happens only when the inspect's exit code is not 0. `enabled: true` keeps its current behavior.

2. **One method in `Installer`** that takes a kept sandbox off the network after a failure and makes the record say what is known: on success `record.network = false`; on a throw `record.network = true` and one warning pushed (for example: "The sandbox could not be taken off the network after the failed install (<first line of the reason>); it may still be online. Turn it off with set_project_network."). It never throws.

3. **Use it at both failure exits of `install`**:
   - the recipe-failure branch: do not apply `wantNetwork` when `res.code !== 0`; take the sandbox off the network instead, then store and return as today;
   - the `catch`, in the `sandboxCreated` branch, before `registry.put`. `record.error` is set from the caught error before the method runs and is not touched by it.
   The success path keeps applying `wantNetwork` as it does now. Leave the `sandboxCreated === false` branch as it is.

4. **`registry.put` inside the `catch` can itself throw** (a lock or disk error). That is today's behavior and stays out of scope; do not wrap it.

5. **Tests**, in a new `describe` in `test/installer.test.ts` (for example "install failure paths"), using the file's `ScriptedDocker`. Add to that subclass, not to `FakeDocker` (which `test/server.test.ts` and `test/proxy.test.ts` share): a field that makes `probe` throw (it is hardcoded at `test/installer.test.ts:55-57`); overrides of `setNetwork`, `removeContainer` and `destroy` that can throw on a chosen call or on every call and otherwise defer to `super`. `FakeDocker.destroy` does not call `removeContainer`, so a throwing `removeContainer` affects only the second attempt's call at `installer.ts:235`. Cases, one behavior each:
   - clone failure → nothing left (registry empty, two `destroy` calls);
   - default image cannot be pulled → nothing left;
   - reinstall of a `ready` project whose clone fails → the earlier record is gone;
   - recipe exits 1 with `network: true` → kept, off, recorded off;
   - recipe times out with `network: true` and a `timeoutSec` of your choosing → kept, off, the error names that number of seconds;
   - first attempt fails softly, then neither the next version's image nor the default can be pulled → kept, off, `error` is the pull error. Reachable as the existing retry test sets it up (`test/installer.test.ts:146-147`: `engines.node` giving `[node:26, node:24]`, the recipe failing softly on `node:26`) with `missingImages` holding `node:24` and `node:lts`, the node default;
   - `removeContainer` throws on the second attempt → kept, off;
   - `setNetwork(…, true)` throws once → kept, `error` is that error, then the turn-off succeeds → recorded off;
   - `setNetwork` throws every time → kept, original `error`, recorded `network: true`, the warning present (assert at least the substring `set_project_network`);
   - success with and without `network: true`;
   - `Installer.uninstall` with `destroy` throwing → rejects, the entry stays.
   In `test/docker.test.ts`, a new `describe` with four cases for `setNetwork(…, false)` per the criterion. That file's `ScriptedDocker` needs a small addition first: replies that a test can set per first argument (`inspect`, `version`, `network`), falling back to what it answers today. `argvs` already records every call, so "no `network disconnect`" and "no `version` probe" are assertions on it.

6. **Docker case** in `test/integration/docker.test.ts`, modeled on `FailsFirstBuild`: a `Docker` subclass whose recipe exec (the one whose script contains `soft_fail()`) first records `await this.hasNetwork(container)` and then throws. Drive `Installer.install` directly with `network: true` and `tomnomnom/gron`, in its own data directory and with its own name prefix (`${prefix}netoff-`). The recipe never runs, so the image only has to start: pass `image: cfg.docker.probeImage` (the clone image, already present once the clone has run; `params.image` bypasses `choose`, so no stub is needed). If the sandbox does not start on that image, fall back to `golang:1` through a `choose` stub as `FailsFirstBuild`'s case does, and record it. Assert per the criterion. `finally`: uninstall whatever the registry lists and remove the directory. Put it in its own `describe.skipIf(!enabled)`.

7. **Tool text** (`src/server.ts`): amend the `install_project` description and the `network` property so they are true of a failed install. Keep each to one added clause. No test pins either string (checked in the design review). **README**: one sentence at `README.md:89-90` saying a failed install leaves the sandbox offline whatever `network` was.

8. **Flight log**: under Leg Progress, what changed, each verification with its result, which cases were seen to fail first, and anything that differed from this leg.

## Edge Cases
- **The container is already gone when the turn-off runs** (second attempt removed it and `createContainer` then failed): with a reachable daemon `setNetwork(…, false)` returns, and the record says `network: false`. Correct: nothing is attached.
- **The sandbox is stopped** (idle timeout): `docker network disconnect` works on a stopped container; the Docker suite already shows `setNetwork` applied while stopped. No special handling.
- **`params.network === true` and the recipe timed out with exit code 0**: the existing test for failure is `res.code !== 0`. Do not change which results count as failed.
- **A throw from `discover` after `setNetwork(container, true)` succeeded**: the `catch` must still end with the network off. `record.network` was `true` at that point; the method sets it.
- **Do not turn the network off when no sandbox was created.** That branch destroys instead.
- **`FakeDocker.setNetwork` is shared** by `test/server.test.ts` and `test/proxy.test.ts`. Change `test/helpers.ts` only by adding; do not alter what the existing field records.

## Files Affected
- `src/install/installer.ts` — `install`'s two failure exits; one new private method
- `src/sandbox/docker.ts` — `setNetwork`
- `src/server.ts` — two strings in the `install_project` tool definition
- `test/installer.test.ts` — new `describe`; small additions to `ScriptedDocker`
- `test/docker.test.ts` — four cases for `setNetwork`
- `test/integration/docker.test.ts` — one case
- `test/helpers.ts` — only if an addition to `FakeDocker` is needed
- `README.md` — one sentence at lines 89-90

## Out of Scope
- Records left `installing` by a dead process (next leg).
- Three things the design review pointed at, all existing behavior, none changed here. Note them in the flight log if you see them, do not fix them:
  - `createContainer` failing or timing out on the first attempt after Docker did create the container: `sandboxCreated` is false, the rollback's `destroy` errors are swallowed, and a failed `destroy` leaves a container with no record. No project code has run in it.
  - On the second attempt, `removeContainer` succeeding and `createContainer` failing: the record is kept and the container is gone, so the advice "The sandbox was kept" is not true of it.
  - A throw from `discover` after the proxy opened sessions in the container: the `catch` does not close them. The next reinstall or uninstall does.
- Shutdown (4c) and `disconnectMcp` (4d).
- The structure of `install` beyond the two exits; the wording of the "sandbox gone" messages; how `discover` treats exec errors.
- The hosted check's minimum test count: raised once, in the flight's last leg.

## Citation Audit
Checked on 2026-11-16 against `7257c17`, each by reading the file: `installer.ts:171`, `:184`, `:187`, `:237`, `:270-272`, `:274`, `:289-301`; `docker.ts:199`, `:314`, `:376`, `:384`; `server.ts:64`, `:73`, `:698`, `:830-837`; `test/installer.test.ts:164`, `:174`; `test/server.test.ts:177`, `:359`. No drift. The design review (a Developer, same day) re-checked them and confirmed; it supplied `test/docker.test.ts:12-18`, `test/installer.test.ts:146-147` and `README.md:89-90`, and `installer.ts:235`.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
