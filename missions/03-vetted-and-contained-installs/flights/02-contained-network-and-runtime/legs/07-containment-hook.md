# Leg: containment-hook

**Status**: completed
**Flight**: [Contained Network and Isolation Runtime](../flight.md)

## Objective
Add `Containment`, the logic above the Docker layer that turns a project's record and the session's configuration into a contained network and proxy. It covers:
- the proxy configuration and its two labels;
- locked replacement;
- containing a project;
- repair;
- the `ensureContained` hook that every exec and every sandbox start passes through, which supplies the proxy environment.

Nothing in the install path or the tools turns containment on yet.

## Context
- **Split from `project-proxy-lifecycle`** at its design review (2026-11-22). Leg 6 (`project-network-primitives`) is the Docker layer this leg builds on.
- **Flight decisions.**
  - **DD2**: the labels, replacement order and locks, the overlap window, repair on use, the hook, the environment from Docker's view.
  - **DD7**.
  - **DD8**: the session label is compared at startup and on change, never on use. The startup pass and its per-slug wait.
  - **DD10**: forwards and aliases.
  - **DD11**: runtime comparison for references.
- **Decisions taken at this leg's design** (Flight Director, from the review; recorded in the flight log):
  1. **The build phase is derived from the record**: `status === "installing"` means build (DD5's build hosts), anything else means run (DD6's sandbox hosts). This is the single source; there is no `phase` parameter. So repair during an install never swaps the wider build proxy for the run proxy mid-build. Leg 8 replaces the proxy explicitly when the install ends.
  2. **`replace` can be forced** (`force: true` skips the label comparison). That is needed after resolver failures.
  3. **The hook receives facts, not a bare reference**: `{ id, name, labels, networks, running }` from one full inspect.
  4. **A per-container-id cache of the hook's answer is mandatory**, used only for an exec on a running sandbox. It expires after 5 s and is invalidated by a Docker-to-Containment callback on `setNetwork`, `destroy` and any replacement. A stale entry fails closed: the old proxy's address has no route once removed.
  5. **`exec` with `restart: false`**, used by cleanup (`McpProxy.kill`, `closeProject` before uninstall), calls the hook in **observe-only** mode: environment only, no repair, no wait.
  6. **The startup pass (leg 10) never goes through the hook.** It calls `Containment`'s and Docker's primitives directly, so it never waits on its own promise.
  7. **Version flapping.**
     - The program version goes in its own label (`mcp-everything.proxy-version`). **A proxy built by a newer program version is never replaced by an older one.** An older session uses it as it is and logs that.
     - The image reference goes only into the session label.
  8. **The lock, guarded**:
     - an overall 90 s deadline on `replace`;
     - the lock file's token is re-read before step 6 (removing the others); if it is no longer ours, the new proxy is removed and the call throws;
     - a caller whose 60 s wait for the lock times out is refused with a clear error. It fails closed;
     - only `replace` takes the mutex; repair calls an inner, lock-free function **while holding it**, so the mutex is never re-entered;
     - the proxy list is re-read inside the lock.
- **Prior legs**:
  - **leg 6**: `ensureProjectNetwork`, `attachProjectNetwork`, `createProjectProxy`, `listProjectProxies`, `removeProjectProxy`, `removeProjectNetwork`, `networkState`, the mode-form `setNetwork`, `SandboxRef.env` and the `name` in facts;
  - **leg 5**: `readUpstreamResolvers`, `invalidateResolvers`, `proxyStatus`;
  - **leg 3**: `proxyConfig`;
  - **leg 1**: `sandboxHosts`, `buildHosts`, the grammar, `localAccessFor`.
- **Project label = repository id** (leg 6). The hook finds the record with the registry's lookup by repository id (case-insensitive). A unit case uses differing case.

## Inputs
- Leg 6's primitives; leg 5's resolvers and `proxyStatus`; `src/registry.ts` (`update`, `get`, the lookup by repository id); `src/server.ts` (construction around line 452); `src/proxy/mcp-proxy.ts` (`kill`, the connect path); `src/install/installer.ts` (`closeProject` before uninstall).

## Outputs
- `src/network/containment.ts` (new).
- `src/sandbox/docker.ts`: `setContainment`, the hook calls, the facts passed, the invalidation callback.
- `src/server.ts`: wiring.
- `test/containment.test.ts` (new), plus cases in `test/docker.test.ts`, `test/server.test.ts` and `test/integration/docker.test.ts`.

