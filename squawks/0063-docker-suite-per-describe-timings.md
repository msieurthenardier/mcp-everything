# Squawk 0063: The Docker suite does not say what each describe costs

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-25
**Completed**: —

## Report
`npm run test:docker` reports one total wall time. Across mission 03 the suite went from about 280 s (flight 1) to 670–724 s (flight 4), then to 801 s after flight 5's leg 1 and 1258 s after its legs 2–3. Nothing separates a new case's cost from drift (Docker Desktop's cache, registries, the network), so a debrief can only guess at a slowdown's cause.

## Evidence
- `package.json:29`: `"test:docker": "MCPE_DOCKER_TESTS=1 vitest run test/integration"` uses the default reporter, which prints no per-describe time.
- `test/integration/docker.test.ts` has 17 top-level `describe`s; flight 5 added one ("the check after the build", two real gron installs).
- Mission 03 flight 05's debrief, Recommendation 3: leg 1's step of about +80–130 s has no clear cause in the diff.

## Corrective Action
*(to be filled in on completion)*: make the Docker run print each top-level describe's wall time, for example with a reporter option on `test:docker` (vitest's `verbose` reporter prints per-test durations) or a small `afterAll` timing line per describe. Keep the unit runs' output unchanged.

## Verification
*(to be filled in on completion)*: run `npm run test:docker` and check that each describe's time appears in the output; the Flight Director diffs Docker object lists around the run as usual.

## Sign-Off
*(to be filled in on completion)*

## Disposition
Logged at mission 03 flight 05's debrief. Carry it to the next squawk turnaround.
