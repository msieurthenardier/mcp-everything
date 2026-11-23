# Leg: old-sandboxes

**Status**: completed
**Flight**: [Groundwork, and Leaving Old Sandboxes Alone](../flight.md)

## Objective
Stop treating a sandbox made before ownership labels as this installation's. A `before` container or volume is refused everywhere a `not-ours` one is: no start, exec, local-access write, network change, containment, reuse, reinstall over it, or removal. Every message about such a sandbox says that only the operator can tell whether it is this installation's, and gives the two `docker` commands that remove it. The tests that pinned the old rule are inverted and renamed, and the docs say what happens now.

## Context
- Flight DD4 (operator, 2026-11-23: "never touch; operator removes"). Flight 2's debrief, recommendation 1: the old rule is the likely way `mcpe-rea` was deleted by the operator's other installation.
- **High risk.** It touches the security-sensitive ownership surface and reverses pinned behavior. It gets a Developer design review, and the Flight Director reads every inverted destructive Docker case before its first run.
- **Starts after leg 3.** The ownership code lives wherever leg 3 put it (planned: `src/sandbox/ownership.ts`), and the gate is in `DockerBase` (planned: `src/sandbox/docker-base.ts`). Citations below are by symbol, with line numbers from `5a5f3fa`.

## Design review resolutions (2026-11-23)
A Developer reviewed this leg against the code after leg 3 and approved it with changes. These resolutions override the text below wherever they differ.
- **Confirmed:**
  - `refuseUnless` (`src/sandbox/docker-base.ts:354`) is the only gate every `before` path reaches. No path classifies on its own condition and then acts.
  - The sweep, `listOwnSandboxes`, the proxy lists and the network checks never meet `before`.
  - A `SandboxRef` is only made after the gate.
  - Old names (`${namePrefix}${slug}`, before `a7eabc0`) can never equal `sandboxName(slug)`, because a slug has no hyphen. So a reinstall proceeds on fresh names with `leftInPlaceWarning`, and `nameHeldWarning` cannot fire for an old name.
  - No `src/` code reads `.reason`.
- **H1, the hint's wording and where it appears.** The hint reaches agents: tool errors (`server.ts:777`), the uninstall result (`:1761`), the owner line, and `record.warnings` shown by `project_info`. An agent with a host shell could act on a `docker rm` it reads, which is exactly the kind of removal this leg answers. Flight Director's decision, a refinement of DD4:
  - **Every message** about a `before` sandbox says: "was made before ownership was recorded; this installation cannot tell whether it is its own and does not act on it. Do not remove it yourself; ask the operator."
  - **The `docker` commands appear only where the operator is told what to do:** the `project_info` owner line and the `uninstall_project` result. They are phrased: "If the operator confirms it is this installation's and not wanted, they can run `docker rm -f NAME` and `docker volume rm NAME`, then reinstall the project." Tool errors and the reinstall warning end with "see project_info" instead of the commands. That keeps the reinstall warning single-line and under the 400-character bound pinned at `test/installer.test.ts` ≈1306.
  - A unit test pins the wording: the prohibition is present, and the commands come after "If the operator confirms".
- **H2, which branches are dead (corrected).**
  - `assertNameFree` (`docker.ts` ≈94) throws a plain `Error("already exists")`. `mine` still reaches it, so it **stays**. Its `before` row (`test/docker.test.ts` ≈1068) becomes a refusal case.
  - `removeStagingVolume` (≈139): the `cls !== "mine"` clause is dead. The condition becomes the role check alone, and the doc comment (≈132) is updated.
  - `requireVolumes` (≈158–160): the `before` branch is dead and is deleted. ≈157 and ≈162–163 stay, because `mine` with a wrong role reaches them.
  - `createContainer` (≈397): its plain `Error` for a non-`mine` volume is dead and is deleted. Its test (≈1326) becomes a refusal.
  - `VolumeNotUsableError` stays. Its doc comment (`errors.ts:5`) drops "from before ownership".
