# Squawk 0024: The README omits four environment variables the configuration reads

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-16

## Report
The README's configuration table lists the `MCPE_*` variables and their defaults, and every default it gives matches the code. Four variables that `loadConfig` reads are not in it. Finding 17 of the [2026-11-15 maintenance report](../maintenance/2026-11-15.md).

Add them to the table with their defaults and one line each. Documentation only.

## Evidence
- `src/config.ts:loadConfig` — `helpTimeoutSec: int(env.MCPE_HELP_TIMEOUT, 10)`; `probeImage: env.MCPE_PROBE_IMAGE || "alpine/git:latest"`; `bin: env.MCPE_DOCKER_BIN || "docker"`; `const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")`.
- Run on 2026-11-16: `grep -c` of `README.md` for `MCPE_HELP_TIMEOUT`, `MCPE_PROBE_IMAGE`, `MCPE_DOCKER_BIN` and `XDG_DATA_HOME` gives 0 for each.
- Squawk 0009 already cites `MCPE_HELP_TIMEOUT` and its default of 10 from the code.

## Corrective Action
Added four rows/mentions to the README configuration table: `MCPE_DOCKER_BIN` (default `docker`, host-side client command) and the `XDG_DATA_HOME` default on the `MCPE_DATA_DIR` row; `MCPE_PROBE_IMAGE` (default `alpine/git:latest`, image of the clone/probe container); `MCPE_HELP_TIMEOUT` (default 10, one `--help` call in discovery). Descriptions checked against `src/sandbox/docker.ts` and `src/toolgen/discover.ts`. Documentation only; earlier rows left as they were.

## Verification
`grep -c` of README.md for each of the four names is now non-zero; each default matches `src/config.ts`. `npx vitest run --testTimeout 20000` and `npm run typecheck` results: 366 passed, 17 skipped; typecheck clean.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-16` (trailer `Squawks: 0008, 0009, 0010, 0011, 0012, 0014, 0015, 0016, 0017, 0018, 0019, 0020, 0021, 0022, 0023, 0024, 0025`) on branch `squawk/turnaround-2026-11-16`
