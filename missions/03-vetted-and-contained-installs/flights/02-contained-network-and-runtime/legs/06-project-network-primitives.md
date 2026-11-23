# Leg: project-network-primitives

**Status**: completed
**Flight**: [Contained Network and Isolation Runtime](../flight.md)

## Objective
Add the Docker-layer pieces a project's contained network needs, with no policy and no hook. They are:
- a project network and project proxies (create, list, remove);
- a three-way `networkState`;
- a three-mode `setNetwork`;
- exec and connector environment plumbing;
- removal of a project's proxies and network with its sandbox;
- the one-shot anonymous-volume fix.

With `MCPE_NETWORK=open`, behavior is today's.

## Context
- **Split from `project-proxy-lifecycle`** at its design review (2026-11-22). That review found the Docker layer and the containment logic were two kinds of risk. This leg is the Docker layer; leg 7 (`containment-hook`) is the logic and the hook.
- **Flight decisions.** DD2 (names, roles, hardening, no idle-out), DD7 (three states, "off" removes everything), DD10 (`--add-host … host-gateway`, aliases), DD5 (the environment).
- **The project label is the repository id** (`github:owner/name`), as sandboxes already carry it (`createContainer({ project: params.repo.id })`, `src/install/installer.ts`). Proxies and networks carry the same value, so one namespace serves the sweep's "has a project label" rule and the listings (design review).
- **T14** (Flight Director trial, Docker Desktop, 2026-11-22):
  - a stopped container whose network was removed keeps that network's name in `NetworkSettings.Networks`;
  - `docker start` then fails: "network … not found";
  - recreating the network under the same name, then `network disconnect -f` and `network connect`, then `start`, works.

  So a missing project network is detected by `network inspect` of its name, never by the sandbox's network list.
- **The one-shot volume fix** (Flight Director, after leg 5). `alpine/git` declares `VOLUME /git`, and `runOnce` removes one-shots with `rm -f`, leaving an anonymous volume each time. `rm -f -v` removes only anonymous volumes, never a mounted named volume.
- **Prior legs**:
  - **leg 5**: `createContainedNetwork({ role, name?, project? })`, `proxyStatus`, the readiness loop in `runBehindProxy`, `ProxyStartError`, and the network "not found" match;
  - **leg 3**: `proxyConfig`, `proxyLaunchArgs`;
  - **leg 2**: the runtime comparison.

## Inputs
- `src/sandbox/docker.ts`: `SandboxRef`/`makeRef`, the inspect formats, `inspectContainer`, `acquire`, `exec`/`execOnce`/`startIfStopped`, `ensureRunning`, `hasNetwork`, `setNetwork`, `destroy`, `removeContainer`, `runOnce` teardown, `createContainedNetwork`, `runBehindProxy`'s readiness.
- `src/proxy/mcp-proxy.ts`: `dockerConnector`.
- `src/install/installer.ts` (`setNetwork` at the network-policy step and in `takeOffline`); `src/server.ts` (`set_project_network`).
- `test/helpers.ts` (`FakeDocker`, its `setNetwork` override around line 110), `test/installer.test.ts` (around lines 102–108), `test/server.test.ts`, `test/docker.test.ts` (the double, strict-mode verbs, the coverage lists, the network cases around lines 792, 880–895 and 908).

## Outputs
- `src/sandbox/docker.ts`: the primitives below.
- `src/proxy/mcp-proxy.ts`: the connector's environment.
- `src/install/installer.ts`, `src/server.ts`: callers moved to the mode form.
- Tests across `test/docker.test.ts`, `test/helpers.ts`, `test/installer.test.ts`, `test/server.test.ts`, `test/proxy.test.ts` and `test/integration/docker.test.ts`.

## Acceptance Criteria

**The one-shot volume fix:**
- [ ] **One-shots are removed with `rm -f -v`**, by id, in `runOnce`'s teardown and timeout path, and in `runBehindProxy`'s teardown of the one-shot and the proxy. A unit case asserts the arguments.
- [ ] **A Docker-gated case** shows that a probe-image one-shot leaves no anonymous volume. It compares the set of `docker volume ls -q` before and after, filtered to volumes created inside the case's time window (`docker volume inspect` `CreatedAt`), not by count.

