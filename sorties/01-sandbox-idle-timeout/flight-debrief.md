# Flight Debrief: Sandbox Idle Timeout

**Date**: 2026-11-15
**Flight**: [Sandbox Idle Timeout](flight.md)
**Status**: landed
**Duration**: 2026-11-15 - 2026-11-15 (planning, execution and debrief in one session)
**Legs Completed**: 1 of 1
**Plugin version**: mission-control 1.2.3 (1.2.4 was available and not installed)

## Outcome Assessment

### Objectives Achieved
New sandboxes run a watchdog as their entrypoint and stop themselves after `MCPE_SANDBOX_IDLE_TIMEOUT` seconds without activity (default 1800, `0` disables). The existing liveness check restarts them on the next call, a call that lands as the sandbox stops is retried once, and network state survives a stop in both directions. The change is one commit (`b041bd0`) in an open pull request (#1), not yet merged.

**One defect was found during this debrief, after the flight was reviewed, committed and its pull request marked ready.** When a sandbox is at its process limit and something keeps competing for free PID slots, the watchdog cannot fork its `sleep`, the shell exits with status 2, and the container stops, killing whatever was running in it. Verified on a throwaway container (`buildpack-deps:stable`, dash, `--pids-limit 16`, a process forking continuously): the container was stopped with exit code 2 within 2 seconds and the watchdog's stderr read `Cannot fork`. With `sleep infinity`, as on `main`, a build that exhausts its process limit sees fork failures but keeps its sandbox. The flight spec's DD2 says the watchdog "reads that as activity and spins until it can"; that statement was never tested and is false on dash. Busybox `sh` was not tested for this.

### Charter Success Criteria

| Criterion | Result | Notes |
|-----------|--------|-------|
| A sandbox with no activity for the configured period ends up stopped, with its volume and installed tools intact | Met, for sandboxes created after the change | Integration case: stopped with exit code 0, files under `/opt/mcpe/bin` and `/workspace/work` intact after restart. Sandboxes created before the change never stop until reinstalled (DD6, accepted at charter time, but the criterion's wording does not carry that scope). |
| The next tool call against a stopped sandbox succeeds without user intervention, and its network setting is unchanged | Met | Integration cases cover an exec straight against a stopped sandbox (through the retry), offline staying offline (checked inside the container), online staying online, and a network change made while stopped. The retry recognises three Docker failure wordings; only the "already stopped" one is exercised against a real daemon. |
| A sandbox is never stopped mid-work: a running tool call, an install, or a live proxied MCP server counts as activity | **Not met** | Holds for a long exec, repeated short execs and a live proxied server (integration cases, asserted by an unchanged `.State.StartedAt`). Fails when the sandbox is at its process limit: the watchdog dies and takes the container with it (see above). An install was not tested as such; the long exec stands in for it. |
| With no configuration the timeout is 30 minutes; the env var overrides it, and it is documented in the README table | Met | Unit tests for the default, override, `0` and invalid values; README row present. The variable was renamed from `MCPE_IDLE_TIMEOUT` to `MCPE_SANDBOX_IDLE_TIMEOUT` by the operator during design. |

### Checkpoints
All five flight checkpoints were met as written. None of them covered behavior at the process limit.

## What Went Well
- **Premise checks on throwaway containers before and during design.** PID-gap detection, network state across restart in both directions, network changes on a stopped container, the stop window, and the actual error strings of a racing `docker exec` were all measured, not assumed. Reviewers and the debrief Developer could judge the code against recorded evidence instead of re-deriving it.
- **Each design review found real defects.** Cycle 1: a retry rule that could re-run a command, cleanup that would wake a stopped sandbox, and a watchdog that resolved `sleep` through a project-writable `PATH`. Cycle 2: a state check that failed the loser of two concurrent calls, and a proxy rule described as equivalent when the proxy cannot see an exit code. Leg review: "stays running" tests that would pass after a wrongful stop, because the retry hides it.
- **The `.State.StartedAt` assertion.** Where a self-healing layer can mask the bug under test, asserting that the container was never restarted is what makes the test able to fail. Reusable wherever auto-restart exists.
- **The implementation landed with no deviations and passed code review on the first pass.** The retry is a pure, exported predicate with a test per table row and per not-retried case.
- **One leg was the right breakdown.** The first Architect pass asked for three; the split was declined with reasons, and both the debrief Architect and Developer agree the single leg fit the work.

## What Could Be Improved

### Process
- **A stated failure mode went untested.** DD2 described what the watchdog does on fork failure as a trade-off, in the same list as measured facts. It was an inference. The leg then made a guard "welcome, not required", so it was not built, no acceptance criterion covered it, and the code review, which checks criteria, could not see it. The same discipline applied to design premises should apply to trade-off claims: either measure the claimed behavior or label it unverified.
- **The race stress test came one review cycle late.** The first draft of DD4 asserted that a matching failure meant the command "provably never started" on the strength of one observed error. The 90-attempt stress test was run only after the first review challenged it. Running it before the first review would likely have saved the first DD4 redesign.
- **The second DD4 redesign was also avoidable.** Two questions answerable by reading code at planning time would have reached the final rule sooner: can a container be stopped for reasons other than idling (yes, so a state check is the wrong test), and can every caller see the exit code (the proxy cannot).
- **The final version of DD4 was never independently reviewed as a design.** The second review cycle rewrote the central decision and the two-cycle cap sent it to the operator as revised. It held up in code review, but the rule's author was its only design reviewer.
- **The pull request was marked ready before the debrief.** The workflow does this by design; here the debrief is where the defect surfaced, so the pull request advertised a criterion as satisfied that is not.

### Technical
- **Watchdog dies on fork failure** (defect, above). Needs a design decision, not a one-line guard: dash exits on any failed fork, so the watchdog must either restart itself without forking or avoid forking per poll.
- **The watchdog's behavior is covered only by the opt-in Docker suite.** Unit tests assert the script's text. Nothing runs in CI. The default configuration (1800 s timeout, 15 s poll) has never been executed for real; every live run used 6 s and 1 s.
- **Three mechanisms now handle a stopped sandbox**: the `ensureRunning` pre-check in callers, the retry in `Docker.exec`, and the state-based relaunch in `McpProxy.open`. The proxy needs its own because its connector spawns `docker exec` itself rather than going through `Docker.exec`.
- **`McpProxy.open` is the awkward seam.** The retried error is produced by string replacement on a message built in another method, and a local variable named `attempt` shadows the method of the same name.
- **The `mcp-everything.idle-timeout` label is written and never read.** Nothing in the product tells an operator which sandboxes idle-stop and which predate the change.
- **The installer's swallowed exec errors matter more now.** Discovery treats a failed exec as "no result". With stops now routine, an unrecognised stop failure during an install would be recorded as a missing tool. Unlikely at the default timeout, reachable with a small one.
- **The retry depends on Docker's wording.** Three strings from one Docker version, two of them from two samples. A reworded message turns the retry off silently; nothing logs that a stop failure went unrecognised.
- **`nonNegativeInt` duplicates `int()`** and inherits its leniency (`"45abc"` parses as 45) without a test for it.
- **Not verified**: gVisor (`runsc`); busybox `sh` in the integration suite (checked by hand at planning only).

### Documentation
- The README does not say that a sandbox at its process limit can now be stopped. It should not need to; the defect should be fixed instead.
- The README does not mention the `mcp-everything.idle-timeout` label, which is currently the only way to tell old sandboxes from new ones (`docker inspect`).

## Deviations and Lessons Learned

| Deviation | Reason | Standardize? |
|-----------|--------|--------------|
| Setting renamed from `MCPE_IDLE_TIMEOUT` (charter) to `MCPE_SANDBOX_IDLE_TIMEOUT` | Review found it easy to confuse with `MCPE_MCP_IDLE_TIMEOUT`; the operator chose the rename | No, one-off |
| `0` disables the timeout, beyond the charter | Keeps the previous always-running behavior available; confirmed by the operator at spec approval | No, one-off |
| Three-leg split requested in review, declined | No human decision or irreversible step between the parts; one review and commit either way | Yes: decline splits by task type and record why |
| No third design review after the second cycle rewrote DD4 | Two-cycle cap | No: see Recommendations |
| Second leg design review skipped | Changes were the reviewer's own recommended fixes, none to the approach | Yes, when that condition genuinely holds |

No deviations were recorded during implementation.

## Key Learnings
- A trade-off sentence in a design decision is a claim about behavior and deserves the same evidence as the decision itself. The one unmeasured claim in this flight was the one that turned out false.
- When adding a layer that restarts things automatically, tests of "it kept running" must observe the restart directly. A success check alone will pass.
- "Provably never started" is an empirical claim. Collect the failure outputs first, then write the rule.
- A shell watchdog that forks every poll inherits the shell's fork-failure behavior, and in dash that is fatal to the script. Anything running as a container's main process should be designed around what happens when it cannot fork.
- A criterion consciously left out of a leg is invisible to code review. If a risk is named, the leg should either require the mitigation or the flight log should list it as accepted debt.

## Test Metrics
This is the first debrief in the project, so these numbers are the seed for later comparisons. The only earlier figure is the planning baseline.

- **Unit suite** (`npm test`): 15 files passed, 1 skipped (the integration file); 268 tests passed, 12 skipped, 0 failed; 1.46 s. Baseline before the flight: 225 passed, 6 skipped. The 43 new tests are `test/config.test.ts` (6), `test/docker.test.ts` (28) and 9 added to `test/proxy.test.ts`; the 6 new skips are the idle-timeout integration cases, skipped without `MCPE_DOCKER_TESTS`. Slowest unit tests: one at about 1 s ("leaves the project unchanged when the server does not start"), two between 100 and 210 ms.
- **Docker integration suite** (`npm run test:docker`): 12 passed, 0 failed, 140 s. The six pre-existing cases take about 45 s (install 15.5 s, rebuild on another image 16.4 s, proxy 9.6 s, the rest under 3 s each). The six new idle-timeout cases take about 94 s, between 11.6 s and 19.0 s each, because each waits out real idle periods. This flight roughly tripled the suite's run time.
- **Flakes**: none in three full runs (Developer, Reviewer, debrief). The idle cases are timing-sensitive by nature; the closest margin observed was a 17.8 s case against 21 s stop deadlines.
- **Skips**: the entire integration file is skipped unless opted in, and there is no CI, so the only regression net for the watchdog is someone running the Docker suite by hand.

## Methodology Observations
All observed with mission-control 1.2.3.

- **Flight skill, Phase 4 (crew interview, design decisions).** The skill says a decision resting on an empirical premise should have the premise verified before it is locked. The Flight Director applied that to each decision's premise but not to the trade-off statements listed under the decisions, and nothing in the skill or the flight format distinguishes a measured trade-off from an inferred one. Expected: a prompt to mark each stated failure mode as verified or unverified. Cost: one false statement in the spec (watchdog behavior on fork failure) and a defect that reached a committed, reviewed pull request and was found only at debrief.
- **Agentic-workflow skill, Phase 2a (leg design).** The leg carried a named risk forward as optional ("a guard is welcome … it is not required"). The skill's risk checks cover schema, reachability, cache freshness and interface changes; none asks whether every risk the flight spec names has ended up as a required criterion, an explicit acceptance, or a logged debt. Expected: a named risk cannot be left optional without the flight log saying it was accepted. Cost: the mitigation was not built and the gap was not visible in the log's Deviations, Anomalies or "not verified" entries.
- **Flight skill, Phase 5b (design review, two-cycle cap).** The second cycle's findings caused the central decision to be rewritten, and the cap sent the rewrite to the operator with no independent look. Expected: when the last permitted cycle forces a rewrite of a decision, a narrow re-check of that decision alone. Cost: none observed here (the rule survived code review); the exposure is a design reviewed only by its author.
- **Flight skill, Phase 5b (design review), earning its cost.** Two Architect cycles and one leg review for about 150 lines of production change. Each round produced at least one finding that would otherwise have shipped. Recorded as working as intended, with a high design-to-code ratio.
- **Agentic-workflow skill, Phase 3 (flight completion).** The workflow marks the pull request ready for review and signals completion before the debrief runs. Expected: nothing different in general, but on this flight the debrief found a defect, so the pull request sat "ready" while advertising an unmet criterion. Cost: a correction to the pull request after the fact.
- **Agentic-workflow skill, Phase 2d (flight review).** The Reviewer confirmed with no blocking issues, correctly: every acceptance criterion was met. The review is scoped to criteria, so a design-level gap outside them passed. Recorded, not judged.
- **Sortie skill, charter.** The charter's first success criterion says "a sandbox"; the operator had agreed in conversation that sandboxes created before the change are out of scope, but the criterion text never carried that. Expected: scope caveats agreed at the charter gate written into the criterion. Cost: a criterion that reads as met only with a qualification added at debrief.
- **Sortie skill, right vehicle?** Yes. One outcome, one cluster of decisions, one leg, no second cluster surfaced. It was not a squawk (it needed design decisions and touched lifecycle and a shared interface) and not a mission. The defect found here is a gap inside the same decision cluster, not evidence of a second one.
- **Flight log conventions.** The Developer's leg entry in the log still read `landed` after the leg file was set to `completed`; the completion steps update the leg file and the flight but nothing prompts updating the log's own per-leg status line. Corrected during this debrief. Cost: a few minutes and one inconsistent artifact in the commit.

## Recommendations
1. **Fix the watchdog's behavior at the process limit before merging pull request #1.** It is a regression relative to `main` for any build that saturates its process limit, and the spec's description of it is wrong. It needs a small design decision (how a shell that cannot fork keeps the container alive), so it is a short follow-up sortie rather than a squawk, with an integration case that holds a sandbox at its limit and asserts `.State.StartedAt` is unchanged.
2. **Mark stated failure modes as measured or unmeasured in design decisions**, and require that any risk a flight spec names ends up in the leg as a criterion or in the flight log as accepted debt.
3. **Give the watchdog a regression net that runs without being asked**: at minimum run the Docker integration suite in CI, and add one live case at a realistic poll interval.
4. **Surface idle-stop status in `project_info`** using the existing label, so operators can see which sandboxes still need a reinstall. This adds behavior, so it is sortie material, possibly together with a migration path for existing sandboxes.
5. **Route the proxy's launch through one owner of "restart on demand"** so the stopped state is handled in one place, and make installer discovery distinguish "the command never ran" from "the command failed".

## Action Items
- [x] Follow-up sortie: watchdog must survive fork failure (Recommendation 1). Done as [sortie 02](../02-watchdog-survives-fork-failure/flight.md), commit `5cf4fad`.
- [x] Pull request #1 returned to draft with a comment describing the defect (operator's decision at debrief).
- [x] Squawk 0001 (completed 2026-11-15, pull request #2): in `McpProxy.open`, carry the failure reason as a field instead of rewriting the message with `replace`, and rename the local `attempt` that shadows the method.
- [x] Squawk 0002 (completed 2026-11-15, pull request #2): add `loadConfig` cases for lenient values (`"45abc"`, `"1.5"`) of `MCPE_SANDBOX_IDLE_TIMEOUT`.
- [x] Squawk 0003 (completed 2026-11-15, pull request #2): README note that `docker inspect` on the `mcp-everything.idle-timeout` label shows whether a sandbox has the timeout.
- [ ] Later flight: CI for the Docker suite; idle-stop status in `project_info`; single owner for restart-on-demand; installer discovery error handling; gVisor and busybox verification.

## Follow-up — 2026-11-15

Added after [sortie 02](../02-watchdog-survives-fork-failure/flight-debrief.md) landed and was debriefed. The assessment above is left as written; this records what changed afterwards.

- **The defect is fixed.** The watchdog now retries a failed fork instead of exiting (commit `5cf4fad` on this branch). Against the script this flight shipped, sortie 02's pressure cases stop the container with exit code 2 on both dash and busybox; against the fixed script they passed 30 of 30 runs per shell, and 10 of 10 per shell in independent review.
- **The third charter criterion** ("a sandbox is never stopped mid-work") is now recorded as **met for the failure that was found**: on the two default images, under the tested pressure. It is not established as a general property. Still not shown: shells other than dash and busybox, fork failures from causes other than the process limit, retrying for longer than about a minute, gVisor, and an install as such. The repeated runs bound the failure rate at roughly 10%; they do not rule out a rare failure.
- **This debrief's statement that the spec was wrong stands.** The spec said the watchdog "spins until it can" fork. That is what the watchdog does now; it is not what it did when that sentence was written.
- **Recommendation 3 (a regression net that runs without being asked) was not acted on, and the gap grew.** Sortie 02's pressure cases are opt-in, by the operator's decision that they are too slow for every review. See sortie 02's debrief, Recommendation 1.
- **The three squawks** logged from this debrief were completed the same day and are on this branch (`7cb69fd`).
- **Status**: with the defect fixed, the operator directed that this sortie be closed; set to `completed`.
