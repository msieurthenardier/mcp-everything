# Leg: scan-in-docker

**Status**: completed
**Flight**: [Checking a Project's Own Code Before It Runs](../flight.md)

## Objective
Add what the checked install needs from Docker, unwired: run the operator's scanners one at a time against a staging volume and turn each run into a `CheckOutcome`; copy a staging volume into a new sandbox volume exactly; and find and remove this installation's leftovers of checks by role and age.

## Context
- Flight DD2 (how a scanner runs; failures; order and total time), DD6 (the guarded copy; the leftovers sweep), DD11.
- Leg 4 built the one-shot owned container (role `clone | scan | copy`, `create --rm`, `start -a`, `rm -f` by id, `NOT_GUARDED`), whose comment says callers classify the volumes they pass. This leg's methods are those callers.
- Leg 2 provides `ScannerSpec`, `parseSarif`, `CheckOutcome`, `emptyCounts`. Leg 4 labels a staging volume `mcp-everything.role=staging` through `probe(…, { volumeRole: "staging" })`.
- Leg 7 wires all of this into the install and the startup; this leg calls nothing from the installer or the server.
- Credentials: the MCP proxy's pattern (`src/proxy/mcp-proxy.ts`, `dockerConnector`): a file under `<dataDir>/tmp` named `env-<16 hex>` (`ENV_FILE_NAME`, `newEnvFileName`), mode 0600, values validated by `validateEnv`, removed in a `finally`; `sweepEnvFiles` removes old ones at startup. Reusing that name shape means the existing sweep covers a scanner's file too.

## Inputs
- Legs 1–5 landed.
- `src/sandbox/docker.ts`: the one-shot method (leg 4), `inspectVolume`, `volumeFacts`, `refuseUnless`, `ensureImage`, `classifySandbox`, the owner and generic labels.
- `src/proxy/mcp-proxy.ts`: `ENV_FILE_NAME`, `newEnvFileName`, `validateEnv`.

## Outputs
- `src/sandbox/docker.ts` — `runScanner`, `createScratchVolume` (or similar), `copyVolume`, `sweepCheckLeftovers`; the label constant for roles if not already exported.
- `src/scan/run.ts` — `runScanners(…)`: the sequence, the time budget, failures, parsing.
- `src/proxy/mcp-proxy.ts` — only to export the env-file helpers it already has, if needed (no behavior change).
- Tests: `test/docker.test.ts`, `test/scan-run.test.ts` (new), `test/integration/docker.test.ts`.

## Acceptance Criteria

**`Docker.runScanner(volume, spec, { timeoutMs, envFile? })`**
- [ ] Before anything else, the volume is inspected and must exist, be classified **`mine`** (another installation's or not mcp-everything's → `SandboxRefusedError` via `refuseUnless`; `before`, which `refuseUnless` lets through, → a plain error: a staging volume is never from before ownership) and carry `mcp-everything.role=staging`; otherwise it throws without creating a container.
- [ ] Runs through the one-shot method with role `scan`; the image's **own entrypoint** (leg 4's `entrypoint` omitted) with `spec.command` as arguments; `--network none` unless `spec.network`, then `bridge`; the volume mounted **read-only** at `/scan` (`--mount type=volume,src=<volume>,dst=/scan,readonly`); working directory `/scan/repo`; `--env-file <file>` when given; stdout cap 8,000,000 bytes; the caller's timeout. (A checkout with no `repo` directory makes `start` fail on the read-only mount's working directory; that is a `failed` outcome, not a crash.)
- [ ] Unit cases pin those arguments, the refusal for a volume that is another installation's, not ours, missing, or without the staging role, and that no `create` happens in those cases.