**Inspect facts:**
- [ ] The inspect formats add `"name":{{json .Name}}`, with Docker's leading `/` stripped. `ContainerFacts` gains an optional `name`.
- [ ] Parsing tolerates the field's absence in scripted test output.

**Project network and proxy primitives** (all owned and classified; none called by production code yet):
- [ ] **`projectNetworkName(sandbox)`** is `<sandbox name>-net`.
- [ ] **`ensureProjectNetwork(sandbox, project)`**: `network inspect` by name.
  - If it is absent, create it through `createContainedNetwork({ role: "project-net", name, project })`.
  - If it is present with this owner, role `project-net` and project, **adopt it** (return its id and subnet). This also covers losing a creation race: Docker's "already exists" means inspect and adopt.
  - If it is present but someone else's, refuse with `SandboxRefusedError`.
- [ ] **`attachProjectNetwork(sandbox, net)`**: `network disconnect -f <net> <id>` (its failure ignored), then `network connect <net> <id>` (T14).
- [ ] **`createProjectProxy(sandbox, project, config, labels)`**:
  - name `<sandbox name>-proxy-<hex>`; role `project-proxy`; owner and project labels;
  - the caller's configuration labels (leg 7 computes them);
  - hardened as leg 5's one-shot proxy, plus `--add-host host.docker.internal:host-gateway`;
  - `network connect --alias mcpe-proxy` and one `--alias <name>` per forward target, before `start`;
  - then `start` and readiness (leg 5's loop, factored into a shared private method);
  - no `--rm`, no restart policy.

  **An alias equal to `mcpe-proxy` is refused** (a unit case). On failure it removes what it created and throws `ProxyStartError`, or leg 2's runtime error.
- [ ] **`listProjectProxies(project)`** returns `{ id, name, running, labels }` for every container with role `project-proxy`, this owner and that project label, found by label filters and checked from the inspect.
- [ ] **`removeProjectProxy(id)`** runs `rm -f -v` by id, after classifying it as this installation's project proxy.
- [ ] **`removeProjectNetwork(net)`** runs `network rm` by id, after classifying it. "Not found" counts as success.

**`networkState`** (replacing `hasNetwork`; its tests are renamed, not deleted):
- [ ] **It is computed from one inspect of the sandbox**:
  - no networks → `"off"`;
  - only its own `-net` → `"contained"`;
  - **anything else** (`bridge`, `bridge` plus `-net`, another network) → `"open"`;
  - a missing container → `"off"`, as `hasNetwork` gave `false`.
- [ ] `"contained"` means only that the sandbox is listed on its own network. Whether that network exists is the caller's to check (T14).

**`setNetwork(target, mode)`**, with `mode` `"off" | "contained" | "open"`, replacing the boolean signature:
- [ ] **`off`** disconnects every network the container is on (`disconnect -f` each). Only when a `-net` was among them, it then removes the project's proxies and the `-net`. A sandbox on `bridge` alone or on nothing makes exactly today's calls (short-circuit), so existing call-sequence tests hold.
- [ ] **`open`** behaves as today when the sandbox is on `bridge` or nothing: `connect bridge`. If it is on `-net`, it first removes the proxies and the `-net`.
- [ ] **`contained`** requires the project network to exist (`ensureProjectNetwork`, else throw). It runs `attachProjectNetwork` before `disconnect bridge` (if on it), so the sandbox is never left with no network while it should be contained. The proxy is not this method's job (leg 7).
- [ ] **Callers.**
  - `installer.ts`'s network-policy step passes `wantNetwork ? "open" : "off"`; `takeOffline` and the reconcile path pass `"off"`.
  - `server.ts`'s `set_project_network` passes `enabled ? "open" : "off"`.
  - Leg 7 and later legs add `"contained"`.
  - `FakeDocker.setNetwork` in `test/helpers.ts` and the recorded network pairs in `test/installer.test.ts` and `test/server.test.ts` move to the mode form. These are deliberate test changes, each listed in the flight log.

**Removal with the project:**
- [ ] **`destroy(container, volume)`**:
  - also lists the project's proxies (by the container's project label) and its `-net`, and classifies all of them with the container and volume, all or nothing as today;
  - **order**: container, then proxies, then `-net`, then volume.
