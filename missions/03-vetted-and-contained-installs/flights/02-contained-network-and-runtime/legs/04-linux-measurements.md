# Leg: linux-measurements

**Status**: completed
**Flight**: [Contained Network and Isolation Runtime](../flight.md)

## Objective
Add a measurement-only GitHub Actions workflow that runs on a draft pull request and answers, on native Linux (`ubuntu-latest`), the premises the flight has measured only on Docker Desktop. Leg 6's design waits for these answers:
- DD3's isolated network;
- `host-gateway`;
- the upstream resolver;
- a network alias held by two containers.

## Context
- **Split from `contained-networks`** at its design review (2026-11-22). The workflow uses plain `docker` and shell, with no project code and no dependency on legs 1–3, so it can run now and its answers arrive before the project-proxy leg is designed.
- **Flight decisions.**
  - DD13: the `docker-gvisor` workflow, its path filter and its triggers.
  - DD3: the isolated-gateway check.
  - DD10 and leg 3's decision 5: `host-gateway` and whether it falls inside `bridge`.
  - DD4: the resolver under systemd-resolved.
  - DD2: the two-holder alias during a replacement.
  - The operator agreed (2026-11-22) to a draft pull request at leg 4.
- **Only this workflow file is committed and pushed** (Flight Director's decision, flight log). The flight's code stays uncommitted until the flight-end review.
- **Leg 10 (`gvisor-ci`) rewrites this file** into the full job. It keeps a measurement job, or folds these steps in.
- **Style.** `.github/workflows/ci.yml` pins actions by SHA, uses `permissions: contents: read` and has `timeout-minutes: 10`. This workflow needs no actions at all (no checkout, no setup), so it pins none; it says so in a comment.

## Inputs
- `.github/workflows/ci.yml` (style).
- Flight trials T1–T13 (what to measure and how it looked on Docker Desktop).
- The probe image reference in `src/config.ts` (`probeImage`, `alpine/git:…@sha256:…`), reused here as the measuring image, so no new unpinned image is pulled.

## Outputs
- `.github/workflows/docker-gvisor.yml` (new).
- Flight log: a `### linux-measurements` entry, with the run's results added by the Flight Director after the push.

## Acceptance Criteria
- [ ] **Triggers**: `workflow_dispatch`, and `pull_request` with `types: [opened, synchronize, ready_for_review]` and `paths`:
  - `src/sandbox/**`, `src/proxy/**`, `src/install/**`, `src/network/**`;
  - `src/config.ts`, `src/server.ts`, `src/registry.ts`;
  - `package.json`, `test/integration/**`;
  - `.github/workflows/docker-gvisor.yml`.
- [ ] **Settings**: `permissions: contents: read`, `timeout-minutes: 15`, `runs-on: ubuntu-latest`. One job, `measure`.
- [ ] **No `actions/*` uses.** A comment says why: no code is needed, and nothing pinned is needed.
- [ ] **Images**: only the probe image, by the exact digest-pinned reference in `src/config.ts`. A comment names that file as its source, so the two are bumped together.
- [ ] **Each measurement is its own step**, run with `set +e`, that prints labelled results. It appends them to `$GITHUB_STEP_SUMMARY` as a Markdown section. A measured "no" never fails the job; a broken script (an unknown command, a syntax error) does. Every Docker object the job creates is named `mcpe-measure-<run id>-…` and removed at the end of its step, with `trap … EXIT`.
- [ ] **Steps:**
  1. **Docker**: `docker version`, and `docker info --format '{{json .Runtimes}}'` plus `DefaultRuntime`.
  2. **DD3**: create `--internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated --ipv6=false`, print the inspect of `Internal`, `EnableIPv6` and `IPAM.Config`, and record whether a `Gateway` is present. Also try `-o com.docker.network.bridge.inhibit_ipv4=true` the same way.
  3. **Resolver**:
     - print the runner's `/etc/resolv.conf`, and whether `systemd-resolved` is active;
     - print a container on `bridge`'s `/etc/resolv.conf`;
     - from that container, resolve `github.com` (`nslookup`, or `getent hosts`) through each nameserver it lists.
  4. **`host-gateway`, all in one step**, with the listener's process killed by the trap:
     - start a listener on the runner: `python3 -m http.server <port> --bind 0.0.0.0` in the background;
     - from a container on `bridge` with `--add-host host.docker.internal:host-gateway`: print `/etc/hosts`, then fetch `http://host.docker.internal:<port>/` (expected reachable) and `http://<docker0 address>:<port>/`;
     - from a container on the isolated internal network: try the same address (expected unreachable);
     - record whether the `host-gateway` address falls inside `bridge`'s subnet (`docker network inspect bridge`).
  5. **Two-holder alias**:
     - on an isolated internal network, start two long-running containers, both connected with `--alias mcpe-proxy`;
     - from a third container on the same network, run `getent hosts mcpe-proxy` ten times and print the order of the answers;
     - `docker restart` one holder, and repeat.
  6. **Cleanup check**: list anything named `mcpe-measure-<run id>-*` that remains (expected none).
- [ ] **The workflow is valid**: `actionlint` passes if it can be run locally (`npx --yes actionlint` or a binary). If not, the Developer says so; the Flight Director's push is then the check.
- [ ] **Nothing else in the repository changes**, apart from this leg's artifact and the flight log.

## Verification Steps
- Read the file against each criterion; run `actionlint` if available.
- Run `bash -n` on each step's script, extracted to a scratch file under `/tmp/claude-1000/-home-cprch-projects-mcp-everything/af8c3a2b-d50f-4f71-82a3-12dc354df1cd/scratchpad/` (not in the repository).
- **Do not run** the steps against the operator's Docker. They are written for the runner. The Flight Director decides whether any step is tried locally.
- The Flight Director then:
  1. commits only this file;
  2. pushes the branch;
  3. opens the draft pull request;
  4. reads the run's summary with `gh run view`;
  5. records the results in the flight log before the project-proxy leg is designed.

## Implementation Guidance
1. Write the file with Write. One `jobs.measure` with the steps above, each a `run: |` block beginning `set +e`. `set -u` only where a variable is certain.
2. Record the run id with `${{ github.run_id }}`, used in names.
3. Find the docker0 address with `ip -4 -o addr show docker0`. If that fails, use `docker network inspect bridge`'s gateway.
4. In the alias step, start holders with the probe image, entrypoint `sleep`, argument `600`.
5. Do not push and do not commit; the Flight Director does.

## Edge Cases
- **`gateway_mode_ipv4=isolated` refused** by an older daemon on the runner: the step records the error text and continues.
- **No `systemd-resolved`** on the runner: record that and continue.
- **The listener's port is busy**: try two more ports.
- **`getent` missing in the probe image** (alpine has it in musl utils): fall back to `nslookup`. Record which was used.

## Files Affected
- `.github/workflows/docker-gvisor.yml`: new.

## Citation Audit
Checked on 2026-11-22:
- `.github/workflows/ci.yml`: `permissions: contents: read`, `timeout-minutes: 10`, actions pinned by SHA. Present.
- `src/config.ts`: `probeImage` default `alpine/git:2.54.1@sha256:29cff25811f790b9f72fc266bf8009a5a911714c0e03c31c47339c50909d9aef`. Present.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