- **H3, more docs.** In addition to the Inputs list:
  - `README.md` ≈73 (the `project_info` row) and ≈439–447: say "cannot be told" for `before`, not "not this installation's to remove";
  - **"On upgrading", ≈468–478:** "Projects installed before this version keep working with no change" becomes false, and so does "the first installation to reinstall it removes the shared sandbox". Rewrite it to say that an old project's tools now fail until the operator removes its sandbox and reinstalls;
  - ≈636–643: an empty owner.
  - `docs/containment.md` ≈307–308 and ≈334–337: drop the `before` clause, keep "labelled sandboxes with no record" (still true), and say "removed by the operator, then reinstalled" instead of "needs a reinstall".
- **H4, comments to fix by symbol.**
  - `docker-base.ts` ≈358 (`resolveContainer`).
  - `docker.ts` ≈472, ≈132 and ≈147.
  - `docker-network.ts` ≈505 (`writeLocalAccess`) and ≈959 (`listOwnSandboxes`). The latter's "a sandbox from before ownership has no project label" is false.
  - `src/network/startup.ts` ≈21.
  - `src/network/containment.ts` ≈789. That check is on the project label, so it hits any sandbox without one. Reword it to say so.
- **H5, the constructor.** `reason` is mapped explicitly from `first.cls` (`another`, `before` or `not-ours`), not by fallback (`ownership.ts:98–101`).
- **H6, the mixed pair** (a `mine` container on a `before` volume). It can only come from hand-made objects now, because `createContainer` refuses a `before` volume. The hint names commands only for the `before` parts. A comment records that removing such a volume requires the container using it to be gone first. No special wording.
- **H7, the test inventory** (it replaces the Inputs list):
  - **Invert and rename:**
    - `test/docker.test.ts`:
      - ≈847 and ≈907: the mine/before tables become `mine` only, and `before` joins the refusal tables at ≈829 and ≈1507;
      - ≈1001 (destroy pairs), ≈1068 (the `before` row) and ≈1326;
      - ≈1760: a `before` row now throws `SandboxRefusedError`;
      - ≈1804–1805 (the refusal flag goes from false to true);
      - ≈1876: remove the `before` row and test it as a refusal;
      - ≈4251 (destroy of a `before` sandbox).
    - `test/server.test.ts`: ≈1704 (add the hint) and ≈1749 (exact owner line).
    - `test/installer.test.ts`: ≈1291 (add the hint) and ≈1306 (the bound still holds).
    - `test/integration/docker.test.ts` ≈420. It also asserts that both objects still exist after `uninstall_project`.
  - **Narrow with a comment:** `test/docker.test.ts` ≈1522 would silently stop exercising `before`. It is narrowed to `mine`, with a comment saying why.
  - **Unchanged:** ≈605–606 (`classifySandbox`), ≈1442 (`ownership()`) and ≈3742 (`listOwnSandboxes`, plus an assertion that a `before` sandbox is not listed).
  - **New tests:**
    - the mixed list naming the `before` part;
    - `acquire` and `startForContainment` refuse `before`;
    - a `before` project's `sandbox_exec` and `project_info` through the App (`isError` with the short form, and the owner line with the commands);
    - the name grammar;
    - a source test that `grep`s `src/`, `docs/` and `README.md` for "treated as this installation", so that check is pinned and not only manual.
- **H8, the name grammar.** Test the raw `f.sandbox`, never `clean()`'s output. Use `LABEL_MAX` (64) for the length.
- **Citations, current:**
  - `refuseUnless`: `docker-base.ts:354`.
  - `ownership.ts`: `describeFacts` :72; `SandboxRefusedError` :98–101.
  - `installer.ts`: `describeLeftPart` :76; `leftInPlaceWarning` :93 (used :682); `nameHeldWarning` ≈98 (used :803); `uninstall` ≈1076.
  - `server.ts`: `ownerLine` :970; the error pass-through :777; the tool description :364; the uninstall result :1761.

