# Leg: gvisor-ci

**Status**: completed
**Flight**: [Contained Network and Isolation Runtime](../flight.md)

## Objective
Grow `.github/workflows/docker-gvisor.yml` from leg 4's measurements into the proof the operator asked for ("if we are going to advertise gvisor we should probably prove it works"). On GitHub's `ubuntu-latest`, with a pinned and checksum-verified gVisor registered as `runsc`, the workflow:
- runs mcp-everything's Docker-gated suite under `MCPE_DOCKER_RUNTIME=runsc`;
- shows that every container mcp-everything starts runs under gVisor;
- shows that installs work under it;
- shows that a missing runtime and a sandbox made under another runtime are refused;
- repeats the containment cases on native Linux.

It keeps the measurement job.

## Context
- **Flight decisions.**
  - **DD13**: the `docker-gvisor` job, its path-filtered triggers, a pinned gVisor with its SHA-512 checked, and the case list.
  - **DD11**: naming a runtime is requiring it; existing sandboxes under another runtime are refused.
  - **Leg 8 resolution 16**: the create/contain/start sequence on native Linux.
- **Leg 4**: the measurement workflow. Leg 4's measurements say native Linux supports DD3's network and `host-gateway` (`172.17.0.1`, inside `bridge`).
- **Legs 2, 5–10**: the runtime check, and the containment describes in `test/integration/docker.test.ts`. Each describe builds its configuration with `loadConfig({ ...process.env, … })`, so `MCPE_DOCKER_RUNTIME` from the job's environment reaches them all. The containment describes set `MCPE_NETWORK=contained` themselves; the older ones run `open`.
- **Suite time**: about 1080 s on Docker Desktop. Most of it is leg 8's refused-registry case waiting out its 600 s `timeoutSec` (flight log, leg 9). This leg lowers that case's `timeoutSec` to 90 s. The flight-end review carried the change, and it is done here because CI time is billed per run. The case still asserts the refusal line and the hint.
- **Actions** are pinned by SHA as in `ci.yml`: `actions/checkout`, `actions/setup-node`. `permissions: contents: read`.

## Inputs
- `.github/workflows/docker-gvisor.yml` (leg 4), `.github/workflows/ci.yml` (style and action pins).
- `test/integration/docker.test.ts`; `package.json` (`test:docker`).
- gVisor's release download location: `https://storage.googleapis.com/gvisor/releases/release/<YYYYMMDD>/x86_64/runsc` and `runsc.sha512`. The release date is **read at implementation** with an HTTP `HEAD` of a recent date, never from memory.

## Outputs
- `.github/workflows/docker-gvisor.yml`: jobs `measure` (kept) and `gvisor`.
- `test/integration/docker.test.ts`: a new describe for the runtime proof; leg 8's refused-host `timeoutSec` lowered to 90 s.
- Flight log: the pinned release and checksum; the first CI run's results, read from `gh run view`.

## Acceptance Criteria

**The `gvisor` job:**
- [ ] **Settings**: `runs-on: ubuntu-latest`, `timeout-minutes: 75`, `permissions: contents: read`. The same triggers and path filter as leg 4, plus `src/network/**` and `test/**`.
- [ ] **Setup steps**, in order:
  1. `docker version`;
  2. download `runsc` and `containerd-shim-runsc-v1` from the pinned dated release, verify each against the published `.sha512` with `sha512sum -c`, and **fail the job if either check fails**;
  3. install them to `/usr/local/bin`;
  4. `sudo runsc install` and `sudo systemctl restart docker`;
  5. `docker info --format '{{json .Runtimes}}'` must list `runsc` (else fail);
  6. a smoke test, `docker run --rm --runtime runsc <the probe image's pinned reference> dmesg`, whose output must contain "gVisor" (else fail).
- [ ] **Build steps**: checkout and Node, both pinned by SHA, Node from `.nvmrc`; `npm ci`; `npm run build`.
- [ ] **Run A, the whole Docker suite under gVisor**: `MCPE_DOCKER_TESTS=1`, `MCPE_DOCKER_RUNTIME=runsc`, `npx vitest run test/integration`, with a step timeout. Every case passes, or the job fails. A case gVisor cannot run (for example the fork-pressure cases, already skipped by default) may be skipped only with `skipIf` on a named reason recorded in the flight log, never silently.
- [ ] **Run B, the runtime describe** (new, below).
- [ ] **A summary**: each run's counts and time, appended to `$GITHUB_STEP_SUMMARY`.

