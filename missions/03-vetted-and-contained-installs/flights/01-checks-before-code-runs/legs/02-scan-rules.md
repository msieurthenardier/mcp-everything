# Leg: scan-rules

**Status**: completed
**Flight**: [Checking a Project's Own Code Before It Runs](../flight.md)

## Objective
Add the scanning configuration, the shared scan types, and the pure rules an operator's scanner is judged by — the scanner file's validation, SARIF parsing with cleaning and bounds, and the policy — as unit-tested functions that nothing calls yet.

## Context
- Flight DD1 (switches), DD2 (scanner file), DD3 (findings and cleaning), DD4 (policy), DD5 (built-in check: report and red flags). This leg implements the parts of DD1–DD4 that need no Docker, and the types every later leg shares. The built-in check's analysis (DD5) is leg 3 (`build-hooks`), split out at this leg's design review; leg 4 walks the clone; leg 5 runs scanners and feeds their stdout to this leg's parser; leg 6 wires the whole into the install.
- Everything a scanner prints and everything in a repository's files is hostile input that reaches the agent. Cleaning and bounds are the security property of this leg.
- Operator decisions (2026-11-21): `on` means `warn`; the built-in check lists what runs plus a few red flags, never above `warning`; a failed check never blocks.
- Existing helpers: `cleanTerminalText` and `oneLine` in `src/util/text.ts`; `ConfigError` in `src/errors.ts` (printed without a stack by `formatFatal`); `loadConfig(env)` in `src/config.ts`, tested in `test/config.test.ts` by passing an env object.

## Inputs
- Leg 1 may be in progress on `src/install/installer.ts`; this leg does not touch that file.
- `src/config.ts` — `Config`, `loadConfig(env)`, `int()`, `parseHosts`, `parseNamePrefix` (the strict pattern this leg follows).
- `src/types.ts` — `Ecosystem`.

## Outputs
- `src/config.ts` — `Config.scan` (below) parsed from `MCPE_SCAN`, `MCPE_SCAN_BLOCK_AT`, `MCPE_SCAN_TIMEOUT`, `MCPE_SCANNERS`.
- `src/scan/types.ts` — the shared types.
- `src/scan/scanners-file.ts` — validation of the scanner file's text.
- `src/scan/sarif.ts` — SARIF to bounded, cleaned findings.
- `src/scan/policy.ts` — the decision and the "unreachable threshold" statement.
- Unit tests for each, in new files `test/scan-*.test.ts`, plus new cases in `test/config.test.ts`.

## Acceptance Criteria

**Types** (`src/scan/types.ts`), used unchanged by later legs:
- [ ] `Level = "error" | "warning" | "note"`; `LEVELS` (highest first) and `levelAtLeast(a, b)`.
- [ ] `ScannerSpec { name: string; image: string; command: string[]; network: boolean; timeoutSec: number; env: string[] }` lives here, so later legs import every shared type from one place.
- [ ] `Finding { check: string; ruleId: string; level: Level; message: string; location?: string; securitySeverity?: string }`.
- [ ] `CheckOutcome { name: string; kind: "builtin" | "scanner"; status: "ran" | "failed" | "incomplete" | "not-run"; counts: Record<Level, number>; findings: Finding[]; omitted: number; notes: string[]; error?: string }`. `notes` holds statements that are not findings and never count for the policy (for example "dependencies' build code is not listed").
- [ ] `BuildFile { path: string; content: string; truncated?: boolean }` and `BuildWalk { files: BuildFile[]; incomplete?: string; skippedLinks?: string[] }` — the shape leg 4's walk produces and leg 3's analysis reads (`truncated` when the file was cut at the walk's per-file cap; `incomplete` says why the walk stopped short, when it did; `skippedLinks` lists build files skipped because they are symbolic links — added at leg 3's design review).
- [ ] `ScanDecision { mode: "off" | "warn" | "block"; blockAt: Level; verdict: "build" | "block"; reason: string }` and `ScanReport { commit: string; checks: CheckOutcome[]; decision: ScanDecision; at: string }` (ISO time).

**Configuration** (`Config.scan: { mode: "off" | "warn" | "block"; blockAt: Level; timeoutSec: number; scanners: ScannerSpec[]; scannersFile?: string }`; `blockAt` is the configured value, default `error`, whatever the mode):
- [ ] `MCPE_SCAN` unset or empty → `off`; `off`, `on`, `warn`, `block` accepted, trimmed and case-insensitive; `on` → `warn`. Anything else is a `ConfigError` naming the variable and the accepted values.
- [ ] `MCPE_SCAN_BLOCK_AT` unset or empty → `error`; `error`, `warning`, `note` accepted, trimmed and case-insensitive. Set (non-empty) while the mode is not `block` → `ConfigError` saying it has effect only with `MCPE_SCAN=block`. Invalid value → `ConfigError`.
- [ ] `MCPE_SCAN_TIMEOUT` unset or empty → 900; a value matching `^[0-9]+$` from 60 to 3600 accepted; anything else (including `0`, `abc`, `1.5`, `45abc`) → `ConfigError`. Strict on purpose, unlike the older numeric settings (flight DD1).
- [ ] `MCPE_SCANNERS` unset or empty → no scanners. Set → the path must be a regular file of at most 1 MB (checked with `stat` before reading, so a FIFO or `/dev/zero` cannot hang startup); it is read once and validated (below); not a regular file, too large, unreadable or invalid → `ConfigError` naming the file and the first problem. Allowed with `MCPE_SCAN=off` (the check tool uses it). `loadConfig` gains an optional second parameter for reading a file (default `fs.readFileSync(path, "utf8")`), so tests pass text without touching the file system.
- [ ] Existing settings and their tests are unchanged.

**Scanner file** (`parseScannersFile(text: string, source: string): ScannerSpec[]`, throwing `ConfigError`):
- [ ] Valid JSON object with exactly the key `scanners`, an array (may be empty) of at most 16 entries.
- [ ] Each entry: `name` matching `^[a-z0-9][a-z0-9-]{0,31}$`, unique, and not `build-hooks` (reserved for the built-in); `image` a non-empty string matching the image-reference pattern `install_project` uses (`/^[a-z0-9][a-z0-9._/:@-]{0,200}$/i`); `command` a non-empty array of at most 64 strings, each at most 4096 characters, none containing a NUL; `network` boolean, default `false`; `timeout_seconds` integer 10–1800, default 300; `env` array of names matching `^[A-Za-z_][A-Za-z0-9_]{0,127}$`, default `[]`; `stage` optional and only `"source"`. Any other key → error, checked with own keys (`Object.keys`), so `__proto__` and friends are unknown keys, not inherited ones.
- [ ] Errors name the entry (index and name if known) and the field.

**SARIF** (`parseSarif(stdout: string, check: string): { ok: true; counts; findings; omitted; notes: string[] } | { ok: false; reason: string }`):
- [ ] Not JSON, not an object, `version` other than `"2.1.0"`, or `runs` not an array → `ok: false` with a short fixed reason. Never the input text, and never `JSON.parse`'s error message, which quotes the input (a test feeds invalid JSON containing an escape sequence and asserts the reason does not contain it).
- [ ] Which results count: every result of every run, except those with `kind` `pass`, `notApplicable` or `informational`, and those with a `suppressions` entry whose `status` is not `rejected`; skipped results are counted in a note ("N results were suppressed or not failures and were not counted").
- [ ] Level: the result's `level`; else the rule's `defaultConfiguration.level`, the rule found by `ruleIndex` into `run.tool.driver.rules`, else by `ruleId` through a map built once per run (not a scan per result); else `warning` (SARIF's default). `none` is not counted. **A level SARIF does not define** (for example `"critical"`) is counted as `warning`, never dropped, with a note saying how many were — failing toward reporting, not toward clean.
- [ ] Each kept finding: `ruleId` (or `"(no rule id)"`), cleaned with `oneLine` to 80 characters; `message.text` (or `message.markdown`, or `"(no message)"`) to 200; location from `locations[0].physicalLocation.artifactLocation.uri` and `.region.startLine` (a positive integer; anything else is ignored), as `uri:line` or `uri` alone, to 120; `properties["security-severity"]` when a string or number, to 16.
- [ ] `counts` are exact. `findings` holds at most 20, sorted by level (highest first), then in input order; `omitted` is the number not kept. **Only kept findings are cleaned**: the parser keeps the first 20 per level in input order (three buckets) while counting everything, slices each raw string to four times its cap before `oneLine`, and never builds or sorts a list of every result.
- [ ] Malformed members (a result that is not an object, a non-string message, a `locations` that is not an array) are skipped or defaulted, never thrown on. Input of 8 MB (including 8 MB made of about four million empty results) parses within a generous time bound (asserted as under 3 s, or as a ratio against a small input, so the hosted check does not flake).
- [ ] A string containing escape sequences, control characters or newlines comes out as one clean line (a test feeds `"\u001b[31mred\u001b[0m\nline2\u0007"`).

**Policy** (`decide(mode, blockAt, checks): ScanDecision`, `unreachableBlock(blockAt, scanners): string | undefined`):
- [ ] `warn` → verdict `build`, reason states the counts at each level across checks that ran or were incomplete.
- [ ] `ScanDecision.blockAt` is the configured value under every mode.
- [ ] `block` → `block` when any check with status `ran` or `incomplete` has a count at or above `blockAt` (with `blockAt` `note`, the built-in check's notes count too: every project with a lifecycle script blocks; the README will say so); reason names the level and the checks ("blocked: 2 findings at error or above, from trivy"). Otherwise `build`. Checks with status `failed` or `not-run` never count; the reason lists them ("trivy failed and was not counted").
- [ ] `off` → verdict `build`, reason "scanning is off" (used by the check tool's "what an install would do").
- [ ] `unreachableBlock` returns a sentence when the mode is `block`, `blockAt` is `error`, and there are no operator scanners (the built-in never reports `error`); otherwise `undefined`. The sentence is reused verbatim by the startup log and the server instructions (leg 7).
- [ ] `emptyCounts()` and `totalCounts(checks)` are exported for later legs (a `failed` or `not-run` outcome, `describe()`).

**General**
- [ ] Nothing outside `src/scan/`, `src/config.ts` and new or existing test files changes; there is no `src/scan/build-hooks.ts` yet (leg 3). Nothing in `src/` imports `src/scan/` yet except `src/config.ts` (for the types it needs).
- [ ] `npx vitest run` passes: the flight-start 950 plus this leg's new cases (and leg 1's, if it has landed by then, which adds none), 24 skipped. `npm run typecheck` clean; `npm run build` succeeds.

## Verification Steps
- `npx vitest run test/config.test.ts test/scan-*.test.ts`, then the whole suite.
- `npm run typecheck`; `npm run build`.
- `grep -rn "src/scan\|/scan/" src --include=*.ts | grep import` shows only `src/config.ts` and files inside `src/scan/`.
- Trials (make each change, run the relevant test file, confirm a failure, undo by editing; compare `git diff -- src` with a copy saved before the trials, since leg 1's work in `src/install/installer.ts` may be in the tree too): (1) in `parseSarif`, stop cleaning the message; (2) count `none` as `note`; (3) in `decide`, count a `failed` check; (4) drop results with an undefined level instead of counting them as `warning`; (5) let `MCPE_SCAN_BLOCK_AT` be set under `warn`; (6) take the 20-finding cap off; (7) use `JSON.parse`'s message as the failure reason. Report each outcome.

## Implementation Guidance

1. **Types first** (`src/scan/types.ts`), exactly as in the criteria; later legs depend on these names.

2. **Configuration.** Add `scan` to `Config` and parse it in `loadConfig` with small strict helpers beside `parseNamePrefix`. Read the scanners file through the injected reader; wrap `JSON.parse` and reader errors in `ConfigError` with the path. Keep the scanner-file validation in `src/scan/scanners-file.ts` and call it from `config.ts`.

3. **SARIF.** Walk defensively: treat every property as `unknown` and check its type. Count every result; keep the first 20 per level in three buckets; at the end take error, then warning, then note bucket entries up to 20 in all. Clean only those, once, after pre-slicing.

4. **Policy.** Small and table-tested: every combination of mode × blockAt × (a check at each level, failed, not-run, incomplete).

5. **Hostile-input bounds** for the parser: test adversarial shapes (deeply nested JSON, a 1 MB message string, four million results) and keep every pass linear.

## Edge Cases
- **SARIF with `runs: []`** → `ok: true`, all counts zero.
- **A rule found by `ruleIndex` out of range** → fall back to `ruleId`, then `warning`.

## Files Affected
- `src/config.ts` — `Config.scan`, parsing.
- `src/scan/types.ts`, `src/scan/scanners-file.ts`, `src/scan/sarif.ts`, `src/scan/policy.ts` — new.
- `test/config.test.ts` — new cases only.
- `test/scan-scanners-file.test.ts`, `test/scan-sarif.test.ts`, `test/scan-policy.test.ts` — new.

## Citation Audit
Checked by the Flight Director against the working tree on branch `flight/01-checks-before-code-runs`: `loadConfig(env: NodeJS.ProcessEnv = process.env): Config` in `src/config.ts`; `parseNamePrefix` throws `ConfigError` on an invalid value; `cleanTerminalText` and `oneLine(text, max)` in `src/util/text.ts`; `ConfigError` and `formatFatal` (no stack for a `ConfigError`) in `src/errors.ts` — so the flight's note that a startup error prints a stack trace until squawk 0027 is fixed is out of date; `Ecosystem` in `src/types.ts`; the image pattern `/^[a-z0-9][a-z0-9._/:@-]{0,200}$/i` in the `install_project` handler of `src/server.ts`; the node recipe runs the install and then `$run build` only when the root `package.json` has a `build` script; the go recipe falls back to `make` only when every `go install` failed and `/opt/mcpe/bin` is empty. `smol-toml` is in `package.json` dependencies. Developer design review (2026-11-22) confirmed: the image pattern at `src/server.ts:742`; `parseNamePrefix` at `src/config.ts:144`; no `Config` is built by hand anywhere (every caller uses `loadConfig`), so adding `scan` and an optional second parameter breaks nothing.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
