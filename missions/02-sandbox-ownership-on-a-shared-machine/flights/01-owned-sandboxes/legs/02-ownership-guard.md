# Leg: ownership-guard

**Status**: completed
**Flight**: [Owned Sandboxes](../flight.md)

## Objective
Make every method of the Docker layer that touches a sandbox classify it first and act only on the container it classified: refuse what is another installation's or not mcp-everything's, and tell "not there" from "could not find out".

## Context
- Flight decisions this leg implements: DD4's classification, check, creation guards and "could not find out"; and the two error types of DD8.
- **This leg is the Docker layer and its own tests only.** It was first drafted together with the carrying of the checked reference through the server, the installer and the proxy; the design review found that too large for one pass, and that part is now leg 3 (`checked-reference`). So at the end of this leg callers still pass names, and every call resolves: correct, and slower in discovery, which issues many commands. Leg 3 removes that cost. Do not change `src/server.ts`, `src/install/installer.ts` or `src/proxy/mcp-proxy.ts` in this leg beyond what compiling requires.
- Also not in this leg (leg 4): what `uninstall_project` and a reinstall do with a refusal (DD7), the swallow sites (DD8), `project_info`'s line (DD9), the two-installation cases in the Docker suite, the README, the hosted floor. Here a refusal simply rises as an error wherever nothing swallows it.
- A sandbox from before the change (the generic label `1`, no owner label) is acted on exactly as today (DD5), now by its container id.
- From leg 1, as landed: `Docker`'s constructor is `(cfg, installationId)`; `sandboxName(slug)`; new containers and volumes carry `mcp-everything.owner`.
- No cache (DD4): nothing about a sandbox is remembered from one call to the next.
- From mission 01: tell "there is none" from "could not find out"; check and act are one operation on one id; do nothing when the answer is unknown; for each new test, name the source change that makes it fail.

## Inputs
- Leg 1 landed in the working tree, uncommitted: unit suite 559 passed and 18 skipped in 1.65 s; Docker suite 16 passed and 2 skipped in 154 s.
- `test/docker.test.ts` has a `ScriptedDocker` that answers by the first word of the command and overrides `ensureRunning`; it cannot exercise a guard that inspects.
- `test/helpers.ts` has `FakeDocker`, which overrides `exec`, `ensureRunning`, `state`, `setNetwork`, `destroy` and `removeContainer` wholesale. The server's, the proxy's and the installer's tests run on it and so do not reach the guard; they should pass in this leg untouched, apart from what a changed signature requires.
- The operator's four containers and their ids are in the flight log ("Execution start").

## Outputs
- A pure classification function, two error types and a reference type, exported from the Docker layer.
- Every sandbox method of the Docker layer classifies first and acts on an id; each also accepts a reference in place of a name.
- A scripted double that answers by the whole command line, the operation-by-class table, a coverage test over the Docker layer's methods, and a structural test on the commands it issues.

## Acceptance Criteria

**Classification**
- [x] AC1. One pure function takes a sandbox's labels and this installation's id and returns its class: *mine* when the owner label equals the id; *another's* when an owner label is present with any other value, including an empty or malformed one; *from before* when the generic label is `1` and there is no owner label; *not ours* when the labels are absent or null, or the generic label is absent or not `1`. Tested as a table, with every row.

**Errors**
- [x] AC2. A refusal is an error of its own type that carries the sandbox's name, whether it is a container or a volume, the reason (another's, or not ours) and, for another's, the owner as recorded. "Docker could not be asked" is an error of a second type. Both are exported and both are `Error`s. Nothing in `src/` recognises either by its message. `assertAvailable` throws the second type, with the messages it has today.
- [x] AC3. A refusal's message contains the sandbox's name and this installation's id; for another's, the owner as recorded; and, for a container, its project label as recorded (a volume has none). Label values are cleaned of control and terminal sequences, flattened to one line and cut to a fixed length before they appear. A test with an escape sequence and a line break in a label fails if the cleaning, or the flattening, is removed.