## Inputs
- **The gate** `refuseUnless`, today `if (facts.some((f) => f.cls === "another" || f.cls === "not-ours")) throw new SandboxRefusedError(...)` (`docker.ts:1189` at `5a5f3fa`). The Architect's trace found every path that reaches it:
  - `resolveContainer`, and through it `acquire`, `startForContainment`, `inspectSandbox`, `look` (so by-name `exec`, `ensureRunning` and `state`), `removeContainer` and `restartSandbox`;
  - `writeLocalAccess`, `destroyNow`, `setNetworkNow` and `createContainer`;
  - the volume checks `assertNameFree`, `removeStagingVolume` and `requireVolumes`.
- **`SandboxRefusedError`'s constructor** picks `first` with `find(cls === "another" || cls === "not-ours") ?? facts[0]` and maps `reason` to `"another"` or `"not-ours"` (≈508–511).
- **Renderings of `before`:**
  - `describeFacts` (≈481): "(treated as this installation's…)";
  - `describeLeftPart` (`src/install/installer.ts:83`);
  - `ownerLine` (`src/server.ts` ≈965: "it is treated as this installation's.").
- **`VolumeNotUsableError` branches** that caught `before` after the gate let it through: `assertNameFree` (≈2215), `removeStagingVolume` (≈2261), `requireVolumes` (≈2280) and `createContainer` (≈2519).
- **Reinstall and uninstall in `src/install/installer.ts`:**
  - the renamed reinstall's `destroy(old)` and `leftInPlaceWarning` (≈684–690), and `nameHeldWarning` (≈810);
  - `uninstall` (≈1084), which deletes the record and returns `e.sandboxes`;
  - `uninstall_project`'s result (`src/server.ts` ≈1754–1756) and its tool description (≈359), which names "another installation's, or not created by mcp-everything".
- **Comments:**
  - `resolveContainer` ("mine or from before", ≈1193);
  - `writeLocalAccess` (≈1644);
  - `acquire` (≈2594);
  - `listOwnSandboxes` (≈2098);
  - `src/network/containment.ts` ≈1014 ("a sandbox from before ownership: nothing is done");
  - `src/network/startup.ts:20`.
