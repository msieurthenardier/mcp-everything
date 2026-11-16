# Leg: reconcile-stale-installs

**Status**: completed
**Flight**: [Install Failure and Interruption Paths](../flight.md)

## Objective
When mcp-everything starts, mark as `failed` every record that has said `installing` for longer than any realistic install runs, and take its sandbox off the network, without disturbing an install that another live process may still be running.

## Context
- Finding 4a (second half) of the [2026-11-15 maintenance report](../../../../../maintenance/2026-11-15.md): if the server process dies during an install, the record stays `installing` and the sandbox stays attached to the network. Nothing ever changes that.
- Flight decision that binds this leg: reconcile **only records that cannot belong to a live install**. Several processes share one data directory, so an `installing` record seen at startup may be another process's install in progress. Turning its network off would break that build.
- The flight left one question to leg design: is there a better ownership signal than age? **No.** A record carries no process id, host or heartbeat (`src/types.ts`, `ProjectRecord`), and adding one is a change to the registry's schema, which the flight reserves for the operator. The container's own state does not settle it either: a live install has no container while it clones and pulls, and can have a stopped one while it pulls the image for a second attempt. This leg uses age, as the flight's default says.
- Leg 1 (`network-off-on-failed-install`) landed. It gives this leg:
  - `Installer.takeOffline(record)` (`src/install/installer.ts:310`, private): detaches the sandbox; on success `record.network = false`; on a throw `record.network = true` and one warning naming `set_project_network`; never throws.
  - `Docker.setNetwork(container, false)` now throws when the daemon does not answer, and returns when the daemon answers and the container is gone.
- The operator's live mcp-everything instance runs from this checkout's `dist/` and `node_modules/`. Never run `npm install`, `npm ci` or `npm run build` here.

Ground truth, read on 2026-11-16 in the working tree after leg 1:

- `installedAt` is set when an install **starts** (`installer.ts:180 — "installedAt: new Date().toISOString(),"`), on a first install and on a reinstall alike, and is stored at once with `status: "installing"`.
- How long one install can run. Every step has a host-side limit: the clone (`docker.ts`, `probe`: 600 s, after an image pull of at most 900 s); per build attempt an image pull (900 s, twice if it falls back to the default image), the container start (120 s), the clean script (300 s) and the recipe (`timeoutSec`, which `install_project` clamps to 7200 at `server.ts:656`, or `cfg.installTimeoutSec`, which `loadConfig` does not clamp). There are at most two attempts (`installer.ts:214 — "const attempts = [choice.image, ...choice.fallbacks.slice(0, 1)];"`). Discovery after the build is bounded by `cfg.helpTimeoutSec` (default 10 s) times a budget of 90 help calls, plus a handful of 60-second execs and up to six MCP probes (15 s to start, then up to ten 30-second pages each). No step is without a host-side limit (`run` kills at `timeoutMs`). The design review added them up: with default settings and steps that behave, everything except the recipe runs is about 3,000 seconds; with **every** limit hit at once it is about 27,000 seconds, more than the seven hours the rule below allows. So the rule covers any realistic install, not every conceivable one. A recipe that times out is not retried (`installer.ts:255`, `unhealthy` excludes `timedOut`), so two full-length recipe runs need the first to fail on its own just under the limit.
- `installedAt` is wall-clock time. A clock that jumps forward (a suspended laptop, WSL2 after sleep) can make a live install look older than it is.
- `App.start()` (`server.ts:391`) is synchronous: it refreshes the registry, logging a failure, and starts the 5-second watcher. `src/index.ts:11` calls it once, before connecting the transport. No test calls `App.start()` today.
- `Registry` (`src/registry.ts`): `put` (`:111`) and `delete` (`:115`) go through the private `mutate` (`:72`), which takes the lock file, re-reads the file, applies one change and renames. There is no way today to change a record based on what the file holds under the lock. `mutate`'s `change` returns nothing that is looked at, and the two arrows passed to it happen to return a `Map` (`put`) and a boolean (`delete`), so a "falsy means skip" convention would silently change `delete` of an absent slug. Nothing depends on `mutate` always writing: `refresh()` compares mtimes, and the watcher only calls `refresh()`.
- `server.ts:717-718` (`project_info`) and `:886-887` (`refresh_mcp`) tell the caller that an `installing` record with no job in this process "was started by another session or was interrupted; reinstall if it does not finish". That stays true for a record that is not yet stale.
- `Installer` already holds `cfg`, `docker` and `registry`. `App` holds the jobs map; at startup it is empty.
- Tests: `test/installer.test.ts` builds an `Installer` over its `ScriptedDocker` (which after leg 1 has `setNetworkFails`, and whose `assertAvailable` is a no-op) and a real `Registry` in a temporary directory. `test/server.test.ts` builds an `App` over `FakeDocker` in `beforeEach`. `FakeDocker.docker` throws if anything reaches the docker binary, so the real `assertAvailable` on a `FakeDocker` throws "Docker CLI … could not be run".
- `README.md:393-397` is where the README says several processes can share a data directory.