**The check**
- [x] AC4. Resolving a container issues one inspect, of a container specifically, whose output is parsed as JSON and yields its id (64 hexadecimal characters), whether it is running, its labels and its attached networks. It is *not there* only when that inspect exited with a non-zero code, did not time out, and its error output says, in any letter case, that there is no such container or object. Any other failure, a timeout, or output that does not parse to that shape throws the second error type. The same rule decides a volume, from a volume inspect.
- [x] AC5. `acquire(name)` returns a reference (the container's id and its name, nothing else) for a container that is mine or from before, starting it by id if it is stopped; returns nothing when it is not there; throws the refusal for another's and for not ours; throws the second error type when Docker could not be asked. A **stopped** container that is another's is refused and is not started.
- [x] AC6. Given a **name**, each of `exec`, `state`, `ensureRunning`, `acquire`, `hasNetwork`, `setNetwork`, `removeContainer` and `destroy` resolves first. Against another's and against not ours each throws the refusal, and when Docker could not be asked each throws the second error type; in both cases the only commands issued are inspects and, at most, a version request. Against mine and against from before each acts, on the id.
- [x] AC7. "Not there", by name: `state` answers `missing`; `ensureRunning` and `hasNetwork` answer false; `acquire` returns nothing; `setNetwork(…, false)` returns; `setNetwork(…, true)` and `exec` throw an error that names the sandbox and says it does not exist; `removeContainer` and `destroy` treat the missing part as already removed.
- [x] AC8. Given a **reference**, `exec`, `ensureRunning`, `state`, `hasNetwork` and `setNetwork` act on its id and do not read labels. The retry inside `exec` after "the container is stopped" starts that id and runs on that id; it does not resolve the name again.
- [x] AC9. `setNetwork` by name issues one inspect in all (the resolve's, which carries the networks) before its `network connect` or `disconnect`. By reference it issues one inspect by id, to read the networks. Either way the connect or disconnect names the id.
- [x] AC10. `destroy(container, volume)` classifies the container and the volume **before** it removes either. If either is another's or not ours it throws a refusal that names both and says which is whose, and issues neither `rm` nor `volume rm`. If either could not be asked about it throws the second error type and issues neither. Otherwise it removes the container by id and the volume by name, each only if it is there. `removeContainer` does the same for a container alone.
- [x] AC11. `probe` creates its volume only when no volume has that name. If one exists and is another's or not ours, it throws the refusal; if one exists and is mine or from before, it throws a plain error saying the volume already exists; if Docker could not be asked, the second error type. In none of these does it create a volume or run the clone.
- [x] AC12. `createContainer` runs only on a volume that exists and is mine. A volume that is another's or not ours: the refusal. A volume that is missing or from before: a plain error. Docker could not be asked: the second error type. In none of these does it issue `run`. It returns a reference whose id is what `docker run` printed, trimmed, and throws if that is not 64 hexadecimal characters.

**The guard cannot be skipped unnoticed**
- [x] AC13. A coverage test enumerates the Docker layer's own methods and asserts that the set equals, exactly, the methods in its table of guarded methods plus a list, written out in the test, of those that touch no sandbox or are private helpers; an empty or shrunken enumeration fails it. For each guarded method the test calls it against another's sandbox on a double that accepts **only** inspects, volume inspects and version requests and fails on any other command, and asserts that the error is an instance of the refusal type and that at least one inspect was issued. For each it also calls it against mine and asserts that it does not throw the refusal. Adding a public method that takes a sandbox and is in neither list fails the test; so does removing the check from a guarded method.
- [x] AC14. A structural test: across the cases that act on mine and on from before, every `exec`, `start`, `rm`, `network connect` and `network disconnect` the Docker layer issued names a 64-hexadecimal id where the container goes, never a name.

**Nothing else changed**
- [x] AC15. A sandbox from before the change is started, run in, taken on and off the network and removed as today: one case per operation.
- [x] AC16. Existing cases in `test/docker.test.ts` are moved onto the new double, not deleted. Where one pinned behavior this leg changes on purpose (a failed inspect read as "missing" or "gone" when Docker did not answer; `destroy` returning quietly then), it is renamed and inverted.
- [x] AC17. `npm run typecheck`, `npm test` and `npm run build` pass, with no fewer than 559 unit tests passing. `npm run test:docker` passes; its duration is recorded beside the 154 s baseline (it may be longer in this leg, since callers still resolve per command). The operator's four containers have the ids recorded in the flight log.

## Verification Steps
- AC1 to AC16: `npm test -- test/docker.test.ts`.
- AC2's "nothing recognises either by its message": `grep -rn` for the two messages' wording in `src/` shows only where they are built.
- AC17: the four commands (`npm test -- --testTimeout=20000`), then `docker ps -a --no-trunc --filter label=mcp-everything=1 --format '{{.Names}} {{.ID}}'` compared with the flight log. The Docker suite is where the inspect's format, the "no such" wording and `docker run`'s printed id meet a real daemon: if it fails on any of them, that is this leg's finding, not a flake.
- For every new or changed test, the flight log entry names the source change that makes it fail; tried where not obvious; undone by editing, never with git. For the coverage test the two to try are removing the check from one guarded method and adding a public method to the class.

## Implementation Guidance

1. **Types and the pure function** (`src/sandbox/docker.ts`, or a small module beside it that it re-exports)
   - The class of a sandbox; the classification function; the two error classes; `SandboxRef`, a read-only value with `id` and `name` and nothing else (no snapshot of networks or labels).
   - The message of a refusal is built in one function. Clean label values with `cleanTerminalText` (`src/util/text.ts`), which leaves line breaks, so flatten them as well (the same file has a one-line helper), then cut.

2. **The resolve step** (private, in `class Docker`)
   - A format that cannot be confused by a label's content, for example
     `--type container --format '{"id":{{json .Id}},"running":{{json .State.Running}},"labels":{{json .Config.Labels}},"networks":{{json .NetworkSettings.Networks}}}'`,
     parsed with `JSON.parse` and validated: the id's shape, a boolean, an object or null for labels, an object or null for networks (only its keys are used). Do not dump the whole container (`{{json .}}`): it includes the environment.
   - `docker inspect --type container` takes an id as well as a name; use the full id everywhere, never a prefix.
   - A volume: `docker volume inspect --format '{{json .Labels}}' <name>`; no labels prints `null`.
   - "Not there" is decided from Docker's own output, as AC4 says; this is a match on what the daemon printed, not on an error of ours. Everything else is the second error type. `assertAvailable` no longer decides it; it changes only in the type of what it throws.
   - The step returns what it found, or "not there", or throws. It never starts, stops or changes anything.

3. **The methods** (`class Docker`)
   - `acquire(name)`: new.
   - `exec`, `state`, `ensureRunning`, `hasNetwork`, `setNetwork` accept a name or a reference. `execOnce` and the retry in `exec` work on an id. `isStoppedExecFailure` matches `container \S+ is not running`, which an id satisfies.
   - `removeContainer`, `destroy`: classify everything, then act.
   - `probe`, `createContainer`: the creation guards. The check on a volume and its creation are two steps and a volume has no id, so this guarantee is weaker than a container's; that is accepted, because only this installation's own sessions can contend for a name that carries its id.
   - `createContainer`'s return type changes from nothing to a reference. Its one caller in `src/` (`Installer.install`) ignores the value until leg 3.

4. **Callers in this leg**
   - None changes its logic. `ensureRunning`, `state`, `exec`, `setNetwork`, `destroy` and `removeContainer` keep accepting the names they are given today.
   - One consequence to check, not to fix here: `Installer.install` and `uninstall` now see `destroy` throw when Docker could not be asked, where it returned quietly. The installer's tests run on a double and are unaffected. Leg 3 and leg 4 take up what the installer should do.

5. **Tests**
   - `test/docker.test.ts`: a new double whose `docker` is a function from the whole argument list to a reply and which overrides nothing under test. A helper that builds an inspect reply for a given class keeps cases short. The existing exec-retry, `setNetwork`, `createContainer`, `removeContainer` and `destroy` cases move onto it; the scripted `run` reply must now print an id.
   - The table of AC6 is generated: method by class.
   - `test/integration/docker.test.ts`: the two helpers that make a volume by hand and then call `createContainer` add the owner label of the `Docker` instance they are given. `hasNetwork` stays available to the suite.
   - `test/helpers.ts` (`FakeDocker`), `test/installer.test.ts` (its `ScriptedDocker`): only what a changed signature requires (for example a `createContainer` override that now returns a reference). Leg 3 reworks them.

## Edge Cases
- **A container and a volume share a name**: every inspect says which it wants.
- **Labels are `null`** in Docker's JSON: not ours.
- **An owner label that is empty, or is not eight hexadecimal characters**: another's; shown cleaned and cut.
- **The inspect times out while the daemon is otherwise fine**: the second error type, never "not there".
- **The daemon's "no such" wording differs** (another runtime behind `MCPE_DOCKER_BIN`): matched without regard to case, on "no such container", "no such object" and "no such volume". A wording that matches none reads as "could not be asked", which fails loudly instead of treating a sandbox as gone.
- **The container is removed between the check and the act**: the act fails as "no such container", a plain failure, as today.
- **Both the container and the volume are absent in `destroy`** (a first install): two inspects, nothing removed, no error.
- **`docker run` succeeds but prints something unexpected**: `createContainer` throws although a container exists. The install's failure branch removes what is at its names, by name, which still works.
- **A reference whose container is gone**: `exec`, `ensureRunning` and `setNetwork` on it fail as plain failures; `state` answers `missing`.

## Files Affected
- `src/sandbox/docker.ts` - classification, errors, reference, the resolve step, every sandbox method
- `test/docker.test.ts` - new double, the method-by-class table, the coverage test, the structural test; existing cases moved
- `test/integration/docker.test.ts` - owner label on hand-made volumes
- `test/helpers.ts`, `test/installer.test.ts` - signatures only

## Citation Audit
Drafted while leg 1 was being implemented, from the code at `eb27f74`; audited on 2026-11-16 against leg 1's landed working tree, and read again by this leg's design review, which found each symbol as cited: `assertAvailable`, `exec`, `execOnce`, `isStoppedExecFailure`, `state`, `ensureRunning`, `setNetwork`, `removeContainer`, `destroy`, `hasNetwork`, `probe`, `createContainer` in `src/sandbox/docker.ts`; `cleanTerminalText` and the one-line helper in `src/util/text.ts`; `ScriptedDocker` in `test/docker.test.ts`; `FakeDocker` in `test/helpers.ts`; `Installer.install` and `uninstall` as callers. No citation relies on a bare line number.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
