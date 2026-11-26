# Squawk 0068: The gVisor workflow never runs unless a sandbox, network or install change lands

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-25
**Completed**: 2026-11-25 (squawk turnaround 2026-11-25)

## Report
`docker-gvisor.yml` runs only by hand, or on a pull request touching `src/sandbox`, `src/network`, `src/install`, `test/integration` or `package-lock.json`. Drift in the runner's Docker, in gVisor's download, or in a base image goes unseen until such a change lands. Mission 03's debrief decided on a weekly run. Whether the job becomes a required check is the operator's separate call, and is not part of this squawk.

## Evidence
- `.github/workflows/docker-gvisor.yml:15-25`: `on:` has `workflow_dispatch` and a path-filtered `pull_request` only.
- `missions/03-vetted-and-contained-installs/mission-debrief.md`, Decisions: "the gVisor CI job, scheduled weekly".

## Corrective Action
`.github/workflows/docker-gvisor.yml`, `on:`: added `schedule: - cron: "17 4 * * 1"` (Mondays 04:17 UTC) with a comment, and the "Advisory" comment now says "runs on demand, weekly, or for ...". Whether the job becomes a required check is untouched.

## Verification
The YAML parses and `on` has `workflow_dispatch`, `schedule`, `pull_request`. A grep for `github.event`, `head_ref`, `base_ref` and `pull_request` in the workflow finds only the `on:` trigger; the `if:` conditions use `hashFiles`, `always()` and `!cancelled()`, all valid on a schedule event. The `concurrency` group uses `github.ref`, which is the default branch on a schedule. The first scheduled run is to be observed after merge (scheduled workflows run only from the default branch).

## Sign-Off
Reviewer (Sonnet), 2026-11-25: `[HANDOFF:confirmed]` for the batch; it checked that nothing in docker-gvisor.yml depends on a pull_request event, so the schedule trigger is safe. The first scheduled run is observed after merge.

## Disposition
Logged at the routine maintenance of 2026-11-25, from mission 03's debrief.