**The runtime describe** (new, in `test/integration/docker.test.ts`, enabled only when `MCPE_DOCKER_RUNTIME` is set). It follows the suite's guard rules: a random owner, the suite prefix, checked removals.
- [ ] **Every container mcp-everything starts runs under the named runtime.** A contained install of `tomnomnom/gron` with `network: true` runs with a `Docker` subclass that records every container id it creates: clone, `resolv-read`, one-shot proxy, sandbox, project proxy and the runtime trial. After the install, `docker inspect` of each still-existing one, plus the ids recorded at creation for the one-shots, shows `HostConfig.Runtime` equal to `runsc`. An exec in the sandbox, `dmesg` or `cat /proc/version`, shows gVisor.
- [ ] **A missing runtime refuses before anything is created**: a second configuration naming `mcpe-no-such-runtime` makes `check_project` refuse with DD11's message, and nothing with the describe's owner exists afterwards.
- [ ] **A sandbox made under another runtime is refused**:
  1. a sandbox created with `runc` (a configuration with no runtime named);
  2. then `acquire` through a configuration naming `runsc` throws `RuntimeMismatchError` with "reinstall";
  3. `set_project_network(false)` on it still works.
- [ ] **The create/contain/start sequence on native Linux**: `networkState` is `open`, then `contained`, then the sandbox runs contained (leg 8 resolution 16).
- [ ] **Local access through `host-gateway` on native Linux**: leg 9's local-access case runs in Run A. This describe asserts nothing more; the job's summary names that case's result.

**The `measure` job** is kept as leg 4 wrote it, so the native-Linux measurements stay visible.

**Leg 8's refused-host case**: `timeoutSec` 90, and its test timeout lowered to match. It still asserts the failed status, the `registry.npmjs.org:443` row, the refusal line, the hint and offline afterwards.

**The run:**
- [ ] **The Flight Director pushes** the branch's workflow change (only `.github/workflows/docker-gvisor.yml`; the flight's code stays uncommitted until the flight-end review). That push cannot run the new tests, because the PR's code is the committed code.
  - So **the first full `gvisor` run happens after the flight commit**, at the flight-end review.
  - For this leg, the Developer verifies the workflow with `actionlint` where available, and runs the new describe and leg 8's shortened case **locally on Docker Desktop with no runtime named** (the describe is skipped there; the shortened case runs).
  - **The CI run's results are recorded when the flight commit is pushed.**
- [ ] **The README sentence** leg 11 marked for leg 12 is updated only after the CI run passes: "behavior under gVisor is tested in CI on Linux (`docker-gvisor.yml`)". Until then it stays as leg 11 wrote it.

## Verification Steps
- `actionlint`, if available.
- `bash -n` of each `run:` block, extracted to a scratch file under the session scratchpad with the Write tool.
- `npm run typecheck`, `npm test`.
- Locally, through the Docker gate: the leg-8 shortened case alone (`-t`), and the new describe, which must report itself skipped without a runtime.
- After the flight commit and push: the `gvisor` job's run, read by the Flight Director with `gh run view --log`; the counts and the smoke test's `dmesg` line go into the flight log.

## Implementation Guidance
1. Find a recent gVisor release date with `curl -fsI` against the dated URL (read-only network). Record the date and both SHA-512s in the workflow and the flight log.
2. Write the `gvisor` job.
3. Write the runtime describe; lower leg 8's case.
4. Run the local checks; stop at the Docker gate before running the shortened case and the describe locally.

## Edge Cases
- **`runsc install` changes `/etc/docker/daemon.json`** on the runner only. That is expected; the runner is discarded.
- **gVisor refuses a build step** (raw sockets, an unsupported syscall): that is a finding, not a flake. Record it, skip only that case with a named reason, and leg 11's README states the limit (the mission constraint: "the isolation runtime may refuse some builds").
- **Run A takes longer than the step timeout**: split Run A by describe across two steps. Never drop cases.

## Design Review 1 Resolutions (binding; they override the text above where they differ)
Flight Director, 2026-11-23. Review: approve with changes. No second review: these are the reviewer's own fixes, and the CI run is the real check.

