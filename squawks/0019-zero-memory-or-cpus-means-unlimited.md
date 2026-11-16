# Squawk 0019: `MCPE_MEMORY=0` and `MCPE_CPUS=0` remove the sandbox limits

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-16

## Report
The memory and CPU limits are passed to `docker` exactly as the environment gives them. Docker reads `0` for either as no limit. The other numeric limits go through `int()`, where zero or less falls back to the default; these two are strings and skip it, so a zero turns a sandbox limit off without saying so. Only the operator can set them. Finding 11c of the [2026-11-15 maintenance report](../maintenance/2026-11-15.md).

Treat a value that Docker would read as unlimited the way `int()` treats zero: fall back to the default. Anything else is passed through as now.

## Evidence
- `src/config.ts:loadConfig` — `memory: env.MCPE_MEMORY || "4g",` and `cpus: env.MCPE_CPUS || "2",`; beside them `pidsLimit: int(env.MCPE_PIDS_LIMIT, 1024),`.
- `src/sandbox/docker.ts` — `"--memory", d.memory,` / `"--cpus", d.cpus,`.
- That Docker reads `0` as unlimited is from its documentation, not checked here.

## Corrective Action
`src/config.ts` gains a `limit()` helper used for `memory` and `cpus`: an unset, empty, or zero value (`0`, `0.0`, `00`, `.0`; for memory also with a unit suffix such as `0g`, `0m`, `0.0g`) yields the default (`4g`, `2`), the way `int()` treats zero. Every other string is passed through unchanged, with no new validation. The README row for the limits says a zero falls back to the default.

Review follow-up: the first pattern missed spellings Docker also reads as zero. `limit()` now uses two patterns (`ZERO_MEMORY`, `ZERO_CPUS`) built from one numeric-zero part: optional sign, zeros (with `_`), optional dot, or `.0`, optional exponent. Memory adds an optional single space and a unit `b`, or `k|m|g|t|p` with optional `i`+`b` / `b`, any case. CPUs add an optional `/<positive integer>` and `0x0`. Non-zero values (`8g`, `512m`, `0.5`, `0.5g`, `10g`, `100m`, `1e0`) and values Docker rejects (`0Gi`, `0/0`) pass through unchanged; there is still no validation.

## Verification
Docker's reading of zero was confirmed on throwaway containers (`mcpe-squawk0019-*`, `--network none`, local image, removed afterwards; none left): `--memory`/`--cpus` of `0 0`, `0g 0.0` and `0m 0.00` all inspected as `HostConfig.Memory=0`, `NanoCpus=0`, i.e. unlimited. `0.0g`, `00` and `.0` were not run; they are matched on the same numeric reading. `docker run --help` gives no statement.

Added cases to `test/config.test.ts` first; ten failed (the zero cases) before the fix. After: `npx vitest run --testTimeout 20000` gives 363 passed, 17 skipped (351 before); `npm run typecheck` clean.

Review follow-up, run against Docker (throwaway `mcpe-squawk0019-*` containers, `--network none`, local image, `docker create` then removed; none left). Read as zero (Memory=0 or NanoCpus=0): memory `0G`, `0 g`, `0GiB`, `0MiB`, `0gb`, `0.0g`, `00`, `.0`, `+0`, `-0`, `0e0`, `0_0`, `0k`, `0b`, `0tb`, `0.g`, `0 gb`, `0 GiB`, `0e0g`, `0.0e5m`; cpus `0e0`, `0/1`, `0/5`, `.0`, `00`, `-0`, `+0`, `0.0e5`, `0e-3`, `0x0`, `0x0p0`, `0_0`, `-0/1`. Rejected by Docker: memory `0Gi`, `0ib`, `0  g`, `0x0`; cpus `0/0`, `0/-1`, `0.0/3`, `0/1e0`, `"0 "`. Non-zero: memory `8g`, `0.5g`, `1.5g`; cpus `0.5`, `1.5`, `1e0`. Not run against Docker: `0x0p0` and `0_0` as cpus with other exponents or denominators beyond those listed, and `0 ` (trailing space) for memory. Added test cases for the newly caught spellings and for `0.5`, `0.5g`, `10g`, `100m` (plus `1e0`, `0Gi`, `0/0`) passing through. After: `npx vitest run --testTimeout 20000` gives 395 passed, 17 skipped; `npm run typecheck` clean.

Second review follow-up: the zero part `0[0_]*\.?0*` was ambiguous on a long run of zeros (both `0[0_]*` and the trailing `0*` can take them), so a failing match backtracked quadratically. It is now `0[0_]*(?:\.0*)?`, so the trailing zeros can only follow a dot; the other quantifiers (leading-dot `\.0+`, exponent, `/<int>`, optional space and unit) were checked and are not ambiguous. The set of matched strings is unchanged: all strings up to 7 characters over `0_.+-e1/xgbiK ` give identical results from the old and new patterns for both memory and cpus. Timing of `test()` on 100,000 zeros followed by `x`: before 6460 ms (memory) and 4817 ms (cpus), 10,000 zeros 65 ms and 49 ms; after 0 ms and 1 ms. 100,000 zeros alone is matched as zero (0 ms, before and after). A test in `test/config.test.ts` pins this with a 2000 ms bound (generous against ~0 ms, so slow machines do not flake). `npx vitest run --testTimeout 20000` and `npm run typecheck` results: 396 passed, 17 skipped (395 before); typecheck clean.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff
**Verdict**: confirmed after two fix cycles: the first review asked for the zero spellings to be measured against Docker (they were, and the rule widened to match); the second found the new patterns could backtrack quadratically on a very long value (fixed, with a test that pins it)
**Commit**: `squawk: turnaround 2026-11-16` (trailer `Squawks: 0008, 0009, 0010, 0011, 0012, 0014, 0015, 0016, 0017, 0018, 0019, 0020, 0021, 0022, 0023, 0024, 0025`) on branch `squawk/turnaround-2026-11-16`
