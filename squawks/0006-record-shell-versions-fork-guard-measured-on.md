# Squawk 0006: The shell versions the fork guard was measured on are not recorded

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-15
**Completed**: —

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
*(written at completion)*

## Verification
*(written at completion)* Expected: the recorded versions match the evidence above; no source behavior changes.

## Sign-Off
*(written at completion)*
**Reviewer**:
**Verdict**:
**Commit**:
