# Flight: Owned Sandboxes

**Status**: completed
**Mission**: [Sandbox Ownership on a Shared Machine](../../mission.md)

> **History.** Logged on 2026-11-16 as sortie 04, "Ownership on a Shared Machine", with a draft charter. At pickup the same day it failed three of the four sortie criteria and was escalated; the charter became the starting point of the mission, and the artifact was moved here as the mission's first flight. The [flight log](flight-log.md) has the escalation, the reconnaissance report this design rests on, and what the design review changed.

## Contributing to Criteria
For sandboxes made after this flight. A sandbox that exists already behaves as today until its project is reinstalled, and the reinstall gives the project an owned one (DD5, DD6). This is now the mission's only flight.

- [x] Two installations that share one Docker daemon and install the same repository each end up with their own working sandbox, and neither install changes the other's.
- [x] An installation acts only on sandboxes it owns, and refuses each operation on one it does not own, not only removal.
- [x] Both of the above hold for two installations that configured nothing.
- [x] For every sandbox made after this change, the operator can find out which installation owns it.
- [x] The README says what an installation is, where its data directory is by default, how sandboxes are named and kept apart, what the protection does not cover, and that a project installed before the change should be reinstalled after upgrading.

Retired at reconnaissance (see the flight log):
- [x] Finding 3a, an invalid `MCPE_NAME_PREFIX` falling back silently: already an error at startup (`src/config.ts:143-150`, squawk 0015).
- [x] Finding 3's two containers that the inspected registry did not list: explained. They are in the registry on the Windows side; no sandbox on the operator's machine is unlisted.

---

## Pre-Flight

### Objective
Give every installation of mcp-everything an identity, and make every sandbox it creates carry that identity in a label and in its name, so that two installations sharing one Docker daemon cannot produce the same sandbox name and the Docker layer can tell, before any operation, whether a sandbox is this installation's, another's, or from before ownership was recorded. Sandboxes from before the change keep behaving as they do today, and one reinstall of a project replaces its sandbox with an owned one. A second flight, to claim existing sandboxes in place, was dropped by the operator on 2026-11-16.

