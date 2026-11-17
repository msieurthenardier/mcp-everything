# Leg: two-installations-and-readme

**Status**: completed
**Flight**: [Owned Sandboxes](../flight.md)

## Objective
Prove the flight against real Docker with two installations on one daemon, without any possibility of touching the operator's sandboxes, and write the README section the mission's last criterion asks for.

## Context
- Flight decisions this leg implements: the Docker-suite cases and rules of DD10, and the README (DD9's command for finding a sandbox's owner; the limits DD1, DD5 and DD6 say are to be stated).
- This leg adds **no** behavior. If a case here fails, the fault is in an earlier leg or in the case; fix the case, or stop and report the fault. Do not change `src/` to make a case pass without saying so under Deviations.
- From legs 1 to 4: an installation's id is in `installation-id` in its data directory; new sandboxes are named `<prefix><id>-<slug>` and labelled `mcp-everything.owner=<id>` on container and volume; the Docker layer refuses a sandbox that is another installation's or not mcp-everything's and acts as today on one from before the change; `uninstall_project` lets go of a refused sandbox and says what it left; a reinstall leaves a refused sandbox and builds its own; `project_info` says who owns the container.
- **The danger in this leg, found by its design review.** A sandbox name cannot reach the operator's sandboxes: `sandboxName` always yields prefix, id, slug, and theirs are `mcpe-<slug>`. The data directory can. `loadConfig` falls back to the default data directory when `MCPE_DATA_DIR` is absent, and that directory holds the operator's real registry, whose records name `mcpe-gron` and `mcpe-rea`, which the code treats as this installation's to use and remove (DD5). A case that built its configuration without a temporary data directory would act on them, and the real id is also eight hexadecimal characters, so checking the id's shape would not notice. The guards below are about the data directory.
- The mission's third criterion needs both installations to have configured nothing, so these cases run with `MCPE_NAME_PREFIX` unset and the default prefix `mcpe-`. Their names are `mcpe-<id>-gron` with ids made for the test.
- The operator's limit, to be stated in the README and not fixed: two sessions of one installation racing a reinstall (DD6).

## Inputs
- Legs 1 to 4 landed in the working tree, uncommitted. At the end of leg 4: unit suite 831 passed and 18 skipped in 1.74 s; Docker suite 16 passed and 2 skipped in 153.65 s. Leg 4's flight log entry gives the exact operator-facing texts: `uninstall_project` on a refused sandbox answers "Removed … and its tools. Its sandbox was left in place, because it is not this installation's to remove: …"; a reinstall beside a refused sandbox carries the warning "The previous sandbox of this project was left in place, untouched, …"; a refusal names the owner as `owner label "<id>"`; `project_info` ends with a line beginning `Sandbox owner:`, which for a sandbox from before the change says it was made before ownership was recorded. Leg 4 already corrected the `uninstall_project` row of the README's table of tools; the row for `list_projects` and `project_info` and the prose are this leg's.
- `test/integration/docker.test.ts`: one main `describe`, skipped unless `MCPE_DOCKER_TESTS=1`, with its own prefix (`mcpe-it-<pid>-`), a temporary data directory, an `App` built from `{ ...process.env, MCPE_DATA_DIR: dir, MCPE_NAME_PREFIX: prefix, … }`, an install of `tomnomnom/gron` under a long per-case timeout, and cleanup by uninstalling what its registry lists. Other `describe`s make volumes and containers by hand through a helper, on `cfg.docker.images.generic`.
- The operator's four containers and their ids are in the flight log ("Execution start").

## Outputs
- A two-installation `describe` in the Docker suite, and one case for a sandbox from before the change in the existing prefixed `describe`.
- The README's section on several installations, and corrections wherever else the README speaks of names, ownership or the data directory.

## Acceptance Criteria

**Guards, before anything else**
- [x] AC1. The two-installation `describe` builds each `App` from a copy of the environment in which `MCPE_NAME_PREFIX` is deleted and `MCPE_DATA_DIR` is a directory the test has just made with `mkdtemp` under the system's temporary directory. Before its first Docker call it asserts, for each `App`: that its data directory is that path and lies under the system's temporary directory; that its registry lists no project; that its installation id is eight hexadecimal characters; and that the two ids differ. If any assertion fails, no case in the `describe` runs a Docker command.
- [x] AC2. Everything the two-installation cases remove from Docker, in a case or in cleanup, is removed by a name that the test has first checked against the pattern prefix-`mcpe-`, one of the two test ids, `-gron`; the hand-made sandbox of AC7 is removed only by a name checked to begin with the suite's prefix `mcpe-it-<pid>-`. No removal is by a broader filter than an exact, checked name. The check is a function in the test file, used at every removal, and has its own unit-style assertions (it rejects `mcpe-gron`, `mcpe-rea`, a name with a third id, and an empty string).