## Acceptance Criteria

**The configuration and its labels:**
- [ ] **`buildConfig(record, net)`**:
  - `allow` is `buildHosts(record.ecosystems)` when `record.status === "installing"`, otherwise `sandboxHosts(record.ecosystems)`, plus `record.hosts`, each re-validated in agent mode. An invalid entry is dropped, with a warning returned to the caller;
  - `forwards` is `localAccessFor(cfg, record.repo)`, minus any whose name is `mcpe-proxy` (refused, with a warning);
  - `resolvers` comes from `readUpstreamResolvers()`;
  - `listenCidr` is the `-net`'s subnet.
- [ ] **The labels** are SHA-256 of canonical JSON (sorted keys):
  - `proxy-record` covers the phase, the sorted `allow` and `DEFAULT_HOSTS_VERSION`;
  - `proxy-session` covers the forwards, the resolvers, the `MCPE_EXTRA_HOSTS` mapping and the proxy image reference;
  - `proxy-version` holds `PROXY_PROGRAM_VERSION`.

  They are deterministic: unit cases compute the same label from reordered input.

**Replacement** (`replace(project, { force?, compareSession? })`):
- [ ] **Steps:**
  1. ensure the proxy image (outside the lock);
  2. take the in-process mutex for the project, then the lock file `<dataDir>/registry.json.proxy-<hash of the project id>.lock`, waited for asynchronously (every 100 ms, up to 60 s), stale after 120 s, with a token. On a wait timeout, throw `ContainmentBusyError`;
  3. read the record fresh inside the lock (`registry.update(slug, cur => { captured = structuredClone(cur); return undefined; })`). A thrown registry error is a refusal;
  4. `ensureProjectNetwork`, then `buildConfig`, then **re-list the proxies**;
  5. unless `force`: if exactly one running proxy has an equal record label (and, with `compareSession`, an equal session label), release and stop. A running proxy with a **newer** `proxy-version` is kept and logged, never replaced;
  6. `createProjectProxy` and readiness. On failure, remove the new proxy, keep the old ones, and throw;
  7. **check the token is still ours**, then remove every other project proxy;
  8. release, in a `finally`.

  The whole call is bounded by a 90 s deadline.
- [ ] **Unit cases** with two `Containment` instances sharing a lock directory, standing for two processes:
  - one waits for the other, then sees equal labels and does nothing;
  - a stale lock file (old mtime) is taken over;
  - a stolen token makes the first instance remove its own new proxy and throw;
  - a newer-version proxy survives an older instance's `replace`.

**Containing** (`contain(project)`), the order for leg 8 and leg 10:
- [ ] Under the mutex, in this order:
  1. `ensureProjectNetwork`;
  2. `replace(…)`, inner lock-free form, so a ready proxy exists;
  3. `setNetwork(sandbox, "contained")`, which attaches before leaving `bridge`;
  4. invalidate the hook cache.
- [ ] **On a failure at any step, the sandbox ends on no network** (`setNetwork("off")`), never on `bridge` (DD8), and the error is returned.

**Repair and the hook** (`ensureContained(facts, mode)`, where `mode` is `"full"` or `"observe"`):
- [ ] **No-op cases.**
  - With no hook installed, behavior is today's.
  - If the facts show no network, or anything `networkState` calls `"open"`, it returns no environment and changes nothing.
- [ ] **When contained** (`"full"` mode):
  1. await the project's startup promise (`waitFor`), which is resolved unless leg 10 registers one. A rejected promise refuses the exec with its reason;
  2. **check the `-net` exists by `network inspect`** (T14); if missing, `ensureProjectNetwork` and `attachProjectNetwork`, under the mutex;
  3. list proxies: if there is none, more than one, or one with a differing **record** label (never the session label), `replace` (lock-free inner form under the mutex). If one is stopped, start it and wait for readiness;
  4. if the proxy reports `resolverFailures >= 3` (read only on a cache miss, at most once a minute per project), `invalidateResolvers()` and `replace(…, { force: true })`;
  5. return the proxy environment (`HTTP_PROXY`, `HTTPS_PROXY`, the lower-case forms, `NO_PROXY=`, `NODE_USE_ENV_PROXY=1`, all `http://mcpe-proxy:3128`).
