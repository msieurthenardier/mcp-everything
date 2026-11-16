# Flight: Local State Hygiene and Secret Hand-Off Tests

**Status**: in-flight
**Mission**: [Maintenance](../../mission.md)

## Contributing to Criteria
- [ ] A test fails if a variable's value appears in the command line of a proxied launch or if the env file is not private, and env files left by a crash are removed at startup (finding 5).
- [ ] A registry file written by a newer version is refused with a clear message and never rewritten (finding 6a).
- [ ] Registry temp files left by a crash are removed at startup (finding 6d).

---

## Pre-Flight

### Objective
Two things about the state mcp-everything keeps on disk. First, pin the one secret-handling property that is real and independent of who is trusted: a variable's value reaches Docker through a private file and never through a command line, where any process on the host could read it. Today the test that appears to assert this cannot fail for a proxied launch. The design sortie that follows this mission will rework the launch path, and it needs that net in place first. Second, reconcile what a crash leaves behind: env files holding values, registry temp files, and a registry written by a version this one does not understand.

### Open Questions
N/A — maintenance flight. The one small design call is stated under Design Decisions with a default.

### Design Decisions

**A registry file with a newer `version`**: refuse to load, never rewrite
- Rationale: reading a later format as version 1 and writing it back drops whatever the later format added. It is the only data-loss path the inspection found that needs no operator mistake. Refusing is the smallest safe behavior and matches how a corrupt file is already treated (a clear "unreadable" error).
- Trade-off: after a downgrade, every tool that needs the registry fails until the operator upgrades again or moves the file. A read-only mode would be friendlier and is more than this flight should build.

**Startup sweeps touch only files that cannot be in use**
- Rationale: several processes can share one data directory, and an env file exists for a moment during every launch (written, handed to `docker exec`, removed after the handshake). The default is to remove only files older than a generous bound, such as an hour, and only names matching what the product itself writes (`env-<hex>` in `tmp/`, `registry.json.<pid>.tmp`).
- Trade-off: a file left by a crash survives until the next start after the bound has passed. The directory is mode 0700 and the files 0600, so exposure meanwhile is local to the operator's own account.
- Provenance: the sharing and the file lifetimes are read from `src/registry.ts` and `src/proxy/mcp-proxy.ts`, not tested by this inspection.

**Carried from the flight 02 debrief, for leg design** (inputs, not decisions; flight 02 added startup work on the same shared directory and its design reviews had to add each of these)
- Flight 02 left three things to build on: `Registry.update(slug, fn)` changes a record from what the file holds under the lock and writes nothing when `fn` returns `undefined`; `App.start()` keeps its startup reconciliation in `App.reconciling`, a promise that never rejects and that tests await instead of polling; and the rule it followed was to re-check immediately before acting and to do nothing when the answer is unknown.
- **Registry temp files**: `registry.json.<pid>.tmp` exists for the length of one write and is renamed away. A leftover is not proof of a crash on its own; a live neighbor may be mid-write. Read `Registry.mutate`, `update` and `lock` first, and consider doing the sweep while holding the registry lock, when no write can be in flight. A process id in the name is reused and means nothing across hosts.
- **Env files**: the name carries no owner. Before choosing the age bound, read in `src/proxy/mcp-proxy.ts` when the file is removed and whether `docker exec` has finished reading it by then, so that a launch another process started a moment ago cannot lose its file.
- **Each removal**: stat and re-check right before the unlink, ignore a file that has already gone, never log a file's contents.
- **The version check**: `mutate` and `update` both re-read and then rewrite the file, so the check belongs where the file is read and before any write, not only at startup. Say what a refused file blocks: the tools that need the registry, or the whole server.
- **Three startup tasks will now exist in three classes** (`Installer`, `Registry`, the proxy). One awaitable "startup work finished" on `App` is better than a field per task.
- Raise the hosted check's test floor in the last leg (it is 430 against 447).

### Prerequisites
- [x] Flight 01 landed, so this work is checked on its pull request (preferred, not required).

### Pre-Flight Checklist
- N/A — maintenance flights skip Pre-Flight.

---

## In-Flight

### Technical Approach

One finding maps to one leg. Evidence is from the maintenance report (Categories 1 and 9) and was read unless marked.

