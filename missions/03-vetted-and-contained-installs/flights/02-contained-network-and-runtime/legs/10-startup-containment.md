# Leg: startup-containment

**Status**: completed
**Flight**: [Contained Network and Isolation Runtime](../flight.md)

## Objective
When mcp-everything starts with `MCPE_NETWORK=contained`, run DD8's pass over this installation's sandboxes. The pass:
- contains those Docker shows on `bridge` with the record saying on;
- takes off those the record says are off (the fail-safe);
- repairs or replaces contained ones whose session configuration changed;
- stops proxies of stopped sandboxes;
- removes orphaned project proxies and networks, and stale lock files.

No exec into a sandbox runs before that sandbox's step is done. With `MCPE_NETWORK=open` nothing new runs.

## Context
- **Flight DD8**: the table of record × Docker state → action, the per-slug wait, "never loosen", and orphans. Also DD2 (the session label compared at startup only; lock files) and DD15.
- **Leg 7 resolutions**:
  - **9**: `registerStartup(key, promise)` attaches a no-op `catch`. A rejection refuses that sandbox's execs until a later successful `contain` or `replace` clears it. **This leg must register synchronously, before the server accepts tool calls.**
  - **10**: the pass uses `startForContainment` and `Containment`'s and `Docker`'s primitives, **never the hook**.
  - **7**: version rules apply. A newer-version proxy is kept.
- **Leg 7 deviation**: the hook re-inspects after a wait only when something was registered and waited for.
- **The server today.** `App.start()` (`src/server.ts`, around line 584) is synchronous. Its `if (!this.startup)` block runs the file sweeps, `checkRuntimeInBackground`, the reconciliation (not awaited), and `sweepCheckLeftovers`, combined into `this.startup`. Tool calls can arrive as soon as `start()` returns.
- **The registration problem, and its answer.** The set of sandboxes is known only after a Docker listing, which is asynchronous, so per-key promises cannot all be registered synchronously. So this leg adds a **startup gate**:
  - `Containment.registerStartupGate(passPromise)` is called synchronously in `start()`;
  - `waitFor(key)` awaits the key's own promise if one is registered, **else the gate while it is pending**;
  - the pass registers and resolves each key as it reaches it, so a sandbox already handled is not held behind the rest.
- **Legs 6–9** (landed): `setNetwork` modes, `networkState`, `listProjectProxies(sandboxName)`, `removeProjectProxy`, `removeProjectNetwork`, `startForContainment`, `contain`, `replace`, `proxyDiffers`, `projectProxyStatus`, `putKeeping`.

