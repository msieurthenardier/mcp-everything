# Squawk 0020: An unused `env` option on `Docker.exec` would put values on the command line

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-16

## Report
`ExecOptions` has an `env` field, and `Docker.execOnce` turns each entry into `-e NAME=value` in the `docker exec` command line, where any process on the host can read it with `ps`. Nothing passes the field today. It is a trap for the next change: the proxy takes care to keep values out of argv by using an env file, and this option would undo that for whoever reaches for it. Finding 11d of the [2026-11-15 maintenance report](../maintenance/2026-11-15.md).

Remove the field and the loop that reads it. If a caller turns up after all, stop: a caller that needs variables needs the env-file route, which is not a squawk.

## Evidence
- `src/sandbox/docker.ts:ExecOptions` — `env?: Record<string, string>;`
- `src/sandbox/docker.ts:Docker.execOnce` — `for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", \`${k}=${v}\`);`
- A search of `src/` for an `env:` property passed to `exec` finds none; `test/docker.test.ts` does not use it. Searched, not proven by the type checker.

## Corrective Action
Removed `env?: Record<string, string>;` from `ExecOptions` and the `for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", ...)` loop from `Docker.execOnce` in `src/sandbox/docker.ts`. Values passed that way would appear in `docker exec` argv, visible to `ps`. The `-e` flags in `createContainer` are unchanged.

## Verification
Ran `npm run typecheck`: clean, so nothing passed `env` in exec options (the earlier text search is now compiler-proven). Ran `npx vitest run --testTimeout 20000`: 363 passed, 17 skipped, same as before. No test asserted the exec `-e` behavior.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-16` (trailer `Squawks: 0008, 0009, 0010, 0011, 0012, 0014, 0015, 0016, 0017, 0018, 0019, 0020, 0021, 0022, 0023, 0024, 0025`) on branch `squawk/turnaround-2026-11-16`
