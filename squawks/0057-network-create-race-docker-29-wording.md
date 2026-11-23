# Squawk 0057: A contained network create that loses the subnet race is not retried on Docker 29

**Status**: deferred
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-23
**Completed**: —

## Report
Containment picks a free subnet by probing, then creates the network with it. When another network takes that subnet in between, the create is supposed to retry with a fresh probe (`POOL_RETRIES`).

On Docker 29.8 the refusal is worded "cannot create network … conflicts with network … (overlapping)". The retry pattern matches only "pool overlaps", so the create fails instead of retrying. It was seen once in mission 03 flight 03's Docker-suite run, and the case passed when run alone.

## Evidence
- `src/sandbox/docker.ts:710`: `const POOL_OVERLAPS = /pool overlaps/i;`. It is used at `:1514`: `if (created.code !== 0 && !created.timedOut && POOL_OVERLAPS.test(created.stderr) && attempt < POOL_RETRIES) continue;`.
- Docker suite, 2026-11-23 (Docker 29.8.2). The failing case was `docker integration: containment hook (leg 7) > two contained projects cannot reach each other…` (`test/integration/docker.test.ts:2266`), with: `ContainmentUnavailableError: Could not create the contained network: Error response from daemon: cannot create network b51a5425… (br-b51a54256690): conflicts with network 8efd919d…`.
  - The other network was transient: it was not among the operator's networks, and it was gone afterwards.
  - The case passed alone on a rerun.

## Corrective Action
*(written at completion)* Widen `POOL_OVERLAPS` to also match Docker 29's wording, for example `/pool overlaps|conflicts with network/i`. Check the exact text against the daemon first: `docker network create --subnet <a subnet in use> x`. Add a unit case giving the new stderr to the retry path.

## Verification
A unit case in `test/docker.test.ts` with Docker 29's stderr retries, with a fresh probe, and succeeds on the next attempt. The existing "pool overlaps" case still passes.

## Sign-Off
*(written at completion)*

## Disposition
**Deferred**: found mid-flight in mission 03 flight 03, outside that flight's surface, which does not touch `src/sandbox` or `src/network`. Revisit at the next turnaround, or in flight 4's mechanical split of `docker.ts`, whichever comes first.
