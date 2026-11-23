# Flight Log: Groundwork, and Leaving Old Sandboxes Alone

**Flight**: [Groundwork, and Leaving Old Sandboxes Alone](flight.md)

## Summary
Planned 2026-11-23 with the operator; approved the same day. Not yet started.

**Baseline** (2026-11-23, `72a0420`): two consecutive runs of `npx vitest run` each gave 2988 passed, 71 skipped, 0 failed, in 18.3 s and 17.4 s. The Docker suite baseline is to be run before leg 3.

---

## Reconnaissance Report
These items come from flight 2's and flight 3's debriefs. Each was checked against `main` at `72a0420` on 2026-11-23.

| Item | Classification | Evidence | Recommendation |
|---|---|---|---|
| F03 HAT: move the README's security chapters to `docs/` | confirmed-live | `README.md` 1,596 lines: `## Checking projects before they run` at 339, `## Network containment` at 754, `## Security model` at 1095; no `docs/`; `package.json` `files` is `["dist", "README.md"]` | Leg `docs-split` (DD2) |
| F02 rec 2: split `docker.ts` and `containment.ts` | confirmed-live | `src/sandbox/docker.ts` 2,898 lines (class `Docker` at 877); `src/network/containment.ts` 1,246 lines, lock scheme ≈387–626 | Leg `split-docker-and-containment` (DD5) |
| F02 rec 1: the `before` ownership class | confirmed-live | `refuseUnless` (`src/sandbox/docker.ts:1189`) refuses only `another`/`not-ours`, so `destroy` (`:2871`) removes `before`. `describeFacts` says "treated as this installation's" (`:481`). `server.ts:947` and `installer.ts:83` render it | Leg `old-sandboxes` (DD4) |
| F03 rec 2: withheld-tool accessor | confirmed-live | `src/server.ts` reads `toolCheck` withheld fields at ≈817, 1015–1028, 1501–1515, 1612, 1644–1647, 1666–1676 | Leg `cleanups` (DD3) |
| F03 rec 3: record the in-process outbound path in the containment code | confirmed-live | no mention of `dependencies` or the lookup in `src/network/containment.ts` | Leg `cleanups` (DD3, a comment) |
| F01–F03 rec: slow unit files out of the default run | confirmed-live | `package.json` `"test": "vitest run"`, no vitest config file. `test/proxy-server.test.ts` (62 cases, ≈17 s). `test/docker.test.ts` real-shell describes at ≈1723 and ≈1925 (`execFileSync("/bin/sh", …)`). CI floor 867 (`.github/workflows/ci.yml`) | Leg `cleanups` (DD3) |
| Squawk 0054: `whileStopped` stop failure untested | confirmed-live | `src/sandbox/docker.ts:1698` `whileStopped` | Leg `cleanups` |
| Squawk 0055: dormant restart-after-swap fallback | confirmed-live | `src/network/containment.ts:137` `RESTART_AFTER_SWAP = false`, `:143` `restartAfterSwap`, `:763` `restartForSwap` | Leg `cleanups` |
| Squawk 0056: two statements on one line | confirmed-live | `test/docker-bypass.test.ts:282` holds both `expect(callers("this.startId"))…` and `expect(callers("this.execOnce"))…` | Leg `cleanups` |
| F03 rec 4: sample data shapes at planning | not applicable | this flight adds no check over third-party data | Carried to flight 5's planning |
| F02 rec 3: refused-registry backoff | out of scope | — | Stays a separate sortie candidate |
| Squawks 0049, 0051, 0052, 0053 | out of scope | other surfaces; 0053 needs the operator's OK to remove volumes | Stay open or deferred |

---

## Leg Progress

---

## Decisions

---

## Deviations

---

## Anomalies

---

### Flight Director Notes
- 2026-11-23, planning:
  - The mission's flight 4 was split with the operator. This flight is the groundwork plus the ownership fix; "checking what a build installed" is flight 5 (DD1).
  - The operator chose for old sandboxes: never touched, the operator removes them (DD4).
  - Bundled into `cleanups`: squawks 0054–0056, the withheld-tool accessor and the slow tests.
  - A short HAT is planned.
- 2026-11-23, design review:
  - The Architect (Sonnet) reviewed the flight: approve with changes, with 3 high and 5 medium issues, all adopted into the flight:
    - the README anchors outside the moved chapters, plus a link-resolution test;
    - the source-text tests that assume one file, made file-list aware in `cleanups`;
    - `SandboxRefusedError`'s constructor and a `before` reason;
    - the removal commands in `refusalMessage`;
    - the dead `VolumeNotUsableError` branches;
    - the reinstall wording, corrected: the old sandbox is left on fresh names, not a failure;
    - the slow-test route (vitest `projects`, real-shell cases into a file of their own);
    - the narrower lock extraction.
  - It recommended keeping the inheritance chain for DD5 and gave module boundaries, which are recorded in DD5.
  - No second review cycle: every change adopts the review's own recommendation or corrects a fact it cited, and no new decision was introduced.
