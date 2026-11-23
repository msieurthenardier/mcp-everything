# Leg: contained-install

**Status**: completed
**Flight**: [Contained Network and Isolation Runtime](../flight.md)

## Objective
With `MCPE_NETWORK=contained`, route the whole install path through containment:
- the clone, through a one-shot proxy that allows only its forge;
- the operator's networked scanners, through one allowing their `hosts`;
- the build, in a sandbox created on `bridge` and contained before its first start, with the build allowlist;
- the end of the install: the run allowlist, or offline.

Failures that a proxy refused say which host and how to allow it. The default host table is measured against real installs and corrected. With `MCPE_NETWORK=open` nothing changes.

## Context
- **Flight decisions.**
  - **DD5**: the clone reaches its forge only, the build reaches the table plus `hosts`, and the clients get the environment variables.
  - **DD6**: the sandbox's run hosts.
  - **DD7**: the contained install's order and failure paths.
  - **DD9**: refusal messages.
  - **DD10**: forges named in `MCPE_EXTRA_HOSTS` may be local for clones.
  - **DD12**: scanners with `hosts`.
- **Legs 5–7** (landed):
  - **Leg 5** gives `runOnce({ egress })` and `OneShotResult.proxy`.
  - **Leg 6** gives:
    - `setNetwork(mode)` (`"off"` removes the proxy and `-net`);
    - `ensureProjectNetwork`;
    - `projectProxyStatus`, `listProjectProxies`;
    - `startForContainment` (leg 7);
    - `SandboxRef.env`.
  - **Leg 7** gives:
    - `Containment`, whose `contain(…)` returns `{ ok, error }`;
    - `replace`, with the phase derived from `record.status`;
    - the hook (the environment for execs, and repair);
    - the version and lock rules.
- **T15**: a contained sandbox is **created on `bridge`, not started, moved to its `-net`, then started**. A container created with `--network <-net>` can never start once that network is gone.
- **The registry ordering trap** (found at this leg's design):
  - `Containment` builds the configuration from the record **in the registry** (fresh read).
  - `finishInstall` (`src/install/installer.ts`) sets `record.ecosystems` in memory **after** `openInstall` wrote the `installing` record.
  - So the record must be written with its detected ecosystems (still `installing`) **before** the sandbox is contained. Otherwise the build gets only the every-build row.
- **Discovery's network** (today's behavior kept):
  - `finishInstall` today sets the network before `discover`, so discovery runs offline unless `network: true`.
  - Contained: with `network: false`, `setNetwork("off")` happens before `discover`, as today.
  - With `network: true`, discovery runs under the build allowlist (leg 7 resolution 4), and the run allowlist applies after `put(ready)`.
- **Callers today**:
  - `probe` (clone, `network: "bridge"`), called from `install` (line ~269) and `checkClone` (~291);
  - `runScanners` → `docker.runScanner(volume, spec, …)` (`src/scan/run.ts`, `network: spec.network ? "bridge" : "none"`);
  - `copyVolume` (`network: "none"`, unchanged);
  - `createContainer` (`docker run -d`, which starts at once), called from `buildAttempts` (~625);
  - `finishInstall`'s `setNetwork` (~539) and `takeOffline` (~785).
- **Installer and `Containment`.** The installer is constructed after `Containment` in `App` (`src/server.ts`). It receives it as an optional constructor argument; absent in unit tests means today's path.

## Inputs
- `src/install/installer.ts`: `install`, `installChecked`, `check`, `checkClone`, `openInstall`, `finishInstall`, `buildAttempts`, `takeOffline`, `settleFailure`.
- `src/sandbox/docker.ts`: `probe`, `runScanner`, `createContainer`, `runOnce({ egress })`, `startForContainment`, `setNetwork`, `projectProxyStatus`.
- `src/scan/run.ts`; `src/network/containment.ts`; `src/network/defaults.ts`; `src/config.ts` (`hosts`, `network`).
- `test/installer.test.ts`, `test/docker.test.ts`, `test/scan-run.test.ts`, `test/integration/docker.test.ts` (the existing install fixtures: `tomnomnom/gron` and the npm project the suite already installs).

## Outputs
- `src/install/installer.ts`, `src/sandbox/docker.ts`, `src/scan/run.ts`, `src/server.ts` (passes `Containment` to the installer), `src/network/defaults.ts` (the measured table, with a version bump if it changes), and a small `src/network/refusals.ts` (new) that turns proxy refusal rows into messages.
- Tests: unit and Docker-gated.

## Acceptance Criteria

**With `MCPE_NETWORK=open`, the install path issues exactly today's Docker calls.** Every existing installer and Docker case passes unchanged.

