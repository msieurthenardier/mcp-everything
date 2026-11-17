# Leg: refusal-outcomes

**Status**: completed
**Flight**: [Owned Sandboxes](../flight.md)

## Objective
Decide what each operation does when the Docker layer refuses a sandbox, so that the operator is never left with a record that can be neither used nor removed and is never told something false, and show a sandbox's ownership in `project_info`.

## Context
- Flight decisions this leg implements: DD7 (uninstall and reinstall when the sandbox is another installation's or not ours), the swallow sites of DD8, and `project_info`'s line of DD9.
- This leg was drafted together with the two-installation cases of the Docker suite and the README. Its design review found that too large for one pass; those are now leg 5 (`two-installations-and-readme`). Do not edit `test/integration/docker.test.ts` or the README's prose in this leg, beyond what a changed signature requires.
- From legs 2 and 3, as landed: the Docker layer throws `SandboxRefusedError` and `DockerUnavailableError`. `SandboxRefusedError.sandboxes` lists the facts (`kind`, `sandbox`, `cls`, `owner`) of each part Docker **found**, including parts that are this installation's or from before; a missing part is absent from it. `destroy` classifies a container and its volume before removing either. An operation holds one checked reference: `sandbox()` in the server and `requireSandbox` in the installer return it; `discover(record, sandbox, extra)` takes it. A command run on a held reference reads no labels, so it can never raise a refusal; it can raise `DockerUnavailableError`, from the retry after "the container is stopped". A refusal can still arise wherever a **name** is resolved: `destroy`, `takeOffline`'s `setNetwork` by name, and the proxy's opening of a session (`proxy.listTools` and `proxy.callTool` are given the container's name).
- Until this leg a refusal simply rises: `uninstall_project` on a record whose sandbox is refused fails and keeps the record, and a reinstall over one puts the old record back and fails.
- A removal that **failed** (Docker did not answer, a failed `rm`) keeps the record so the operator can try again. Only a **refusal** means "this is not yours; let go of it".
- The doubles, as landed: `FakeDocker` has `acquireError` and `destroyError`; `ScriptedDocker` in `test/installer.test.ts` hands out a new reference from each `createContainer`. The coverage test in `test/docker.test.ts` requires the Docker layer's methods to equal the keys of its guarded table (`CASES`) plus a written list (`NOT_GUARDED`).
- From mission 01: for each new test, name the source change that makes it fail; say in a comment what a rule does not cover.

## Inputs
- Legs 1 to 3 landed in the working tree, uncommitted. At the end of leg 3: unit suite 761 passed and 18 skipped in 1.67 s; Docker suite 16 passed and 2 skipped in 153.7 s.
- The hosted check's floor on passed unit tests is 480, with a comment that says 500 pass (`.github/workflows/ci.yml`, the step "Minimum passed tests"). Nothing else there names a count.

## Outputs
- `uninstall_project` and a reinstall that let go of a refused sandbox and say so.
- No place in `src/` that turns a refusal or "Docker could not be asked" into a different statement, other than a short written list.
- `project_info` says whose a sandbox is.
- The hosted floor raised.

## Acceptance Criteria

**Uninstall**
- [x] AC1. `uninstall_project` on a record whose container or volume the Docker layer refuses: the record and its tools are removed; neither the container nor the volume is touched; the result is not an error; and in place of "and its sandbox" it says the sandbox was left in place and, for each part that exists, names it and says whose it is: another installation's (with that installation's id), not created by mcp-everything, this installation's, or made before ownership was recorded. An owner label is shown flattened to one line and cut to a fixed length.
- [x] AC2. `uninstall_project` when removal failed for any other reason (Docker could not be asked; a plain error from the removal) fails and keeps the record. One case for each.

