# Leg: checked-install-server

**Status**: completed
**Flight**: [Checking a Project's Own Code Before It Runs](../flight.md)

## Objective
Wire the checked install into the server: choose the entry point by the scanning mode, word the result from the outcome, show a project that is being checked, start the leftovers sweep at startup, and prove the whole against real Docker.

## Context
- Flight DD6, DD8. Split from the first draft of `check-before-build` at its design review (2026-11-22); leg 7 (`checked-install`) provides `installChecked` and `InstallOutcome`.
- `describe()`'s `security:` line, `check_project` and the instructions' security paragraph are leg 9's. Until then a warn-mode install's findings are stored in `record.scan` but not shown in the install result; the integration case reads the registry for them.
- Leg 6's `sweepCheckLeftovers(maxAgeSec)` never throws and returns `{ removed, failures }`.

## Inputs
- Legs 1–7 landed.
- `src/server.ts` — `Job { promise: Promise<ProjectRecord>; log; startedAt }`; the `install_project` handler (key `repo.id.toLowerCase()`; `.finally`, `.catch`, the race, `describe(done)`); `project(args)` (accepts slug, id or bare path; throws "No installed project"); `project_info` (with `ownerLine(project, job !== undefined)`); `list_projects` (early return "No projects installed" when the registry is empty); `start()` (`this.startup` running `reconcileStale` un-awaited inside `if (!this.startup)`).
- `test/helpers.ts` — `FakeDocker extends Docker`.
- `test/server.test.ts` — the startup cases asserting the exact `log` (an empty log; a two-line log), and a case injecting a job `{ promise, log, startedAt }`.
- `test/integration/docker.test.ts` — Apps over a shared data directory; `mayRemove`; the pinned `alpine` constant (leg 4).

## Outputs
- `src/server.ts`, `test/helpers.ts`, `test/server.test.ts`, `test/integration/docker.test.ts`.

## Acceptance Criteria

**Entry point and job**
- [ ] `install_project` calls `installChecked` when `cfg.scan.mode` is not `off`, and `install` otherwise (its record wrapped as `{ kind: "installed", record }`). `Job.promise` becomes `Promise<InstallOutcome>`; `Job` gains `stage?: "checking" | "installing"` (absent means `installing`; the scan-off path sets `installing`; the hooks set `checking` then `installing`) and the repository's id, so a job can be found from a bare `owner/name` as well as an id.

**Wording, from the outcome's kind** (never from `status` alone)
- [ ] `installed` → exactly today's texts (ready; failed with the sandbox kept; nothing installed).
- [ ] `blocked` → an error result: "Blocked by the scan policy: <decision reason>." Then, with `kept`: "<slug> was left as it was" plus ", at commit <12 hex>" when it has a commit, and its status when not `ready`; without: "Nothing was installed." Then each check's name, status, counts and its kept findings, as stored (already bounded and cleaned).
- [ ] `check-failed` → an error result: "The check could not be completed: <reason>." then the same `kept` / nothing-installed sentence. Neither wording says "Generated tools are callable".
- [ ] A rejection of `installChecked` (a failed retire, as with `install()`) keeps today's path.

**Being checked**
- [ ] `project_info`: when the argument resolves to a record, it shows the record as today, adding "being checked" while its job's stage is `checking`, and `ownerLine` is passed `job?.stage === "installing"` (during a reinstall's check the old sandbox is live). When it resolves to no record, the argument is parsed as a repository (`parseRepoRef` with the configured hosts, in a try) and, if a job exists for that repository id, `project_info` reports the job (repository, stage, seconds so far, recent output) instead of "No installed project". A `check:`-prefixed job key (leg 9) never matches.
- [ ] `list_projects`: jobs that have no record are listed on lines of their own ("<repo id>: being checked" or "installing"), and the "No projects installed" early return does not hide them.
- [ ] The five refusals that test `jobs.has` are unchanged; `call_project_tool` on a reinstalled project still works during its check.

**Startup sweep**
- [ ] Inside `if (!this.startup)`, beside `reconcileStale`, `docker.sweepCheckLeftovers(600 + cfg.scan.timeoutSec + 300 + 1800)` runs, whatever the scan mode; both are folded into `this.startup` (for example with `Promise.all`), so code and tests that await `startup` cover it; its result is logged only when something was removed (names) or failed (a count); a rejection (from a double) is caught and logged.
- [ ] `FakeDocker` overrides the sweep: it records its argument and returns `{ removed: [], failures: 0 }` by default, so no unit test shells out to `docker`; the existing startup cases' exact logs are unchanged.

**Tests**
- [ ] Unit (`test/server.test.ts`): the entry point by mode; the three wordings, including `kept` without a commit and with a non-`ready` status; `project_info` for a job being checked with a record (and `ownerLine`'s argument), without a record by id and by bare `owner/name`, and that a `check:` key never matches; `list_projects` with only a record-less job; the sweep started with the computed floor, logged only when it did something, a rejection caught. The existing injected-job case passes with `stage` absent.
- [ ] Integration (**gated before its first run**; a new `describe` over a fresh temporary data directory — its own installation id — with a distinct suite-prefixed name prefix; `MCPE_SCAN=block` and `MCPE_SCANNERS` pointing at a file written in that directory naming one fake scanner from the pinned `alpine` that always prints one `error` result; an `afterAll` that uninstalls and removes what the cases made, through the suite's checked helpers): (a) installing `tomnomnom/gron` is blocked, leaves no record and no role-labelled container or volume of that installation (polled for up to 10 s); (b) gron installed by a scan-off `App` over the same data directory, then a reinstall by the blocking `App` is blocked, the project's `gron` tool still runs through `call_project_tool` on a small JSON input, and the warning names the commit; (c) with `MCPE_SCAN=warn`, a reinstall builds; the registry's record has `scan` with the fake scanner's `error` and the decision `build`; the sandbox's checkout `HEAD` is the scanned commit.
- [ ] `npx vitest run` passes; typecheck clean; build succeeds; after the gate the Docker suite passes and the operator's containers and volumes are unchanged.

## Verification Steps
- `npx vitest run`; `npm run typecheck`; `npm run build`; gate; `npm run test:docker` saved whole; operator's objects compared with the flight log; `docker ps -a --filter label=mcp-everything.role` and `docker volume ls --filter label=mcp-everything.role` empty afterwards.
- Trials (exact edits, undone by editing, compared after each undo): (1) word a blocked reinstall from `status` (`ready`); (2) let the sweep's floor ignore `cfg.scan.timeoutSec`; (3) let `project_info` match a `check:` key; (4) call `install` regardless of mode. Report each outcome.

## Edge Cases
- Two `install_project` calls for one repository join one job, as today; the stage is the job's.
- `wait_seconds` running out during the check: today's "Still installing" text, with "(checking)" when the stage is `checking`.

## Files Affected
- `src/server.ts`, `test/helpers.ts`, `test/server.test.ts`, `test/integration/docker.test.ts`.

## Citation Audit
From the first draft's design review (2026-11-22), confirmed by the Flight Director's reading: `FakeDocker extends Docker` in `test/helpers.ts`; the job key `repo.id.toLowerCase()` and the job's consumers in the `install_project` handler (creation, `.finally`, `.catch`, the race, `describe(done)`), none elsewhere; `project()` accepting slug, id or bare path; `ownerLine(project, job !== undefined)` in `project_info`; `list_projects`' early return when empty; the startup cases asserting an empty and a two-line `log`; the injected job without `stage`; two Apps over one data directory already used in the integration suite; `MCPE_SCANNERS` read by `loadConfig`. Line numbers drift; quoted names are authoritative.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
