# Leg: extract-discovery

**Status**: completed
**Flight**: [Checking Dependencies and Tool Descriptions](../flight.md)

## Objective
Move discovery (`discover`, `foldAliases`, `discoverMcp` and the helpers only they use) out of `src/install/installer.ts` into a new `src/install/discovery.ts`, with no change in behavior, so that leg 3 can add `vetCatalog` at the end of discovery in a module of its own.

## Context
- Flight DD1: extract first, change after, as flight 01's DD9 did for `Installer.install`. Flight 01's debrief, recommendation 3.
- **Only the installer moves.** Nothing in `src/toolgen/` changes in this leg (leg 3 owns `buildToolsWithText`).
- `publish`, `reselect`, `rediscover`, `refreshMcp`, `connectMcp`, `disconnectMcp` stay in `Installer`; they keep calling a private `discover` that is now a thin call into the new module.
- Baseline (2026-11-23, on `4a0dd5e`): `npx vitest run` gives 2751 passed, 71 skipped, 0 failed (two runs). A first run had one failure under load (35.9 s instead of about 17 s) that did not repeat. It is logged as a flake.

## Inputs
- `src/install/installer.ts` as on `4a0dd5e`:
  - `discover` (≈1063);
  - `foldAliases` (≈1218);
  - `discoverMcp` (≈1259, to ≈1371, before `uninstall`);
  - helpers used by them: `COMMAND_NAME`, `COMMAND_PATH`, `MAX_COMMANDS`, `MAX_CATALOG`, `NO_EXECUTABLES`, `MCP_WARNING`, `MCP_PROBE_SEC`, `MAX_MCP_PROBES`, `parseJsonLine`, `strings`, `interface McpDiscovery`, `routeHint`.

## Outputs
- New `src/install/discovery.ts` holding the three functions and the helpers that only they use.
- `src/install/installer.ts` shorter by about 300 lines. `Installer.discover(record, sandbox, extraCommands)` keeps its signature and body of one call.

## Acceptance Criteria
- [ ] `src/install/discovery.ts` exports one entry point, e.g. `discover(ctx, record, sandbox, extraCommands): Promise<McpDiscovery>`.
  - `ctx` is an explicit, named interface (e.g. `DiscoveryContext`) carrying exactly what the code used through `this`: the config values read (`helpTimeoutSec` and any other `cfg` fields, so pass `cfg`), `proxy` (its `listTools`), `execFor`, `launchSpec`, and `publish`.
  - No `Installer` instance is passed in, and the module does not import `Installer`.
- [ ] `foldAliases` and `discoverMcp` are module functions in `discovery.ts`, not exported unless a test needs them (none does today).
- [ ] Constants and helpers:
  - those used only by discovery move to `discovery.ts`;
  - those also used by the installer (`MCP_WARNING`, `routeHint` and `COMMAND_NAME` if still referenced; check each with `grep`) are exported from `discovery.ts` and imported by `installer.ts`;
  - nothing is duplicated, and `TOOLS_WARNING` stays with `publish`.
- [ ] The behavior is unchanged:
  - the code is moved, not rewritten;
  - `this.x` becomes `ctx.x`, and nothing else changes in the bodies;
  - every comment moves with its code;
  - the order of Docker commands, catches and `checkAsked()` calls is identical.
- [ ] `npm run typecheck` is clean, and `npm run build` succeeds.
- [ ] `npx vitest run` gives 2751 passed, 71 skipped, 0 failed. No test file is edited (none reaches the moved private methods: `grep` of `test/` for `foldAliases|discoverMcp|as any).discover` finds only a test *title* in `test/server.test.ts:762`, a string, which stays).
- [ ] `test/docker-bypass.test.ts` (which reads source text for Docker call sites) still passes. If it lists files or callers by name and the move changes what it reads, update only its expected file or caller lists, and record that in the flight log.

## Verification Steps
- `git diff --stat`: only `src/install/installer.ts`, the new `src/install/discovery.ts`, and at most `test/docker-bypass.test.ts` (expected lists only), plus this flight's artifacts.
- `npm run typecheck && npm run build && npx vitest run` with the counts above.
- `grep -n "foldAliases\|discoverMcp\|PYTHON_DISCOVERY\|NODE_DISCOVERY" src/install/installer.ts` returns nothing.
- A side-by-side read of the moved bodies against `git show 4a0dd5e:src/install/installer.ts`: only `this.` → `ctx.` (and the import lines) differ.

## Implementation Guidance
1. Read `installer.ts` from `publish` (≈1056) to `uninstall` (≈1372) and every helper it uses. List each `this.` member used in that range; that list is the context interface.
2. Create `discovery.ts` with the imports those bodies need (from `../sandbox/docker.js`, `../toolgen/*`, `../proxy/*`, `./recipes.js` for `PYTHON_DISCOVERY`/`NODE_DISCOVERY`, `../util/text.js`, `../errors.js` and so on). Move the code.
3. In `Installer`:
   - `private async discover(record, sandbox, extraCommands)` returns `discover(this.discoveryContext(), record, sandbox, extraCommands)`, or builds the context once in the constructor if every member is stable;
   - `publish` is passed as a bound function;
   - imports that are no longer used are removed.
4. Run the typecheck, build and tests. Fix only import or visibility errors. Do not change logic.

## Edge Cases
- **`execFor`** returns a function bound to the sandbox; pass the method bound (`(s) => this.execFor(s)`).
- **`publish` mutates the record.** Keep it as a callback so that leg 3 can put `vetCatalog` next to it.
- **Error types used in `instanceof` checks** (`SandboxRefusedError`, `DockerUnavailableError`, `isUnusableValueError`) must be imported from the same modules, not re-declared.
- **A constant shared by both files** is exported from `discovery.ts` (the lower layer), never imported from `installer.ts` (no cycle).

## Files Affected
- `src/install/discovery.ts` — new.
- `src/install/installer.ts` — discovery removed; thin delegate.
- `test/docker-bypass.test.ts` — only if its expected lists name files or callers (see criteria).

## Citation Audit
Checked 2026-11-23 against `4a0dd5e`:
- `discover` at 1063, `foldAliases` at 1218, `discoverMcp` at 1259, `uninstall` at 1372 and `publish` at 1056 are present.
- The helper constants are at 140–209, and their uses were listed by `grep`.
- `test/server.test.ts:762` is a test title only.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
