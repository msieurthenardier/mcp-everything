# Leg: installation-identity-and-owned-names

**Status**: completed
**Flight**: [Owned Sandboxes](../flight.md)

## Objective
Give an installation a persistent id, put that id in the name and in a label of every sandbox it creates, and make a reinstall move a project from its old sandbox names to new ones without ever leaving a sandbox that no record names.

## Context
- Flight decisions this leg implements: DD1 (the id and its file), DD2 (names), DD3 (the owner label), DD6 (the order of a reinstall and its failure branch), and the parts of DD9 that need no Docker call (the id in `list_projects`, the sandbox's name in a project's full description).
- **Nothing is refused in this leg.** The ownership check, the two error types, the checked reference, and what uninstall and reinstall do with another installation's sandbox are legs 2 and 3. Removals here still use the check `Docker.destroy` has today, so a reinstall of a record that names another installation's sandbox still removes it, as today, until leg 3.
- A sandbox from before this change keeps its stored names and behaves as today (DD5). Do not rename fixtures that stand for such records. A first install does not look for, or touch, a sandbox with the old-style name for its slug.
- Not in this flight at all, by the operator's decision: making record writes conditional against a reinstall from another session. Do not add it.
- The registry's format does not change. `src/index.ts` does not change (its stack trace on a startup error is squawk 0027's).
- Names that legs 2 and 3 will rely on, fixed here: the Docker layer's public read-only property `installationId`, and its method `sandboxName(slug)`.
- From mission 01: one definition of a file's name, shared by the code that writes it and the code that sweeps it; work at startup on a shared directory checks again before acting and does nothing when the answer is unknown; for each new test, be able to name the source change that makes it fail.

## Inputs
- Branch `flight/01-owned-sandboxes`, cut from `mission/02-planning`; no source change yet.
- Unit suite, run at this leg's design review: 515 passed, 18 skipped, across 18 files, with the integration file skipped. (The flight spec's "500" was the count the hosted check's comment recorded.) Docker suite: 16 cases, about 154 s.
- `npm run typecheck` covers `src` and `test` (`tsconfig.json` includes both), so a construction site of the Docker layer that was missed fails there, including in the Docker suite's file, which the unit run skips.
- The operator's four sandboxes and their container ids are recorded in the flight log ("Execution start"). They must be the same after this leg's test runs.

## Outputs
- `src/installation.ts`: the id file module.
- The Docker layer constructed with the id; names and owner labels on what it creates.
- `Installer.install` reordered.
- `list_projects` and the full project description extended.
- Two README sentences corrected.
- Tests for all of it; the existing suites green.

## Acceptance Criteria

**The id file.** "Valid" below means: the file's content, with at most one trailing newline removed, is exactly eight lowercase hexadecimal characters.
- [x] AC1. On a data directory with no id file, loading the id creates a file named `installation-id` in that directory whose content is a valid id and a newline, and returns the id. The file's permission bits are 0600 under the default umask (and never looser than the mode it was created with, under any umask). The directory is created if it is missing.
- [x] AC2. A second load on the same directory returns the same id and leaves the file's content unchanged.
- [x] AC3. When a second load completes between the first load's write of its temporary file and its link, both return the same id, and the directory holds one `installation-id` and no temporary file.
- [x] AC4. When the link fails with an error other than "the name exists", the fallback creates the file; the id returned is valid and is the file's content; no temporary file is left. When the link fails because the name exists, the fallback is not used and the existing file's id is returned.
- [x] AC5. A file of eight or more characters that is not valid makes the load throw at once, with an error whose message contains the file's path and says the file must be restored or, if no sandbox belongs to this data directory, deleted. The file is unchanged afterwards and no other file has been created. Covered at least for: nine hexadecimal characters, an uppercase character, a non-hexadecimal character.
- [x] AC6. A file of fewer than eight characters is treated as possibly being written: the load re-reads, waiting between reads, for no more than two seconds of requested waiting in all; it returns the id if the file becomes valid in that time, and otherwise throws the error of AC5. The bound is the sum of the waits requested, not the wall clock, so a test that replaces the wait with a function that returns at once finishes at once.
- [x] AC7. A temporary file of the id module older than one hour is removed by a load; a younger one is not. The module's temporary names are not matched by `Registry.sweepTemps`, and the module's sweep does not touch `registry.json.<digits>.tmp`. Both directions are tested.
- [x] AC8. When the file can be neither read nor created, the load throws an error that names the file and returns no id. "Absent" means only that the read failed because there is no such file; any other read failure throws. Tested without relying on file permissions (for example with a directory in the file's place, and with the data directory's path under a regular file).

