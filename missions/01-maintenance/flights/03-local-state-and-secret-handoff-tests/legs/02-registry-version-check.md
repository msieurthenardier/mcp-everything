# Leg: registry-version-check

**Status**: completed
**Flight**: [Local State Hygiene and Secret Hand-Off Tests](../flight.md)

## Objective
Make the registry refuse a file written in a format newer than the one this build writes, with a message that says so, and never rewrite such a file; and raise the hosted check's minimum test count to match the suite this flight leaves.

## Context
- Finding 6a of the [2026-11-15 maintenance report](../../../../../maintenance/2026-11-15.md), as restated in the flight's Technical Approach.
- Flight decision that binds this leg: **refuse to load, never rewrite.** No read-only mode. After a downgrade, every tool that needs the registry fails until the operator upgrades again or moves the file; that trade-off was accepted in the flight.
- The flight's divert condition, "the earliest released version wrote registry files that the version check would refuse", was checked at flight start and does not arise: the first commit of `src/registry.ts` (`45437ca`) already wrote `version: 1`, and nothing since has written anything else. So no released version wrote a file without a `version`. A missing `version` is still treated as 1, as the flight says, because a hand-written or hand-repaired file is the only place it can come from and reading it is harmless.
- Last leg of the flight. Leg 1 landed; it added a temp-file sweep to `Registry` that neither reads nor writes `registry.json`.
- The operator's live mcp-everything instance runs from this checkout's `dist/` and `node_modules/`. Never run `npm install`, `npm ci` or `npm run build` here.

Ground truth, by symbol (leg 1 moved the lines):

- `src/registry.ts`: `interface RegistryFile { version: 1; projects: … }`. `Registry.refresh()` stats the file, returns early when the mtime is the one it last loaded, otherwise parses it inside a `try` (`JSON.parse(…) as RegistryFile`, then `this.projects = new Map(Object.entries(parsed.projects ?? {}))`) and rethrows any failure as `Registry file <path> is unreadable: <reason>`. It sets `this.mtimeMs` only after a successful load, so a file that failed to load is read again on the next call. It never looks at `version`.
- Every write goes through `mutate` or `update`, and both begin, under the lock, with `this.mtimeMs = -2; this.refresh();`. A `refresh()` that throws there stops the write before anything is changed, and the `finally` releases the lock. So a check inside `refresh()` is also a check before every write.
- `persist()` writes `{ version: 1, projects }`.
- Who meets a throwing `refresh()`:
  - `App.callTool` (`src/server.ts`) calls `this.registry.refresh()` first, inside its `try`: the tool call returns `Error: <message>` and the message is logged.
  - `App.start()` logs `registry: <message>` and carries on; the 5-second watcher swallows it; the startup tasks log it per task.
  - `App.listTools` reads the in-memory list without refreshing: after a refusal at startup it lists the built-in tools only.
  - `Installer.install` and `reconcileStale` call `refresh()` themselves; both are reached only through the paths above. At startup the log therefore gets two lines for a refused file, `registry: …` from `start()` and `reconcile: …` from the reconciliation.
  - An install **already running** in this process when the file turns newer: its next `registry.put` throws, the `catch` in `install` calls `put` or `delete` again and that throws too, and the error leaves `install` and reaches the install job, which reports it. Nothing is written. The sandbox it was building stays in Docker with a record that was never updated.
- `test/registry.test.ts`: "reports a corrupt registry file instead of silently discarding it" writes `"{ nope"` to `registry.json` and expects `refresh()` to throw `/unreadable/`. Every other case writes through `put`, so every file the suite produces has `version: 1`.
- `.github/workflows/ci.yml`, step "Minimum passed tests": `const floor = 430;` under a comment that begins "447 tests pass as of 2026-11-16".
- `README.md`: the configuration table's `MCPE_DATA_DIR` row says where the registry is stored; the limitations list describes `registry.json`.

## Inputs
- Leg 1 landed, uncommitted, in the working tree.