**Two installations, real Docker**
- [x] AC3. The first installation installs `tomnomnom/gron`; then the second does. Each ends with its own container and volume, named with its own id and carrying its own id in the owner label; each runs its generated tool. The first's container id, read with `docker inspect`, is the same after the second's install as before it.
- [x] AC4. With the second installation's record pointed at the first's container and volume: a generated tool call, `sandbox_exec`, and `set_project_network` with `enabled: true` each return an error result that names the first installation's id as the owner. After each, the first's container has the same id, the same running state and the same attached networks as before.
- [x] AC5. In that state `install_project(reinstall: true)` in the second installation ends ready under the second's own names, with the warning that the first's sandbox was left in place. Afterwards the first's container has the same id and its tool still runs.
- [x] AC6. With the second's record pointed at the first's sandbox again, `uninstall_project` in the second returns a result that is not an error and says the sandbox was left, the second's registry no longer lists the project, and the first's container has the same id and its tool still runs.
- [x] AC7. In the existing prefixed `describe`: a container and a volume made by the test with the label `mcp-everything=1` and no owner label, both named with the suite's prefix, and a record that names them. `sandbox_exec` runs a command in it; `project_info` says the sandbox was made before ownership was recorded; `uninstall_project` removes the container and the volume.

**Nothing left, nothing touched**
- [x] AC8. After the suite, whether its cases passed or failed, no container or volume carries either test id in its owner label, and none has the suite's prefix. The cleanup hook has an explicit timeout long enough for its removals.
- [x] AC9. Before the first run and after the last, the operator's four containers have the ids recorded in the flight log and their four volumes are present.
- [x] AC10. The test file's header comment says how to find sandboxes left by an interrupted run: by owner label, since the two-installation cases' names carry no suite prefix.

