# Leg: checked-reference

**Status**: completed
**Flight**: [Owned Sandboxes](../flight.md)

## Objective
Carry the reference that one ownership check returns through everything that operation then does, in the server, the installer and the proxy, so that a tool call, a discovery run and an install each check once and no command is run on a bare container name.

## Context
- Flight decision this leg implements: DD4's "one check per operation", and the proxy's part of DD8 (the two errors arise where a session is opened; the kill keeps swallowing).
- From leg 2, as landed, all exported from `src/sandbox/docker.ts`: `acquire(name)` returns a `SandboxRef` (a frozen value with `id` and `name`), returns nothing when the container is not there, and throws `SandboxRefusedError` or `DockerUnavailableError`; `exec`, `state`, `ensureRunning`, `hasNetwork`, `setNetwork` and `removeContainer` accept a name or a reference; `createContainer` returns a `SandboxRef`; `destroy` takes two names and classifies both before removing either. With a reference whose container is gone, `ensureRunning` and `setNetwork` throw a plain error and `state` answers `missing`; an inspect by reference that fails for any reason other than "no such" throws `DockerUnavailableError` (the flight log's Decisions for leg 2).
- At the start of this leg every caller still passes names, so every command resolves. That is correct and wasteful; this leg ends it.
- **Not in this leg** (leg 4): what `uninstall_project` and a reinstall do when the sandbox is another installation's or not ours (DD7); the swallow sites in discovery and in taking a failed install offline (DD8); `project_info`'s line (DD9); the two-installation cases in the Docker suite; the README; the hosted floor.
- One item moved here from leg 2's design review, because it is in `Installer.install`: a reinstall on unchanged names whose first removal fails must not delete the record of a project that was ready.
- A reference is held for one operation and never stored for the next. The proxied session is the one exception: it holds the reference it was launched with.

## Inputs
- Legs 1 and 2 landed in the working tree, uncommitted. At the end of leg 2: unit suite 721 passed and 18 skipped in 1.71 s; Docker suite 16 passed and 2 skipped in 158.5 s (baseline 154 s). Leg 2 changed no logic in `src/server.ts`, `src/install/installer.ts` or `src/proxy/mcp-proxy.ts`, and left `FakeDocker` in `test/helpers.ts` as it was, taking names only.
- `test/helpers.ts`, `FakeDocker`: overrides `exec`, `ensureRunning`, `state`, `setNetwork`, `destroy` and `removeContainer` wholesale and records `calls`, `ensureCalls`, `network`, `destroyed`. The server's and the proxy's tests read those.
- `test/installer.test.ts`: `class ScriptedDocker extends FakeDocker`, with leg 1's trace.

## Outputs
- `sandbox()` in the server and `requireSandbox` in the installer return the reference; everything downstream takes it.
- The install runs on the reference `createContainer` returned.
- A proxied launch carries the reference; the connector's command line and the kill use it.
- Doubles that hand out references, record names as before, and can raise the typed errors.

## Acceptance Criteria

**The server**
- [x] AC1. The server's step that makes sure a sandbox is up returns the reference `acquire` gave it. For a generated command-line tool, `sandbox_exec`, `sandbox_read_file` and `sandbox_write_file`, the Docker layer is asked to `acquire` once and then to `exec` on that very reference, and nothing else. `set_project_network` is `acquire` once and then `setNetwork` on that reference.
- [x] AC2. A refusal or "Docker could not be asked" from that step reaches the tool's result as that error's own message. It is not wrapped in, or replaced by, the "no longer exists… reinstall" message, and with Docker not answering the result does not contain that message. A sandbox that is not there still produces it, word for word as today.

**The installer**
- [x] AC3. `rediscover`, `refreshMcp`, `connectMcp` and `disconnectMcp` each acquire once, through `requireSandbox`, and run every command of that discovery on the one reference it returned.
- [x] AC4. In an install, the clean step, the recipe, the network setting after the build and the discovery that follows run on the reference `createContainer` returned; after the rebuild on a fallback image, on the reference the second `createContainer` returned and not the first.
- [x] AC5. A reinstall of a project whose record already holds the names computed now, when the removal that opens it throws: the record is put back as it was before the install, with the fixed warning of leg 1, and the install throws; the record is not deleted and nothing else was attempted. (Leg 1 left this case as today's, where the record is deleted; its test is renamed and inverted here.)

**The proxy**
- [x] AC6. A launch carries the reference, as a required part of it, beside the container's name. The command line the real connector builds names the reference's id where it named the container. The kill runs on the launch's reference, does not restart a stopped sandbox, and still swallows its errors. The container's name remains the key of the session and what a launch reports as its container.
- [x] AC7. Opening a session acquires by name. A refusal or "could not be asked" there rejects the call with that typed error and leaves no session in the table, so the next call tries again. A sandbox that is not there gives the message it gives today. When the first handshake fails and the sandbox is found stopped, the restart and the second attempt use the same reference.
- [x] AC8. A session whose container has been replaced under the same name (a reinstall from another session): its next call fails, the session is dropped, and the call after that opens a new session on the new container.

**No bare name**
- [x] AC9. No command line built in `src/` passes a container's name to `docker exec`, and no caller in `src/` passes a name to the Docker layer's `exec`. Names are passed only to `acquire`, to `destroy` and `removeContainer`, and to `setNetwork` where an operation has no reference in hand (taking a failed install offline; the startup reconciliation).

**What the operator sees**
- [x] AC10. A generated tool call, `sandbox_exec` and `set_project_network` against a record whose sandbox is another installation's each return an error result that contains the sandbox's name and its owner's id.
- [x] AC11. `uninstall_project` when Docker could not be asked fails with that error and keeps the record. (Today it deletes the record and leaves the sandbox; DD4 names this change.)

**The doubles**
- [x] AC12. `FakeDocker` hands out a reference from `acquire` (governed by its `exists` flag, with an id derived from the name), records the name in `ensureCalls` for `acquire` and for `ensureRunning` alike, and records the **name** in `calls` and `network` whether it was given a name or a reference, with the reference kept beside it. It can be made to raise either typed error from `acquire` and from `destroy`. The existing cases that read `calls`, `ensureCalls`, `network` and `destroyed` pass with their assertions unchanged, except where this leg changes what they assert on purpose.

**Nothing else changed**
- [x] AC13. A record with old names is used exactly as before.
- [x] AC14. `npm run typecheck`, `npm test` and `npm run build` pass, with no fewer unit tests passing than at the end of leg 2. `npm run test:docker` passes; its duration is recorded beside leg 2's and the 154 s baseline, and is not materially above the baseline. The operator's four containers have the ids recorded in the flight log.

## Verification Steps
- AC1, AC2, AC10, AC11: `npm test -- test/server.test.ts`.
- AC3, AC4, AC5: `npm test -- test/installer.test.ts`. For AC4 the double's `createContainer` returns a different reference each time, and the cases assert which reference the recipe, the clean step and the second recipe ran on.
- AC6, AC7, AC8: `npm test -- test/proxy.test.ts`, with one case on the real connector's command line.
- AC9: `grep -rn 'docker\.exec(\|"exec"' src/` and read each hit.
- AC12, AC13: the three suites above pass.
- AC14: the four commands (`npm test -- --testTimeout=20000`), then the listing of the operator's containers compared with the flight log.
- For every new or changed test, the flight log entry names the source change that makes it fail; tried where not obvious; undone by editing, never with git.

## Implementation Guidance

1. **The server** (`src/server.ts`)
   - `sandbox(project)` returns the reference: `acquire` in place of `ensureRunning`, the "no longer exists" message when it returns nothing, typed errors left to rise. Its callers (the generated-tool path, the proxied-tool path, `sandbox_exec`, `sandbox_read_file`, `sandbox_write_file`, `set_project_network`) pass the reference to `exec` and `setNetwork` where they pass `project.container` today.
   - The proxied-tool path keeps giving the proxy the container's name. Its `sandbox()` call is then a second check when a session has to be opened; that is the count it has today, and it stays.

2. **The installer** (`src/install/installer.ts`)
   - `requireSandbox` returns the reference. `execFor` binds a reference instead of a record. `discover` and what it calls take the reference from their caller; every `exec` they issue goes through that one binding (`SandboxExec` in `src/toolgen/discover.ts` is unchanged in shape).
   - `rediscover`, `refreshMcp`, `connectMcp`, `disconnectMcp`: each calls `requireSandbox` first today; each passes what it returns on.
   - `install`: keep the reference `createContainer` returns; replace it at the rebuild; use it for the clean step, the recipe, the network setting after the build and the discovery. `takeOffline` and `reconcileStale` keep resolving by name.
   - The failure branch: where an existing record's sandbox has not yet been removed, whether or not the names are changing, put the old record back and throw (AC5). Leg 1's `phase` covers the changing-names case; extend it to the unchanged-names one.
   - Calls into the proxy keep passing the container's name.

3. **The proxy** (`src/proxy/mcp-proxy.ts`)
   - `open` acquires by name in place of its `ensureRunning`; `attempt` and the restart after a failed first handshake work on the reference (`state` and `ensureRunning` accept one).
   - `Launch` gains the reference as a required field, so the connector cannot fall back to a name. `dockerConnector` puts the reference's id where it puts `container` in the `docker exec` arguments. `kill` runs on the launch's reference with `restart: false` and keeps its `catch`.
   - A rejected `open` already leaves nothing behind: the pending entry is deleted when it rejects. Keep that, and test it for the typed errors.

4. **The doubles and the tests**
   - `test/helpers.ts`, `FakeDocker`: as AC12. `state` and `ensureRunning` accept either.
   - `test/installer.test.ts`, its `ScriptedDocker`: `createContainer` returns a reference with a counter in its id; `exec` records the name and the reference.
   - `test/proxy.test.ts`: the cases that build a launch or call the connector by hand supply a reference; the assertion on the connector's arguments expects the id; the two that count `ensureCalls` keep their expectations under AC12's rule.
   - `test/server.test.ts`: the cases that read `calls[].container` and `ensureCalls` keep passing under AC12's rule.

## Edge Cases
- **A reference outlives its container** inside one operation (the sandbox is removed mid-discovery): the commands fail as plain failures, which discovery reads as it does today.
- **The sandbox idles out mid-operation**: `exec`'s retry starts the same id; nothing resolves again.
- **`acquire` succeeds and the tool then finds the project still installing**: the existing check for that comes first in `sandbox()` and is unchanged.
- **Two sessions of one installation**: each holds its own references; nothing is shared between processes.
- **The proxy's kill after the container is gone**: fails, swallowed, as today.
- **A launch built by a test without a reference**: does not compile, which is the point of making the field required.

## Files Affected
- `src/server.ts` - `sandbox()` returns the reference; its callers
- `src/install/installer.ts` - `requireSandbox`, `execFor`, `discover` and its helpers, `install`
- `src/proxy/mcp-proxy.ts` - `open`, `attempt`, `Launch`, `dockerConnector`, `kill`
- `test/helpers.ts`, `test/server.test.ts`, `test/installer.test.ts`, `test/proxy.test.ts` - doubles and cases
- `test/integration/docker.test.ts` - only if a name is used where a reference is now needed

## Citation Audit
Drafted while leg 2 was being implemented; audited on 2026-11-16 against leg 2's landed working tree. The Docker layer's exports and method signatures were read from `src/sandbox/docker.ts` as landed (`acquire`, `exec`, `state`, `ensureRunning`, `hasNetwork`, `setNetwork`, `removeContainer`, `destroy`, `createContainer`, `SandboxRef`, `SandboxRefusedError`, `DockerUnavailableError`). The callers this leg changes were read at leg 2's design, and leg 2 did not touch them: `sandbox`, `callTool` and the tool handlers in `src/server.ts`; `requireSandbox`, `execFor`, `discover`, `rediscover`, `refreshMcp`, `connectMcp`, `disconnectMcp`, `install`, `takeOffline`, `reconcileStale` in `src/install/installer.ts`; `open`, `attempt`, `Launch`, `dockerConnector`, `kill` in `src/proxy/mcp-proxy.ts`; `SandboxExec` in `src/toolgen/discover.ts`. The line numbers the design review gave for the tests are in the flight log and are not relied on here.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