**The id in the Docker layer**
- [x] AC9. `Docker` takes the id as a required constructor argument, has a public read-only property `installationId` equal to it, and throws on construction when it is not a valid id.
- [x] AC10. An `App` constructed without an injected Docker double loads the id from its data directory: afterwards the file exists and `app.docker.installationId` is its content. An `App` constructed with a double creates no id file.
- [x] AC11. The arguments of `docker volume create` in `probe` and of `docker run` in `createContainer` each contain `--label mcp-everything.owner=<id>`, in addition to the labels written today.

**Names**
- [x] AC12. `sandboxName(slug)` returns `<prefix><id>-<slug>`. A first install records `container` and `volume` both equal to it: `mcpe-<id>-widget` with nothing configured, and `<chosen><id>-widget` when `MCPE_NAME_PREFIX` is set.
- [x] AC13. No code in `src/` joins the name prefix to anything except `sandboxName`.

**Reinstall.** "The registry" in these criteria means what `registry.json` holds on disk, read afresh, never an object the installer may still be changing.
- [x] AC14. Reinstalling a project whose record holds old names (`mcpe-widget`): proxied servers on the old container are closed, and the old container and the old volume are removed, while the registry's record says `installing` and still holds the old names; the record takes the new names only after that removal returned; whatever is at the new names is removed before the clone; the install ends `ready` with the new names.
- [x] AC15. During that reinstall, at every call into the Docker double and at the call that closes the old container's proxied servers, the registry's record for the slug holds the old names until the old sandbox's removal has returned, and the new names from then on. It never holds the new names while the old sandbox has not been removed.
- [x] AC16. Reinstalling a project whose record already holds the names computed now removes that sandbox once before the clone, not twice; if that removal throws, the outcome is today's (the removal is tried again with its failure ignored, and the record is deleted).
- [x] AC17. When the names differ and removing the old sandbox throws: `install` rejects with an error that names the project, says the old sandbox could not be removed and why, and says the project was left as it was. Afterwards the registry's record equals the record from before the install (same status, tools, commands, selection, names and `installedAt`) plus one warning, a fixed sentence that carries no part of the error, saying a reinstall could not remove the old sandbox, which may be partly removed. Nothing was removed at the new names, no clone was attempted, and the record was not deleted. A second such failure leaves exactly one copy of the warning.
- [x] AC18. Through the tool: `install_project(reinstall: true)` in the case of AC17 returns an error result whose text is that error, and contains neither "The sandbox was kept" nor "Nothing was installed".
- [x] AC19. When a reinstall fails after the record took the new names and before a container exists (the clone fails): whatever is at the new names is removed and the record is deleted, as today. When it fails once a container exists: the sandbox is taken offline and the record is kept as `failed` with the new names, as today.
- [x] AC20. An install without `reinstall` over a record that is `failed`, and over one that says `installing`, takes the same path as AC14.
- [x] AC21. A first install behaves as today apart from its names: one removal at its target names opens it, and the failure branches end as they do today.

**What the operator sees**
- [x] AC22. `list_projects` begins with a line stating this installation's id, both when projects are installed and when none is; the tool's description mentions it. A registry that cannot be read still produces its own error from `list_projects`, as today. The full description of a project (`project_info`, and the result of an install) has a line with its sandbox's container name; the short description used by `list_projects` does not.
- [x] AC23. The README no longer says a container is named with the prefix plus the slug: the sentence in "Limitations" and the `MCPE_NAME_PREFIX` row in "Configuration" both describe `<prefix><id>-<slug>` for sandboxes made by this version and the old form for earlier ones.

**Nothing else changed**
- [x] AC24. A record with old names that is not reinstalled is used exactly as before: the existing tests that build such records pass without their fixtures' names being edited.
- [x] AC25. `npm run typecheck`, `npm test` and `npm run build` pass, with no fewer than 515 unit tests passing. `npm run test:docker` passes. The operator's four containers have the ids recorded in the flight log after the Docker suite has run.

