# Flight Log: Checking Dependencies and Tool Descriptions

**Flight**: [Checking Dependencies and Tool Descriptions](flight.md)

## Summary
Planning. Premises measured 2026-11-23 against GitHub's dependency graph and OSV (see the flight's Open Questions).

---

## Reconnaissance Report
Items carried from flight 01's and flight 02's debriefs that touch this flight, checked against `main` at `84982b9` on 2026-11-23.

| Item | Classification | Evidence | Recommendation |
|---|---|---|---|
| F01 rec 3: pull discovery out of `installer.ts` before adding stages | confirmed-live | `src/install/installer.ts:1063` `discover`, `:1218` `foldAliases`, `:1259` `discoverMcp` | Leg `extract-discovery` |
| F01 action: the pre-clone dependency check on its own call path | confirmed-live | `checkClone` (`installer.ts:322`) runs `build-hooks` and scanners only | Leg `dependency-check` (DD2) |
| F01 action: findings across stages in one `scan` record | partially-satisfied | `ProjectRecord.scan` holds one `ScanReport` (`src/types.ts:156`) | `dependencies` joins it; tool checks go to `toolCheck` (DD7: different lifetime) |
| F02 rec 1: the `before` ownership class | confirmed-live | not in this flight's surface | Flight 4 (operator, 2026-11-23) |
| F02 rec 2: split `docker.ts` / `containment.ts` | confirmed-live | `src/sandbox/docker.ts` 2895 lines | Flight 4 (this flight does not touch them) |

---

## Leg Progress

---

## Decisions

---

## Anomalies

---

## Flight Director Notes
- 2026-11-23: Mission flight 3 split at the operator's agreement into this flight (in-process checks) and flight 4 (build output onto a volume, post-build stage, preceded by the `docker.ts` split and the `before` ownership fix).
- 2026-11-23, **design review 1** (Architect, Sonnet): approve with changes. Four highs, all folded in. I checked each against the code before accepting it.
  1. The check in `publish` would be undone by `reselect`: `installer.ts:1048` calls `publish` on the stored, already-filtered catalog. Now `vetCatalog` runs at the end of `discover`, and `reselect` calls `publish` only (DD6).
  2. Removal alone made three surfaces misreport. `findGenerated` (`server.ts:787`) would answer "Unknown tool"; `refresh_mcp` and `connect_mcp_server` would count wrongly. All three now read `toolCheck.withheld` (DD7).
  3. At `MCPE_SCAN_BLOCK_AT=note`, `decide()` counts a check's notes (`policy.ts` `countAtOrAbove`). Pinned-ref findings at note and the "what was sent" statement would have counted. Now a pinned ref is `not-run`, and the sent-statement is rendered by the formatter (DD2, DD9).
  4. `unreachableBlock` (`policy.ts`) says the built-in check never reports above warning. Rewritten in leg 2 (DD9).

  Mediums folded in:
  - No matched text is quoted back to the agent.
  - The check reads only text that came from the project, not the `tag()` prefix, plus `mcp.tool` and `argv`.
  - Bidirectional isolates and ZWNJ are warnings; credential words need a verb in the same sentence; tool names are matched as whole words.
  - The freshness contract is stated.
  - The test default for the lookup is injected, so the unit suite never reaches the network; `readme.test.ts` is updated with the README.
  - Withheld entries are keyed by upstream identity.

  Lows folded in:
  - The lookup runs concurrently with the clone.
  - The HTTP helper has a byte cap and refuses redirects; the token goes to GitHub only.
  - DD1's extraction takes an explicit context object.

  A second review is warranted because DD6 and DD7 changed shape.
- 2026-11-23, **design review 2** (Architect, Sonnet): approve with changes. No high issues; the first round's highs are resolved without contradiction. Mediums folded in:
  - **DD4: the lookup is inert unless injected.** `test/helpers.ts` builds neither `Installer` nor `App`. Both now default to an inert lookup; the real client is wired only in `index.ts`, and a test pins that.
  - **DD2/DD4: `CheckOutcome.contacted`.** The sent-statement is keyed on the services actually called, not on the outcome's status.
  - **DD2: concurrency.** The catch is attached when the promise is created; an `AbortController` stops the calls when the clone fails; whether the lookup runs is an explicit `checkClone` argument.
  - **DD7: `refresh_mcp`'s `bare` count** is withheld-aware too.
  - **DD9:** `unreachableBlock` becomes informational; the README warns about block at `warning` and at `note`.

  On Q3, stripping the description is not exact (`oneLine`, truncation, interleaved CLI template text). The project's text is now carried transiently through `buildToolsWithText`, with no change to the record's shape (DD5).

  The review cycles are at the maximum of two, and no high issue remains, so there is no third review. Spec presented to the operator.