- [ ] **`"observe"` mode** returns the environment if contained and does nothing else.
- [ ] **The record is found by the project label** (the repository id). If there is no record, it returns no environment and does nothing: leg 10's pass removes orphans.

**The Docker class's calls** (`src/sandbox/docker.ts`):
- [ ] **`setContainment(hook, invalidate)`.** `acquire`, `ensureRunning` (name or reference), `startIfStopped` and `exec` (name or reference) each make one full inspect, pass the facts to the hook, and only then start or exec.
  - `exec` with `restart: false` passes `"observe"`.
  - `acquire` returns a `SandboxRef` carrying the hook's environment.
  - `exec` merges as leg 6 defined (the reference's environment wins).
- [ ] **The cache** (decision 4) applies only to `exec` on a running sandbox. `setNetwork`, `destroy` and `Containment` replacements call `invalidate(id)`.
- [ ] **The runtime comparison** (leg 2) is applied from the same facts for references too.
- [ ] **No recursion.** The hook and everything it calls use only non-hooked primitives. A unit test counts hook entries during a repair and asserts one.
- [ ] **No bypass.** Every `Docker` method is listed in a hook-guarded table or a documented "not a sandbox start or exec" table: proxy creation, `proxyStatus`, one-shots, the runtime trial, and inspection. The test asserts:
  - the union equals `Object.getOwnPropertyNames(Docker.prototype)`;
  - a source scan finds every `"start"` and `"exec"` Docker verb in `docker.ts` inside a listed method.

  A new path fails the test by name.

**Wiring** (`src/server.ts`):
- [ ] `App` constructs `Containment(cfg, registry, docker, { dataDir: cfg.dataDir })` and installs it.
- [ ] `Containment.registerStartup(project, promise)` exists for leg 10. Unit cases cover its wait and rejection.
- [ ] **Cost under `open`**: the unit double counts Docker calls per exec. With the cache, a run of 10 execs on a running, non-contained sandbox makes at most 1 extra inspect per 5 s. The flight log states the measured count.

**Docker-gated cases** (the gate before the first run; the operator's ids before and after):
- [ ] **Two contained projects cannot reach each other**. There are two sandboxes, each contained through `contain` with records in a test registry. A `node -e` prober in A cannot connect directly to B's address, and a `CONNECT` to B's address through A's proxy gets `403`. Positive control: two open sandboxes on `bridge` reach each other.
- [ ] **Replacement without a reinstall**: add a host to A's record, then `replace`. A `CONNECT` to that host through `mcpe-proxy` succeeds, and exactly one proxy remains. Which proxy answered during the overlap is recorded, not asserted.
- [ ] **Repair**:
  - the proxy removed by hand, then `exec` into A: a new proxy, and the exec had the environment;
  - A stopped and its `-net` removed, then `acquire` A: the `-net` is recreated, and A runs, contained.
- [ ] **Build phase**: a record with `status: "installing"` is contained with build hosts (`registry.npmjs.org` for a Node record). An exec during that state does not replace the proxy.
- [ ] **The full Docker suite passes** after the go-ahead.

**Overall:**
- [ ] `npm run typecheck`, `npm test` and `npm run build` pass.

## Verification Steps
- `test/containment.test.ts` on the double: the configuration, the labels, every replacement step and guard, two-instance locking, `contain`'s order and failure, repair's order, observe mode, resolver failures, startup wait and rejection, the version rule, and case-insensitive lookup.
- `test/docker.test.ts`: the hook's placement, the bypass enumeration and source scan, the recursion count, the cache and its invalidation.
- **The Docker gate**, as in legs 5 and 6.
- **Trials**. Weaken, confirm a test fails, restore by editing:
  - repair comparing the session label;
  - replacement removing others before readiness;
  - the hook skipped in `startIfStopped`;
  - the phase derived as "run" during `installing`;
  - the token check removed.

## Implementation Guidance
1. Configuration and labels (pure).
2. Locks: mutex plus file, async wait, staleness, token.
3. `replace` and its inner lock-free form; `contain`.
4. Repair and `ensureContained`, with observe mode.
5. The Docker class's hook installation, facts, cache and invalidation; the bypass and recursion tests.
6. Server wiring and the cost count.
7. Unit tests and trials, then stop at the gate.

## Edge Cases
- **A sandbox with no project label** (from before ownership): no environment, nothing done.
- **A registry that cannot be read** during `replace`: refuse. During the hook: no environment, and the exec proceeds uncontained **only if** the facts say not contained. If contained, refuse, because a contained sandbox without a proxy environment has no route anyway.
- **The proxy image cannot be pulled**: `replace` throws before the lock, and nothing changes.
- **A one-shot `runBehindProxy`** never goes through `Containment`: it is not a project.

## Design Review 2 Resolutions (binding; they override the text above where they differ)
Flight Director, 2026-11-22. The last design cycle: approve with changes. Each item answers one of the review's issues.

1. **The session's network mode drives the hook's order** (DD8: nothing runs uncontained meanwhile).
   - `Containment` is given `cfg.network.mode`.
   - **Under `contained`**, the hook **first** awaits `waitFor(key)`, which resolves at once if nothing is registered. It then **re-inspects**, and only then branches on the fresh facts, including the `open` no-op.
   - **Under `open`**, it never waits, never loosens, and returns the environment if the fresh facts say contained.
   - Unit cases cover a legacy `bridge` sandbox under `contained` (it waits, then sees the pass's result) and an `open` session.
2. **One lock path.** `withProjectLock(key, fn)` takes the in-process mutex **and** the lock file together.
   - `replace`, repair and `contain` all run inside it. "Inner" functions assume their caller holds both, and say so in their names (`…Locked`).
   - Releasing deletes the lock file **only if its token is still ours**.
   - Unit case: two instances repairing the same project at once end with exactly one proxy.
3. **The project network is part of the record label.** It includes the `-net`'s id and subnet, so a recreated network changes the label and forces replacement. Step 5's match also requires that the matching proxy is attached to the current `-net` with the `mcpe-proxy` alias. The Docker-gated case "`-net` removed, then `acquire`" asserts that a `CONNECT` to an allowed host works afterwards.
4. **The install's end, the contract for leg 8.**
   - **Discovery runs under the build hosts**: the record is `installing` through `finishInstall`'s `discover`. Accepted and stated; discovery is part of the install.
   - At the end, leg 8 calls, in order: `registry.put(ready)`, then `containment.replace(key)` (the record now says run), then `invalidate`.
   - **A sandbox whose name is not the record's `container`** (the old sandbox of a renamed reinstall, or a stale one) gets **observe-only** treatment: the environment if contained, no repair, never the record's configuration.
5. **Keys.**
   - Docker objects are keyed by the sandbox's project label **verbatim** (from the facts) **plus the sandbox name**. Leg 6 adds a `mcp-everything.sandbox=<name>` label to project proxies and networks, and `listProjectProxies(project, sandbox)` filters by both, so a left-in-place twin's proxy is never removed.
   - The mutex, lock file, startup promises and cache groups are keyed by the **lower-cased** repository id.
   - The hook calls `registry.refresh()` before `findByRepo` (`src/registry.ts`); a throw falls under the unreadable-registry rule.
6. **The bypass test**, built with the TypeScript compiler API (`typescript` is a dev dependency), not regex. It:
   - enumerates `Docker`'s methods **and** class-field functions;
   - finds every call site of `startId`, `execOnce`, `startIfStopped`, `ensureRunning` and `this.docker(` with a verb in `start`, `exec`, `run`, `restart`, `unpause` or `attach`;
   - requires each caller to be in the hook-guarded table or one of the two documented tables ("not a sandbox start or exec"; "unhooked by design, containment-internal");
   - scans `src/**` for other uses of `cfg.docker.bin`. Only `dockerConnector` is expected; it is documented as depending on `acquire`'s environment, and listed.
7. **Versions.**
   - The `proxy-version` label is compared **before** `buildConfig` (no resolver one-shot for a newer proxy). A "kept newer" result is remembered for 60 s, and logged once per process per project.
   - **`force` does not override the version rule.** Step 7 never removes a newer-version proxy.
   - A missing or unparseable version label counts as **0** (oldest).
   - **Stated**: an older session runs under the newer proxy's allowlist, and hosts it adds through the record apply only when a session at least as new repairs. The way out is a newer session, `set_project_network` off, or uninstall.
   - `PROXY_PROGRAM_VERSION` covers the program, including its refused-range table. That is why DD2's separate range-table version is not repeated in the record label; a deliberate, stated departure.
8. **The cache is owned by `Docker`**, keyed by container id, with each entry also storing the sandbox name and project key.
   - `invalidate({ id?, sandbox?, key? })` clears matching entries, and a generation counter discards a hook result that was in flight across an invalidation.
   - It is read and written only when the inspect said `running`. `startIfStopped` never uses it, and the retry after a restart uses `startIfStopped`'s fresh hook result.
   - The cost target is about execs by reference; by name, the inspect already happens.
   - **Staleness, stated precisely**: up to 5 s with no environment after another process contains the sandbox (fails closed), or with an environment naming `mcpe-proxy` after another process opens it (a harmless, broken proxy setting on an open sandbox).
9. **The startup wait and errors.**
   - `registerStartup(key, promise)` attaches a no-op `catch` at once.
   - `waitFor` with nothing registered resolves at once.
   - **A rejection refuses that sandbox's execs until a later successful `contain` or `replace` for that key clears it**, or until the session restarts. `set_project_network` off is unhooked and still works.
   - Leg 10 must register every promise **synchronously**, before the server accepts tool calls.
   - **Errors**: a base `ContainmentError` with subclasses `ContainmentBusyError` (lock wait), `ContainmentDeadlineError`, `ContainmentLockLostError` (token), `ContainmentUnreadableError` (registry) and `ContainmentStartupError` (a rejected startup step). `closeProject` and `kill` keep swallowing.
10. **An unhooked start for the pass and for `contain`**: a public `startForContainment(name)` on `Docker`, classified as this installation's, is listed in the "unhooked by design" table. Only `Containment` calls it; a source-scan rule enforces this.
11. **The deadline and the lifecycle.**
    - The 90 s deadline starts **after** the lock is acquired, so image pulls are outside it, and it is measured on a monotonic clock (`performance.now()`).
    - The new proxy's name is generated before `create`. On the deadline, or any failure, it is removed by name in a `finally`.
    - The mutex wait is bounded by the holder's deadline.
    - The token re-check comes **before step 7** (removing the others). Decision 8 in Context means this step.
12. **Observe mode** ignores the record. A contained sandbox with **no record**, in full mode, gets **no environment**: the exec proceeds with no route, so it fails closed. This is stated in a comment.
13. **Leg 6's public pieces** (leg 6, design review 2) are what this leg uses:
    - `listProjectProxies(sandboxName)`;
    - `projectProxyStatus(id)`, for `resolverFailures`;
    - `startProjectProxy(id)`, which accepts any version string, so a kept newer proxy can be started;
    - `ensureProjectNetwork(…)` returning `{ id, subnet, created }`; repair re-attaches the sandbox when `created`;
    - the `SandboxInspectFacts` type for the hook.

    T15 holds for leg 8: sandboxes are created on `bridge` and moved before their first start.
14. **More acceptance cases**:
    - the deadline;
    - `ContainmentBusyError`;
    - the cache's TTL and its invalidation by `setNetwork` and `destroy`;
    - the generation race;
    - a stopped proxy started by repair;
    - the once-a-minute resolver gate (a genuine resolver outage therefore causes at most one replacement a minute per project, accepted);
    - a newer proxy surviving step 7;
    - an unreadable registry refusing a contained sandbox;
    - observe mode making no listing calls;
    - `setNetwork` and `contain` not re-entering the hook (the recursion count).

## Files Affected
- `src/network/containment.ts`: new.
- `src/sandbox/docker.ts`, `src/server.ts`.
- `test/containment.test.ts` (new), `test/docker.test.ts`, `test/server.test.ts`, `test/integration/docker.test.ts`.

## Citation Audit
Checked on 2026-11-22. The review's facts, spot-checked by the Flight Director:
- `registry.update(slug, () => undefined)` re-reads and does not write;
- `Registry.dir` is private, so `dataDir` is passed in;
- `McpProxy.kill` and the uninstall's `closeProject` use `exec(…, { restart: false })`;
- `startIfStopped` takes an id;
- the project label holds the repository id.

T14 and leg 6's primitives as designed.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