**`runScanners(docker, volume, scanners, opts)`** in `src/scan/run.ts`, returning `CheckOutcome[]` in the file's order
- [ ] Scanners run one at a time. The clock is injectable (`opts.now`). The image pull gets what is left of the overall budget (`opts.totalTimeoutSec`, from `MCPE_SCAN_TIMEOUT`) as its timeout (`ensureImage` gains an optional timeout; today it is a fixed 900 s); after the pull, the scanner gets the smaller of its `timeoutSec` and what is then left. One that would get less than 10 s is not started and is reported `not-run` ("no time left in the scan budget"); so is every later one. The one-shot method's `create` (60 s) and `rm` are outside the budget, which the leg's code comment states.
- [ ] For each scanner: the image is pulled with `ensureImage` (time spent pulling counts against the budget); a pull failure → `failed` with the fixed text "image could not be pulled" (never `ensureImage`'s message, which carries the pull's stderr). Variables named in `spec.env` are read from the environment given in `opts` (default `process.env`); a variable that is unset → `failed` naming the variable, never a value; set to the empty string → passed as empty; a value `validateEnv` rejects → `failed` naming the variable, with fixed text; the file is written under `<dataDir>/tmp` (created with mode 0700) with the proxy's name shape, flag `wx` and mode 0600, and removed in a `finally`, success or not; a failure to write it → `failed` with fixed text.
- [ ] Outcome of a run: `timedOut` → `failed` ("timed out after N s"); stdout `truncated` → `failed` ("output over 8 MB"); `parseSarif` not ok → `failed` with its reason; ok → `ran` with its counts, findings, omitted and notes. A `failed` outcome carries `error`: the reason plus the last 300 characters of stderr through `oneLine`, and `counts` from `emptyCounts()`. The exit code is ignored when stdout is SARIF.
- [ ] Errors are told apart: a `SandboxRefusedError` or the volume check's error from `runScanner` **propagates** and aborts the whole run (every scanner would meet it); any other exception from Docker for one scanner makes that scanner `failed` with the fixed message "Docker did not answer", and the next scanners still run.
- [ ] Nothing a scanner prints reaches the outcome except through `parseSarif` and the bounded stderr tail; `name` and `kind` come from the configuration, and `error` is fixed text plus that tail.
- [ ] **Secrets are redacted**: before an outcome is returned, every occurrence of each value passed to that scanner through `env` (values of 4 characters or more) is replaced with `[redacted]` in its `error`, every finding's message and location, and its notes; scanners that detect secrets routinely print them. Unit case: a scanner given `TOKEN=s3cr3t-value` whose stderr and SARIF message both contain it returns an outcome without it.

**Copy**
- [ ] A method creates an empty, owned volume for a sandbox (labels exactly as `probe` labels a sandbox volume today, no role), refusing if the name exists (the same rule `probe` applies). Leg 7 uses it before the copy.
- [ ] `Docker.copyVolume(from, to)`: both volumes inspected first; `from` must be classified `mine` with role `staging`, `to` `mine` with no role (`before` is refused for both, as above); otherwise it throws with no container created. Runs through the one-shot method with role `copy`, the clone image with `--entrypoint cp`, `--network none`, the extra capabilities `CHOWN`, `FOWNER`, `DAC_OVERRIDE` and `FSETID` (this container alone: it runs no repository code, has no network and reads its source read-only; without them `cp -a` cannot preserve ownership other than root's or read a mode-000 directory), `from` read-only at `/from`, `to` at `/to`, arguments `-a /from/. /to/`; a non-zero exit or a timeout (300 s) throws with the cleaned stderr tail. A failed copy leaves `to` partly written: the caller removes it (leg 7).

**Leftovers sweep**
- [ ] `Docker.sweepCheckLeftovers(maxAgeSec)`: lists containers with this installation's owner label and a role label (`docker ps -a --no-trunc --filter label=<owner>=<id> --filter label=<role>`; repeated label filters are ANDed, `label=k` matches presence; a unit case pins the arguments), keeps those whose role is in the allowlist `clone`, `scan`, `copy` **and** whose owner label equals this installation's id on inspection, and whose `.Created` (parsed with `Date.parse`; `NaN` is a failure, never "old") is older than `maxAgeSec`, and removes each by its full 64-hex id; then the same for volumes with role `staging` (age from `docker volume inspect`'s `.CreatedAt`, which may carry a UTC offset). A thing that is gone by the time it is inspected or removed is skipped, not a failure. It never touches anything without a role label or with another owner, and never throws: Docker failures are counted and returned with the removals (`{ removed: string[], failures: number }`), for the caller to log. Its doc comment states the floor a caller must respect: `maxAgeSec` must exceed the longest a live check can hold these things (clone 600 s + pulls and scan budget + copy 300 s + the staging volume's life through an install), because another process of the same installation may be mid-check; leg 7 computes it from the configuration.
- [ ] Unit cases: a sandbox (no role) of this installation older than the age is not touched; another owner's `scan` container is not touched; a young `staging` volume is not touched; an old `copy` container and an old `staging` volume are removed by id or name; a failed inspect leaves the item and counts a failure.

**Coverage and integration**
- [ ] **First**, the coverage test's table is extended so it can express these methods: a case may list several volumes, each with a class and an optional role (`putVolume` gains a role), and the refusal check runs for each volume position as `another` and `not-ours`, while the `mine` case is set up with the roles the method requires (so a role check cannot make it pass vacuously). `runScanner`, `copyVolume` and the volume creator go in the guarded table with `acts: null`; the sweep goes in `NOT_GUARDED` with the list's comment updated ("acts only on what it listed and re-verified by owner and role") and a `describe` block of its own.
- [ ] Integration (suite prefix; **gated before its first run**): with a fake scanner from the pinned `alpine` (leg 4's constant) and a staging volume made by `probe(…, { volumeRole: "staging" })` of `tomnomnom/gron`: (a) a scanner printing a fixed SARIF document with one `error` and one `note` result gives `ran` with those counts, and cannot write to `/scan` (a second scanner that tries `touch /scan/repo/x` sees a read-only error and the file is absent afterwards); (b) a scanner printing garbage gives `failed`; (c) a scanner sleeping past a 5 s budget gives `failed` ("timed out") and leaves no container (polled for up to 10 s, by the suite owner's label, not by name); (d) before the copy, a throwaway container with default capabilities adds to the staging volume a file owned by uid 1234 gid 1234, a mode-000 directory with a file in it, a symbolic link and an executable file; `copyVolume` into a new sandbox volume preserves all four (`stat -c '%u:%g %a'` and `readlink` in a throwaway container over the copy) and the gron checkout's `HEAD`; (e) on a `Docker` built over a fresh temporary data directory (its own installation id, never the operator's default, whose live staging a `maxAgeSec` of 0 would sweep), the sweep with `maxAgeSec` 0 removes the suite's own leftover `staging` volume and a stopped `scan` container it made for the case, and leaves a volume labelled with another owner id (made by the case, suite-prefixed, removed by the case afterwards through `removeVolumeChecked`).
- [ ] `npx vitest run` passes; typecheck clean; build succeeds; after the gate the Docker suite passes and the operator's containers and volumes are unchanged.

