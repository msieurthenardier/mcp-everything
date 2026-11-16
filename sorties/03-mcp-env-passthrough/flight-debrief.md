# Flight Debrief: MCP Env Passthrough

**Date**: 2026-11-15
**Flight**: [MCP Env Passthrough](flight.md)
**Status**: landed (set to `completed` at the end of this debrief, on the operator's confirmation)
**Duration**: 2026-11-15 - 2026-11-15 (planning, execution, acceptance session and debrief in one session)
**Legs Completed**: 3 of 3
**Plugin version**: mission-control 1.2.3 (1.2.4 was available and not installed)

## Outcome Assessment

### Objectives Achieved
A variable named `{slug}__{NAME}` in the environment of the mcp-everything process now reaches every MCP server of the project with that slug as `NAME`. The merge happens in memory at each launch, through one method (`Installer.launchSpec`), and what is stored is never touched. A new meta tool, `refresh_mcp(project)`, stops a project's MCP servers and reruns discovery, and says what started, what did not and what disappeared. `project_info` lists the names a project receives; the discovery warnings, the server instructions and the `connect_mcp_server` descriptions point to the route; the README documents both ways of giving a server its environment, says which is safe, and states the limits.

The change is 223 added lines in four source files (one of them new, `src/proxy/host-env.ts`, 71 lines), 933 lines of tests, and about 110 lines of README, in pull request #4 (commits `3d52778` and `94519d7`, with squawk 0008 logged separately in `0d108f9`). The pull request is open and not merged.

No defect was found in this debrief. It found one named risk that ended up neither tested nor documented, one behavior the Developer would have designed differently, and some small debt.

### Charter Success Criteria

| Criterion | Result | Notes |
|-----------|--------|-------|
| With `mcp_booking__API_KEY=x` in the environment of the mcp-everything process, an MCP server of the project with slug `mcp_booking` is started with `API_KEY=x` | Met | Unit: a test per launch site asserts the launched environment (`callGenerated`, `connectMcp`, both loops of `discoverMcp`). Docker: a shell server registered with a different stored value reports the environment's value. Acceptance session: after a real reconnect of the operator's client, a stand-in server's tool returned the dummy value set as `gron__HAT_KEY`. |
| An MCP server that could not start when its project was installed, for lack of a variable, publishes its tools once the variable is present and `refresh_mcp` is called | Met, with one qualification | Unit, on a scripted sandbox: installed without the variable (no server, a warning), then a second `App` on the same data directory with the variable calls `refresh_mcp` and the tools are published. Docker and the acceptance session show the same with a real process, but there the "could not start" state was produced by a discovery after the install, not by the install itself. Both run the same discovery code; the literal install path is shown by the unit test only. |
| mcp-everything never writes a proxied value on its own account; `project_info` shows names only; what a proxied server itself prints is a documented limit | Met, as reworded | Unit: after install, connect, a proxied call, discovery and refresh, the bytes of `registry.json`, every tool result and every log line lack the value, in tests that first assert the launch carried it. Acceptance session: 0 occurrences of the value in the registry file. The limit is pinned by two tests named as documented limits (stderr reaches tool errors and the log, not the registry; a protocol error message reaches the registry too) and stated in the README. The criterion as first agreed ("never appear in `registry.json`, in the output of any tool, or in logs") was false for a server that prints its own key and was reworded by the operator during design. |
| Variables prefixed for one slug never reach another project's sandbox, and a project with no matching variables behaves exactly as before | Met, in the unit suite | Two projects with variables each launch with only their own; the two-slug case (`a`, `a__b`) in both slug orders; a project without variables launches with exactly its stored environment and shares its session as before. No test that existed before the flight was edited. Not shown against real sandboxes. |

**Constraints**: all five held. Process environment only (the environment object is read at each launch; nothing else is consulted). MCP server processes only (a test shows command line tools and `sandbox_exec` do not receive the value; the README says this is not an isolation boundary inside the sandbox, which was measured at planning). No blanket passthrough. Values travel by the env file, never on a command line (tested against the real connector). `connect_mcp_server` behaves as before; its descriptions were reworded, and a value it stored is now overridden at launch by a variable of the same name, which is the operator's decision DD4.

### Checkpoints
All seven flight checkpoints were met.

### Not Shown
A real third-party MCP server; a real secret; a sandbox with its network on; Windows; the operator's other client; two processes with different variables on one data directory (documented, untested); an empty-valued variable reaching a real server (unit-tested at the matching level and measured through an env file at planning, but the Docker case uses a non-empty value); how long a refresh takes on a project with many commands.

## What Went Well
- **Measuring before deciding, again.** Three planning probes changed the design or removed a risk: a slug can contain `__` (so matching starts from known slugs, with a longest-slug rule); env files carry values verbatim and other processes in a sandbox can read a server's environment (so the README does not claim isolation); and the recipe for the second Docker case was run once before the second design review, which turned the flight's likeliest divert into a case that passed first time at about 4 s.
- **Controls seen to fail.** Five deliberate breaks, each failing the one test meant to catch it, with checksums before and after. Two of them only work because of what design review added: the two-slug test runs in both slug orders (one order passes with the rule removed), and each error-flag condition has a test in which it alone holds (the first draft's "gone" test also tripped another condition).
- **Absence paired with presence.** Every "the value is not there" assertion sits in a test that first asserts the launch carried the value. The reviewer checked this and found none vacuous.
- **Each review round earned its place.** Architect cycle 1: the criterion that was false, guards for `refresh_mcp`, the leg split. Cycle 2: three statements worded beyond their evidence. Leg 01 review: a launch site with no test, and a criterion that could pass on an earlier launch's session. Leg 02 review: a test fake that would have hung the unit suite for 15 s per unanswered launch, and a control that would not have failed.
- **The implementation needed no fix cycle.** Both legs landed without deviation from their criteria and the flight review confirmed on the first pass.
- **Test time budgets were set at leg design** (sortie 02's lesson): 0.5 s for the unit suite (about 0.1 s used), 25 s for the two Docker cases (about 6 s used). Nobody objected late.
- **The acceptance session found things only a real client shows**: that the session's server was still the old build, and that the operator's two clients share one Docker daemon and one container name prefix.
- **Decisions made by the operator were written into the artifact they change**: the two charter scope choices, the reworded criterion, precedence, the accepted debts.

## What Could Be Improved

### Process
- **A named risk fell through.** The spec says a refresh on a project with many commands is not measured and "could outlast a client's request timeout". It became neither a criterion, nor a README sentence, nor an entry under accepted debt. Sortie 01's debrief made exactly this rule. The other five named risks were each documented or accepted in the log.
- **The Flight Director stated things beyond their evidence, four times.** At the charter gate, "slugs never contain `__`", from reading; measured false an hour later, before it reached the spec. When putting the echoed-values decision to the operator, that a server's start-up error is stored in the registry; the second review showed stderr is not. Three further statements in the spec were corrected by that review. All were caught, none changed a decision, and each cost a correction. This is the same finding as sortie 02's, with the same cause: marks applied from memory.
- **A leg's guidance contradicted the previous leg's criterion.** Leg 02 suggested "a small dedicated error class"; leg 01's criterion required a plain `Error`, and a leg 01 test pins it. Neither leg review noticed. The Developer resolved it sensibly with a tag, and the result is the least conventional piece of the code.
- **The acceptance session started on an unchecked assumption.** The Flight Director built the branch, told the operator the next reconnect would run it, and recorded "reconnected, `refresh_mcp` shows up" as a pass without looking. The operator had reconnected another client. The stand-in was then placed and a discovery run through the old build before anyone noticed. Cost: three exchanges, a corrected record, and a stale-worded warning written into the operator's registry until the next refresh.
- **A question to the operator assumed knowledge they did not have.** The precedence question presupposed knowing that `connect_mcp_server` takes values typed by the agent. It took two more exchanges, and it is also what surfaced the operator's documentation requirement, so the detour paid for itself.
- **A pull request edit failed quietly again.** `gh pr edit` printed a deprecation error and left the body unchanged while the rest of the command went on. It was caught by reading the body back before reporting, and redone through the REST API. Sortie 02 recorded the same class of failure; this time nothing untrue was said.

### Technical
- **`refresh_mcp` flags a project with no MCP server at all as an error.** This is by design (DD5: "the catalog holds no proxied tool afterwards"; the leg calls it the caller's signal that there is nothing to refresh). The debrief Developer reads it as wrong for a command-line-only project. It is a design question for the operator, not a defect.
- **Two validators for one rule.** `launchVariables` in `src/proxy/host-env.ts` has its own pattern for unusable values and shares only the name pattern with `validateEnv` in `src/proxy/mcp-proxy.ts`. The spec said validation goes "through `validateEnv`". If one changes, the other will not.
- **The unusable-value error is told apart by a module-level `WeakSet`.** It works and is tested; it is an unusual pattern and exists only because of the contradiction above.
- **The `refresh_mcp` guards live in `App.callMeta`, not in `Installer.refreshMcp`.** Another caller of the method would skip them. They are also near-copies of the wording other cases use, with no shared helper.
- **`Installer` is accumulating.** It now also owns the environment object, slug ownership, the launch spec, the refresh method and the route-hint wording, in a 685-line file. Not a problem yet; the next feature in this area should give launch environment its own small collaborator.
- **`launchSpec` is a seam nothing enforces.** A future launch path that calls the proxy with a stored spec would silently start a server without its variables. The four existing sites each have a test; a fifth would have none until someone wrote it. A comment says what the method is for; nothing says "every launch must use it".
- **`RefreshOutcome` repeats three fields of the discovery result**, and `callMeta` reads the variable names separately from the ones the refresh used. Harmless while the environment cannot change.
- **Test-code debt**: the secret test value is defined in three test files, with a fourth different one.
- **Squawk 0008 matters more now.** Slugs containing `__` already break tool lookup; the longest-slug rule was built to live with them. It should be fixed before anything else is keyed on slugs.
- **Still no CI.** The Docker suite ran four times in this flight because four agents ran it by hand.

### Environment (not caused by this flight)
- **Two registries on one Docker daemon replace each other's sandboxes.** The operator's two clients keep separate data directories and use the same container name prefix. Install destroys the container of that name first, and the check it makes is the generic mcp-everything label, not an owner (Architect, by reading). One client had already replaced the other's `rea` sandbox. With this flight's feature the consequence grows: a registry would start whatever is now in that sandbox with its own variables for the slug, and `project_info` would not show it. That is the slug-reuse exposure of DD8 arising without an uninstall.

### Documentation
- The README does not say that a refresh is a full discovery whose duration grows with the number of commands.
- The README's limit on echoed values does not say that only the first line of an error is stored.
- Nothing outside the code describes `launchSpec` as the one way to launch.

## Deviations and Lessons Learned

| Deviation | Reason | Standardize? |
|-----------|--------|--------------|
| Charter criterion 3 reworded during design | As agreed it was false for a server that prints its own key; the operator narrowed the promise | Yes, as a check: before the charter gate, ask of any "never" whether a third party controls a channel it covers |
| One implementation leg became two | First design review; the split is by what can be finished and tested alone, with the secrets-handling part first | Yes, when the parts are separately testable. Not by task type |
| The error flag counts proxied tools in the catalog, not the published subset | A large server's tools can be callable while none is published; clarified at leg 02 design and annotated in the spec | No, one-off |
| Unusable-value error tagged, not given its own class | Leg 01's criterion and test require a plain `Error`; leg 02's guidance suggested a class | No: see Process |
| No third design review after cycle 2; no second review of either leg | Two-cycle cap; every revision was a correction or one the reviewer recommended | Yes, when that holds |
| Squawk 0008 logged on the sortie branch, in its own commit | Found during planning; the operator approved the branch | Case by case |
| Acceptance session: the Flight Director made the tool calls and, at the operator's request, edited the client configuration; the operator did the reconnects and judged | In this client the operator reaches the tools through the session anyway | Yes, with the reconnects kept as the human's |
| Acceptance session: the registry search was run by the Flight Director | A dummy value was used, so there was nothing to keep out of the conversation | No, incidental |
| Acceptance session: step 1 first recorded as passed without being checked | Assumed the operator had reconnected this session | No: see Process |
| The Docker script tests the variable with `printenv` | `${NAME+set}` is read as a template substitution inside `String.raw` | No, incidental |
| Pull request body updated through the REST API | `gh pr edit` failed on a deprecation error | Yes: read the body back after any edit |

## Key Learnings
- A criterion that says "never" about a secret has to be read against every channel a third party controls. Here there were three (what a server returns, what it prints, what it sends over the protocol), and they end in different places.
- When a session cache reuses a launch, "a launch carried the value" does not show that the call under test launched it. Make that site's launch the only one, or count launches.
- A test fake that simply does not answer turns into a timeout. In this suite that is 15 s per probe. A launch that should fail has to fail at once.
- A control needs a test in which the broken condition is the only one that could trip the assertion.
- Before an acceptance session, look at what the session is actually running: the process's start time against the build's, and one line only the new build prints.
- A value that is set in one place and enforced in another (a criterion in one leg, guidance in the next) should be checked across legs when the second leg is designed.
- An operator's question back ("would the agent need to be told?") can be the most useful thing in a design interview. Here it produced a documentation requirement nobody had written down.

## Test Metrics
Compared with the sortie 01 and 02 debriefs.

- **Unit suite** (`npm test`): 16 files passed, 1 skipped; 340 tests passed, 16 skipped, 0 failed; 1.55 s. Sortie 02: 270 passed, 14 skipped, 1.44 s. The 70 new tests are this flight's: `test/host-env.test.ts` (22) and new blocks in `test/server.test.ts`, `test/installer.test.ts` and `test/proxy.test.ts`. The two extra skips are the two new Docker cases, skipped without the opt-in. Every new test runs in a few milliseconds; the slowest recorded for leg 02 was 6 ms.
- **Default Docker suite** (`npm run test:docker`): 14 passed, 2 skipped, 0 failed; 148.2 s. Sortie 02: 12 passed, 2 skipped, 141.6 s. The two new cases take about 2.1 s and 4.1 s (the refresh itself 1.2 s); the rest of the difference is within the spread of this flight's four runs (143.1 s with 13 cases, then 149.1 s, 152.6 s and 148.2 s). Slowest cases are unchanged: the six idle-timeout cases between 15 and 19 s, the install and the rebuild at about 16 to 17 s, the proxy case at 9.9 s.
- **Pressure cases**: not run, by the operator's rule; the watchdog script, its tests and the sandbox images did not change.
- **Flakes**: none in four runs of the Docker suite and many of the unit suite. The idle-timeout cases remain the timing-sensitive ones; the closest was again 19.0 s of work against 21 s deadlines.
- **Skips**: the Docker file is skipped without its opt-in, and two of its cases need a second one. There is still no CI.

## Methodology Observations
All observed with mission-control 1.2.3.

- **Sortie skill, Plan step 2 (charter).** The charter was agreed with a success criterion that design review then showed to be false as worded ("values never appear in … the output of any tool, or in logs", when a proxied server can print them). The operator reworded it. Second occurrence in this project of the charter gate passing something design had to change (sortie 02: a criterion and a constraint that could not both hold). The skill has no step for testing a charter's wording against the code before the gate. Cost: one operator round-trip. Saved: a criterion that would have been recorded as not met.
- **Sortie skill, Plan step 1 (qualify).** "A quick read of the code it touches" produced a statement to the operator, at the charter gate, that slugs never contain `__`. It was false and was found by running the function during flight design. The qualification step asks for a read, not for evidence. Cost: none realized; the claim had not yet shaped a decision.
- **Flight skill, Phase 4 (design decisions).** Statements were marked measured, read or inferred, as sortie 02 recommended. The second design review still found three worded beyond their evidence, and a fourth had already been told to the operator while asking for a decision. The flight format has no place for a statement's provenance, so the mark is applied by hand, from memory. Second occurrence (sortie 02: three statements). Cost: part of one review cycle and one correction to the operator.
- **Flight skill, Phase 5b (design review), premise of the test recipe.** Acting on the sortie 01 and 02 debriefs, the recipe for the hardest test was run once before the second review. It passed, was recorded with what was and was not varied, and the leg built from it passed first time. Recorded as the earlier recommendation working. The skill still prompts premise checks for design decisions only, not for the verification approach.
- **Flight skill, Phase 5b (two-cycle cap).** The second cycle's revisions went to the operator without a further look, as in sorties 01 and 02. Third occurrence. This time they were corrections and added specification, none a changed decision, and the flight log says so. No cost observed.
- **Flight skill, pre-flight rigor (named risks).** One of six risks the spec names ended up neither as a criterion, nor documented, nor logged as accepted (refresh duration on large projects). Sortie 01's debrief recommended that every named risk end as one of those. Nothing in the flight or leg skill asks for that reconciliation before `ready` or at landing. Second occurrence of a named risk falling through (sortie 01: the watchdog's behavior on fork failure, which was a defect). Cost here: a missing README sentence, found at debrief.
- **Agentic-workflow skill, Phase 2a (leg design review).** Both leg reviews found problems that would have shipped or stalled the leg: an untested launch site and a vacuously passing criterion in leg 01; a hanging test fake and a control that could not fail in leg 02. Recorded as working as intended, at about two and four minutes for the two reviews.
- **Agentic-workflow skill, Phase 2a (leg design across legs).** Leg 02's guidance suggested something leg 01's criterion forbade (a dedicated error class against "a plain `Error`"). The leg design step reads the flight log and the code, and the review checks the leg against the codebase; neither is asked to check a new leg against the previous legs' criteria. Cost: an unconventional mechanism in the code and a debrief finding.
- **Agentic-workflow skill, Phase 2b (interactive legs).** The skill says to present one step, wait for the human to perform it and report, then proceed. It does not ask the Flight Director to establish which client or session the human is acting in, or to confirm a reported result where the session could observe it. The flight skill's guidance on HAT legs does say to include "at least one state the operator won't be looking at (another window, session, or client)", and that is where the trouble was: the operator's other client. Cost: three exchanges, one record corrected after being written as a pass, and test fixtures placed against the wrong build.
- **Agentic-workflow skill, Phase 2d and Phase 3 (order with an interactive leg).** The skill reviews and commits "after the last autonomous leg" and opens a draft pull request "with all legs checked off", then describes flight completion. It does not say where an interactive leg that follows sits. Here: commit and draft pull request with the HAT leg unticked, then the HAT, then a second commit, then landing. No cost; recorded as a gap in the sequence.
- **Agentic-workflow skill, Phase 3 (flight completion).** The pull request was marked ready before the debrief, as the workflow prescribes. Third occurrence of the ordering; the debrief found no defect, so no cost this time.
- **Agentic-workflow skill, crew protocol (commit and one-line fixes).** Two Developer spawns existed only to run a handful of git commands, and one to change a single README line; each used about 38,000 tokens. The Flight Director may not edit source, and the crew file gives the commit to the Developer. Recorded with its cost; the separation also meant each commit was preceded by an independent check of the working tree and a test run.
- **Squawk skill, Log verb, used mid-planning.** Logging one squawk during sortie planning loaded the whole skill, including the completion workflow, to write one artifact. Worked as intended; recorded for its weight.
- **Flight-debrief skill, Phase 2 (test metrics instruction).** The skill says to run the full test suite; the operator's rule excludes the pressure cases unless the watchdog changes. Second occurrence of a project rule overriding this default (sortie 02). No cost.
- **Sortie skill, right vehicle?** Yes. One outcome, one cluster of decisions (how variables are matched, merged, shown and refreshed), two implementation legs and a HAT, no new subsystem. Things that would have made it a mission were named and kept out: replacing echoed values, per-server scoping, pinning variables to a repository, changing `connect_mcp_server`. It was near the upper end for a sortie: ten design decisions, two design review cycles, and a charter criterion reworded once. The operator, asked at debrief, said the weight was right and that nothing in particular had slowed them down.

## Recommendations
1. **Decide who owns a sandbox.** Either install refuses to replace a container another registry created, or registries on one Docker daemon are made to use different name prefixes. With variables now bound to slugs, a replaced sandbox is started with the other registry's variables. This needs design: a sortie.
2. **Complete squawk 0008 before building anything else on slugs**, and decide then whether `makeSlug` should stop producing `__` at all.
3. **Close the named risk that fell through**: one README sentence that a refresh is a full discovery and takes longer on projects with many commands, or a measurement that shows it does not matter.
4. **Make `launchSpec` hard to bypass**: share one validator with `validateEnv`, move the refresh guards into `Installer.refreshMcp`, and consider having the proxy accept only a spec produced by it. Small, but best done before per-server scoping or anything else is added.
5. **At the charter gate and at leg design, check wording against what already exists**: a "never" against the channels a third party controls, and a new leg's guidance against the previous legs' criteria. And before a human acceptance session, confirm what the session is running.

## Action Items
- [ ] Squawk 0009 (open): README says that `refresh_mcp` is a full discovery whose duration grows with the number of commands (Recommendation 3).
- [ ] Squawk 0010 (open): `launchVariables` and `validateEnv` share one pattern for unusable values.
- [ ] Squawk 0011 (open): a test in which an empty-valued variable reaches a server end to end.
- [ ] Squawk 0012 (open): one shared secret test value in `test/helpers.ts` in place of the three copies.
- [ ] Squawk 0008 (open, logged during planning): tools of a project whose slug contains `__` cannot be called by name.
- [ ] Needs the operator's decision, so not a squawk: whether `refresh_mcp` on a project with no MCP server should be an error (by design today).
- [ ] Needs design, so not a squawk: replace the `WeakSet` tag with a typed error and change leg 01's test to match; move the refresh guards into `Installer`.
- [ ] Later flight: sandbox ownership across registries (Recommendation 1); replacing echoed values in server text; per-server scoping; a collaborator for launch environment taken out of `Installer`; CI for the Docker suite.
- [ ] For the operator's environment, now: give one of the two clients a different `MCPE_NAME_PREFIX`.

## Follow-up — 2026-11-15

Added the same day, after the debrief above was written. The assessment is left as written; this records what changed afterwards.

- **The operator confirmed the sortie as `completed`**, and selected all four candidate squawks, logged as 0009 to 0012.
- **The version was bumped to 0.3.0** at the operator's request, as squawk 0013 (`7f7ae08`), reviewed separately and pushed to pull request #4. No tag was created.
- **Pull request #4 was merged** (`d0cf9ca`) before this debrief, squawks 0009 to 0012 and the status changes had been committed. They were in the working tree, not in the pull request. Nothing was lost; they reach `main` through a separate branch, `sortie/03-debrief`, and its own pull request. The statement above that pull request #4 "is open and not merged" was true when written.
- **One more methodology observation**, mission-control 1.2.3. *Flight-debrief skill, Phase 1 step 3 and Phase 5, with agentic-workflow Phase 3.* The workflow marks the pull request ready and recommends the debrief "on the flight branch before merging, so the debrief joins this PR"; the debrief skill then writes its artifacts and "leaves committing them to the operator". Between those two, the pull request sat ready and reviewable while the debrief's artifacts existed only as uncommitted files, and the Flight Director's closing message asked the operator to say when to commit them. The operator merged first. Expected: nothing in either skill makes the debrief's artifacts part of the pull request before it can be merged, or says to return the pull request to draft while a debrief is being written. Cost: a second branch and pull request for artifacts only, and a debrief that reaches `main` after the work it describes. The same ordering, ready before debrief, is recorded for sorties 01 and 02 and, above, for this one; this is its first cost of this kind. In sortie 01 the cost was a pull request advertising an unmet criterion; in sortie 02 there was none.