## Verification Steps
- AC1 to AC8: `npm test -- test/installation.test.ts` (new file). The module's link and its wait are replaceable by parameter: a link that first runs a whole second load and then links gives AC3; one that throws a "cannot link" error gives AC4; one that throws "the name exists" after the test has planted the file gives AC4's second half. File ages for AC7 are set with `utimes`.
- AC9, AC11, AC12 (the method): `npm test -- test/docker.test.ts`.
- AC10, AC18, AC22: `npm test -- test/server.test.ts`.
- AC12, AC14 to AC17, AC19 to AC21, AC24: `npm test -- test/installer.test.ts`.
- AC13: `grep -rn namePrefix src/` shows the configuration and one use.
- AC23: read the two places in `README.md`.
- AC25: the four commands, the unit run with the runner's timeout (`npm test -- --testTimeout=20000`; there is no vitest configuration file, so the default is five seconds a test); then `docker ps -a --no-trunc --filter label=mcp-everything=1 --format '{{.Names}} {{.ID}}'` compared with the flight log.
- For every new test, name in the flight log entry the source change that makes it fail, and try it where that is not obvious. Undo such a trial by editing, never with git: nothing in this flight is committed until its end.

## Implementation Guidance

1. **The id module** (`src/installation.ts`, new)
   - One exported synchronous function that takes the data directory and returns the id, and one exported pattern for a valid id. The file's name and the temporary file's name pattern are each defined once and used by both the writer and the sweep.
   - Order: make the directory (as `prepareDataDir` does in `src/server.ts`); sweep its own stale temporary files; read the final file; if it is absent, generate (four random bytes as hexadecimal), write the whole content to a temporary file opened exclusively with mode 0600, flush it to disk, close it, hard-link it to the final name, and remove the temporary file whatever happened; then **read the final file and return what it holds**, never the value just generated.
   - Only "no such file" from the read means absent. Any other failure, of the read, of making the directory, of the temporary file or of the fallback, becomes an error that names the final file's path.
   - "The name exists" from the link means another process won: read its file. Any other link error means this file system cannot link: fall back to an exclusive create of the final name with mode 0600, write, flush. "The name exists" from that create also means another process won.
   - A reader that finds fewer than eight characters waits briefly and re-reads until the waits it has asked for add up to two seconds, then calls the file invalid (the registry's lock shows a synchronous wait without a timer, `src/registry.ts`, `lock`). This also delays the failure for a file that is short and wrong, by those two seconds; that is accepted. A reader that finds eight or more characters that are not valid fails at once.
   - Temporary names must not match `isTempName` in `src/registry.ts` (which accepts `registry.json.<digits>.tmp` only), and the module's own matcher requires its own prefix and suffix. Something like `installation-id.<pid>-<random>.tmp`.
   - Never regenerate: no path overwrites or deletes an existing final file.
   - No flush of the directory itself is needed: an id only matters once a sandbox carries it.

2. **The Docker layer** (`src/sandbox/docker.ts`)
   - The constructor (`class Docker`, `constructor(private readonly cfg: Config)`) takes the id as a second, required argument, validates it against the module's pattern, and exposes it as `installationId`.
   - `sandboxName(slug)` builds a name from the prefix, the id and the slug. It is the only place the prefix is joined to anything.
   - Add the owner label where the generic label is written: `probe` (`"volume", "create", "--label", "mcp-everything=1"`) and `createContainer` (`"--label", "mcp-everything=1"`).
   - No check, no new inspect, no change to `exec`, `state`, `ensureRunning`, `setNetwork`, `removeContainer` or `destroy` in this leg.

3. **Where the id is loaded** (`src/server.ts`)
   - `App`'s constructor: `this.docker = opts.docker ?? new Docker(this.cfg)` becomes a construction with the id loaded from `this.cfg.dataDir`. An injected double is used as given and no file is touched.
   - A throw here leaves the constructor, as any constructor error does.

4. **Names and the reinstall order** (`src/install/installer.ts`, `Installer.install`)
   - Today: `const container = `${this.cfg.docker.namePrefix}${slug}`; const volume = container;`, a `registry.put(record)` with those names, then inside the `try` `proxy.closeProject(container)` and `docker.destroy(container, volume)`, and a `catch` that sets `record.status` and `record.error` and then chooses by `sandboxCreated`.
   - New names come from `sandboxName`. Before the new record is built, take a deep copy of the existing record (`existing` is an object the registry owns): it is the source of the old names and of what is put back if the old sandbox cannot be removed.
   - **An aliasing trap.** After `registry.put(record)` the registry's in-memory map holds that very object, and `install` goes on changing it. So the record put first, with the old names, must be a separate object from the one that later carries the new names; set the new names only on the object about to be put with them. Otherwise a reader of the registry sees the new names before they were written.
   - Order, when a record exists and its names differ from the new ones: put a record that says `installing` with the **old** names; close proxied servers on the old container and destroy the old names; put the record with the new names; close and destroy at the new names; then the clone and everything after it as today, all on the new names.
   - With no existing record, or when the existing record already holds the new names: put with the new names, close and destroy at them once, continue. That is what happens today.
   - The failure branch decides from an explicit phase, set as the install advances, before it changes anything on a record:
     - *Old sandbox not yet removed* (only reachable when the names differ): put back the deep copy from before the install, with the fixed warning added if it is not already there, and **throw** an error. Do not put the new record. `callTool` in `src/server.ts` turns a thrown error into an error result, which is what keeps the "sandbox was kept, repair the build" advice (`case "install_project"`, `if (done.status !== "ready")`) from being shown for a build that never started. If the put itself fails, let that error rise.
     - *New names taken, no container*: destroy the new names, ignoring its failure, and delete the record, as today.
     - *A container exists*: take it offline and keep the record as failed, as today.
   - `sandboxCreated`, `takeOffline`, the rebuild on a fallback image (`if (i > 0) await this.docker.removeContainer(container)`) and everything after the clone keep their logic; they use the new names.
   - Do not touch `uninstall`, `reconcileStale`, `requireSandbox`, discovery, or any record write other than the ones in `install`.

5. **What the operator sees** (`src/server.ts`)
   - `list_projects` (`case "list_projects"`): a first line stating the installation's id, then a blank line, then the list or the "No projects installed" text. Add a few words to the tool's description (`name: "list_projects"`).
   - `describe` (`private describe(p, verbose)`): when verbose, one line with `p.container`, in the style of the lines around it (`  build: …`).
   - `test/server.test.ts` has an assertion anchored at the start of `list_projects`' text (`^demo — github:owner\/demo \(ready\)`): change it deliberately. Two cases there compare two apps' outputs for equality; they hold as long as both doubles carry the same test id.

6. **README**
   - "Limitations", the paragraph on checking a sandbox ("The container is named `MCPE_NAME_PREFIX` (default `mcpe-`) plus the project's slug"): say how a sandbox made by this version is named, with an example, that one made by an earlier version is the prefix plus the slug, and that `project_info` shows the name.
   - "Configuration", the `MCPE_NAME_PREFIX` row: the prefix is followed by the installation's id and the project's slug.
   - Nothing more. The section on several installations is leg 3's, when the behavior it describes exists.

7. **Tests**
   - A shared test id exported from `test/helpers.ts`. `FakeDocker` gets a constructor whose second argument defaults to it, so the sites that construct it or a subclass of it (`test/proxy.test.ts`, `test/server.test.ts` and its `Reachable`, `test/installer.test.ts`) need no edit. `test/docker.test.ts` (`mk`, whose `ScriptedDocker` extends the real class) passes it. In the Docker suite the three direct constructions and the two subclasses `FailsFirstBuild` and `ThrowsInBuild` load the id from their temporary data directory; the four `new App(...)` there load it themselves.
   - `test/installer.test.ts`, existing cases: the assertions that name a newly installed sandbox (`mcpe-widget`, in "runtime selection during install" and "install failure paths", about twenty to twenty-five lines, including the `destroys()` helper's filter) take the new name. None of these cases is deleted. Fixtures that stand for records from before the change keep `mcpe-<slug>` (`record` in `test/helpers.ts`, and the seeded records in this file and in `test/server.test.ts`).
   - `test/installer.test.ts`, new cases for AC14 to AC21. The double there (`class ScriptedDocker extends FakeDocker`) gains a trace: each of its overrides appends the call, its arguments and the slug's record **as read from `registry.json` on disk at that moment**. Its `destroy` records the volume as well as the container; do not change the shape of the existing `destroyed` list, which other cases read. Closing proxied servers is not a Docker call: spy on `proxy.closeProject` and record the same snapshot there. To observe "after the removal returned", snapshot at the next traced call. "drops the earlier record when a reinstall fails this way" stays valid for a record that already has the new names; add its counterpart seeded with an old-names record.
   - `test/docker.test.ts`: the labels assertion uses `arrayContaining`, so it passes without the owner label; add the owner label to it so that it fails without the change.
   - `test/integration/docker.test.ts`: the assertion on `project.container` and the other uses of `${prefix}gron` (including direct `docker inspect` calls) follow the new name; read the name from the record.

## Edge Cases
- **A data directory on a file system without hard links** (a Windows directory reached from inside WSL, exFAT): the fallback. Only reachable in tests by forcing the link to fail.
- **A zero-length id file** left by a process that died inside the fallback: the load waits, then fails with the message of AC5. No sandbox can belong to that directory yet, which is why the message may say "delete it".
- **The existing record's `container` and `volume` differ from each other**: never produced so far, but treat them as two names; do not assume they are equal.
- **Closing proxied servers on the old container throws**: it is in the same step as the old sandbox's removal and takes the same failure branch.
- **The old sandbox's removal half succeeds** (container gone, volume not): the record put back still names it; a later reinstall removes the rest. The warning says the old sandbox may be partly removed.
- **Writing the record with the new names fails** after the old sandbox is gone: the phase is still "old sandbox not yet removed, as far as the registry knows", the put-back is attempted and will most likely fail the same way, and that error rises. The registry then still holds the `installing` record with the old names, which reads as "no longer exists; reinstall". Accepted: a registry that cannot be written fails every path today.
- **The record being reinstalled says `installing`** because another session is installing it now: its sandbox is removed, as today. Not changed here.
- **A first install while a sandbox with the old-style name for that slug exists** (for instance another installation's): untouched and unlooked-for. That is the point of the new names.
- **An id that is not valid reaches `sandboxName`**: cannot happen, because the constructor refused it. That refusal is what keeps a fault from ever producing `mcpe--<slug>` or `mcpe-<slug>`.
- **Name length**: a prefix may be 31 characters; with nine more for the id and a dash, and a slug of at most about twenty, a name stays far inside what Docker accepts. No check is needed.
- **The Docker suite on the operator's machine**: it uses its own prefix (`mcpe-it-<pid>-`) and a temporary data directory, so its names become `mcpe-it-<pid>-<id>-gron`. It must not create, change or remove anything named `mcpe-<slug>`.

## Files Affected
- `src/installation.ts` - new: load or create the installation id
- `src/sandbox/docker.ts` - constructor takes the id; `installationId`; `sandboxName`; owner label in `probe` and `createContainer`
- `src/server.ts` - `App` loads the id; `list_projects` and its description; `describe`
- `src/install/installer.ts` - names from `sandboxName`; `install` reordered; failure branch by phase
- `README.md` - two sentences
- `test/installation.test.ts` - new
- `test/helpers.ts`, `test/docker.test.ts`, `test/installer.test.ts`, `test/server.test.ts`, `test/integration/docker.test.ts` - the id at construction; names; new cases

## Citation Audit
Checked on 2026-11-16 against the working tree at `eb27f74` (no source change since `1d41c9f`). Every symbol and snippet cited above was read in this session by the Flight Director, and the leg's design review read them again and found each as quoted: `Registry.put`, `persist`, `isTempName`, `sweepTemps` and `lock` in `src/registry.ts`; `class Docker`, `probe`, `createContainer` and the label arguments in `src/sandbox/docker.ts`; `Installer.install` (the name computation, the early `put`, `closeProject`, `destroy`, the `catch` on `sandboxCreated`, the `i > 0` rebuild), `takeOffline`, `uninstall` in `src/install/installer.ts`; `App`'s constructor, `prepareDataDir`, `callTool`, `describe`, `case "install_project"` and `case "list_projects"` in `src/server.ts`; the two README places; the construction sites of the Docker doubles. No citation relies on a bare line number.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