- **Docs:**
  - `README.md` ≈455 ("is treated as this installation's … it is started, used, reinstalled over and removed as it was before"), in "Several installations on one Docker daemon";
  - `README.md` ≈461 (`project_info`'s line) and ≈639;
  - `docs/containment.md` ≈307 ("Not contained by the pass") and ≈334 ("Sandboxes from before ownership labels … stay uncontained").
- **Tests that pin the old rule:**
  - **`test/docker.test.ts`:**
    - 860 ("acts on the id of a sandbox that is %s", mine/before);
    - 920 ("starts a stopped sandbox that is %s");
    - 1000–1014 ("destroy classifies both");
    - 1081 ("says a volume that is %s already exists");
    - 1339 ("a volume from before cannot hold a new container");
    - 1418–1456 and 1536 (`writeLocalAccess`);
    - 1774, 1818–1819 and 1889 (the staging and volume checks);
    - 3756 (`listOwnSandboxes`, which stays: it is never listed);
    - 4265 ("a sandbox from before ownership … is destroyed the same way").
  - **`test/server.test.ts`:** 1680, 1702 and 1747 (the owner line).
  - **`test/installer.test.ts`:** 1295.
  - **`test/integration/docker.test.ts`:** 416–473 ("works on, describes and removes a sandbox made before ownership was recorded").

## Outputs
- The gate, the error's constructor, the one formatter for removal commands, the three renderings, the dead branches removed, and the comments.
- Inverted, renamed tests, plus new tests for the edge cases below.
- Docs: the README's paragraph and line, and `docs/containment.md`'s two items.

## Acceptance Criteria
- [ ] **The gate.** `refuseUnless` refuses `before` as it refuses `another` and `not-ours`. `classifySandbox` still answers `before`; the type `SandboxClass` is unchanged.
- [ ] **The error.**
  - `SandboxRefusedError`'s `first` is the first fact that is `another`, `not-ours` or `before`.
  - `reason` gains `"before"`, so its type is `"another" | "not-ours" | "before"`.
  - Every consumer of `.reason` is listed (`grep -rn "\.reason\b" src`) and still correct.
  - A unit test pins that a mixed list (container `mine`, volume `before`) names the volume.
- [ ] **One formatter for the removal commands** (e.g. `removalHint(facts)` beside `refusalMessage`). For each `before` part it gives the command by kind, `docker rm -f <name>` for a container and `docker volume rm <name>` for a volume, then "then reinstall the project".
  - **Wording.** It is phrased to the operator, not the agent: "only the operator can tell whether it is this installation's; if it is, they can remove it with …". An agent with a shell must not read it as an instruction to delete.
  - **When a command is printed.** Only when the name matches Docker's own grammar (`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`) and fits in 64 characters. Otherwise the message says "remove it in Docker" without a command.
  - **Who uses it:**
    - `refusalMessage`, so every tool failure carries it (a tool's failure passes the refusal's message through);
    - `leftInPlaceWarning` (a reinstall), so the warning on the new record carries it;
    - the `uninstall_project` result;
    - `ownerLine` in `project_info`.
- [ ] **Renderings.**
  - No text anywhere says a `before` sandbox is "treated as this installation's": `grep -rn "treated as this installation" src docs README.md` returns nothing.
  - `describeFacts`, `describeLeftPart` and `ownerLine` say "was made before ownership was recorded; this installation does not act on it", followed by the hint.
- [ ] **Dead branches.**
  - The `VolumeNotUsableError` branches that could only be reached by `before` are deleted, or kept with a comment saying what else reaches them, case by case, recorded in the flight log.
  - `VolumeNotUsableError` itself stays if anything still throws it. Its doc comment drops "from before ownership" if that no longer applies.
- [ ] **Reinstall and uninstall.**
  - A reinstall of a project whose record names an old sandbox does not remove it. It proceeds on fresh names (`sandboxName` embeds the installation id) and adds `leftInPlaceWarning` with the hint.
  - `uninstall_project` deletes the record, leaves the old sandbox, and says so with the hint. Its tool description adds "or was made before ownership was recorded".
  - Unit tests pin both.
  - A test pins that `nameHeldWarning` does not fire when the old names differ from the new ones.
  - The design review verifies the pre-ownership name format against `git log -p` of `sandboxName`. If old names could equal new ones, the leg records what happens.
- [ ] **References.** A unit test pins that a `SandboxRef` for a `before` container cannot be obtained: `acquire` and `startForContainment` refuse. The by-reference `exec` path therefore never meets one.
- [ ] **Inverted tests.** Each test listed in Inputs either:
  - is inverted, so that `before` is now refused or left in place, and **renamed** to say so, with `before` taken out of the `["mine", "before"]` tables and put under the refused classes; or
  - stays unchanged, where it pins something still true (e.g. `classifySandbox` answering `before`, or `listOwnSandboxes` not listing one), with that noted.

  No test is deleted outright.
- [ ] **The integration case** (`test/integration/docker.test.ts` ≈416) is renamed and inverted. The new case:
  - refuses `sandbox_exec`, with the message naming both commands;
  - shows the new `project_info` line;
  - has `uninstall_project` delete the record and leave both objects, which must still exist after the call;
  - is cleaned up by its `finally`, which removes its own `${prefix}before` objects by exact, checked name as today.

  The Flight Director reads this case before its first run.
- [ ] **Docs.**
  - `README.md`'s paragraph says a sandbox with `mcp-everything=1` and no owner label is never started, used, reinstalled over or removed. It gives what the operator does, and says that an older mcp-everything on the same daemon still treats such sandboxes as its own, which this version cannot prevent.
  - `project_info`'s line description is updated.
  - `docs/containment.md` "Not contained by the pass" and "What containment does not stop" no longer list `before` sandboxes as running uncontained, because they no longer run. Labelled sandboxes with no record remain listed.
  - `src/network/startup.ts:20` and the containment comment are updated to match.
  - The leg 1 link-resolution test still passes.
- [ ] **Checks.**
  - `npm run typecheck` is clean and `npm run build` succeeds.
  - `npx vitest run` passes: leg 3's totals plus the new tests, with the delta explained.
  - The Flight Director runs `npm run test:docker` (66 passed, 5 skipped, or with the inverted case) with Docker object lists diffed.

## Verification Steps
1. `grep -rn "treated as this installation" src docs README.md` gives nothing. `grep -rn "\"before\"" src` shows only `classifySandbox`, the type, the formatters and the reason.
2. **Mutation.** Remove `before` from `refuseUnless`'s condition by editing. The inverted unit tests fail, including the mixed-list and `acquire` cases. Restore it by editing, and check `git diff --stat`.
3. **Mutation.** Make the hint formatter return an empty string. The tests for the refusal message, the reinstall warning, the uninstall result and the owner line fail. Restore it.
4. **Name grammar.** A unit test with a name containing a space, or longer than 64 characters, gets the "remove it in Docker" form, with no command.
5. `npx vitest run` totals. The Docker suite is run by the Flight Director.

## Implementation Guidance
1. **Gate and error first.** Run the unit tests and collect what fails: that is the list of pinned behavior.
2. **Add the formatter,** then the three renderings, the reinstall warning, the uninstall result and the tool description.
3. **Invert and rename the failing tests one by one.** Each new name says what is pinned now. Add the new tests.
4. **Dead branches:** delete each, or justify keeping it.
5. **Docs and comments.**
6. **Integration case:** invert it, keeping the exact-name cleanup, and do not run it. The Flight Director runs the Docker suite.

## Edge Cases
- **Mixed facts:** a `mine` container on a `before` volume, or the reverse. Refused, and the hint gives a command only for the `before` part. The `mine` part is described as this installation's, and the message does not suggest removing it.
- **A `before` network or proxy:** `foreignNetworkRefusal`, `checkedProxy` and `projectObjects` already map anything that is not `mine` to `another` or `not-ours`. They are unchanged, and the hint covers only containers and volumes.
- **The startup pass, the sweep and `listOwnSandboxes`** filter on the owner label and never meet `before`, so they are unchanged. A test already pins `listOwnSandboxes` skipping one (≈3756).
- **The hook cache** is filled only after `resolveContainer` passes, so no `before` entry can exist (Architect review).
- **The operator's other installation** (an older version on the same daemon) will still act on `before` sandboxes. The docs say so. Nothing here can prevent it.
- **An agent reading the hint:** the wording addresses the operator. mcp-everything itself has no tool that runs `docker` on the host, so nothing in it can act on the hint.

## Files Affected
- `src/sandbox/ownership.ts` (or wherever leg 3 put `classifySandbox`, `refusalMessage` and `SandboxRefusedError`), `src/sandbox/docker-base.ts` (`refuseUnless`), and `src/sandbox/docker.ts` / `docker-network.ts` for the dead branches and comments
- `src/install/installer.ts`, `src/server.ts`, `src/network/containment.ts` (comment), `src/network/startup.ts` (comment)
- `README.md`, `docs/containment.md`
- `test/docker.test.ts`, `test/server.test.ts`, `test/installer.test.ts`, `test/integration/docker.test.ts`

## Citation Audit
Checked 2026-11-23 against the working tree after leg 2 (src unchanged from `5a5f3fa` except leg 2's edits):
- the test line numbers come from `grep -n "before ownership\|\"before\"\|from before\|made before"`;
- the docs lines come from the same grep over `README.md` and `docs/`;
- `uninstall` is at `installer.ts:1084`, and its result at `server.ts` ≈1754.

Line numbers shift with leg 3, and the design review re-checks them by symbol after leg 3 lands.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
