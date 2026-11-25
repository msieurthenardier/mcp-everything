# Flight Debrief: Groundwork, and Leaving Old Sandboxes Alone

**Date**: 2026-11-24
**Flight**: [Groundwork, and Leaving Old Sandboxes Alone](flight.md)
**Status**: completed
**Duration**: 2026-11-23 (planning) – 2026-11-24
**Legs Completed**: 5 of 5 (four autonomous and the HAT; one wording fix at the HAT)
**Plugin version**: mission-control 1.2.4

## Outcome Assessment

### Objectives Achieved
The flight prepared the code and docs for flight 5. It also closed a path by which one installation could act on a sandbox it cannot prove is its own.

**Docs (leg 1).** The README's three security chapters moved, unchanged in wording, to `docs/checking.md`, `docs/containment.md` and `docs/security-model.md`.
- The README went from 1,596 to 702 lines, with a summary and a link for each chapter.
- `package.json` `files` ships `docs`.
- `test/readme.test.ts` gained a link-resolution test that checks every relative link and anchor across the README and the three docs.
- A normalized diff against `5a5f3fa` was empty for each chapter.
- The operator read the result on GitHub at the HAT: "looks good".

**Clean-ups (leg 2).**
- Squawks 0054–0056 were cleared.
- `App.withheldOf` became the one view of withheld tools, used by all six surfaces.
- The in-process outbound path (the dependency lookup) is recorded in the containment module's comment.
- The slow tests moved to a vitest `slow` project. `npm test` dropped from 18.2 s to about 5 s.

**Split (leg 3).**
- `src/sandbox/docker.ts` (2,898 lines) became seven modules. The class chain is `DockerBase` → `DockerNetwork` → `Docker`.
- `containment.ts` lost its lock scheme to `project-lock.ts` and its shared values to `containment-core.ts`.
- Two independent normalized diffs showed every moved declaration identical: the Developer's diff, and the Flight Director's `movediff.py`.
- The Docker suite was unchanged (66 passed).

**Old sandboxes (leg 4).** A sandbox made before ownership labels (`mcp-everything=1`, no owner label) is refused at the one gate, `refuseUnless`, everywhere: tools, `sandbox_exec`, starts, destroys, volume copies and containment.
- Every message about one carries "Do not remove it yourself; ask the operator."
- The removal commands appear only where the operator reads them: `project_info`'s owner line and the `uninstall_project` result (H1).
- The README, including "On upgrading", and `docs/containment.md` were rewritten to match.

**HAT (leg 5)** ran on the operator's own installation, and all six steps passed.
- One wording fix: a refusal named the sandbox twice. Every refusal now names each part once.
- The operator accepted H1's placement of the commands.
- **Step 6:** the operator then had the Flight Director remove their old `mcpe-gron` sandbox and its volume and reinstall it. The new sandbox, `mcpe-e44f84eb-gron`, belongs to this installation, and its tool runs.