## Outputs
- `src/registry.ts` — the check, and one constant for the format version.
- `test/registry.test.ts`, `test/server.test.ts` — cases.
- `README.md` — one sentence.
- `.github/workflows/ci.yml` — the floor and its comment.

## Acceptance Criteria
- [x] The format version this build reads and writes is one named constant, used by the type, by the check and by `persist()`.
- [x] **Newer file**: when `registry.json` holds a `version` that is an integer greater than the constant, `refresh()` throws an error that begins `Registry file <path>` like the class's other errors, names the file's version and the version this build reads, says the file is left untouched, and says what to do: upgrade mcp-everything; moving the file aside starts this build with an empty registry, but the sandboxes of the projects in it stay in Docker and are no longer listed. The message does not say "unreadable": the file is fine, this build is old.
- [x] **Never rewritten**: with such a file in place, `put`, `delete` and `update` each throw the same error; afterwards the file's bytes are identical to before, no `registry.json.<pid>.tmp` exists, and `registry.json.lock` does not exist.
- [x] **Refused every time, then accepted**: a second `refresh()` on the unchanged file throws again; after the file is replaced by one this build can read, `refresh()` loads it.
- [x] **Records already in memory are kept** when a refused file appears under a running process: `list()` returns what it returned before the failed `refresh()`.
- [x] **A missing `version`** on an otherwise valid file loads as before.
- [x] **Any other `version`**, meaning one that is present and is neither the constant nor an integer greater than it (`0`, `-1`, `1.5`, `2.5`, `"1"`, `null`, `true`, an object, or a number too large for JSON such as `1e999`), is refused through the existing error as `Registry file <path> is unreadable: unsupported version <the value as JSON>`. It is not loaded and not rewritten. (`"1"` as a string loads today and will not after this leg; nothing released ever wrote it.)
- [x] **A file with `version: 1`** loads exactly as before; no existing case changes.
- [x] **Through the server**: with a newer file in the data directory before the `App` is built, `App.start()` does not throw, the startup promise (`App.startup`) resolves, both startup sweeps still ran, `list_projects` returns an error result carrying the refusal, the log has the refusal, and the file's bytes are unchanged afterwards.
- [x] `README.md` says in one sentence, where it describes the registry file, that a registry written by a newer version is refused and left untouched, and what the operator does about it.
- [x] `.github/workflows/ci.yml`: the floor is the multiple of 10 that lies between 15 and 24 below the number of unit tests passing after this leg, and the comment states that number and today's date. Nothing else in the workflow changes.
- [x] `npm run typecheck` is clean. `npx vitest run --testTimeout 20000` passes; counts recorded. The workflow's own count step, run locally with `RUNNER_TEMP` pointed at a scratch directory, passes with the new floor.

## Verification Steps
- Write the cases first and run them against the unchanged `refresh()`: the newer-file cases must fail (today the file loads and the next write rewrites it as version 1). Record what the unchanged code did to the file. Do not use `git stash`, `git restore` or `git checkout` of files.
- `npm run typecheck`; `npx vitest run --testTimeout 20000`.
- Extract the workflow's unit-test and count steps and run them with `RUNNER_TEMP` set to a scratch directory outside the repository; the count step prints "<n> tests passed (floor <floor>)". Parse the YAML with `python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" .github/workflows/ci.yml`.
- By reading: the check runs before `this.projects` is assigned and before `this.mtimeMs` is updated.
- `git status --short`: only the files under Files Affected, on top of leg 1's.