## Verification Steps
- `npx vitest run`; `npm run typecheck`; `npm run build`; gate; `npm run test:docker` saved whole.
- `docker ps -a --filter label=mcp-everything.role` and `docker volume ls --filter label=mcp-everything.role` empty after the suite.
- Trials (exact edits, undone by editing, compared after each undo): (1) mount the scan volume without `readonly`; (2) skip the staging-role check in `runScanner`; (3) let the sweep remove a container whose owner label differs; (4) count a pull failure as `ran`; (5) leave the env file on disk after a run; (6) skip redaction in the stderr tail; (7) drop `CHOWN` from the copy (expected: caught by integration case (d) only — run it after the gate). Report each outcome.

## Implementation Guidance
1. The coverage table's extension first; then the Docker methods with unit cases; then `runScanners` against a fake `Docker`; then the integration cases; stop at the gate.
2. Follow `createContainer` and `probe` for inspecting and classifying volumes; follow `dockerConnector` for the env file (export its helpers rather than copying them).
3. Record in the flight log where each method went in the coverage test.

## Edge Cases
- A scanner list of zero: `runScanners` returns `[]` and starts nothing.
- A scanner whose image is the clone image: allowed; nothing special.
- The budget exhausted by a slow pull: the next scanners are `not-run`.
- `cp -a` under `--cap-drop ALL` alone preserves only root ownership and fails on unreadable directories; hence the copy's four capabilities, and case (d)'s non-root file and mode-000 directory.

## Files Affected
- `src/sandbox/docker.ts`, `src/scan/run.ts` (new), possibly `src/proxy/mcp-proxy.ts` (exports only).
- `test/docker.test.ts`, `test/scan-run.test.ts` (new), `test/integration/docker.test.ts`.

## Citation Audit
Checked by the Flight Director on branch `flight/01-checks-before-code-runs`: in `src/proxy/mcp-proxy.ts`, `ENV_FILE_NAME = /^env-[0-9a-f]{16}$/`, `newEnvFileName`, the env file written under `path.join(cfg.dataDir, "tmp")` with mode `0o600` and `validateEnv`, removed by `removeEnvFile`, swept by `sweepEnvFiles`; in `src/sandbox/docker.ts`, `inspectVolume`, `volumeFacts`, `refuseUnless`, `ensureImage`, and `createContainer`'s volume check. Leg 4's one-shot method and role labels are specified in `legs/04-owned-clone.md` and not yet implemented; names are the Developer's.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
