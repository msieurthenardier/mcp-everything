# Leg: contained-networks

**Status**: completed
**Flight**: [Contained Network and Isolation Runtime](../flight.md)

## Objective
Give the Docker layer contained networks and the one-shot proxy:
- an internal network with no gateway, checked after creation;
- the upstream DNS servers, read once;
- a one-shot container run behind its own one-shot proxy, all owned, labelled, hardened and torn down in order on every path;
- the sweep for their leftovers.

## Context
- **Planned as leg 4; renumbered 5** when its design review split the measurement workflow out as leg 4 (`linux-measurements`) and moved the exec-environment plumbing to `project-proxy-lifecycle`, its first caller (2026-11-22).
- **Flight decisions.**
  - **DD2**: the one-shot network and proxy, roles, teardown order, image first, readiness, "the proxy did not start", the sweep's roles and project-label exclusion, labels-only classification.
  - **DD3**: network flags and the check; never `bridge`.
  - **DD4**: resolvers read from a container on `bridge`.
  - **DD13**: Docker cases with positive controls, `mayRemove`, the gate.
  - **DD15**: address pools.
  - **Trials**: T1–T5, T11–T13.
- **Prior legs** (landed, uncommitted):
  - **Leg 1**: `HostEntry`, `PROXY_PORT`.
  - **Leg 2**: `assertRuntime()` before every `runOnce` except `runtime-check`, and the mapping of Docker's runtime error.
  - **Leg 3** (`proxy-program`): **landed**. Its exports were checked by this leg's second design review.
- **The contract with leg 3**, as landed in `src/network/proxy/config.ts` and `proxy.cjs`:
  - **`proxyConfig({ allow, local?, forwards?, listenCidr, resolvers, controlPort?, limits? })`** returns the configuration.
    - `port` is `PROXY_PORT` (3128), `controlPort` defaults to `PROXY_CONTROL_PORT` (3129), `version` is `PROXY_PROGRAM_VERSION` (`"1"`), and `forwards` defaults to `[]`.
    - `limits` is optional here; the program fills every limit it is not given with its defaults.
  - **`proxyLaunchArgs(config)`** returns `["-e", <text>, <json>]`.
  - **The control endpoint** starts only after every listener is bound.
  - **`GET /status`** carries `ready: true`, `listening`, `version`, `startedAt`, `configHash`, `resolverFailures`, `total` and `refusals`.
    - Each row is `{ kind: "connect" | "http" | "forward", host: string | null, port: number | null, reason, count, firstAt, lastAt }`.
    - `reason` is one of `not-allowed`, `refused-address`, `no-address`, `resolve-failed`, `connect-failed`, `timeout`, `bad-request`, `method`, `cap`.
  - **The program waits for its interface** up to `limits.bindWaitMs` (default 10 s) before exiting.
- **Containers on `bridge` are never reachable from a contained network**, by design. The proxy is on `bridge`, so `bridge`'s subnet is in its own `ownCidrs`, which leg 3 classes `never`, even for `local: true` entries. That is the point: another project's open sandbox sits on `bridge`. Local services are reached through `MCPE_LOCAL_ACCESS` names, such as `host.docker.internal` with a published port, under leg 3's narrow exemption. This answers the design review's question; the Docker cases below assert it.
- **No caller in the install path yet.** Leg 7 (`contained-install`) routes the clone and scanners through this layer; leg 6 (`project-proxy-lifecycle`) builds on these pieces. The sweep is already called at startup, so its extension takes effect at once.
- **The code today.**
  - `runOnce` (`src/sandbox/docker.ts`) creates an owned one-shot with `--network spec.network` and removes it by id in a `finally`.
  - `probe` passes `"bridge"`, `runScanner` passes `"bridge"` or `"none"`, and `copyVolume` passes `"none"`.
  - `NOT_THERE = /no such (container|object|volume)/i` drives `isNotThere`.
  - `OneShotRole` and `ONE_SHOT_ROLES` are parallel lists.
- **Working tree**: legs 1–3 are uncommitted. Build on the current tree. Do not touch `.github/workflows/ci.yml` (leg 3's) or `.github/workflows/docker-gvisor.yml` (leg 4's).