**README**
- [x] AC11. A section on several installations sharing one Docker daemon says: what an installation is; where its data directory and its `installation-id` file are by default on Linux and on Windows; that two installations need two data directories; how a sandbox is named and labelled, with one command each for containers and for volumes that lists every mcp-everything sandbox with its owner (an empty owner meaning it was made by an earlier version); what an installation refuses to do with a sandbox that is not its own, and what `uninstall_project` and a reinstall do with one; what `project_info` shows.
- [x] AC12. The same section says what to do on upgrading: reinstall each project installed before this version; the first installation to reinstall a project that two installations share removes the shared sandbox, so the other must reinstall it too; upgrade every installation on the machine.
- [x] AC13. The same section says what the protection does not cover: anything with access to the Docker daemon; an installation still on an earlier version, which treats every `mcpe-<slug>` sandbox as its own; a copied data directory (two installations, one id); a deleted data directory (sandboxes whose owner is gone, found by the command above and removed by hand); two sessions of one installation racing a reinstall, where one can write the old names back and leave the new sandbox unlisted; a reinstall changing a project's sandbox name, so another session's proxied servers on the old one close and reopen; and Windows, where nothing was tested. It says what was tested: Linux, two data directories, one daemon.
- [x] AC14. Elsewhere the README agrees with it and links to it instead of repeating it: the first bullet of "Security model" (one container and one volume per project); the bullet on the startup reconciliation (a sandbox that is not this installation's is left alone); the bullet on several processes sharing a data directory (those are sessions of one installation); `MCPE_DATA_DIR` (it also holds the id file; copying it copies the id); `MCPE_NAME_PREFIX` (the prefix does not separate installations; the id does); the paragraph in "Limitations" with the `docker ps` hint (it shows the owner).
- [x] AC15. Every statement the README makes about a message or a behavior of legs 1 to 4 matches the code: the texts are taken from leg 4's flight log entry or read from the source, not paraphrased from this leg.

**Nothing else changed**
- [x] AC16. `npm run typecheck`, `npm test` and `npm run build` pass, with the unit count unchanged from the end of leg 4. `npm run test:docker` passes; its case count and duration are recorded beside leg 4's and the 154 s baseline.

## Verification Steps
- AC1, AC2: read the `describe`'s setup; the name check's own assertions run in the unit suite or at the top of the `describe` before any Docker call.
- AC3 to AC8: `MCPE_DOCKER_TESTS=1` through `npm run test:docker`. After it: `docker ps -a --filter label=mcp-everything.owner=<idA>`, the same for `<idB>`, `docker volume ls` with the same two filters, and `docker ps -a --filter name=mcpe-it-` and `docker volume ls --filter name=mcpe-it-`: all empty. The two ids are printed by the suite or read from the cases' output.
- AC9: before the first run and after the last, `docker ps -a --no-trunc --filter label=mcp-everything=1 --format '{{.Names}} {{.ID}}'` and `docker volume ls --filter label=mcp-everything=1 --format '{{.Name}}'`, compared with the flight log.
- AC11 to AC15: read the README against the lists; `grep -n 'mcpe-\|MCPE_NAME_PREFIX\|MCPE_DATA_DIR\|installation-id\|mcp-everything.owner' README.md`.
- AC16: the four commands (`npm test -- --testTimeout=20000`).
- For each new case, the flight log entry names the source change that would make it fail. Do **not** try those changes against the real daemon in this leg: breaking the guard and then running the Docker suite is exactly the experiment that could reach a real sandbox. Reason about them, and cite the unit cases of legs 2 to 4 that were tried.

## Implementation Guidance

1. **The two-installation `describe`** (`test/integration/docker.test.ts`)
   - Skipped unless the suite is enabled, like the others. Cases run in order and depend on each other; say so in a comment.
   - Build each configuration from `const env = { ...process.env }; delete env.MCPE_NAME_PREFIX; env.MCPE_DATA_DIR = dir;`. Never rely on the absence of a variable in the ambient environment.
   - The guards of AC1 go in `beforeAll`, and a flag they set is what every case checks first, so that a failed guard cannot be followed by a Docker call.
   - "Pointing a record at the first's sandbox": through the second `App`'s own registry (`app.registry.put({ ...record, container, volume })`), not by editing `registry.json`, whose modification time may not move between two writes in the same tick.
   - After the pointing, the second's own sandbox is named by no record. The reinstall of AC5 removes and rebuilds it, because it sits at the second's own names. After the uninstall of AC6 it is again named by no record. So cleanup removes, by exact checked name, the second's container and volume and the first's container and volume, whatever state the cases left.
   - Read a container's id, running state and networks with `docker inspect` directly, as the suite does elsewhere, not through the layer under test.
   - Three installs of the repository: the first's, the second's, the second's reinstall. Give each case the long timeout the existing install case has. Do not add a fourth install.
   - `afterAll` with an explicit timeout; it must run its removals even when a case failed, and must not go through `uninstall_project` (which, by design, now leaves a sandbox it does not own).

2. **The sandbox from before the change** (same file, the existing prefixed `describe`)
   - Made with plain `docker volume create` and `docker run -d` carrying `--label mcp-everything=1` only, on `cfg.docker.images.generic` (it has `sh`, a `timeout` that takes `-k`, and `sleep`), with the volume mounted at `/workspace`, a directory `/workspace/repo` created or `sandbox_exec` called with a working directory that exists, and `sleep infinity` as its command. Container and volume have the same name, beginning with the suite's prefix.
   - A full record registered with `app.registry.put`, status `ready`.

3. **README**
   - One new section, placed where a reader of "Security model" will find it. Then the corrections of AC14, each a sentence and a link.
   - The Windows default follows from `loadConfig`: the home directory, `.local`, `share`, `mcp-everything` (there is no Windows-specific branch), unless `XDG_DATA_HOME` or `MCPE_DATA_DIR` is set. Write the path with a placeholder for the user's name.
   - Commands: `docker ps -a --filter label=mcp-everything=1 --format '{{.Names}}\t{{.Label "mcp-everything.owner"}}'` and the corresponding `docker volume ls` form. Check the volume form's output against the daemon before printing it in the README (read-only).
   - Plain statements, no promises beyond what the tests show.

## Edge Cases
- **A guard fails**: every case is skipped or fails without a Docker call; cleanup has nothing to remove and must cope with ids that were never set.
- **The first install fails** (network): later cases fail fast; cleanup still runs.
- **The suite is interrupted** between an install and cleanup: sandboxes named `mcpe-<id>-gron` remain, with an owner label whose data directory is gone. The header comment and the README's command are how they are found.
- **`MCPE_NAME_PREFIX` is set in the developer's environment**: deleted from the copy, so the default applies.
- **`XDG_DATA_HOME` is set in the developer's environment**: irrelevant, because `MCPE_DATA_DIR` is always set to the temporary directory.
- **Both test ids happen to be equal**: one chance in four billion; the guard fails and nothing runs.

## Files Affected
- `test/integration/docker.test.ts` - the two-installation `describe`; the from-before case; the header comment
- `README.md` - the new section; corrections elsewhere

## Citation Audit
Drafted while leg 4 was being implemented; audited on 2026-11-16 against leg 4's landed working tree: the suite's main `describe`, its `prefix`, its `App` construction and `afterAll`, and the hand-made volume helper in `test/integration/docker.test.ts`; `loadConfig`'s data directory default in `src/config.ts`; `sandboxName` and the owner label in `src/sandbox/docker.ts`; the `Sandbox owner:` line in `src/server.ts`; the README sections named in AC14, which the design review of leg 4 read and listed. The operator-facing texts quoted in Inputs are from leg 4's report and flight log entry; AC15 requires them to be read from the source before they are relied on.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
