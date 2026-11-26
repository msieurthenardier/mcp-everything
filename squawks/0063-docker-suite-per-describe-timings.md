# Squawk 0063: The Docker suite does not say what each describe costs

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-25
**Completed**: 2026-11-25 (squawk turnaround 2026-11-25)

## Report
`npm run test:docker` reports one total wall time. Across mission 03 the suite went from about 280 s (flight 1) to 670–724 s (flight 4), then to 801 s after flight 5's leg 1 and 1258 s after its legs 2–3. Nothing separates a new case's cost from drift (Docker Desktop's cache, registries, the network), so a debrief can only guess at a slowdown's cause.

## Evidence
- `package.json:29`: `"test:docker": "MCPE_DOCKER_TESTS=1 vitest run test/integration"` uses the default reporter, which prints no per-describe time.
- `test/integration/docker.test.ts` has 17 top-level `describe`s; flight 5 added one ("the check after the build", two real gron installs).
- Mission 03 flight 05's debrief, Recommendation 3: leg 1's step of about +80–130 s has no clear cause in the diff.

## Corrective Action
`package.json`: `test:docker` and `test:docker:pressure` now pass `--reporter=verbose` (vitest 5.1.0), which prints one line per test with its duration, so a describe's cost is the sum of its lines. Unit runs (`npm test`, `test:slow`) are unchanged. This gives per-test, not a per-describe total line; a describe-level total would need a timing hook in `test/integration/docker.test.ts`, left out as the smallest change.

## Verification
Confirmed on a unit file that `--reporter=verbose` prints lines like `✓ |default| test/scan-sarif.test.ts > ... 3763ms`. Docker was not run. The Flight Director runs `npm run test:docker` and checks the durations appear.

## Sign-Off
Reviewer (Sonnet), 2026-11-25: `[HANDOFF:confirmed]` for the batch, scoped to the diff, with mutation trials (0051, 0067, 0061 and 0049 each made a test fail). Unit: 3,076 passed (both projects). Docker suite: 67 passed, 5 skipped, 0 failed (1,665 s), run by the Flight Director, with object lists unchanged apart from another tool's transient containers.

## Disposition
Logged at mission 03 flight 05's debrief. Carry it to the next squawk turnaround.
