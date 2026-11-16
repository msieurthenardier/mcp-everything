# Squawk 0006: The shell versions the fork guard was measured on are not recorded

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-15
**Completed**: 2026-11-15

## Report
The watchdog's fork guard relies on one POSIX rule (`command eval` does not abort the shell on an error) as implemented by the two shells it was measured on. Both come from floating image tags, so "what was tested" will silently stop being true as those tags move, and nothing in the repository says which versions the measurements were taken on. Raised in the sortie 02 debrief (Recommendation 3).

Record the versions where a maintainer of the script will find them: beside the watchdog script or in the README's idle-stopping note. Documentation only.

## Evidence
Read from the local images on 2026-11-15, the same ones the sortie 02 measurements and acceptance runs used:
- `buildpack-deps:stable` — Debian GNU/Linux 13 (trixie), `dash 0.5.12-12`, digest `buildpack-deps@sha256:188a9dfa5e813c917be00c3f474bc75488b62914305e13fa21dff1cfef2eb354`
- `alpine/git:latest` — Alpine Linux v3.24, `BusyBox v1.37.0`, digest `alpine/git@sha256:2306e2b05ee0ef99f5d25b0779f645b24ae9f91ba187107503592fcdfe78da3a`
- `src/config.ts` — `const generic = "buildpack-deps:stable"`; `probeImage: env.MCPE_PROBE_IMAGE || "alpine/git:latest"`
- No occurrence of `0.5.12` or `1.37` in `src/`, `test/` or `README.md`

## Corrective Action
Added four `//` lines at the end of the comment block above `WATCHDOG_SCRIPT` in `src/sandbox/docker.ts`, after squawk 0004's lines, recording that the guard was measured on dash 0.5.12 (Debian 13, `buildpack-deps:stable`) and BusyBox 1.37.0 `sh` (Alpine 3.24, `alpine/git:latest`) in November 2026, and that both tags float. Comments only; no script, config, test or README change.

## Verification
Diff of `src/sandbox/docker.ts` shows only added `//` lines above `const WATCHDOG_SCRIPT`; versions match the evidence; `npm test`: 270 passed, 14 skipped; `npm run typecheck`: clean. No Docker run. Expected: the recorded versions match the evidence above; no source behavior changes.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff
**Verdict**: confirmed against the recorded evidence; not re-measured
**Commit**: `squawk: turnaround 2026-11-15` (trailer `Squawks: 0004, 0005, 0006`) on branch `squawk/turnaround-2026-11-15-2`
