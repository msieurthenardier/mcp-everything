# Leg: proxy-by-address

**Status**: completed
**Flight**: [Contained Network and Isolation Runtime](../flight.md)

## Objective
Make containment work under gVisor by removing its dependence on Docker's embedded DNS:
- contained containers reach their proxy at a **fixed IP address** on their network, not the alias `mcpe-proxy`;
- the operator's local-access names resolve through the **sandbox's `/etc/hosts`**, written by mcp-everything, not through network aliases;
- the Docker suite's gVisor-specific differences get named skips or adjusted timeouts;
- a native-Linux **runc** containment run is added to CI.

After this leg, the `gvisor` job is green.

## Context
- **The finding** (first full `gvisor` run, 45146029960, on `070486a`, 2026-11-23):
  - **Run A** gave 43 passed and 21 failed; **Run B** gave 2 passed and 1 failed.
  - **Every contained case failed to resolve `mcpe-proxy`**: "Could not resolve proxy: mcpe-proxy (Could not contact DNS servers)" from `git`, and `EAI_AGAIN` from Node probers.
  - **Why**: Docker's embedded DNS (`127.0.0.11`) is reached through NAT rules in the container's network namespace, and gVisor's own network stack does not honor them. The local-access aliases (DD10, T8) depend on the same server.
  - **The operator chose to fix it in this flight** (2026-11-23).