1. **Every container's runtime, proven at creation.**
   - The runtime describe uses a `Docker` subclass overriding the protected `docker()`. On every successful `create` or `run`, it takes the id from stdout and **immediately** inspects `{{.HostConfig.Runtime}}`, before `start`, while even one-shots still exist. It also asserts the argv carries `--runtime` followed by `runsc`.
   - **Completeness** is checked with `docker events --since <t> --until <t'> --filter type=container --filter event=create --filter label=mcp-everything.owner=<id>`: the count equals the recorded count.
   - **The roles seen must include** clone, `resolv-read`, `oneshot-proxy`, `runtime-check`, **`scan`**, **`copy`**, the sandbox (no role) and `project-proxy`.
   - So the install runs **with scanning on** (`MCPE_SCAN=warn`) and one trivial operator scanner (the suite's existing test-scanner shape, the pinned `ALPINE`, `network: false`). That makes the scan one-shot and the staging copy appear.
   - "Ids recorded at creation, inspected later" is withdrawn.
2. **The gVisor proof inside a container is `dmesg`, one command**: `docker exec <sandbox> sh -c 'dmesg'`, with the output required to contain `gVisor` (case-insensitive). The `golang` image ships util-linux's `dmesg`. `/proc/version` is not used: gVisor reports `Linux version 4.4.0`.
3. **Push plan: one file, gated test steps.**
   - The workflow's test steps (build, Run A, Run B) carry `if: hashFiles('src/network/proxy/proxy.cjs') != ''`, so before the flight commit (tree `0a2e39f` has no `proxy.cjs`) **only the setup half runs**: download, checksum, install, registration, smoke `dmesg`.
   - The Flight Director pushes the workflow after this leg lands. That run is expected to show setup only; a red setup is wanted information.
   - Run A and Run B run first on the flight commit. **Fix commits after a red first run are expected.** The rule is "one commit for the flight's work after the flight-end review", not "no follow-up commits".
4. **No shim**: only `runsc` (and `runsc.sha512`) is downloaded. Docker's `--runtime runsc`, registered by `runsc install`, does not need `containerd-shim-runsc-v1`.
   - Files are verified in one directory under their published names (`sha512sum -c runsc.sha512`).
   - The release date and the hash go in one `GVISOR_RELEASE`/`GVISOR_SHA512` `env:` pair, read at implementation from the newest dated release that answers 200 (the review saw 20260817), with a bump note in a comment.
   - After `systemctl restart docker`, a bounded `until docker info …` loop.
   - Outputs are captured and then tested, not piped under `pipefail`.
5. **The runtime describe lives in its own file**, `test/integration/gvisor.test.ts`.
   - Run A runs `test/integration` excluding it; Run B runs only it.
   - Step timeouts: Run A 50 min, Run B 15 min. The job timeout is 75.
   - The runc-sandbox case builds its first configuration with `MCPE_DOCKER_RUNTIME: ""`.
   - The missing-runtime check counts objects by that configuration's own owner id.
6. **Skips under gVisor.**
   - Each skip is a `skipIf(process.env.MCPE_DOCKER_RUNTIME === "runsc")` with a reason string, recorded in the flight log.
   - The job summary prints skipped counts from vitest's JSON reporter, with `if: always()`.
   - Candidates to verify, not presume: the cases reading `/sys/class/net`, and exact prober error codes.
   - **A failing contained install or a failing local-access case is a finding, never a skip.**
7. **Leg 8's refused-host case**: `timeoutSec: 90`, and the test timeout lowered from 1,800,000 ms to 300,000 ms, which leaves room for a cold image pull on a fresh runner.
8. **Paths**: the trigger filter becomes `src/**`, `test/**`, `package.json`, `package-lock.json`, `.nvmrc`, `tsconfig*.json` and the workflow itself.
9. **Housekeeping in the workflow**:
   - `concurrency: { group: docker-gvisor-${{ github.ref }}, cancel-in-progress: true }`;
   - the header comment updated (leg 12, not 10);
   - checkout and setup-node pinned to the same SHAs as `ci.yml`, with `persist-credentials: false`;
   - `docker version` in the summary;
   - the leg-9 local-access case's result named in the summary from the JSON report.
10. **Answers to the review's questions.**
    - **Run A** stays one step; the per-step timeout and the JSON summary localize failures.
    - **A project proxy created under `runc`** needs no separate refusal: it is used only through its sandbox, which is refused, and a reinstall's `destroy` removes it.
    - **The `docker-gvisor` job stays advisory**, not a required check: the runner's Docker version floats. Recorded for the operator.

## Files Affected
- `.github/workflows/docker-gvisor.yml`, `test/integration/docker.test.ts` (leg 8's case), `test/integration/gvisor.test.ts` (new).

## Citation Audit
Checked on 2026-11-23:
- `.github/workflows/docker-gvisor.yml`: leg 4's `measure` job, as pushed in `0a2e39f`.
- `test/integration/docker.test.ts`: describes call `loadConfig({ ...process.env, … })` (legs 5–10 pattern); leg 8's refused-host case has `timeoutSec: 600`.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