## Inputs
- `src/sandbox/docker.ts`: `runOnce`, `OneShotSpec`, `OneShotRole`, `ONE_SHOT_ROLES`, `NOT_THERE`, `isNotThere`, `limits()`, `ensureImage`, `sweepCheckLeftovers`.
- `src/config.ts`: `Config.docker`.
- `src/network/proxy/config.ts` (leg 3).
- `test/docker.test.ts` (the double, strict mode, coverage lists); `test/integration/docker.test.ts` (`mayRemove`, `assertNameCheckBehaves`, the removal helpers, the suite's prefix and owner).

## Outputs
- `src/sandbox/docker.ts`:
  - `createContainedNetwork`, `readUpstreamResolvers` and `invalidateResolvers`;
  - the egress path of `runOnce` (`runBehindProxy`);
  - new roles and errors;
  - the network "not found" match;
  - the sweep extended to networks.
- `src/config.ts`: `docker.proxyImage`, with an `MCPE_PROXY_IMAGE` override.
- Tests: `test/docker.test.ts`, `test/config.test.ts`, `test/integration/docker.test.ts`.
- Flight log: the measurements on the operator's daemon.

## Acceptance Criteria

**Configuration:**
- [ ] **`cfg.docker.proxyImage`** defaults to `node:<lts>-alpine@sha256:<index digest>`, read from the registry **at implementation** (e.g. `docker buildx imagetools inspect`), with the tag in a comment, as for `probeImage`. `MCPE_PROXY_IMAGE` overrides it.
- [ ] **Its Node version** is at least 22. It is recorded in the flight log from `docker run --rm <image> node --version`, run during the gated Docker run, and it matches the comment's tag.

**"Not there" for networks:**
- [ ] **`isNotThere` also matches Docker's network wording.** The design review saw this daemon answer `Error response from daemon: network X not found` to `network inspect` and `network rm`.
- [ ] **The match is extended deliberately**: a second pattern `/no such network|\bnetwork \S+ not found\b/i`, used for network commands only, with unit cases on both wordings. Containers and volumes keep the current pattern.

**Contained networks** (DD3):
- [ ] **`createContainedNetwork(labels)`**:
  - names the network itself (`<prefix><id>-<role>-<hex>` for one-shots; leg 6 passes a project name);
  - runs `docker network create --internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated --ipv6=false` with the owner, role and (when given) project labels;
  - requires a 64-hex id on stdout;
  - then runs a JSON inspect of `Id`, `Internal`, `EnableIPv6`, `IPAM.Config`, `Labels` and `Created`.
- [ ] **It returns `{ id, name, subnet }`** only if all hold: `Internal` is true, `EnableIPv6` is false, there is exactly one IPv4 subnet, no `Gateway` in any `IPAM.Config` entry, and the owner label is this installation's. A `null` `Labels` fails the owner check.
- [ ] **Otherwise it removes the network by id** (tolerantly) and throws `ContainmentUnavailableError`, whose message says what was wrong.
- [ ] **The minimum Docker version** in that message comes from a constant set from leg 4's measurement or Docker's release notes. Until it is known, the message says "a Docker version whose bridge driver supports `gateway_mode_ipv4=isolated`", never a number from memory.
- [ ] **Failures of the create itself.**
  - On a timeout, remove by the random name (tolerantly) and throw.
  - On a non-zero exit, throw with the cleaned last line.
  - Address-pool exhaustion ("all predefined address pools have been fully subnetted") becomes `ContainmentUnavailableError`, naming `default-address-pools` (DD15).
  - The inspect failing or timing out removes the network by id and throws `DockerUnavailableError`.
- [ ] **Never a fallback to `bridge`.**

**Upstream resolvers** (DD4):
- [ ] **`readUpstreamResolvers()`** runs one one-shot (role `resolv-read`) on `bridge` with the probe image, entrypoint `cat` and argument `/etc/resolv.conf`.
- [ ] **Parsing**: `nameserver` lines, IPv4 and IPv6 literals only, no `%`. Loopback and `127.0.0.11` are dropped. IPv4 is ordered before IPv6, since the contained side has IPv6 off.
- [ ] **An empty result** throws `ContainmentUnavailableError` ("no usable upstream DNS server").
- [ ] **Caching**: per `Docker` instance (not module scope). Failure is not cached, concurrent callers share one in-flight read, and `invalidateResolvers()` clears it.

**One-shot behind a proxy** (DD2):
- [ ] **`OneShotSpec` gains an optional `egress: { allow: HostEntry[]; local?: boolean }`.**
  - `network` becomes optional in the type, and is required when `egress` is absent.
  - With `egress`, a given `network` is an error (a runtime check), since `runBehindProxy` uses the network it creates.
- [ ] **The result is a derived type**, `OneShotResult = RunResult & { proxy?: ProxyReport }`, so the result without egress is unchanged.
  - `ProxyReport` is `{ unavailable: true }` or `{ rows: ProxyRefusalRow[]; total: number; resolverFailures: number }`.
  - `ProxyRefusalRow` mirrors leg 3's row: `host` and `port` may be `null`; `count` is a positive integer; `firstAt` and `lastAt` are strings.
  - Leg 6 uses `resolverFailures` to re-read resolvers. Leg 7 turns rows into messages.
- [ ] **With `egress`, `runOnce` calls a private `runBehindProxy`**, in this order:
  1. `assertRuntime()`;
  2. ensure the proxy image and the one-shot's image (pulls happen before any object exists);
  3. `readUpstreamResolvers()`;
  4. `createContainedNetwork` (role `oneshot-net`);
  5. **create** the proxy (role `oneshot-proxy`, name `<prefix><id>-oneshot-proxy-<hex>`):
     - `--network bridge`, `limits()`, `--cap-drop ALL` with no `--cap-add`, `--user node`, `--read-only`, `--tmpfs /tmp:size=8m`;
     - no `-p`, never `--network host`;
     - `--entrypoint node`, `cfg.docker.proxyImage`;
     - then `proxyLaunchArgs(proxyConfig({ allow, local, listenCidr: <subnet>, resolvers, limits: { bindWaitMs: 3000 } }))`, as an argv array, never through a shell. The 3 s bind wait is well inside readiness's 10 s budget, so a bad CIDR ends as "exited" with the program's reason, never as "out of budget". A unit test asserts the pair;
  6. `docker network connect --alias mcpe-proxy <net> <proxy>`, **which must happen before `start`**;
  7. `docker start <proxy>`. **A non-zero exit throws `ProxyStartError`** with the cleaned last line of Docker's stderr. For example, an image without `node` gives "OCI runtime create failed … executable file not found", and such a container never runs, so it has no logs. Only Docker's runtime-name refusal maps to `RuntimeUnavailableError` (leg 2's `runtimeRefusal`);
  8. **readiness**, within a 10 s budget measured with `Date.now()`:
     - loop: inspect `.State.Running` and `.State.ExitCode`;
     - if the container exited, throw `ProxyStartError` at once;
     - otherwise run `docker exec <proxy> node -e <GET /status>` with a 3 s per-exec timeout, and require JSON with `ready === true` and `version === PROXY_PROGRAM_VERSION`. The in-container script sets its own 2 s socket timeout and calls `process.exit`, so a killed CLI leaves no process behind. One private helper, `proxyStatus(id, timeoutMs, maxBytes)`, serves readiness, the refusals read and leg 6, so the caps live in one place;
     - sleep 250 ms between rounds;
     - out of budget: `ProxyStartError`;
  9. **create** the one-shot with `--network <net>` and `-e` for `HTTP_PROXY`, `HTTPS_PROXY`, `http_proxy`, `https_proxy`, `NO_PROXY=` and `NODE_USE_ENV_PROXY=1`, all `http://mcpe-proxy:3128`, then run it as today (`start -a`, time limit, byte cap).
- [ ] **`ProxyStartError`'s message** is "the network proxy did not start: <cleaned last line of `docker logs`>", or "exited with code N" if the logs cannot be read. Never a refusal.
- [ ] **Docker's runtime error on the proxy's create or start** still maps to `RuntimeUnavailableError` (leg 2), not `ProxyStartError`.
- [ ] **Every failure path tears down**, in a `finally`, in the order one-shot container → proxy → network. Each removal is tolerant and independent, and never masks the original error. One unit case for each:
  - network create fails or times out;
  - the id is not 64 hex;
  - the check fails;
  - the inspect fails;
  - the proxy create fails or times out (remove by name);
  - `network connect` fails;
  - the proxy start fails;
  - readiness fails (exited, or out of budget);
  - the one-shot's create fails after readiness;
  - the one-shot times out;
  - a throw anywhere.
- [ ] **Refusals, on failure only.**
  - When the one-shot exits non-zero, times out or throws, **before** the proxy is removed: `docker exec <proxy> node -e <GET /status>` with a 3 s timeout and a 64 KiB cap.
  - The JSON is parsed defensively into `ProxyReport`:
    - the shape is checked;
    - `kind` and `reason` must be in leg 3's vocabularies;
    - at most 50 rows;
    - `host` is `null` or a string of at most 253 characters, cleaned with `cleanTerminalText`;
    - `port` is `null` or 1–65535;
    - `count` is a positive integer;
    - `total` and `resolverFailures` are non-negative integers.
  - An invalid row is dropped. If the JSON is unreadable, `proxy = { unavailable: true }`.
  - Hostile-JSON unit cases include `host: null`, escapes, a huge array and wrong types.
  - This never throws out of teardown.
  - On success, no read.
- [ ] **Without `egress`**, `runOnce` issues exactly the same Docker calls as today, and every existing test passes unchanged.
- [ ] **Roles.** `resolv-read`, `oneshot-proxy` and `oneshot-net` are added. A test asserts `OneShotRole` and `ONE_SHOT_ROLES` list the same container roles.

**Sweep** (DD2):
- [ ] **What `sweepCheckLeftovers` adds**:
  - the container roles `resolv-read` and `oneshot-proxy`;
  - networks: `docker network ls --filter label=<owner> --filter label=mcp-everything.role=oneshot-net --format '{{.ID}}'`, inspected for `Labels` and `Created` (RFC 3339 with nanoseconds; `null` labels mean "skip", not a failure).
- [ ] **A candidate must not carry the `mcp-everything.project` label at all**, for containers, volumes and networks, even with an empty value.
- [ ] **Order**: containers, volumes, then networks. A network with active endpoints is skipped without counting a failure.
- [ ] **Unit cases**:
  - an aged `oneshot-net` and `oneshot-proxy` of this installation are removed;
  - a container or network with a project label survives, whatever its role, including `project-proxy` and `project-net`;
  - another owner's survives;
  - a project slug `oneshot`, whose sandbox's name looks like a one-shot, survives (labels only);
  - a nine-digit fraction in `Created` parses;
  - an already-gone network is not a failure.

**Coverage and guards:**
- [ ] **Coverage lists.** Every new `Docker` method, private ones included, is in **exactly one** of the coverage test's lists (`CASES`, `NOT_GUARDED`, `REPORTING`; the test asserts their union equals the class's methods): `createContainedNetwork`, `readUpstreamResolvers`, `invalidateResolvers`, `runBehindProxy`, `proxyStatus`, and helpers. Those acting only on objects they created go in `NOT_GUARDED`, each with a reason.
- [ ] **The double** answers `network create`, `network inspect`, `network connect`, `network rm`, `network ls`, `exec` (proxy status), `logs` and `start` for the proxy. Strict mode's allowed list gains the verbs the new methods need, `network inspect` included (`createContainedNetwork` always needs it).
- [ ] **`mayRemove`** is extended deliberately: a `removeNetworkChecked` helper goes through it. `assertNameCheckBehaves` gains one-shot network and proxy names under the suite's prefix (allowed), under `mcpe-` (refused) and under another process's prefix (refused).

**Docker-gated cases** (the first run is gated on the Flight Director's go-ahead, with the operator's container, volume and network ids recorded first). The prober is the proxy image running `node -e` with `net.connect`, so the error code is printed:
- [ ] **Allowed**: a one-shot (probe image) behind its proxy, allowed `github.com`, runs `git ls-remote https://github.com/tomnomnom/gron HEAD`, which shows alias resolution plus CONNECT end to end.
- [ ] **Refused directly, each with a positive control** from a prober on `bridge` (connects or gets `ECONNREFUSED`). The test process opens a listener on `0.0.0.0` on the host for the controls. On Docker Desktop, `172.17.0.1` is not the host (T5), so its control is "reachable, any answer". The contained prober (no proxy variables) is refused:
  - the network's `.1`;
  - `172.17.0.1`;
  - `192.168.65.254` (Docker Desktop only; skipped elsewhere);
  - `169.254.169.254`;
  - a listener container on `bridge`, by its address.
- [ ] **Refused through the proxy**: `CONNECT host.docker.internal:80` and `CONNECT <bridge listener address>:<port>` get `403`. That is the stated design: `bridge` is never reachable from contained networks.
- [ ] **Allowed nothing**: `git ls-remote` fails, and `refusals` holds `github.com` with reason `not-allowed`.
- [ ] **The proxy is not reachable from `bridge`**: a prober on `bridge` connecting to the proxy's bridge address on 3128 gets `ECONNREFUSED`, because the proxy binds only its internal address.
- [ ] **The proxy's hardening, by `docker inspect` while it runs**: `HostConfig.NetworkMode` is `bridge`, not `host`; `ReadonlyRootfs` is true; `CapDrop` is `ALL`; `CapAdd` is empty; there are no port bindings; `Config.User` is `node`; and its networks are exactly `bridge` and the one-shot network. **The one-shot's** `NetworkMode` is the one-shot network.
- [ ] **Nothing remains after each case**: filtered `docker ps -a`, `docker network ls` and `docker volume ls` on the suite's owner are empty.
- [ ] **Sweep**: an aged `oneshot-net` and `oneshot-proxy`, under the suite's owner, created by the test with a sweep age of 0, are removed. A network with a project label survives.
- [ ] **A start failure case**: the proxy image overridden with an image without `node` (the probe image) gives `ProxyStartError`, and nothing remains.

**Measurements on the operator's daemon** (after the go-ahead; flight log, not tests):
- [ ] `node --version` in the proxy image.
- [ ] `docker exec` into the `--read-only`, `--user node`, cap-dropped proxy works.
- [ ] A network alias held by two containers: what `getent hosts` returns from a client, across ten tries, and after `docker restart` of one holder. This mirrors leg 4's runner measurement.

**Overall:**
- [ ] `npm run typecheck`, `npm test` and `npm run build` pass, and the existing test count does not drop.
- [ ] The Docker-gated suite passes after the go-ahead. Its counts and time go into the flight log, against the ~280 s baseline.

## Verification Steps
- `npx vitest run test/docker.test.ts test/config.test.ts`: double-driven cases for:
  - every step's arguments and order, the launch arguments and the exact configuration JSON;
  - every failure path's teardown;
  - the refusals read (hostile JSON: escapes, huge arrays, wrong types);
  - the network check;
  - the address-pool mapping;
  - resolvers;
  - the sweep;
  - the role-list agreement.
- `npm run typecheck`, `npm test`, `npm run build`.
- **The Docker gate**:
  1. stop after the unit work;
  2. report the new Docker cases to the Flight Director;
  3. record `docker ps -a -q --no-trunc`, `docker volume ls -q` and `docker network ls -q --no-trunc` into the flight log;
  4. wait for the go-ahead.

  After the run, record the same lists; the operator's ids must be unchanged.
- **Trials**. Weaken the source, confirm a test fails, and restore by editing:
  - the gateway check;
  - the project-label exclusion;
  - teardown removing the network before the proxy;
  - readiness accepting a 200 without `ready`.

## Implementation Guidance
1. **Configuration**: `proxyImage` (digest read at implementation).
2. **The network "not found" match**, then `createContainedNetwork`, with the double extended to answer `network create`, `network inspect`, `network connect`, `network rm` and `network ls`.
3. **`readUpstreamResolvers`** and `invalidateResolvers`.
4. **`runBehindProxy`**, keeping the step order exactly. The existing non-egress path stays visibly unchanged.
5. **The sweep.**
6. **Unit tests, trials**, then stop for the gate.
7. After the go-ahead: Docker cases and the measurements, then the results into the flight log.

## Edge Cases
- **The proxy exits at once** (bad configuration, no interface in the CIDR): readiness sees `Running: false` and throws with its logs.
- **`docker logs` cannot be read, or contains terminal escapes**: "exited with code N", or a cleaned line (unit cases).
- **`readUpstreamResolvers` finds only `127.0.0.11`**: `ContainmentUnavailableError`.
- **The one-shot is killed by its timeout**: its `rm -f` by id runs first, then the proxy and the network go.
- **A Node process killed midway** leaves a `oneshot-proxy` and a `oneshot-net`; the startup sweep removes them after its age.
- **An attached endpoint blocks `network rm`**: the proxy is removed first, so the order handles it. A Docker case on a start failure confirms it. If removal still fails, the sweep gets it later.

## Files Affected
- `src/sandbox/docker.ts`, `src/config.ts`.
- `test/docker.test.ts`, `test/config.test.ts`, `test/integration/docker.test.ts`.
- The flight log.

## Citation Audit
Checked on 2026-11-22 against the working tree (legs 1–4 landed):
- `src/sandbox/docker.ts`:
  - `runOnce`, `probe` (`"bridge"`), `runScanner` (`"bridge"`/`"none"`), `copyVolume` (`"none"`), `sweepCheckLeftovers`;
  - `NOT_THERE = /no such (container|object|volume)/i`;
  - `OneShotRole` and `ONE_SHOT_ROLES` as parallel lists (`runtime-check` added by leg 2).

  Present, cited by symbol, since line numbers move with each leg.
- `test/integration/docker.test.ts`: `mayRemove`, `assertNameCheckBehaves`, `removeContainerChecked`, `removeVolumeChecked`; no network helper. Present.
- Leg 3's contract (`proxyConfig`, `proxyLaunchArgs`, `PROXY_CONTROL_PORT`, `PROXY_PROGRAM_VERSION = "1"`, `/status` with `ready` and its row shape) was checked against the landed `src/network/proxy/config.ts` and `proxy.cjs` by design review 2, on 2026-11-22.
- `docker buildx imagetools inspect node:22-alpine` works on the operator's daemon. Review 2 saw `sha256:1314fb30…`, a snapshot only; re-read at implementation.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
