# Leg: checked-install

**Status**: completed
**Flight**: [Checking a Project's Own Code Before It Runs](../flight.md)

## Objective
Add `Installer.installChecked`: check the repository in a staging clone before anything of an installed project is touched, decide by the operator's policy, and only then open the install, retire the old sandbox, copy exactly the checked bytes into the new one and build — returning an outcome — while sharing every step with `install()` through two behavior-preserving extractions, so `install()` (the scan-off path) runs exactly as today.

## Context
- Flight DD6, DD8, DD4. Split from the first draft of `check-before-build` at its design review (2026-11-22) at the installer/server seam; leg 8 (`checked-install-server`) does the server, the startup sweep and the integration cases. This leg needs no server change.
- Mission 02's debrief: `Installer.install` drifted when edited in several places. So the opening of an install (slug, names, `before`/`renamed`, the record, the state, the first registry write) and its remainder (from clone data to the end) are each extracted once and called by both entry points; nothing is copied.
- The `checking` stage lives in `installChecked` before any install state exists; **`InstallState` gains no member**. A failure while checking is handled there and never reaches `settleFailure`.
- Legs 2–6 provide `Config.scan`, `decide`, `analyzeBuildHooks`, `ScanReport`, `probe(…, { volumeRole: "staging" })`, `ProbeData.walk`, `runScanners`, the sandbox-volume creator, `copyVolume`. Follow the names the code has.

## Inputs
- Legs 1–6 landed.
- `src/install/installer.ts` — `install()` (from `await this.docker.assertAvailable()` through `return this.settleFailure(…)`), `retireOldSandbox`, `buildAttempts`, `settleFailure`, `InstallState`.
- `src/registry.ts` — `refresh()` (mtime-based), `findByRepo`, `get`, `put`, `update(slug, fn)` (locked; forces a re-read; `fn` may return `undefined` to write nothing).
- `test/installer.test.ts` — the existing doubles and cases.

## Outputs
- `src/types.ts` — `ProjectRecord.scan?: ScanReport`.
- `src/install/installer.ts` — `openInstall`, the shared remainder, `installChecked`, `InstallOutcome`; `install()` calling the two extracted pieces.
- `test/installer.test.ts` — new cases only; existing ones unchanged.

## Acceptance Criteria

**Extractions (behavior-preserving; done first, with every existing test green and none edited)**
- [ ] `openInstall(params, existing)` returns `{ record, slug, container, volume, before, renamed, state }` and performs the first registry write exactly as `install()` does today (the renamed copy or the record). It holds: the slug (`existing?.slug` or `makeSlug`), the names, `before` as a `structuredClone`, `renamed`, the record literal (with `installedAt` set at this call and `selection` carried from `existing`), the state holder, and the two `registry.put` branches.
- [ ] The shared remainder, signature `(params, record, probe, container, volume, state, log)`, holds everything `install()` does after the clone: `record.commit = probe.commit`, detection and its notes, the license warning, `meta.*`, `mcpHint`, image choice, attempts, `imageReason`, the "Detected …" log line, `buildAttempts`, the failed-recipe branch, network, discovery, `ready`. Both callers `return await` it **inside** their `try`, so its rejections reach `settleFailure` (a bare `return` of the promise would bypass the `catch`).
- [ ] `install()` becomes: available check, refresh, shortcut, `openInstall`, `try { retireOldSandbox; "Cloning…" log; probe; return await remainder } catch { settleFailure }`. Its unit cases and the Docker suite pass unchanged.

**The outcome**
- [ ] `type InstallOutcome = { kind: "installed"; record: ProjectRecord } | { kind: "blocked"; report: ScanReport; kept?: ProjectRecord } | { kind: "check-failed"; reason: string; kept?: ProjectRecord }`, exported. `kept` is the existing record for the repository (whatever its status), as it stands after any warning was added, or absent when there was none or it was removed meanwhile.

**`installChecked(params, log, hooks?)`**
- [ ] Same opening as `install()`: `assertAvailable` (its failure throws, as in `install()`), `refresh`, and the shortcut (a `ready` record and no `reinstall` → `installed` with it; nothing cloned).
- [ ] **Checking, with nothing touched**: no registry write, no `closeProject`, no `destroy`, no `setNetwork` until the decision to build. `hooks?.onChecking?.()` first. Clones into a new staging volume (a `Docker` method returns a fresh `<prefix><id>-stg-<8 hex>` name — the form no slug produces; it issues no Docker command), with `volumeRole: "staging"`. Detects from the clone's data (the primary being `params.ecosystem ?? detection.primary`), runs `analyzeBuildHooks(primary, probe.walk)` (an exception → that check `failed`, fixed text), then `runScanners` with `cfg.scan.scanners` and `cfg.scan.timeoutSec`, then `decide(cfg.scan.mode, cfg.scan.blockAt, checks)`; the report carries the commit and the time.
- [ ] **The checking stage is one private method** (for example `checkClone(params, log)`), returning `{ staging, probe, report }` or throwing with a cleaned reason after removing its staging volume; `installChecked` calls it, and leg 9's `check()` (the check tool) will call it too, so the checking logic exists once. It touches no registry record.
- [ ] **A failure while checking** (clone failure, Docker not answering, a refusal propagated by `runScanners`) → staging removed (best effort); `check-failed` with a cleaned, bounded reason and `kept`. A first install whose clone fails leaves nothing (with scanning off it would be a failed, deleted record; the difference is intended and has a unit case).
- [ ] **Blocked** → staging removed; when a record exists, `registry.update(slug, cur => …)` returns `undefined` if `cur` is gone, else `cur` with one warning — "A reinstall at commit <12 hex> was blocked by the scan policy on <ISO date>; the project is unchanged." — replacing any earlier warning starting "A reinstall at commit"; nothing else of the record changes; `kept` is that updated record. Outcome `blocked`.
- [ ] **Allowed** → `registry.refresh()` then `findByRepo` again. If a `ready` record now exists that did not before and `reinstall` was not asked: staging removed, outcome `installed` with that record (another session installed it). Otherwise `hooks?.onBuilding?.()`, then `openInstall(params, fresh)` with the fresh record, `record.scan = report`, and in the `try`: `retireOldSandbox`; create the sandbox volume; `copyVolume(staging, volume)`; remove staging; `return { kind: "installed", record: await remainder(…, probe, …) }` with the **same** `ProbeData` (the clone is not repeated). The `catch` is `settleFailure`, as in `install()`; its `old` branch still throws (the rejection is unchanged and is the handler's existing path). The staging volume is also removed in a `finally` (best effort).
- [ ] `onBuilding` fires only on the path that builds, after the re-read.

**Tests** (unit, `test/installer.test.ts`, existing doubles; existing cases unchanged)
- [ ] The extractions: an existing reinstall case still passes; a new case pins that `selection` is carried from the record `openInstall` is given (the fresh one).
- [ ] `installChecked`: the shortcut; blocked first install (no registry write, no sandbox call, staging removed, no record afterwards); blocked reinstall (no `closeProject`/`destroy`/`setNetwork` on the old sandbox; one warning; a second block replaces it; `kept` equals the stored record); blocked when the record was removed meanwhile (`update` writes nothing; `kept` absent); check failed during the clone (first install: nothing left; reinstall: record untouched), during the built-in check (that check `failed`, decision still made), and by a refusal from `runScanners`; allowed path in order (check → refresh → open → retire → create volume → copy → remove staging → build) with `scan` set and `installedAt` from `openInstall`; a registry write by "another session" between the check and the re-read (the fresh record is used); the "installed meanwhile" branch; a copy failure settled by `settleFailure`; a failed retire still rejecting as `install()` does; `onChecking`/`onBuilding` order.
- [ ] `npx vitest run` passes; typecheck clean; build succeeds. No Docker run is needed in this leg (leg 8 runs the integration cases).

## Verification Steps
- After the extractions and before any new code: `npx vitest run test/installer.test.ts` and the whole suite, unchanged counts; record them.
- Then the whole suite with the new cases; typecheck; build.
- Trials (exact edits, undone by editing, compared after each undo): (1) write the record before the check; (2) put the blocked warning with `registry.put` of the stale record; (3) skip the refresh before the re-read; (4) clone a second time instead of copying; (5) `return` the remainder's promise without `await` in `install()`. Report each outcome.

## Edge Cases
- `params.image` does not affect the check; `params.ecosystem` does (the built-in check analyzes the recipe that will run).
- An existing `failed` or `installing` record: `kept` is it; the blocked warning is added to it as to any.
- A reinstall whose names changed: `openInstall` computes `renamed` from the fresh record.

## Files Affected
- `src/types.ts`, `src/install/installer.ts`, `test/installer.test.ts`.

## Citation Audit
Checked by the Flight Director against the working tree after leg 1: `install()` from `await this.docker.assertAvailable();` through `return this.settleFailure(e, record, slug, container, volume, state);`, with the record literal, `const state: { current: InstallState }`, the two `registry.put` branches, `retireOldSandbox`, `probe`, `detect`, `choose`, `buildAttempts`, `setNetwork`, `discover`. Design review (2026-11-22) confirmed `Registry.refresh` is mtime-based and `update`'s `fn` may return `undefined`; that `settleFailure`'s `old` branch throws; and that a bare `return` of the remainder inside `try` would bypass the `catch`.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
