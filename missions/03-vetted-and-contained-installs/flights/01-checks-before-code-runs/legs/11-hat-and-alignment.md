# Leg: hat-and-alignment

**Status**: completed
**Flight**: [Checking a Project's Own Code Before It Runs](../flight.md)

## Objective
The operator, in their own client, sees and accepts what this flight does — with scanning off, with it on, with a scanner of their own, and when a reinstall is blocked — and decides the open items; issues found are fixed as they come.

## Context
- Interactive leg (operator opted in, 2026-11-21). The Flight Director guides one step at a time; a look-and-feel fix rides inline; anything that adds behavior goes through the fix-vs-feature gate (a scoped design review first).
- The operator's client is this Claude Code session; mcp-everything runs from this checkout's `dist/index.js` (local scope), so `npm run build` and a reconnect put the branch in front of it. Settings come from the server's environment in the client configuration.
- Open items for the operator: a scanners-file `entrypoint` key (the flight's `sh -c` wrapper advice could not work; leg 10); the deferred squawk 0051; anything the walk-through surfaces.
- The operator's existing projects (eleven sandboxes) are real; no step uninstalls or reinstalls one of them unless the operator chooses it.

## Acceptance Criteria (verification steps, one at a time)
- [x] 1. Built and reconnected: `npm run build`; the client reconnects mcp-everything; `check_project` appears in the tool list.
- [x] 2. Scanning off: the server's instructions carry the security paragraph (not scanned; network not contained; runtime); `project_info` of one existing project shows `security: not scanned at install; scanning is currently off`.
- [x] 3. `check_project` with scanning off, on a repository with npm lifecycle scripts: the commit, the `build-hooks` findings naming those scripts, "Installs are not scanned at present"; nothing installed or left behind.
- [x] 4. Scanning on with a scanner of the operator's: `MCPE_SCAN=warn` and `MCPE_SCANNERS` pointing at a file with one real scanner, set in the client configuration; reconnect; the instructions now say warn and name the scanner; `check_project` shows that scanner's outcome.
- [x] 5. A blocked reinstall: with `MCPE_SCAN=block` (and a threshold the chosen project reaches), reinstalling a throwaway project installed for the HAT is blocked; the project's tool still runs; its warning names the commit.
- [x] 6. Back to the operator's normal settings; reconnect; the instructions say what is set.
- [x] 7. Decisions recorded: the `entrypoint` key (now, later as a squawk or sortie, or not); squawk 0051; anything else raised.

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.

## Feature raised in the HAT: a scanner's `entrypoint` (operator, 2026-11-22: add it now)

Promoted through the fix-vs-feature gate: it adds behavior (a new key in the operator's scanners file), so it has this scope and a design review before implementation.

**Why.** A scanner's `command` is passed as arguments to the image's own entrypoint. A scanner that writes SARIF only to a file, needs a pre-step, or whose entrypoint prints to stdout, cannot be wrapped in a shell today; the README tells the operator to build a custom image. (Leg 10 found the flight's `sh -c` wrapper advice could not work.)

**Scope**
- [x] `ScannerSpec` gains optional `entrypoint?: string`; `parseScannersFile` accepts `entrypoint`: a string of at most 256 characters with no NUL; the empty string is allowed and means "clear the image's entrypoint" (`--entrypoint ""`); any other type is a `ConfigError` naming the entry and field, like the other fields. The unknown-key check knows the new key.
- [x] `runScanner` passes it to the one-shot method's `entrypoint` when defined (including the empty string), and passes none when absent — exactly today's arguments when absent.
- [x] Unit: the parser (absent, a value, empty, 257 characters, a number, NUL); `runScanner`'s `create` arguments with `--entrypoint sh`, with `--entrypoint ""`, and with no `--entrypoint` when absent.
- [x] Integration (gated before its first run; in the existing scanners describe through its `scanner()` helper, same guards), both on the pinned clone image `cfg.docker.probeImage` (entrypoint `git`, so each case proves something): (a) `"entrypoint": "sh"` with `command: ["-c", "printf '%s' '<SARIF>'"]` gives `ran` with the document's counts (an override replaces a real entrypoint); (b) `"entrypoint": ""` with `command: ["sh", "-c", "printf '%s' '<SARIF>'"]` gives `ran` (clearing works; without it, `git sh -c …` would fail).
- [x] *(Design review, 2026-11-22)*: `runOnce` already treats only `undefined` as absent, so `""` passes through as `--entrypoint ""`; the parser must return `""` unchanged and `runScanner` must pass `spec.entrypoint` straight through (never `||`); the key is absent from the parsed spec when not set; unit cases assert the argument pair and that the image follows it, and key absence with `in`; the README's "not exercised by this project's tests" wording changes to match.
- [x] README ("Adding a scanner"): the wrapper is done with `entrypoint` (an example: a scanner writing SARIF to a file, read back with `cat`); a custom image remains an alternative; the field is listed with the others. The README consistency test still passes.
- [x] Nothing else changes; the agent still cannot set or see scanner configuration beyond names.

**Not in scope**: environment or working-directory overrides, per-scanner mounts.

## Outcome (2026-11-22)
- Steps 1–7 passed with the operator. Found and fixed inline: the depth check's `-mindepth` disabled pruning (a false "incomplete" on nodemon); "blocked" said twice; the blocked-reinstall date unlabelled as UTC. Added through the feature gate: a scanner's `entrypoint`.
- Decisions (operator): no "no install-time scripts found" note; the client's mcp-everything left with scanning on (`MCPE_SCAN=on`, warn) and Trivy 0.76.2 pinned in `~/.config/mcp-everything/scanners.json`; the throwaway `unfurl` removed; the `entrypoint` key added now; squawk 0051 stays deferred.
- The HAT's changes reviewed together by a Reviewer: `[HANDOFF:confirmed]`, no issue. Unit suite 1511 passed, 37 skipped; Docker suite 35 passed, 2 skipped.
