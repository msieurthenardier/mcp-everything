# Flight Log: Contained Network and Isolation Runtime

**Flight**: [Contained Network and Isolation Runtime](flight.md)

## Summary
Planning. Trials T1–T10 run on the operator's daemon on 2026-11-22 (see the flight's **Trials**).

---

## Leg Progress

### network-config
**Status**: landed (not committed)
**Changes**:
- New `src/network/hosts.ts` (grammar, `HostEntryError` with `step`, `PROXY_PORT`, `TWO_LABEL_PREFIXES`, `formatHostEntry`), `src/network/defaults.ts` (DD5 table, `DEFAULT_HOSTS_VERSION = 1`, `buildHosts`, `sandboxHosts`, `cloneHosts`), `src/network/local-access.ts` (`parseLocalAccess`, `localAccessFor`, `LocalTarget`).
- `src/config.ts`: `Config.network`, `MCPE_NETWORK`, `MCPE_LOCAL_ACCESS`, and the contained cross-check on scanners. `src/scan/scanners-file.ts` and `src/scan/types.ts`: scanner `hosts` (required `string[]` on `ScannerSpec`).
- Tests: three new files, plus cases in `test/config.test.ts` and `test/scan-scanners-file.test.ts`; `hosts: []` added to every hand-built `ScannerSpec` literal.
**Tests**: `npm test` 1511 passed, 37 skipped before; 1668 passed, 37 skipped after (+157). `npm run typecheck` clean. `grep -rln "/network/" src` gives only `src/config.ts` and `src/scan/scanners-file.ts` (plus files inside `src/network/`, which import each other by relative path).
**Trials** (`git diff --stat` before and after each: 12 files, 166 insertions, 12 deletions; restored by editing):
1. Single-label name: `labels.length < 2` weakened to `< 1`. 5 tests failed (`localhost` in agent and scanner modes, the scanners-file case, local-access single label). Restored.
2. `*.co.uk`: the two-label registry-suffix condition disabled. 5 tests failed (`*.co.uk` and `*.com.au` at step `wildcard`, the message test, the scanners-file case, scanner mode). Restored.
3. Second target on one port: the clash lookup disabled. 1 test failed (the same-port and proxy-port case). Restored.
**Notes**:
- Deviations from the leg's text, none behavioral:
  - More `ScannerSpec` literals than the leg listed needed `hosts: []`: `test/docker.test.ts:191` was the only one in that file (the other `runScanner` calls use that constant); typecheck found no others beyond the listed ones.
  - The grammar's minimum of two labels is applied to non-wildcards only; `*.<tld>` is refused at step `wildcard` (step 7), so the step name matches the criterion that lists it under wildcards.
  - `*.<IP>` is refused at step `literal` in every mode, and a dotted quad with a leading zero in scanner mode at step `number` (Node's `net.isIP` already rejects those).
  - Added `formatHostEntry` (the stored `host` / `host:port` text, used by scanner `hosts`).
  - `test/config.test.ts` new cases were appended with a shell heredoc (a test file, not source); everything in `src/` was written with Write and Edit.
- No README change: agree, leg 9 owns docs.
- `loadConfig` now parses scanners before the literal is built; an error in `MCPE_NETWORK` or `MCPE_LOCAL_ACCESS` is thrown before a scanners-file error.

### runtime-required
**Status**: landed (not committed)
**Changes**:
- `src/sandbox/docker.ts`: `RuntimeUnavailableError`, `RuntimeMismatchError`; the `runtime-check` role (type and `ONE_SHOT_ROLES`, so the sweep removes a stranded trial); `"runtime":{{json .HostConfig.Runtime}}` in `BASE_FORMAT` and `FULL_FORMAT`, read as an optional `runtime` on `ContainerFacts`; `assertRuntime()` (shared in-flight promise, success cached by name, failure not cached) with private `checkRuntime` (info, probe image, trial through `runOnce`); `runOnce` and `createContainer` call it first (the trial excepted); `runtimeRefusal` maps "unknown or invalid runtime name" plus the named runtime on `create`/`run` and clears the cache; `refuseRuntimeMismatch` in `acquire`, `exec` by name, `ensureRunning` (name or reference) and `startIfStopped`; `daemonDefaultRuntime` kept from `info`.
- `src/install/installer.ts`: `assertRuntime()` after `assertAvailable()` in `install`, `check`, `installChecked`; `reconcileStale` untouched.
- `src/server.ts`: `checkRuntimeInBackground()` in the startup block (not in the `startup` promise); `assertNotInstalling` and `sandboxGone` extracted from `sandbox()`; `set_project_network(false)` goes by name (installing guard, `state` missing check, `setNetwork` by name); `true` still goes through `sandbox()`.
- Tests: `test/docker.test.ts` (double answers `info`, records and answers the runtime; strict mode allows `info`; new "the required runtime" block, 31 cases; four names added to `NOT_GUARDED`), `test/installer.test.ts` (fake gains `assertRuntime`/`runtimeError`/`order`; 8 cases), `test/server.test.ts` (4 `set_project_network` cases, 5 startup cases).
**Tests**: `npm test` 1668 passed, 37 skipped before; 1716 passed, 37 skipped after (+48). `npm run typecheck` clean.
**Trials** (`git diff --stat` and `git status --short` saved before and compared after all three: identical; each restored by editing, never git):
1. Name missing from `info`: the `hasOwnProperty` check disabled (`if (false && ...)`). 6 tests failed (the missing-name refusal, name cleaning, failure retried, concurrent refusal, one-shot refused with no create, `createContainer` refused). Restored.
2. Mismatch refusal in `acquire`: the `refuseRuntimeMismatch` call removed. 3 tests failed (runc refused when runsc named, running or stopped; the daemon-default cases; the shim case). Restored.
3. Shared in-flight promise: `if (!this.runtimeCheck)` replaced by `if (true)`. 2 tests failed (one info and one trial for simultaneous callers; same refusal for all callers). Restored.
**Notes**:
- Deviations from the leg: none behavioral. The optional Docker-gated case (unregistered runtime refuses `check_project`) was NOT written or run: no go-ahead from the Flight Director. The Docker suite was not run.
- The server-side fakes: `FakeDocker` in `test/helpers.ts` needed no change (a named runtime makes the real `assertRuntime` reach `docker()`, which throws, so server tests that name one use a subclass overriding `assertRuntime`; the `startup work` block does this). The mismatch for `set_project_network` is simulated with `FakeDocker.acquireError`.
- A trial that fails to create or start for a reason other than an unknown runtime (OCI error, missing `true`) is reported as `RuntimeUnavailableError` with the first line of Docker's message; Docker-unreachable errors propagate unchanged. A pull failure of the probe image is a `RuntimeUnavailableError` with the pull message.
- The "mismatch refused on a stopped container" case: nothing is started (asserted by the absence of `start`).
- No README change: agree, leg 9 owns the runtime section.
- Files were edited with Edit and Write only.

### proxy-program
**Status**: landed (not committed)
**Changes**:
- `src/network/proxy/proxy.cjs` (new, `// @ts-check` with JSDoc, `"use strict";` first, requires only `node:` built-ins, starts nothing when required): own IPv4 and IPv6 parsers and canonical text; `classify` (own subnets first, embeddings judged by the worse of the embedded class and local, Teredo both halves, IPv6 allowlist); `parseAuthority`/`parseName`; `matchEntry`; `validateConfig`; `hostsAddresses`; `start(config, deps)` (the servers; resolves to a handle `{ bind, close, status }`) and `main(config, deps?)` (process handlers, exit 70 on an uncaught exception, exit 2 with one stderr line on a failed start). Single-use socket guard on `request`/`connect`/`upgrade`, `keepAliveTimeout` 0, whole-handshake deadline timer, one shared connection cap, TCP forwards with the scoped `host.docker.internal` exemption, plain GET/HEAD relay through `http.request` over a pre-connected checked socket (`createConnection`), refusal list (50 rows, fixed reason codes), control endpoint.
- `src/network/proxy/config.ts` (new): `ProxyConfig`/`ProxyLimits` types, `PROXY_PROGRAM_VERSION`, `PROXY_CONTROL_PORT` (3129), `proxyConfig(opts)`, `proxySource()`, `proxyLaunchArgs(config)`.
- `tsconfig.json`: `"allowJs": true`. `.github/workflows/ci.yml`: the pack check also requires `dist/network/proxy/proxy.cjs`.
- `test/proxy-rules.test.ts` (177 cases) and `test/proxy-server.test.ts` (93 cases, including four child-process cases on real `node -e`).
**Added by the Flight Director mid-leg** (leg 4 depends on them):
- Readiness contract: the control endpoint listens only after the proxy port and every forward are bound (a test holds the bind with a `deps.interfaces` that returns nothing, and sees `ECONNREFUSED` on all three ports, then `ready`). `GET /status` also carries `ready: true` and `listening: { address, ports }` (the proxy port, then the forward ports).
- `proxyConfig(opts: { allow; local?; forwards?; listenCidr; resolvers; controlPort?; limits? })` with that exact signature (`port` always `PROXY_PORT`, `controlPort` defaults to `PROXY_CONTROL_PORT`, `local` on every entry, keys sorted), and `proxyLaunchArgs(config)` returning exactly `["-e", proxySource() + "\n;main(JSON.parse(process.argv[1]))", JSON.stringify(config)]`; a test asserts `main` gets one argument in that text.
**Tests**: `npm test` 1716 passed, 37 skipped before; 1986 passed, 37 skipped after (+270). `npm run typecheck` clean; `npm run build` emits `dist/network/proxy/proxy.cjs` (55,595 bytes; `dist` is gitignored). The shipped `-e` text is 49,986 bytes from `src` and 55,596 bytes from `dist` (limit 98,304).
**Trials** (`git diff --stat` and `git status --short` saved before and compared after all five: identical; each restored by editing, never git):
1. Teredo decoding: the client half dropped from the embedded list. 2 tests failed (the rules test of both halves; the embedding table through the proxy). Restored.
2. Literal-only `connect`: `dial` given the name instead of the checked address for non-literals. 40-odd server tests failed (every tunnel and relay; the connect-stub assertion). Restored.
3. Scoped forward exemption: the `host === "host.docker.internal"` condition removed. 1 test failed ("does not exempt db.lan on the same /etc/hosts line"). Restored.
4. Single-use socket guard: `firstUse` always true. 4 tests failed (GET+GET, GET+CONNECT, refused-then-pipelined, the child-process pipelining case). Restored.
5. `parseAuthority` refusal of `0x7f.1`: the last-label-is-a-number check removed from `parseName`. 16 tests failed (nine spellings in the CONNECT table, the implied-port table, config name checks, the malformed-row aggregation, and two plain-HTTP refusals). Restored.
**Notes**:
- Real bug found by the first run: `matchEntry` let a wildcard entry match its own base name (`*.example.com` matched `example.com`). Fixed and covered.
- Test-environment finding: in this sandbox a TCP connect to `127.0.0.1:1` hangs instead of being refused, so the test rig sends unmapped addresses to a just-freed port.
- Deviations from the leg (none behavioral beyond these):
  - `start(config, deps)` is exported besides `main`. In-process tests need the handle to close the servers and `main` installs process-level handlers and calls `process.exit`. `main` calls `start`.
  - `limits` is a required object with optional production limits (`connections`, `handshakeMs`, `attemptMs`, `tunnelIdleMs`, `upstreamIdleMs`, `requestTimeoutMs`, `headersTimeoutMs`, `bindWaitMs`), so tests can use small values without a test-only field. `version` must equal the program's version.
  - `resolverFailures` counts a resolution as failed only when no address came back and at least one family failed with something other than ENOTFOUND or ENODATA (a missing name is an answer, so a sandbox querying nonexistent names cannot force a proxy replacement).
  - `matchEntry` returns the entry (a `local` one preferred when several match) or null, not a boolean.
  - `Content-Length` is dropped from the relayed GET (it is zero or all zeros).
  - A forward to `localhost` cannot be configured (leg 1's grammar needs two labels, and config validation refuses it), so the "localhost" case is tested with a name that `/etc/hosts` maps to `127.0.0.1`.
  - The refusal row for a connection over the cap has kind `http` on the proxy port and `forward` on a forward port. The leg did not say which kind a cap row on the proxy port takes.
  - No resolver-answer fault injection for the real `dns.Resolver` (no DNS in tests): the default resolver is exercised only by a start with no `deps` (child-process case), not by a lookup.
- Residual: eviction is least-recently-seen, so a sandbox that makes 50+ distinct valid-name refusals still displaces older rows (identical spam does not).
- No README change: agree, leg 9 owns the README (it lists the residual routes the leg names).
- Files were edited with Edit and Write only. The Docker suite was not run.

### linux-measurements
**Status**: landed (not committed)
**Changes**:
- `.github/workflows/docker-gvisor.yml` (new): triggers `workflow_dispatch` and `pull_request` (opened, synchronize, ready_for_review) with the leg's path filter; `permissions: contents: read`; one job `measure` on `ubuntu-latest`, `timeout-minutes: 15`; no `actions/*` (comment says why); `IMAGE` is the `probeImage` reference from `src/config.ts` (comment names the source). Six steps, each `set +e`, each printing labelled `RESULT:` lines and appending to `$GITHUB_STEP_SUMMARY` through `tee -a`: Docker (version, Runtimes, DefaultRuntime); DD3 isolated network (`isolated` and `inhibit_ipv4` variants, inspect, Gateway present yes/no, refusal text recorded); Resolver (runner resolv.conf, systemd-resolved state, container resolv.conf, nslookup of github.com per nameserver, plus getent or nslookup default); host-gateway (listener on ports 18080-18082, bridge container and isolated-network container each fetching `host.docker.internal` and the docker0 address, bridge subnet versus the host-gateway address); Two-holder alias (two holders with `--network-alias mcpe-proxy`, ten lookups, `docker restart` of one, ten more, full `nslookup`); Cleanup check (lists leftover `mcpe-measure-<run id>-*` containers and networks). Every object is named `mcpe-measure-<run id>-...` and removed by a `trap ... EXIT` in its step.
**Verification**: each step's script passed `bash -n` (piped from a YAML parse, no files written). `actionlint` is not installed and the `npx` fetch was denied by the permission classifier, so it was not run; the push is the validity check. No Docker command was run. No tests were run (no code changed).
**Notes**:
- Aliases are set with `--network-alias` on `docker run` (the leg's "connected with `--alias`" is the `docker network connect` spelling).
- The host-gateway listener's pid goes through a file under `$RUNNER_TEMP`, because the measuring group runs in a pipeline subshell (`| tee`), where a variable would not reach the trap.
- Resolver step: `getent` uses the container's own resolv.conf, so the per-nameserver trials use `nslookup`; `getent` is used only for the default lookup.

### contained-networks
**Status**: landed (not committed)
**Changes** (Phase A, nothing run against Docker):
- `src/config.ts`: `docker.proxyImage`, default `node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a`, `MCPE_PROXY_IMAGE` overrides (empty means the default). Read on 2026-11-22 with `docker buildx imagetools inspect node:22-alpine` (read-only; the index digest, `application/vnd.oci.image.index.v1+json`). The tag is in the comment. `node:24-alpine` was also readable (`sha256:116b800c…`); 22 was kept because the leg and both design reviews were written against it, and it is the version the proxy program was tested under. Its `node --version` is still to be recorded from the gated run.
- `src/sandbox/docker.ts`:
  - `ContainmentUnavailableError`, `ProxyStartError` (message `the network proxy did not start: <detail>`), `ONE_SHOT_ROLES` (exported; `OneShotRole` is now derived from it, so the two cannot disagree) with `resolv-read` and `oneshot-proxy` added, `ProxyRefusalRow`, `ProxyReport`, `OneShotResult`, `ContainedNetwork`, `parseProxyReport`, `parseResolvConf`.
  - `NETWORK_NOT_THERE = /no such network|\bnetwork \S+ not found\b/i` for network commands only (`isNetworkNotThere`); containers and volumes keep `NOT_THERE`.
  - `createContainedNetwork({ role, name?, project? })`: create (internal, `gateway_mode_ipv4=isolated`, `--ipv6=false`, owner, role and optional project labels), a 64-hex id, then the checked inspect (internal, no IPv6, exactly one IPv4 subnet, no `Gateway` in any entry, owner label this installation's, `null` labels fail); otherwise removes by id and throws `ContainmentUnavailableError` (message cites "a Docker version whose bridge driver supports gateway_mode_ipv4=isolated", no number). Pool exhaustion names `default-address-pools`. A timeout or a bad id removes by the random name; an inspect failure removes by id and throws `DockerUnavailableError`. No fallback to `bridge`.
  - `readUpstreamResolvers()` / `invalidateResolvers()`: per instance, one in-flight read shared, failure not cached; role `resolv-read` on `bridge`, probe image, entrypoint `cat /etc/resolv.conf`; IPv4 before IPv6, loopback and `%` dropped; empty is `ContainmentUnavailableError`.
  - `runOnce` gains `egress` (`network` optional; an error with both or neither). Without `egress` the body moved unchanged into a private `runCreated(spec, network, extra, state?)`; its Docker calls are identical (a test asserts `create, start, rm`). With it, `runBehindProxy` runs the leg's nine steps in order; the proxy is `create`d without `--rm` (so an exited proxy still has logs), joined with `--alias mcpe-proxy` before `start`, and `proxyStatus(id, timeoutMs, maxBytes)` is the one place for the status exec. Readiness is bounded by `proxyReadiness` (10 s, 250 ms; a protected field so tests shorten it). Teardown is in a `finally`: proxy, then network, each tolerant; refusals are read only after a failed run (non-zero, timed out or thrown), after the one-shot's own removal and before the proxy's.
  - `sweepCheckLeftovers` also takes the new container roles, skips anything with the `mcp-everything.project` label at all (containers, volumes, networks), and then lists, inspects and removes `oneshot-net` networks by full id (`--no-trunc` added to the leg's `network ls`, so the id is full). Null labels are skipped; an already-gone network and one with active endpoints are skipped without a failure.
- `test/docker.test.ts`: the double answers `network create|inspect|rm|ls|connect`, `logs`, the proxy's status exec, the `resolv-read` role and the readiness inspect; strict mode allows `network inspect`; the coverage test's `NOT_GUARDED` lists the 14 new methods with a reason. New blocks: network wording, `createContainedNetwork`, upstream resolvers, roles, one-shot behind a proxy (order, arguments, the exact launch pair and configuration JSON, aliases, env), teardown on every path, `parseProxyReport` (hostile input), and the sweep.
- `test/config.test.ts`: `proxyImage` default (digest-pinned, Node 22 or later, tag in the comment) and override.
- `test/integration/docker.test.ts` (written, **not run**): `removeNetworkChecked` through `mayRemove`; `assertNameCheckBehaves` gains one-shot network and proxy names; one new describe with seven cases (below).
**Tests**: `npm test` 1986 passed, 37 skipped before; **2117 passed, 44 skipped** after (+131 run, +7 skipped Docker cases). `npm run typecheck` clean; `npm run build` clean.
**Changes to existing tests** (deliberate, forced by this leg's rules):
- `sweepCheckLeftovers` "never throws when Docker cannot be run at all": failures 2 becomes 3 (a third listing, networks).
- "a trial container left behind by a killed process is swept like a clone": its inspect labels were `LABELS.mine`, which carries a project label; the sweep now never takes a project-labelled container, so the labels are a one-shot's (no project label).
**Trials** (`git diff --stat` and `git status --short` hashed before and after all four: identical, 18 files changed; each restored by editing, never git):
1. Gateway check disabled (`false &&`): 3 tests failed (the two gateway cases and the teardown-on-failed-check case). Restored.
2. Project-label exclusion removed from the network sweep: 1 test failed ("never takes anything that carries the project label at all"). Restored.
3. Teardown removes the network before the proxy: 17 tests failed (the happy-path order, every proxy-path teardown, the ordering case). Restored.
4. Readiness accepting a status without `ready`: 2 tests failed (out of budget for "not ready" and "a 200 without ready"). Restored.
**The Docker cases** (all in `docker integration: contained networks and the one-shot proxy`; owner = a random id of the describe's own, names under `mcpe-it-<pid>-`; every removal through `removeContainerChecked` / `removeNetworkChecked` / `removeVolumeChecked`, and a final owner-filtered sweep in `finally` and `afterAll`):
1. Allowed: probe image behind a proxy allowing `github.com` runs `git ls-remote https://github.com/tomnomnom/gron HEAD`; nothing remains.
2. Allowed nothing: the same fails and `proxy.rows` holds `github.com` / `not-allowed`.
3. Refused directly with positive controls (host listener on 0.0.0.0, a listener container on `bridge`): prober on `bridge` reaches the bridge gateway (`CONNECTED` on Linux; any answer on Docker Desktop), the listener container and (Desktop) `192.168.65.254`; a prober on the contained network (no proxy variables) is refused for the network's `.1` (anything but `CONNECTED`), the bridge gateway, `169.254.169.254`, the listener container, and `192.168.65.254` on Desktop.
4. Through the proxy: `CONNECT host.docker.internal:80`, the listener container and the bridge gateway get `403`, once allowing only `github.com`, once allowing those very entries with `local`.
5. While running: `docker inspect` of the proxy (`NetworkMode` bridge, read-only, `CapDrop` ALL, no `CapAdd`, no port bindings, user `node`, networks exactly `bridge` and the one-shot network), the one-shot's `NetworkMode`, `docker exec` into the proxy (uid and Node version), and a prober on `bridge` gets `ECONNREFUSED` on the proxy's bridge address on 3128.
6. Start failure: `MCPE_PROXY_IMAGE` set to the probe image (no `node`) gives `ProxyStartError`; nothing remains.
7. Sweep: a test-made aged `oneshot-net` and `oneshot-proxy` (sweep age 0, this describe's owner) are removed; a network and a container with a project label survive.
**Docker state before the gated run** (read-only: `docker ps -a -q --no-trunc`, `docker volume ls -q`, `docker network ls -q --no-trunc`, 2026-11-22):
- Containers, 22 (sha256 of the output starts `8af5a4baef98358b`):
  `1bf8d328c7915ad682ef8be1a4648f0bda66e766f3b8718feb159e40d413dee0` `4862dc6bdd92bdbf059a29c1d9b26756033a3dca2d47aca9ac02cfa3b3267746` `52e8c288b5a1b2a93b683e1895b8922d01a39e05cbda7603cbc51fdbac45fe1e` `7d75675c038e8df9b8e5e88d83c3f786300515ab231ad3cc8e0bdb526fd56809` `0a41d59982924bed365389036ec0afe0add8a15b3abf676d138fb59c63744861` `9c6b79841c35138d4ac2267b11692abfbb521e268916373e02d791d72dc2c06a` `f71a3b30ce661498ed6d5864259e2b22e1dd390f3f0e4fe029d23ae3cef2890c` `665f39adfe00f76cc711a408499b4b38b31bf01e108afde2219813a598a40e58` `7b144f9777119594abc6b6839d29de7f50d5f6223a9d92d1f9d026f9ab755f21` `fd587c938d433c986bcdc6962a77664eefd6ca1afd4a3ffd14d4a2e3afd26646` `fb6814b6904c90f161a54a210f287a26271fdf02015a90036aae4da66732831b` `89b7d8151868c39406247ff3b56af8ecbd4cdd881ae2bfe3bd41e8e8439d51f0` `235051f29be509969766542467cafc93a4dde838d07fff6d37940d0231ea9f69` `5465d1348cb56b3b25959af085df7034a6f90fe153339aa9185d147976224d07` `bdfb3d0f88333fdf6d6ee9e16eec21bc72f5ac4418238d11589005b3aab40679` `bf55b2872a3a614cbae49930d1430e0eda80df8d85134ef05b6523921c712330` `ddbf390e524a6927072c1c0e16cdc3627525378592ffb1a21730a31c0dc54c4c` `7941abb309c023b7ce450cf5f0d002fa6bb70842b61e43a0c6581057a08abebf` `24305c4cba1e2393cf2123dc8408e1c64590b73a2babfb555903c08ec8b01c56` `d390797513969f07fea96c1c0442cabae70dd612f92314af1630cddd188d4140` `9eb376fc3bea9cc599f66dc67afe72f6e8b6acc1faa9ca35e0b9025c72fe01d7` `9eac669dbf238cee693c4d84e8ff8d6794b70c8f74572488098f3dbae8522977`
  (names: `mcpe-bde0aedf-{yfinance,maverick_mcp,diagnostic,backtest,netron,solvor,algebrite}`, `mcpe-ha_googlehome`, `mcpe-rea`, `mcpe-cowsay`, `mcpe-gron`, the `concourse-local-*` set, `air-traffic-control-*`, `registry`.)
- Volumes, 244 (sha256 of the output starts `1b198447fc48e0f8`): 221 anonymous 64-hex ids and 23 named; recorded as count and hash because the list is 244 lines of anonymous ids. The after-run check compares both and the sorted list. The named ones include `air-traffic-control_atc-*`, `claude-trader_postgres_data_dev`, `concourse-local_*`, `epipen_epipen-graph`, `mcpe-bde0aedf-*`, `mcpe-cowsay`, `mcpe-gron`, `mcpe-ha_googlehome`, `mcpe-rea`, `the-one_*`.
- Networks, 8 (sha256 starts `a2fe9cbb670042b4`): `a319d00ede60b3b4541cb6332ba83e0c817a0cf096f016b0edcc1a1cd526828b` (air-traffic-control_default) `4e100e1ab26406e9ea8ae7e11a3f7f294c4facd5b881145b1be91577b0c68189` (atc-sessions) `70c5e967e1249fbec4749d8c9856422d868adf8ad018db88e3c2e317019add58` (bridge) `e60451e221a0a4f6ec6de8d4ddb6a7d3a9ce6d42e880cf377e7fde2c7a3d5efc` (concourse-local_default) `39caee5f8c2240c83295a5d9401aed4d247b214ef4dc49e817da07b25814a20c` (epipen_default) `e23718008631e774827ac0c96238ab9924f911829584e8bded9388325680b1bd` (host) `7171621c55473449657dd2e85a3e462fb08e02cd540776a81c39628fe8d3fdd6` (none) `d88b147fb234fbc647b97d9a54d2f79aada9a143762c9786353c50d510f0b4cc` (src_default).
**Deviations**:
- `network ls` for the sweep gets `--no-trunc` (the leg's command lacks it), so that the removal is by a full id, as for containers.
- A throw from the one-shot's own start still reads the refusals (the leg says "or throws"), and they ride on the thrown error as a `proxy` property, since a throw cannot return them. Nothing reads that property yet; leg 7 may.
- `createContainedNetwork` takes `{ role, name?, project? }` rather than a bare `labels` argument; the leg says it "names the network itself" and "leg 6 passes a project name".
- A failed `network create` (non-zero) is `ContainmentUnavailableError`: a Docker that refuses the isolated options is one that cannot contain. The leg said "throw with the cleaned last line" without naming the class.
- `OneShotRole` is derived from the exported `ONE_SHOT_ROLES` instead of a parallel list; the agreement test checks the list's contents and that every role runs.
- The proxy is created without `--rm` (an exited proxy must keep its logs for the readiness message).
- The generic `mcp-everything=1` label is not put on networks (the leg names owner, role and project only); containers keep it.
**Phase B (Docker gate opened by the Flight Director)**:
- `npm run test:docker`: first run 41 passed, 2 skipped (pressure), 1 failed, 293.8 s (baseline ~280 s; the 7 new cases are included). The failure was a test bug: `parseHostEntry("host.docker.internal", "agent")` refuses `.internal`; changed to mode `local-access`. Re-run of that case then showed `host.docker.internal:80` answered **502**, not 403, when the entry is allowed by name with `local` on (a refusal by address or resolution, never 200). The assertion was widened for that second run only to `403|502`; the first run (nothing allowed) still requires 403 for every target. Reported to the Flight Director as a change to a refusal assertion (no connection is allowed either way). The rest of the suite, the full 44-case file, was not re-run after that one-case fix; the case passed alone (17 s). Cases 1-6 and the sweep case passed in the full run, including the `.1` case (what was observed was within the accepted looseness; the test does not print it).
- Measurements (objects `mcpe-it-measure-<random>-*`, owner label that random id, removed by exact name):
  - `node --version` in `node:22-alpine@sha256:1314fb30…`: **v22.23.5** (matches the tag).
  - `docker exec` into the `--read-only`, `--user node`, cap-dropped proxy works (readiness depends on it and case 5 runs `node -e` in it: uid and version asserted).
  - Network alias on an internal network held by two containers (`a`=172.22.0.2, `b`=172.22.0.3), `getent hosts mcpe-proxy` from a client, ten tries: 4x .2 and 6x .3 (both holders are returned, no stable choice). After `docker restart` of `b` (it kept 172.22.0.3): 6x .2, 4x .3. So an alias held by two containers load-spreads; leg 6 must not leave a second holder.
- `npm test` 2117 passed, 44 skipped; typecheck and build clean.
- After-run lists: containers 22, sha256 prefix `8af5a4baef98358b` (unchanged); networks 8, `a2fe9cbb670042b4` (unchanged); no `mcpe-it` container or network remains. Volumes 244 to **246**, hash `806405b78464e707`: two new anonymous volumes (labels `com.docker.volume.anonymous`, created during the run). **Finding**: the probe image `alpine/git` declares `VOLUME /git`, and `runOnce` removes its container with `rm -f` (no `-v`), so each one-shot of the probe image leaves an anonymous volume. This is pre-existing in `runOnce` (the clone and copy do it today) and the two new ones are from this run's git cases. I did not remove them (anonymous, no name to check). Suggest `rm -fv` in `runOnce`, or `--volume` handling, as a squawk; not done here.

### project-network-primitives
**Status**: landed (not committed)
**Changes** (Phase A):
- `src/sandbox/docker.ts`:
  - **Volume fix**: `rm -f -v` in `runCreated`'s teardown, its create-timeout path (by name) and `dropContainer` (the proxy teardown).
  - **Inspect facts**: both formats add `"name":{{json .Name}}`; the leading `/` is stripped; `ContainerFacts.name` is optional (a scripted answer without it still parses). Exported `SandboxInspectFacts` `{ id, name, running, labels, networks, runtime }` for leg 7's hook.
  - **Facts kinds**: `SandboxFacts.kind` and `SandboxRefusedError.kind` gain `"network"` and `"proxy"`; `describeFacts` shows the project label for them too. `describeLeftPart` (installer) already prints `${kind} "name"`, so the new kinds are named with no change there.
  - **Public pieces**: `projectNetworkName(sandbox)` (function), `makeRef(id, name, env?)` (now exported; `env` is a frozen copy), `envFlags(env)`, `NetworkMode`, `ProjectProxy`, `SANDBOX_LABEL`.
  - **`checkContainedNetwork`** (private, pure): the DD3 block factored out of `createContainedNetwork`. Checks owner, role, project and sandbox first (a mismatch is `foreign`), then internal, no IPv6, one IPv4 subnet, no gateway. Used for creation and adoption.
  - **`createContainedNetwork`** takes `{ role, name?, project?, sandbox? }` (and puts a `mcp-everything.sandbox` label when given); it wraps a private `createNetwork` that also reports `created`. With a fixed name, a failed or timed-out create re-inspects by name: ours and passing is adopted, anything else throws, and it **never removes by name** (not even for an unusable id); a created network that fails its check is removed by its id.
  - **`ensureProjectNetwork(sandbox, project)`** returns `{ id, name, subnet, created }`; foreign is `SandboxRefusedError`, ours but uncontained is `ContainmentUnavailableError` (left alone).
  - **`attachProjectNetwork(ref, net)`**: `disconnect -f` (failure ignored), then `connect`. The disconnect names the network by its NAME and the connect by id (see Deviations).
  - **`createProjectProxy(sandbox, project, config, labels)`**: validates caller labels (`mcp-everything.<name>` only, no reserved name, no line break) and aliases (`mcpe-proxy` refused); requires the project network (never made here); creates `<sandbox>-proxy-<hex8>` hardened as the one-shot's proxy plus `--add-host host.docker.internal:host-gateway`, with labels `mcp-everything=1`, owner, role `project-proxy`, project, sandbox, then the caller's; `network connect --alias mcpe-proxy --alias <forward host>... <net id>` before `start`; readiness requires `PROXY_PROGRAM_VERSION`. Any failure removes what it made (by name, then by id, `-f -v`) and throws `ProxyStartError` or the runtime error.
  - **`startProjectProxy(id)`** (classified, then `start` and readiness accepting any version string), **`projectProxyStatus(id)`** (public wrapper of the private `proxyStatus`; never throws), **`listProjectProxies(sandboxName)`** (`ps -a -q --no-trunc` with owner and role filters; kept by the inspect's name `^<sandbox>-proxy-[0-9a-f]{8}$`, the sandbox label and a project label; needs no container), **`removeProjectProxy(id)`** (classified; `rm -f -v`), **`removeProjectNetwork(net)`** (classified by id; "not found" is success).
  - **`networkState`** replaces `hasNetwork`: from one inspect; `off` / `contained` (its own `-net` only) / `open` (anything else); a missing container is `off`.
  - **`setNetwork(target, mode)`** replaces the boolean form exactly as Design Review 2 resolution 1: `off` on `bridge` alone or on nothing makes today's calls (no `-f`); with a `-net` listed it classifies the proxies and `-net` first, then `disconnect -f` each, then removes the proxies, then the `-net`; `open` is a no-op on `bridge`, on `-net` removes proxies, disconnects `-f`, removes the `-net` and connects `bridge` (a failed proxy removal throws before `bridge`); `contained` never creates, checks the network by name, attaches, then disconnects `bridge`.
  - **`destroy`** classifies container, volume, proxies and `-net` before any removal; order container, proxies, `-net`, volume; a foreign or label-less `<sandbox>-net` refuses the whole destroy. `removeContainer` is unchanged (keeps proxies and `-net`).
  - **Environment**: `ExecOptions.env` (doc comment: not for secrets); `SandboxRef.env`; `exec` merges `{ ...opts.env, ...ref.env }` (the reference wins) and the retry reuses it; `execOnce` takes the merged environment and validates through `envFlags`.
- `src/proxy/mcp-proxy.ts`: `dockerConnector` adds `envFlags(sandbox.env)` after `--env-file` and before the id.
- `src/install/installer.ts`, `src/server.ts`: callers move to `"open"` / `"off"` (`wantNetwork ? "open" : "off"`, `takeOffline` and the reconcile path `"off"`, `set_project_network` `enabled ? "open" : "off"`).
- Tests: `test/docker.test.ts` (the double: per-network membership by name, the inspect `name`, `network connect/disconnect [-f]`, `ps` with label filters, an active-endpoint refusal on `network rm`; ~110 new cases), `test/proxy.test.ts` (3 connector cases), `test/integration/docker.test.ts` (5 Docker-gated cases, written, not run).
**Tests**: `npm test` 2117 passed, 44 skipped before; **2225 passed, 49 skipped** after (+108 run, +5 skipped Docker cases). `npm run typecheck` and `npm run build` clean.
**Changes to existing tests** (each by editing; none deleted):
- `test/helpers.ts:110` `FakeDocker.setNetwork` and its `network` record: boolean to `NetworkMode`.
- `test/docker.test.ts`:
  - the `setNetwork(container, false)` describe renamed to `"off"`, its five cases pass `"off"` (the `disconnect bridge <id>` argv, without `-f`, is asserted unchanged);
  - `CASES.hasNetwork` renamed `networkState`, `CASES.setNetwork` passes `"off"`, the `EIGHT` list;
  - "a sandbox that is not there": the `hasNetwork` answer becomes `networkState` `"off"`, `setNetwork(false/true)` becomes `("off"/"open")`;
  - "a reference": the `hasNetwork` case (`true` becomes `"open"`), the `setNetwork` cases (`false`/`true` to `"off"`/`"open"`), the gone-reference case (`hasNetwork` false becomes `"off"`);
  - "resolving a container: decides a volume by the same rule" (the call list of a `destroy` of two absent objects now also holds the `ps` listing and the `network inspect`);
  - the destroy pair cases: the "last inspect before the first rm" pin widened to the `ps` and `network inspect`;
  - `READ_ONLY` gains `ps`; the double's strict mode allows `ps`;
  - the "every command names a 64-char id" test: `exec` parsing skips `-w` and `-e` pairs, network arguments are checked only for `connect`, `disconnect` and `rm`;
  - the coverage test: `NOT_GUARDED` gains the 7 public and 9 private new methods; `REPORTING` gains `listProjectProxies` and `projectProxyStatus` (the three state-reporting `it.each` blocks run over `STATE_REPORTERS = ["ownership"]`);
  - the `runtime` describe's "destroy, removeContainer, ownership, state, networkState and setNetwork do not compare";
  - the one-shot removals now carry `-v`: "removes the container by id after success / a non-zero exit / a timeout / when start throws", "removes by the call's own name when create times out", the probe's "says a timed-out clone timed out", and the proxy-teardown cases (the proxy create fails / times out / the one-shot times out: the `rm` argv).
- `test/installer.test.ts`: the `ScriptedDocker.setNetwork` override (mode form; the trace now records the mode), the recorded pairs at the network-policy step (`true`/`false` become `"open"`/`"off"`), the reconcile pairs, `takeOffline`'s, the `lastNetwork()` assertions (five), and the `map((n) => n[1])` pair.
- `test/server.test.ts`: the four `set_project_network` / reconcile pairs.
- `test/integration/docker.test.ts`: the six `hasNetwork` uses map to `networkState(...) !== "off"`; `setNetwork(..., false)` to `"off"`; the name check also decides a project's `-net` and proxy names.
**Trials** (`git diff --stat` plus `git status --short` hashed before and after all four: identical, `8eb6624928bf6f50`; each restored by editing, never git):
1. `rm -f` without `-v` in `runCreated`'s teardown: 7 tests failed. Restored.
2. `destroy` removing the network before the proxies: 3 failed (the three destroy order cases; the double refuses a network that a proxy is still on). Restored.
3. `contained` disconnecting `bridge` before attaching: 2 failed (the order case and "leaves bridge on when the attach fails"). Restored.
4. The caller's environment winning over the reference's: 3 failed. Restored.
The Docker case for the volume fix has a fifth, owed in Phase B: run it once with plain `rm -f` to show it can fail (it needs Docker).
**The Docker cases** (all new, in `docker integration: project network primitives`; owner = a random id of the describe's own, names under `mcpe-it-<pid>-`, sandboxes on `alpine`; every removal through `removeContainerChecked`, `removeContainerWithVolumesChecked` (new, `rm -f -v`, checked by `mayRemove`), `removeNetworkChecked` or `removeVolumeChecked`; a final owner-filtered sweep in `finally` and `afterAll`):
1. Modes: sandbox on bridge; network and proxy by the primitives; `contained` leaves it on `-net` only (and `eth0`, `lo`); `open` leaves it on `bridge` with the proxy and `-net` gone; again `contained` then `off` leaves it on nothing and nothing of the project.
2. T14 in code: contained, stop, remove the proxy and `-net` (checked), `start` fails, `ensureProjectNetwork` and `attachProjectNetwork` then `start` works, on the new `-net` only.
3. `destroy` of a contained project leaves nothing owned by the describe.
4. `destroy` after `removeContainer` finds the proxy and `-net` (and `removeContainer` left them).
5. The volume fix: a control (`docker create` of the probe image shows the anonymous `/git` volume, removed with `rm -f -v` through the checked helper), then a timed-out probe-image one-shot: the volumes that appeared, filtered to `CreatedAt` within the case's window (5 s margin), are none.
**Docker state before the gated run** (read-only, 2026-11-22/23; identical to leg 5's after-run state):
- Containers: 22, sha256 prefix `8af5a4baef98358b` (the same 22 ids as before leg 5).
- Volumes: 246, sha256 prefix `806405b78464e707`; the full list is saved at `/tmp/claude-1000/-home-cprch-projects-mcp-everything/af8c3a2b-d50f-4f71-82a3-12dc354df1cd/scratchpad/leg6-volumes-before.txt` (verified identical to the live list). They include the two anonymous volumes leg 5's run left.
- Networks: 8, sha256 prefix `a2fe9cbb670042b4` (the same 8 ids as before leg 5).
**Deviations**:
- `attachProjectNetwork` disconnects `-f` by the network's **name** and connects by id. The leg says `<net>`. The reason: Docker deletes the stale entry of a removed network under the literal string it was given, and that entry is keyed by name (T14b was run by name); an id would miss it. When the network exists, a name resolves to the same network as its id. The Docker-gated T14 case checks it.
- `createProjectProxy` takes the sandbox **name** and finds the network by name (never creating it), rather than a network argument: the leg's signature has none.
- The proxy's `mcp-everything=1` generic label is set (as the one-shot proxy's); networks still do not carry it.
- `removeProjectProxy` and `removeProjectNetwork` accept only a full 64-hex id (a name throws); `removeProjectNetwork` also accepts the object `ensureProjectNetwork` returns.
- A network of this installation with the wrong role, project or sandbox label is refused with reason `not-ours` (the facts have no class for "ours, but not this project's"), so its message says "was not created by mcp-everything".
- `setNetwork("off")` on a sandbox on foreign networks only (no `-net`, not `bridge` alone) disconnects each with `-f`; the resolutions leave that case open.
- Four existing tests changed beyond the enumerated list (all moves to the new interface): the `ps`/`network inspect` call list of "decides a volume by the same rule", the `lastNetwork()` pairs, the `map((n) => n[1])` pair and `proxy.test.ts` (new cases only).
**Phase B (Docker gate opened by the Flight Director)**:
- Full `npm run test:docker`: 46 passed, 2 skipped (pressure), 1 failed, 355 s. The failure was a test bug in the modes case: the contained sandbox's interface was `eth1`, not `eth0`. The assertion became "one `eth<n>` and `lo`" (not a security assertion; the network membership assertions are unchanged). The new describe re-run alone: 5 passed (21.6 s). The other 44 cases (leg 5's seven included) passed in the full run, so leg 5's full green run is owed no more (the one case fixed in leg 5 at its gate passed again).
- **Deviation 1 stood**: case 2 (T14 in code, `disconnect -f` by name, then `connect` by id, then `start`) passed: the stopped sandbox started again on the new `-net` only.
- **Fifth trial**: with plain `rm -f` in the one-shot teardown the volume case failed (`expected [ Array(1) ] to deeply equal []`: one anonymous volume, `36748c78…`, created in the window); with `-v` restored it passed. The trial's volume was left (anonymous, not removable by a checked name).
- After-run lists: containers 22, `8af5a4baef98358b` (unchanged); networks 8, `a2fe9cbb670042b4` (unchanged); no `mcpe-it` container or network remains. Volumes 246 to **248**: two new anonymous volumes (label `com.docker.volume.anonymous`), diff against `leg6-volumes-before.txt`:
  - `36748c788610ef2403a4ba173ea68284daf25e415abbd572aeaa856c4d5d56e1`, created 05:40:21Z: the fifth trial's own (plain `rm -f`).
  - `86292c7ff0d049c300f25e0c77e8dfb51a832bdcbceb0b7a4b5d6f741be10b2a`, created 05:34:31Z, about 60 s into the full run (started 05:33Z), before the new describe ran. **Not identified**: some earlier case. The likely cause is a suite helper `removeContainerChecked` (`rm -f`, no `-v`) on a container of an image that declares a volume (the checked helpers were left as they were). Neither was removed.
- Final: `npm test` 2225 passed, 49 skipped; typecheck and build clean; `src/` restored after the trial.

### containment-hook
**Status**: landed (not committed)
**Changes** (Phase A):
- `src/network/containment.ts` (new): `Containment(cfg, registry, docker, { dataDir, log?, clock? })`.
  - **Pure parts**: `phaseOf` (status `installing` is build, anything else run; the one source), `allowanceFor` (phase hosts plus `record.hosts`, each through `parseHostEntry(…, "agent")`, an invalid one dropped with a warning), `recordLabelOf` (phase, sorted allow, `DEFAULT_HOSTS_VERSION`, the `-net`'s id and subnet), `sessionLabelOf` (forwards, resolvers, `MCPE_EXTRA_HOSTS` mapping, proxy image; sorted, canonical JSON, SHA-256), `proxyVersionOf` (missing or unparseable is 0), `proxyEnvironment()`. Labels: `mcp-everything.proxy-record`, `.proxy-session`, `.proxy-version`.
  - **`buildConfig(record, net)`**: forwards from `localAccessFor` minus `mcpe-proxy` (warning), resolvers from `readUpstreamResolvers()`, `listenCidr` the subnet.
  - **Locks**: `withProjectLock(key, fn)` takes the in-process mutex (a promise chain, wait bounded at 60 s) and the lock file `<dataDir>/registry.json.proxy-<sha256(key)[:16]>.lock` (token, polled every 100 ms, stale after 120 s, 60 s wait then `ContainmentBusyError`), then runs `fn` under a 90 s deadline that starts once both are held (monotonic clock; also a timer). Release removes the file only if the token is still ours. `assertLive()` (deadline plus token re-read) runs before the others are removed. Injected `Clock` (`now`, `mono`, `after`, `sleep`).
  - **`replace(key, { force?, compareSession? })`**: image outside the lock; lock; record read fresh (`registry.refresh()`, `findByRepo`, `registry.update(slug, cur => { captured = structuredClone(cur); return undefined })`); `ensureProjectNetwork`; list; a newer-`proxy-version` proxy is kept (started if stopped; `force` does not override; no resolver read; remembered 60 s, logged once per process per project); `buildConfig`; list again; unless `force`, exactly one running proxy of this version with an equal record label (and with `compareSession` an equal session label) attached to the current `-net` under `mcpe-proxy` stops it; the new proxy's name is chosen beforehand, created and awaited, removed by name in a `finally` on any failure or deadline; `assertLive()`; the others removed (never a newer one).
  - **`contain(key)`**: under the lock, `replaceLocked` (which makes the network first), `setNetwork(sandbox, "contained")`, invalidate. A failure at any step runs `setNetwork(sandbox, "off")` and **returns** `{ ok: false, error }`.
  - **`ensureContained(facts, mode)`**: no project label: nothing. `"observe"` and the `open` session: the environment if the facts say contained, no record read, no waiting, no repair. Under `contained`: `waitFor(key)` first (a rejection refuses with `ContainmentStartupError`); if it waited, `docker.inspectSandbox(name)` re-reads the facts; `off`/`open` are no-ops; contained: no record gives no environment (fails closed, stated in a comment), a record whose `container` is not this sandbox gives the environment only, otherwise a lock-free check (`findProjectNetwork`, `listProjectProxies`, `projectProxyAttached`, the record label only) and, when it is not fine, `withProjectLock` and `repairLocked` (re-checks inside the lock; `ensureProjectNetwork`, re-attach when `created`, start a stopped proxy, or `replaceLocked`). Resolver failures (`projectProxyStatus`, at most once a minute per project) `>= 3` give `invalidateResolvers()` and a forced replacement.
  - **Startup**: `registerStartup(key, promise)` (no-op `catch` attached at once), `waitFor`, a failed entry stays until a successful `contain` or `replace` clears it.
  - **Errors**: `ContainmentError` and `ContainmentBusyError`, `ContainmentDeadlineError`, `ContainmentLockLostError`, `ContainmentUnreadableError`, `ContainmentStartupError`.
- `src/sandbox/docker.ts`:
  - **Hook**: `setContainment(hook)`; types `ContainmentHook`, `ContainmentHookMode`; `hooked()` is the one place the hook is called, with `SandboxInspectFacts` from the inspect already made. `acquire` (hook, then start; the reference carries the environment), `ensureRunning` (by reference now reads labels when a hook is installed), `startIfStopped` (hook, then start; returns the fresh answer) and `exec` (by name: the inspect already made; by reference: one full inspect on a cache miss; `restart: false` is `"observe"`, no cache, no runtime comparison for a reference) pass through it. The retry after a restart uses `startIfStopped`'s fresh answer. Merge order: caller, hook, reference.
  - **Cache**, owned by `Docker`: by container id, 5 s (`hookTtlMs`, `clock()` overridable), read only by an exec by reference, written only when the inspect said running, a generation counter discards an answer in flight across an invalidation; `invalidate({ id?, sandbox?, key? })` public; `setNetwork` and `destroy` invalidate in a `finally` (bodies renamed `setNetworkNow`, `destroyNow`).
  - **New public pieces**: `startForContainment(name)` (the unhooked start, classified and runtime-checked), `inspectSandbox(name)`, `findProjectNetwork(sandbox, project)`, `projectProxyAttached(id, net)` (read-only inspect of the proxy's networks: `NetworkID` and the `mcpe-proxy` alias), `removeProjectProxyNamed(sandbox, name)`, `createProjectProxy(…, { name? })`, `newProjectProxyName(sandbox)`, `networkModeOf(name, networks)` (now what `networkState` uses).
- `src/server.ts`: `App` builds `Containment(cfg, registry, docker, { dataDir, log })`, installs it, exposes it as `app.containment`.
- Tests: `test/containment.test.ts` (new, 70 cases on a double of the Docker layer, a real `Registry` in a temporary directory, a fake clock), `test/docker-bypass.test.ts` (new, 6), cases in `test/docker.test.ts` (hook placement, cache, real `Containment` over the scripted double: recursion count and cost; 46 new), `test/server.test.ts` (2), `test/integration/docker.test.ts` (4 Docker-gated cases, written, not run).
**Tests**: `npm test` 2225 passed, 49 skipped before; **2353 passed, 53 skipped** after (+128 run, +4 skipped Docker cases). `npm run typecheck` and `npm run build` clean.
**Measured Docker calls per exec under `open`** (real `Containment` as the hook on the scripted double, sandbox on `bridge`, running):
- By reference, one exec per second for ten seconds: **10 `exec` + 2 `inspect`** (12 calls; the cache holds 5 s); a burst of ten inside one window: 10 `exec` + **1 `inspect`**. Without the hook it is 10 calls. So the extra cost is at most one full inspect per 5 s per sandbox.
- By name: `inspect` + `exec`, as before (the inspect already happened; the hook adds none).
- Under `open` the hook itself makes no Docker call: no listing, no network inspect, no registry read.
**Changes to existing tests** (by editing; none deleted):
- `test/docker.test.ts`: the coverage test's `NOT_GUARDED` gains `setContainment`, `invalidate`, `clock`, `hooked`, `hookCached`, `setNetworkNow`, `destroyNow`, `findProjectNetwork`, `projectProxyAttached`, `removeProjectProxyNamed` (new methods, each with its reason); `CASES` gains `startForContainment` and `inspectSandbox` (they classify by name, so they get the refusal and acts cases); the double's `inspect` answers the `{{json .NetworkSettings.Networks}}` format (ids and aliases); imports. No assertion of an existing case changed.
- `test/server.test.ts`: import and a new describe; nothing existing changed.
- No other existing test changed: every existing case passes under the default `open` with the hook installed in `App`.
**Trials** (`git diff --stat` plus `git status --short` hashed before and after: identical, `380b8ffb3d362ecd`; each restored by editing, never git):
1. Repair comparing the session label (`assess`): 5 failed (fine path, never-compares, stopped proxy, resolver cases). Restored.
2. Removing the others before the new proxy is ready: 4 failed (order, create failure, stolen token, deadline). Restored.
3. The hook skipped in `startIfStopped`: 3 failed (the restart case, the cache's restart case, the bypass test's "asks the hook before its first start"). Restored.
4. The phase derived as "run" during `installing`: 4 failed (`phaseOf`, build hosts, label, fresh-read). Restored.
5. The token check removed from `assertLive`: 1 failed (the stolen-token case). Restored.
6. (Extra) A new method `trialBypass` calling `this.docker(["start", id])`: the bypass test failed by name in three places (the table, the call-site scan, the old coverage list). Removed.
**Docker state before the gated run** (read-only, 2026-11-23; same method as leg 6: `docker ps -a -q --no-trunc`, `docker network ls -q --no-trunc`, `docker volume ls -q`, hashed unsorted):
- Containers: 22, sha256 prefix `8af5a4baef98358b` (unchanged since leg 5).
- Volumes: 248, `ef82d3c19c8d0087`; the full list is saved at `/tmp/claude-1000/-home-cprch-projects-mcp-everything/af8c3a2b-d50f-4f71-82a3-12dc354df1cd/scratchpad/leg7-volumes-before.txt` (verified identical to the live list). They include leg 6's two anonymous volumes.
- Networks: 8, `a2fe9cbb670042b4` (unchanged).
**Deviations**:
1. **The bypass test uses TypeScript 7's `typescript/unstable/sync` API** (the native parser behind a spawn), because TypeScript 7 has no JavaScript compiler API (`import("typescript")` exports only `version`). Same AST approach as the leg asks for; the API is marked unstable. It is in a new file, `test/docker-bypass.test.ts`, not in `test/docker.test.ts`.
2. **`setContainment(hook)` takes no `invalidate` callback**: with the cache owned by `Docker` (resolution 8), `Docker` invalidates itself and `Containment` calls `docker.invalidate(...)`.
3. **`record.hosts` is not on `ProjectRecord`** yet (a later leg adds it): `allowanceFor` reads `(record as { hosts?: unknown }).hosts`. `src/types.ts` is untouched.
4. **`contain` returns `{ ok, result | error }`** instead of throwing ("the error is returned").
5. **The re-inspect after a startup wait happens only when something was waited for**, not on every contained call: with nothing registered, the facts just read are as fresh as a second read would be.
6. **Under `open`, a contained sandbox is given the environment but never repaired** (the leg says "never loosens, never waits, returns the environment if contained"; repair is read as part of managing proxies, which an `open` session does not do).
7. **New Docker methods beyond the leg's list**, each needed by a stated step: `findProjectNetwork` (the T14 network inspect without creating), `projectProxyAttached` (the "attached to the current -net with the alias" check), `removeProjectProxyNamed` and the `name` option of `createProjectProxy` (the removal by name on the deadline), `inspectSandbox` (the re-inspect), `newProjectProxyName`, `networkModeOf`.
8. **The mutex and the file lock share one 60 s wait budget** for the file poll, and the mutex has its own 60 s timer (the leg says 60 s for "the lock"); the deadline race lets the work continue in the background after it fires (it stops at its next `assertLive`, and its `finally` removes its own proxy by name), so the lock is released at the deadline rather than after the straggler.
9. **A reference that is a stale `acquire` result keeps its environment** (the reference's environment wins, leg 6): a reference acquired under `contained` and held across a switch to `open` still carries the proxy variables, which then point at a proxy that is gone. `McpProxy` re-acquires per session; noted for leg 8.
**The Docker cases** (written, not run; describe `docker integration: containment hook (leg 7)` in `test/integration/docker.test.ts`; owner = a random installation id of the describe's own, names under `mcpe-it-<pid>-<id>-`, sandboxes on the proxy image (it has Node), a registry in `<tmp>/mcpe-it-ct-<id>` of the describe's own; every removal through `removeContainerWithVolumesChecked`, `removeNetworkChecked` or `removeVolumeChecked`; an owner-filtered sweep in `finally` and `afterAll`):
1. Two contained projects (through `contain`) cannot reach each other: a raw connect from A to B's address on its `-net` is refused, and a `CONNECT` to it through A's proxy is 403; the positive control is two sandboxes left on `bridge` that reach each other.
2. Replacement without a reinstall: a `CONNECT` to `github.com` is 403, the record gains `hosts: ["github.com"]`, `replace`, then 200 and exactly one proxy (a different one); the statuses seen during the overlap are logged, not asserted.
3. Repair: a proxy removed by hand, then an exec by name has `HTTPS_PROXY` and a new proxy exists; the sandbox stopped, its proxy and `-net` removed (checked), then `acquire` recreates the `-net`, runs the sandbox on it only, and a `CONNECT` to `github.com` is 200.
4. Build phase: an `installing` record with node is contained; `registry.npmjs.org` and `github.com` are 200, `example.org` 403; an exec does not replace the proxy.
**Phase B (Docker gate opened by the Flight Director)**:
- Full `npm run test:docker`: **51 passed, 2 skipped (pressure), 0 failed**, 358 s. All four new cases passed first time; no assertion changed.
- The overlap statuses of case 2 were logged with `console.log`, but the run's output file has no such line, so **they were not observed**. Not asserted, as the leg says.
- After-run lists: containers 22, `8af5a4baef98358b` (unchanged); networks 8, `a2fe9cbb670042b4` (unchanged); no `mcpe-it` container, network or temp data directory remains. Volumes 248 to **249**, `a33c6d2815fa2bf9`; diff against `leg7-volumes-before.txt`: one new volume, `48f962bbcbed13056cc92897ab2f0bc40ecb9f997e3f13586d58b03d531de550`, anonymous (`com.docker.volume.anonymous`), created 06:07:09Z, about a minute into the run, so before the new describe: the same unidentified older-case leak as leg 6's (a checked `rm -f` without `-v` on a container of an image that declares a volume). Not removed.
- Final: `npm test` 2353 passed, 53 skipped; typecheck and build clean.

### contained-install
**Status**: landed (not committed). Stage A, the Flight Director's change (below), and Stage B are done.
**Changes** (Stage A):
- `src/network/refusals.ts` (new, pure): `refusalLines(rows, context)` (`build` | `clone` | `scanner`; one line per `(host, port)`, at most 10 lines with the last one "and N more." when there are more; a row with no host is skipped; hosts are cut to `[A-Za-z0-9._:[]*-]` (anything else becomes `?`) and always between backticks), `refusalWarnings(rows, max)` (the successful-build warnings: `not-allowed` rows only, one per `(host, port)`, at most `max`), `joinRefusals(lines, sep)` (whole lines, at most 1,500 characters).
- `src/sandbox/docker.ts`:
  - `createContainer` gains `start?: boolean` (default `true`: `run -d`, as before). `start: false` is `docker create` with the same arguments minus `-d` (two literal verbs, so the bypass test reads both), still `--network bridge`, id verified. `start !== false` under `cfg.network.mode === "contained"` throws before any Docker call, so "never started on bridge under containment" is a code guarantee.
  - `startId(id, label, mapRuntime)`: `startForContainment` passes `true`, so Docker's unknown-runtime refusal on a new sandbox's first start is `RuntimeUnavailableError` (the other callers keep their plain error, so no existing assertion changed).
  - `probe`: under containment `runOnce({ egress: { allow: [parseHostEntry(repo.host, "scanner")], local: repo.host is not github.com or gitlab.com } })` instead of `network: "bridge"`. A failed clone under containment throws the new `CloneFailedError` (`detail`, `refusals`; the message is `detail` plus the lines); under open it is the same plain `Error` as before. `ProxyStartError` is untouched (it never reaches the clone's failure branch).
  - `runScanner` returns `OneShotResult`; with `spec.network` under containment it runs with `egress: { allow: spec.hosts parsed in scanner mode, local: true }`; without a network it is `"none"`; under open it is today's `"bridge"`/`"none"`.
  - `projectRefusals(sandboxName)` (new, public): lists the sandbox's proxies (at most 4), reads each status with `projectProxyStatus`, parses with `parseProxyReport`, returns the rows; `[]` on anything unavailable, never throws.
- `src/network/containment.ts`: `ContainmentOptions.defaults?: DefaultHosts` (the test seam; `App` never passes it), threaded through `allowanceFor(record, table?)` at both call sites (`buildConfig` and `assess`); `contain(key, { start })` starts the sandbox through `startForContainment` after `setNetwork(..., "contained")`, inside the lock, and returns `{ ok: true, result, sandbox }` (the started reference); a start that fails, or a sandbox that is gone, takes the sandbox off the network and returns `{ ok: false }`; `ContainmentDocker` gains `startForContainment`.
- `src/install/installer.ts`:
  - 7th trailing constructor parameter `containment?: InstallContainment` (`contain(key, { start })`, `replace(key)`); under `contained` without one the constructor throws.
  - Contained `finishInstall`: `record.ecosystems = [primary, ...detected without primary]`, then one `registry.put(structuredClone(record))` (still `installing`) after `imageReason` and before `buildAttempts` (interim: `hosts` not preserved, until leg 9's merging writer). `buildAttempts` per attempt: `createContainer({ start: false })`, `state.current.sandbox` set, `containment.contain(repo.id, { start: true })`, `{ ok: false }` throws `new Error(error.message)`, and the build `exec`s (and attempt 2's `CLEAN_SCRIPT`) run on the reference `contain` returned.
  - The refusal read: `docker.projectRefusals(container)` once, right after `buildAttempts` returns, before the success/failure branch (contained only). Failed build: `error` gets the `refusalLines(..., "build")` after the existing text (joined by spaces), `errorLog` the same joined by newlines, then `takeOffline`. Finished build: `refusalWarnings(rows, 5)` go on the record's warnings, written by the final `put`.
  - Three end branches (DR2): contained and `network: false` is `setNetwork("off")`, `discover`, `put(ready)`; contained and `network: true` is no `setNetwork`, `record.network = true`, `discover` (the record still says `installing`), `put(ready)`, `containment.replace`, `proxy.closeProject`, `docker.invalidate`; a failed `replace` leaves the project `ready`, `setNetwork("off")`, `record.network = false` and a warning ("The run allowlist could not be applied (...); its network was turned off."), written by a second `put` of a snapshot (if the `off` also fails: `network` stays true and the warning says so); open is today's code, unchanged.
  - `checkClone`: a `CloneFailedError` with refusals gives `oneLine(refusal lines + " " + detail, 300)`, so the cut is of git's text.
- `src/scan/run.ts`: `ScanDocker.runScanner` returns `OneShotResult`; refusal lines (`"scanner"`, whole lines up to 1,500 characters) are appended only to `failed(...)` outcomes, through `redact`, the whole kept to 2,000 characters; unchanged text when there are no rows.
- `src/server.ts`: `Containment` is built, and installed as the hook, before the `Installer`, which is given it as its last argument.
**Tests**: `npm test` 2353 passed, 53 skipped before; **2430 passed, 59 skipped** after (+77 run, +6 skipped Docker cases). `npm run typecheck` and `npm run build` clean. New: `test/network-refusals.test.ts` (16); `test/installer.test.ts` "a contained install" (20+); `test/docker.test.ts` (createContainer `start: false`, `startForContainment`'s runtime mapping, the clone's and the scanner's egress, `projectRefusals`); `test/containment.test.ts` (contain with `{ start }`, the seam, 8); `test/scan-run.test.ts` (5); `test/server.test.ts` (2).
**Changes to existing tests** (by editing; none deleted; no existing assertion changed, only doubles and a helper):
- `test/containment.test.ts`: `FakeLayer` gains `startForContainment` (and `startError`) because `ContainmentDocker` gained the method; import of `makeRef`.
- `test/installer.test.ts`: `ScriptedDocker.createContainer` takes and records `start` (`createStarts`); `ScriptedDocker.projectRefusals` traces; `setup()` builds a `FakeContainment` and passes it as the installer's 7th argument (unused under open).
- `test/helpers.ts`: `FakeDocker` gains `projectRefusals` (`refusals`, `refusalCalls`).
- `test/scan-run.test.ts`: the `Fake` double's `runScanner` and `run` are typed `OneShotResult` (a type change only).
- `test/docker.test.ts`: `REPORTING` gains `projectRefusals` (the method-coverage test); import of `CloneFailedError`.
- `test/docker-bypass.test.ts`: the `createContainer` note rewritten (the listed exception is now the open mode's; under containment it creates stopped), `projectRefusals` added to the table.
- `test/integration/docker.test.ts` (leg 7's describe): `makeProject` creates with `start: false` and starts the sandbox itself with `startForContainment` (it wants a running sandbox on `bridge` to contain), because `createContainer` now refuses a start under containment. Written, not run.
**Trials** (`git diff --stat` plus `git status --short` hashed before and after all five: identical, `1acb804c0b3e8703`; each restored by editing, never git):
1. The pre-contain record write removed: 3 failed (the ecosystems-before-`contain` case, the ecosystem override, `installChecked`'s sequence). Restored.
2. The sandbox created without `start: false` under containment: 4 failed (the order, the second attempt, a failed containment, `installChecked`). Also the guard in `createContainer` disabled (`false &&`): 1 failed (the refusal case). Restored.
3. Discovery before `setNetwork("off")` with `network: false`: 1 failed (the order case). Restored.
4. A refusal host interpolated unquoted (`quote` without backticks and without `safeHost`): 20 failed across `network-refusals`, `installer`, `scan-run`. Restored.
5. (DR2) `setNetwork(sandbox, "open")` added on the contained network-on branch: 4 failed ("never opens", the end-of-install order, both failed-replacement cases). Restored.
**Deviations / readings** (nothing in the leg contradicted landed code):
1. `Containment.contain(..., { start })` returns the reference as a top-level `sandbox` on the ok result (`{ ok, result, sandbox }`), not inside `result` (`ReplaceResult` is the replacement's own).
2. The mapping of the runtime refusal is in `startId` behind a flag used by `startForContainment` only (the bypass test requires `startForContainment` to call `startId`; the stderr is not available outside it).
3. `refusalWarnings` counts `not-allowed` rows only; the leg says "refusals". A refused address or a failed connect on a build that finished is not something `hosts` fixes, and the sentence would be wrong for it.
4. The refusal read has the one fixed point DR2-3 names. The leg's "Failure paths" bullet (a failed build, a timeout, `settleFailure`, an interrupted install) is therefore met for the first two only; a throw inside the build (`settleFailure`) and an interrupted install (`reconcileStale`) do not read the proxy before `takeOffline`. Flag for the Flight Director if the others are wanted.
5. At most 10 lines includes the "and N more." line (9 hosts and the count).
6. A scanner's lines are appended to its failure text only when there are rows; the whole error is then bounded at 2,000 characters.
7. Everything about `check_project` under containment is Docker-layer behavior (the clone and the scanners); `Installer.check` needed no change.
**Docker state before the gated run** (read-only, 2026-11-23; same method as legs 6 and 7):
- Containers: 22, sha256 prefix `8af5a4baef98358b` (unchanged since leg 5).
- Volumes: 249, `a33c6d2815fa2bf9`; the full list is saved at `/tmp/claude-1000/-home-cprch-projects-mcp-everything/af8c3a2b-d50f-4f71-82a3-12dc354df1cd/scratchpad/leg8-volumes-before.txt` (verified identical to the live list). They include leg 6's two and leg 7's one anonymous volumes.
- Networks: 8, `a2fe9cbb670042b4` (unchanged).
**The Docker cases** (written, not run; describe `docker integration: the contained install (leg 8)` in `test/integration/docker.test.ts`; owner = a random id of the describe's own, names under `mcpe-it-<pid>-<id>-`, registry and data directory `<tmp>/mcpe-it-c8-<id>` removed only after a location and basename check; every removal through `removeContainerWithVolumesChecked`, `removeNetworkChecked` or `removeVolumeChecked`, by an owner-filtered sweep in `finally` and `afterAll`):
1. `tomnomnom/gron`, contained, scan off: ready, `gron__gron`, no refusal warning and no `MCPE_WARN` line; the states are `open` right after create and `contained` right before the first start; offline at the end (no `-net`, nothing on the sandbox). Records the refusal rows.
2. `tomnomnom/gron` with `network: true`: ready, still contained on its `-net`, one proxy, `proxy.golang.org` 200 and `github.com` 403 through it (the run allowlist), no refusal warning.
3. `piuccio/cowsay` at `eef317a302d0...`, contained: ready, `cowsay__cowsay`, no refusal warning; a probe exec before the build records `node -v`, `npm -v`, a `fetch` of the npm registry with the hook's environment and with `NODE_USE_ENV_PROXY` unset (recorded, not asserted).
4. The refused build host: cowsay with `registry.npmjs.org` removed from the table by `Containment`'s test seam, its own `Docker`, `Containment` and `Installer`, `timeoutSec: 600`: failed, a `registry.npmjs.org` `not-allowed` row, every `refusalLines` line in `record.error`, the `` `registry.npmjs.org:443` `` and the reinstall hint, offline afterwards; its time is recorded.
5. `Installer.check` of gron under containment: `checked`, nothing left.
6. The sequence by hand (create stopped and on `bridge`, `contain` leaves it stopped on its network only, then it starts contained), and `createContainer` refusing a start.
**Public repositories cloned by the new cases**: `tomnomnom/gron` (cases 1, 2, 5) and `piuccio/cowsay` (3, 4), over the contained proxy, from github.com. The `pnpm`, `yarn`, Debian `need`/`apt-get`, Python, Rust, Ruby and CMake/autotools rows stay unmeasured.
**Change after the gate (Flight Director, decision 4)**: `settleFailure`, when a contained sandbox exists, reads `projectRefusals` before `takeOffline` and appends the lines to the failed record's `error`/`errorLog` (same caps). `reconcileStale` does not (new process, the proxy is often gone). Unit case "a build that throws (settleFailure) carries them too ...; reconcileStale reads nothing". Trial 6: the read disabled (`false &&`) made that case fail; restored by editing (hash `59736c654c11a1c6` before and after). `npm test`: 2431 passed, 59 skipped.
**Phase B**:
- Full `npm run test:docker` (`timeout 2700`): 55 passed, 2 skipped (pressure), 2 failed, 401 s. Both failures were test bugs in my new describe: its sweep left the describe's own registry records, so the second gron install ("network on") and the cowsay refused-host install found a `ready` record and answered at once (155 ms, 163 ms). Fix: the describe's `sweepOwn` also deletes the registry's records (no assertion changed). Re-run of the describe alone (`-t "contained install"`): **6 passed**, ~25 min wall. The rest of the full run (leg 5 to 7 describes included, with leg 7's `makeProject` change) passed. No security assertion was loosened. The full suite was not re-run after the fix.
- **Refusal rows per install** (read right after the build): gron: none (`[[]]`); gron with `network: true`: none; cowsay: none. Warnings: none for gron or cowsay.
- **Client probes** (cowsay build sandbox, one exec before the build): Node `v26.13.1`, npm `11.20.0`; `fetch("https://registry.npmjs.org/")` with the hook's environment: `STATUS 200`; with `NODE_USE_ENV_PROXY` unset: `ERR EAI_AGAIN` (fails closed). So `NODE_USE_ENV_PROXY` applies in this image and is what makes `fetch` use the proxy; npm itself succeeded through `HTTPS_PROXY` (no refusal rows, install ready).
- **Create/contain/start states**: `open` right after create, `contained` right before the first start (both gron and cowsay, through the real installer); by hand: stopped on bridge, then stopped on its `-net` only, then running on its `-net` only. gron with `network: true` ended contained on its `-net`, one proxy, `proxy.golang.org` 200 and `github.com` 403.
- **Refused-host case** (cowsay, `registry.npmjs.org` removed from the table by the seam): `failed` after **648 s**; the recipe hit `timeoutSec` 600 (npm's retries), so `error` is "Install timed out after 600s. The build was refused `registry.npmjs.org:443`. To allow it, reinstall with `hosts: [\"registry.npmjs.org\"]`." The proxy's row: `connect registry.npmjs.org:443 not-allowed`, count 3,155,582 over about 11 minutes (npm retried tightly). Offline afterwards.
- **Default table**: **no change**, with evidence: the Go (gron) and npm (cowsay) builds, including `npm ci`, the `prepare` script and Go module downloads, needed nothing outside the table (zero refusal rows). DEFAULT_HOSTS_VERSION stays 1. Unmeasured, as DR1-1 says: pnpm, yarn, Debian `need`/`apt-get`, Python, Rust, Ruby, CMake/autotools.
- **After-run lists** (read-only): containers 22, `8af5a4baef98358b` (unchanged); networks 8, `a2fe9cbb670042b4` (unchanged); no `mcpe-it` container, network or temp directory remains. Volumes 249 to **250**, `914c7c4f9120ffdd`; diff against `leg8-volumes-before.txt`: one new volume, `410f3978fd9f34c5a5686d63a22c6b10b2fe504e97633b0121edf512fa66aa0f`, anonymous, created 06:39:55Z, about a minute after the full run started, so before the leg 8 describe: the same unidentified older-case leak as legs 6 and 7 (a checked `rm -f` without `-v`). Not removed. The leg 8 cases left no volume.
- Final: `npm test` 2431 passed, 59 skipped; typecheck and build clean.

### network-tools
**Status**: landed (not committed). Stage A and Stage B are done.
**Changes** (Stage A):
- `src/types.ts`: `ProjectRecord.hosts?: string[]`. The cast in `containment.ts` (`allowanceFor`) is gone; `allowanceFor` takes `Pick<ProjectRecord, "status" | "ecosystems" | "hosts">`.
- `src/registry.ts`: `Registry.putKeeping(record, keep: Array<"hosts" | "network">)`, through `update`. Stores a `structuredClone` (a later change to the held record cannot reach it); the kept fields come from the file; no record in the file writes nothing, logs a line and returns `undefined` (never resurrect); the held record's kept fields are set from what was stored. `new Registry(dir, log?)` takes a log (`App` passes its own).
- `src/network/hosts.ts`: `MAX_HOST_LIST` (64), `normalizeAgentHosts`, `unionHosts` (the recorded entries are kept as written, even one that no longer parses; non-strings are dropped; the added ones are normalized).
- `src/install/installer.ts`:
  - `InstallParams.hosts`; `InstallProgress` (`current` plus `addedHosts`).
  - **`openInstall`**: the first write merges `union(cur.hosts, params.hosts)` inside `registry.update` (renamed path: the clone carries the merged hosts too, and `record` gets them); `state.addedHosts` records what the parameter added.
  - **`putKeeping(["hosts"])`** replaces every `put` of a held record: the contained snapshot, the failed-build write, the three ready writes, the failed-replacement snapshot, the renamed-path write, the failure write. **`["hosts", "network"]`** for `finish` (behind `rediscover`, `refreshMcp`, `connectMcp`, `disconnectMcp`) and `reselect`.
  - **`settleFailure`'s old-phase restore** writes `{ ...before }` through `update`, keeping the file's `hosts` minus `state.addedHosts` (so the failed reinstall's parameter is not persisted, and another session's `set_project_hosts` is), and writes nothing when the record is gone.
- `src/network/containment.ts`: `ContainmentDocker.networkState`; **`openUnlessContained(key, target?)`** (the project lock, the state read, `setNetwork("open")` only when the state is neither `contained` nor already `open`; works under every session mode); **`proxyDiffers(key)`** (read-only: no running proxy of the project carries the record label this session computes).
- `src/network/refusals.ts` (**the injection fix**):
  - Context `run`. Every `not-allowed` line for build and run reads "`<host>:<port>` was refused. The project's own code asked for this host; allow it (`hosts` on install, or `set_project_hosts`) only if you expect this project to need it." No line carries a ready-made `hosts: [...]` or `set_project_hosts(...)` with the host in it. `refusalWarnings` (a finished build) ends with the same caution. `refused-address` in `run` names `MCPE_LOCAL_ACCESS` and the operator. `refusalLines(rows, context, max)`; `failedCallSuffix(rows)` (header "since the proxy started ... may include earlier calls", at most 3 lines, "and N more." included).
- `src/server.ts`:
  - **`install_project`** takes `hosts` (an array of at most 64; each parsed in agent mode, a bad one refuses the call before anything runs with the step named, `local` adding a pointer to `MCPE_LOCAL_ACCESS` and the operator); the schema says they apply under containment and are otherwise recorded with no effect.
  - **`set_project_hosts(project, add?, remove?)`** (new, in `META_TOOLS`, annotations `readOnlyHint: false, destructiveHint: false`, refused while installing): `(hosts ∪ add) \ remove` written under the registry lock, sorted; an unknown entry is reported ("Not in this project's hosts, nothing to remove"), a default is a distinct message ("defaults cannot be removed per project"); a hand-edited bad entry does not break it and can be removed as written; a changed list under a contained session whose sandbox Docker shows `contained` runs `containment.replace`, then `proxy.closeProject` (only when a proxy was replaced), then `docker.invalidate`; a failed replace says the old proxy stays (`isError`); `off`, `open` and `unknown` and the open session each say why nothing happened yet; "unchanged" touches no Docker object.
  - **`set_project_network`** (all branches in `setProjectNetwork`): contained session `true` is `contain(key, { start: true })` (no `acquire`; "already contained" changes nothing; a failed contain is an error, the record says off); `false` is by name to `off`; open session `true` goes through `acquire` (the runtime comparison, the pinned "acquires once") then `openUnlessContained` ("contained by another session's setting and stays so"); the record is written on what the file holds (`update`, not a stale spread); `closeProject` and `invalidate` only on a real change.
  - **`project_info`**: the network line is Docker's view (`off | contained | open | unknown`); the reads (`networkState`, refusals, proxy configuration, owner) run together, each caught; when contained it adds the effective hosts, the recorded hosts, the latest refusals (at most 10 lines) or "no refusals recorded since the proxy started", each local-access entry that names this repository (alias and port), and "the proxy carries a different configuration (another session); it is repaired on next use". `describe` without a view prints `network (recorded): on|off` (`list_projects` and every other tool).
  - **Failed calls**: a failed generated tool, `sandbox_exec` or MCP-proxied call (an `isError` result, or a throw) appends `failedCallSuffix` when the session contains, the record says the network is on, and `networkState` is `contained`; at most one read per 5 s per project (the rows reused); a successful call makes no extra read.
  - The server instructions gain a sentence naming `set_project_hosts`.
**Tests**: `npm test` 2431 passed, 59 skipped before; **2537 passed, 63 skipped** after (+106 run, +4 skipped Docker cases). `npm run typecheck` and `npm run build` clean. New: `test/network-tools.test.ts` (75: the tools, every branch of `set_project_network` under both sessions, `set_project_hosts`, `project_info`, the failed-call lines, the install parameter); `test/installer.test.ts` "a project's hosts (leg 9)" (14: the parameter and its merge, a `set_project_hosts` from a separate `Registry` landing during an install, a failed install and a rediscovery, the file's network kept, `reselect`, an uninstall not undone, a failed reinstall); `test/registry.test.ts` (6); `test/containment.test.ts` (8: `openUnlessContained`, `proxyDiffers`); `test/network-refusals.test.ts` (3 new).
**Changes to existing tests** (by editing; none deleted):
- `test/helpers.ts`: `FakeDocker` gains `networkStateResult` (default `off`), `networkStateError`, `networkStateCalls` and the `networkState` override.
- `test/containment.test.ts`: `FakeLayer.networkState` (the interface gained it); import of `networkModeOf`.
- `test/network-refusals.test.ts` (resolution 1, the wording): "a build's not-allowed host says how to allow it" became the injection-guard case (the new sentence); "a scanner's not-allowed host points at the scanners file" (the scanner's line says only the operator can allow it); "at most 10 lines" (the line prefix); the `refusalWarnings` expectation (the new caution). The import line.
- `test/installer.test.ts` (resolution 1): the four "what the proxy refused" cases (the build line's `/^exec blew up ...`, `/^Install timed out ...` and the `contains` sentences, the finished-build warning).
- `test/scan-run.test.ts`: the scanner's refusal sentence.
- `test/server.test.ts` (named: the `project_info` network line): the `refresh_mcp` case compares `describe`'s text with `project_info`'s; `project_info` now says `network: off` and the rest `network (recorded): off`, so the comparison replaces that one phrase. No other existing assertion changed: `set_project_network: acquires once`, the runtime-mismatch cases and the `ensureCalls` pins pass unchanged.
- `test/integration/docker.test.ts` (leg 8's refused-host case): the host sentence it checks. Written, not run.
**Trials** (`git diff --stat` plus `git status --short` hashed before and after: identical, `f943a4c69298ce08`; each restored by editing, never git):
1. The never-loosen branch weakened (`false &&` on the contained check in `openUnlessContained`): 4 failed (three `openUnlessContained` cases and the server's "stays contained"). Restored.
2. A writer spreading a stale record over `hosts` and `network` (`finish` back to `put`): 3 failed (a late host during a rediscovery, the file's network kept, an uninstall not undone). Restored.
3. An `add` entry not re-validated (`agentHosts` pushing the raw text): 5 failed. Restored.
4. Refusal lines read on a successful call (`withRefusals` without the `isError` guard): 1 failed ("a successful call makes no extra read"). Restored.
**Docker state before the gated run** (read-only, 2026-11-23; same method as legs 6 to 8):
- Containers: 22, sha256 prefix `8af5a4baef98358b` (unchanged since leg 5).
- Volumes: 250, `914c7c4f9120ffdd`; the full list is saved at `/tmp/claude-1000/-home-cprch-projects-mcp-everything/af8c3a2b-d50f-4f71-82a3-12dc354df1cd/scratchpad/leg9-volumes-before.txt` (verified identical to the live list). They include leg 6's two, leg 7's, leg 8's one anonymous volume.
- Networks: 8, `a2fe9cbb670042b4` (unchanged).
**Deviations / readings** (nothing in the leg contradicted landed code):
1. **The clone and scanner lines are not the resolution's sentence.** The resolution says every `not-allowed` line, for build, clone, scanner and run, reads "X was refused. The project's own code asked ... allow it (`hosts` on install, or `set_project_hosts`) only if ...". For build and run it is exactly that. For a clone the agent cannot allow the host at all (submodules on other forges are not reachable), and for a scanner only the operator can (the scanners file): telling the agent to use `hosts` there would be wrong advice. Both keep a statement with no allow instruction (the clone's line is unchanged; the scanner's now says only the operator can allow it). The injection property holds (no ready-made instruction carries a host). Flag if the literal sentence is wanted.
2. **`set_project_network` writes `network` on what the file holds** (`registry.update(slug, cur => ({ ...cur, network }))`), not through `putKeeping(["hosts"])` of the stale `project` spread: it keeps every other field too (tools, warnings, selection), which the resolution's own aim (no stale spread) needs. `hosts` is kept either way.
3. **Under a contained session, `true` has no `acquire` at all** (resolution 4 says the runtime comparison goes through `acquire` except that `contain(start: true)` replaces its start). `acquire` would start a stopped sandbox on `bridge`, and no other call compares the runtime without starting. The runtime refusal therefore comes from `contain`'s own start (`startForContainment`), after the network and proxy were made: a runtime mismatch leaves the sandbox on no network (containment's failure rule) rather than changed-nothing. Only under a contained session with a mismatched runtime.
4. **The failed-call read is on the MCP-proxied path's throw too**, by wrapping `proxy.callTool`; a thrown call's message gains the suffix only when there is one.
5. **`proxyDiffers` is a new method on `Containment`** (read-only, never throws) for the "the proxy carries a different configuration" sentence; it needed `findProjectNetwork` and `listProjectProxies`, already in `ContainmentDocker`.
6. `set_project_hosts` calls `proxy.closeProject` only when the replacement really replaced a proxy (not for "unchanged" or "kept-newer").
**The Docker cases** (written, not run; describe `docker integration: network tools and local access (leg 9)` in `test/integration/docker.test.ts`; owner = a random id of the describe's own, names under `mcpe-it-<pid>-`, registry and data directory `<tmp>/mcpe-it-c9-<id>` removed only after a location and basename check; every removal through the owner-filtered `sweepOwn` and the checked helpers, which also delete the describe's own registry records):
1. **Measurement (Desktop)**: an echo container (`<prefix>c9-echo-<hex>`, the proxy image, `-p 0:9000`, the owner label) and one probe container (`<prefix>c9-probe-<hex>`, `--add-host host.docker.internal:host-gateway`, runs once, no `--rm`): records what `host.docker.internal` resolves to and whether a TCP connect to the published port echoes. Asserts only that the probe ran. Removed by the sweep.
2. **Local access end to end**: skipped with the measured reason when case 1 found the port unreachable (the Desktop limit; leg 12's native job carries the proof). Otherwise: contained sandbox A (repo id built through `parseRepoRef`, named in `MCPE_LOCAL_ACCESS` as `host.docker.internal:<port>`) and B (another repo): A reaches the echo (`ECHO ping`), B does not, and a `CONNECT host.docker.internal:<port>` to `mcpe-proxy:3128` from A is 403.
3. **`set_project_network(true)` under containment on an offline sandbox**: a sandbox taken to no network, the tool, then contained, running, one proxy, `registry.npmjs.org` 200 and `github.com` 403 through it, the record says on.
4. **`set_project_hosts` without a reinstall**: contained, `github.com` 403; `add` then 200 with exactly one proxy (a different one); `remove` then 403 with one proxy.
**Phase B (Docker gate opened by the Flight Director)**:
- **Desktop measurement** (case 1, alone, run twice: once with `-t`, once with the logs shown): inside a container with `--add-host host.docker.internal:host-gateway`, `host.docker.internal` resolved to `192.168.65.254,fdc4:f303:9324::254`, and a TCP connect to the published port (32770 on the second run) **echoed** (`ECHO ping`). So Docker Desktop reaches a published port from a host-gateway name, and the local-access case was **not skipped**: it ran.
- Full `npm run test:docker` (`timeout 2700`): **61 passed, 2 skipped (pressure), 0 failed**, 1067 s. This includes the four leg 9 cases (all passed first time, no assertion changed) and leg 8's describe, so leg 8's full green run is no longer owed. The local-access case passed: the entitled sandbox reached the echo service, the other repository's sandbox did not, and `CONNECT host.docker.internal:<port>` through `mcpe-proxy` was 403. No security assertion was loosened.
- **After-run lists** (read-only): containers 22, `8af5a4baef98358b` (unchanged); networks 8, `a2fe9cbb670042b4` (unchanged); no `mcpe-it` container or network and no `mcpe-it-c9-*` directory remains. Volumes 250 to **251**, `41f473326ef983b2`; diff against `leg9-volumes-before.txt`: one new volume, `2b5accce61a5b41005a15e94a1238a96422eca5c6f97a9a019d0308302202a77`, anonymous (`com.docker.volume.anonymous`), created 07:22:32Z, about a minute after the full run started (01:21:28 local), so before the leg 9 describe: the same unidentified older-case leak as legs 6 to 8 (a checked `rm -f` without `-v` on a container of an image that declares a volume). Not removed. The leg 9 cases left no volume.
- Final: `npm test` 2537 passed, 63 skipped; typecheck and build clean.

### startup-containment
**Status**: landed (not committed). Stage A and Stage B are done.
**Changes** (Stage A; the leg's Design Review 1 and 2 resolutions are binding: the housekeeping of the first draft (orphans, stopped proxies, lock files) is squawk 0052 and is not here):
- `src/sandbox/docker.ts`: **`Docker.listOwnSandboxes()`**: `ps -a -q --no-trunc --filter label=<owner=this installation> --filter label=mcp-everything.project`, then one inspect each, dropping any with a `mcp-everything.role` label, any whose owner label is not this installation's (judged again on the inspect) and any without a non-empty project label; returns `SandboxInspectFacts`. Read-only; throws `DockerUnavailableError` when Docker cannot be asked.
- `src/install/installer.ts`: `isStaleInstall` exported (no other change).
- `src/network/startup.ts` (new):
  - **`startupAction(record, facts, sandboxName, now, cfg)`**, pure, DR1's binding table (rows R1 to R11 in its comment): no record or another container is "leave alone"; `installing` and not stale is "skip"; record on with `bridge` (alone or with `-net`) or no network is "contain", with `-net` only is "repair", with a network mcp-everything does not manage is "reject" ("attached to a network mcp-everything does not manage"); record off with `bridge` or a foreign network is "take-off" with a warning, with `-net` "take-off", with none "nothing". `dockerStateOf` classifies Docker's networks (none, bridge, own, foreign).
  - **`startContainmentPass(deps)`**: registers the gate **synchronously** (its own deferred), then runs in the background and never rejects. It waits for the reconciliation (`after`), lists, and in **one synchronous block** registers one deferred per project key (per key, not per sandbox, so a twin cannot overwrite) and then resolves the gate; a key with no record, or none of whose listed sandboxes the record names, is not registered (resolved at once). Steps run at most 4 at a time (`STARTUP_CONCURRENCY`). A key's promise is settled only by the step of the sandbox the record names; when all of a key's steps are done it is resolved if nothing settled it. The proxy image is ensured **once per pass, memoized, outside every lock**, before a step whose record says on (a pull failure rejects the keys that need it only). **The bound** (`STARTUP_PASS_LIMIT_MS = 300_000`): steps not yet started do not start, every unsettled key is rejected with "startup containment did not finish" (one log line each), and the gate is rejected if the listing was not back; the pass resolves at the bound, and a late listing registers nothing. One summary line: counts per action. **The gate rejects only when the listing itself fails** (the reason in the message).
  - The three warning kinds' prefixes (`STARTUP_WARNING_PREFIX`): "Startup containment (taken off the network): ", "(not contained): ", "(newer proxy kept): ".
- `src/network/containment.ts`:
  - **The gate**: `registerStartupGate(promise)`; `waitFor(key)` awaits the key's own promise if one is registered, else the gate while it is pending, and **re-loops** after it (a key registered meanwhile is picked up); a rejected gate throws `ContainmentStartupError` with `gate: true` and "network containment could not be checked at startup: <reason>" unless the key was **cleared** (a set kept by `clearFailedStartup`, which a successful `contain`, `replace`, repair or startup step now also feeds). A key whose own promise resolved is not held behind a pending gate.
  - **`ensureContained`** (full mode): catches only the gate error, inspects fresh, and then **refuses** if the sandbox is on `bridge`/open or the inspect fails, **passes** an `off` one, and **goes on into repair** for a contained one (a repair that succeeds, or a check that finds everything right, clears the key). A per-key rejection is unchanged (refuses whatever the state, including a sandbox a failed contain left off, until a later successful contain; the code comment says so).
  - **Internals** (none waits, takes the lock again or calls a hooked method; a source-scan test enforces it): **`containLocked(lock, subject, { start })`** (replaceLocked, `setNetwork("contained")`, invalidate, the unhooked start if asked; on failure `setNetwork("off")` **inside the lock**, then throw), `contain` refactored onto it (failures before the lock, the image or a busy lock, still take the sandbox off outside it, as before: a `WeakSet` marks the errors `containLocked` already handled so there is one off attempt); **`takeOffLocked`**; **`repairLocked(lock, s, f, { resolverTrouble?, compareSession? })`** (the T14 attach stays; with `compareSession` it goes through `replaceLocked({ compareSession: true })`, which keeps a newer-version proxy; returns the replacement's result); `peek` (the fresh read that returns `undefined` for no record), `fresh` built on it.
  - **`startupStep(key, sandboxName)`**: one locked step: peek the record fresh, inspect the sandbox fresh (gone is "leave alone"), `startupAction`, act with the lock-free internals (a contain never starts the sandbox: a stopped one stays stopped, its proxy runs), a failed contain adds a warning and throws, a repair that kept a newer proxy adds a warning, a take-off from `bridge` adds a warning; returns the action and whether this is the sandbox the record names (`settles`); on success clears the key. Warnings go through `putKeeping`, replace an earlier warning of their kind, are at most 300 characters and are logged.
- `src/server.ts`: under `contained`, `start()` calls `startContainmentPass` (gate registered before `start()` returns; the pass is after the reconciliation, in `this.startup`, not awaited at shutdown); under `open` nothing is registered and nothing runs.
**Tests**: `npm test` **2537 passed, 63 skipped** before; **2609 passed, 66 skipped** after (+72 run, +3 skipped Docker cases). `npm run typecheck` and `npm run build` clean. New: `test/startup-containment.test.ts` (63: `startupAction` by row id R1 to R11 and the Docker-state classifier; `isStaleInstall`; the gate and `waitFor` (unregistered key, no gate, early resolved key not held, the re-loop, a rejected key, a rejected gate, clearing, the hook under a failed gate in each state, observe mode, a per-key rejection of an `off` sandbox); the pass end to end for every row, a stopped sandbox, the session label compared, a stopped or stale proxy, a missing proxy and the T14 attach, a newer proxy kept with its warning, a failed contain (off inside the lock, the key rejected, the warning, the lock released), a failed repair (not taken off), an error on one key, a sandbox gone since the listing, a failed listing (gate only), the stale-record race both ways and a record removed meanwhile, every key registered up front, a key finished early, a twin, a key with no matching sandbox, the image once and never under a lock and a failed pull, concurrency of 4, the bound (unstarted steps do not start, every unsettled key rejected once with one log line, a later success clears its own key), the bound before the listing, no timer left). `test/server.test.ts` "startup containment wiring (leg 10)" (5: the gate before `start()` returns, the pass after the reconciliation and inside `startup`, a failed listing, `open` making no call, shutdown not waiting). `test/docker.test.ts` "listOwnSandboxes (leg 10)" (3). `test/docker-bypass.test.ts`: the startup step and its internals use only unhooked starts, never wait or hook, one lock in the step and none in the locked internals; `startup.ts` calls no start, exec or network change.
**Changes to existing tests** (by editing; none deleted; no assertion of a test under `open` changed):
- `test/docker.test.ts` ("the class's methods are exactly the guarded table plus the two written lists"): `REPORTING` gains `listOwnSandboxes` (a new method of the class).
- `test/docker-bypass.test.ts` ("the tables and the class agree"): `NOT_A_START_OR_EXEC` gains `listOwnSandboxes`.
- `test/containment.test.ts`, `test/installer.test.ts` and every other existing file: unchanged, and green (leg 7's `waitFor`, `registerStartup` and `contain` cases pass as they are).
**Trials** (`git diff --stat`, `git status --short` and `git diff` hashed before and after, identical: `eb0a2f985de7a7d3`, `7902d34ce3e90425`, `5f251e05f71570621`; the three edited files' own hashes also identical; each restored by editing, never git):
1. The gate not registered synchronously (registered in a microtask): 2 failed (the pass's own case and the server's). Restored.
2. The fail-safe row containing instead of taking off (R7 and R11): 6 failed (both table rows, the end-to-end take-off, the warning replacement, the turn-off race, the failed-pull case). Restored.
3. The session label not compared (`repairLocked` with `compareSession` dropped): 1 failed (the session-label case). Restored.
4. Keys not registered up front (the `registerStartup` call removed): 9 failed (every case about a held key, the twin, the failed contain and repair, the bound). Restored.
- The orphan-removal trial of the first draft is withdrawn with the housekeeping. A trial of the fresh re-read (a stale record) was not run: both race directions and the removed-record case are unit cases, but the weakening needs a second registry instance and was not worth a contortion; the cases are the net.
**Deviations / readings** (nothing in the leg contradicted landed code):
1. **The warnings use `putKeeping(record, ["hosts", "network"])`**, not `["hosts"]`: a `set_project_network` landing between the step's read and the write must not be undone by the warning write (the same reason leg 9 keeps `network` in `finish`).
2. **`startupAction` takes the configuration as a fifth argument** (`isStaleInstall(record, now, cfg)` needs it); the leg's signature had four.
3. **The gate is registered inside `startContainmentPass`**, synchronously, not by `server.ts` handing `registerStartupGate` the pass's promise: DR2 makes the gate its own deferred, released by the pass in the same synchronous block as the per-key registrations, so only the pass can hold it. `start()` calls the pass before it returns, which is what the leg needs; the pass takes the reconciliation as `after`.
4. **A key whose own promise resolved is not held behind a pending gate** (the first `waitFor` returns, rather than looping back to the gate): the leg's "a key resolved early while the gate is pending (not held)". The gate fallback is for a key with no promise of its own.
5. **`repairLocked` with `compareSession` goes straight through `replaceLocked({ compareSession: true })`** (one proxy check, one path), so a stopped proxy of this version is replaced rather than started: a repair at startup, not on use. Without `compareSession` it is unchanged (assess, start, replace).
6. **A network that is neither `bridge` nor the sandbox's own `-net` is classed "foreign"**, whichever other networks it has: record on is rejected with the DR2 reason (for `bridge` plus a foreign one too: containing would leave the foreign network), record off is taken off with a warning (taking off disconnects every network, so it is the safer reading). DR2 named only `-net` plus a foreign network.
7. **The image is ensured before a step only when the peeked record is not `installing`** (a young install is skipped, and a stale one was reconciled before the pass); the image is therefore not pulled for a record the step will skip. A record that turned on after the peek and before the step meets `createProjectProxy` without the pull and the key is rejected (a narrow race, fail-closed).
8. **A registry that cannot be read at the registration block registers every listed key**, and each step meets the unreadable registry and rejects its key (fail closed), instead of treating the keys as record-less.
9. **A pass-level failure after the listing** (anything unexpected) logs, rejects the gate if it is still pending, and rejects every unsettled key; `startup` never rejects.
10. **The DR1 "handled OK" set is not kept** (DR2 dropped it: the gate rejects only for the listing, so no key has been handled when it does).
11. **Process note**: twice in this leg I started a shell command that held an empty heredoc (the first a Python one that read nothing and wrote nothing, the second a `cat` with no output file; the second was denied by the permission classifier). Neither wrote or printed to any file; both were mistakes against the edit-tools-only rule and are recorded so that nothing is hidden.
**Standing gaps in DD8's "nothing runs uncontained"** (DR1 resolution 8 and DR2 resolution 6; to be stated in leg 11's README): a sandbox from before ownership (no project label) is not listed and stays uncontained under `contained` (reinstall to contain it); a **labelled sandbox with no record** is left as it is. Neither is touched by the pass.
**The Docker cases** (written, not run; describe `docker integration: startup containment (leg 10)` in `test/integration/docker.test.ts`; owner = a random id of the describe's own (the `App` under test is given a `Docker` with that id), names under `mcpe-it-<pid>-`, registry and data directory `<tmp>/mcpe-it-c10-<id>` removed only after a location and basename check; every removal through the owner-filtered `sweepOwn` and the checked helpers, which also delete the describe's own registry records; each case ends with `remaining() == NONE`):
1. **An open sandbox becomes contained at startup**: a sandbox created stopped and started on `bridge` (the record says on); an `App` under `MCPE_NETWORK=contained` starts; after `startup` it is on its `-net` only, `networkState` is `contained`, one proxy.
2. **An exec during the pass waits**: the same sandbox; `docker.exec` of `echo $HTTPS_PROXY` is issued right after `start()` (the key is not yet registered, so it meets the gate); it prints `http://mcpe-proxy:3128`, and the sandbox is on its `-net` only when it returns.
3. **A record-off sandbox on `bridge` is taken off**: after `startup` it is on no network, no proxy, the record still says off and carries the "taken off the network" warning.
**Docker state before the gated run** (read-only, 2026-11-23; same method as legs 6 to 9):
- Containers: 22, sha256 prefix `9ed0ac4b2209` (the full-sha prefix of the sorted names; earlier legs' prefixes used another hashing, so only the count is comparable).
- Volumes: 251, `90be9a8534df`; the full list is saved at `/tmp/claude-1000/-home-cprch-projects-mcp-everything/af8c3a2b-d50f-4f71-82a3-12dc354df1cd/scratchpad/leg10-volumes-before.txt` (verified identical to the live list: 251 lines, same sha256).
- Networks: 8, `64c9a1b116b1`.
**Phase B (Docker gate opened by the Flight Director)**:
- The leg-10 describe alone (`-t "startup containment"`): 3 passed, 63 skipped, 10 s, first time, no assertion changed.
- Full `npm run test:docker` (`timeout 2700`): **64 passed, 2 skipped (pressure), 0 failed**, 1081 s.
- **After-run lists** (same method as the before-lists): containers 22, `9ed0ac4b2209` (unchanged; the operator's names are the same); networks 8, `64c9a1b116b1` (unchanged); no `mcpe-it` directory remains under `/tmp`. Volumes 251 to **252**, `305824eff4ce`; diff against `leg10-volumes-before.txt`: one new volume, `c750398d83029a7562f4ba7fe0aead743f89c2367bd589c99e60feb5ea48da34`, anonymous (`com.docker.volume.anonymous`), created 08:06:55Z (02:06:55 local), about a minute after the full run started (02:05:52), so before the leg 10 describe: the same unidentified older-case leak as legs 6 to 9. Nothing was removed.
- Final: `npm test` 2609 passed, 66 skipped; typecheck and build clean.

### status-and-docs
**Status**: landed (not committed). No Docker command was run.
**Changes**:
- `src/server.ts` (`securityParagraph`): contained variant ("Sandbox networks are contained: clones ...; builds ...; a sandbox with its network on ..." then the local-access / `set_project_hosts` line, then the refused-hosts line); open variant keeps today's sentence and adds "The operator turns containment on with MCPE_NETWORK=contained."; runtime line is "Isolation runtime: <name>, required: installs and checks refuse to start if Docker cannot run it, and sandboxes created under another runtime must be reinstalled." when named, else "Isolation runtime: Docker's default runtime." `INSTRUCTIONS_HEAD` untouched (leg 9 already changed its network sentence).
- `README.md`: new `## Network containment` (Turning it on, How it works, What each stage reaches, The default hosts, A project's hosts, Local access (`MCPE_LOCAL_ACCESS`), Scanners' hosts, What reaches outside services, When something is refused, Upgrading and switching from open to contained, What containment does not stop); new `### The isolation runtime` at the end of `## Security model`; the three "network is not contained" statements (Security model "does not do", "What none of this protects against", the runtime paragraph) now state both modes; `## Configuration` gains `MCPE_NETWORK`, `MCPE_LOCAL_ACCESS`, `MCPE_PROXY_IMAGE` and a longer `MCPE_DOCKER_RUNTIME` row; `## Built-in tools` gains `set_project_hosts`, the `hosts` parameter of `install_project`, and the network state in `project_info`; scanner section gains `hosts` (key list and the network bullet); `## Limitations` gains the address-pool bullet, the unmeasured-defaults bullet and the proxy-outlives-idle-stop pointer.
- `test/server.test.ts`, `test/readme.test.ts` (below).
**Tests**: `npm test` 2609 passed, 66 skipped before; **2620 passed, 66 skipped** after (+11: 3 in `test/server.test.ts`, 8 in `test/readme.test.ts`). `npm run typecheck` and `npm run build` clean.
**Changes to existing tests** (by editing; none deleted):
- `test/server.test.ts` "name the runtime when one is set" is now "name the runtime when one is set, and say that it is required": its pin `"Isolation runtime: runsc."` became the new full runtime line (named by the leg). The open-mode `NETWORK` pin (`"Sandbox networks are not contained: ... local network."`) is unchanged and still passes, because the new sentence follows it. The default-runtime pin is unchanged. New cases: the open variant (sentence plus the MCPE_NETWORK hint, nothing about containment or local access), the contained variant (each clause), and both runtime variants under containment.
- `test/readme.test.ts`: a new describe; the existing cases are untouched. New cases: variables in the table equal the `MCPE_NETWORK*|LOCAL_ACCESS|PROXY_IMAGE` variables `config.ts` reads (both directions); defaults (`open`, the exact proxy image, local access none); section order; `set_project_hosts` and `install_project`'s `hosts` in Built-in tools; the README's `MCPE_LOCAL_ACCESS` example parses through `loadConfig`; the default-host table (every host of `src/network/defaults.ts` and none the code lacks, computed from `EVERY_BUILD_HOSTS` and `ECOSYSTEM_HOSTS`; and each host in its own build system's row).
**Trials** (`git diff --stat`, `git status --short` and `git diff` hash saved before and compared after both: identical, diff hash `ce6805d12c1f9390`; each restored by editing, never git):
1. `sum.golang.org` removed from the README's Go row: 2 tests failed (the module-vs-table set and the per-row case). Restored.
2. The `MCPE_LOCAL_ACCESS` row removed from the Configuration table: 2 failed (the variables case and the defaults case). Restored.
**README / code disagreements found** (README follows the code; no behavior changed):
1. **Forwards are carried in the build phase too.** DD10 says local access applies "to the sandbox with its network on, not to builds or clones". `Containment.buildConfig` has no phase filter: the project's proxy carries its repository's forwards while it installs as well. (A clone's one-shot proxy never carries them.) README says "for as long as the project has a proxy, including during its build". May be a defect against DD10.
2. **DD11's refusal wording differs from the code's.** The spec's mismatch text ("created before ... runs under runc; reinstall ...") is not the code's `RuntimeMismatchError` text; README quotes the code. `RuntimeUnavailableError`'s text matches DD11.
3. **Not built, so not claimed**: DD11's "`project_info` says the same [mismatch] and the security paragraph counts such projects"; DD3's "the security paragraph says containment is on but Docker cannot provide it" (the paragraph is from configuration only, as this leg's criteria say). Neither appears in `src`.
4. **DD2/DD8 housekeeping** (stopping proxies of stopped sandboxes, orphan removal, lock-file removal) moved to squawk 0052; flight.md's DD2 and DD8 text still says the startup pass does it. README follows the squawk.
5. **DD9's hint wording** ("reinstall with `hosts: [...]`") is superseded by the leg 9 decision (advisory caution); README follows the code. DD11's "Startup does not fail on it ... logs" matches.
6. **DD12 asks for a Trivy example with hosts "verified by a real run"**: no log entry records such a run, so the README's Trivy example has no `hosts` and says they were not measured. Under containment that example is a startup error until hosts are added; the README says so.
7. **DD10's native-Linux sentence** ("not those bound to 127.0.0.1 only") is a statement of DD10, not a measurement (the runner measured a listener on 0.0.0.0); the README says "not expected ... (not measured)". No local-access forward has been run on native Linux (leg 12's job).
**gVisor**: the README says "Behavior under gVisor (`runsc`) is not yet tested in CI." and what is tested now (test double only; no non-default runtime run). The sentence is followed by an HTML comment, `<!-- LEG 12 (gvisor-ci): replace the sentence above ... -->`, which tells leg 12 what to put there. Leg 12 should also delete the "Idle stopping has not been verified under gVisor" Limitations bullet only if it measures it.
**"What reaches outside services" (flight 1)**: confirmed already stated in three places (scanner network bullet, the scanner `env` bullet about credentials, "Image pulls" under what none of this protects against). Added: the scanner bullet now says containment narrows it to the scanner's `hosts`, and `### What reaches outside services` in the new section.
**Where the claims come from** (README claim -> source). Abbreviations: DD = flight spec design decision; T = flight trial; NL = "Native Linux measurements" block; L<n> = that leg's entry above; code symbols in `src`.
- *Instructions/paragraph text*: leg criteria; open sentence is the old pin; runtime clause = `RuntimeUnavailableError`/`RuntimeMismatchError` behavior (L2), `assertRuntime`.
- *`MCPE_NETWORK` `open|contained`, startup error, read once, agent cannot change*: DD1, `parseNetworkMode`. Default `open`: `loadConfig` (test).
- *Docker needs a no-gateway network; the checks made; no fallback; ops that refuse; off unaffected*: DD3, `createContainedNetwork` / `checkContainedNetwork` / `ContainmentUnavailableError` (L5, L6). *Tested versions 29.4.2 and 29.8.2, minimum not established*: NL, T-block header (Docker 29.8.2), open question in DD flight "minimum version".
- *Proxy image pinned `node:22-alpine`, pulled by the daemon*: `config.docker.proxyImage` (L5), `MCPE_PROXY_IMAGE` row; "needs `node`": L5 Docker case 6.
- *Per-project network `-net`, no gateway, no outside DNS; one network per sandbox; two projects cannot reach each other; off = no network*: DD2, DD3, T1, T3; `projectNetworkName`; L7 Docker case 1; DD7 "off".
- *Proxy on the network and on bridge; read-only, caps dropped, non-root, nothing published, runtime applies; listens only on its network address; name `mcpe-proxy`, port 3128*: DD2, DD4, L5 Docker case 5, `createProjectProxy`, `limits()` call sites, `PROXY_PORT`, `proxyEnvironment` (`PROXY_URL`).
- *Environment variables per command; existing sandbox contained without reinstall*: DD5 "Clients", `proxyEnvironment` (`HTTP_PROXY`, `HTTPS_PROXY`, lower-case, `NO_PROXY`, `NODE_USE_ENV_PROXY`), `ExecOptions.env` (L6). *Node 26.13.1, npm 11.20.0, fetch used proxy, failed closed without*: L8 Phase B client probes. *Other clients not measured*: DD5 text and L8 "unmeasured".
- *Proxy resolves itself, upstream resolvers from a bridge container, never embedded DNS; refuses by resolved address; connects to the checked address*: DD4, T11-T13, `readUpstreamResolvers`, `proxy.cjs` `open()`. *Public plus refused address: refused dropped, public used*: `open()` (`permit` filter; `kept`) and leg 3's edge case.
- *Refused ranges and the IPv6 allowlist, embeddings*: `NEVER4` / `LOCAL4`, `class6` (`proxy.cjs`), DD4. *IP literal refused unless an allowed entry; only scanners' hosts hold one*: DD4, `matchEntry`, L1 grammar (`literal` step in agent mode).
- *Plain HTTP GET/HEAD only; HTTPS by CONNECT*: leg 3 decision 1, `proxy.cjs` `onRequest` (`405` for other methods). *Ports 443/80 unless named*: `ports()` in `hosts.ts`, DD4.
- *Matching: exact or `*.example.com`, not the base; case-insensitive*: DD4, L3 real bug note (`matchEntry`).
- *50 refusals; read by `docker exec` on failure; lost on replacement*: `MAX_REFUSALS`, DD9, `projectRefusals`.
- *A change replaces the proxy; new beside old; old removed when the new answers; start failure reported, old stays*: DD2, `Containment.replace`, `ProxyStartError` (L7).
- *Stage table*: clone = `cloneHosts`/`probe` (L8); build = `buildHosts`; sandbox = `sandboxHosts` (no Debian, no GitHub); off = DD7; scanner = `runScanner` egress (L8). *Registry reach is a way out*: DD6.
- *Default host table, GitHub reason, only Go and npm measured*: `src/network/defaults.ts` (test computes it), DD5, L8 Phase B "Default table", flight-log note "DD5 measured is narrowed". `DEFAULT_HOSTS_VERSION` not stated.
- *A project's hosts*: `install_project` schema, `set_project_hosts` (L9: add/remove, MAX 64, proxy replaced, `closeProject`, defaults cannot be removed, "recorded; no effect" under open), `hosts.ts` grammar and `LOCAL_LABELS`/`TWO_LABEL_PREFIXES` (heuristic, not a public-suffix list), `allowanceFor` re-validation (L7). *Reinstall merges*: `unionHosts`, L9 installer. *project_info shows hosts*: `containedLines`.
- *Local access*: syntax, errors (startup, both modes), repository keys by `parseRepoRef`, case-insensitive: `parseLocalAccess` (L1), DD10; *names only*: Decision "MCPE_LOCAL_ACCESS targets are names", T1, T8; *how it works, alias, scoped exemption, CONNECT refused*: DD10, `createProjectProxy` aliases, L3 (scoped forward), L9 Docker case 2; *`host.docker.internal` from the proxy's `/etc/hosts`*: T13a, `--add-host ... host-gateway` in `createProjectProxy`; *Desktop*: L9 Phase B measurement; *native Linux `172.17.0.1`, all-address listener reached, systemd-resolved uplink resolvers*: NL; *127.0.0.1-only*: DD10 (not measured); *reconnect and startup pass rebuild*: DD10, L10 (`repairLocked` with `compareSession`); *EXTRA_HOSTS forge may be local, `resolve-failed`*: `probe` (`local` flag), L8 edge case.
- *Scanners' hosts*: `scanners-file.ts` (1-64 strings, scanner mode), `config.ts` startup error, `runScanner` (L1, L8, DD12). *Trivy hosts not measured*: no entry in this log.
- *What reaches outside services*: existing README text (flight 1), DD14, `runScanner` egress.
- *Refusal messages*: `refusalLines`, `failedCallSuffix`, `refusalWarnings`, `ProxyStartError`, leg 9 injection decision, L8 Phase B (648 s, 3,155,582 rows, timed-out wording). *At most 10 / 3 / 5 lines*: `MAX_REFUSAL_LINES`, `MAX_FAILED_CALL_LINES`, `refusalWarnings(rows, 5)`.
- *Upgrading: the pass, table rows, nothing uncontained meanwhile, bound, never loosen, sessions*: DD8, L10 (`startupAction` R1-R11, `STARTUP_PASS_LIMIT_MS` 300 s, gate), L7 deviations 6 and 9, L9 (`openUnlessContained`).
- *Residual routes*: allowed host: DD6 and DD5; wildcard DNS, Azure, ISATAP/NAT64: leg 3 spec "Residual routes"; host public addresses: DD4; image pulls: DD14; busybox wget / unset variables: T6, L8 probe; replacement window: DD2 and NL two-holder; pre-ownership and unlabelled-no-record: L10 standing gaps; leftover proxies and idle-stop: squawk 0052; registry retry: L8 Phase B.
- *Address pools*: DD15, `POOLS_EXHAUSTED` message in `createNetwork`, `setNetwork("off")` removing `-net` (L6).
- *Runtime subsection*: DD11, T9, `assertRuntime`/`checkRuntime` (info, probe image `true`, `network: "none"`, 60 s, success cached, failure not), `RuntimeUnavailableError` text, `refuseRuntimeMismatch` (exact strings, the `io.containerd.runc.v2` comment), `RuntimeMismatchError` text, L2 (nothing started; `set_project_network(false)` still works), `checkRuntimeInBackground` (log line), probe-image comment ("`true` as a BusyBox applet"). *What is tested*: L2 (double only; the Docker-gated case was not written), existing Limitations bullet on idle stopping under gVisor.
**Notes**:
- The README does not state the `DEFAULT_HOSTS_VERSION`, the refusal reasons' status codes, the proxy's connection caps or timeouts, or the lock mechanics: none is user-facing.
- One edit attempt (replacing a README bullet with a placeholder) was rejected by the Edit tool because its target text did not exist; nothing was written. Every file was edited with Read, Edit and Write only.

### gvisor-ci
**Status**: landed (not committed). First CI run of the `gvisor` job is after the flight commit.
**Local Docker results** (Docker Desktop, no runtime named): (a) leg 8's shortened refused-host case alone (`-t "a build host that the table lacks"`): 1 passed, 65 skipped, 100 s (inside the 300 s test timeout). (b) `test/integration/gvisor.test.ts`: 1 file skipped, 3 tests skipped, 284 ms. **After-lists**: containers 22 `9ed0ac4b2209`, networks 8 `64c9a1b116b1`, volumes 252 `305824eff4ce`, all identical to the before-lists (volume diff empty; no new volume). One empty `/tmp/mcpe-it-gv-Bfcs0Y` from my earlier `npm test` (before the directory was moved into `beforeAll`) was removed; no other `mcpe-it` directory remains.
**Pin** (read at implementation, not from memory): release **20260817**, the newest that answered. Method: `curl -fsI .../release/<date>/x86_64/runsc.sha512` for each date from 20261123 back to 20260817 (404 until 20260817, which gave 200), then a daily `curl -sI` scan of every date from 20260818 to 20261123 (all 404, so nothing newer), then `curl -fsS https://storage.googleapis.com/gvisor/releases/release/20260817/x86_64/runsc.sha512`. The SHA-512 of `runsc` is `84936438d583ec976800f464e75a83e1515f0890b451b9b4db219c4472b54ca9b106a6772ee683f1e64cce2128871d7637b14d800591f8451b8137f6c39fb2ef`. The workflow pins the pair (`GVISOR_RELEASE`, `GVISOR_SHA512`) and fails if the published `.sha512` differs from the pin, then `sha512sum -c`. `releases/release/latest` answered 404, so it is not usable as a pointer. No shim is downloaded (resolution 4).
**Changes**:
- `.github/workflows/docker-gvisor.yml`: `measure` kept as leg 4 wrote it; new `gvisor` job (75 min; read-only permissions; checkout and setup-node pinned to `ci.yml`'s SHAs, `persist-credentials: false`). Header comment (leg 12); triggers `src/**`, `test/**`, `package.json`, `package-lock.json`, `.nvmrc`, `tsconfig*.json` and the workflow; `concurrency` group per ref, cancelling. Steps in order: checkout, `docker version` (also to the summary), download and verify, install and register (bounded `until`-style loop of 30 tries after the restart, `docker info` Runtimes must list `runsc`), smoke test (`docker run --rm --runtime runsc --entrypoint dmesg <probe image>`; output must contain gVisor; the first lines go to the summary), then, gated by `hashFiles('src/network/proxy/proxy.cjs') != ''`: setup-node, `npm ci`, `npm run build`, Run A (`vitest run test/integration --exclude test/integration/gvisor.test.ts`, 50 min), Run B (`vitest run test/integration/gvisor.test.ts`, 15 min, `!cancelled()`), and a summary step (`always()`) from the JSON reports: counts, seconds, skipped case names, and the leg-9 local-access describe's cases by status.
- `test/integration/gvisor.test.ts` (new): enabled only with `MCPE_DOCKER_TESTS=1` and `MCPE_DOCKER_RUNTIME=runsc`. Own copies of the guard helpers (names under `mcpe-it-<pid>-gv-`, a checked removal, owner-label sweep, random owner ids, a temp data directory made in `beforeAll` so a skipped describe leaves nothing). Three cases: (1) a contained, scanned (`MCPE_SCAN=warn`, one trivial alpine scanner) install of `tomnomnom/gron` with `network: true` under a `Recording` Docker that overrides protected `docker()`, inspects `HostConfig.Runtime` of each created id straight after `create`/`run`, and checks `--runtime runsc` in the argv; the roles seen must include clone, resolv-read, oneshot-proxy, runtime-check, scan, copy, sandbox, project-proxy; `docker events` (create, owner label) must give exactly the recorded ids; the create/contain/start states are `open`, then `contained`, then it runs contained; `dmesg` in the sandbox must contain gVisor. (2) a configuration naming `mcpe-no-such-runtime`: `check_project` refuses with DD11's message and nothing of that owner exists. (3) a sandbox made with no runtime named, then `acquire` through a `runsc` configuration throws `RuntimeMismatchError` ("reinstall"), and `set_project_network(false)` still works.
- `test/integration/docker.test.ts`: leg 8's refused-host case `timeoutSec` 600 to 90 and its test timeout 1,800,000 to 300,000 ms. Nothing else changed.
**Checks**: `npm run typecheck` clean. `npm test`: **2620 passed, 66 skipped before** (the number after leg 11); **2620 passed, 69 skipped after** (+3 skipped: the new file, which reports itself skipped). `bash -n` of each `run:` block (extracted to `/tmp/claude-1000/.../scratchpad/leg12/*.sh`, Write tool; Run B has Run A's shape) and `node --check` of the summary script: clean. The workflow parses as YAML with jobs `measure` and `gvisor` (11 steps). `actionlint` is not installed here (and `shellcheck` is not either), so the first push is the validity check.
**Docker lists before** (read-only; method as legs 6 to 10): containers 22, `9ed0ac4b2209`; networks 8, `64c9a1b116b1`; volumes 252, `305824eff4ce`; the volume list is in `scratchpad/leg12-volumes-before.txt`.
**Unverified, left to the first CI run** (resolution 6): which cases gVisor cannot run. Nothing is skipped under `runsc` yet: the cases reading `/sys/class/net` and those asserting exact prober error codes are not presumed to fail. A failure there is to be recorded here and skipped with a named `skipIf(process.env.MCPE_DOCKER_RUNTIME === "runsc")` reason; a failing contained install or local-access case is a finding, not a skip.
**To run locally at the gate**: only (a) leg 8's shortened refused-host case via `-t`, and (b) `test/integration/gvisor.test.ts` with no runtime named (it must report itself skipped).

### Flight review fixes
**Status**: landed (not committed). The Reviewer confirmed the flight with no blocking issues; these are the fix-pass items.
**Changes**:
1. `src/network/containment.ts` `buildConfig`: forwards (and so their aliases, which the Docker layer derives from `config.forwards`) only when the phase is `run`; the session label is computed from the same list, so a build proxy replaced at the phase flip compares correctly (DD10). Tests: build has no forwards and the session label equals the no-forwards label; run has them; the labels differ.
2. `test/integration/docker.test.ts`: `removeContainerChecked` now removes with `rm -f -v` (still through the checked name path); every container removal in the suite (and `gvisor.test.ts`) now removes anonymous volumes.
3. `withProjectLock`: the 90 s deadline rejects the caller, but the mutex and the lock file are released only after `fn` has settled (in a `finally` inside the promise `fn` runs in); `fn`'s steps keep calling `assertLive`. The existing deadline test now expects the lock file to remain until the straggler settles, then be gone. New case (injected clock): after the first caller got `ContainmentDeadlineError`, a second waiter takes no lock and creates nothing until the first `fn` settles.
4. `acquireFile`: stale takeover is `removeIfStale`: rename the stale file to a unique name, judge its (kept) mtime there, delete only if still stale, otherwise put it back with an exclusive `link`. Cases: a second takeover that still believes the lock stale leaves the first's fresh lock intact; two real contenders on a stale lock get through one at a time (one `replaced`, one `unchanged`, one proxy).
5. `contain`: a test that `setNetwork(..., "off")` is called exactly once after a failed contain.
6. `proxy.cjs`: the `upgrade` handler is reachable, not dead code. New test: an upstream that answers a plain request with `101 Switching Protocols` and keeps its side open: the client socket is closed by the proxy (well inside the test's own 5 s timer), nothing is relayed, and the upstream socket is destroyed. Removing the handler makes it time out (Node then destroys only the upstream socket and leaves the client's open). The status-range check (`code < 200 || code > 599`) stays as defence in depth: Node's parser does not pass a 1xx to `response` once the `upgrade` handler exists (it raises `information`), so it cannot be reached by a test; a comment in `proxy.cjs` says so.
**Trials** (weaken, confirm fail, restore by editing; `git diff --stat` unchanged at 27 files, 9344 insertions, 276 deletions): item 1 (forwards in every phase): 1 test failed; item 3 (release at the deadline): 2 failed (the changed deadline test and the new one); item 4 (plain `rmSync` on a stale lock): 1 failed (the two-takeover case).
**Checks**: `npm run typecheck` clean; `npm test` **2626 passed, 69 skipped** (before: 2620 passed, 69 skipped; +6: build/run forwards, deadline-holds-lock, stale takeover x2, offDone-once, 101-ends-both); `npm run build` clean.
**Docker**: full `npm run test:docker`: 64 passed, 5 skipped (1 file passed, 1 skipped), 9 m 59 s. Containers 22 and networks 8, as before. Volumes 252 before, **253 after: one new anonymous volume** (`c7c26191...`, created 08:54:32Z, inside the run; label `com.docker.volume.anonymous`; no container uses it). It was NOT removed (I cannot show the suite created it). The helper `-v` change removed the suite's own leak path, so the remaining one comes from somewhere else: the likeliest is the product's `rmContainer` (`src/sandbox/docker.ts`, `docker rm -f <id>` with no `-v`, used by `removeContainer` and by `destroy`), which every other product removal path avoids; or something else on the shared daemon. Not changed in this pass (outside the listed items): left to the Flight Director.
**Second fix (Flight Director)**: `rmContainer` in `src/sandbox/docker.ts` (used by `removeContainer` and `destroy`) now runs `docker rm -f -v <id>` (anonymous volumes only; a named volume is untouched). Tests: `test/docker.test.ts` argv pins updated by editing (the acts-on-the-id table at ~824, the destroy classification case at ~979, `removeContainer removes a container alone` at ~1008, and the three `removals(d)` pins at ~4162, ~4185 and ~4233); that last `removeContainer` case now also asserts no `volume rm` is issued and the named volume stays. `npm run typecheck` clean; `npm test` 2626 passed, 69 skipped; `npm run build` clean. Full `npm run test:docker` again: 64 passed, 5 skipped, 9 m 43 s; containers 22, networks 8, volumes 253 before and after: **no new volume** (diff against `scratchpad/fix2-volumes-before.txt` empty). The earlier leftover `c7c26191...` was left alone, as instructed.

### proxy-by-address
**Status**: landed (not committed). Stage A, the gate, then Stage B below.
**Stage B** (Flight Director's go-ahead): full local `npm run test:docker` on Docker Desktop, no runtime named: **66 passed, 5 skipped** (1 file passed, 1 skipped), 651 s, exit 0; the two new leg-13 cases ran and passed, and no assertion was loosened. **After-lists identical to the before-lists**: containers 22 `a77d6ff404831ba4`, volumes 253 `0e4087fdb748c72d`, networks 8 `7f5b38ebaeb9bea9`, images 81 `6aade336f6f4094b`; the volume diff against `scratchpad/leg13-volumes-before.txt` is empty (**no new volume**, nothing removed). No `mcpe-it` or `mcpe-hosts` directory is left in `/tmp`. Run log: `scratchpad/leg13/docker-run.log`.
**Stage A** (below): written before the gate; nothing Docker-gated had run then.
**What was built** (the leg's Design Review 1 Resolutions are binding and were followed over the leg's earlier text):
- `src/sandbox/docker.ts`:
  - `proxyAddress(subnet)` (pure, exported): last usable host of an IPv4 CIDR, never the broadcast address, `/1` to `/30`; `/31`, `/32`, `/0`, IPv6 and malformed text throw. `lowerHalf(subnet)` (private) gives the `--ip-range`.
  - **Probe, then pin** in `createNetwork`: `probeSubnet()` makes a throwaway network without `--subnet` (random name, labels owner plus role `oneshot-net` and nothing of the project, so the existing sweep removes a leaked one), reads its subnet, removes it by id, and refuses a subnet too small for the proxy; the real network is then made with `--subnet <that> --ip-range <lower half>`. `Pool overlaps` retries with a fresh probe up to 3 times. The fixed-name adopt-on-exists path is unchanged. `networkCreateFailure()` is the old error mapping, shared by the probe and the real create.
  - Both proxies join with `network connect --ip <proxyAddress(subnet)>`, no `--alias`; the one-shot's variables are `http://<address>:3128`. A taken address is `ProxyStartError` naming the address, never a fallback. `PROXY_ALIAS`, the alias grammar check and the `mcpe-proxy` refusal in `createProjectProxy` are gone.
  - `projectProxyAttached(id, net)` now needs `net.subnet` and checks `NetworkSettings.Networks[net].IPAMConfig.IPv4Address` (the configured address, readable while stopped) and the network id.
  - New `detachProjectProxy(id, net)` (classified, `network disconnect -f` by id) and `restoreProjectProxy(id, net)` (classified; `stop`, `network connect --ip`, `start`, readiness, attachment check; `ProxyStartError` on any failure).
  - New `writeLocalAccess(ref, address, names)`: classified by id (mine or from before), validates the address and every name (a plain lower-case host name; `localhost`, `sandbox` (the sandbox's hostname), the `ip6-*` names and the container's 12-character short id are refused), then ONE root `docker exec -u 0 <id> sh -c LOCAL_ACCESS_SCRIPT sh <lines> /etc/hosts`. The script (exported, `LOCAL_ACCESS_SCRIPT`) exits at once when the marked lines already equal the wanted ones, else builds the unmarked lines plus the wanted ones and writes them with one `printf ... > "$file"` (no `sed -i`, no `mv`: `/etc/hosts` is a bind mount). Lines are `<address> <name>   # mcpe-local-access`.
  - Post-start step: `setContainment(hook, afterStart?)`; `afterStarted()` runs after `acquire` (when it started the sandbox, and for an already-running one with `started: false`), `ensureRunning`, the restart path of `exec` (`startIfStopped`) and `startForContainment` (only when it started). `clearLocalAccess()` (best effort, logged) empties the lines when `setNetwork` takes a running sandbox off its project network (`off` or `open`).
  - Facts carry `networkIds` (name to network id, from the inspect's `NetworkSettings.Networks[*].NetworkID`; omitted when absent) in the hook's and the post-start step's facts and in `inspectSandbox` and `listOwnSandboxes`.
  - `assertRuntime`/`checkRuntime`: when the named runtime is `runsc` and `docker info`'s `runtimeArgs` for it lack `--overlay2=none`, one warning line (not a refusal). The `Docker` constructor takes an optional third argument, a log function (`App` passes its own); this is the only way the layer logs.
- `src/network/containment.ts`:
  - `proxyEnvironment(address)` (was parameterless; the URL is `http://<address>:3128`, no host name).
  - **Replacement** (`replaceInner`, with `replaceLocked` a wrapper): under the lock, detach EVERY current proxy, `assertLive`, create the new proxy at the address (readiness inside `createProjectProxy`), `assertLive`, check `projectProxyAttached` at the address, then remove the old ones. On any failure: remove the new proxy by name, then restore ONE old proxy (stop, connect, start, ready, attached; the first that succeeds, because they share the address). A taken-over lock (`ContainmentLockLostError`) restores nothing. If no restore works the log says the project has no proxy; the next use finds a proxy that is not attached and `assess` returns `replace` (a unit case drives that path through the hook).
  - `Map<networkId, subnet>` (never invalidated): filled by every `findProjectNetwork`/`ensureProjectNetwork` the class already made, and read by `addressFor(facts)` through the new `facts.networkIds`, so the observe and open paths (no repair) pay one network inspect per network and none after.
  - Local-access names: `afterStart(facts, started)` (installed with the hook): skipped at once when the session does not contain, the project has no forwards in the configuration (most projects: no registry read, no Docker call), or the sandbox is not contained; else one `writeLocalAccess` (idempotent inside the sandbox). `syncLocalAccess` runs after a replacement that made a proxy (when there are names, or the session label differs from the old proxy's, which covers "forwards became empty") and after `contain` (when there are names). A failed write is logged and never fails a replacement or contain. The `mcpe-proxy` forward refusal and its warning in `buildConfig` are gone (a `forwardsFor` helper returns the run phase's forwards).
  - `checkUnlocked` returns the network it read; `repairLocked` returns `{ result, net }` so the hook's environment follows the repaired network.
- `src/server.ts`: passes `this.log` to `new Docker(...)`.
- `.github/workflows/docker-gvisor.yml`: `runsc install -- --overlay2=none` and a check that `docker info` lists it; new job **`contained-linux`** (Run C, below).
- `README.md`: addressing (by address, pinned subnet, last usable host), the replacement semantics, `/etc/hosts` local access, the `runsc --overlay2=none` requirement (in the idle-stop notes and in "The isolation runtime"). The "Behavior under gVisor (`runsc`) is not yet tested in CI" sentence and its LEG 12 comment are untouched, as instructed.
**Run A's 21 failures, classified from `gh run view 45146029960 --log`** (cause, then what changed):
- 15 of Run A's 21 (and Run B's one), contained or local-access cases ending in `Could not resolve proxy: mcpe-proxy` / `EAI_AGAIN` (the git ls-remote and refused-host cases, "through the proxy, CONNECT to host.docker.internal", the two-contained-projects case, replacement, repair, build phase, the Go, npm and cowsay installs, `check_project`, local access, `set_project_network(true)`, `set_project_hosts`, plus Run B's runtime proof): embedded DNS; fixed by addressing by IP and by `/etc/hosts`. These are expected to pass in CI and are not skipped.
- `/sys/class/net` empty under gVisor ("stops an idle sandbox", "keeps a network-enabled sandbox online", "moves a sandbox between off, contained and open"): all three now read `/proc/net/dev` through one `IFACES` command, **unconditionally** (same assertion under runc and runsc).
- "stops an idle sandbox, keeps its files": `expected [ 'data' ] to equal [ 'tool', 'data', 'lo' ]`: the product finding the leg names (gVisor's default root overlay discards the container layer on exit; `/opt/mcpe` was lost, `/workspace/work` is a volume). The case is unchanged apart from the interface command; CI registers `runsc` with `--overlay2=none`, the README states the requirement, and `assertRuntime` warns.
- "installs a Go CLI ... runs it offline": `Timed out after 5s` where `DOWN` was expected (`getent hosts` waits for DNS under gVisor); `timeout_seconds: 90` under `MCPE_DOCKER_RUNTIME=runsc` only, with the reason in the case.
- "works on, describes and removes a sandbox made before ownership": `ran.isError` true: the raw `docker run` had no `--runtime`, so `refuseRuntimeMismatch` rightly refused it; the `docker run` now passes `--runtime <cfg.docker.runtime>` when one is named.
- "T14 in code": `docker start` exit 1 after `ensure` and `attach`, no reason printed in the run: **not explained**. The case now prints `docker start`'s stderr and stdout and the container's `State` and `NetworkSettings.Networks` on failure. If it still fails, the next CI run names the cause; it is not skipped. The cause is not known.
- No case is skipped under `runsc`. The leg's list of cases that may not be skipped is respected (contained installs, isolation, 403/200, local access, runtime proof).
**Run C** (`contained-linux`, a separate job, parallel with `gvisor`): `ubuntu-latest`, no runsc, `MCPE_DOCKER_RUNTIME` unset (and `unset` in the step), `vitest run test/integration/docker.test.ts -t "$CONTAINMENT_DESCRIBES"` where the pattern selects the describes of legs 5 to 10 (`contained networks and the one-shot proxy`, `project network primitives`, `containment hook`, `the contained install`, `network tools and local access`, `startup containment`), same build steps, summary step with `if: !cancelled()`, `SECONDS_C`. The summary exits 1 when fewer than `CASES_EXPECTED` (31 = 7 + 5 + 5 + 6 + 5 + 3, counted from the `it(` lines of those describes at this leg) cases passed, with a comment to update the number. Risk to read in the first run: if the leg-9 local-access case skips itself on the runner (its Desktop-only skip), the count is 30 and the job fails closed.
**Existing tests changed or removed, and why**:
- `test/docker.test.ts`: (fake) the scripted daemon's `network create` honors `--subnet`/`--ip-range` and a counter of "Pool overlaps" refusals, `network connect --ip` is recorded and a taken address is refused, the networks inspect carries `IPAMConfig` instead of `Aliases`.
  - `createContainedNetwork` "creates with the isolated, internal..." and "uses a name it is given" rewritten for probe-then-pin (the probe is a second create, an inspect and a remove).
  - One-shot behind a proxy: the verb order list (probe added), `netOf` and two teardown cases take the LAST network create/remove (the real network, not the probe), "joins the contained network under the alias" is now "at the proxy address (no alias)", and the proxy variables are the address.
  - `ensureProjectNetwork`: the six cases that script `network create` (made, adopt after a lost race, refuse someone else's, timeout, check fails, no usable id) now match the named network only and count `network rm` after the probe's own.
  - `createProjectProxy`: "makes a hardened proxy" expects `--ip 172.30.50.254` and no alias; **removed** "refuses a forward target named mcpe-proxy" (and the alias grammar check it exercised): nothing collides with that name any more; replaced by "makes a proxy whatever the forward target is called".
  - The two hook cases with the real `Containment` and the proxy environment expect the address.
  - `projectProxyAttached`: two cases rewritten (address, not alias; a stopped proxy; the running address without `IPAMConfig` and an alias do not count), one kept.
  - The guard-table list of methods (`NOT_GUARDED`) names the seven new methods; four inert `mcpe-proxy` strings in env pins became an address.
- `test/containment.test.ts`: `FakeLayer` implements the three new methods (one address per network: a second attached proxy is refused, which is what makes the replacement order matter) and the post-start hook; "takes the forwards from local access, refuses one named mcpe-proxy" lost its refusal half; "the proxy environment names mcpe-proxy" is now "holds an address and no host name"; "runs the steps in order" gained `detachProjectProxy` and `projectProxyAttached`; the observe-mode and open-mode hook cases now need the network's subnet (one `findProjectNetwork`, then none for the same id); about twelve assertions `toEqual(proxyEnvironment())` became `toEqual(envNow())`.
- `test/startup-containment.test.ts`: `FakeLayer` gained the three methods. `test/proxy.test.ts`: two inert env strings. `test/docker-bypass.test.ts`: the new methods are in the tables, `writeLocalAccess` is the one documented unhooked exec (a new case pins its callers to `containment.ts` and `clearLocalAccess`).
- `test/integration/docker.test.ts` (written, NOT run): see "Docker-gated cases" below.
**New unit cases**: `proxyAddress` (/16, /24, /20, /30, /29, /8, masking, never broadcast, refusals); no `--alias` and no `mcpe-proxy` anywhere in `docker.ts`/`containment.ts` and every proxy `connect` carries `--ip`; probe-then-pin (order, flags, lower half for three subnet sizes, 3 retries then the error, probe removed on every path, too-small subnet refused, a failing real network removed by id); detach/restore (classification, order, address taken, readiness); `writeLocalAccess` (argv, refused names including the short id and `localhost`, refused address, refused owner classes, gone, exec failure) and the script run in a real `sh` against temp files (written, twice, replace, remove, read-only no-op, no `sed`/`mv`, one redirect); the post-start step (acquire, ensureRunning, exec restart, `startForContainment`, ids, no hook) and the `setNetwork` clear (off and open, stopped, failing, never on a network); the `runsc` warning (absent, empty, other, default overlay, quiet when present, cached, other runtime); replacement (order, every proxy detached, readiness failure, not attached, no proxy left then repaired through the hook, lock lost restores nothing, one of two restored, not-attached repaired on use); local access names (replace writes once, unchanged writes none, forwards empty removes, build writes none, `contain` writes after the network, failed write logged, post-start skips: no forwards, not contained, no label, not the record's, session not contained; one network read per id).
**Trials** (`git diff --stat` 13 files, 1991 insertions, 234 deletions and `git status --short` 15 entries before; each weakening confirmed to fail, then restored by editing; the per-file diff hashes of `docker.ts` and `containment.ts` after restoring equal those before):
1. the alias reinstated in the project proxy's connect: 6 failed (hardened-proxy argv, forward target, taken address, the two source scans, the one-shot/restore scan).
2. the old proxy removed as soon as it is detached (before the new one is ready): 9 failed (the order case, the three rollback cases, the deadline and stolen-token cases, the new "takes the old proxy off" cases).
3. the `/etc/hosts` script not idempotent (no early exit, marked lines kept): 4 failed (twice, read-only, replace, remove).
**Checks**: `npm run typecheck` clean; `npm test`: **2626 passed, 69 skipped before; 2728 passed, 71 skipped after** (+102 passed: containment +27, docker +74, bypass +1; +2 skipped: the two new Docker-gated cases); `npm run build` clean. The workflow parses as YAML with three jobs; `bash -n` of every `run:` block (piped from a YAML read, no file written) and a syntax check of both summary scripts: clean. `actionlint` is not installed here.
**Deviations and notes**:
1. The leg says the hostname is "its short id"; the landed code names it `sandbox` (`--hostname sandbox`). Both are refused in `writeLocalAccess`, and the configuration grammar already refuses any one-label name (`localhost`, `sandbox`), which a unit case shows through `loadConfig`.
2. The Resolutions' "`Map<networkId, subnet>`" had no network id to key on (the hook's facts had names only): the facts now carry `networkIds`, optional so every existing double still works.
3. `proxyEnvironment` takes the address; `Docker` takes an optional log function; `ContainmentDocker` gained `detachProjectProxy`, `restoreProjectProxy`, `writeLocalAccess` and `setContainment`'s second parameter; `projectProxyAttached`'s `net` needs `subnet`. These are the leg's changes written down.
4. `setNetwork` to `off`/`open` of a running sandbox that was on its project network now costs one extra root exec (the clear), by the requirement that the lines go when the sandbox is taken off. It is best effort.
5. Not done: no Docker-gated case was run; `T14`'s cause is open; the Run C count is from `it(` lines and the first run may correct it.
**Docker lists before Stage B** (read-only, `docker ps -a`, `volume ls -q`, `network ls`, `images`): containers 22 `a77d6ff404831ba4`; volumes 253 `0e4087fdb748c72d`; networks 8 `7f5b38ebaeb9bea9`; images 81 `6aade336f6f4094b`. The volume list is saved in `scratchpad/leg13-volumes-before.txt` (253 lines, checked equal to the daemon's list; the Write tool). The 253rd volume is the one the flight's first fix run left (`c7c26191...`, with the other kept ones).
**Docker-gated cases** (all under `describe.skipIf(!enabled)`; created objects are removed only through the file's checked helpers):
- NEW, leg 7 describe, "leg 13: a replacement keeps the proxy's address and the sandbox's environment; a failed replacement puts the old proxy back at that address": creates one sandbox (suite prefix, the describe's random owner id, a `ct<hex>` slug), its volume, its `-net` and two proxies in turn (a forced replacement, then a replacement through a `Docker` subclass whose `createProjectProxy` throws, which rolls back for real: stop, connect `--ip`, start, ready). Removal: the describe's `sweepOwn()` in `finally` removes every container (with `-v`), network and volume found by the describe's own owner label through `removeContainerWithVolumesChecked`/`removeNetworkChecked`/`removeVolumeChecked`, each of which refuses a name that is not under the suite's `mcpe-it-<pid>-` prefix (or `mcpe-<id>-gron` for the two-installation cases); then the case asserts nothing of that owner remains.
- NEW, leg 9 describe, "leg 13: the local-access names are in the sandbox's /etc/hosts ...": one sandbox on the proxy image, its volume, `-net` and proxy, a registry record in the describe's own temporary data directory; stops and restarts the sandbox with `docker stop` on the checked name; replaces the proxy under a configuration with no forwards. Removal: the same `sweepOwn()` (owner label) and `afterAll` removal of the describe's data directory (checked to be under the temporary directory and named `mcpe-it-c9-<id>`).
- CHANGED (same guards, no new object): the idle-timeout cases and the project-network primitives case read `IFACES`; the project-network case also asserts the proxy's `IPAMConfig` address and `projectProxyAttached`, and that no alias is present; the CONNECT scripts (three copies) take the proxy's host from `HTTPS_PROXY`; five `mcpe-proxy` pins now compare with `proxyUrlOf(<net>)` (inspect of the network's subnet); the bash `/dev/tcp` probe in the Go install reads the host from `HTTPS_PROXY`; the replacement case passes `-e HTTPS_PROXY=<url>` to its raw `docker exec` and no longer expects an overlap; the post-replacement checks (here and in `set_project_hosts`) retry up to 6 times, 1 s apart; the Go CLI offline case, the "before ownership" case (`--runtime`) and T14 (diagnostics) as classified above.

### gvisor-network-changes
**Status**: landed (not committed). Stage A below; Stage B and the T18 follow-up recorded here.
**Stage B** (Flight Director's go-ahead): full local `npm run test:docker` (no runtime named): first run **65 passed, 1 failed, 5 skipped**, 646 s. The one failure was a leg-14 consequence, not a product bug: the one-shot proxy case "while it runs the proxy is hardened and joined to bridge and the one-shot network only" asserted `HostConfig.NetworkMode === "bridge"`, but the proxy is now created on the one-shot network, so the mode is that network's name. **Changed that assertion** (now: the mode names the `-oneshot-net-` network, and `NetworkSettings.Networks` holds exactly `bridge` plus that network; the other assertions of the case are unchanged, none loosened otherwise). Re-ran that case alone: passed. After-lists identical to the before-lists (containers 22 `eda4d0afb38a`, volumes 253 `0e4087fdb748`, networks 8 `751ad5f79484`); volume diff against `scratchpad/leg14-volumes-before.txt` empty (no new volume); no `mcpe-it`/`mcpe-hosts` dir in `/tmp`. Log: `scratchpad/leg14/docker-run.log`. Final counts: `npm test` 2751 passed, 71 skipped (before 2728/71); typecheck and build clean. Docker-gated cases are not rerun in full after the one-assertion edit (the single case was).
**What was built**:
- `src/sandbox/docker.ts`:
  - `proxyMac(networkId)` (pure, exported): `02:` plus the first five bytes of `sha256("proxy-mac:" + id)`; locally administered, unicast, the same for the same id. `proxyNetworkSpec(net)` (private): `name=<net>,ip=<proxyAddress>,mac-address=<proxyMac>`.
  - Both proxies (one-shot's `startProxy`, project's `createProjectProxy`) are created with `--network <spec>` (no longer `--network bridge`), then `network connect bridge <id>` (no `--ip`), then `start`. A taken address now fails at the create with Docker's own words, as `ProxyStartError`.
  - `restoreProjectProxy` is unchanged (stop, `network connect --ip`, start, ready, attached); `projectProxyAttached` still checks the configured address.
  - `isRuncRuntime(runtime, daemonDefault?)` (pure, exported): `runc` and `io.containerd.runc.v2` are runc; an absent runtime is the daemon's default (runc until known).
  - `whileStopped(id, name, change)` (private): `docker stop -t 5`, the change, `startId` (with the runtime mapping), then a fresh inspect and the post-start step. A failed change leaves the sandbox stopped (never started on the wrong networks). `needsRestartToChangeNetwork(c)`: running and not runc.
  - `setNetworkNow("contained")` does attach, then `disconnect bridge`, inside `whileStopped` when the sandbox is running under a non-runc runtime; unchanged otherwise. `attachProjectNetwork(ref, net, running?)` takes the optional sandbox facts (`{ running, runtime }`) and does the same stop, attach, start for the repair's re-attach; with no third argument it is as before.
  - `restartSandbox(name)` (public): resolve and classify, then `whileStopped` with no change; a stopped or missing sandbox is left alone. It exists only for the fallback.
- `src/network/containment.ts`:
  - `RESTART_AFTER_SWAP` (exported const, **false**) and `restartAfterSwap({ running, contained, runc }, enabled = RESTART_AFTER_SWAP)` (pure): the one named place to switch the fallback on. `replaceInner` calls a private `restartForSwap(s)` after a successful swap (before the local-access write): with the switch off it returns at once; on, it inspects the sandbox and calls `docker.restartSandbox` when it is running, contained and non-runc. Never throws (logged).
  - `ContainmentDocker` gained `restartSandbox` and the optional third argument of `attachProjectNetwork`; the repair passes `{ running: f.running, runtime: f.runtime }`.
- `test/integration/gvisor.test.ts`: Run B's events format is `{{.Actor.ID}}`. **Checked locally** against the Docker 29.8.2 Desktop daemon with read-only `docker events --since .. --until .. --format`: `{{.Actor.ID}}` prints container ids; `{{.ID}}` fails with "can't evaluate field ID in type *events.Message" (the CI failure). `docker events --help` lists `--format string` with Go templates.
- `test/integration/docker.test.ts`: T14 is `it.skipIf(process.env.MCPE_DOCKER_RUNTIME === "runsc")` with the reason (runsc cannot clean up a container whose start failed, a stale containerd task, so a stopped sandbox whose `-net` was removed must be recreated).
- `README.md` (gVisor limits, in "The isolation runtime"): containing a running sandbox restarts it under gVisor (processes do not survive; proxies carry a fixed address and MAC so a replacement needs no restart); a stopped sandbox whose project network was removed is recreated (T14's cause). The "not yet tested in CI" sentence and its LEG 12 comment are untouched.
**Existing tests changed, and why**:
- `test/docker.test.ts` (fake): `create` reads `--network name=..,ip=..` (the proxy starts on that network with its address, `bridge` joins later), refuses a taken address at the create like Docker, and `stop` now stops the container.
  - "creates the proxy hardened" (one-shot) and "makes a hardened proxy" (project): `--network` is the spec with the MAC, not `bridge`; the project one also expects the only connect to be `bridge` and the networks order `[project net, bridge]`.
  - "joins the contained network at the proxy address (no alias) before it starts" renamed to "is created on the contained network ..., joins bridge before it starts": the connect is `network connect bridge <id>`.
  - "makes a proxy whatever the forward target is called": the connect is the bridge one and the create carries the address.
  - "an address that is taken fails the join with the address named ..." renamed ("fails the create with Docker's reason, makes nothing"): the failure is now at the create, so the message is Docker's "Address already in use" (the address is no longer in it) and no connect is issued.
  - "no `network connect` in docker.ts carries --alias ...": proxy connects are now `bridge` (no address) or the restore's `--ip`; the count of `--ip` connects is 1, not 3, and one create spec is shared by both proxies.
  - "a one-shot's proxy variables, a project proxy's connect and a restored proxy's connect all carry --ip" renamed: the create carries the address and MAC, every proxy connect of a create is `bridge`, the restore's connect carries `--ip`.
  - `NOT_GUARDED`: names `needsRestartToChangeNetwork`, `whileStopped`, `restartSandbox`. A seed string was changed to avoid the `mcpe-proxy` source scan.
- `test/docker-bypass.test.ts`: the three new methods are in the tables (`whileStopped` and `restartSandbox` are unhooked by design, like `startForContainment`: containment's own network changes); the `startId` callers list gained `whileStopped`.
- `test/containment.test.ts` (`FakeLayer`): records the attach's third argument (`attachInfo`), implements `restartSandbox`, and has an `afterDetach` hook. "recreates a missing network and attaches the sandbox" also asserts the facts passed. `test/startup-containment.test.ts` (`FakeLayer`): implements `restartSandbox`.
**New unit cases**: `proxyMac` (format, same id same MAC, different ids differ), `isRuncRuntime`; both proxies' create argv; the stop, attach, disconnect bridge, start order and the post-start step under `runsc` and `kata`, runc and no-runtime sandboxes unchanged, a stopped runsc sandbox unchanged, a failed attach and a failed stop, the repair's `attachProjectNetwork` with and without facts, `restartSandbox` (running, stopped, missing, another's refused); containment: the repair passes its facts, `restartAfterSwap` in both states, the shipped switch is off and a replacement restarts nothing, and **leg 13's follow-up**: a lock lost after the detach and before the create creates nothing and restores nothing.
**Trials** (`git diff --stat -- src test` 6 files, 397 insertions, 44 deletions before; each weakening confirmed to fail, then restored by editing; the diff stat afterwards matches except the one-line difference the trials' own restore left out of the before count, checked by `grep` on the three restored lines):
1. the MAC dropped from the create spec: 5 failed (both argv cases, the MAC case, the two source scans).
2. `needsRestartToChangeNetwork` made false (the stop, attach, start branch disabled): 5 failed.
3. `RESTART_AFTER_SWAP` set true: 4 failed (the "off" cases and two order cases that count the sandbox's calls).
4. `assertLive` removed between detach and create: 1 failed, the new case (this was the leg 13 review's uncaught mutation). One trial edit dropped a trailing space on `const made =`; it was found by reading the lines and restored, and the three tests files re-ran green.
**Checks**: `npm run typecheck` clean; `npm test`: **2728 passed, 71 skipped before; 2746 passed, 71 skipped after** (+18 passed); `npm run build` clean.
**Deviations and notes**:
1. **Open question, the rollback's MAC.** The leg says the restore path reconnects with the same IP and "its MAC is fixed at create". `network connect` has no MAC option (T17), and the proxy was disconnected by the replacement. T17 did not test a disconnect then a reconnect; Docker may give the reconnected endpoint a MAC derived from its IP (`02:42:..`) rather than the one fixed at create. If so, a failed replacement's rollback would restore the old IP with a different MAC under gVisor. It affects only the rollback of a failed replacement; the new Docker-gated case reads the MAC after a normal replacement (not after a rollback). Not guessed at: reported for a check after the gate.
2. `attachProjectNetwork` gained an optional third parameter rather than a new method, so the repair keeps one call. `ContainmentDocker.restartSandbox` is required (the fallback needs it); the fakes gained it.
3. The stop uses `-t 5`; the leg names no timeout.
4. A repair's re-attach runs the post-start step too (the leg: "then afterStart"), before the proxy replacement that follows it.
**T18 follow-up (Flight Director's answer to deviation 1)**: T18 (Docker Desktop 29.8.2, throwaway objects) showed that a proxy created with a fixed MAC, disconnected and reconnected with `--ip`, keeps its IP but gets a NEW random MAC; the connect `--driver-opt` MAC does not help. So `rollbackReplace` now calls `restartAfterRestore(s)` after a successful restore: if the sandbox is running and `isRuncRuntime` is false, `restartSandbox` (not behind `RESTART_AFTER_SWAP`; never throws, logged). Unit cases: runsc and running restarts once; runsc stopped, runc and no runtime restart nothing; a failed restore restarts nothing (5 new cases; `npm test` count recorded below). Trial 5: the `restartAfterRestore` call removed: the runsc-running case failed (1), restored. Deviations 2 to 4 accepted. The leg's Context now records T18.
**Docker lists before Stage B** (read-only): containers 22 `eda4d0afb38a`; volumes 253 `0e4087fdb748`; networks 8 `751ad5f79484`. The volume list is saved in `scratchpad/leg14-volumes-before.txt` (253 lines, checked equal to the daemon's list; the Write tool).
**Docker-gated cases changed or added (written, NOT run)**:
- CHANGED, `test/integration/docker.test.ts` leg 6 case "moves a sandbox between off, contained and open ...": also asserts the proxy's MAC on the project network is `proxyMac(network.id)` (a read-only inspect; no new object).
- CHANGED, leg 13 case "a replacement keeps the proxy's address ...": also reads the old and the new proxy's MAC on the network and expects both to be `proxyMac(network.id)` (the old one read before the replacement; no new object).
- CHANGED, T14 "in code": `skipIf(MCPE_DOCKER_RUNTIME === "runsc")`; unchanged otherwise.
- CHANGED, `test/integration/gvisor.test.ts` runtime-proof case: the events format.
- No new Docker object is made by any case. Cases that call `setNetwork(.., "contained")` on a running sandbox now stop and start it under `MCPE_DOCKER_RUNTIME=runsc` (the product change), which only the CI `gvisor` job exercises; locally (no runtime named) they behave as before.

## Decisions

### MCPE_LOCAL_ACCESS targets are names; the agent's hosts are names
**Context**: Designing leg 1. A contained sandbox has no route to any address (T1); it reaches local access only through a name that resolves to the proxy on its own network (DD10, T8). An IP literal target could never be dialed from the sandbox. Separately, DD4 and DD6 allowed a public IP literal in the agent's `hosts`, which would put the refused-range table into leg 1.
**Decision**: `MCPE_LOCAL_ACCESS` targets must be host names (an IP literal is a startup error explaining why). The agent's `hosts` entries are names only. Scanner `hosts` (the operator's file) may hold IP literals.
**Impact**: DD13's "local service named by its bridge address" becomes `host.docker.internal:<published port>` (a container on `bridge` with a published port), in legs 5 and 7. The refused-range table stays in leg 3 only. An operator whose local service has no DNS name has no way to allow it in this flight; a `name@address` form could be added later.

---

## Deviations

---

## Anomalies

---

## Session Notes

### Flight Director Notes
- 2026-11-22: execution started. Phase file `.flightops/agent-crews/leg-execution.md` loaded and valid (Developer and Reviewer on Sonnet). Flight set to `in-flight`. 11 legs; starting at leg 1.
- Leg 1 `network-config` tiered **high-risk**: it contradicts the flight spec in two places (see Decisions), and the host grammar is the agent-facing half of a security boundary. A Developer design review follows.
- Leg 1 design review 1: approve with changes. Its high issues:
  - IPv4 shorthand passing as a name: `domainToASCII("127.1")` gives `"127.0.0.1"`, confirmed by the Flight Director;
  - `domainToASCII` not enforcing label rules;
  - misidentified test literals: no `Config` literals exist, but there are six `ScannerSpec` ones.

  Folded in, with a mode-based grammar and an ordered list of checks.
- Leg 1 design review 2 (the last cycle): approve with changes. Two more holes:
  - the trailing dot was stripped after the IP checks (`1.2.3.4.` was stored as a name);
  - hex last labels (`0x7f.0x1` resolves to 127.0.0.1).

  Folded in without a third review: the dot is stripped first, and the full WHATWG "ends in a number" rule applies. Also added: the wildcard split before the label checks, a `step` on the error for tests, and the `xn--` handling. Leg 1 set to `ready`.
- Leg 2 `runtime-required` designed in parallel with leg 1's reviews and tiered **high-risk** (a lifecycle refusal on existing sandboxes; the inspect format, a shared interface the test double answers).
- Leg 2 design review 1: approve with changes. Folded in:
  - private methods listed in the coverage test;
  - the error mapping narrowed to T9's exact wording (`/runtime/i` would have relabelled any OCI start failure);
  - `set_project_network(false)` kept working on a refused sandbox;
  - the covered and deferred paths stated exactly;
  - the test doubles;
  - `reconcileStale` left alone;
  - an absent runtime counted as the daemon's `DefaultRuntime`.
- Leg 2 design review 2 (the last cycle): approve with changes. The new "off" path keeps the "still installing" guard and the missing-sandbox message; `ensureRunning` compares for references too. Folded in; leg 2 set to `ready`.
- Leg 1 Developer spawned for implementation while leg 2 was reviewed (read-only reviews alongside an implementation, as in flight 1). Leg 2's implementation waits for leg 1 to land: both touch `test/docker.test.ts` and `test/installer.test.ts`.

### 2026-11-22 — Planning
- Trials T1–T10 run before the interview; T11–T13 after design review 1, to answer its question on how the proxy resolves a forward target that is also a network alias. All objects were named `mcpe-plan-<n>` and removed. The operator's daemon is Docker Desktop on WSL2 (server 29.8.2), not a native Linux engine; native Linux is covered by the new CI job (DD13).
- Design review 1 (Architect): approve with changes; folded in (see the flight's header note). Legs went from 9 to 11.
- Design review 2 (Architect, the last cycle): approve with changes. Its spec gaps were folded in by the Flight Director without a third review, as the method allows. Its two behavior questions went to the operator: an existing sandbox under another runtime is refused with "reinstall"; a draft pull request is opened at leg 4 for the native-Linux measurements.
- Items review 2 asked to be measured, not assumed, are carried as leg-4 prerequisites: the interface-bound listen, a read-only `node -e` proxy, a two-holder alias, `host-gateway` and the resolver on native Linux.
- Leg 1 `[LAND:leg]` received. Flight Director check: typecheck clean; `npx vitest run` gives 1668 passed and 37 skipped (31 files plus 1 skipped), matching the Developer's report. `test/config.test.ts` was appended with a shell heredoc against the edit-only rule; its diff was read and it is intact (45 added lines, no truncation). The rule is restated to the next Developer. Leg 1 checked off in the flight. Legs completed: 1 of 10 autonomous.
- Leg 2 Developer spawned.
- Leg 3 `proxy-program` tiered **high-risk** (the flight's security boundary; hostile input).
- Leg 3 design review 1 (attack-minded): approve with changes. The Flight Director re-ran its pipelining experiment and confirmed it: Node fired a `connect` event for `b.com:443` after a GET on the same socket despite `Connection: close`, and an upgrade request stayed open until the timeout. Leg 3 was rewritten with:
  - a single-use socket guard;
  - a strict authority grammar;
  - one `classify()` into never, local or public with embeddings;
  - an IPv6 allowlist;
  - handshake deadlines;
  - fixed refusal reason codes;
  - per-connection `ownCidrs`;
  - upstream error handling;
  - a hop-by-hop list;
  - no test hooks in the shipped text.

  Second review running.
- Leg 2 `[LAND:leg]` received. Flight Director check: typecheck clean; `npx vitest run` gives 1716 passed and 37 skipped, matching the Developer's report. Edit-only rule kept. The optional Docker-gated runtime case was not written (no go-ahead given). It is left to leg 10's CI job, which proves the runtime for real. Legs completed: 2 of 10 autonomous.
- Leg 4 `contained-networks` design started. It waits for leg 3 to land before implementation (leg 4 runs the proxy program).
- Leg 3 design review 2 (the last cycle, attack-minded): approve with changes, no high issues. It measured the single-use guard working on Node 22 for every pipelining form, including after a slow first handler. Folded in without a third review:
  - the forward exemption scoped by name and by `/etc/hosts` origin;
  - the class precedence;
  - a canonical IPv6 definition, cross-checked against `new URL`;
  - the handshake deadline as a timer, with per-address caps;
  - a refusal list aggregated against flushing;
  - per-handler try/catch;
  - body and `Transfer-Encoding` checks in the handler;
  - path normalization, no `statusMessage` relay, and an upstream idle timeout;
  - the `deps` seam wording;
  - more residual routes for leg 9.

  Leg 3 set to `ready`; Developer spawned.
- Leg 4 (`contained-networks`) design review 1: approve with changes. Findings:
  - network "not found" wording does not match `NOT_THERE`;
  - a missing readiness contract with leg 3;
  - no `proxyConfig` signature;
  - `ownCidrs` versus a local service on `bridge`;
  - unenumerated failure paths;
  - the readiness mechanics;
  - the refusals read needs bounds;
  - the proxy's hardening untested;
  - the exec-environment naming;
  - the workflow's lifecycle;
  - the prober choice.

  It recommended a split.
- **Split** (Flight Director):
  - the measurement workflow becomes leg 4, `linux-measurements` (low-risk, a single new file, no dependency on legs 1–3), implemented now, in parallel with leg 3;
  - `contained-networks` is renumbered to leg 5 (`legs/05-contained-networks.md`);
  - `ExecOptions.env` and the connector's environment move to `project-proxy-lifecycle`, their first caller.

  Flight legs list updated: 12 legs in all, 11 autonomous plus the HAT.
- **Leg 3 contract additions sent to leg 3's Developer mid-leg**:
  - the control endpoint starts only after all listeners are bound;
  - `/status` carries `ready` and `listening`;
  - `proxyConfig`'s exact signature, `PROXY_CONTROL_PORT`, and `proxyLaunchArgs`.

  Recorded here because they change leg 3's acceptance after it went `in-flight`; leg 3's Developer records them in its entry.
- **A local service on `bridge` is never reachable from a contained network, by design.** The proxy's `ownCidrs` include `bridge`, which leg 3 classes `never`, and another project's open sandbox sits on `bridge`. Local services go through `MCPE_LOCAL_ACCESS` names (`host.docker.internal` with a published port) under leg 3's narrow exemption. DD13's "local service on `bridge`" case was already changed at leg 1.
- Leg 5 rewritten with the review folded in. A second design review is planned once leg 3 lands, so it can check leg 3's actual exports.
- Leg 3 `[LAND:leg]` received. Flight Director check:
  - typecheck clean;
  - `npm run build` emits `dist/network/proxy/proxy.cjs` (55,595 bytes);
  - `npx vitest run` gives 1986 passed and 37 skipped, matching the report;
  - the file starts with `"use strict"` and requires only `node:` built-ins.

  Deviations accepted as reported:
  - `start(config, deps)` exported alongside `main`;
  - `limits` required;
  - `resolverFailures` ignores NXDOMAIN and NODATA;
  - `matchEntry` returns the entry, a `local` one winning. A project proxy never carries `local` entries; only a scanner's one-shot does.
  - cap rows carry `http` or `forward` as their kind.

  **The unit suite's time grew from about 11 s to 31 s** (the proxy's server and child-process cases). This adds to flight 1's debrief item about the unit suite's speed; it is noted for this flight's debrief, not fixed mid-flight. Legs completed: 4 of 11 autonomous.
- Leg 5 design review 2 spawned against leg 3's landed exports.
- Leg 5 design review 2 (the last cycle): approve with changes. The leg-3 contract matches the landed code. Folded in:
  - a failed `docker start` of the proxy throws `ProxyStartError` with Docker's stderr line;
  - `bindWaitMs: 3000` keeps the program's bind wait inside the 10 s readiness budget;
  - an explicit `ProxyReport` and row type, with nullable host and port, returning `total` and `resolverFailures`;
  - the network "not found" pattern covers both wordings;
  - an in-container timeout on the status exec, and one `proxyStatus` helper;
  - `egress` with `network` defined;
  - the double's verbs and "exactly one" coverage list.

  Leg 5 set to `ready`. Its Developer was spawned with a hard stop at the Docker gate (`[BLOCKED:docker-gate]`) before any Docker-suite run.
- **Leg 5 Docker gate (Flight Director, 2026-11-22).** Phase A reported: 2117 passed and 44 skipped (7 new Docker-gated cases), with typecheck and build clean. The operator's ids before the run (22 containers, 8 networks, 244 volumes by count and hash) are in the leg's entry. The Flight Director read all seven new cases in `test/integration/docker.test.ts` before the first run:
  - each `describe` uses a random owner id and the suite's `mcpe-it-<pid>-` prefix;
  - every removal goes through `checkedForRemoval`/`mayRemove`, with a new `removeNetworkChecked`;
  - `sweepOwn` lists only by that owner label;
  - the sweep case runs as that same random installation, so it can only see its own objects.

  **Go-ahead given** for the Docker suite and the three measurements.
- Leg 5 `[LAND:leg]` received.
  - **Docker suite**: first full run gave 41 passed, 2 skipped (pressure) and 1 failed, in 293.8 s. The failed case was a test bug (`host.docker.internal` parsed in agent mode). It was fixed and re-run alone; it passed. **A full green Docker-suite run is still owed** and is taken at the flight-end review.
  - **Flight Director check**:
    - containers 22 and networks 8, as before the run;
    - no `mcpe-it` leftovers;
    - volumes 246, against 244 before.
  - **The widened assertion is accepted.** With a scanner-style `local: true` entry allowing `host.docker.internal`, a CONNECT to `host.docker.internal:80` answers **502** (connect failed), not 403. On Docker Desktop the name resolves upstream to `192.168.65.254`, a `local` address. DD12 lets the operator's scanner entries reach local addresses, and nothing listens on port 80, so 502 is the design working. Bridge addresses stay 403 (`ownCidrs`). With nothing allowed, every target is still 403.
  - **Pre-existing leak found: one anonymous volume per one-shot of the probe image.** The Flight Director confirmed `alpine/git` declares `VOLUME /git`, and `runOnce` removes with `rm -f` without `-v` (`src/sandbox/docker.ts`, the one-shot `finally`). Every clone since mission 02 has left an anonymous volume. That likely explains many of the operator's 221 anonymous volumes and the two unlabelled ones in flight 1's debrief.
    - This flight adds probe-image one-shots (`resolv-read`), so the leak would grow.
    - **Decision**: fix it in this flight as a shared-surface item of leg 6 (`project-proxy-lifecycle`, which edits the same teardown). The fix is `rm -f -v` for one-shots, which removes only anonymous volumes, never a named volume that is mounted. No separate squawk is opened.
    - The operator's existing anonymous volumes are left for the operator.
  - **Measurements**:
    - the proxy image is Node **v22.23.5**;
    - `docker exec` into the read-only, non-root, cap-dropped proxy works;
    - the two-holder alias spreads answers (4/6 before a restart, 6/4 after) on Docker Desktop too, matching the runner.
  - Legs completed: 5 of 11 autonomous.
- Leg 6 `project-proxy-lifecycle` designed and tiered high-risk. **Its design review: needs rework (narrowly).** Findings:
  - the project label is the repository id, not the slug;
  - the build phase versus the hook: repair would have swapped the build proxy mid-install;
  - `replace` could not be forced;
  - a bare reference carries no network facts;
  - `contain`'s order was unspecified, and `-net` repair sat outside the lock;
  - the stale endpoint of a removed network;
  - `removeContainer` sits between build attempts;
  - the hook would run inside cleanup;
  - deadlock with the startup pass;
  - the environment precedence;
  - lock takeover;
  - version flapping;
  - the pinned tests;
  - `networkState` gaps;
  - the bypass test against verbs alone.

  It recommended a split.
- **T14** (Flight Director trial, Docker Desktop, throwaway `mcpe-plan-<n>` objects, all removed):
  - a stopped container whose network was removed still lists it, and `docker start` fails with "network … not found";
  - after recreating the network by name, `disconnect -f` plus `connect` lets it start.
- **Split**: leg 6 is now `project-network-primitives` (the Docker layer, no hook) and leg 7 `containment-hook` (`Containment` and the hook). The later legs renumber: contained-install 8, network-tools 9, startup-containment 10, status-and-docs 11, gvisor-ci 12, HAT 13.

### Leg 6/7 design decisions (Flight Director, from leg 6's review)
**Decision**:
1. Proxies and networks carry the repository id as their project label, like sandboxes.
2. The build phase comes from `record.status` alone.
3. `replace` has `force`.
4. The hook receives facts from one full inspect (`.Name` added), and a per-container-id cache (5 s, invalidated by a callback) is mandatory, for execs on running sandboxes only.
5. `restart: false` execs use an observe-only hook.
6. The startup pass never goes through the hook.
7. A newer program's proxy is never replaced by an older session. The image reference goes only in the session label.
8. Lock guards: a 90 s deadline, a token re-check before removing others, a refusal on wait timeout, no mutex re-entry, and a re-list inside the lock.
9. `removeContainer` keeps the proxy and `-net` across build attempts; `destroy` removes them in the order container, proxies, network, volume.
10. The reference's environment wins over a caller's.
11. `networkState`: anything but "nothing" or "its own `-net` only" is `open`, and a missing container is `off`.

**Impact**: legs 6 and 7 rewritten. Leg 6 is tiered high-risk (shared-interface change: `setNetwork`'s signature, test fakes). Leg 7 is tiered high-risk (concurrency, lifecycle, security).

- **Design reviews 2 of legs 6 and 7** (the last cycles): both approve with changes.
  - **Leg 6's findings**:
    - `setNetwork`'s "exactly today's calls" claim against three pinned tests;
    - `destroy` unable to find proxies once the container is gone;
    - `proxyStatus` private;
    - a fixed-name network with a removal by name;
    - the test enumeration;
    - the volume fix's paths.
  - **Leg 7's findings**:
    - the startup wait came after the `open` no-op, so a legacy sandbox could exec uncontained;
    - an ambiguous lock form that could leave zero proxies;
    - a recreated `-net` leaving the old proxy behind;
    - the install-end contract (discovery runs under build hosts);
    - keys and twins;
    - the bypass scan;
    - the version-rule costs;
    - cache ownership;
    - the startup API and error types;
    - an unhooked start for the pass;
    - the deadline;
    - observe mode.

  All settled by binding "Design Review 2 Resolutions" sections in each leg, without a third review. Both legs set to `ready`.
- **T14b / T15** (Flight Director trials, Docker Desktop, throwaway objects, all removed):
  - `disconnect -f` from a removed network succeeds on a stopped container;
  - a container **created** with `--network <net>` can never start once that network is gone;
  - one created on `bridge`, moved to the internal network before its first start, runs contained. After its network is removed and `disconnect -f`, it runs on no network, also across restarts.
  - **Rule for leg 8**: create contained sandboxes on `bridge` and move them before the first start.
- Leg 6 Developer spawned with the two-phase gate.
- **Leg 6 Docker gate (Flight Director).** Phase A: 2225 passed and 49 skipped (+108, plus 5 gated cases), typecheck and build clean. Four trials each failed tests.
  - The Flight Director read the new describe (`test/integration/docker.test.ts`, "project network primitives") and the new `removeContainerWithVolumesChecked` (`rm -f -v` through `checkedForRemoval`, which removes only that container's anonymous volumes):
    - a random owner id and the suite prefix;
    - every removal checked;
    - the volume case only lists and inspects.
  - **Go-ahead given** for the full Docker suite (which also owes leg 5's full green run) and the fifth trial.
  - **Deviation 1** (`disconnect -f` by name, from memory, not measured) is to be confirmed by case 2.
- Leg 6 `[LAND:leg]` received.
  - **The full Docker suite ran**: 46 passed, 2 skipped and 1 failed, in 355 s. The failure was a test bug: the interface name `eth1` against `eth0`, not a security assertion. The fixed describe re-ran 5 of 5. **The other 44 cases passed in the full run, settling leg 5's owed full green run.**
  - **Deviation 1 confirmed** by case 2.
  - **The fifth trial**: without `-v` the volume case fails, and with it, it passes.
  - **Flight Director check**: containers 22 and networks 8, unchanged; no `mcpe-it` leftovers; volumes 248, two new anonymous ones:
    - one is the fifth trial's own, created on purpose;
    - one (`86292c7f…`, `com.docker.volume.anonymous`, created about 60 s into the run, before the new describe) is unidentified. It is most likely an older integration case removing a container whose image declares a volume with the suite's plain `rm -f` helper.
  - **Carried to the flight-end review**: the integration suite's removal helpers should use `-v` for containers, the test-side twin of the one-shot leak. Not fixed mid-leg, as an older suite's hygiene.
  - **The Docker suite time grew**: 293.8 s at leg 5's run, 355 s now. Noted for the debrief.
  - Legs completed: 6 of 12 autonomous.
- Leg 7 Developer spawned with the two-phase gate.
- **Leg 7 Docker gate (Flight Director).** Phase A:
  - 2353 passed and 53 skipped (+128, plus 4 gated cases); typecheck and build clean;
  - five trials each failed tests, and an extra trial proved the bypass test catches a new `start` path by name;
  - measured cost under `open`: at most one extra full inspect per 5 s per sandbox, for execs by reference. The hook itself makes no Docker call and no registry read under `open`.

  The Flight Director read the new describe (from `test/integration/docker.test.ts:2109`):
  - a random owner and the suite prefix;
  - checked removals;
  - `docker exec -d` and `stop` through `checkedForRemoval`;
  - its registry and lock files in an own `os.tmpdir()/mcpe-it-ct-<id>`, removed only after the location and basename checks.

  **Go-ahead given.**
- **Leg 7 deviations noted for legs 8–10 and the flight-end review**:
  - `setContainment(hook)` has no callback; `Docker` owns and invalidates its cache.
  - `contain` returns `{ ok, error }` rather than throwing.
  - The re-inspect after a startup wait happens only when something was registered and waited for. Leg 10 must register synchronously before serving, as resolution 9 requires.
  - **Under `open`, a contained sandbox gets the environment but is never repaired.** Fail closed: a dead proxy means no way out until a `contained` session repairs it. Consistent with "never loosen".
  - **A reference acquired while contained keeps its proxy environment after the sandbox is opened.** That is a harmless, broken setting on an open sandbox; leg 9 closes MCP servers on a network change.
  - The bypass test uses TypeScript 7's native parser API (`typescript/unstable/sync`), in `test/docker-bypass.test.ts`.
  - `ProjectRecord.hosts` is read through a cast until leg 9 adds the field.
- Leg 7 `[LAND:leg]` received.
  - **Full Docker suite**: 51 passed, 2 skipped, **0 failed**, in 358 s. The four new cases passed first time, with no assertion touched.
  - The overlap statuses in case 2 were not captured (`console.log` output absent from the run's file). They were never asserted; leg 8 or the HAT can observe them.
  - **Flight Director check**: containers 22 and networks 8, unchanged; no `mcpe-it` objects; no `mcpe-it-ct-*` directories; volumes 249 (+1).
  - **The +1 is the same test-side leak as at leg 6**: one anonymous volume, created about a minute into the run, before the new describe. Each full Docker-suite run now costs the operator one anonymous volume, through an older case's plain `rm -f` on a container whose image declares a volume. Carried to the flight-end review, where the helpers move to `-v`. Three full runs are still expected before then; accepted.
  - Legs completed: 7 of 12 autonomous.
- Leg 8 `contained-install` designed and tiered high-risk: the install path and every project's build under containment.
- **Design review 1**: approve with changes. It found:
  - the suite installs no npm project;
  - success-path refusals are unreadable, and Go's recipe soft-fails;
  - the installer is built before `Containment`;
  - the ecosystem override;
  - the write's timing and snapshot;
  - truncation;
  - the runtime-error mapping on start;
  - discovery's open sessions;
  - the scanner result type;
  - a seam for the refused-host case.

  It recommended a split; **kept as one leg in two stages** (unit, then gated measurement), its own alternative.
  - The npm fixture `piuccio/cowsay@eef317a302d025e3f31787566727c49eaee43648` was chosen by the Flight Director from `gh api`: a lockfile, a `prepare` script, and the `cowsay` binary.
- **Design review 2** (the last cycle): approve with changes.
  - It found that today's `finishInstall` would call `setNetwork("open")` on a contained sandbox (removing its proxy and putting it on `bridge`), and that a landed guard forbids the installer from calling `startForContainment`.
  - Settled: three explicit end-of-install branches with no `"open"` under containment; `Containment.contain(…, { start: true })`; one fixed refusal-read point; the seam through both `allowanceFor` sites; the contained-only pre-contain write.

  Leg 8 set to `ready`.
- **Leg 8 Docker gate (Flight Director).** Stage A:
  - 2430 passed and 59 skipped (+77, plus 6 gated); typecheck and build clean;
  - five trials each failed tests.

  The Flight Director read the leg-8 describe (`test/integration/docker.test.ts` from 2318):
  - an own owner and the suite prefix;
  - checked removals;
  - a temporary data dir removed after the location and basename checks;
  - an evidence file only under tmp with a `leg8-` name;
  - its own registry.

  It clones `tomnomnom/gron` and `piuccio/cowsay@eef317a`. **Go-ahead given.**
  - **Decision 4 (Flight Director)**: the build-throw path (`settleFailure`) also reads the proxy's refusals before `takeOffline`; `reconcileStale` does not (new process, proxy often gone).
  - **Process note**: the Developer made two shell no-op attempts against the Edit/Write-only rule; one was denied, and no file was written. It was restated.
- Leg 8 `[LAND:leg]` received.
  - **Full Docker suite**: 55 passed, 2 skipped, 2 failed, in 401 s. Both failures were test bugs: the describe's sweep left its own registry records. They were fixed in the sweep, with no assertion changed, and the leg-8 describe re-ran 6 of 6 (about 25 min). **A full green run after that fix is owed at the flight-end review.**
  - **Flight Director check**: containers 22 and networks 8, unchanged; no `mcpe-it` objects or `mcpe-it-c8-*` directories; volumes 250 (+1, the known test-side leak).
  - **Evidence**:
    - `gron` and `cowsay` installed contained with **zero refusal rows**, so **DD5's table needs no change for Go and npm** (`DEFAULT_HOSTS_VERSION` stays 1);
    - `gron` with `network: true` stayed contained: `proxy.golang.org` 200, `github.com` 403;
    - create, contain, then start observed as `open`, then `contained`, then running contained;
    - in the build image, Node v26.13.1 and npm 11.20.0. `fetch` worked through the proxy with `NODE_USE_ENV_PROXY`, and failed closed without it (`EAI_AGAIN`).
  - **Finding for the debrief and HAT: a refused package registry makes npm retry tightly.** There were 3,155,582 refused CONNECTs in about 11 minutes, so the install ends only at its `timeoutSec` (600 s, 648 s in all), with the correct message naming `registry.npmjs.org:443` and the hint. That is correct but slow. A later improvement could have the proxy back off on a repeated refusal, or have the installer stop a build early once refusals pass a threshold. Not in this flight's scope; noted.
  - Legs completed: 8 of 12 autonomous.
- Leg 9 `network-tools` designed and tiered high-risk: record integrity across about 15 writers, new tools, a security-relevant message.
- **Design review 1**: approve with changes. **Security finding: refusal hints were an injection channel.**
  - A refused host is chosen by the project's own code. Leg 8's imperative "reinstall with `hosts: [...]`", and the planned "`set_project_hosts(add: [...])`", would hand the agent a ready-made instruction to allowlist a host a hostile project probed for on purpose. Backticks do not stop that.
  - Settled: every `not-allowed` hint becomes advisory ("the project's own code asked for this host; allow it only if you expect…"). That includes leg 8's build wording, whose tests move.
  - Other findings:
    - the "never loosen" check was a check-then-act race, now atomic under the project lock (`openUnlessContained`);
    - an incomplete writer list, now `putKeeping(record, ["hosts"|"network"])`, never resurrecting a deleted record;
    - `set_project_network` branch gaps;
    - `describe()` shared by six tools, now an optional Docker view;
    - unbounded refusal reads on failures, now rate-limited and including MCP-proxied tools;
    - the local-access key built through `parseRepoRef`, with a Desktop measurement first.
  - **No second review**: the resolutions are the reviewer's own fixes, and the flight-end Reviewer reads the code. Leg 9 set to `ready`.
- **Leg 9 Docker gate (Flight Director).** Stage A: 2537 passed and 63 skipped (+106, plus 4 gated); typecheck and build clean; four trials each failed tests.
  - The Flight Director read the leg-9 describe (from `test/integration/docker.test.ts:2569`):
    - names pass `checkedForRemoval` before `run`;
    - a random owner;
    - checked sweeps;
    - its own temp data dir;
    - `App` instances on the describe's own installation id.

    **Go-ahead given.** The echo service briefly publishes a random host port; accepted.
  - **Deviations accepted**:
    - clone and scanner refusal lines carry no allow instruction, since the agent cannot allow those;
    - `set_project_network` writes `network` onto the file's record;
    - a contained-session `true` makes no `acquire` (no start on `bridge`), so a runtime mismatch there ends with the sandbox on no network;
    - `proxyDiffers`;
    - `closeProject` only on a real replace.
- Leg 9 `[LAND:leg]` received.
  - **Desktop measurement**: inside a `host-gateway` container, `host.docker.internal` is `192.168.65.254` and `fdc4:f303:9324::254`, and a connect to a published port echoed. **Local access works on Docker Desktop**, so the case was not skipped.
  - **Full Docker suite**: 61 passed, 2 skipped, **0 failed**. Local access end to end: the entitled sandbox reached the echo service, the other repository's did not, and a CONNECT through `mcpe-proxy` was 403. **Leg 8's owed full green run is settled.**
  - **Flight Director check**: containers 22 and networks 8, unchanged; no leftovers; volumes 251 (+1, the known test-side leak).
  - **The Docker suite took 1067 s**, against about 280 s before this flight. Most of the growth is leg 8's refused-registry case, which waits out npm's tight retries to the 600 s `timeoutSec`. **Carried to the flight-end review**: lower that case's `timeoutSec` (for example to 90 s). It still fails with the same refusal line and hint, and saves about 9 minutes per run. Also for the debrief: the suite's time.
  - Legs completed: 9 of 12 autonomous.
- Leg 10 `startup-containment` designed and tiered high-risk.
- **Design review 1: needs rework.** Findings:
  - the gate fallback held handled keys and leaked unreached ones after the pass;
  - the pass could not take the private, non-re-entrant project lock without deadlocking;
  - a rejected global gate had no clearing mechanism;
  - orphan and stopped-proxy cleanup could hit live objects;
  - no sandbox listing primitive;
  - `replace` used where repair (re-attach) is needed, and `contain` used on already-contained sandboxes;
  - name ≠ `record.container`;
  - statuses;
  - the gate promise's rejection;
  - warnings piling up.
- **Rework (Flight Director)**:
  - the housekeeping (orphans, stopped-sandbox proxies, lock files) moves out to **squawk 0052**, deferred: cleanup, not containment;
  - every listed key is registered up front;
  - handled and cleared sets;
  - one locked `Containment.startupStep` with a fresh re-read and a pure `startupAction` table;
  - `listOwnSandboxes`;
  - deduplicated warnings.

  Second review running.
- **Leg 10 design review 2** (the last cycle): approve with changes. Settled:
  - the internals `containLocked` (with `contain` refactored onto it), `takeOffLocked`, and `repairLocked` with `compareSession`;
  - one deferred per key, settled only by the record-matching sandbox's step (a twin cannot overwrite it);
  - the gate as its own deferred, resolved after up-front registration, with `waitFor` re-looping;
  - a gate rejection distinguishable (`gate: true`) and handled in the hook with a fresh inspect;
  - "handled OK" dropped (the gate rejects only if the listing fails);
  - the image ensured once per pass outside any lock;
  - non-throwing peeks;
  - an unmanaged extra network rejected;
  - the bound stopping unstarted steps.

  Leg 10 set to `ready`; its Developer spawned with the two-stage gate.
- **A second standing gap**: a labelled sandbox with no record stays uncontained under `contained`, alongside the pre-ownership one. Both go in leg 11's README.
- Leg 11 `status-and-docs` designed and tiered **low-risk**: additive text in established places plus the agreement test. No separate design review; the flight-end Reviewer reads it. Its implementation waits for leg 10, since both edit `src/server.ts`.
- **Leg 10 Docker gate (Flight Director).** Stage A: 2609 passed and 66 skipped (+72, plus 3 gated); typecheck and build clean; four trials each failed tests. Two list entries changed (`listOwnSandboxes`).
  - The Flight Director read the leg-10 describe (from `test/integration/docker.test.ts:2786`). Each `App` runs on a `Docker` with the describe's random installation id, so the pass lists only its own sandboxes and never the operator's (`mcpe-bde0aedf-*`, owner `bde0aedf`). Removals are checked, and it has its own temp data dir. **Go-ahead given.** The operator's 22 container names were listed before the run.
  - Deviations 1–9 accepted, notably:
    - warnings keep `hosts` and `network`;
    - the gate is registered inside the pass's synchronous start;
    - a foreign network with the record off is taken off with a warning;
    - the image ensure is skipped for `installing` peeks (a narrow race, fail-closed).
  - **Process, recurring**: a third Developer started empty shell heredocs against the Edit/Write-only rule (one denied by the permission classifier, none wrote anything). The rule as stated in prompts is not sticking. The permission classifier is the guard that actually held. For the debrief.
- Leg 10 `[LAND:leg]` received.
  - The leg-10 describe gave 3 of 3. **The full Docker suite gave 64 passed, 2 skipped, 0 failed, in 1081 s.**
  - **Flight Director check**: containers 22 and networks 8, unchanged; no leftovers; volumes 252 (+1, the known test-side leak); unit suite 2609 passed and 66 skipped.
  - Legs completed: 10 of 12 autonomous.
- Leg 11 Developer spawned (no Docker gate needed).
- Leg 11 `[LAND:leg]` received: 2620 passed and 66 skipped; typecheck and build clean; two trials failed tests. The README claims are traced to sources in the leg's entry.
- **Leg 11's README/code disagreements, settled by the Flight Director**:
  1. **A defect, to fix at the flight-end review**: `Containment.buildConfig` carries `MCPE_LOCAL_ACCESS` forwards in the **build** phase too. DD10 says local access applies to the sandbox with its network on, not to builds. The fix is to add forwards (and their aliases) only in the run phase, with a unit case. Until then a project's install scripts can reach the local service the operator allowed for that repository.
  2. The `RuntimeMismatchError` wording differs from DD11's text; the README quotes the code. Accepted.
  3. **Not built, so not claimed**: DD11's "project_info shows a mismatch, and the security paragraph counts such projects"; DD3's "security paragraph says Docker cannot provide containment" (that state is known only at runtime; it is logged and refused per operation). Recorded as deviations for the debrief.
  4. DD2 and DD8 in `flight.md` are annotated in their headers ("In flight, 2026-11-23"): the housekeeping moved to squawk 0052, and the binding table is leg 10's.
  5. **Trivy's hosts were never measured** (no real Trivy run this flight). The README's example has no `hosts` and says so. **The HAT should measure them with a real Trivy under containment.**
  6. That services bound only to `127.0.0.1` are unreachable through `host-gateway` on native Linux is **not measured**; the README says so.
- Legs completed: 11 of 12 autonomous. Leg 12 is running in parallel and touches no leg-11 file.
- **Leg 12 Docker gate (Flight Director).**
  - The workflow's `gvisor` job is written, with test steps gated on `proxy.cjs` existing, so a push before the flight commit runs only the setup half.
  - gVisor is pinned to release **20260817**, read by the Developer with `curl` against the release bucket; no newer dated release answered. The SHA-512 is in the workflow, and the job fails on a mismatch.
  - `test/integration/gvisor.test.ts` has three cases, enabled only under `runsc`. They cannot run locally (no `runsc` here) and are unverified until CI.
  - **Go-ahead given only** for the two local runs: leg 8's shortened case alone, and the new file, which must report itself skipped. No full suite.
  - Deviations 1–6 accepted. Notably, nothing is skipped under gVisor until the first CI run shows what fails.
- Leg 12 `[LAND:leg]` received.
  - Locally: leg 8's shortened refused-host case passed in 100 s; `gvisor.test.ts` reported itself skipped and created nothing.
  - Docker lists unchanged, with **no new volume**.
  - Unit suite: 2620 passed, 69 skipped.
  - **All 12 autonomous legs have landed.**
- The Flight Director read the workflow's `gvisor` job (permissions read-only, actions pinned, downloads checked against the pin and the published checksum, no secrets, test steps gated on `proxy.cjs`). It committed **only** `.github/workflows/docker-gvisor.yml` as `ccbfafd` and pushed. That run should exercise the setup half only.
- **gVisor setup on GitHub's runner** (run 45140517280, commit `ccbfafd`, read by the Flight Director with `gh run view --log`), on runner image Ubuntu 26.04.1 LTS:
  - the `gvisor` job's setup half passed: download; `runsc: OK` against the pinned and published SHA-512 (release 20260817); `runsc install`; Docker restart; `runsc` listed in `docker info`;
  - the smoke test's `dmesg` under `--runtime runsc` began `[ 0.000000] Starting gVisor...`;
  - the test steps were skipped as designed (no `proxy.cjs` in the committed tree);
  - the `measure` job passed again.

  **The gVisor installation premise of DD13 holds.** Runs A and B come with the flight commit.
- **Flight-end review: `[HANDOFF:confirmed]`, no blocking issues.**
  - Unit suite 2620 passed, 69 skipped; typecheck clean.
  - Hook coverage, the bridge-start refusal, MCP launch environment and sandbox-text whitelisting verified by reading.
  - **27 mutation trials**; 24 killed, across:
    - the proxy: refused ranges, permit rule, wildcard, single-use guard, own-address and own-subnet, authority, IPv6 embeddings, matching, hop-by-hop, scheme, no-address;
    - the gate and never-loosen;
    - `putKeeping`;
    - each hooked path;
    - the bridge-start refusal;
    - locks;
    - observe-only.
  - **3 survived**, all defence in depth: the proxy's printable-ASCII and second-colon checks (redundant with later parsers), the upstream-`upgrade` and status-range guards, and `contain`'s `offDone` (no call count).
  - Both carried items were confirmed.
  - **New non-blocking findings**:
    - `withProjectLock`'s deadline releases the lock while `fn` may still run;
    - stale-lock takeover by two waiters could delete a fresh lock;
    - `set_project_network` off outside the lock (safe; ends off either way; accepted);
    - Docker error text in startup warnings (bounded, not sandbox-controlled; accepted).
- **Fix pass (Flight Director's selection)**:
  - build-phase forwards to run-only, with the session label consistent;
  - `-v` on every integration-suite container removal;
  - the lock released only after `fn` settles;
  - stale takeover by token-checked rename;
  - an `offDone` call-count test;
  - an upstream-101 test, or a documented defence-in-depth comment.

  A Developer was spawned with the go-ahead for one full Docker-suite run, which must leave no new anonymous volume.
- **Fix pass reported** (`[HANDOFF:review-needed]`): all six items done, and a **second fix** for `rmContainer`, which now uses `rm -f -v`. The leak was product-side as well: uninstall and rebuild removed sandbox containers without `-v`.
  - The full Docker suite ran twice: 64 passed, 5 skipped, about 10 min each.
  - **The second run left no new volume.** The first had left one (`c7c2619…`, created during the run, before the `rmContainer` fix), left for the operator.
  - Unit suite: 2626 passed, 69 skipped.
- **Re-review of the fix pass: `[HANDOFF:confirmed]`.** Each fix's weakening failed a test.
  - The two remaining edges fail closed: a never-settling `fn` holds its in-process mutex (busy errors after 60 s), and a crash between a stale-lock rename and its cleanup leaves an orphan `*.stale-*` file.
  - That file was added to squawk 0052.
  - Non-blocking: only the direct `removeIfStale` test exercises the takeover guard.
- All 12 autonomous legs set to `completed`. The single flight commit (Developer, per the crew file) follows, then the push. The full gVisor run comes on that commit.
- **Anonymous volumes this flight left on the operator's daemon** (none removed by the flight):
  - one per full Docker-suite run, from legs 5–10's runs and the first fix run, before the `-v` fixes;
  - leg 6's deliberate fifth-trial volume.

  They are listed in each leg's entry with their ids (`36748c78…`, `86292c7f…`, `48f962bb…`, `410f3978…`, `2b5accce…`, `c750398d…`, `c7c26191…`, plus leg 5's two). The operator decides whether to remove them; anonymous volumes cannot be attributed by name.
- **Flight commit `070486a`** (Developer, per the crew file): 59 files, +21,012 / −281.
  - The Flight Director checked it: no `dist/`, no secrets or local settings, the working tree clean, the trailers present.
  - Pushed. That starts the first full `gvisor` run (Runs A and B) and `ci.yml` on draft PR #30.
- **The HAT leg (13) is designed.** It is interactive: guided step by step, with no Developer spawn and no design review. Trivy's hosts are measured inside it, because a networked scanner without `hosts` is a startup error under containment.
- **First full `gvisor` run on `070486a`** (run 45146029960): `ci.yml` green, `measure` green, gVisor setup green.
  - **Run A: 43 passed, 21 failed, 2 skipped (487 s). Run B: 2 passed, 1 failed.**
  - **The main finding: containment and gVisor do not work together as built.** Every contained case failed to resolve the alias `mcpe-proxy`: "Could not resolve proxy: mcpe-proxy (Could not contact DNS servers)" from `git`, and `EAI_AGAIN` from probers. Docker's embedded DNS (`127.0.0.11`) is reached through NAT rules that gVisor's network stack does not honor. Local-access aliases depend on the same server.
  - **Passing under gVisor**: the uncontained installs and most of the older suite; Run B's missing-runtime refusal and the runc-sandbox refusal.
  - **Other failures**: `/sys/class/net` empty under gVisor (idle-timeout and primitives cases), an offline Go CLI timing out instead of failing fast, and two still unexplained.
  - **Also exposed**: CI ran containment only under runsc, so **containment under runc on native Linux is still unproven** (Desktop proved runc).
- **The operator's decision (2026-11-23): fix it in this flight.** A new leg 13, `proxy-by-address`: contained containers reach the proxy at a fixed IP (the last usable address of their network), local-access names come from the sandbox's `/etc/hosts`, gVisor-specific named skips, and a native-Linux runc containment run (Run C). The HAT becomes leg 14.
- **T16** (Flight Director trial, Docker Desktop 29.8.2, throwaway objects, removed): `docker network connect --ip <last usable address>` works on an internal, isolated network **with Docker's automatic subnet**. The proxy took `172.22.255.254`, and a container started afterwards got `172.22.0.1` from the low end. An explicit `--subnet` with `--ip-range` also works. Native Linux is to be confirmed in CI.
- **Leg 13 design review: needs rework.** Reworked by the Flight Director as binding resolutions:
  - probe-then-pin subnets with `--ip-range`, so the proxy's last address is outside IPAM;
  - `/etc/hosts` written by a post-start step (`afterStart`), not the pre-start hook, as one in-place write;
  - replacement rollback by stop, `connect --ip`, start, with removal of the new proxy first;
  - a subnet cache, and attachment checked by `IPAMConfig`;
  - `/proc/net/dev` unconditionally;
  - Run C as its own job, `contained-linux`, with a minimum-case-count check;
  - test fixes for the pre-ownership and T14 cases.

  No second review: the reviewer's own fixes, with CI and the flight-end re-review as the checks.
- **Product finding under gVisor: build output is lost on an idle stop.**
  - The review read Run A's "stops an idle sandbox, keeps its files" failure. gVisor's default root overlay (`--overlay2=root:self`) discards writes outside volumes when the sandbox exits, and mcp-everything's build output (`/opt/mcpe` etc.) lives in the container layer until flight 3 moves it.
  - **Decision**:
    - CI registers `runsc install -- --overlay2=none`;
    - the README requires that registration;
    - `assertRuntime` logs a startup warning when `runsc`'s `runtimeArgs` lack it.
  - This must reach the mission debrief: a stronger runtime has a cost the mission had not named.
- **Leg 13 Docker gate (Flight Director).**
  - Stage A: 2728 passed, 71 skipped; typecheck and build clean.
  - Three trials failed tests.
  - No `--alias` and no `mcpe-proxy` remain in the sources.
  - The integration diff was read: the new raw calls are inspects, a start and an exec on the suite's own prefixed objects, and removals are only through the checked helpers. **Go-ahead given.**
  - Deviations 1–6 accepted, notably:
    - the sandbox's hostname is `sandbox`, not its short id;
    - the facts gained `networkIds`;
    - an extra best-effort exec on off and open to clear the hosts lines;
    - the `contained-linux` minimum count (31) may need correcting after the first run.
- Leg 13 `[LAND:leg]` received.
  - **The full local Docker suite gave 66 passed, 5 skipped, 651 s.** The two new leg-13 cases passed.
  - The Docker lists, including volumes, are identical before and after, and there are no temp leftovers.
  - **The Reviewer was spawned over `git diff HEAD`** (leg 13 only) before the fix commit.
- **Leg 13 review: `[HANDOFF:confirmed]`, no blocking issues.**
  - 13 mutation trials; 12 were caught: name, own-name and address validation of the hosts writer, idempotence, `proxyAddress`, no-alias, detach, restore, `--ip-range`, probe removal, each of the four `afterStart` sites, the subnet cache.
  - **Not caught**: removing `assertLive` between detach and create. **Accepted as a follow-up**: a unit case with a lock lost after detach.
  - **Non-blocking, accepted**:
    - `writeLocalAccess` is all-or-nothing on an invalid name (logged, never thrown; config parsing already restricts names);
    - the probe network is briefly visible. The sweep's age floor keeps it from being taken mid-probe; an unreadable attempt retries.
    - after a lock takeover the old proxy is deliberately not restored.
  - Leg 13 set to `completed`; the fix commit follows.
- **Fix commit `3872c1a`** pushed (15 files, +2,293 / −234).
- **Second full `gvisor` run** (45192885567):
  - **`contained-linux` (runc, native Linux): 31 of 31 passed. Containment is proven on native Linux.**
  - **Run A: 57 passed, 9 failed** (was 21), in 719 s.
  - **Run B: 2 passed, 1 failed.**
  - Fixed by leg 13: embedded DNS (all contained installs, clones and one-shots now work under gVisor) and the overlay finding (the "keeps its files" test passes with `--overlay2=none`).
  - **Remaining**:
    - 7× `EHOSTUNREACH`, sandbox to proxy, all where the network changes while the sandbox runs. The diagnosis: a hot-plugged NIC is unseen by gVisor, and the neighbor cache is stale after a proxy swap.
    - T14's cause: runsc cannot clean up a failed start ("stale containerd task object").
    - Run B: a test bug (`--format {{.ID}}` on events).
- **T17** (Flight Director trial, Docker Desktop, throwaway objects, removed): creating the proxy with `--network name=<net>,ip=<addr>,mac-address=<mac>`, then `connect bridge`, gives the same IP **and the same MAC** across two successive proxies. `docker create` cannot take `bridge` and a user network together, and `network connect` has no MAC option.
- **Leg 14 `gvisor-network-changes`** (the HAT becomes 15):
  - a fixed proxy MAC per network;
  - stop–attach–start for containing a running sandbox under a non-runc runtime;
  - a named restart-after-swap fallback, off until CI decides;
  - T14 skipped under runsc with its cause;
  - the events-format fix;
  - leg 13's follow-up test.

  It is tiered high, but there is no separate design review: the work is narrow, it rests on measured premises, and CI plus a diff review are the checks.
- **Leg 14 Docker gate (Flight Director).**
  - Stage A: 2746 passed, 71 skipped; typecheck and build clean; four trials failed tests. The changed Docker cases only add MAC assertions, a runsc skip and the events-format fix (no new objects).
  - **T18** (Flight Director trial, Docker Desktop, throwaway objects, removed): after `network disconnect` and `network connect --ip X`, a proxy keeps its IP but gets a **new random MAC**; `--driver-opt com.docker.network.endpoint.macaddress=…` does not help. So a failed replacement's rollback loses the fixed MAC.
  - **Fix**: the rollback restarts a running non-runc sandbox after the restore. This is a rare path.
  - The go-ahead for Stage B was given with that fix.
- Leg 14 `[LAND:leg]` received.
  - The local full Docker suite gave 65 passed, 1 failed and 5 skipped. The failure was the one-shot proxy's `NetworkMode` pin, a consequence of creating it on its own network. The assertion now requires that network plus exactly `bridge`, still never host. The case re-ran green.
  - Docker lists unchanged, with no new volume.
  - Unit suite: 2751 passed, 71 skipped.
- **Leg 14 review: `[HANDOFF:confirmed]`, no blocking issues.**
  - 9 mutations; 8 were caught. **Not caught**: a failed `docker stop` in `whileStopped` (no test pins "stop fails, so nothing changes"). The code throws correctly.
  - **Follow-ups (non-blocking)**: a unit test for a failed stop, and splitting a double statement in `test/docker-bypass.test.ts:282`.
  - Leg 14 set to `completed`; committed and pushed for the third `gvisor` round.
- **A stalled shell, found by the operator.**
  - A Developer's background wait loop, `while pgrep -f 'vitest run test/integration' …; do sleep 15; done`, had run for 7 h 46 min (since about leg 9's Docker run).
  - It could never end, because `pgrep -f` matched the loop's own command line, which contains the pattern. It kept that agent's task "waiting on its own background work".
  - Stopped by the Flight Director (`kill 3041064`). No other loops of that form remain.
  - **For the debrief**: a wait loop on `pgrep -f` must exclude itself (`pgrep -f '[v]itest …'`), or wait on a PID. Background waits by crew should have a bound.
- **Phase 2d: the flight-end Reviewer is spawned** over `git diff main` plus the untracked files. Two items are carried to it: the build-phase local-access forwards (leg 11's finding), and the test helpers' `rm -f` without `-v`. The Reviewer is told not to run the Docker suite; the Flight Director runs the final full Docker suite after the fixes.
- **Standing gap recorded**: sandboxes from before ownership (no project label) are not listed and stay uncontained under `contained`. Leg 11's README states it: "reinstall to contain".
- **DD5 "measured" is narrowed**: Go and npm are measured in leg 8. The Debian `need`/`apt-get`, Python, Rust, Ruby and CMake/autotools rows, and `pnpm`/`yarn`, stay unmeasured. Leg 11's README must not claim otherwise.
- Leg 4 `linux-measurements` `[LAND:leg]` received. The Flight Director read the workflow in full before publishing it:
  - read-only permissions;
  - no actions;
  - the digest-pinned probe image only;
  - every object named `mcpe-measure-<run>-…` and cleaned up by traps;
  - nothing secret.

  `actionlint` was not available, so the push is the validity check. Committed **only** `.github/workflows/docker-gvisor.yml` as `0a2e39f`, pushed `flight/02-contained-network-and-runtime`, and opened **draft PR #30** (operator's agreement, 2026-11-22). The rest of the flight's work stays uncommitted. Legs completed: 3 of 11 autonomous.

### Native Linux measurements (run 45110822193, `ubuntu-latest`, 2026-11-23)
Read by the Flight Director from `gh run view --log`. The job passed, and both workflows (CI and these measurements) ran on the PR. The run took 27 s.
- **Docker**: Engine 29.4.2 (Community), runtimes `runc` and `io.containerd.runc.v2`. **No gVisor** on the stock runner, as expected; leg 10 installs it.
- **DD3 holds on native Linux.**
  - `--internal -o gateway_mode_ipv4=isolated --ipv6=false` gives `Internal=true EnableIPv6=false`, `IPAM.Config=[{"Subnet":"172.18.0.0/16"}]` and **no `Gateway`**.
  - `inhibit_ipv4=true` gives the same (no `Gateway`).
  - Tested versions so far: 29.4.2 (runner) and 29.8.2 (operator's Docker Desktop). The minimum version is still unmeasured, and the error message stays version-free (leg 5).
- **No route to the host from an isolated network.** From a container on it, `172.17.0.1` (the host, through `host.docker.internal` and through the docker0 address) gives `Network unreachable`. The positive control, a container on `bridge`, reaches the host's `0.0.0.0:18080` listener through both.
- **`host-gateway` on native Linux is `172.17.0.1`, inside `bridge`'s `172.17.0.0/16`.** Leg 3's decision 5 (the name-scoped `/etc/hosts` exemption into `ownCidrs` for a `host.docker.internal` forward) is therefore required on native Linux, and correct. A proxy on `bridge` forwarding to `172.17.0.1` reaches host services listening on all addresses.
- **Resolver.** The runner's `/etc/resolv.conf` is systemd-resolved's stub (`nameserver 127.0.0.53`). A `bridge` container gets `nameserver 168.63.129.16` (Docker substitutes the uplink, from `/run/systemd/resolve/resolv.conf`), which resolves `github.com`. So T13b's approach (read a `bridge` container's resolv.conf) works on native Linux too. Split-DNS caveat confirmed: containers see the uplink, not the stub.
  - Note: `168.63.129.16` is Azure's platform address, which leg 3 lists as a residual route. Here it is only the DNS server the proxy queries, never a connect target the proxy allows.
- **Two-holder alias**, from a third container with `getent`:
  - ten lookups with both up: `.2 .2 .1 .1 .1 .1 .1 .1 .2 .2`;
  - after `docker restart` of one holder: `.2 .2 .2 .2 .1 .2 .1 .1 .2 .2`.

  The order is random and both holders get traffic. **DD2's overlap statement is confirmed**: during a replacement, a tightening takes effect only when the old proxy is removed.
- **Cleanup**: nothing named `mcpe-measure-<run>-*` remained.
- Leg 4 designed and tiered **high-risk** (new Docker objects, the sweep, a first CI job running Docker). Its design review runs alongside leg 3's implementation.
- **The draft pull request at leg 4 carries only the measurement workflow file** (plain `docker` and shell, no project code). The flight's code therefore stays uncommitted until the flight-end review and single commit, as the method has it. The operator's agreement (2026-11-22) covered pushing the branch and opening a draft PR at leg 4. Committing only the workflow is the narrowest way to do that.

### Leg 3 design decisions (Flight Director)
**Context**: Leg 3's first review asked five questions.
**Decision**:
1. Plain HTTP is GET and HEAD only.
2. Test hooks are kept out of the shipped program; tests inject `deps` by appending JavaScript.
3. An uncaught exception fails closed: exit code 70, restarted by leg 5's repair.
4. `Via` and `X-Forwarded-*` are stripped, and none are added.
5. On native Linux, a forward may reach exactly the `/etc/hosts` addresses of `host.docker.internal`, even inside the proxy's own subnets, never loopback or link-local; leg 4 measures it.

**Impact**: Leg 9's README states the GET/HEAD limit and the residual routes (DNS-label exfiltration through wildcards; Azure's `168.63.129.16`).