### Open Questions
- [x] How an installation knows itself → DD1
- [x] Whether an installation may have a readable name → DD1 (no; the operator chose the id alone)
- [x] How names stop colliding by default, and what `MCPE_NAME_PREFIX` then means → DD2
- [x] Where ownership is recorded → DD3
- [x] Where the ownership check goes, what it costs, and whether it is cached → DD4
- [x] What a sandbox from before the change is to this flight's build, and whether the two flights may be released apart → DD5 (the operator's decision)
- [x] How a reinstall moves a project from old names to new ones without leaving a sandbox no record names → DD6
- [x] What uninstall and reinstall do when the sandbox is not this installation's → DD7
- [x] How a refusal reaches the caller through code that swallows errors → DD8
- [x] How the operator finds out who owns a sandbox → DD9
- [x] How the criteria are verified, and with what → DD10 (the operator's decision)
- [x] Tests that assume today's names → DD10, and the reconnaissance report (R11)
- [x] How a sandbox from before the change comes under ownership → by reinstalling its project (DD5, DD6). The flight that would have claimed existing sandboxes in place was dropped by the operator, and with it the question of how a claim fits a check that reads labels.
- [x] Whether a write from another session, built on what it read before a reinstall, must be kept from putting the old names back → no; accepted as a limit by the operator (DD6)

### Design Decisions

**DD1. An installation is identified by a short generated id kept in its own file in the data directory.**
Eight lowercase hexadecimal characters from the system's random source, in a file beside `registry.json`, created the first time a process starts on that data directory and never rewritten. No readable name and no environment variable.
- Rationale: an id from the environment cannot meet "two installations that configured nothing"; that is how the name prefix works today. Its own file, because every build to date rewrites `registry.json` as `version` and `projects` only (`Registry.persist`, `src/registry.ts:175`): as a field there, one write from a session on an older build would drop it, and the installation would return with a new id and own nothing. A separate file needs no format change and no migration.
- How it is created, so that two sessions starting at once on an empty data directory end with the same id and neither reads a partial one: the id is written in full to a uniquely named temporary file in the same directory, and that file is hard-linked to the final name. A link fails if the name exists and the name appears with its content complete; the loser reads the winner's file. This holds on Linux and on NTFS. Where a file system cannot link, the fallback is an exclusive create, with a reader that treats a short file as "being written" and waits briefly before calling it invalid. Not sound, and not to be used: an exclusive create alone (the file exists empty before its content lands), a rename (it replaces, so the last writer wins), or the registry lock.
- The temporary file is removed whether or not the link succeeded, is named so that the registry's own sweep of temporary files does not match it (`isTempName` in `src/registry.ts` matches `registry.json.<digits>.tmp` only), and one left by a process that died is removed at a later start by the same module. The fallback is chosen only for an error that means "this file system cannot link", never for "the name exists", and is tested by making the link fail. Hard links are not to be assumed on a Windows directory reached from inside WSL or on exFAT. The module creates the data directory if it is missing.
- A file that exists but does not hold a valid id stops the process with a message naming the file and saying what to do. It is **not** regenerated: a new id disowns every sandbox. (The entry point prints a stack trace for any startup error today; that is squawk 0027, open. This error's message has to be readable either way.) The id is read once per process and never re-read or regenerated while it runs.
- Where it enters the code: the Docker layer is constructed with the id as a required argument, and is the one place the rest of the code reads it from. `App` loads it when it constructs the Docker layer, which is before any Docker operation, including the startup reconciliation; a failure there ends the process with a clear message before the protocol connects. Tests that inject a Docker double supply an id and touch no file. It is not part of `Config`, which is a pure function of the environment.
- Trade-off: a copied data directory gives two installations one id, which cannot be detected. A deleted data directory leaves sandboxes whose owner is gone for good; they can be found by the label and removed with Docker. Both are stated in the README.

**DD2. A new sandbox is named `<prefix><id>-<slug>`, for its container and its volume alike.**
With nothing configured: `mcpe-3f9a2c1b-gron`. `MCPE_NAME_PREFIX` stays a prefix and the id always follows it. A record keeps the names it was written with (`container`, `volume`); names are computed when a sandbox is made, by an install or a reinstall, and never recomputed for a sandbox that exists.
- Rationale: always including the id means two installations with the same prefix, default or chosen, still cannot collide. The registry's format does not change: the record already stores both names.
- Trade-off: names in `docker ps` are nine characters longer, and an operator who set a prefix to tell installations apart now sees the id as well. Tool names and variable names are unaffected: they come from the slug. A record's names were stable for a slug until now; a reinstall now changes them, so another session of the same installation that holds a proxied server open on the old sandbox loses it and reopens on the next call (its registry is re-read at every call). Stated in the README.

**DD3. Ownership is recorded on the sandbox, as a label on both the container and the volume.**
`mcp-everything.owner=<id>`, beside the labels written today (`mcp-everything=1`, `mcp-everything.project`, `mcp-everything.idle-timeout`).
- Rationale: the two registries cannot see each other; Docker is the only state they share. The name carries the id for people; the label is what the code checks.
- Trade-off: labels are fixed at creation, so this marks only sandboxes made from now on.

**DD4. The ownership check lives in the Docker layer, runs once per operation, and acts on what it checked.**
Before acting on a sandbox by name, the Docker layer asks Docker once for that name's container id, labels and running state (asking for a container specifically, since a project's volume has the same name), classifies the answer, and then acts on the **id** it just checked. The classes:

| Class | Meaning | What the Docker layer does |
|-------|---------|----------------------------|
| mine | owner label is this installation's id | acts |
| another's | an owner label that is not this installation's id, well formed or not | refuses |
| from before | the generic label, no owner label | acts, as today (DD5) |
| not ours | the generic label absent, or not `1` | refuses |
| not there | Docker answered and has no such container | reports it missing, as today |
| could not find out | Docker did not answer | fails saying so; never read as "not there" |

- The same classes apply to a volume, by its own labels, asked for as a volume. Removing a sandbox classifies **both** its container and its volume before removing either, so a refusal never leaves half a sandbox.
- Creation is guarded too. A volume is created only under a name that is free, and a container only on a volume that exists and is this installation's. Both are a check and then an act; that is enough because the names carry this installation's id, so only its own sessions can contend for them. An install therefore clears its own target names first (DD6).
- The classification is one pure function of a sandbox's labels, in one place.
- One check per operation, not per Docker command. The check's result is a **reference** to the container it checked, and the reference is what every later command of that operation is given:
  - A tool call: the server's step that makes sure the sandbox is up (`sandbox()`, `src/server.ts:488`) is the check, where it inspects today, and returns the reference its command runs on.
  - Discovery, refresh and connect: the installer's `requireSandbox` (`src/install/installer.ts:404`) returns the reference, and the function it binds for running commands (`execFor`) and the proxy both take the reference, not the name. Without this each of discovery's dozens of commands would check again.
  - An install: there is nothing to check before the container exists. Creating the container returns the reference, and what this installation has just created is its own. The rebuild on a fallback image removes that container and creates another, so the reference is replaced there.
  - A proxied server's session holds the reference it was launched with for as long as the session lives; its kill uses that reference.
  - The retry inside `exec` when a sandbox has idled out starts and re-runs on the same reference.
- A reference is held for one operation and never stored for the next; the proxied session is the one named exception. That is sound because a container's id and labels cannot change: a verdict about an id holds for that container's whole life, and if the container is removed meanwhile the command fails as "no such container".
- A command on a held reference that fails because Docker stopped answering is a plain failure, as today, and discovery still reads it as "no commands found", as today. Only the check itself raises "could not find out".
- No cache across operations. A verdict remembered by **name** goes stale when the container under that name is replaced, which a reinstall from another session does and which this process cannot see.
- "Could not find out" follows the pattern `setNetwork` already uses (`src/sandbox/docker.ts:391-399`): when an inspect fails, ask whether the daemon is reachable before concluding the container is gone.
- A refusal names the sandbox, its owner's id, its project label and this installation's id. The label values come from whoever made the container, so they are cleaned and cut to length like any other untrusted text before they are shown.
- The proxy's own `docker exec` (reconnaissance, R9) launches and kills through a checked reference, so that no `docker exec` by bare name remains in `src/`.
- Rationale: 22 call sites act on a sandbox by name, through nine methods of the Docker layer (R8). A check at the call sites would be 22 places to forget; a check in the layer is one.
- Trade-off: the common tool call makes the same number of Docker round trips as today. Paths that ran a command without inspecting first gain one inspect per operation. To be measured on the Docker suite, whose baseline is 154 s for 16 cases.
- A behavior change that follows, stated plainly: today, with Docker not answering, a sandbox reads as "gone", so `uninstall_project` deletes the record and leaves the sandbox, and a tool call advises a reinstall. After this flight both fail saying Docker could not be asked, and the record is kept.

**DD5. A sandbox from before the change behaves as it does today.** *(The operator's decision, 2026-11-16.)*
A sandbox with the generic label and no owner label, named by this installation's registry, is started, run in, given variables, taken on and off the network, reinstalled over and removed as it is now.
- Rationale: existing projects keep working with no reinstall, and nothing changes for a project until its operator chooses to reinstall it.
- Trade-off, accepted: for a project both registries list, one installation can still remove the sandbox the other is using, until that project has been reinstalled. That is live on the operator's machine: `rea` is listed by both registries with the one container `mcpe-rea`. A reinstall builds under the new names, so after one reinstall a project is owned. The first installation to reinstall a shared project removes the shared sandbox; the other then finds its sandbox gone and reinstalls in turn. The README says to reinstall existing projects after upgrading, and says this.

**DD6. A reinstall removes the old sandbox under the names the record holds, and only then gives the record new names.**
Today an install writes its record first and then removes whatever has the record's names; the names never change, so one variable serves both. Once a reinstall changes the names, that order would write the new names, remove nothing, and leave the old sandbox running with no record naming it; the startup reconciliation would then look for a sandbox at the new names, find none, and leave the old one online. So:
1. While the old sandbox exists, the record says `installing` and still holds the old names.
2. Proxied servers on the old sandbox are closed, and the old sandbox is removed, by the old names.
3. The record takes the new names.
4. Whatever is at the new names is removed. Only this installation can have put it there (an earlier attempt that died), and the creation guards of DD4 depend on this step.
5. The clone and the build proceed as today, under the new names; every later step, and the cleanup when the build fails, uses the names the record holds at that moment.
- A process that dies between steps 2 and 3 leaves a record that names nothing, which already reads as "no longer exists; reinstall". At no point does a sandbox exist that no record names. The window is no wider than today's.
- If the old sandbox cannot be removed because Docker failed, the reinstall fails and the record still names the old sandbox. Today that path deletes the record and can leave the sandbox behind it.
- A limit, accepted by the operator on 2026-11-16: "at no point does a sandbox exist that no record names" holds for the session doing the reinstall. Another session of the same installation that read the record before the reinstall and writes it back afterwards (the end of a discovery, a refresh or a connect; `set_project_network`) puts the old names back, and the sandbox the reinstall built is then named by no record. That lost update exists today, where it costs a tool list; names that change make it cost a sandbox. The second design review proposed making those writes conditional; the operator declined it: the project is a day old and has one user, and coordination between sessions is outside the mission. The README states the limit, with the Docker command that finds a sandbox by its owner label.
- This is the path of every install that finds a record and does not return it at once: `reinstall: true`, and also an install over a record that is `failed`, or that says `installing` (a dead install, or another session's live one, whose sandbox step 2 then removes, as today).
- A first install has no old sandbox: steps 3 to 5 only, as today. When the names computed now are the names the record already holds (a second reinstall), step 4 is skipped.
- The failure branch chooses by how far the install got, where today one flag chooses between two outcomes:
  - Before step 3 (the old sandbox could not be removed): nothing has changed in Docker, so the record is put back as it was before the install began, with a warning that the reinstall could not remove the old sandbox, and the call reports the failure.
  - After step 3, before a container exists: whatever is at the new names is removed and the record is deleted, as today ("leave no half-project behind"). The old sandbox is already gone.
  - Once a container exists: it is taken offline and the record is kept as failed, as today.
- Trade-off: this reorders a few lines at the top of `Installer.install` and its failure branch, in a method mission 01 decided not to restructure. It is the one place the installer changes shape.

**DD7. When a record names a sandbox that is another installation's, or not ours at all, the sandbox is never touched, and the registry side of the operation completes.**
- Start, run a command, launch a server with variables, change the network: refused, with the message of DD4.
- `uninstall_project`: removes the record and its tools, leaves the sandbox, and says so, naming the owner.
- `install_project(reinstall: true)`: leaves that sandbox where it is, builds a new one under this installation's own names, and records a warning that says so.
- Rationale: a refusal with no way out would leave a record the operator can neither use nor remove; for a container that is not ours, that is the case today, where the uninstall fails forever. Reinstalling is the remedy the refusal message gives, so it has to work, and because new names carry the id, building beside the other sandbox is safe.
- When this arises: a registry copied to a new data directory without its id file. The tests make it by seeding one installation's registry with another's record.
- A mixed pair is treated as a whole. If either the container or the volume a record names is another's or not ours, neither is removed, and the message names both and says which is whose. A volume of this installation's can be left behind this way with no record naming it; the message is how the operator learns of it.
- Trade-off: `uninstall_project` reports success for a record whose sandbox it did not remove; its message must make that plain. A removal that **failed** (Docker did not answer, a failed `rm`) is different: the record is kept so the operator can try again, as today (`test/installer.test.ts:679`).

**DD8. A refusal and a "could not find out" are their own kinds of error, and code that swallows errors lets them through.**
- Two error types from the Docker layer: one for a refusal, carrying the class and the owner, and one for "Docker could not be asked". Nothing decides from the text of a message.
- The type is what tells "refused, so drop the record" (DD7) from "failed, so keep it".
- The places that swallow an error from the Docker layer today must not swallow these: discovery, which turns a failed command into "no commands found" in eight places and would then record a project as ready with no tools; the step that takes a failed install offline, which would write "may still be online" into the record about a sandbox that is not this installation's; the rollback of a failed install. Each either lets the error rise or says what is true: "belongs to another installation; left alone". Taking offline a sandbox that is not this installation's, at a failed install or in the startup reconciliation, neither changes what the record says about its network nor adds "may still be online".
- The two errors arise only where a name is resolved. In the proxy that is the opening of a session; a session that failed to open leaves nothing in the proxy's table. The proxy's kill and its idle reaping act on a reference that was checked at launch, cannot meet a refusal, and go on swallowing errors as they do today: if they threw, closing a project's sessions could stop an uninstall before it removes the record (against DD7) and could make shutdown fail.
- Rationale: the classes of DD4 are only as good as their route to the operator. Mission 01 found the same shape twice: an answer of "no" standing for "could not find out".
- Trade-off: discovery and the failure paths of the installer are touched, lightly, in a flight that is otherwise about the Docker layer.

**DD9. The operator finds a sandbox's owner from Docker, and an installation's id from the installation.**
- From Docker: the label, and the name. The README gives the one command, where it gives the one for the idle timeout today.
- From the installation: `list_projects` states this installation's id once, including when no project is installed. A project's full description shows its sandbox's name. `project_info`, and only it, asks Docker once and says whether the sandbox is this installation's, from before ownership was recorded, another's, missing, or could not be checked.
- Rationale: the description of a project is built without asking Docker and is used in many results; the name is in the record, so it costs nothing, while the class needs a round trip and belongs to the one tool that is asked about one project.
- Trade-off: no new tool and no listing of every sandbox on the machine from inside mcp-everything.

**DD10. Verified by scripted tests; no behavior test and no HAT leg.** *(The operator's decisions, 2026-11-16.)*
- Unit suite, the Docker layer through its real class. A scripted `docker` that answers by the whole command line and does not replace the methods under test (the existing one in `test/docker.test.ts` answers by first word and overrides `ensureRunning`, so it cannot exercise the guard). The classification, one case per class, for a container and for a volume. Every guarded operation against each class. A coverage test that walks the Docker layer's methods, with a short list of those that touch no sandbox, and for each of the rest asserts that against "another's" no changing command is issued; a method added later cannot skip the guard unnoticed. The refusal message, including a label value that needs cleaning.
- Unit suite, the rest. The id file: first start, second start, two starts at once, an invalid file, a directory that cannot be written. Naming and the labels in the arguments of every create. The reinstall order of DD6, including a death at each step and a removal that fails. The installer's and the server's doubles gain a way to raise the typed refusal, so that DD7's outcomes and DD8's routes are tested where they are decided. The proxy's launch and kill.
- Docker suite (`npm run test:docker`, real Docker, real clone): two server instances on two data directories with no name prefix set install the same repository; each has a working tool; the first's container id and volume are unchanged by the second's install. Then, with the second's registry seeded with the first's record: each operation is refused and the first's sandbox is unchanged (same container id, same network state, still there); uninstall leaves it; reinstall builds beside it. Then a sandbox from before the change, made by the test with the generic label only, works as today through one tool call and an uninstall.
- Apparatus, both axes. Act: the suite drives `App.callTool` in-process, as it does now. Observe: `docker inspect` and `docker ps` for id, labels, name, network and existence, which the suite already shells out to.
- Rationale: one script can verify every criterion, which is the case the methodology says not to spend a behavior test on. The mission's note on its first criterion is corrected to match.
- Trade-off: nothing runs on Windows. No test runs two real processes; two `App` instances in one process share nothing but Docker and the file system, which is what two installations share.
- Rules for the Docker suite, because it runs on a machine that holds the operator's real sandboxes:
  - No test creates, changes or removes anything whose name an operator's sandbox could have.
  - The case with no prefix set builds its configuration from an environment with `MCPE_NAME_PREFIX` removed and the data directory pointed at a temporary one, and asserts that its installation's id is eight hexadecimal characters **before** its first Docker call, so that a fault which produced an old-style name fails before it can reach `mcpe-<slug>`.
  - The sandbox "from before the change" is made under the suite's own prefix (`mcpe-it-<pid>-`), never as `mcpe-<slug>`. A seeded record carries the other test installation's real names.
  - Cleanup removes by the exact names the test made, as the suite does today; nothing sweeps by label or pattern.
  - The ids of the operator's five containers are recorded before the first run and compared after the last.

### Prerequisites
- [x] Mission 01 (Maintenance) completed.
- [x] Squawks 0034 and 0036 (both in `src/registry.ts`) completed.
- [x] Mission 02 agreed with the operator (2026-11-16).
- [x] Docker reachable from the project for the Docker suite (ran: server and client 29.8.2).
- [x] The generic label has been on every sandbox since the first commit (ran: `git log -S`), so no sandbox the product made is "not ours". The class stays reachable for an unrelated container that happens to have the name, so its code and tests are still required.
- [x] Unit suite green at 500 tests in 1.65 s; hosted floor at 480 (`.github/workflows`), to be raised with the suite.
- [x] The flight's design is on the planning branch (`mission/02-planning`, pull request 16).

At the start of execution, by whoever starts it (not prerequisites of the design):
- Cut the flight branch from `main` once pull request 16 is merged, or from `mission/02-planning` if it is not.
- Record in the flight log the container ids of the operator's five sandboxes and the names of their five volumes.

### Pre-Flight Checklist
- [x] All open questions resolved
- [x] Design decisions documented
- [x] Prerequisites verified
- [x] Validation approach defined
- [x] Legs defined

---

## In-Flight

### Technical Approach
Three legs. The first gives the installation its identity and puts it on what it creates; nothing is refused yet. The second makes the Docker layer check before it acts and carries the checked reference to everything that runs a command. The third decides what each operation does with a refusal, and proves the whole with two installations against real Docker. They land in one review and one commit.

**Identity and names (leg 1).** A small new module owns the id file (DD1). The Docker layer's constructor takes the id; `App` loads it where it constructs the Docker layer today, and the installer reads it from the Docker layer when it computes names, where it computes them from prefix and slug today (`src/install/installer.ts:184-185`). The Docker layer adds the owner label wherever it writes the generic one (`src/sandbox/docker.ts:253`, `306-308`). `Installer.install` is reordered as DD6 says, with its failure branch choosing by phase; in this leg its removals still use today's check, which is safe because the only names it removes are the record's old ones (as today) and its own new ones, and a removal that today's check refuses is a plain failure. `list_projects` gains the id line, in both of its branches, and a project's full description gains the sandbox's name. The README's sentence that a container is named with the prefix plus the slug changes in this leg, so that no commit states the old rule.

**The guard and the reference (leg 2).** One pure function classifies from labels. One private step in the Docker layer resolves a name to id, labels and state in a single typed inspect and returns a checked reference or raises one of the two errors of DD8. `state`, `ensureRunning`, `exec`, `setNetwork`, `removeContainer` and `destroy` go through it and act on the id; `probe` and `createContainer` gain the creation guards, and `createContainer` returns the reference to what it made; `hasNetwork`, which nothing in `src/` calls, is brought under the same rule or removed. The reference is then carried as DD4 lists: out of `sandbox()` and `requireSandbox`, into `execFor`, discovery and the proxy, whose launch carries it beside the container's name (the name stays as the session key and in what the tests observe). The new scripted double and the coverage test come with this leg. At its end every operation is guarded and a refusal surfaces as an error wherever it is not swallowed.

**What a refusal means to each operation (leg 3).** `Installer.uninstall` and the reinstall path apply DD7; the swallow sites apply DD8; `project_info` gains its line (DD9). The two-installation cases go into the Docker suite. The README is written here, when the behavior it describes exists; the hosted floor is raised.

Rules carried from mission 01 that apply:
- Tell "there is none" from "could not find out".
- Check again immediately before acting; the check and the act are one operation on one id.
- Do nothing when the answer is unknown.
- For each new test, name the source change that makes it fail.
- Run the Docker suite locally before the pull request is marked ready; the hosted check does not run it.

Expected fallout in the tests, from the design review's reading (not run): about a dozen cases in `test/installer.test.ts` assert the name of a newly installed sandbox; about twenty-five in `test/docker.test.ts` script every inspect with one answer and are rewritten onto the new double; the Docker suite constructs the Docker layer about six times and makes two volumes by hand, each of which needs the id or the owner label. Forty to fifty cases touched in all.

Not touched: the registry's format and lock, the slug, tool names, variable names, the seven-hour rule (the reconciliation reaches Docker through `setNetwork`, which is guarded like everything else), and the structure of `Installer` and `server.ts` beyond DD6 and DD8.

### Checkpoints
- [x] An id file is created once per data directory; a second start, and two starts at once, read the same id; an invalid file stops the process.
- [x] A new install's container and volume are named with the id and carry the owner label; the record stores those names.
- [x] A reinstall of a project with old names removes the old sandbox, ends with new names, and leaves no sandbox unnamed at any step.
- [x] Every operation in the Docker layer classifies before acting and acts on the id it classified; the coverage test passes; no `docker exec` by bare name remains in `src/`; a tool call makes no more Docker round trips than today.
- [x] A refusal reaches the caller as a refusal from discovery, from a failed install going offline, and from the proxy.
- [x] Two installations with nothing configured install the same repository and each has its own working sandbox (Docker suite).
- [x] Each operation against another installation's sandbox is refused and leaves it unchanged (Docker suite).
- [x] A sandbox from before the change works as today (unit suite and Docker suite).
- [x] README updated; hosted floor raised; Docker suite time recorded against the 154 s baseline; the operator's five container ids unchanged.

### Adaptation Criteria

**Divert if**:
- The registry's format turns out to have to change.
- A sandbox from before the change cannot be kept behaving as today under the guard, for any operation other than the behavior changes DD4, DD6 and DD7 name.
- The id file cannot be created safely for concurrent starts by the means of DD1.
- The guard cannot sit in the Docker layer, and has to be spread over the call sites.
- A tool call ends up slower than today by more than about a tenth of a second, which would mean the one-check-per-operation design did not hold.
- Any test run changes one of the operator's five containers.

**Acceptable variations**:
- The id's length, the file's name, the label's exact name, and the wording of messages.
- The shape of the checked reference and of the Docker layer's interface, and the changes to the test doubles that follow.
- Folding two legs into one, or moving work between them, if a leg proves too thin or too large to design and review as one.
- Covering the proxied launch's refusal in the unit suite alone if a second server in the Docker suite costs more than it shows.

### Legs

> **Note:** These are tentative suggestions, not commitments. Legs are planned and created one at a time as the flight progresses. This list will evolve based on discoveries during implementation.

- [x] `installation-identity-and-owned-names` - The id file; the Docker layer constructed with the id; names and owner labels on everything created; the reinstall order of DD6 and its failure branch; the id in `list_projects` and the sandbox's name in a project's description; the README's naming sentence; the tests whose assertions name a newly installed sandbox.
- [x] `ownership-guard` - The classification and the two error types; the guard on every operation in the Docker layer; creation guards; the new scripted double, the coverage test and the structural test. Callers still pass names.
- [x] `checked-reference` - The checked reference carried through the server, the installer's discovery and install, and the proxy's launch and kill, so that one operation checks once. *(Split from `ownership-guard` at its design review, which found the two together too large for one pass.)*
- [x] `refusal-outcomes` - DD7 for uninstall and reinstall; DD8 at the swallow sites; `project_info`'s line; the tool descriptions; the hosted floor.
- [x] `two-installations-and-readme` - The two-installation cases in the Docker suite, with their safety rules; the README's section on several installations. *(Split from `refusal-outcomes` at its design review, for the same reason as the split above.)*

No HAT leg, by the operator's choice.

---

## Post-Flight

### Completion Checklist
- [x] All legs completed
- [ ] Code merged
- [x] Tests passing
- [x] Documentation updated

### Verification
- `npm test`: green, with the new unit cases, and the hosted floor raised to match.
- `npm run test:docker`, run locally: green, including the two-installation cases; its duration recorded.
- By hand, once, on the built server: `list_projects` shows the installation's id; after an install, the README's `docker ps` command shows the new sandbox with that id as its owner.
- The operator's existing sandboxes are untouched by the test runs: the same five containers, with the container ids recorded at the start of execution, and the same five volumes.