**Finding 5 — the secret hand-off is barely tested; leftover env files are never swept** (Security Reviewer; low as rated, raised to Action Required by the Architect because the design sortie will change this path).
- Evidence: the assertion at `test/server.test.ts`, about line 730 ("docker.calls … not.toContain(VALUE)"), records only `Docker.exec` calls. Proxied launches go through the connector, not `Docker.exec`, so the assertion cannot fail for launch argv. The real `dockerConnector` (`src/proxy/mcp-proxy.ts:72-98`: `--env-file`, a file of mode 0600 with a random name in a 0700 `tmp/` under the data directory, removed in `finally`) is exercised only by the Docker-gated suite, and that test checks neither file mode nor argv. A search finds no unit test of `dockerConnector` or `env-file`. An env file left by a kill between the write and the cleanup stays in `<dataDir>/tmp`; nothing sweeps it. The directory was empty when inspected.
- Fix: unit tests of the real connector's argument list and file — the value is absent from argv, the file's mode is 0600, its directory's is 0700, and the file is gone after the launch settles, on success and on failure. This may need a small seam so the connector's arguments can be observed without starting Docker; keep it to that. Replace or delete the vacuous assertion and say which. Add the startup sweep of `tmp/` per the design decision.
- Related, not in scope: squawk 0010 (two validators for unusable values), squawk 0011 (an empty-valued variable end to end), squawk 0012 (the secret test value in three files) and squawk 0016 (the connector's comment) touch the same files. If the turnaround that completes them has not landed, do not fold them in; note the overlap in the flight log.

**Finding 6a — the registry's `version` is written and never checked** (Inspector; medium, new).
- Evidence: `src/registry.ts:9,39-45,81` — reads cast the parsed file to `RegistryFile` without looking at `version`; writes always write `version: 1`. A corrupt file already throws "unreadable" from `refresh()` and is tested at `test/registry.test.ts:72`.
- Fix: on load, a `version` greater than the one this build writes is an error naming both versions and the file, raised the same way as the unreadable case, and no write follows it. A missing `version` on an otherwise valid file is treated as 1, if any such file can exist; check what the earliest released version wrote before deciding, and record it.

**Finding 6d — registry temp files left by a crash are never swept** (Inspector; low, new).
- Evidence: `mutate()` writes `registry.json.<pid>.tmp` and renames it over the target; a process that dies between the two leaves the temp file behind.
- Fix: the same startup sweep as for env files, under the same age rule.

Out of scope here: emptying the registry on a stat error (squawk 0017), quarantining a corrupt registry (finding 6c, carried), fsync, and the lock's steal timing.

### Checkpoints
- [x] A unit test fails when a value is put into the connector's argv, and passes as the code stands.
- [x] The vacuous assertion is gone or made real, and the flight log says which.
- [x] A registry file marked with a later version is refused and is byte-identical afterwards.
- [x] Old env and registry temp files are removed at startup; fresh ones are left.

### Adaptation Criteria

**Divert if**:
- Observing the connector's arguments needs more than a small seam, for example a change to the `Connector` interface that the proxy and its tests share.
- The earliest released version wrote registry files that the version check would refuse.
- A sweep cannot tell its own files from an operator's without a naming change.

**Acceptable variations**:
- The age bound for the sweeps, if stated and tested.
- One sweep function serving both file kinds, or two.
- Leaving the old assertion in place with a comment on what it does cover, if it still pins something about `Docker.exec`.

### Legs

> **Note:** These are tentative suggestions, not commitments. Legs are planned and created one at a time as the flight progresses. This list will evolve based on discoveries during implementation.

- [x] `handoff-tests-and-startup-sweeps` - The gaps in the connector's tests closed; leftover env files and registry temp files removed at startup; one awaitable for startup work (findings 5 and 6d)
- [x] `registry-version-check` - Refuse a registry from a newer version; the hosted check's test floor raised (finding 6a)

---

## Post-Flight

### Completion Checklist
- [x] All legs completed
- [ ] Code merged
- [x] Tests passing
- [x] Documentation updated

### Verification
`npm test` and `npm run typecheck` pass with the new cases. To show the connector test is not vacuous in its turn: temporarily put a value into the connector's argument list, watch the new test fail, and revert; record that in the flight log. A registry file hand-edited to a later `version` makes `list_projects` report the refusal and leaves the file unchanged. `npm run test:docker` passes; its secret-gated case is unaffected. The README's data-directory section gains a sentence only if the refusal or the sweep is something an operator would meet. The hosted check added by flight 01 does not run the Docker suite and will be green without it: run `npm run test:docker` locally before the pull request is marked ready, and record the result in the flight log. In the leg that adds tests, raise the minimum passed-test count in `.github/workflows/ci.yml` to stay close under the new total.