- **Other Run A failures, not DNS** (to be classified in this leg, from the run's log):
  - the idle-timeout cases and the primitives-modes case read `/sys/class/net`, which is empty under gVisor (`[ '' ]`);
  - "installs a Go CLI … runs it offline" timed out after 5 s where it expected a fast `DOWN`, because offline name resolution under gVisor waits instead of failing at once;
  - "works on … a sandbox made before ownership" (`expected true to be false`) and the T14 case (`expected 1 to be 0`) are still to be explained.
- **The fixed address.**
  - The proxy joins its network with `docker network connect --ip <address>`, where the address is the **last usable host address** of the network's IPv4 subnet (for `172.22.0.0/16`, `172.22.255.254`), computed from the subnet that `createContainedNetwork` already returns.
  - Docker's IPAM hands out addresses from the low end, so the sandbox never collides with it.
  - The same rule applies to the one-shot proxy on its one-shot network.
- **What changes in replacement (DD2).**
  - Two containers cannot hold one address, so replacement becomes:
    1. under the lock, take the old proxy off the network (`network disconnect`);
    2. create the new proxy at the address;
    3. readiness;
    4. remove the old proxy.
  - **If the new proxy fails readiness**, reconnect the old one at the address. If that also fails, the project has no proxy: fail closed, repaired on the next use.
  - **The overlap window disappears.** A tightening is effective at once, and in-flight connections through the old proxy drop.
  - The proxy environment is the same string before and after a replacement, so MCP servers need no restart for addressing (they still close on a configuration change, as legs 7 and 9 do).
- **Local-access names (DD10).**
  - The sandbox's `/etc/hosts` gets one line per forward target name: `<proxy address> <name>   # mcpe-local-access`.
  - It is written **by the hook** (`ensureContained`) after every start, and after `contain` or `replace` changes the forwards: `docker exec` as root, idempotent, replacing previous `mcpe-local-access` lines.
  - Docker rewrites `/etc/hosts` on start (T8), which is why it is rewritten after each start.
  - Names that collide with the sandbox's own entries (`localhost`, its hostname) are refused, and leg 1's grammar already keeps them out.
  - The proxy keeps its own `/etc/hosts` `host-gateway` entry for `host.docker.internal` (T13a), unchanged.
- **Aliases are no longer relied on.** The `mcpe-proxy` alias and the forward aliases are dropped, so nothing depends on embedded DNS. The proxy's own resolution was already independent of it (it uses the upstream resolvers, DD4).
- **Tests that pin the alias** (`HTTPS_PROXY=http://mcpe-proxy:3128`, `--alias` argv, the connect-script probers that dial `mcpe-proxy`) change deliberately to the address, and are listed.

## Inputs
- `src/sandbox/docker.ts`: `runBehindProxy`, `createProjectProxy`, `projectProxyAttached`, `PROXY_ALIAS`, the readiness loop, `createContainedNetwork` (subnet).
- `src/network/containment.ts`: `PROXY_URL`, `replaceLocked`, `repairLocked`, `containLocked`, `ensureContained`, the forwards and aliases in `buildConfig`.
- `test/docker.test.ts`, `test/containment.test.ts`, `test/integration/docker.test.ts`, `test/integration/gvisor.test.ts`.
- `.github/workflows/docker-gvisor.yml`: a new **Run C**.
- The run's log: `gh run view 45146029960 --log`.

## Outputs
- Code: the fixed address, the replacement order, `/etc/hosts` local-access lines, no reliance on aliases.
- Tests: the alias pins moved; gVisor skips and timeouts; new unit and Docker cases.
- The workflow: Run C.
- The flight log.

## Acceptance Criteria
- [ ] **`proxyAddress(subnet)`**: a pure function returning the last usable host address of an IPv4 CIDR (unit cases: `/16`, `/24`, `/20`, and a `/31` or `/32`, which is refused).
- [ ] **Both proxies at the address.** The one-shot and project proxies join their network with `--ip <proxyAddress(subnet)>` and no `--alias`. The environment `HTTP_PROXY`, `HTTPS_PROXY` and the lower-case forms are `http://<address>:3128`.
  - For one-shots, at create.
  - For sandboxes, from the hook, which reads the address from the `-net`'s subnet. That is pure, with no extra inspect beyond the facts and the network's subnet, which is cached with the hook cache.
- [ ] **`projectProxyAttached`** checks that the proxy is on the `-net` **at the address**, not by alias.
- [ ] **Replacement order**, as in Context:
  - under the lock: disconnect old, create new at the address, readiness, remove old;
  - on a readiness failure: reconnect old at the address, and fail closed if that fails;
  - unit cases cover each branch, including "old reconnected" and "no proxy left".
  - The DD2 "overlap" text and leg 7's resolutions are superseded where they differ, and recorded in the flight log.
- [ ] **Local access through `/etc/hosts`.**
  - The hook writes, idempotently, the `# mcpe-local-access` lines after a start and after the forwards change, and removes them when the forwards become empty or the sandbox is taken off.
  - The forward listeners in the proxy are unchanged.
  - Unit cases: the exec's script and its idempotence (written twice, one set of lines); removal; a refused name.
- [ ] **No embedded DNS anywhere.** A unit test asserts that no `network connect` in `docker.ts` carries `--alias`, and that the proxy environment contains no host name.
- [ ] **gVisor differences in the suite** (`skipIf(process.env.MCPE_DOCKER_RUNTIME === "runsc")` with a reason string, recorded in the flight log):
  - **`/sys/class/net`**: use `/proc/net/dev` or `ip -o link`, if gVisor supports it (measured in CI). Otherwise skip only the interface-name assertion under runsc and keep the membership assertions.
  - **The offline Go CLI case**: a longer `timeout_sec` under runsc, with the reason.
  - **The two unexplained failures** are read from the run's log first and either fixed or skipped with the cause named.
  - **No contained-install, isolation, 403/200, local-access or runtime-proof case may be skipped.**
- [ ] **Run C in `docker-gvisor.yml`**: the containment describes (legs 5–10) under **runc** on native Linux (`MCPE_DOCKER_RUNTIME` unset, `-t` selecting those describes), run before `runsc install`, or with `--runtime runc`. Same summary reporting.
- [ ] **Docker Desktop (local)**: the full Docker suite passes with the address change (the Flight Director's gate before the run).
- [ ] **CI**: after the commit, `gvisor` is green: Run A (with named skips only), Run B, and Run C.
- [ ] `npm run typecheck`, `npm test` and `npm run build` pass.

## Verification Steps
- Unit cases as above. Trials:
  - the alias reinstated (the no-alias test fails);
  - the old proxy removed before the new one is ready;
  - the `/etc/hosts` write not idempotent.
- **The Docker gate**: Developer stops, the Flight Director reads the new and changed cases, then the full suite runs locally, with the volume list compared.
- **CI**: the Flight Director pushes and reads `gh run view` for Runs A, B and C.

## Edge Cases
- **A subnet whose last address Docker has already given out** (very unlikely, since IPAM allocates low first): `network connect --ip` fails. Then refuse with `ProxyStartError`, naming the address. Never fall back to an alias.
- **Two sandboxes on one `-net`** cannot happen (one project per network).
- **A sandbox started outside mcp-everything** (`docker start` by hand) has no local-access lines until its next hooked exec. Stated in the README.
- **Docker rewrites `/etc/hosts` on `network connect` too.** The hook's post-attach write covers it; measured in the Docker case.

## Design Review 1 Resolutions (binding; they override the text above where they differ)
Flight Director, 2026-11-23. Review: needs rework. Reworked here.
- **No second design review.** These are the reviewer's own fixes plus the Flight Director's measurement T16. The proof is CI (Runs A, B and C) and the flight-end Reviewer's read of this leg's diff, which runs before the commit.
- **The flight is unreleased**, so no migration of existing project networks is needed.

1. **Addressing (T16 plus robustness).**
   - Every contained network is created by **probe, then pin**:
     1. create a throwaway network without `--subnet`, so the daemon's `default-address-pools` choose;
     2. read its subnet and remove it;
     3. create the real network with `--subnet <that> --ip-range <lower half>`;
     4. on "Pool overlaps", retry up to three times with a fresh probe.
   - The proxy address is the last usable host of the subnet, which is outside the IP range, so IPAM can never hand it out.
   - The fixed-name project network keeps its adopt-on-exists path.
   - `checkContainedNetwork` still requires no gateway and one subnet. `proxyAddress` returns the last usable host for `/16`, `/24` and `/30`, never the broadcast address, and refuses `/31` and `/32`.
   - T16 showed `--ip` also works on an automatic subnet on Docker Desktop 29.8.2. Pinning removes the dependence on that, and on native-Linux behavior.
2. **`/etc/hosts` is written after the start, not in the hook.**
   - A new post-start step, `afterStart(ref)`, is installed by `Containment` like the hook. It runs in `acquire` when it started the sandbox, in `ensureRunning` when it started it, in `exec`'s restart path, and in `startForContainment`.
   - It also runs **when an acquired, running sandbox lacks its lines**: a cheap `grep` in the same exec. It is skipped entirely when the project has no forwards, which is most projects.
   - The write runs `docker exec -u 0 <id> sh -c '…'`. It builds the new content (all lines except `# mcpe-local-access` ones, plus the current lines) and writes it with **one `printf … > /etc/hosts`**: no `sed -i`, no `mv` (`/etc/hosts` is a bind mount).
   - It runs again after `contain` or `replace` changes the forwards, bypassing the hook cache. A unit case covers that.
   - The Docker case asserts the lines survive a stop and start, under runc locally and under runsc in CI.
3. **Replacement and rollback.**
   - Under the lock:
     1. disconnect **every** current project proxy;
     2. `assertLive`;
     3. create the new proxy, connected `--ip <address>` before `start`;
     4. readiness, **and** `projectProxyAttached` at the address;
     5. remove the old proxies.
   - **On failure**, the cleanup order is:
     1. remove the new proxy by name;
     2. then **stop** the old one;
     3. `network connect --ip <address>` it;
     4. **start** it;
     5. readiness and the attachment check.
   - If that fails too, there is no proxy: fail closed, and `assess` returns "replace" on the next use, which a unit case covers.
   - The replacement tests allow one slow first connect after a swap (ARP), with a bounded retry.
4. **Cost and attachment.**
   - `Containment` holds a `Map<networkId, subnet>`. A network's subnet never changes, so it is never invalidated. A unit case shows one inspect per network.
   - `projectProxyAttached` checks `NetworkSettings.Networks[net].IPAMConfig.IPv4Address` (the configured address, readable while stopped), not `.IPAddress`. The `docker.test.ts` fake models `IPAMConfig`.
5. **Test pins.**
   - The alias pins change: integration lines around 1641, 1979, 2149, 2214 and 2268; `--alias` argv cases; the alias regex validation in `createProjectProxy` (now removed).
   - **The "forward target named `mcpe-proxy`" refusal and its warning are removed**, since nothing collides with that name any more. Its tests are removed with that reason: `containment.test.ts` around 318–324, `docker.test.ts` around 3672–3675.
   - The source-scan test asserts no `--alias` in `docker.ts`, and that the proxy environment contains no host name.
   - A test names the sandbox's hostname (its short id) and `localhost` as forward targets, and shows both refused.
6. **Run A's other failures.**
   - **`/sys/class/net`**: replaced **unconditionally** by parsing `/proc/net/dev` (gVisor implements it), so runc and runsc run the same assertion, with no skip.
   - **"stops an idle sandbox, keeps its files": a product finding under gVisor.**
     - gVisor's default root-filesystem overlay (`--overlay2=root:self`) discards writes outside volumes when the sandbox exits. mcp-everything's build output (`/opt/mcpe`, `/root/.cargo`, `/usr/local/go`) lives in the container's layer (flight 3 moves it to a volume). **So under default `runsc`, an idle-stopped sandbox loses its built tools.**
     - **Decision**:
       - the CI registration is `sudo runsc install -- --overlay2=none`;
       - the README states that `runsc` must be registered with `--overlay2=none` for sandboxes to keep their build across stops;
       - `assertRuntime` logs one startup warning when the named runtime is `runsc` and Docker's `runtimeArgs` for it lack `--overlay2=none`. This is a warning, not a refusal; the operator's registration is theirs.
     - The test stays and must pass under the CI registration.
   - **The offline Go CLI case**: a longer `timeout_sec` under runsc, with the reason that offline name resolution waits under gVisor.
   - **"A sandbox made before ownership"**: a test fix. Its raw `docker run` passes `--runtime ${MCPE_DOCKER_RUNTIME}` when set; otherwise `refuseRuntimeMismatch` rightly refuses it.
   - **T14**: its raw `docker start` assertions print `stderr` and `docker inspect` state. **One more CI round is allowed** to explain it. A skip is only with the cause named.
7. **Run C is a separate job**, `contained-linux`:
   - on `ubuntu-latest`, under runc (no `runsc` installed), in parallel with `gvisor`;
   - it runs the containment describes selected by `-t`, and its summary **fails if fewer than the expected number of cases ran** (the count is pinned in the workflow, with a comment to update it);
   - it gets the same build steps and summary step (`SECONDS_C`, `if: !cancelled()`).
8. **The Flight Director's gate**: CI green across `gvisor` (Runs A and B) and `contained-linux` is the Flight Director's check after the push, not a Developer acceptance line. The Developer's lines are binary and local:
   - unit tests and trials;
   - the local Docker suite on Desktop after the gate;
   - `actionlint` if available.

## Files Affected
- `src/sandbox/docker.ts`, `src/network/containment.ts`, `src/network/proxy/config.ts` (if the URL helper lives there).
- `test/docker.test.ts`, `test/containment.test.ts`, `test/integration/docker.test.ts`, `test/integration/gvisor.test.ts`.
- `.github/workflows/docker-gvisor.yml`, `README.md` (the addressing and `/etc/hosts` mechanics, and the gVisor sentence once green).

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
