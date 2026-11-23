# Squawk 0057: A contained network create that loses the subnet race is not retried on Docker 29

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-23
**Completed**: 2026-11-23

## Report
Containment picks a free subnet by probing, then creates the network with it. When another network takes that subnet in between, the create is supposed to retry with a fresh probe (`POOL_RETRIES`).

On Docker 29.8 the refusal is worded "cannot create network … conflicts with network … (overlapping)". The retry pattern matches only "pool overlaps", so the create fails instead of retrying. It was seen once in mission 03 flight 03's Docker-suite run, and the case passed when run alone.

## Evidence
- `src/sandbox/docker.ts:710`: `const POOL_OVERLAPS = /pool overlaps/i;`. It is used at `:1514`: `if (created.code !== 0 && !created.timedOut && POOL_OVERLAPS.test(created.stderr) && attempt < POOL_RETRIES) continue;`.
- Docker suite, 2026-11-23 (Docker 29.8.2). The failing case was `docker integration: containment hook (leg 7) > two contained projects cannot reach each other…` (`test/integration/docker.test.ts:2266`), with: `ContainmentUnavailableError: Could not create the contained network: Error response from daemon: cannot create network b51a5425… (br-b51a54256690): conflicts with network 8efd919d…`.
  - The other network was transient: it was not among the operator's networks, and it was gone afterwards.
  - The case passed alone on a rerun.

## Corrective Action
Widened `POOL_OVERLAPS` in `src/sandbox/docker.ts` to `/pool overlaps|conflicts with network/i`, so Docker 29's "cannot create network ...: conflicts with network ..." refusal is retried with a fresh probe like the older "Pool overlaps" wording. The comment above it names both wordings. The retry logic is unchanged. The wording was taken from the observed text in this squawk's evidence, not re-checked against a daemon (no `docker` commands were run, to leave the operator's objects alone); "conflicts with network" is the stable fragment.

In `test/docker.test.ts`, the fake daemon gained an `overlapStderr` field (defaulting to the old text) so a case can choose the refusal wording, and a new case uses Docker 29's text.

## Verification
A unit case in `test/docker.test.ts` with Docker 29's stderr retries, with a fresh probe, and succeeds on the next attempt. The existing "pool overlaps" case still passes.

- New case "on Docker 29's 'conflicts with network' refusal probes again and retries" with the regex temporarily reverted to `/pool overlaps/i`: failed with `ContainmentUnavailableError: Could not create the contained network: ... conflicts with network ...`. Regex restored afterwards.
- `npm run typecheck`: clean.
- `npx vitest run test/docker.test.ts`: 726 passed (726), including the new case and the existing "on 'Pool overlaps' probes again and retries, up to three times".
- The Docker integration suite was not run.

## Sign-Off
**Reviewer**: Reviewer crew agent (Sonnet), batch review of 0057–0060
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-23` on branch `squawk/turnaround-2026-11-23`

## Disposition
**Deferred**: found mid-flight in mission 03 flight 03, outside that flight's surface, which does not touch `src/sandbox` or `src/network`. Revisit at the next turnaround, or in flight 4's mechanical split of `docker.ts`, whichever comes first.
