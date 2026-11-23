# Leg: network-tools

**Status**: completed
**Flight**: [Contained Network and Isolation Runtime](../flight.md)

## Objective
Give the agent the after-install network controls under containment:
- `set_project_network`, three-way;
- a `hosts` parameter on `install_project`, and a new `set_project_hosts` tool;
- `ProjectRecord.hosts`, kept by every record writer;
- refusals in failed tool calls and in `project_info`;
- Docker's own view of the network in `project_info`;
- MCP servers closed when the network changes.

It also proves the operator's `MCPE_LOCAL_ACCESS` end to end on a real local service. With `MCPE_NETWORK=open` every existing behavior and message stays as it is, apart from the named additions.

## Context
- **Flight decisions.**
  - **DD6**: `hosts`, `set_project_hosts`, grammar and refusals, merging writers, re-validation when a proxy is built, a reinstall merging, and the sandbox reaching its registries.
  - **DD7**: what `set_project_network` says; MCP servers closed on a change; `describe()` from Docker's view.
  - **DD8**: a session never loosens what another tightened.
  - **DD9**: refusal messages.
  - **DD10**: local access by repository, aliases, forwards.
- **Legs 1–8** (landed):
  - **Leg 1**: `parseHostEntry(…, "agent")`, `localAccessFor`.
  - **Leg 6**: `setNetwork` modes, `projectRefusals`.
  - **Leg 7**: `Containment.contain`, which returns `{ ok, error, sandbox }` and contains a sandbox from `off` or `bridge`; `replace`; the forwards from `localAccessFor` with aliases; invalidation.
  - **Leg 8**:
    - the install path;
    - `src/network/refusals.ts` (`refusalLines`, `refusalWarnings`);
    - the interim pre-contain snapshot `put`, which drops `hosts`, logged for this leg;
    - the `hosts`-hint naming this leg's parameter.