- [ ] **`removeContainer` does not remove proxies or the `-net`**: the installer uses it between build attempts (`buildAttempts`), and DD7 keeps the network and proxy across attempts (design review).

**Environment:**
- [ ] **`ExecOptions.env?: Record<string, string>`**: `execOnce` adds `-e NAME=value` before the container id, with names `^[A-Za-z_][A-Za-z0-9_]*$` and values without a newline or NUL.
- [ ] **`SandboxRef` gains an optional `env`**, a frozen copy. `exec(ref, …)` merges `{ ...opts.env, ...ref.env }`, so **the reference's environment wins**: leg 7 puts the proxy variables there, and a caller's `env` cannot remove them. A unit case covers this.
- [ ] **`dockerConnector`** adds `-e` flags for `sandbox.env` before the id, separate from the secrets `--env-file`. A test shows the argv order: `--env-file` first, then `-e`, which Docker applies last.

**Coverage and the double:**
- [ ] Every new `Docker` method, private ones included, is in exactly one of `CASES`, `NOT_GUARDED` and `REPORTING`. Methods acting on classified objects are guarded (`CASES`); those acting only on what they created go in `NOT_GUARDED`.
- [ ] The double answers the new verbs: `network inspect` by name, `network disconnect -f`, `ps` filters for project proxies, and `rm -f -v`.