**Reinstall**
- [x] AC3. A reinstall whose record names a sandbox the Docker layer refuses, under names that differ from the ones computed now: that sandbox is not touched; proxied servers on its name are closed, as for any reinstall; the install goes on and builds under this installation's own names; the record ends `ready` with the new names and carries a warning that names the container and volume left in place and whose they are. If the build then fails once a container exists, the failed record carries the same warning.
- [x] AC4. A reinstall whose record holds the very names computed now, when the sandbox there is refused (a container with this installation's name and no mcp-everything label): the install fails, the record is put back as it was, and both the error and the warning added to the record say that the name is held by a sandbox that is not this installation's, name it, and say it must be removed or renamed by hand in Docker. Neither says "reinstall again to retry", and neither says the old sandbox may be partly removed.
- [x] AC5. A reinstall whose old sandbox could not be removed for any other reason is unchanged from leg 3: the record is put back with leg 3's warning and the install fails. One case with a plain error, one with "Docker could not be asked".
- [x] AC6. When the old sandbox is refused and skipped (AC3) and the install then fails before a container exists, including because what is at the new names is refused too: the record is deleted, as for any install that fails before a container exists, and the failed record the call returns carries the warning of AC3.

**Nothing false is said**
- [x] AC7. "Docker could not be asked", raised by any command of a discovery (including the ones issued from `src/toolgen/discover.ts`), ends the discovery with that error: the project is not recorded as having no commands, and the record is not rewritten. A command that merely fails is still read as it is today.
- [x] AC8. A refusal or "Docker could not be asked" raised when discovery opens a proxied server ends the discovery with that error. It is not turned into a warning that the project's MCP server did not start or did not answer, and the record is not rewritten.
- [x] AC9. An install takes its own sandbox offline through the reference it holds, so that step cannot meet a refusal. The startup reconciliation, when the sandbox its stale record names is refused: marks the install failed as it does today, leaves the record's `network` as it was, and adds a warning that the sandbox the record names is not this installation's (another installation's, or not created by mcp-everything) and was left alone; it adds no "may still be online" warning. When Docker could not be asked, both behave as today.
- [x] AC10. The flight log entry for this leg lists every `catch`, `.catch(` and rejection handler in `src/` that can receive either typed error, each with what it does and why that is right. Each one that swallows or rewords a typed error has a comment in the code saying so. Expected to remain, by name: the proxy's kill and its idle reaping and session closing; the handler that deletes a pending session when its opening rejects; the proxy's restart after a failed handshake, which keeps the original text in its note; the rollback removal of a failed install's own new names; `callTool`'s, which keeps the error's own message; the reconciliation's per-record and reachability handlers, which log.

**`project_info`**
- [x] AC11. `project_info` has one line about who owns the sandbox's **container**, from one read-only inspect: this installation's; made before ownership was recorded; another installation's, with its id shown flattened and cut; not created by mcp-everything; missing; or could not be checked because Docker did not answer. While an install of that project is running in this process the line says the sandbox is being built and no question is asked. `project_info` never fails because of that question: a case makes the inspect fail and the tool still succeeds.
- [x] AC12. No other tool asks: `list_projects` and the result of an install issue no Docker command for ownership.
- [x] AC13. The Docker layer's method that answers that question never throws and issues only read-only commands, for each class and for missing and unavailable; it classifies with the same function as everything else. The coverage test gains a third written list for methods that report instead of refusing, with its own test of exactly that, and its equality now runs over all three lists; a method in none of them still fails it.

**Texts**
- [x] AC14. The descriptions of the `uninstall_project` and `project_info` tools in `src/server.ts`, and the `uninstall_project` row of the README's table of built-in tools, are true after this leg.
- [x] AC15. The hosted check's floor is raised to the nearest ten below the unit count at the end of this leg, minus twenty, and its comment gives that count and today's date.

**Nothing else changed**
- [x] AC16. A record with old names is used exactly as before. `npm run typecheck`, `npm test` and `npm run build` pass, with no fewer than 761 unit tests passing. `npm run test:docker` passes; the operator's four containers have the ids recorded in the flight log.

## Verification Steps
- AC1, AC2, AC11, AC12, AC14: `npm test -- test/server.test.ts`.
- AC3 to AC9: `npm test -- test/installer.test.ts`.
- AC8's proxy side, if the proxy changes: `npm test -- test/proxy.test.ts`.
- AC10: `grep -rn 'catch' src/` and read every hit; the list goes in the flight log.
- AC13: `npm test -- test/docker.test.ts`.
- AC15: read the workflow file.
- AC16: the four commands (`npm test -- --testTimeout=20000`), then `docker ps -a --no-trunc --filter label=mcp-everything=1 --format '{{.Names}} {{.ID}}'` compared with the flight log.
- For every new or changed test, the flight log entry names the source change that makes it fail; tried where not obvious; undone by editing, never with git. To try at least: removing the refusal branch from `uninstall`; removing it from the reinstall; letting a refusal at a session's opening become an MCP warning again; letting "could not be asked" become "no commands"; making the reconciliation write "may still be online" for a refusal.

## Implementation Guidance

1. **Uninstall** (`src/install/installer.ts`, `uninstall`; `src/server.ts`, `case "uninstall_project"`)
   - Today: close the project's proxied servers, `destroy` by the record's names, delete the record; the tool says "Removed … and its sandbox."
   - Catch `SandboxRefusedError` only. On it, delete the record and **return** the facts of what was left (`err.sandboxes`); return an empty list when the sandbox was removed. Any other error rises before the record is deleted. Nothing depends on `uninstall` returning nothing (its callers are the server, one unit case that expects a rejection, and the Docker suite's cleanup, which ignores the value).
   - The server builds its sentence from those facts, never from a message. A part may be missing, this installation's, from before, another's or not ours. For an owner use the one-line helper in `src/util/text.ts` with a length limit; the Docker layer's own cleaner is not exported.

2. **Reinstall** (`src/install/installer.ts`, `install`)
   - As landed: `before` is a deep copy of the existing record; `phase` is `"old"` until the removal that opens a reinstall succeeds; with changed names the old sandbox is removed inside `if (before && renamed)` and the record is then put with the new names; the failure branch puts `before` back with a fixed warning and throws when `phase` is `"old"`.
   - AC3: wrap only the `destroy` of the old names. On `SandboxRefusedError`, build the warning from its facts, add it to the record that is about to be put, and go on to the put and `phase = "new"` exactly as if the removal had succeeded. Any other error rethrows with `phase` still `"old"`. `closeProject` on the old container stays before it.
   - The warning must not begin with the prefix discovery uses for its MCP warnings or the one publishing uses for its tool warnings (both are filtered out later); nothing else removes warnings.
   - AC4: with unchanged names the opening removal runs while `phase` is `"old"`, so a refusal there already takes the put-back path. Give that path a second warning and a second error text for a refusal, as AC4 says; keep leg 3's for every other error.
   - AC6 needs no new logic: after the skip, `phase` is `"new"` and the existing branches apply.

3. **Discovery** (`src/install/installer.ts`, `discover` and `discoverMcp`)
   - One mechanism, not an edit at each swallow: wrap the bound `exec` in `discover` so that it remembers the first `DockerUnavailableError`, rethrows it on every later call, and `discover` rethrows it before it writes anything to the record and before it returns. That reaches the eight `.catch(() => null)` in the installer and the `catch` in `fetchHelp` in `src/toolgen/discover.ts`, without editing that file. Say in a comment why only that one type: a command on a held reference cannot raise a refusal.
   - `discoverMcp`'s two `catch` blocks around `proxy.listTools`: rethrow both typed errors; everything else as today. Errors after a session has opened are already plain errors.
   - When a typed error leaves a discovery, nothing has been written: the callers work on a copy and `finish` is not reached.

4. **Taking offline** (`src/install/installer.ts`, `takeOffline`, `reconcileStale`, `install`)
   - `install`: keep the reference where its failure branches can see it and take the sandbox offline through it.
   - `takeOffline` by name (the reconciliation's path): catch `SandboxRefusedError` itself, leave `network` alone and add the "not this installation's; left alone" warning in place of "may still be online". The reconciliation's existing code then carries the added warning and the unchanged `network` into its guarded write.

5. **`project_info`** (`src/sandbox/docker.ts`, `src/server.ts`)
   - A method on the Docker layer that inspects a container by name and reports the class, the owner if there is one, "missing", or "could not be checked". It uses the same inspect and the same classification as the resolve step, without that step's throwing.
   - `case "project_info"` appends the line after `describe`'s text, inside its own `try`. `describe` stays synchronous. An inspect can take up to its 30-second limit when the daemon hangs; say so in a comment.
   - `test/docker.test.ts`: the third list and its test (AC13).

6. **Texts and the floor**
   - The two tool descriptions in `src/server.ts`; the one row in the README's table.
   - `.github/workflows/ci.yml`: the floor and its comment.

7. **Tests**
   - `test/server.test.ts`, `test/installer.test.ts`, `test/docker.test.ts`, on the doubles as landed. A refusal in tests is a real `SandboxRefusedError` built from facts, so that the sentence-building code is exercised with: a container that is another's and a volume that is this installation's; only a container; a container that is not ours; an owner label with a line break and excessive length.

## Edge Cases
- **The container is refused and the volume is this installation's**: `destroy` refuses the pair. Uninstall lets go of both and the message says the volume is this installation's and was left, because it now has no record.
- **The record's sandbox is missing altogether**: not a refusal. Uninstall deletes the record as today; a reinstall builds.
- **`project_info` for a record that says `installing` with no install running here** (another session's, or a dead one): the question is asked and answered like any other.
- **`project_info` when the volume is another's but the container is this installation's**: the line speaks of the container only. Uninstall and reinstall still classify both.
- **A refusal while closing a project's proxied servers**: cannot arise; closing acts on references already held and swallows.
- **Docker stops answering after discovery has opened proxied sessions**: those sessions stay open until they idle out, as today.

## Files Affected
- `src/install/installer.ts` - `uninstall`, the old-sandbox removal and failure texts in `install`, `discover`, `discoverMcp`, `takeOffline`
- `src/server.ts` - `uninstall_project`'s text; `project_info`'s line; two tool descriptions
- `src/sandbox/docker.ts` - the reporting method
- `src/proxy/mcp-proxy.ts` - comments on the swallows that stay
- `README.md` - one row of the tools table
- `.github/workflows/ci.yml` - the floor
- `test/server.test.ts`, `test/installer.test.ts`, `test/docker.test.ts`, `test/helpers.ts` - cases and doubles

## Citation Audit
Drafted while leg 3 was being implemented; audited on 2026-11-16 against leg 3's landed working tree, and read again by this leg's design review, which confirmed or corrected each: `uninstall`, `install` (`before`, `renamed`, `phase`, the fixed warning), `requireSandbox`, `execFor`, `discover` and its `.catch(() => null)` sites, `discoverMcp` and its two `catch` blocks, `takeOffline`, `reconcileStale` in `src/install/installer.ts`; `fetchHelp` in `src/toolgen/discover.ts`; `sandbox`, `describe`, `callTool`, `case "project_info"`, `case "uninstall_project"` and the tool descriptions in `src/server.ts`; `SandboxRefusedError` and its `sandboxes`, `DockerUnavailableError`, `destroy`, the inspect and classification helpers in `src/sandbox/docker.ts`; `open`, `kill`, the idle reaping and the pending-session handler in `src/proxy/mcp-proxy.ts`; `CASES` and `NOT_GUARDED` in `test/docker.test.ts`; the step "Minimum passed tests" in `.github/workflows/ci.yml`. No citation relies on a bare line number.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
