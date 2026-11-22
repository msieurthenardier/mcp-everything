# Leg: owned-clone

**Status**: completed
**Flight**: [Checking a Project's Own Code Before It Runs](../flight.md)

## Objective
Make the clone container an owned, named, one-shot container that is removed by its id whatever happens (including a timeout), through a reusable one-shot method later legs share; let the clone label its volume as staging when asked; raise the clone's output cap; and pin the clone image by digest — with no other change to what the clone does or returns.

## Context
- Flight DD6 step 2, DD10, DD11. Split from the first draft of `clone-walk` at its design review (2026-11-22), which found two separate risks in one leg: this one (container lifecycle, the Docker double, the coverage test, the pin) and the shell walk (leg 5).
- Design review 1 of the flight: `run()` kills only the `docker` client on a timeout (`src/util/exec.ts`), so a timed-out `docker run` leaves its container running; today's clone container is unnamed and unlabelled (`probe`: `"run", "--rm", "--network", "bridge"`). This fix applies to every install, scanning on or off.
- Leg 6's scanner runner and copy reuse the one-shot method. It mounts whatever volume it is given, so **callers classify the volumes they pass** (`probe` already refuses a volume name that exists; leg 6 must classify staging and sandbox volumes before passing them).
- The cap rises from 8 MB to 16 MB now, for the walk leg 5 adds (about 2.7 MB of walk output plus up to about 8.8 MB of manifests).

## Inputs
- `src/sandbox/docker.ts`: `probe(repo, volume, opts)` creates the volume (labels `mcp-everything=1`, owner), then `docker run --rm --network bridge …limits() -v <volume>:/workspace --entrypoint sh <probeImage> -c PROBE_SCRIPT probe <url> <ref> <submodules> …MANIFESTS` with `{ timeoutMs: 600_000, maxBytes: 8_000_000 }`; `FULL_ID` (the 64-hex id check); `limits()`; `ensureImage`.
- `src/config.ts`: `probeImage: env.MCPE_PROBE_IMAGE || "alpine/git:latest"`.
- `test/docker.test.ts`: the scripted double (`world()`, about lines 74–122: its `run` fake prints `HEAD ccc…`; it has no `create`; its `start` reads the id from `args[1]`); the `probe's volume` cases asserting `d.count("run")` (about lines 831–863); the `CASES` table; `NOT_GUARDED` and `REPORTING` with their comments; the coverage test.
- `test/integration/docker.test.ts`: the suite prefix `mcpe-it-<pid>-`, `mayRemove`, `removeVolumeChecked`.

## Outputs
- `src/sandbox/docker.ts` — the one-shot method; `probe` on it; `volumeRole`; cap 16 MB.
- `src/config.ts` — the pinned default.
- `test/docker.test.ts` — the double extended; probe cases moved to the new calls; new cases; coverage lists.
- `test/integration/docker.test.ts` — two cases; the pinned `alpine` constant for later legs.

## Acceptance Criteria

**One-shot method** (private; the Developer names it, for example `runOnce`)
- [ ] `docker create --rm` with: name `<namePrefix><installationId>-<role>-<8 random hex>`; labels `mcp-everything=1`, the owner label with this installation's id, `mcp-everything.role=<role>`; `limits()`; no TTY; the network, mounts, working directory, image and arguments the caller gives; an optional `entrypoint` (when omitted, no `--entrypoint` flag, so the image's own entrypoint runs — leg 6's scanners need this); and optional extra capabilities from a closed set (`CHOWN`, `FOWNER`, `DAC_OVERRIDE`, `FSETID`) added with `--cap-add` after `limits()` (leg 6's copy needs them; the clone passes none). `create` has its own timeout (60 s). Its stdout, trimmed, must match `FULL_ID`, or the call fails as a creation failure.
- [ ] Then `docker start -a <id>` through `run()` with the caller's `timeoutMs` and `maxBytes`; then, in a `finally`, `docker rm -f <id>`. "No such container" from `rm -f` is success (`--rm` may have removed it). Any other `rm -f` failure is ignored with a comment pointing at leg 6's startup sweep and never masks the command's outcome.
- [ ] If `create` fails, nothing is started and nothing removed. If `create` **times out**, a container may exist under the random name, so `rm -f <name>` is issued (the name is this call's own and random), and the call fails as a creation failure. Accepted residual risk: the daemon may still create it after that `rm -f`; leg 6's startup sweep removes it.
- [ ] Returns stdout, stderr, exit code, `timedOut`, `truncated` as `run()` reports them for `start -a`.
- [ ] `role` is a closed type (`"clone" | "scan" | "copy"`); no caller text reaches the label or the name.
- [ ] A comment on the method says it mounts what it is given and callers must classify volumes first.
- [ ] In the coverage test it is listed in `NOT_GUARDED` (it acts only on a container it created; the guarded table is for acting on caller-named sandboxes), and that list's comment is updated to say so.

**The clone**
- [ ] `probe` runs through the one-shot method with role `clone`, network `bridge`, the volume at `/workspace`, the same entrypoint, script and arguments as today, `timeoutMs` 600 s (overridable through `opts` for tests only) and `maxBytes` 16,000,000.
- [ ] `opts.volumeRole?: "staging"`: when set, the volume also carries `mcp-everything.role=staging`; otherwise the volume's labels are exactly today's.
- [ ] A timed-out clone throws today's "Could not clone …" with "timed out" in its detail, and leaves no container.
- [ ] Otherwise unchanged: the refusal when the volume name is taken, the "produced no commit" error, and `ProbeData` (no `walk` yet; leg 5).

**The pin**
- [ ] Default `probeImage` = `alpine/git:<tag>@sha256:<index digest>`, the tag being what `latest` points to on the day, both read from the registry during the leg (`docker buildx imagetools inspect alpine/git:latest`, or pull then `docker image inspect --format '{{index .RepoDigests 0}}'`), with the commands and output recorded in the flight log. `MCPE_PROBE_IMAGE` still overrides. A comment beside it says how to bump it. The comment near the watchdog script that says behavior was "measured on `alpine/git:latest`" is updated to name the pinned image.
- [ ] A real-Docker run shows `ensureImage` finds the pinned reference locally on a second use (no second pull); if it does not, that is reported, not worked around.
- [ ] `alpine`, for the test scanner of later legs, is pinned the same way as an exported constant in the integration suite, read the same day.

**Tests**
- [ ] The scripted double handles `create` (prints a 64-hex id; records name, labels and arguments), `start -a <id>` (the id is the last argument; returns the script's output, `HEAD ccc…` for the clone), and `rm -f`. The `probe's volume` cases count calls whose first argument is `create` (not `volume create`, which the double already records) where they counted `run`, so their zero-count assertions mean something again.
- [ ] Unit cases for the one-shot method: the exact `create` arguments (name shape, the three labels, `--rm`, no `-t`); `start -a` with the caller's timeout and cap; `rm -f <id>` after success, after a non-zero exit, after a timeout, after `start` throws; "No such container" from `rm -f` tolerated (a unit case only: on Docker 29.8.2 `rm -f` of an auto-removed container answers 0, per the second design review); no `start` and no `rm` when `create` fails; `rm -f <name>` when `create` times out; a non-`FULL_ID` stdout from `create` rejected. Unit cases for `probe`: the 16 MB cap, role `clone`, the staging label only when asked.
- [ ] Integration (the suite's own `mcpe-it-<pid>-` prefix, so `mayRemove`'s existing prefix clause covers every name; `mayRemove` is **not** extended, since no case here runs under the default prefix; flight DD11 is amended to match): (a) a clone of `tomnomnom/gron` into a volume named under the suite prefix returns a commit, no container with role `clone` and the suite's owner id remains, and the volume is removed by the case through `removeVolumeChecked`; (c) the one-shot method with role `clone` running `sleep 30` with a 2 s timeout returns `timedOut` and leaves no container. "Leaves no container" is checked by polling for up to 10 s, since the daemon may still be removing it. (Reaching a private method from the suite: through a small test subclass, as the double does, or a documented test-only hook; the Developer chooses and says which.)
- [ ] `npx vitest run` passes (legs 1–3 plus this leg's cases); typecheck clean; build succeeds. **The first run of the new integration cases is gated**: the Developer stops after writing them and reports, and runs them only on the Flight Director's go-ahead. Then the whole Docker suite passes, and the operator's containers and volumes listed in the flight log are unchanged.

## Verification Steps
- `npx vitest run`; `npm run typecheck`; `npm run build`.
- Gate; then `npm run test:docker`, whole output saved to the scratchpad.
- `docker ps -a --filter label=mcp-everything.role` empty afterwards; operator's containers and volumes as listed.
- Trials (exact edits, undone by editing; `git diff -- src test` compared after each undo with a copy saved before): (1) drop the `rm -f` from the `finally`; (2) build the name without the role; (3) drop `--rm` from `create`; (4) accept any `create` stdout as the id. Report each outcome.

## Implementation Guidance
1. Extend the double first so the existing probe cases fail for the right reason, then build the one-shot method with its cases, then switch `probe`.
2. Read `createContainer` for how this file names, labels and validates ids; follow it.
3. Pin last; record the commands.
4. Write the integration cases; stop at the gate.

## Edge Cases
- `docker start -a` returns the container's exit code; a non-zero clone exit is today's "Could not clone".
- The daemon removes a `--rm` container when it exits; `rm -f` then answers "No such container": success.
- A Node process killed mid-clone leaves a running or exited container named with role `clone`: leg 6's sweep removes it (stated in the method's comment).

## Files Affected
- `src/sandbox/docker.ts`, `src/config.ts`, `test/docker.test.ts`, `test/integration/docker.test.ts`.

## Citation Audit
Checked by the Flight Director on branch `flight/01-checks-before-code-runs`, and by the first draft's design review (2026-11-22, which ran busybox 1.37 checks): `probe` and its `run` arguments and caps as quoted; `FULL_ID` near `src/sandbox/docker.ts:303`; the double's `world()` at `test/docker.test.ts:74–122`, whose `run` fake prints `HEAD ccc…` (line 120) and whose `start` reads `args[1]`; the `probe's volume` cases' `count("run")` at about lines 838–863; `NOT_GUARDED` (about 918–922) and `REPORTING` (about 928); the integration prefix clause of `mayRemove` (about line 62); the two-installation suite uses the default prefix (about line 749). Slugs never contain `-` (`src/toolgen/naming.ts`). Line numbers drift; quoted snippets are authoritative.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
