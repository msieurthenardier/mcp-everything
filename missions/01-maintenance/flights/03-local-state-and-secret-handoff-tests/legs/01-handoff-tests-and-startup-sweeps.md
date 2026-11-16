# Leg: handoff-tests-and-startup-sweeps

**Status**: completed
**Flight**: [Local State Hygiene and Secret Hand-Off Tests](../flight.md)

## Objective
Close the two small gaps in the tests of how a variable's value is handed to Docker, and remove at startup the two kinds of file a crash can leave in the data directory: env files, which hold values, and registry temp files.

## Context
- Findings 5 and 6d of the [2026-11-15 maintenance report](../../../../../maintenance/2026-11-15.md), as restated in the flight's Technical Approach, **corrected by the flight log's Flight Director Notes of 2026-11-16**: the connector's argument list, the file's mode and its removal are already unit-tested, and so is the proxy calling `cleanup` once per launch. Read those notes before starting. This leg does not rewrite those tests; it adds what is missing.
- Flight decision that binds this leg: **startup sweeps touch only files that cannot be in use**, recognized by the names the product itself writes and by age. The age bound is an acceptable variation "if stated and tested".
- Flight 02 left the pattern for startup work on a directory several processes share: check again immediately before acting; do nothing when unsure; give tests a promise to await. `App.start()` keeps flight 02's reconciliation in a public field, `reconciling`.
- First leg of this flight. Findings 6a (the registry's version) is the next leg; do not start it here.
- The operator's live mcp-everything instance runs from this checkout's `dist/` and `node_modules/`. Never run `npm install`, `npm ci` or `npm run build` here.

Ground truth, read on 2026-11-16 at branch head `661db3e`:

- `src/proxy/mcp-proxy.ts`, `dockerConnector` (`:72`): when the server has an environment it creates `<dataDir>/tmp` (`:81-82 — "fs.mkdirSync(dir, { recursive: true, mode: 0o700 });"`), writes `env-<16 hex>` there (`:83 — "envFile = path.join(dir, `env-${randomBytes(8).toString("hex")}`);"`, mode 0600 at `:85`), and passes `--env-file <path>` to `docker exec`. `cleanup` removes the file (`:101-103`).
- The file's life in a healthy launch: written when `McpProxy.attempt` calls the connector (`:150`), read by the `docker` client when it starts inside `client.connect` (the client parses `--env-file` before any handshake can complete, so removing the file afterwards is safe), removed in the `finally` at `:171-173`. On a handshake that fails, `client.close()` and `kill` (a `docker exec` limited to 10 s, `:139`) run before that `finally`. So a live file lasts at most the startup timeout plus about 12 seconds: `cfg.mcpStartupTimeoutSec`, default 30 s, set by `MCPE_MCP_STARTUP_TIMEOUT` with no upper clamp (`src/config.ts:134`); installs probe with 15 s. The relaunch path removes the first file before the second is written. A process killed between `:150` and `:172` leaves the file.
- One more way a file is left, found in the design review: `attempt` calls the connector outside its `try` (`:150`), so if `dockerConnector` throws after the write at `:85` (a partial write on a full disk, or the transport's constructor throwing), `cleanup` is never reached. Not changed in this leg; logged as squawk [0033](../../../../../squawks/0033-connector-throw-after-write-leaves-env-file.md). The sweep is its backstop.
- `src/registry.ts`: `persist` (`:85`) writes `registry.json.<pid>.tmp` (`:87 — "const tmp = `${this.file}.${process.pid}.tmp`;"`) and renames it over `registry.json`. It runs only inside `mutate` and `update`, which hold the lock from `lock()` (`:50`). The lock is a file created exclusively; a waiter removes it when it is older than 10 s **or after waiting 5 s**, so the lock can be taken from a live but slow writer, and holding it proves nothing about a write in flight. `lock()` also waits with `Atomics.wait` (`:68`), which blocks the whole event loop. So the registry sweep does **not** take the lock: it would add a possible 5-second stall at startup, before the server answers `initialize`, for no protection. Age is the protection: a write takes milliseconds and the bound is an hour. A process killed between the write and the rename leaves the temp file.
- Nothing else in `src/` writes under `<dataDir>/tmp` or creates a `.tmp` file (`grep -rn '"tmp"\|\.tmp' src`).
- `prepareDataDir` (`src/server.ts:945`) creates the data directory with mode 0700 at startup, before `App` is built (`src/index.ts`).
- `App.start()` (`src/server.ts`, `start(): void`): refreshes the registry, then `this.reconciling ??= this.installer.reconcileStale(Date.now(), this.log).then(() => {}).catch(…)`, then starts the watcher. An async function runs synchronously up to its first `await`, so `reconcileStale`'s own `registry.refresh()` already runs inside `start()`; only its Docker calls happen later. `reconciling` is read by three cases and the `afterEach` in `test/server.test.ts` (`describe("reconciling stale installs at startup")`, `:1110`), and by nothing in `src/` outside `App`. `src/index.ts` calls `start()` and then connects the transport, so anything slow and synchronous in `start()` delays the reply to `initialize`.
- Tests that exist and stay:
  - `test/proxy.test.ts:152`, `describe("dockerConnector")` — "passes the environment through a private env file, never through argv": calls the real connector, reads the argument list from the transport (`_serverParams`), asserts the value is absent from it, the file's content, mode 0600, and that `cleanup` removes it. It does **not** assert the mode of `tmp`, nor that the value is absent, under its own name, from the environment given to the `docker` client (`_serverParams.env`), which the comment at `src/proxy/mcp-proxy.ts:77-80` promises.
  - `test/integration/docker.test.ts` (Docker suite) already asserts that `tmp` is empty after a successful real launch.
  - `test/proxy.test.ts:282`, "hands a variable of the launch spec to docker through the env file only, never on a command line".
  - `test/proxy.test.ts:182`, `describe("McpProxy start-up after an idle stop")` — a `cleanup` spy on the in-memory connector; `cleanups` is asserted `[1, 1]` (first launch failed, second succeeded) and `[1]` (failed).
  - `test/server.test.ts:836 — "expect(JSON.stringify(docker.calls.map((c) => ({ argv: c.argv, opts: c.opts })))).not.toContain(SECRET_VALUE);"`, in "only MCP server processes receive it: command line tools and sandbox_exec do not". It covers `Docker.exec` calls, which is what that test is about.
  - `test/registry.test.ts`, "steals a stale lock left by a dead process" — shows how a test ages a file: `fs.utimesSync(file, old, old)`.
- `README.md:360-366` is where the README describes the registry file and the "private temporary file" that carries values.

## Inputs
- Branch `flight/03-local-state-and-secret-handoff-tests`, cut from `main` at `661db3e`.
- `npm run typecheck` clean; `npx vitest run` at 447 passed, 18 skipped.

## Outputs
- `test/proxy.test.ts`, `test/server.test.ts` — the two gaps closed; one comment.
- `src/proxy/mcp-proxy.ts` — a sweep of leftover env files.
- `src/registry.ts` — a sweep of leftover registry temp files.
- `src/server.ts` — `App.start()` runs both; one awaitable for all startup work.
- `test/registry.test.ts`, `test/proxy.test.ts`, `test/server.test.ts` — cases for the sweeps.
- `README.md` — one sentence.

## Acceptance Criteria

Hand-off tests (no change to `dockerConnector` is expected):
- [x] A case asserts that the directory the real connector creates for env files has mode 0700, and that the environment the connector gives the `docker` client does not carry the variable under its own name. Use a variable name the test makes up and checks is not already in `process.env`; assert the name is not a key of that environment and the value is not among its values.
- [x] A case shows that a value the env file cannot carry (one with a line break) makes the real connector throw and leaves no file in `tmp`.
- [x] One case takes a real env file through `McpProxy`: with a connector that uses the real `dockerConnector` for the file and its `cleanup`, and the in-memory transport for the conversation, the file exists with mode 0600 while the handshake runs, and `<dataDir>/tmp` holds no file after a launch whose handshake succeeds; a second case, the same after a launch whose handshake fails.
- [x] **Shown once, by hand, as the first thing done in this leg, and recorded in the flight log**: while `git diff --stat src/proxy/mcp-proxy.ts` is still empty, a value is temporarily put into the connector's argument list and "passes the environment through a private env file, never through argv" fails; the edit is undone, the case passes, and `git diff --stat src/proxy/mcp-proxy.ts` is empty again.
- [x] The assertion at `test/server.test.ts:836` is unchanged, with a comment above it saying it covers `Docker.exec` calls (command line tools and `sandbox_exec`) and that a proxied launch's arguments are covered in `test/proxy.test.ts`.

Env-file sweep:
- [x] A function removes, from `<dataDir>/tmp`, regular files whose name is exactly `env-` followed by 16 lowercase hex digits and whose modification time is older than the bound. The bound is one named rule: `max(3600, 2 × cfg.mcpStartupTimeoutSec)` seconds, with a comment saying what it is measured against (a live file lasts at most one startup timeout) and what it does not cover (a neighbor process with a much larger timeout; a clock that jumped forward; in both, the cost is one failed launch).
- [x] It leaves alone: a matching file at or under the bound; any other name (including `env-` with 15 or 17 hex digits, uppercase hex, or a suffix); a directory or a symbolic link with a matching name (and the link's target); everything outside `tmp`.
- [x] It examines each file immediately before removing it (`lstat`), removes with `unlink` (which cannot remove a directory and does not follow a link), ignores a file that has gone, never reads a file's contents, and never puts a file's contents in a log line or an error.
- [x] It does not create `tmp` when it does not exist, and it does not throw. A failure on one file is logged by name and the rest are still examined. A failure to list the directory other than its absence (`tmp` is a file; a permission error) is logged with the directory's path and the function returns 0.

Registry temp sweep:
- [x] A method on `Registry` removes, from the data directory, regular files whose name is exactly `registry.json.<digits>.tmp` and whose modification time is more than one hour old (a named constant, with a comment: a write takes milliseconds; the registry lock is not taken, because it can be taken from a live writer anyway and waiting for it blocks the event loop; what the rule does not cover is a writer stopped for more than an hour between its write and its rename, whose rename then fails). It does not take, create or remove `registry.json.lock`.
- [x] It leaves alone: a matching file at or under the bound; `registry.json`; `registry.json.lock`; any other name; a directory or symbolic link with a matching name.
- [x] It neither reads nor writes `registry.json`: the file's bytes and `mtimeMs` are unchanged afterwards, and the sweep works when `registry.json` is missing or corrupt.
- [x] Same `lstat`, `unlink`, gone-file, per-file failure and listing-failure rules as the env-file sweep, logged through the same kind of callback. It does not create the data directory when it does not exist.
- [x] `Registry.put`, `delete` and `update` behave as before, and a sweep run while another `Registry` instance holds the lock file returns at once.

Startup:
- [x] `App.start()` runs both sweeps and then the stale-install reconciliation. The sweeps are a few synchronous file operations with no lock and no Docker call: they run inside `start()`, before the reconciliation begins, and are finished when `start()` returns. One public field holds one promise that resolves when all startup work is finished, never rejects, and is what tests await. It replaces `reconciling` (renamed, for example to `startup`); the three flight 02 cases and their `afterEach` use the new name and still pass. The sweeps and the reconciliation run once per `App`: a second `start()` call repeats neither (shown by putting an old file of each kind in place between two calls and finding both still there), and the field holds the same promise. `shutdown()` and `stop()` do not wait for the promise.
- [x] One task failing does not stop the others, and each failure is logged with which task it was. In particular the sweeps run when `registry.refresh()` throws at startup (a corrupt registry file).
- [x] When a sweep removed something, one line is logged with the kind and the count. Nothing is logged when nothing was removed. (The existing startup `describe` builds its `App` without a `log`; the case for this passes one.)
- [x] Through a started `App`: when `start()` has returned, an old env file and an old registry temp file are gone and a fresh one of each is still there; after the startup promise has been awaited, a stale install is reconciled as before.

Documentation and suite:
- [x] `README.md`, at the passage on the private temporary file (`:360-366`): one sentence saying that a file left there by a crash is removed at a later start, once it is more than an hour old.
- [x] `npm run typecheck` is clean. `npx vitest run --testTimeout 20000` passes with more than 447 passed and 18 skipped.

## Verification Steps
- **First, before any other edit**, the argv experiment: confirm `git diff --stat src/proxy/mcp-proxy.ts` prints nothing; edit `dockerConnector` to push the values of `server.env` into `args`; run `npx vitest run test/proxy.test.ts -t "never through argv"` and see it fail; undo the edit; run it again and see it pass; confirm `git diff --stat src/proxy/mcp-proxy.ts` prints nothing again. Record the failing assertion's message.
- Then write the sweep and startup cases and run them before the implementation, so they are seen to fail. Record which were. Do not use `git stash`, `git restore` or `git checkout` of files for this or for anything else.
- `npm run typecheck`; `npx vitest run --testTimeout 20000`; record the counts.
- By reading: no test waits on real time (files are aged with `fs.utimesSync`, and the sweeps take the current time as a parameter); no log line or error message in the new code can contain a file's contents.
- `grep -rn "reconciling" src test` finds nothing after the rename.
- `git status --short`: only the files under Files Affected and this flight's artifacts. The Docker suite is not run in this leg; it runs once at the end of the flight.

## Implementation Guidance

1. **Env-file sweep**, in `src/proxy/mcp-proxy.ts` next to `dockerConnector`, exported, for example `sweepEnvFiles(cfg: Config, now = Date.now(), log: (line: string) => void = () => {}): number`. Share the file-name shape with `dockerConnector` (one constant or one small function used by both) so the writer and the sweep cannot drift apart. `readdirSync` the directory (missing: return 0; any other failure: log the path and the error's message, return 0); for each name that matches, `lstatSync`, require `isFile()` and age over the bound, `unlinkSync`. Wrap each file in its own `try`; `ENOENT` is not an error.

2. **Registry temp sweep**, a method on `Registry`, for example `sweepTemps(now = Date.now(), log: (line: string) => void = () => {}): number`. If the directory does not exist, return 0. Do the same list, match, `lstat`, age check and `unlinkSync`, with the same handling of failures. Do not call `lock()`, `refresh()` or `persist()`.

3. **`App.start()`** (`src/server.ts`): on the first call only, run the two sweeps, each in its own `try` that logs the task's name and the error; then start the reconciliation as today and keep its promise in the renamed field. The sweeps go first because the reconciliation can wait on Docker for a minute. Guard the sweeps and the reconciliation together so they run once per `App` (for example, do both only when the field is still unset, and assign the field in the same synchronous step). Leave the rest of `start()` as it is: the registry refresh and the watcher's `setInterval` run on every call today, and a second call leaves the first interval running. That is existing behavior, reached by no caller in `src/`; note it in the flight log, do not change it. Rename the field and update `test/server.test.ts`.

4. **Tests.**
   - `test/proxy.test.ts`: the directory-mode assertion (extend the existing connector case or add one beside it); the two cases through `McpProxy`. For those, build the connector in the test: call `dockerConnector(cfg)(launch)` for the file and `cleanup`, call the file's fake (`up.connector(launch)`) for `transport` and `stderr`, and return the combination. The real connector constructs its transport without starting a process, so nothing is spawned. Use `up.answer = false` and a short startup time for the failing case, as the cases under "McpProxy start-up after an idle stop" do. To look at the file while the handshake runs, not merely after the connector returns, hook the upstream server the fake creates (`up.servers`, `oninitialized`). In the failing case no upstream server exists: check the file right after the wrapped connector has created it, and again after the launch has rejected (`attempt` removes it only after `kill`, which awaits a `Docker.exec`). Add the two small assertions and the line-break case beside the existing connector case. Then a `describe` for `sweepEnvFiles`: one case per line of its criteria. Create a symbolic link with `fs.symlinkSync` to a file outside `tmp` and assert both link and target survive.
   - `test/registry.test.ts`: a `describe` for the temp sweep: one case per line of its criteria, including a corrupt `registry.json` (`"{ nope"`, as the existing corrupt-file case writes) and bytes-and-mtime unchanged. For "returns at once while the lock file is held": write `registry.json.lock` by hand, sweep with an aged temp file present, and assert the temp file is gone, the lock file is still there with the same `mtimeMs`, and `Atomics.wait` (under `vi.spyOn`) was never called. Add a case for each sweep with the directory listing failing (`tmp` created as a regular file; for the registry, a data directory path that is a file).
   - `test/server.test.ts`: in the existing startup `describe`, the case through `App.start()` with old and fresh files of both kinds, asserted right after `start()` returns; a case where one task throws (`vi.spyOn(local.registry, "sweepTemps")` made to throw; `registry` is a public field. Do not try to spy on `sweepEnvFiles`: spying on an ES module export is unreliable) and the other sweep and the reconciliation still ran; a case with a corrupt `registry.json` in which both sweeps still ran.
5. **The comment** above `test/server.test.ts:836`.
6. **README**: one sentence at `:360-366`.
7. **Flight log**: a `### handoff-tests-and-startup-sweeps` entry under Leg Progress: what changed, each verification with its result, the argv experiment's output, which cases were seen to fail first, anything that differed from this leg.

## Edge Cases
- **A neighbor process is launching a server right now.** Its env file is seconds old; the bound is an hour. Left alone.
- **A neighbor process is mid-write on the registry.** Its temp file is milliseconds old; left alone by age. The sweep takes no lock, so it neither waits for that writer nor disturbs it.
- **This process's own pid appears in a leftover temp file's name** (the pid was reused after a crash). It is still just an old file; the sweep runs at startup, before this process has written anything. Removed if old. (If another process that was just given that same pid writes its temp file between the sweep's `lstat` and its `unlink`, that process's rename fails once. Microseconds wide and needs the pid reused at that instant; accepted.)
- **`tmp` exists with a looser mode than 0700** (created by something else). Not this leg's concern; do not chmod it. Note it in the flight log if the directory-mode test shows `mkdirSync` leaves an existing directory's mode as it is.
- **The data directory is on a filesystem with coarse or odd timestamps.** The bound is an hour; a second's coarseness does not matter.
- **Many leftover files.** Each is one `lstat` and one `rm`; no batching needed.
- **A file that matches the name but belongs to the operator.** The names are specific enough (16 hex digits; `registry.json.<digits>.tmp`) that the flight's divert condition, "a sweep cannot tell its own files from an operator's without a naming change", does not arise. If you conclude otherwise, stop with `[BLOCKED:sweep-names]`.

## Files Affected
- `src/proxy/mcp-proxy.ts` — `sweepEnvFiles`; the shared name shape
- `src/registry.ts` — the temp sweep
- `src/server.ts` — `App.start()`, the renamed field
- `test/proxy.test.ts`, `test/registry.test.ts`, `test/server.test.ts`
- `README.md` — one sentence

## Out of Scope
- The registry's `version` (next leg).
- Any change to `dockerConnector`'s behavior, to the `Connector` interface, or to how `McpProxy` calls `cleanup`. That includes squawk 0033 (a connector that throws after writing its file).
- The lock's steal timing; emptying the registry on a stat error (squawk 0017); quarantining a corrupt registry.
- Sweeping on a timer or on a tool call. Startup only.
- Squawks 0029 to 0032, which touch `test/installer.test.ts` and `Installer`. Do not fold them in.
- The hosted check's minimum test count: raised once, in the flight's last leg.

## Citation Audit
Checked on 2026-11-16 against `661db3e`, each by reading the file: `src/proxy/mcp-proxy.ts:72`, `:77-80`, `:81-85`, `:101-103`, `:139`, `:150`, `:171-173`; `src/config.ts:134`; `src/registry.ts:50`, `:68`, `:85`, `:87`; `src/server.ts:945`; `test/proxy.test.ts:152`, `:182`, `:282`; `test/server.test.ts:836`, `:1110`; `README.md:360-366`. No drift. The design review re-checked them, confirmed the two file-name shapes against the code that writes them, and found no other writer under `tmp` or beside `registry.json`.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