## Implementation Guidance
1. In `src/registry.ts`: a constant (for example `REGISTRY_VERSION = 1`); `RegistryFile.version` typed from it; `persist()` writes it.
2. In `refresh()`, after `JSON.parse` and before `this.projects` is assigned: read `version` from the parsed value as `unknown`, and decide in this order. Missing (`undefined`): continue. Equal to the constant: continue. `Number.isInteger(version)` and greater than the constant: the newer-version error. Anything else: the unreadable error with the reason `unsupported version <JSON.stringify(version)>`. The newer-version error must not be swallowed into "unreadable" by the existing `catch`: parse into a local inside the `try`, and do the version check and the assignment after it; or let the `catch` pass that one error through. (`1.0` in the file is the number 1 after parsing and loads.)
3. Tests in `test/registry.test.ts`, beside the corrupt-file case: write the file by hand with `fs.writeFileSync` (for example `{"version":2,"projects":{"x":{…}},"future":true}`), then one case per criterion. Compare bytes with `fs.readFileSync` before and after. For "records already in memory", use one instance: `put` a record, overwrite the file by hand with a newer one, set its mtime to something clearly different with `fs.utimesSync` (so the read is not skipped as unchanged), then assert `refresh()` throws, `list()` equals what it was, and a second `refresh()` throws again. A fresh instance cannot show this; it holds no records.
4. One case in `test/server.test.ts` through the `App`, awaiting `App.startup`, in the startup `describe` leg 1 extended (it already has a corrupt-registry case to model on). Assert the log has both the `registry:` and the `reconcile:` line carrying the refusal, and that `list_projects` returns an error result.
5. README: one sentence. The floor: last, after this leg's cases exist, run the full unit suite, compute the floor from the passing total and edit the constant and the comment (the comment's "447" is already stale: leg 1 took the suite to 482).
6. Flight log: a `### registry-version-check` entry under Leg Progress, including what the unchanged code did in the reproduction.

## Edge Cases
- **The file's mtime does not change between two hand writes in one test** (same millisecond): `refresh()` would return early. Use a fresh `Registry` instance, or set the mtime with `fs.utimesSync`.
- **`version` is `2` as a string, or `1.5`**: refused as unsupported, per the criterion. Nothing this project ever released wrote those.
- **The parsed value is `null`**: reading a property of it throws inside the `try`, as today, and is reported as unreadable. Keep that.
- **The parsed value is an array, a number or a string**: it has no `projects` and no `version`, so today it loads as an **empty registry**, and the next write replaces the file. That is a hazard of its own, found by the design review, and it is not this leg's: it is logged as squawk [0034](../../../../../squawks/0034-registry-file-that-is-not-an-object-loads-as-empty.md). Leave the behavior as it is and write no test that pins it either way.
- **An install is running in this process when a newer process rewrites the file**: see Context. The install job reports the refusal and its sandbox is left in Docker until a reinstall on a build that can read the file. Accepted with the flight's trade-off; no test is required for it.
- **A process that was running when a newer process rewrote the file**: its in-memory records stay, its tool list stays, and every tool call reports the refusal until it is restarted on the newer version. That is the flight's accepted trade-off; do not add a read-only mode.

## Files Affected
- `src/registry.ts`
- `test/registry.test.ts`, `test/server.test.ts`
- `README.md`
- `.github/workflows/ci.yml`

## Out of Scope
- Migrating between versions (there is only one), a read-only mode, quarantining a corrupt file, squawk 0017 (emptying the registry on a stat error).
- Any change to the temp sweep from leg 1, which must keep working when the file is refused.

## Citation Audit
Written on 2026-11-16 from a read of `661db3e`, by symbol. Re-checked against the working tree after leg 1 landed: `Registry.refresh()` is unchanged (the parse and the assignment of `this.projects` share one `try`; `this.mtimeMs` is set after it); `mutate` and `update` still begin with the forced `refresh()`; leg 1's `sweepTemps` calls neither `refresh()` nor `persist()`; the startup field is now `App.startup`; the workflow still has `const floor = 430;` under the "447 tests pass" comment. No drift. The design review traced every read and write of `registry.json` (one reader, `refresh()`; one writer, `persist()`, reached only after a forced `refresh()`) and confirmed that a `refresh()` that throws inside `mutate` or `update` releases the lock, creates no temp file, leaves the in-memory map alone and is never skipped as unchanged afterwards.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
