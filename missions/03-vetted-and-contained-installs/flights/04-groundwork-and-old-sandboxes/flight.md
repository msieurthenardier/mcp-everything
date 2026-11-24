# Flight: Groundwork, and Leaving Old Sandboxes Alone

**Status**: landed
**Mission**: [Vetted and Contained Installs](../../mission.md)

> **Planned with the operator on 2026-11-23.** The mission's tentative flight 4 had three separate sets of design decisions:
> - checking what a build installed, which moves build output onto a volume and is hard to reverse;
> - sandboxes made before ownership labels;
> - none, for the docs move and the code split.
>
> The operator chose to split it. This flight does the groundwork: the docs move, the code split, and the clean-ups that share those files. It also fixes the treatment of old sandboxes, its only design decisions. "Checking what a build installed" becomes flight 5, planned on top of the split code.

## Contributing to Criteria
- [x] **The README describes what is checked and when, … and what none of this protects against.** The three security chapters move to `docs/` with their wording unchanged, and the README links to them. The text about old sandboxes is rewritten for DD4.
- [x] **No clone, build or sandbox can reach the host … whatever its network setting.** Flight 2 left two gaps in this: sandboxes made before ownership labels, and labelled sandboxes with no record, are never contained. After DD4, an old sandbox is never started, so it cannot run uncontained. Labelled sandboxes with no record remain a gap, unchanged.
- [x] **Constraint: what mcp-everything creates in Docker is never removed or changed by an installation that does not own it.** An old sandbox carries no owner label, so this installation cannot know it owns it. After DD4 it is left alone.

---

## Pre-Flight

### Objective
Prepare the code and docs for flight 5, and close a way an installation can delete a sandbox that isn't its own.
- **Docs.** The README's three security chapters move unchanged into `docs/checking.md`, `docs/containment.md` and `docs/security-model.md`. Each leaves a short summary and a link in the README.
- **Code split.** `src/sandbox/docker.ts` (2,898 lines) and `src/network/containment.ts` (1,246) are split into modules by concern, with no change in behavior.
- **Clean-ups in the same files and tests.** They are done first, separately from the move:
  - squawks 0054, 0055 and 0056;
  - one accessor for withheld tools in `src/server.ts`;
  - the two slow unit-test files moved out of the default run.
- **Old sandboxes.** A sandbox made before ownership labels (label `mcp-everything=1`, no owner label) is no longer treated as this installation's. mcp-everything does not:
  - start it, exec in it or contain it;
  - reinstall over it or remove it.

  Every message about it tells the operator how to remove it with `docker` and reinstall.