### Mission Criteria Advanced
| Mission criterion | This flight |
|---|---|
| README describes what is checked and when, and what none of it protects against | **Advanced.** Same content, now in `docs/` with summaries, and link-tested. The old-sandbox text is rewritten for DD4 |
| No clone, build or sandbox can reach the host, whatever its network setting | **Advanced.** An old sandbox is never started, so it can no longer run uncontained (the operator's `gron` had been running uncontained for 8 days). **Still open:** labelled sandboxes with no record are never contained |
| Constraint: what mcp-everything creates in Docker is never removed or changed by an installation that does not own it | **Met for old sandboxes.** They were previously treated as this installation's and could be destroyed; now they are refused |
| Checking what a build installed | Not this flight. It is flight 5, planned on top of the split |

## What Went Well
- **Clean-ups before the move, then a normalized diff (DD3, DD5).** Leg 2 landed first, so leg 3's diff ran against code that only the clean-ups had changed.
  - **Developer's diff:** 230 of 230 names identical for `docker.ts`, and 84 of 84 for `containment.ts`.
  - **Flight Director's script:** 220 and 81, counted differently, with the same result.
  - **Docker suite:** the same before and after.
  - The pattern worked for discovery extraction in flight 3, and here at four times the size.
- **The Flight Director's own call graph before the leg 3 design review.** It found a cycle (`runOnce`, `runBehindProxy`, the runtime check) and two upward calls that the Architect's planned ranges had missed. The Developer design review then added R1–R7 (2 high, 3 medium), including `containment-core.ts` as a value-cycle breaker. No code rework followed.
- **H1: messages for agents name no commands.** The leg 4 design review raised that a message carrying `docker rm` reaches an agent holding `sandbox_exec`, which is the mission's own threat model. The Flight Director narrowed DD4, and the operator accepted it at the HAT.
- **Risk tiering was proportionate.**
  - Legs 1 and 2 (low risk) went straight to implementation, with independent Flight Director checks.
  - Legs 3 and 4 (high risk) had one design review each.
  - The flight review found two non-blocking items, both fixed with a mutation proof.
- **The Docker gate held through four suite runs.**
  - Docker object lists were diffed before and after every run.
  - The new and inverted destructive case was read before its first run.
  - The operator's and the Windows installation's objects were untouched.
  - The first run was also the first live confirmation of squawk 0057's fix: 66 passed, against flight 3's 65 passed and 1 failed.
- **The slow-tests recommendation, open since flight 1, is done.** The default run went from 18.2 s to 4.15 s (vitest), with 2,907 of 3,017 tests. The other 110 run in `test:slow`.
- **The HAT surfaced the issues a HAT should.**
  - Wording an operator reads: the doubled name.
  - A placement decision only the operator can make: H1.
  - A real migration of the operator's own old sandbox, done with an inspection first.

## What Could Be Improved

### Process
- **A Developer wrote files with shell commands again, the third flight running.** The fix Developer in the flight review edited `src/server.ts` with a Python one-liner and appended its log entry with a heredoc. The Edit/Write-only rule was in its prompt.
  - **Checks:** the Flight Director found no invisible characters and no stray files. The heredoc put the entry in the wrong place in the log.
  - **Contrast:** the leg 1–4 Developers and the HAT-fix Developer kept to the rule.
  - **Operator's call at this debrief:** keep restating the rule; no hook.
- **The leg 1 Developer rewrote the README with Write, not Edit.** Deleting 1,000 lines with Edit would have needed the whole text as `old_string`. The Flight Director's normalized diff is what made this safe. A docs move leg should name that diff as an acceptance criterion, not leave it to the Flight Director.
- **Squawk 0054's premise was partly stale.** A test from flight 2 already failed on the mutation the squawk described. The leg added the missing checks: the message, no `start`, and the `restartSandbox` route. A squawk bundled into a leg should have its premise rechecked against the current tests at recon. It was rechecked against the code, but not the tests.
- **Leg 2's Files Affected missed `docker-gvisor.yml`.** With inline vitest `projects`, the CLI `--exclude` is ignored. The Developer found it, and the change was accepted.
- **The flight log's Summary was left at "Not yet started"** until this debrief.

### Technical
- **DD4 did not foresee two consequences of "never touch".**
  - **The reinstall warning cannot point to `project_info`.** After a reinstall, `project_info` describes the new sandbox. The deviation was accepted.
  - **`project_info` shows `network: unknown` for an old sandbox.** `networkState`'s inspect goes through the gate and is refused. The owner line explains why, but `unknown` hides the cause on the network line. The Architect calls this arguably a defect.
- **Inheritance chosen for refactor safety.** The chain `DockerBase` → `DockerNetwork` → `Docker` is ordered by call direction.
  - Anything new that calls upward needs a reshuffle or a `protected` hook.
  - 32 members became `protected`.
  - `docker-network.ts` is 1,079 lines and `containment.ts` 992. The size was accepted (R6) but is still debt.
  - `src/server.ts` grew to 1,776 lines (1,723 after flight 3).

  | File | Before | After |
  |---|---|---|
  | `README.md` | 1,596 | 702 |
  | `src/sandbox/docker.ts` | 2,898 | 762 |
  | `src/sandbox/docker-network.ts` (new) | — | 1,079 |
  | `src/sandbox/docker-base.ts` (new) | — | 471 |
  | `src/network/containment.ts` | 1,246 | 992 |
  | `src/server.ts` | 1,723 | 1,776 |
- **Small couplings left by the split.**
  - `containment.ts` re-exports `containment-core.ts`'s names, so a new importer may take either path.
  - `test/containment.test.ts` reaches a private member through `.locks`, which will break on the next move.
  - `test/sources.ts` must list every new module under `src/sandbox/`, or the bypass tests stop seeing it.
  - Tests that read source text are cheap and caught a planted method in a mutation trial, but they pin structure more than behavior.
- **Test infrastructure debt.**
  - The CI floor is still 867 passing tests, against 3,017. It would not catch a silent drop of two thirds of the suite.
  - `SLOW` is a hand-kept list in `vitest.config.ts`, so a new slow file lands in `default` unnoticed.
  - One un-named unit failure was seen once in leg 4 (a bare run) and did not reproduce in two reruns. Flight 3's baseline had a similar one under load, also un-named.
- **Still a gap:** labelled sandboxes with no record are never contained. The docs say so.

### Documentation
- The new `docs/` chapters are link-tested.
- **Not written down for contributors:**
  - the three test entry points (`npm test`, `npm run test:slow`, `npm run test:docker`) and what each covers;
  - where the ownership classes and the one gate live (`ownership.ts`, `docker-base.ts` `refuseUnless`).
- **`mission.md`'s flight 5 entry** still carries the original tentative flight-4 text (marked as such). It should be trimmed when flight 5 is planned.

## Deviations and Lessons Learned

| Deviation | Reason | Standardize? |
|-----------|--------|--------------|
| H1: removal commands only in `project_info` and `uninstall_project`, not in every message (narrows DD4) | A message carrying `docker rm` reaches an agent that can act on it | Yes: messages an agent receives carry a prohibition and a pointer; commands go to operator-facing surfaces only |
| Reinstall warning without "see project_info" | After a reinstall, `project_info` describes the new sandbox | Accepted |
| R1: `containment-core.ts`, re-exported from `containment.ts` | It breaks a value cycle without touching the containment importers | Yes, for pure moves |
| The class chain's boundaries from the Flight Director's call graph, not the plan's line ranges | The planned ranges created a cycle | Yes: compute the call graph before a split leg's design review |
| `docker-gvisor.yml` run A names its file | Inline vitest `projects` ignore the CLI `--exclude` | Accepted; noted for any future workflow edit |
| Leg 1's README rewritten with Write | Deleting 1,000 lines with Edit is impractical | Only with a normalized diff as an acceptance criterion |
| HAT wording fix across every refusal class, not only `before` | The duplication was in the one shared builder | Yes |
| HAT step 6 carried out by the Flight Director, at the operator's explicit request, after inspecting both objects | The operator delegated the removal | Accepted as the operator's decision; the default remains that the operator runs it |

## Key Learnings
- **A pure move is verified by name, not by line.** Split the old file into named declarations and members, find each in the new files, strip only the permitted edits, and compare. Two independent scripts agreed. Mutation trials (a planted method, a list entry removed) proved the source-reading tests see the new files.
- **Compute the call graph before splitting a class.** The plan's ranges looked right and would have created a cycle. A call graph from the code takes minutes and decides the module boundaries.
- **Know who reads each message.** A tool error goes to an agent; `project_info`'s owner line and an uninstall result are read on the operator's behalf. Wording that is helpful to an operator ("run `docker rm -f …`") is an instruction to an agent.
- **"Never touch" reaches read-only surfaces too.** Refusing a class at the one gate also refuses status reads. Each status surface should then say why it shows nothing, not just `unknown`.
- **Recheck a squawk's premise against the tests, not only the code,** before bundling it into a leg.

## Methodology Observations
- **Agentic-workflow, Developer rules (1.2.4).**
  - **What happened:** the review-fix Developer edited `src/server.ts` with a Python one-liner and appended to the flight log with a heredoc. The Edit/Write-only rule was restated in its spawn prompt.
  - **Expected:** no shell writes.
  - **Cost:** a Flight Director check for invisible characters and stray files, and a misplaced log entry left in place.
  - **History:** the third flight running (flights 2, 3 and 4). In this flight, 5 of 6 Developer spawns kept to the rule, including the leg Developers and the HAT-fix Developer.
  - **Operator's call:** keep restating, no hook.
- **Agentic-workflow, review-fix spawns (1.2.4).**
  - **What happened:** the rule broke in the shortest spawn, the "Fix Review Issues" one. Its prompt is built from the Reviewer's findings, and the project rule sits further from the task than in an Implement spawn.
  - **Recorded:** as a possible pattern for the sweep. One instance is not a trend.
- **Agentic-workflow, leg design for splits (1.2.4).**
  - **What happened:** the flight's Architect review gave line ranges for the class split. The Flight Director's own call graph from the code found that those ranges created a cycle, and corrected the assignment before the Developer design review.
  - **Expected:** the leg-design risk checks cover reachability, caches and interfaces. A "dependency direction" check for structural moves was not prompted; the Flight Director did it unprompted.
  - **Cost:** none, because it was caught at design. It would have been a leg 3 divert ("cannot be done without changing a method body").
- **Flight skill, Phase 1b recon (1.2.4).**
  - **What happened:** the recon checked squawk 0054 against the code and classified it `confirmed-live`. A test that already covered most of it was found only at implementation.
  - **Expected:** recon of a defect item to check the existing tests as well as the cited code.
  - **Cost:** one deviation note; no rework.
- **Agentic-workflow, HAT fix-vs-feature gate (1.2.4).**
  - **What happened:** worked as written. A wording request was classified out loud as a fix. It spanned one function and three test files, so it was reviewed by a Reviewer rather than given a design review.
  - **Why recorded:** a positive data point.
- **Agentic-workflow, HAT legs on an MCP server (1.2.4).**
  - **What happened:** each code change at the HAT needed a rebuild and an operator `/mcp` reconnect before re-verifying. This was planned into the leg's steps this time, following flight 3's observation, and cost one round-trip.
  - **Why recorded:** a positive data point.
- **Flight-debrief, crew interviews (1.2.4).**
  - **What happened:** both interviews returned usable input. The Developer reconciled the test totals (2,907 + 110 = 3,017).
  - **Correction needed:** the Architect read "line ranges were wrong" as the Architect review's fault. The ranges came from the planning Architect, and the correction from the Flight Director's call graph.

## Recommendations
1. **In flight 5's design, name the new ownership surfaces.** Flight 5 moves build output onto a volume, and that volume needs ownership handling.
   - Its classification must go through `classifySandbox` and `refuseUnless`.
   - Check whether it creates a new way to obtain a `SandboxRef`, and update the bypass tables and `test/sources.ts` in the same leg as any new method or module.
   - Decide there what a reinstall does when the old sandbox is `before`: it is left in place, and the new one is built on fresh names.
2. **Make `project_info` say why it does not know an old sandbox's network.** "not inspected: made before ownership was recorded", rather than `unknown`. Squawk 0061.
3. **Raise the CI floor from 867 to about 2,900 passing tests.** At 867 it no longer catches a large silent drop. Squawk 0062.
4. **Name the intermittent unit failure.** Run the suite several times under load (`npx vitest run` in a loop with CPU contention), and squawk the test once named.
5. **For a split or move leg, compute the call graph and make the normalized diff an acceptance criterion.** Both decided this flight's outcome, and neither came from the leg template.

## Action Items
- [ ] Flight 5 planning: recommendation 1; trim `mission.md`'s flight 5 entry of the old flight 4 text; carry flight 3's recommendation 4 (sample data shapes).
- [ ] Squawk 0061: `project_info` network line for an old sandbox (recommendation 2).
- [ ] Squawk 0062: raise the CI floor (recommendation 3).
- [ ] Investigate the intermittent unit failure (recommendation 4); a squawk once the test is named.
- [ ] Later: labelled sandboxes with no record are never contained (needs design; a flight or sortie).
- [ ] Later: a contributor note on the three test entry points and where the ownership gate lives.
- [ ] Anomaly closed: the `afp-reh-probe-twin-*` Docker objects belong to another of the operator's tools (operator, at this debrief).

## Test Metrics
Measured on the flight branch at `a5d7ec4`, one run each, by the debrief Developer.

| Run | Files | Passed | Skipped | Failed | Wall | Vitest |
|---|---|---|---|---|---|---|
| `npm test` (default project) | 40 (+2 skipped) | 2,907 | 71 | 0 | 5.0 s | 4.15 s |
| `npm run test:slow` | 2 | 110 | 0 | 0 | 18.5 s | 17.0 s |
| `npx vitest run` (both) | 42 (+2 skipped) | 3,017 | 71 | 0 | 19.5 s | 18.9 s |

- **The default run dropped from 18.2 s to 4.15 s.** `proxy-server.test.ts` (about 17 s, real sockets) and the 16 real-shell cases now in `docker-shell.test.ts` (about 13 s) run only in `test:slow`.
- **The full run is unchanged** (18.2 s at flight 3, 18.9 s now). The split moved the cost; it did not remove it. CI still runs both projects.
- **Against earlier flights** (`npx vitest run`, passed tests and time):
  - mission 02 flight 01: 833 passed, 1.78 s;
  - mission 03 flight 01: 1,511, 13.35 s;
  - flight 02: 2,751, 17.4 s;
  - flight 03: 2,987, 18.2 s;
  - now: 3,017, 18.9 s.
- **Test count:** +30 over flight 3.
  - Leg 1: 5 link tests.
  - Leg 2: −2.
  - Leg 4: +20, of which 14 are in `old-sandboxes.test.ts`.
  - Flight review: +1.
  - HAT fix: +5.
  - The flight baseline was 2,988 (2,987 at flight 3's debrief).
- **Skips** unchanged at 71.
- **Flakes:** none in the debrief's runs. One un-named failure in leg 4's un-timeouted run did not reproduce in two reruns (recommendation 4).
- **Docker suite** (`npm run test:docker`, Docker 29.8.2, Docker Desktop): 66 passed, 5 skipped, 0 failed on all four runs:

  | Run | Time |
  |---|---|
  | Baseline | 678.8 s |
  | After leg 3 | 693.3 s |
  | After leg 4 | 724.2 s |
  | After the review fixes | 669.9 s |

  - **Against earlier flights:** flight 3 had 65 passed and 1 failed (squawk 0057, now fixed) in 756.8 s; flight 02's leg 14 run took 646 s; flight 01 about 280 s.
  - **Docker objects:** the lists matched before and after every run, apart from the `afp-reh-probe-twin-*` objects. Those belong to another of the operator's tools.
- **Typecheck** and **build**: clean.