## Inputs
- Leg 1 landed, uncommitted, in the working tree. `npx vitest run`: 415 passed, 18 skipped.

## Outputs
- `src/install/installer.ts` — a public method that reconciles stale `installing` records.
- `src/registry.ts` — a guarded write.
- `src/server.ts` — `App.start()` runs the reconciliation in the background.
- `test/installer.test.ts`, `test/registry.test.ts`, `test/server.test.ts` — new cases.
- `README.md` — one or two sentences.

## Acceptance Criteria
- [x] **The rule is one named constant or function with its reasoning in a comment**: a record is stale when its status is `installing` and it is older than `2 × max(7200, cfg.installTimeoutSec) + 10800` seconds, measured from `installedAt` (seven hours with default settings: two build attempts at the longest limit, plus three hours for everything else). A record whose `installedAt` cannot be parsed, or lies in the future, is not stale. The comment says what the rule does not cover: an install in which every step runs to its limit, a neighbor process with a larger `MCPE_INSTALL_TIMEOUT`, and a clock that jumped forward; and that in those cases the live install's own final write restores its record.
- [x] **A stale record is reconciled**: its sandbox is detached through the same path leg 1 uses, and the stored record becomes `status: "failed"`, `network: false`, with an `error` that says the install was interrupted, when it had started, and to reinstall with `install_project(reinstall: true)`. `errorLog` is absent.
- [x] **Everything else is left exactly as it was**: an `installing` record at or under the limit, and `ready` and `failed` records of any age. For these no Docker call is made and the registry file is not rewritten (asserted on the file's `mtimeMs`). A stale record and a fresh one in the same registry: only the stale one changes.
- [x] **Nothing is asked of Docker when no record is stale.**
- [x] **Docker does not answer**: when at least one record is stale and the daemon cannot be reached, no record is changed, one line is logged, and the same records are reconciled by a later start. (A sandbox that could not be confirmed offline is not marked `failed` on that basis.)
- [x] **The detach fails for one record while Docker answers**: that record becomes `failed` with `network: true` and the warning from `takeOffline`; the other stale records are still reconciled.
- [x] **Each record is checked again immediately before its sandbox is detached**: the registry is refreshed and the rule re-applied to what it holds now. If the record is gone, no longer `installing`, or has a different `installedAt`, it is skipped with no Docker call. Shown with a second `Registry` on the same directory replacing the record while the reachability check runs: no `setNetwork` call follows.
- [x] **The write is made from the record as it is under the registry lock**: the stored result is the current record with `status`, `error`, `errorLog` and `network` changed and, if the detach failed, the one warning `takeOffline` added appended to the warnings the record has now. A field another process changed in the meantime (for example `selection`, or a warning it added) survives. If under the lock the record is gone, no longer `installing`, or has a different `installedAt`, nothing is written and the file's `mtimeMs` is unchanged. Shown with a second `Registry` changing the record during the detach. A detach that already ran is not undone in that case; the comment says so.
- [x] `Registry.put` and `Registry.delete` behave exactly as before, including `delete` of a slug that is not there (pinned by a case).
- [x] **Startup**: `App.start()` returns synchronously as before and never throws because of the reconciliation; a failure is logged. The `App` keeps the reconciliation's promise where a test can await it, and that promise never rejects. `shutdown()` and `stop()` do not wait for it. With a stale record in the registry, a started `App` whose reconciliation has been awaited has that record `failed`. With a fresh `installing` record, after the same await, the record and the file's `mtimeMs` are unchanged and no `setNetwork` call was made.
- [x] The README says, next to the passage on shared data directories, that at startup an install left unfinished for more than seven hours (by default) is marked failed and its sandbox taken off the network, that this waits for the next start if Docker is not reachable, and that until then `project_info` reports it as interrupted.
- [x] `npm run typecheck` is clean. `npx vitest run --testTimeout 20000` passes with more than 415 passed and 18 skipped.

## Verification Steps
- `npm run typecheck`; `npx vitest run --testTimeout 20000`. Record the counts.
- The new cases alone: `npx vitest run test/installer.test.ts test/registry.test.ts test/server.test.ts --testTimeout 20000`.
- For the cases "a stale record is reconciled", the re-check before the detach, the write under the lock and "startup": write them first and run them before the implementation, so they are seen to fail. Do not use `git stash` for this: leg 1's `src/` changes are uncommitted in the same files and a stash would take them too. Record which cases were seen to fail.
- By reading (no test can show these): the comment on the rule names what it does not cover, and the comment at the detach says a detach is not undone when the write is skipped.
- Check by reading that no test waits on real time for hours: the method takes the current time as a parameter, and cases build records with `installedAt` computed from it.
- `grep -n "installing" src/server.ts` and read each hit: the texts at `:717-718` and `:886-887` are unchanged and still true.
- `git diff --stat`: only the files under Files Affected, on top of leg 1's.
- No Docker-suite case is added by this leg, and the Docker suite is not run. The detach itself is covered against real Docker by leg 1's case.

## Implementation Guidance

1. **`Registry`**: add one method that changes a record from what the file holds under the lock: `update(slug, fn: (current: ProjectRecord | undefined) => ProjectRecord | undefined): boolean`. Under the lock and after the re-read, it calls `fn` with the current record; a returned record is stored (in the file and in the in-memory map, as `put` does) and the method returns `true`; `undefined` means no change: the file is **not** rewritten and it returns `false`. Do not get there by making `mutate` skip on a falsy return from `change`: `delete`'s arrow returns `false` for an absent slug and `put`'s returns a `Map`. Use a signal that cannot be confused with those (a separate private helper, or an explicit sentinel), and leave `put` and `delete` untouched. After a skipped write the in-memory state must still be the freshly read one. Unit-test in `test/registry.test.ts` with two `Registry` instances on one directory: stored when `fn` returns a record; not rewritten (`mtimeMs`) when it returns `undefined`; `fn` sees a change the other instance made; after a skipped `update`, `get(slug)` equals the other instance's write; `delete` of a missing slug still behaves as before.

2. **`Installer`**: a public method, for example `reconcileStale(now = Date.now(), log: Logger = () => {}): Promise<string[]>`, returning the slugs it changed.
   - `registry.refresh()`, then collect the stale records by the rule. None: return `[]` without touching Docker.
   - `await this.docker.assertAvailable()`. If it throws: log one line naming how many records are waiting, and return `[]`.
   - For each stale record, in turn:
     1. `registry.refresh()` and look the slug up again. Skip it unless it is still `installing` with the same `installedAt` (the reachability check can take 15 seconds and an earlier record's detach up to 90; another process may have reinstalled this one meanwhile).
     2. `await this.takeOffline(copy)` on a copy (`{ ...current, warnings: [...current.warnings] }`). It sets `network` and may add a warning on the copy.
     3. `registry.update(slug, (locked) => …)`: return `undefined` unless `locked` is still `installing` with the same `installedAt`; otherwise return a new object, `{ ...locked, status: "failed", error, errorLog: undefined, network: copy.network, warnings: [...locked.warnings, ...added] }`, where `added` is what `takeOffline` pushed onto the copy (`copy.warnings.slice(current.warnings.length)`). The updater is handed the registry's own object: copy, never mutate.
     4. Log one line per record changed.
   - One record's failure must not stop the others: `takeOffline` never throws, but `refresh` and the registry write can; catch per record, log, continue.
   - The error text, for example: `Install was interrupted: it started at <installedAt> and never finished. Reinstall with install_project(reinstall: true).`
   - Put the staleness rule next to it as a small exported function or constant so the tests can use the same number.

3. **`App.start()`**: after the registry refresh, start the reconciliation without awaiting it and keep its promise in a field a test can read (for example `reconciling: Promise<void>`), with the rejection already caught and logged so the field never rejects. If it changed anything, nothing else is needed: neither `installing` nor `failed` projects publish tools (`listTools` lists `ready` only). Do not add it to the 5-second watcher: the flight's decision is reconciliation at startup. Do not make `shutdown()` or `stop()` await it. `start()` is called once (`src/index.ts`); if it is called again, it does not start a second reconciliation while one is pending.

4. **Tests.**
   - `test/installer.test.ts`, new `describe` (for example "stale installs at startup"), seeding the registry directly with `registry.put({ ...record("x"), status: "installing", network: true, installedAt: … })` (`record` from `test/helpers.ts`): stale → reconciled (assert the `setNetwork` call, the stored fields, the error text); one second under the limit and exactly at it → untouched and `docker.network` empty; old `ready` and old `failed` → untouched; unparsable and future `installedAt` → untouched; a raised `MCPE_INSTALL_TIMEOUT` moves the limit; no stale record → `assertAvailable` not called (count it on the subclass); `assertAvailable` throwing → nothing changed, one log line, and a second call with Docker back reconciles; `setNetworkFails` → `failed`, `network: true`, the warning, and a second stale record still reconciled (`setNetworkFails` counts every call, so number the calls against the seeded records); a stale and a fresh record together; the re-check (the scripted `assertAvailable` uses a second `Registry` to replace the record with a new `installedAt`; expect no `setNetwork` call and the newer record intact); the write under the lock (the scripted `setNetwork` uses a second `Registry` to change `selection` on the record in one case, and to replace the record in another; expect `selection` kept in the first and nothing written in the second; and, with `setNetworkFails` active, a hook that adds a warning through the second `Registry`: expect both that warning and `takeOffline`'s). `ScriptedDocker.assertAvailable` is a no-op today (`test/installer.test.ts`), so counting it, failing it once and hooking it need new fields on that subclass or a local subclass; same for a hook in `setNetwork`.
   - `test/server.test.ts`: two cases through `App.start()`. Await the `App`'s reconciliation promise; do not poll and do not sleep (for the fresh record nothing observable happens, so a poll would pass before the work ran). `start()` uses the real clock, so the fresh record's `installedAt` is `new Date().toISOString()` (the `record()` helper's default, 2026-01-01, is stale). Build the `App` over a small local subclass of `FakeDocker` whose `assertAvailable` resolves (the real one on `FakeDocker` throws; do not change `FakeDocker`). Await the promise before the temporary directory is removed, and call `app.shutdown()` in cleanup so the watcher does not outlive the test.

5. **README**: one or two sentences at `README.md:393-397`.

6. **Flight log**: under Leg Progress, as leg 1 did.

## Edge Cases
- **Two processes start at once and both see the same stale record**: both detach (idempotent) and both try the guarded write; the second finds `status` already `failed` and writes nothing. Correct.
- **A reinstall of the same project starts in another process (or in this one) after the re-check and before the detach lands.** The window is one Docker round trip: the inspect and the disconnect. A reinstall's record is written before it destroys and re-creates the container, so for the detach to hit the new container the round trip must outlast the reinstall's destroy and clone. It cannot be closed without an ownership field. State it in a comment; do not try to close it. If it happens, the write under the lock is skipped, the new install's build may lose its network, and its own final write and `setNetwork` restore the record and the policy.
- **The detach ran and the write was skipped or failed**: the record still says `installing` and the sandbox is offline. Harmless; the next start tries again, and `set_project_network` can turn it back on.
- **The container is gone** (the install died before creating one, or someone removed it): `setNetwork(…, false)` returns, the record becomes `failed`, `network: false`. The volume, if any, is left for the reinstall, which destroys it first. Do not destroy anything in reconciliation.
- **A stale record's sandbox was started online and has since stopped itself** (idle timeout): the detach works on a stopped container.
- **Processes that share a data directory but not `MCPE_INSTALL_TIMEOUT`**: each judges by its own setting. The rule's floor of 7200 covers every `timeout_seconds` a caller can pass; a process with a larger environment default than its neighbor is the uncovered case. Say so in the comment on the rule.
- **`installedAt` on an `installing` record written by an older version**: the field is required by `ProjectRecord` and is set in the record's first `put`. No migration. (Whether an earlier release ever set it differently was not checked; an unparsable value is simply not stale.)

## Files Affected
- `src/install/installer.ts` — `reconcileStale` and the staleness rule
- `src/registry.ts` — the guarded replace
- `src/server.ts` — `App.start()`
- `test/installer.test.ts`, `test/registry.test.ts`, `test/server.test.ts`
- `README.md` — lines 393-397

## Out of Scope
- An ownership field (process id, heartbeat) in the record. If you conclude the leg cannot be made safe without one, stop with `[BLOCKED:needs-registry-field]`: the flight says that goes to the operator.
- Reconciling on the watcher's timer, or on a tool call.
- Destroying containers or volumes of interrupted installs.
- Shutdown (next leg) and `disconnectMcp`.

## Citation Audit
Checked on 2026-11-16 against the working tree after leg 1, each by reading the file: `installer.ts:180`, `:214`, `:255`, `:310`; `server.ts:391`, `:656`, `:717-718`, `:886-887`; `registry.ts:72`, `:111`, `:115`; `src/index.ts:11`; `README.md:393-397`. No drift. The design review walked every step's limit and confirmed that `installedAt` and `status: "installing"` are written only in `install`.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