**Docker-gated cases** (the Flight Director's gate before the first run; the operator's ids before and after):
- [ ] **Network modes**: with a project network and a proxy created by these primitives (a fixed test configuration and labels), `setNetwork(sandbox, "contained")` puts it on `-net` only; `"open"` puts it on `bridge`, with the proxy and `-net` gone; `"off"` leaves it on nothing.
- [ ] **T14 in code**: stop the sandbox, remove its `-net`, then `ensureProjectNetwork` plus `attachProjectNetwork` lets it start, on `-net`.
- [ ] **`destroy` of a contained project** leaves no container, proxy, `-net` or volume of it.
- [ ] **The volume fix**, as above.
- [ ] The full Docker suite passes after the go-ahead (it also owes leg 5's full green run).

**Overall:**
- [ ] `npm run typecheck`, `npm test` and `npm run build` pass. The changed tests are listed by name in the flight log, each with its reason.

## Verification Steps
- Unit cases for every criterion, on the double.
- `npm run typecheck`, `npm test`, `npm run build`.
- **The Docker gate**:
  1. stop after unit work, with `[BLOCKED:docker-gate]`;
  2. report the cases;
  3. record the ids;
  4. after the go-ahead, run the full suite and record the ids again.
- **Trials**. Weaken, confirm a test fails, restore by editing:
  - `rm -f` without `-v`;
  - `destroy` removing the network before the proxies;
  - `contained` disconnecting `bridge` before attaching;
  - the reference's environment losing to the caller's.

## Implementation Guidance
1. `rm -f -v`.
2. The `name` field in the inspect facts.
3. The primitives, with the double extended.
4. `networkState` and the mode-form `setNetwork`; move the callers and the fakes.
5. `destroy`.
6. The environment: exec, `SandboxRef`, the connector.
7. Unit tests and trials; then stop at the gate.

## Edge Cases
- **`destroy` when the project label is missing** (a sandbox from before ownership): there are no proxies to list, so behavior is today's.
- **Adopting a `-net` whose project label differs** (a slug reused by another repository): refuse, and do not adopt.
- **`network disconnect -f` on a network the container is not on**: the error is ignored.
- **`setNetwork("open")` on a contained sandbox whose proxy removal fails**: throw before connecting `bridge`. Never leave a sandbox on `bridge` with its contained objects half removed.

## Design Review 2 Resolutions (binding; they override the text above where they differ)
Flight Director, 2026-11-22. The last design cycle: approve with changes. Two trials answered the review's questions (Docker Desktop, throwaway `mcpe-plan-<n>` objects, all removed):
- **T14b**: `network disconnect -f <removed network> <stopped container>` exits 0, and the network leaves the container's list. A container *created* with `--network <that network>` still cannot start ("could not find a network matching network mode"), because its `HostConfig.NetworkMode` names it.
- **T15**: a container created with `--network bridge` (not started), then `network connect <internal>`, then `network disconnect bridge`, then `start`, runs on the internal network only. After `stop`, `disconnect -f`, `network rm` and `start`, it runs on **no network**, and stays so across `restart`.
  - **Rule for leg 8**: a contained sandbox is created on `bridge`, moved to its `-net` before its first start, and never created with `--network <-net>`.

1. **`setNetwork` semantics, exactly:**
   - **`off`.**
     - If the sandbox is on `bridge` only, or on nothing: **today's calls exactly**. That means `network disconnect bridge <id>` without `-f` when on `bridge`, and nothing otherwise. So `test/docker.test.ts:494`, `:785` and `:886` hold.
     - Only when a `-net` is listed: `disconnect -f` each listed network, then remove the project's proxies, then `-net`.
     - "Not found" and "not connected" are ignored for a disconnect. Any other failure throws ("Failed to disable network …"), as today.
   - **`open`.**
     - On `bridge` (alone or with others): a no-op, as today (`connected === enabled`).
     - On `-net`: remove proxies, `disconnect -f -net`, `network rm -net`, then `connect bridge`, in that order.
     - On nothing, or on a foreign network only: `connect bridge`. Foreign networks are left alone.
   - **`contained`** never creates. It does a name-keyed `network inspect` of `-net` and runs the shared check (item 6). If the network is absent or foreign, it throws. Then it runs `attachProjectNetwork`, then `disconnect bridge` if on it. Proxies are leg 7's.
2. **Finding a project's proxies needs no container and no label from it.**
   - Proxies are listed with `ps -a -q --no-trunc --filter label=<owner> --filter label=mcp-everything.role=project-proxy`, then kept only if the inspect's `name` matches `^<sandbox name>-proxy-[0-9a-f]{8}$`.
   - Proxies and `-net` also carry `mcp-everything.sandbox=<sandbox name>` and the project label, checked second.
   - `listProjectProxies(sandboxName)` takes the sandbox name, so a left-in-place twin with the same repository id is never touched. `setNetwork` and `destroy` use the same listing; the container may already be gone.
3. **`destroy`.**
   - It classifies the container, the volume, the listed proxies and the `-net` found by name, **all before any removal**. That keeps the existing "last inspect before first `rm`" pin (`test/docker.test.ts:943`), widened to the new calls.
   - **A foreign or label-less network named `<sandbox>-net` refuses the whole destroy**: all or nothing, consistent with mission 02.
   - `SandboxFacts.kind` gains `"network"` and `"proxy"`. `describeLeft`, the left-in-place warning and the uninstall output name them; the tests at `:925`–`:935` gain the new kinds deliberately.
   - The order is container, proxies, `-net`, volume.
   - Under `MCPE_NETWORK=open`, `destroy` now also makes the `ps` listing and the `network inspect`. That is a deliberate change: the call-sequence tests are updated and listed in the flight log. "None called by production code" is withdrawn: `setNetwork` and `destroy` call the listing and removals.
4. **Public pieces leg 7 needs**:
   - `projectProxyStatus(id)`, a public wrapper of `proxyStatus`, which stays private;
   - `startProjectProxy(id)`: `start`, then readiness;
   - `ensureProjectNetwork(…)` returns `{ id, subnet, created }`;
   - an exported `SandboxInspectFacts` type `{ id, name, running, labels, networks, runtime }`, the shape the hook receives.
   - **Readiness's version check**: proxies this session creates must report `version === PROXY_PROGRAM_VERSION`. `startProjectProxy` accepts any version string, so an older session can start a newer proxy it keeps (leg 7 resolution 7).
5. **The environment.**
   - `execOnce` takes an already-merged environment. For `exec` by name, leg 7's hook result merges the same way, and the retry after `startIfStopped` reuses it.
   - **`ExecOptions.env` is not for secrets**: values are visible in `ps`. The doc comment says so.
   - The connector's `-e` flags go through the same validator as `execOnce`'s; one shared function.
   - **Wording**: Docker gives `-e` precedence over `--env-file` regardless of flag order. The test pins the order only as documentation.
6. **The fixed-name network.**
   - The DD3 verification block in `createContainedNetwork` is factored into `checkContainedNetwork(inspect, expect)`, used for creation **and** adoption: internal, no IPv6, one IPv4 subnet, no gateway, plus owner, role and project.
   - When a name is supplied, a failed or timed-out create **re-inspects by name**. If the network is ours and passes, adopt it ("already exists" included). Otherwise throw, and **never remove by name**: with a fixed name, that could remove a racing creator's network.
7. **Coverage**:
   - `networkState` replaces `hasNetwork` in `CASES` (`:728`), the EIGHT list (`:756`) and the name-resolution describe.
   - `listProjectProxies` and `projectProxyStatus` go in `REPORTING`.
   - `ensureProjectNetwork`, `attachProjectNetwork`, `createProjectProxy`, `startProjectProxy`, `removeProjectProxy`, `removeProjectNetwork` and `checkContainedNetwork` go in `NOT_GUARDED`, each with the reason "acts only on objects it creates, or classifies itself by owner, role and name".
   - The "every command names a 64-char id" test (`:1423`–`:1448`) checks network arguments only for `connect`, `disconnect` and `rm`, and its `exec` parsing skips `-e` pairs.
8. **The double** (`test/docker.test.ts`, around lines 190–250) gains:
   - per-network membership (not a single `["bridge"]` flag);
   - the inspect `name` field;
   - `network disconnect -f` and `network connect <net>`;
   - `ps` with label filters;
   - an active-endpoint refusal on `network rm`, so the removal order is testable.
9. **The tests to move are enumerated** in the flight log, from this review:
   - `docker.test.ts`: `:468`–`:501`, `:729`, `:756`, `:785`, `:792`, `:801`–`:804`, `:870`–`:873`, `:880`–`:895`, `:908`, `:925`–`:943`, `:1115`, `:1132`, `:1164`, `:1222`, `:1432`, `:2442`–`:2450`;
   - `installer.test.ts`: `:103`, `:764`, `:834`, `:841`, `:893`, `:937`, `:1365`, `:1398`;
   - `server.test.ts`: `:166`, `:1287`, `:1522`, `:1538`;
   - `helpers.ts`: `:110`;
   - integration: `:500`, `:523`, `:590`, `:595`, `:599`, `:613`, `:616`, `:619`. Their boolean `hasNetwork` use maps to `networkState(…) !== "off"`.

   Each is moved by edit, not by delete-and-re-add.
10. **The volume fix, precisely.**
    - The timeout path removes **by name** (no id exists yet) with `rm -f -v <name>`.
    - `dropContainer`, the proxy teardown, gains `-v`.
    - `--rm` already removes anonymous volumes on a normal exit. So the Docker-gated volume case uses a **timed-out** probe-image one-shot (where the explicit `rm` does the work) and asserts no new anonymous volume.
    - One trial runs it with plain `rm -f`, to show the case can fail.

## Files Affected
- `src/sandbox/docker.ts`, `src/proxy/mcp-proxy.ts`, `src/install/installer.ts`, `src/server.ts`.
- `test/docker.test.ts`, `test/helpers.ts`, `test/installer.test.ts`, `test/server.test.ts`, `test/proxy.test.ts`, `test/integration/docker.test.ts`.

## Citation Audit
Checked on 2026-11-22 against the working tree (legs 1–5 landed). These come from leg 6's first design review and were spot-checked by the Flight Director:
- `src/install/installer.ts`: `createContainer({ … project: params.repo.id })`, `removeContainer` between attempts, `setNetwork` at the network-policy step and in `takeOffline`.
- `test/helpers.ts:110`: `FakeDocker.setNetwork(…, enabled: boolean)`.
- `src/sandbox/docker.ts`: `startIfStopped(id)` receives an id only; `BASE_FORMAT` has no `.Name`.
- T14: run by the Flight Director on Docker Desktop, 2026-11-22, with throwaway `mcpe-plan-<n>` objects, all removed.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