## Inputs
- `src/server.ts` (`start()`, the startup block); `src/network/containment.ts` (`registerStartup`, `waitFor`, `contain`, `replace`, the version rule, the session label, `withProjectLock`, the lock directory); `src/sandbox/docker.ts` (listing this installation's sandboxes by owner label, `networkState`, `setNetwork`, the project proxy and network primitives); `src/registry.ts`; `src/install/installer.ts` (`reconcileStale`, its age floor).
- The flight spec's DD8 table.

## Outputs
- `src/network/startup.ts` (new): the pass, as one function with injected `Containment`, `Docker`, `Registry`, configuration, clock and log.
- `src/network/containment.ts`: `registerStartupGate`; `waitFor` honoring it.
- `src/sandbox/docker.ts`: any listing primitive the pass needs, such as "this installation's sandboxes" (containers with this owner and a project label, and no role) and "this installation's project proxies and networks", each classified.
- `src/server.ts`: the gate and the pass in `start()`, under `contained` only.
- Tests.

## Acceptance Criteria

**Gate and registration:**
- [ ] **Under `contained`**, `start()` calls `registerStartupGate(pass)` synchronously before returning, and `pass` is the pass's promise. Under `open`, nothing is registered.
- [ ] **`waitFor(key)`**:
  - awaits the key's own promise if one is registered;
  - otherwise awaits the gate while it is pending;
  - resolves at once when neither is pending;
  - **a rejected key** refuses (leg 7's rule). **A rejected gate** (the pass as a whole failed, e.g. Docker unreachable) refuses execs into contained-or-unknown sandboxes with "network containment could not be checked at startup: <reason>", until a later successful `contain` or `replace` of that key.
- [ ] **The pass registers each key** before acting on it, and resolves or rejects it when done.

**The pass** (DD8's table, every row a unit case):
- [ ] **Selection**: this installation's sandboxes (owner label = this installation, a project label, no role), by Docker's view, each with its record looked up by repository id. Another installation's are never listed or touched.
- [ ] **For each sandbox**:

| Record | Docker | Action |
|---|---|---|
| `installing`, younger than the reconcile age floor | any | **skip** (resolve the key) |
| on | `bridge` (alone, or with `-net`) | `contain(key)`; on failure, ensure off and **reject the key** |
| on | `-net` only, proxy fine (record label equal) | compare the **session** label; replace if it differs (`replace(…, { compareSession: true })`); keep a newer-version proxy |
| on | `-net` only, proxy stopped, missing, more than one, or record label differs | repair (`replace` or start, as leg 7) |
| on | none | `contain(key)` (the record's "on" is the intent) |
| off | none, no proxy | nothing |
| off | `bridge` | **`setNetwork("off")`, record kept off, warning on the record** (fail-safe) |
| off | `-net` | `setNetwork("off")` (removes the proxy and `-net`) |
| no record | any | the sandbox is left alone; its proxies and `-net` are orphans (below) |
- [ ] **Orphans**: project proxies and `-net`s of this installation whose `mcp-everything.sandbox` label names a sandbox that no longer exists are removed (classified first). Ones whose sandbox exists but has no record are kept: an uninstall may be in flight in another session.
- [ ] **Stopped sandboxes**: their running project proxies are stopped (`docker stop`, classified). They are started again by repair on next use.
- [ ] **Lock files**: `registry.json.proxy-<hash>.lock` files in the data directory whose key has no record are removed, unless their mtime is younger than the lock's stale age (120 s). Never any other file.
- [ ] **Concurrency**: each sandbox's step runs under `withProjectLock` where it changes Docker, at most 4 at a time. The whole pass is bounded (for example 5 minutes). When the bound passes, unfinished keys are **rejected** with "startup containment did not finish", never silently resolved.
- [ ] **Warnings**: a fail-safe take-off, a failed contain and a kept newer proxy each add a bounded record warning (through `putKeeping`) and a startup log line.
- [ ] **Errors from DD15** (address pools) and DD3 (containment unavailable) reject the affected keys with their messages. The pass continues with the others.

**Server wiring:**
- [ ] `start()` under `contained`:
  1. register the gate;
  2. run the pass in the background, after the reconciliation (the pass needs reconciled records);
  3. include it in `this.startup`, so tests can await it;
  4. log one summary line: counts per action.
- [ ] **Under `open`**: no pass, no gate, no new Docker calls; `start()` behaves as today.
- [ ] **Shutdown** does not wait for the pass (as for the reconciliation).

**Docker-gated cases** (the gate before the first run; the volume list saved before):
- [ ] **An open sandbox becomes contained at startup.** A sandbox is created on `bridge` with a record saying on, under the suite's own installation. An `App` with `MCPE_NETWORK=contained` starts. After `startup`, the sandbox is on its `-net` only, with one proxy.
- [ ] **An exec during the pass waits.** An exec issued right after `start()` (before `startup` resolves) completes only after containment, and carries the proxy environment.
- [ ] **A record-off sandbox on `bridge` is taken off**, with a warning on the record.
- [ ] **An orphan proxy and `-net`** (sandbox removed by the test, through the checked helper) are removed by the pass.
- [ ] **The full Docker suite passes.**

**Overall:**
- [ ] `npm run typecheck`, `npm test` and `npm run build` pass. **Under `open`, no existing assertion changes**, except named entries.

## Verification Steps
- **Unit**, on doubles:
  - every table row;
  - the gate with and without per-key promises;
  - a rejected gate;
  - the bound;
  - orphan selection (a sandbox present without a record is kept);
  - lock-file selection (a young file is kept; other files are never touched);
  - concurrency of at most 4;
  - `open` making no calls.
- **The Docker gate**, as in legs 5–9.
- **Trials**. Weaken, confirm a test fails, restore by editing:
  - the gate not registered synchronously, so an exec slips through;
  - the fail-safe row containing instead of taking off;
  - orphans removed when the sandbox exists but has no record;
  - the session label not compared.

## Implementation Guidance
1. `registerStartupGate` and `waitFor`.
2. The listing primitives.
3. `src/network/startup.ts`: the pass, table-driven, with injected clock and log.
4. The server wiring.
5. Unit tests and trials; then stop at the gate.

## Edge Cases
- **A sandbox from before ownership** (no project label): not listed, untouched. Leg 11's README notes it needs a reinstall to be contained.
- **Docker unreachable at startup**: the gate rejects, and execs into sandboxes are refused with the reason until a later successful `contain`. `set_project_network(false)` still works (unhooked).
- **Another session's pass running at the same time**: the project locks serialize the per-sandbox steps. Two passes converge on the same state.
- **A very large number of sandboxes**: bounded concurrency and the overall bound. Unfinished keys reject, then repair on use after a later successful `contain`.

## Design Review 1 Resolutions (binding; they override the text above where they differ)
Flight Director, 2026-11-23. Review: needs rework. Reworked here; a second review follows.

1. **Scope: the housekeeping moves out.** Removing orphan project proxies and networks, stopping proxies of stopped sandboxes, and removing stale lock files are **deferred**: logged as squawk 0052 by the Flight Director. They are destructive cleanup with their own races, not containment.
   - An orphan or idle proxy binds only its internal address and costs memory; a lock file is a few bytes.
   - The rows and criteria above for orphans, stopped proxies and lock files are withdrawn.
   - This leg is **the gate and the containment pass**.
2. **Registration.**
   - The gate (`registerStartupGate`, with a no-op `catch`) is registered synchronously in `start()`, and **covers only the window before the listing finishes**.
   - As soon as the listing returns, **every selected key is registered up front**, before any step runs.
   - Each key is resolved or rejected when its own step ends.
   - When the bound (`STARTUP_PASS_LIMIT_MS = 300_000`, a named constant) passes, **every key still unsettled is rejected**.
   - A sandbox that appears after the listing is not this session's gate's concern: an install in this process contains its own sandbox, and another session's pass covers its own.
   - The gate's copy folded into `this.startup` swallows rejection, as the reconcile does.
3. **A failed gate, and clearing.**
   - `Containment` keeps a set of keys **handled OK** by the pass, and a set **cleared** by a later successful `contain`, `replace` or repair (leg 7's clearing extended to the gate).
   - The hook (`ensureContained`, full mode) changes: when the gate has failed and the key is in neither set, it **refuses only if the fresh facts show `bridge`, `open` or unknown**. An `off` sandbox passes, and a `contained` one without a proxy already fails closed.
   - A rejected gate never refuses a key the pass finished.
4. **One locked step per sandbox**: a public `Containment.startupStep(key, sandboxName)`, so the pass never takes the lock itself and never nests it. Under `withProjectLock` it:
   1. **re-reads the record fresh and inspects the sandbox fresh**;
   2. decides with a **pure** `startupAction(record, facts, sandboxName, now)`;
   3. acts with the lock-free internals: `containLocked`, `repairLocked` (which re-attaches when `ensureProjectNetwork` created the `-net`, T14), and `takeOffLocked`;
   4. clears the key on success.

   The fresh re-read means a `set_project_network(true)` that landed mid-pass is not undone. "Under `withProjectLock`" in the prose above is replaced by this.
5. **`startupAction`, the binding table** (pure; every row a unit case):

| Record | Sandbox name = `record.container`? | Docker (fresh) | Action |
|---|---|---|---|
| none | — | any | leave alone |
| any | **no** (a renamed reinstall's old sandbox, or a twin) | any | leave alone |
| `installing`, not stale (`isStaleInstall`, exported from the installer) | yes | any | skip |
| `network: true` (`ready` or `failed`) | yes | `bridge` (alone or with `-net`), running or stopped | `containLocked` (with `start: false` for a stopped sandbox: the proxy is created and runs, and the sandbox stays stopped) |
| `network: true` | yes | `-net` only | `repairLocked` (record label; plus the **session** label, compared here only; a newer-version proxy kept) |
| `network: true` | yes | none | `containLocked`, with `start: false` if stopped |
| `network: false` | yes | `bridge` | `takeOffLocked`, plus one warning (deduplicated by kind: it replaces an earlier warning of the same kind) |
| `network: false` | yes | `-net` | `takeOffLocked` |
| `network: false` | yes | none | nothing |

   - `containLocked` failing leaves the sandbox off, as leg 7 does, and rejects the key.
   - Repair failing (a busy lock, a slow Docker) **rejects the key without taking the sandbox off**: it is already contained or offline. `contain` is never used for an already-contained sandbox.
6. **Listing primitives (required)**:
   - `Docker.listOwnSandboxes()`: `ps -a --no-trunc --filter label=<owner> --filter label=mcp-everything.project`, then inspect each, dropping any with a `mcp-everything.role` label and any whose owner does not match.
   - It returns `SandboxInspectFacts` with the name. It goes in the coverage lists under `REPORTING`.
7. **Warnings**:
   - added through `putKeeping(record, ["hosts"])`;
   - each kind (`startup-take-off`, `startup-contain-failed`, `startup-kept-newer-proxy`) replaces an earlier warning of the same kind, so warnings do not pile up across startups;
   - each is bounded.
8. **Pre-ownership sandboxes** (no project label) are not listed and stay uncontained under `contained`. This is a **standing gap in DD8's "nothing runs uncontained"**: recorded in the flight log and stated in leg 11's README ("reinstall to contain").
9. **Acceptance additions**:
   - unit cases for:
     - the gate fallback for an unregistered key;
     - a key resolved early while the gate is pending (not held);
     - a rejected gate with a handled key and with a cleared key;
     - the stale-record race (take-off against a concurrent turn-on, resolved by the fresh re-read);
     - a stopped sandbox with a record saying on and on `bridge`;
     - the bound rejecting unsettled keys;
   - a trial: keys not registered up front, so an exec slips through after the pass;
   - Docker case 2's exec targets a key **not yet registered** when it is issued, covering the gate fallback.
10. **The housekeeping Docker case** (orphan proxy and `-net`) is withdrawn with resolution 1.

## Design Review 2 Resolutions (binding; the last cycle; they override everything above where they differ)
Flight Director, 2026-11-23. Review: approve with changes.

1. **Internals to add in `containment.ts`**:
   - `containLocked(lock, subject, { start })`: `replaceLocked`, then `setNetwork("contained")`, then `startForContainment` if `start`. On failure, `setNetwork("off")` **inside the lock**, then throw. **`contain` is refactored onto it**, so there is one code path.
   - `takeOffLocked(subject)`: `setNetwork(sandbox, "off")`, then `invalidate`.
   - `repairLocked` gains a `compareSession` option, used only by the startup step. The T14 attach when `ensureProjectNetwork` reports `created` stays inside it.
   - None of these calls `waitFor`, takes the lock again, or calls a hooked method.
2. **Registration, exactly.**
   - The gate is **its own deferred**, registered synchronously in `start()`.
   - When the listing returns, one synchronous block:
     1. registers **one deferred per key**: per project, not per sandbox, so a twin cannot overwrite it;
     2. **then resolves the gate**.
   - `waitFor` **re-loops** after awaiting the gate, to pick up a key registered meanwhile.
   - A key's deferred is settled only by the step of the sandbox whose name equals `record.container`. A twin's or an old sandbox's step leaves it alone and settles nothing.
   - A key with no matching listed sandbox is resolved at once.
   - **The gate rejects only if the listing itself fails**, so the "handled OK" set is dropped.
   - The **cleared** set stays: a successful `contain`, `replace` or repair clears a gate failure for its key.
3. **The failed gate in the hook.**
   - `waitFor` throws a distinguishable `ContainmentStartupError` with `gate: true`.
   - `ensureContained` (full mode) catches only that, inspects fresh, and then:
     - **refuses** if the sandbox is on `bridge` or `open`, or the inspect fails or is unknown;
     - **passes** an `off` sandbox;
     - **continues into repair** for `contained`.
   - **A per-key rejection keeps leg 7's rule**: it refuses whatever the state, including a sandbox the failed `containLocked` left `off`, until a later successful `contain` (for example `set_project_network(true)`) clears it. This is stated in the code comment.
4. **The proxy image** is ensured **once per pass, outside any lock, memoized**, before any step whose record says on. A pull failure rejects those keys only. `ensureImage` is never called inside `withProjectLock`.
5. **The step's reads never throw for "leave alone" cases.**
   - A peek variant of the fresh record read returns `undefined` for no record and reports a renamed container, so both map to "leave alone", not rejection.
   - A sandbox gone since the listing (the inspect is `undefined`) is "leave alone", and its key is resolved.
6. **The table's last gaps.**
   - A sandbox on `-net` plus a network mcp-everything does not manage (not `bridge`) is **rejected** with the reason "attached to a network mcp-everything does not manage". Conservative: the operator or agent resolves it.
   - **A labelled sandbox with no record** stays uncontained under `contained`: a second standing gap, recorded with the pre-ownership one, and stated in leg 11's README.
7. **The bound.** When it fires, steps not yet started **do not start**, and every unsettled key is rejected. A step that finishes successfully after the bound clears its own key's failure.
8. **Acceptance additions** (binary):
   - a twin case (two listed sandboxes under one key: only the matching one acts, and the key is settled once);
   - image-ensure ordering (no `ensureImage` call while a project lock is held, asserted on the double);
   - the gate wording, as above;
   - **`isStaleInstall` exported** from `src/install/installer.ts`, with a unit case;
   - `startupAction`'s unit cases listed by row id in the test;
   - one log line per rejected key with its reason;
   - the source-scan test confirms `startupStep` uses only unhooked starts.

## Files Affected
- `src/network/startup.ts` (new), `src/network/containment.ts`, `src/sandbox/docker.ts`, `src/server.ts`.
- `src/install/installer.ts` (export `isStaleInstall`).
- `test/startup-containment.test.ts` (new), `test/containment.test.ts`, `test/docker.test.ts`, `test/server.test.ts`, `test/integration/docker.test.ts`.

## Citation Audit
Checked on 2026-11-23 against the working tree (legs 1–9 landed):
- `src/server.ts`: `start()` at about line 584, synchronous; the `if (!this.startup)` block at about line 595 (sweeps, `checkRuntimeInBackground`, reconcile, `sweepCheckLeftovers`).
- `src/network/containment.ts`: `ContainmentStartupError` (about line 71), `registerStartup` (about 335), `waitFor` (about 350), `openUnlessContained` (about 660).

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