**Clone** (`probe`):
- [ ] **When contained**, `probe` runs the clone through `runOnce({ egress: { allow: cloneHosts(repo) } })` instead of `network: "bridge"`.
  - `local: true` only when `repo.host` comes from `MCPE_EXTRA_HOSTS` (DD10: self-hosted forges may be local).
  - Everything else about the clone (the script, the walk, the caps) is unchanged.
- [ ] **A failed contained clone with refusal rows** appends one line per refused host to the clone error, with a fixed message. A submodule on another forge reads: "The clone was refused `<host>`: submodules on other forges are not reachable under containment."
- [ ] **A failure in which the proxy did not start** keeps `ProxyStartError`'s message, never a refusal.

**Scanners** (`runScanner`):
- [ ] **When contained and `spec.network`**, the scanner runs with `egress: { allow: spec.hosts parsed in scanner mode, local: true }`.
  - When not `spec.network`: `"none"`, as today.
  - When open: today's `"bridge"` or `"none"`.
  - Leg 1 already refuses a networked scanner without `hosts` under containment at startup.
- [ ] **A scanner failure** keeps flight 1's "failed check, never blocks". When the proxy refused hosts, the cleaned rows are added to the failure's bounded `error` text.

**Sandbox creation and the build** (T15, DD7):
- [ ] **`createContainer` gains `start?: boolean`** (default `true`, today's `docker run -d`).
  - With `start: false` it uses `docker create` with the same arguments, then verifies the id. It never uses `--network` other than `bridge`.
- [ ] **When contained, the sequence is**:
  1. after detection, **write the record** (still `installing`) with its detected ecosystems, primary and image, through the merging writer (leg 9 makes this the shared helper; here, a `registry.update` that keeps `hosts` from the file);
  2. `createContainer({ …, start: false })`;
  3. `containment.contain(…)`. If `{ ok: false }`, the install fails with that error, and the sandbox is left on **no network** (leg 7 guarantees it);
  4. `startForContainment(name)`;
  5. the build `exec`s get the proxy environment through the hook (`record.status === "installing"`, so build hosts).
  - The second attempt (new image) repeats steps 2–4. `removeContainer` keeps the proxy and `-net` (leg 6), so `contain` adopts them.
- [ ] **After a successful build:**
  - with `network: false`: `setNetwork("off")` before `discover`, as today; the proxy and `-net` go;
  - with `network: true`: `discover` under the build allowlist, then `put(ready)`, then `containment.replace(…)` (the record now says run: DD6's sandbox hosts plus `hosts`), then invalidate the hook cache.
  - A failed `replace` there leaves the project `ready`, offline (`setNetwork("off")`), with a warning naming the error; never on `bridge`.
- [ ] **Failure paths** (a failed build, a timeout, `settleFailure`, an interrupted install):
  - before the network is taken off, `projectProxyStatus` of the project's proxy is read (3 s, capped; leg 5's parser);
  - then `takeOffline` with `"off"` removes the proxy and `-net`.
- [ ] **`check_project`** (`Installer.check`) under containment clones and scans the same way, and builds nothing.

**Refusal messages** (DD9; `src/network/refusals.ts`):
- [ ] **`refusalLines(rows, context)`** turns rows into at most 10 lines, one per `(host, port)`. The rest are counted ("and N more").
  - `not-allowed` during a build: "The build was refused `<host>:<port>`. To allow it, reinstall with `hosts: ["<host>"]`." The `hosts` parameter lands in leg 9.
  - `refused-address`: "`<host>` resolves to a local address; builds cannot reach local addresses under containment."
  - `no-address`, `resolve-failed`, `connect-failed` and `timeout`: "The build could not reach `<host>` (<reason>)."
  - Hosts are already cleaned (leg 5); they are quoted with backticks and never interpolated unquoted.
- [ ] **A failed install's `error` and `errorLog`** carry these lines after the existing text. `project_info` shows them through the record.

**The default table, measured** (DD5):
- [ ] **Docker-gated, contained, with `MCPE_SCAN=off`**: installs of `tomnomnom/gron` (Go) and of the npm project the suite already installs both succeed.
  - The proxy's refusal rows during each build are recorded in the flight log, whether the install succeeded or not.
  - Any host a recipe needed that the table lacked is added to `src/network/defaults.ts`, with `DEFAULT_HOSTS_VERSION` bumped and the pinned hash test updated. The table change and its evidence go in the flight log.
- [ ] **The clients**: during the npm build, record whether npm used the proxy (its refusals, or the proxy's connect rows). Record the image's Node version, and whether `NODE_USE_ENV_PROXY` applied.
- [ ] **A refused build host**: a contained install of the same npm project with a `hosts`-less record, where the table entry for `registry.npmjs.org` is removed only by a test-only configuration seam (no production flag), fails. Its `error` names `registry.npmjs.org`, with the reinstall hint.
  - If no seam can be made without a production flag, use a tiny repository fixture whose recipe fetches an unlisted host. Say which in the flight log.

**Overall:**
- [ ] `npm run typecheck`, `npm test` and `npm run build` pass. The full Docker suite passes after the gate. Counts and times go in the flight log.

## Verification Steps
- **Unit**, on the double:
  - the contained and open call sequences for `install`, `installChecked`, `check`, `buildAttempts` (both attempts) and `finishInstall` (network true and false);
  - the record written with its ecosystems before `contain`;
  - `contain` failure leaving no network;
  - `replace` failure leaving the project offline;
  - refusal lines;
  - scanners' egress;
  - the clone's `local` for extra forges.
- **The Docker gate**, as in legs 5–7, with the volume list saved before.
- **Trials**. Weaken, confirm a test fails, restore by editing:
  - contain before writing the ecosystems;
  - the sandbox created with `start: true` under containment;
  - discovery left on the network with `network: false`;
  - a refusal host interpolated unquoted.

## Implementation Guidance
1. `refusals.ts` (pure).
2. The `start: false` option on `createContainer`.
3. `probe` and `runScanner` egress, behind the session's mode.
4. The installer: pass `Containment` in, the record write before `contain`, the creation and contain sequence in `buildAttempts`, `finishInstall`'s end, the failure paths' status read.
5. Unit tests and trials; then stop at the gate.
6. After the go-ahead: the Docker cases, the measurement, and the table correction (if any) with its version bump.

## Edge Cases
- **A repository on an `MCPE_EXTRA_HOSTS` forge whose name does not resolve upstream** (split DNS on native Linux): the clone fails `resolve-failed`, and the message says so. Recorded as a known limit; leg 11's README carries it.
- **An install whose build needs a host only GitHub release downloads serve**: it is allowed (DD5's GitHub rows).
- **A reinstall under the same names, contained**: `openInstall` retires the old sandbox as today. Its proxy and `-net` go with `destroy` (leg 6), and the new sandbox gets fresh ones.
- **`MCPE_NETWORK=contained` and Docker cannot provide it** (DD3's check fails): the install fails with `ContainmentUnavailableError`'s message, before the build, with nothing touched beyond the clone's own objects.

## Design Review 1 Resolutions (binding; they override the text above where they differ)
Flight Director, 2026-11-23. Review: approve with changes. **The leg stays one leg, in two stages**:
- **Stage A**: all code and unit tests, then the Docker gate.
- **Stage B**: after the go-ahead, the Docker cases, the measurement and the table correction.

The review recommended a split. A two-stage leg was its own alternative, and the egress pieces are small.

1. **The npm fixture** is `piuccio/cowsay` at `ref: eef317a302d025e3f31787566727c49eaee43648`. The Flight Director read it on 2026-11-23 with `gh api`: `package-lock.json`, a `prepare` script (`rollup -c`) that `npm ci` runs, and the binary `cowsay`. **The suite installs only `tomnomnom/gron` today**; the text above saying "the npm project the suite already installs" was wrong. `pnpm` and `yarn` stay **unmeasured** and are logged as such. So do the Debian `need`/`apt-get`, Python, Rust, Ruby and CMake/autotools rows: DD5's "measured" claim covers Go and npm only, and the flight log says so.
2. **Refusals on a successful install become warnings** (also the measurement's evidence; Go's recipe soft-fails on `go install`).
   - Under containment, before `setNetwork("off")` or `replace` on the success path, one helper reads the project proxy's report: `Docker.projectRefusals(sandboxName)`. It lists the proxy, calls `projectProxyStatus`, parses with leg 5's parser, and never throws.
   - Per `(host, port)`, up to 5, it pushes a record warning: "The build was refused `<host>:<port>` but finished; the project may be incomplete. Reinstall with `hosts: ["<host>"]`."
   - The proxy keeps only refusals, so "connect rows" in the text above do not exist.
   - The Docker cases assert, for `gron`: `ready`, a `gron__gron` tool, and **no** refusal or `MCPE_WARN` warnings. For `cowsay`: `ready`, a `cowsay__cowsay` tool (or the generated name the suite's existing naming gives `cowsay`), and no refusal warnings.
3. **Construction order.**
   - In `App` (`src/server.ts`), `Containment` is built **before** the installer. Today the installer is at about line 458 and `Containment` at about 461; reorder them.
   - The installer takes it as a **7th, trailing** constructor parameter typed `{ contain(key): …; replace(key): … }`.
   - **If `cfg.network.mode === "contained"` and none is given, the installer's constructor throws.** A forgotten argument never means open.
4. **`ecosystem` override**: the pre-contain record write sets `record.ecosystems` to include `record.primary` (primary first, de-duplicated). That way a caller-chosen ecosystem gets its registry rows. Unit case.
5. **The pre-contain write**:
   - **one** `registry.put(structuredClone(record))` in `finishInstall`, after `imageReason` and before `buildAttempts`. The image is set inside `buildAttempts` and is not claimed for this write;
   - a **snapshot**, so later in-memory mutations (`status = "failed"`) cannot reach the hook's `findByRepo` read;
   - `hosts` is not preserved here: interim, until leg 9's merging helper. Logged.
6. **Refusal-line budget.**
   - In `checkClone`'s `oneLine(…, 300)` path, the refusal sentence goes **first**, so truncation cuts Docker's stderr, not the refusal.
   - Appended lines are capped at 10 and 1,500 characters.
   - A clone failure in `install` reaches only the tool's error, not `project_info`: `settleFailure` deletes a record with no sandbox. The bullet above is narrowed to build failures.
7. **`start: false`**:
   - `docker create` with the arguments of `run -d` minus `-d`;
   - **the runtime refusal is mapped in `startForContainment`** too (`runtimeRefusal`), with a case;
   - `createContainer` refuses `start !== false` when `cfg.network.mode === "contained"`, so the trial is a code guarantee;
   - `test/docker-bypass.test.ts`'s `createContainer` exception note, `test/helpers.ts`, and the installer double (`test/installer.test.ts:183`) are updated and listed.
   - **A gated assertion**: `networkState` is `open` right after create, `contained` after `contain` and before start, and the sandbox runs contained after start.
8. **After `replace` on the success path**: `this.proxy.closeProject(container)` (MCP sessions opened during discovery held build-proxy connections), then invalidate.
9. **A failed `contain`**: the installer throws `new Error(error.message)` after `state.current.sandbox` is set, so `settleFailure` takes it offline again (idempotent) and the record is `failed`.
10. **Scanners**:
    - `ScanDocker.runScanner` returns `OneShotResult`;
    - refusal lines are added only to `failed(…)` outcomes (timeout, truncation, unparsable SARIF), never to `ran`, and pass through `redact`;
    - **known limit, written down**: a scanner that swallows its own refusals and exits 0 with valid SARIF is invisible.
11. **Clone entries**: `cloneHosts(repo)` is parsed with `parseHostEntry(…, "scanner")` mode, where literals are allowed for self-hosted forges. `local: true` when `repo.host` is **not** `github.com` or `gitlab.com`.
12. **The refused-build-host seam**:
    - `ContainmentOptions` gains an optional `defaults?: { build(ecosystems): string[]; run(ecosystems): string[] }`, defaulting to `buildHosts` and `sandboxHosts`, threaded through `allowanceFor`. `App` never passes it: no flag, no variable.
    - The Docker case builds its own `Registry`, `Docker`, `Containment` (with a `defaults` that drops `registry.npmjs.org`) and `Installer`, as leg 7's describe does.
    - **`cowsay`**: `npm ci` gets 403, so the record is `failed`, and its `error` carries `` `registry.npmjs.org:443` `` and the reinstall hint. **Not `gron`** (it soft-fails).
    - The repository-fixture fallback is dropped.
13. **Client evidence**, recorded in the flight log from one probe exec in the `cowsay` build sandbox before the end of the install:
    - `node -v` and `npm -v`;
    - `node -e 'fetch("https://registry.npmjs.org/")…'` with the hook's environment (expected to succeed);
    - the same with `NODE_USE_ENV_PROXY` unset (expected to fail closed).

    npm itself uses `HTTPS_PROXY`; `NODE_USE_ENV_PROXY` matters for `fetch` and corepack.
14. **"Every existing case passes unchanged"** becomes "no existing assertion changes, except the named entries in the flight log".
15. **Recorded evidence**:
    - the refusal-row table per install;
    - Node and npm versions;
    - the exact table diff;
    - the `-net`/start sequence assertion's result.

    A failed `replace` warning needs a second registry write; it is made with a snapshot.
16. **Native Linux**: leg 12's CI job repeats the `gron` contained install. The create/contain/start sequence assertion is added to its case selection, noted for leg 12.

## Design Review 2 Resolutions (binding; the last cycle; they override the text above where they differ)
Flight Director, 2026-11-23. Review: approve with changes.
1. **The sandbox is started by `Containment`, not the installer.** `test/docker-bypass.test.ts` allows `startForContainment` only from `containment.ts`, and that guard stays strict.
   - Add `Containment.contain(key, { start: true })`, which starts the sandbox after containing it, through `startForContainment`, and returns the started reference in `{ ok, result }`.
   - The installer uses that reference for every build `exec` and for the second attempt's `CLEAN_SCRIPT`, and sets `state.current.sandbox` to it.
   - Unit case.
2. **Under containment, the install never calls `setNetwork(sandbox, "open")`**: on a contained sandbox that removes the proxy and `-net` and connects `bridge`. `finishInstall`'s end is three explicit branches:
   - **contained, `network: true`**: no `setNetwork`; `record.network = true`; `discover` under the build allowlist; `put(ready)`; `replace`; `closeProject`; invalidate;
   - **contained, `network: false`**: `setNetwork("off")`, then `discover`, `put(ready)`;
   - **open**: today's `setNetwork(wantNetwork ? "open" : "off")` unchanged.

   A unit trial asserts that no `"open"` call happens under containment.
3. **The refusal read has one fixed point**: immediately after `res.code === 0`, before the network branch. That captures the build's refusals in both branches. On the failed branch it is before `takeOffline`, as stated.
   - Refusals during discovery with `network: true` are **not read**. Accepted and stated: discovery runs commands that rarely fetch.
   - The warnings are written by the final `put`.
   - `projectRefusals` returns `[]` when the report is unavailable.
   - Warnings are de-duplicated by `(host, port)`.
4. **The `defaults` seam is threaded through both `allowanceFor` call sites** (`buildConfig` and `assess`). Otherwise the hook would judge a seam-built proxy stale and rebuild it with the real table.
   - The signature is `allowanceFor(record, defaults?)`.
   - Unit case: a seam-built proxy is judged fine by `assess`.
5. **The pre-contain write and the ecosystem override are contained-only.** Open mode keeps today's single in-memory `record.ecosystems = detection.ecosystems` and its writes. The snapshot `put` replaces `openInstall`'s record, keyed by slug.
6. **A proxy kept between build attempts carries attempt 1's refusals into attempt 2's warnings.** Accepted and stated; neither fixture takes the fallback.
7. **The `cowsay` refused-host case** gets a generous `timeoutSec` (600 s) and test timeout, since `npm ci` retries with backoff and `|| npm install` tries again. Its time is recorded.
8. **The client probe** runs through a `Docker` subclass that intercepts the first build `exec`, as `test/integration/docker.test.ts`'s `attachedDuringBuild` does.
   - The unset probe uses `sh -c 'unset NODE_USE_ENV_PROXY; node -e …'`, since the reference's environment wins over a caller's.
   - Outcomes are recorded, not asserted. The image's Node may predate `NODE_USE_ENV_PROXY`.
   - Gated assertions:
     - `refusalLines` output reaches `record.error` in the `cowsay` refused case;
     - the `gron` and `cowsay` success cases carry no refusal warnings;
     - discovery generates `cowsay__cowsay`. The review confirmed it from `makeToolName` and `NODE_DISCOVERY`, along with `cowsay__cowthink`.

## Files Affected
- `src/install/installer.ts`, `src/sandbox/docker.ts`, `src/scan/run.ts`, `src/server.ts`, `src/network/defaults.ts`, `src/network/refusals.ts` (new).
- `src/network/containment.ts` (the `defaults` seam, `contain(…, { start })`), `test/containment.test.ts`, `test/docker-bypass.test.ts`, `test/helpers.ts`.
- `test/installer.test.ts`, `test/docker.test.ts`, `test/scan-run.test.ts`, `test/network-refusals.test.ts` (new), `test/network-defaults.test.ts` (if the table changes), `test/integration/docker.test.ts`.

## Citation Audit
Checked on 2026-11-23 against the working tree (legs 1–7 landed):
- `src/install/installer.ts`:
  - `probe` at ~269 (`install`) and ~291 (`checkClone`);
  - `copyVolume` at ~419;
  - `finishInstall` at ~488, with `setNetwork(sandbox, wantNetwork ? "open" : "off")` at ~539 before `discover`, then `status = "ready"` and `put`;
  - `buildAttempts` at ~592, with `removeContainer` between attempts and `createContainer` at ~625;
  - `takeOffline`'s `setNetwork(…, "off")` at ~785.

  Present.
- `src/scan/run.ts`: `runScanners` → `docker.runScanner(volume, spec, …)`. Present.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