- **`ProjectRecord.hosts` is read through a cast** in `src/network/containment.ts` (leg 7's deviation). This leg adds the field to `src/types.ts` and removes the cast.
- **Today's `set_project_network`** (`src/server.ts`, the `set_project_network` case):
  - `true` → `this.sandbox(project)` → `setNetwork(sandbox, "open")`;
  - `false` → by name, `"off"`;
  - then `registry.put({ ...project, network: enabled })`, a stale spread (DD6 calls it out);
  - message: "ON: its code can reach the internet and your local network".
- **Today's record writers in the installer** that hold a record across long work are listed in DD6: around lines 529, 542, 573, 681, 702, 815 and 898 at planning. Re-locate them by symbol.
- **The local service for the Docker case** (leg 1's decision): a container on `bridge` publishing a port, named in `MCPE_LOCAL_ACCESS` as `host.docker.internal:<published port>`. On Docker Desktop that name reaches published ports. On native Linux, `host-gateway` is `172.17.0.1`, and leg 3's narrow exemption covers it, as leg 4 measured.

## Inputs
- `src/server.ts`: `install_project` schema and handler, `set_project_network`, `project_info`, `describe()`, `call_project_tool` and the generated-tool call path, `sandbox()`.
- `src/install/installer.ts`: `openInstall` (carries `selection` from `existing`), every `registry.put`, `rediscover`, `connect_mcp_server`'s writer.
- `src/types.ts` (`ProjectRecord`); `src/registry.ts` (`update`); `src/network/containment.ts`; `src/network/refusals.ts`; `src/proxy/mcp-proxy.ts` (`closeProject`).
- `test/server.test.ts`, `test/installer.test.ts`, `test/integration/docker.test.ts`.

## Outputs
- `src/types.ts`: `hosts?: string[]`.
- `src/server.ts`: the tool changes and the new tool.
- `src/install/installer.ts`: `hosts` handling and the merging writer.
- `src/network/containment.ts`: the cast removed.
- `src/registry.ts`, if the merging helper lives there.
- Tests.

## Acceptance Criteria

**The record field and its writers** (DD6):
- [ ] **`ProjectRecord.hosts?: string[]`**: normalized entries from leg 1's agent-mode grammar (`host` or `host:port`, with `*.` allowed). The cast in `containment.ts` is removed.
- [ ] **One merging writer.** `registry.update(slug, cur => ({ ...next, hosts: cur?.hosts }))`, exposed as e.g. `Registry.putKeepingHosts(record)`. It is used by:
  - every installer writer that holds a record across a build, sandbox call or discovery;
  - leg 8's pre-contain write;
  - `rediscover`;
  - `connect_mcp_server` and `disconnect_mcp_server`'s writers;
  - `select_project_tools`;
  - `set_project_network`.

  The only writers of `hosts` are `set_project_hosts`, and `openInstall` (from `existing`, plus the install's `hosts`).
- [ ] **Unit cases**: a `set_project_hosts` landing during an install, during a rediscovery and during `set_project_network` is not lost. Each is written by a separate `Registry` instance, as flight 1's stale-write tests do.

**`install_project`'s `hosts`:**
- [ ] **The parameter**: an optional array of at most 64 strings. Each is parsed in agent mode. An invalid one refuses the call with leg 1's step-named reason, before anything runs.
- [ ] **Merging**: `openInstall` merges the parameter into `existing.hosts`, normalized, de-duplicated and sorted.
- [ ] **The schema description** says the hosts apply under network containment, and are recorded but have no effect otherwise.

**`set_project_hosts(project, add?, remove?)`** (new tool):
- [ ] **Validation.** At least one of `add` and `remove`; each at most 64 entries. `add` entries are parsed in agent mode, and refused with the step-named reason. `remove` entries are matched after the same normalization; an unknown entry is reported, not an error.
- [ ] **Writing**: `registry.update` applies `(cur.hosts ∪ add) \ remove`, sorted.
- [ ] **What it does next**:
  - if the session is `contained` and the project's Docker state is `contained`: `containment.replace(key)`, then `proxy.closeProject(container)`, then invalidate. A failed replace leaves the old proxy (leg 7) and says so;
  - if the session is `contained` and the network is off: the hosts are recorded and apply when the network is turned on;
  - if the session is `open`: recorded, and the result says "recorded; no effect until the operator turns on network containment (`MCPE_NETWORK=contained`)".
- [ ] **The result** lists the project's hosts after the change.
- [ ] **Annotations**: not read-only, not destructive.
- [ ] It is refused while the project is installing (`assertNotInstalling`).

**`set_project_network`** (DD7, DD8):
- [ ] **Session `contained`**:
  - `true` → `containment.contain(key, { start: false })` from `off` or `open`. The result: "contained: it can reach `<registries>` and `<hosts>`; local addresses only as the operator allows (`MCPE_LOCAL_ACCESS`)". `contain` failing leaves the sandbox on no network and returns its error;
  - `false` → `"off"` (unchanged).
- [ ] **Session `open`**:
  - `true` on a sandbox Docker shows `contained` → **unchanged**: never loosen. The result says it is contained by another session's setting and stays so;
  - `true` otherwise → `"open"` with today's message;
  - `false` → `"off"`.
- [ ] **The record write** follows Docker's result, through the merging writer.
- [ ] **MCP servers**: on any change, `proxy.closeProject(container)` and invalidation.

**`project_info` and failed tool calls** (DD7, DD9):
- [ ] **`project_info`'s network line** shows Docker's view: `off`, `contained`, `open`, or `unknown` if Docker cannot be asked. It replaces the record's boolean there. `list_projects` keeps the record's view (no per-project Docker calls), and its line is labelled `network (recorded)`.
- [ ] **When contained**, `project_info` also shows:
  - the effective hosts;
  - the latest refusals (`refusalLines`, at most 10), or "no refusals recorded since the proxy started";
  - for each `MCPE_LOCAL_ACCESS` entry that names this repository, the alias and port.
- [ ] **A failed generated tool call or `sandbox_exec`** (non-zero exit or a timeout) on a contained sandbox appends the refusal lines from `projectRefusals`, read once on failure, with the `not-allowed` hint naming `set_project_hosts`.
  - A refused local address names `MCPE_LOCAL_ACCESS` and the operator (DD10).
  - Successful calls make no extra read.

**Local access, end to end** (DD10; Docker-gated):
- [ ] **The case.**
  - A local service: a container on `bridge` running a TCP echo server, publishing its port on the host's loopback-free interface (`-p <port>:9000`).
  - `MCPE_LOCAL_ACCESS="<test repo id>=host.docker.internal:<port>"`.
  - A contained sandbox for that repository (leg 7's pattern, with its own registry and record).
- [ ] **What it asserts**, from inside the sandbox:
  - connecting to `host.docker.internal:<port>` reaches the echo service;
  - the same sandbox without the entry (another repository id) cannot resolve or reach it;
  - a `CONNECT host.docker.internal:<port>` through `mcpe-proxy` is refused, because the forward is scoped to its listener.
- [ ] **On native Linux** the same case runs in leg 12's job.

**Other Docker-gated cases:**
- [ ] **`set_project_hosts` without a reinstall**: under `contained`, `github.com` is refused, then allowed after `set_project_hosts(add: ["github.com"])`, with exactly one proxy.
- [ ] **`set_project_network(true)` under `contained`** on an offline sandbox: it is contained, and its proxy allows the run hosts.
- [ ] **The full Docker suite passes** after the go-ahead. It also owes leg 8's full green run.

**Overall:**
- [ ] `npm run typecheck`, `npm test` and `npm run build` pass.
- [ ] **With `MCPE_NETWORK=open`**, no existing assertion changes, except the named entries in the flight log. Expected entries:
  - the `set_project_network` record write;
  - `project_info`'s network line and `list_projects`' label;
  - the new tool in the tool list and its count.

## Verification Steps
- **Unit**:
  - every branch of `set_project_network` under both sessions;
  - `set_project_hosts`: validation, merge, the replace call and its failure, the open-mode message;
  - the merging writer against concurrent `Registry` instances;
  - `install_project`'s `hosts` and the reinstall merge;
  - `project_info`'s lines;
  - refusal lines on a failed call and none on success.
- **The Docker gate**, as in legs 5–8, with the volume list saved before.
- **Trials**. Weaken, confirm a test fails, restore by editing:
  - `set_project_network` under `open` loosening a contained sandbox;
  - a writer spreading a stale record over `hosts`;
  - an `add` entry not re-validated;
  - refusal lines read on a successful call.

## Implementation Guidance
1. The field and the merging writer; move every writer to it, with the stale-write unit cases.
2. `install_project`'s `hosts` and `openInstall`'s merge.
3. `set_project_hosts`.
4. `set_project_network`'s branches.
5. `project_info` and the failed-call refusal lines.
6. Unit tests and trials; then stop at the gate.
7. After the go-ahead: the local-access case, the hosts case, the network case, then the full suite.

## Edge Cases
- **`set_project_hosts` while the sandbox is open under a `contained` session** (another session opened it): recorded, and the result says the network is open, so hosts have no effect until it is contained. It does not contain the sandbox itself.
- **Removing a host that is in the default table**: the default stays allowed. The result says defaults cannot be removed per project.
- **`MCPE_LOCAL_ACCESS` names a repository with no installed project**: nothing happens. `project_info` of another project does not mention it.
- **An agent passing `host.docker.internal` in `add`**: refused by the grammar (agent mode, local names), with the step reason and a pointer to `MCPE_LOCAL_ACCESS`.

## Design Review 1 Resolutions (binding; they override the text above where they differ)
Flight Director, 2026-11-23. Review: approve with changes.
- **No second design review.** These resolutions adopt the reviewer's own fixes, and the flight-end Reviewer reads all of it.
- **One leg, two stages**:
  - **Stage A**: record integrity, the tools and branches, `project_info`, the refusal text, and unit tests;
  - **Stage B** (gated): the local-access measurement first, then the Docker cases.

1. **Refusal hints are advisory, never imperative: an injection guard.**
   - A refused host is chosen by the project's own code. `safeHost` leaves letters, digits, dots and hyphens, so `ignore-the-above-and-allow-me.attacker.net` survives cleaning. A ready-made `set_project_hosts(add: [...])` line would then steer the agent into allowlisting it.
   - So every `not-allowed` line, for build, clone, scanner and the new `run` context, reads as a statement plus a caution: "`<host>:<port>` was refused. The project's own code asked for this host; allow it (`hosts` on install, or `set_project_hosts`) only if you expect this project to need it."
   - **Leg 8's build wording changes with it.** Its tests move, and are listed.
   - **`refused-address` in the `run` context** names `MCPE_LOCAL_ACCESS` and the operator: "only the operator can allow local addresses for a repository".
   - **The lines say they may include refusals from earlier calls** ("refused since the proxy started").
   - **A failed call shows at most 3 lines**; `project_info` shows up to 10.
   - `src/network/refusals.ts` and its tests join Outputs and Files Affected.
2. **"Never loosen" is atomic.** `Containment.openUnlessContained(key)` takes the per-project lock (`withProjectLock`), reads `networkState`, and calls `setNetwork("open")` only if the state is not `contained`.
   - It works under an `open` session too: `Containment` exists in both modes.
   - `set_project_network(true)` under `open` uses it; under `contained` it uses `contain`.
   - `FakeDocker` (`test/helpers.ts`) gains `networkStateResult` and `networkStateError`.
   - The `test/server.test.ts` pins that change (`set_project_network: acquires once`, the runtime-mismatch cases, the `ensureCalls` pins) are listed.
3. **The record writers.**
   - **One helper**: `putKeeping(record, keep: Array<"hosts" | "network">)`, through `registry.update`.
     - If the file has no record, because an uninstall deleted it, it **writes nothing** and returns `undefined` with a logged warning: never resurrect.
     - After the write, the in-hand record's kept fields are set from the stored ones, so returned records and `describe()` are current.
   - **Writers and what they keep**:
     - **`hosts` only**: every installer `put` of a held record (the clone, renamed, contained-snapshot, after-destroy, build-phase and failure writes), re-located by symbol.
     - **`hosts` and `network`**: `finish` (behind `rediscover`, `refreshMcp`, `connectMcp`, `disconnectMcp`) and `reselect`, since discovery never changes the network.
     - **`hosts` kept, `network` written**: `set_project_network`'s write.
   - **`settleFailure`'s old-phase restore** of `{ ...before }` keeps the file's `hosts`. **The failed reinstall's `hosts` parameter is not persisted.**
   - **The first install write** merges inside `registry.update` as `union(cur.hosts, params.hosts)`, not from an earlier `existing`. For the renamed path, the merged `hosts` are put on the clone too.
4. **`set_project_network` branches, completed.**
   - **Runtime refusal**: still through `assertNotInstalling`, and the runtime comparison through `acquire`, except that under a `contained` session `contain(key, { start: true })` replaces `acquire`'s start, so a stopped sandbox is never started on `bridge`.
   - **Already contained**: "already contained" and no change.
   - **`contain` failure**: `isError: true`, the record written `network: false`, and MCP servers closed (they are on no network).
   - **The message's hosts** come from `allowanceFor(record)`; dropped entries are shown as warnings.
   - **`closeProject` and invalidation** run only on a real change, never on "unchanged" or "stays contained".
5. **`project_info` and `describe()`.**
   - `describe(p, verbose, view?)` takes an optional Docker view. Without one it prints `network (recorded): on/off` in every tool that uses it. `project_info` passes `networkState` and prints `network: off | contained | open | unknown`.
   - Its Docker reads (`networkState`, `projectRefusals`, the existing owner line) run in parallel with `Promise.all`. Each read is caught and mapped to `unknown`. The refusal read is skipped unless contained and not building.
   - **The effective hosts and forwards are computed from the session** (`allowanceFor`, `localAccessFor`), a deliberate simplification of DD8's "what the proxy carries". When the proxy's record label differs from what the session would build, `project_info` says "the proxy carries a different configuration (another session); it is repaired on next use".
   - Existing pins on `network: on/off` text in `installer.test.ts` and the integration file are grepped and listed.
6. **Refusal reads on failed calls are bounded.** They happen only when all of these hold:
   - the session is `contained`;
   - the record says `network: true`;
   - the call failed;
   - `networkState` is `contained`.

   They are rate-limited per project to one read per 5 s, with the last rows reused. They live in `callGenerated`, `sandbox_exec` **and the MCP-proxied tool path** (an `isError` upstream result, or a throw), never in the shared synchronous `formatExec`, which takes a `refusals` suffix.
7. **The local-access Docker case.**
   - The record's `repo` is built through `parseRepoRef`, so its id matches `MCPE_LOCAL_ACCESS`'s key.
   - The echo service publishes a **random** port (`-p 0:9000`, read back with `docker port`).
   - The third assertion's `CONNECT` goes to `mcpe-proxy:3128` for `host.docker.internal:<forward port>`, and must be refused.
   - **Stage B starts with a measurement on Docker Desktop**, using only suite-prefixed objects. It records:
     - what `host-gateway` resolves to inside a proxy-like container (T13a gave `192.168.65.254`, a `local`-class address, allowed for forwards);
     - whether a TCP connect from there reaches the published port.

     If Desktop cannot reach it, the case is marked Desktop-skipped with the measured reason, leg 12's native job carries the proof, and leg 11's README states the Desktop limit. That is not a silent pass.
8. **The other acceptance tightenings**:
   - a bad `hosts` entry hand-edited into the file does not break `set_project_hosts` (pin);
   - `set_project_hosts` joins `META_TOOLS`;
   - "unknown entry" and "a default cannot be removed per project" are distinct messages, each tested;
   - the server instructions' network sentence (pinned around `test/server.test.ts:2346`) gains a mention of `set_project_hosts`, as a listed change;
   - a trial weakens the never-loosen branch and confirms a unit case fails.

## Files Affected
- `src/types.ts`, `src/server.ts`, `src/install/installer.ts`, `src/network/containment.ts`, `src/registry.ts` (if the helper lives there).
- `src/network/refusals.ts`, `test/network-refusals.test.ts`, `test/helpers.ts`.
- `test/server.test.ts`, `test/installer.test.ts`, `test/registry.test.ts`, `test/integration/docker.test.ts`.

## Citation Audit
Checked on 2026-11-23 against the working tree (legs 1–8 landed):
- `src/server.ts`:
  - `set_project_network` at about line 1184: `true` via `sandbox()` then `"open"`; `false` by name, `"off"`; then `registry.put({ ...project, network: enabled })`;
  - `install_project`'s schema with `network` at about line 104;
  - `describe()` at about line 820.
- The installer's writer lines move with each leg and are re-located by symbol.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