### Open Questions
- [x] Scope of the mission's flight 4 → **groundwork and the ownership fix**; "checking what a build installed" becomes flight 5 (operator, 2026-11-23). DD1.
- [x] How an old sandbox is treated → **never touched; the operator removes it** (operator, 2026-11-23). DD4.
- [x] Can this installation's registry prove it owns an old sandbox? → **No.** Records store the container and volume *names* (`src/types.ts:121–122`), not Docker ids. Another installation on the same daemon can have a record with the same name, which is the case for the operator's Windows installation and `mcpe-rea`. Docker cannot change a container's labels after it is created, so an "adopt" step could not relabel it in place either. Checked in the code 2026-11-23. DD4.
- [x] What to bundle into the clean-ups leg → **squawks 0054–0056, the withheld-tool accessor, and the slow tests moved out of the default run** (operator, 2026-11-23). DD3.
- [x] HAT → **a short one** (operator, 2026-11-23).
- [x] Name of the docs files → `docs/checking.md`, `docs/containment.md`, `docs/security-model.md`. Not `SECURITY.md`, which GitHub reads as a vulnerability-reporting policy (operator, flight 3's HAT).

### Design Decisions

**DD1 — Scope: groundwork and the ownership fix. Checking what a build installed is flight 5.**
- Rationale:
  - The layout change is hard to reverse, has many decisions of its own, and changes what existing projects need.
  - It lands better on split code and on the ownership rule fixed here. Flight 2's debrief said the `before` class must be fixed "before anything else touches ownership", and flight 5's volume change does.
- Trade-off: the mission gets one more flight. Its criterion "what a build installed is checked" stays open until flight 5.

**DD2 — Docs move: unchanged wording, three files, the README keeps a summary.**
- What moves:
  - the README's "Checking projects before they run" (≈ lines 339–753) to `docs/checking.md`;
  - "Network containment" (≈ 754–1094) to `docs/containment.md`;
  - "Security model" (≈ 1095–1276) to `docs/security-model.md`.
- The wording is unchanged. Only these may change:
  - heading levels, so each file starts at `#`;
  - links between chapters, which become relative links between files or back into the README.
- In the README, each chapter leaves its `##` heading, a summary of at most ~10 lines, and a link. The summaries are new text, kept short.
- `package.json` `files` gains `docs`, so the npm package carries the files the README links to.
- `test/readme.test.ts` reads each section from the file it now lives in. Its assertions are otherwise unchanged.
  - `section()` (`test/readme.test.ts:12`) slices on `\n## ` and needs a per-file variant, because the docs files start at `#`.
  - The assertions that read moved chapters (≈ `:26`, `:93`, `:100`, `:135`, `:164`) read the docs files instead.
- **Anchors** *(Architect review, 2026-11-23)*. The README links into the moved chapters from outside them about 30 times. The links are at ≈ lines 71, 74 and 101, and in the Configuration table at ≈ 1467–1564. Targets include:
  - `#network-containment`, `#what-containment-does-not-stop` and `#the-isolation-runtime`;
  - `#checking-projects-before-they-run`, `#the-dependency-check` and `#scanners-hosts`;
  - `#the-tool-description-check`, `#the-default-hosts`, `#local-access-mcpe_local_access` and `#the-built-in-check`.

  Every `###` anchor stops resolving in the README once its subsection moves. The leg rewrites every such link to `docs/<file>.md#<anchor>`. It also adds a test that every `](#x)` in the README and in each docs file resolves to a heading in the same file, and that every relative `docs/…#…` link resolves to a heading in the named file.
- Nothing in `src/` refers to a README section by anchor; the only mention is a comment at `src/network/startup.ts:21`.
- Rationale:
  - The operator's decision at flight 3's HAT.
  - Unchanged wording makes the move checkable: a normalized diff of the moved text against the old README is empty apart from headings and links.
- Trade-off: the README alone no longer holds everything. A reader of the npm tarball still gets the docs, because `files` includes them.

**DD3 — Clean-ups first, as their own leg; the move after, unmixed.**
- The clean-ups leg makes these changes, each stated:
  - **Squawk 0054:** a unit test where `docker stop` fails in `whileStopped` and nothing is changed or started.
  - **Squawk 0055:** delete the `RESTART_AFTER_SWAP` fallback:
    - delete `RESTART_AFTER_SWAP`, `restartAfterSwap`, `restartForSwap` and their tests;
    - `restartSandbox` and `restartAfterRestore` stay for the T18 rollback.
  - **Squawk 0056:** split the two `expect` statements that share line 282 of `test/docker-bypass.test.ts`.
  - **Withheld-tool accessor** (flight 3, recommendation 2):
    - one private accessor in `src/server.ts` over `ProjectRecord.toolCheck`;
    - every place that reads `toolCheck.withheld`, `withheldNames`, `withheldOmitted` or `allWithheldServers` goes through it;
    - output is byte-identical;
    - its doc comment states the withheld-tool contract across the surfaces.
  - **Slow tests** *(route settled by the Architect review, 2026-11-23)*:
    - Add a `vitest.config.ts` with two `projects`: `default`, which excludes the slow files, and `slow`. A directory exclusion is not used, because the CLI cannot override it.
    - Scripts:
      - `npm test` becomes `vitest run --project default`;
      - `npm run test:slow` runs `--project slow`;
      - a bare `npx vitest run` runs both. This flight's baseline counts are taken that way.
    - `test/proxy-server.test.ts` goes to `slow` as it is.
    - The real-shell cases of `test/docker.test.ts` ("the walk script, in a local shell" ≈1723 and "the whole probe script, in a local shell" ≈1925) move into a file of their own. Any helpers they share with `docker.test.ts` move first into a shared test module.
    - CI keeps one invocation with all projects, a single JSON report and the passed-test floor. `vitest.config.ts` is added to the typecheck's `include`.
    - No test is deleted or weakened.
  - **Source-text readers made file-list aware** *(Architect review)*. These tests read `src/sandbox/docker.ts` as text and assume one file and one class:
    - `test/docker-bypass.test.ts` (`DOCKER_TS`, `dockerClass()`, `members()`, `callers()`);
    - `test/docker.test.ts` ≈2410 (the `runtime-check` count and the `checkRuntime` slice) and ≈2901 (`export type OneShotRole`).

    They are parametrised over a list of files in this leg, still reading the one file. The split leg then changes a list, not logic. Squawk 0055's deletion also touches the bypass test's table entries and caller lists (≈282).
  - **The in-process outbound path** (flight 3, recommendation 3): a short note at the top of `src/network/containment.ts`. It says the dependency lookup (`src/scan/dependencies.ts`) is mcp-everything's own traffic and not the proxy's. It also says that a new stage calling an outside service follows the same pattern: inert unless injected, `contacted` recorded, a sent-statement rendered.
- Rationale:
  - A pure move is verified by a normalized diff that must come out empty. Mixing real changes into it would ruin that check.
  - These changes touch the same files, so they come first. The move then carries them.
- Trade-off: two legs over the same files instead of one.

**DD4 — An old sandbox is never touched; the operator removes it.**
- **The rule:**
  - `classifySandbox` keeps answering `before`, so messages stay accurate.
  - Every gate that today lets `before` through refuses it as it refuses `not-ours`. That covers `refuseUnless` (`src/sandbox/docker.ts:1189`), which `destroy`, `exec`/start (via `resolveContainer`), `writeLocalAccess`, the volume checks and the network-object checks all go through.
- **What follows from the rule:**
  - An old sandbox can no longer be started, exec'd in, contained, repaired, reinstalled over or removed.
  - Its tools fail with a message. The message:
    - names the container and volume;
    - says it was made before ownership was recorded, so this installation cannot tell whether it is its own;
    - gives the two `docker` commands that remove it (`docker rm -f <container>` and `docker volume rm <volume>`, names cleaned as elsewhere);
    - says "then reinstall".
  - `project_info`'s owner line says the same. A reinstall leaves it in place, with `leftInPlaceWarning`.
- **What the Architect's trace found** (2026-11-23). Adding `before` to `refuseUnless` reaches every path that lets one through today:
  - `resolveContainer`, and through it `acquire`, `startForContainment`, `inspectSandbox`, `look` (so `exec`, `ensureRunning` and `state` by name) and `removeContainer`;
  - `writeLocalAccess`, `destroyNow`, `setNetworkNow` and `createContainer`;
  - the volume checks.

  The trace also found no breakage:
  - The startup pass, `sweepCheckLeftovers` and `listOwnSandboxes` filter on the owner label, so they never meet a `before` sandbox.
  - The hook cache is filled only after `resolveContainer` passes, so it never holds a `before` entry.
- **Edge cases the ownership leg must settle:**
  - **`SandboxRefusedError`'s constructor** (`docker.ts:508`) picks the first fact that is `another` or `not-ours`, and falls back to `facts[0]`. With `before` refused, a mixed list from `destroy` (a mine container and a before volume) would describe the wrong object. Fix:
    - `before` joins the `find`;
    - `reason` gains `"before"`;
    - no consumer reads `.reason` today (they use `instanceof` and `.sandboxes`), and the leg re-checks this with grep.
  - **The removal commands go in `refusalMessage`** (`docker.ts:≈489`). A tool's failure passes a refusal's own message through (`server.ts:≈752`), so this is the only place every tool failure gets them. Today three places render `before`, and none carries the commands:
    - `describeFacts` (`docker.ts:481`);
    - `describeLeftPart` (`installer.ts:83`);
    - `ownerLine` (`server.ts:947`).

    They share one formatter for the removal commands.
  - **Dead `VolumeNotUsableError` branches.** These branches caught `before` after `refuseUnless` let it through: `assertNameFree` (≈2215), `removeStagingVolume` (≈2261), `requireVolumes` (≈2280) and `createContainer` (≈2519). The leg deletes them, or states why one stays. Their tests (`test/docker.test.ts` ≈1340, 2010, 2054–2055, 2126) are inverted to expect `SandboxRefusedError`.
  - **Reinstall and uninstall.** `sandboxName` embeds the installation id (`docker.ts:912`), so an old record's names differ from the new ones; the leg verifies the pre-ownership name format.
    - A reinstall marks the names renamed (`installer.ts:476–480`). Its `destroy(old)` is refused, it takes `leftInPlaceWarning` (`installer.ts:688–690`), and it proceeds on fresh names. It never fails or removes.
    - `uninstall_project` likewise deletes the record and returns what was left (`installer.ts:1085–1092`).
    - After either, the old sandbox has no record. The warning, and the uninstall result, are then the only places its name appears, so both carry the removal commands.
    - A test asserts that `nameHeldWarning` (`installer.ts:≈810`) cannot fire for an old sandbox whose names differ.
  - **References.** A test pins that a `SandboxRef` is made only from classified sources (`acquire`, `createContainer`), because the by-reference exec path does not classify (`docker.ts:≈2661`).
  - **Inverting the old tests.** Tests that pin "before is treated as this installation's" are inverted and renamed, not deleted, in the same leg. There are references in `test/docker.test.ts` (18), `test/server.test.ts` (3), `test/installer.test.ts` (1) and `test/integration/docker.test.ts` (5).
- **Docs:** the containment and security-model docs drop "treated as this installation's" and say what happens now. They also say an older mcp-everything on the same daemon still treats such sandboxes as its own, and that this version cannot prevent that.
- Rationale:
  - The operator's choice.
  - Name-based records cannot prove ownership (Open Questions).
  - The current behavior is the likely cause of `mcpe-rea`'s deletion in flight 2.
  - A sandbox that cannot be started cannot run uncontained, so flight 2's first standing gap closes.
- Trade-off: one manual `docker rm`/`docker volume rm` and a reinstall per old sandbox (the operator's `gron`). A project whose old sandbox held work in `/workspace/work` loses it when the operator removes the volume. The message says the volume holds the checkout and scratch space.

**DD5 — How the code is split: modules by concern, the class in a chain, only visibility changes.**
- **Top-level declarations of `docker.ts`** (lines 1–876: scripts, labels and ownership, errors, network specs and the proxy-report parser) move into modules by concern under `src/sandbox/`. The lean:
  - `scripts.ts`: clone, walk, probe and watchdog scripts, `parseProbeOutput`, `MANIFESTS`;
  - `ownership.ts`: labels, `classifySandbox`, facts, refusal messages, `SandboxRefusedError`;
  - `errors.ts`: the other error classes;
  - `network-spec.ts`: proxy address and MAC, subnets, `parseResolvConf`, `parseProxyReport`.
- **The `Docker` class** (lines 877–2898) is split along its method groups into a chain of classes, one per file. Boundaries from the Architect review, 2026-11-23:
  - **`src/sandbox/docker-base.ts`** (≈877–1339): the constructor and fields, the hook and its cache, `ask`, inspect and classify, the runtime check, `limits`, `runOnce` and `runCreated`. `startId`, `execOnce` and `hooked` stay together here so the bypass invariant stays auditable in one file.
  - **`src/sandbox/docker-network.ts`** (≈1340–2210): contained networks, project proxies, `runBehindProxy`, `listOwnSandboxes`.
  - **`src/sandbox/docker.ts`**: volumes, scanner, copy and sweep, and the container lifecycle (`exec`, `acquire`, `destroy`). `Docker` keeps its name and path and is still the only class anything outside instantiates.
  - No method in the network group calls up into the lifecycle group, so the chain is not cyclic. `requireVolumes` uses `Docker["inspectVolume"]` in a type (≈2273). The leg's design review settles whether that becomes the base class's name, which would be a body edit to state, or a type-only import.
- **The only edits allowed in method bodies:**
  - `private` becomes `protected` where a member is used across files;
  - import lines.
- **`containment.ts`:** only the lock moves, to a module of its own used by `Containment` through an explicit interface. The lock is `lockPath`, `acquireMutex`, `removeIfStale` and `acquireFile` (≈ 471–626), which use only `cfg`, the clock and the mutex map.
  - The startup registration (`registerStartup`, `registerStartupGate`, `waitFor`, ≈387–456) stays in `Containment`. It shares state with `ensureContained` and `clearFailedStartup` (Architect review).
- **Imports:** importers in `src/` import from the new homes. Whether `docker.ts` also re-exports the moved names is for the split leg's design review to decide and record. Tests change only in imports, and in `test/docker-bypass.test.ts`'s expected file or caller lists, which read source text.
- Rationale:
  - Flight 2's debrief, recommendation 2.
  - The chain keeps `Docker`'s public API and the test fakes that subclass it (overriding `protected docker()`) working unchanged.
  - Flight 3's leg 1 showed that a normalized diff verifies a pure move.
- Trade-off: an inheritance chain is a mechanical split, not a redesign. Composition is cleaner but is left for later; this flight changes no behavior.
- **The Architect's review weighed this and recommended keeping the chain** (2026-11-23). Composition would rewrite every `this.docker`, `this.ask`, `this.hooked` and `this.inspectContainer` call. It would also break the test doubles that override `protected docker()`/`clock()` on `Docker`: `FakeDocker` (`test/helpers.ts:51`), `ScriptedDocker` (`test/docker.test.ts:97`) and the one at ≈4615.

### Prerequisites
- [x] PR #32 (squawk turnaround 0057–0060) merged; `main` at `72a0420`.
- [x] A unit baseline on `main` (2026-11-23, `72a0420`): `npx vitest run` gave 2,988 passed, 71 skipped, 0 failed in each of two runs (18.3 s, 17.4 s).
- [x] The Docker suite (`npm run test:docker`) run once on `main` as a baseline, before leg 3. **Done 2026-11-23:** 66 passed, 5 skipped, 0 failed (678.8 s), and no Docker objects were left behind. It separates failures that already exist from the split's.
  - 0057's fix was not run against a live Docker 29 daemon; this run is the first to exercise it.
  - The baseline includes the old-sandbox (`before`) cases in `test/integration/docker.test.ts`, which leg 4 inverts.
- [x] The operator's `gron` (an old sandbox, label `mcp-everything=1`, no owner label) is still present for the HAT; checked with `docker inspect` (read-only) before the HAT.

### Pre-Flight Checklist
- [x] All open questions resolved
- [x] Design decisions documented
- [x] Prerequisites verified (Docker baseline before leg 3; `gron` check before the HAT)
- [x] Validation approach defined
- [x] Legs defined

---

## In-Flight

### Technical Approach
1. **Docs move** (leg 1). A move and a link rewrite, verified by a normalized diff against `git show 72a0420:README.md`.
2. **Clean-ups** (leg 2). Small changes in the files the split will move. Each is behavior-neutral or a stated change, and each is tested. After leg 2 lands, the Flight Director saves copies of `docker.ts`, `containment.ts` and `server.ts` to the scratchpad, as the reference for leg 3's normalized diff.
3. **Split** (leg 3). Declarations and methods move; only `private`→`protected` and imports change. Verification:
   - a normalized diff of every moved body against the saved copies;
   - typecheck, build and the full unit suite (default and slow);
   - the Docker suite.
4. **Ownership** (leg 4). The gate changes in one place plus its messages. The tests that pin the old rule are inverted and renamed. The docs text is rewritten. The Docker suite runs again, and the Flight Director reads every new or inverted destructive case before its first run.
5. **HAT** (leg 5). On the operator's own installation.

**Leg order.** The Architect review noted that doing the ownership leg before the split is also defensible: the security change would be verified on the unsplit file first. This flight keeps the split first. Ownership then changes one gate in a module of its own (`docker-base.ts` / `ownership.ts`), and the split's normalized diff stays against code that the clean-ups alone changed.

### Checkpoints
- [x] Docs moved; README summaries read by the operator at the HAT.
- [x] Clean-ups landed; the default unit run is shorter, and the slow run carries the moved cases.
- [x] Split landed; the normalized diff is empty and every suite passes as before.
- [x] Old sandboxes refused everywhere, with the removal message; the Docker suite passes.
- [x] HAT passed.

### Adaptation Criteria

**Divert if**:
- the split cannot be done without changing a method body beyond visibility and imports (for example, a cyclic import that needs restructuring). Stop and bring it back to the operator; do not redesign inside a move leg;
- refusing `before` breaks a path the design did not foresee, such as the startup pass or the sweep relying on starting old sandboxes. Bring it back before widening the leg;
- the Docker suite baseline on `main` fails in ways unrelated to this flight. Log a squawk and decide with the operator before leg 3.

**Acceptable variations**:
- different module names or boundaries from DD5's lean, recorded in the leg;
- `docker.ts` re-exporting moved names, if the split leg's review prefers it;
- the README summaries' wording, read by the operator at the HAT;
- the slow tests moved by a vitest project or by a directory exclusion, whichever vitest 5.1 supports cleanly.

### Legs

> **Note:** These are tentative suggestions, not commitments. Legs are planned and created one at a time as the flight progresses. This list will evolve based on discoveries during implementation.

- [x] `docs-split` — Move the README's three security chapters to `docs/`, leave summaries and links, add `docs` to `package.json` `files`, and repoint `test/readme.test.ts` (DD2). Low risk.
- [x] `cleanups` — Squawks 0054–0056, the withheld-tool accessor, slow tests out of the default run, and the in-process outbound note (DD3). Low risk; behavior-neutral apart from the stated test moves.
- [x] `split-docker-and-containment` — The mechanical split of `docker.ts` and `containment.ts` (DD5). High risk for its size: it gets a design review.
- [x] `old-sandboxes` — Refuse `before` everywhere, with messages, inverted tests and the rewritten docs text (DD4). High risk: it touches ownership, the security-sensitive surface, and reverses pinned behavior.
- [x] `hat-and-alignment` — Short guided HAT on the operator's installation:
  1. read `docs/` on GitHub;
  2. use one tool of the operator's `gron` and see the removal message;
  3. check that `project_info gron` says the same;
  4. check that `list_projects` and another project still work.

---

## Post-Flight

### Completion Checklist
- [x] All legs completed
- [ ] Code merged
- [x] Tests passing (unit default and slow, Docker suite)
- [x] Documentation updated (`docs/`, README summaries, the old-sandbox text)

### Verification
- `README.md` is roughly 660 lines shorter. Each security chapter has a summary and a link, and `docs/*.md` hold the old text unchanged (normalized diff).
- `npm pack --dry-run` lists `docs/checking.md`, `docs/containment.md` and `docs/security-model.md`.
- `src/sandbox/docker.ts` and `src/network/containment.ts` are split. No method body differs from before except in visibility and imports (normalized diff). The test count is unchanged apart from leg 2's stated deltas.
- An old sandbox:
  - `exec`, start and `destroy` refuse it, and a reinstall or uninstall leaves it in place. Each message names both `docker` removal commands;
  - unit tests and the Docker suite pin this;
  - the operator sees it on their own `gron` at the HAT.
