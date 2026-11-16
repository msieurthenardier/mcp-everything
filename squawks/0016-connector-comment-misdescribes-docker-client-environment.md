# Squawk 0016: A comment in `dockerConnector` says secrets are not in the Docker client's environment

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-16

## Report
The comment above the env-file code in `dockerConnector` says secrets travel "not in the docker CLI's own environment". Ten lines below, the connector hands the Docker client the whole of `process.env`, which holds every project's `<slug>__<NAME>` variables under their prefixed names, and the forge tokens. The README's limitations section states this correctly; the comment contradicts it and would mislead the next person to change this path. Finding 5b of the [2026-11-15 maintenance report](../maintenance/2026-11-15.md).

Comment only: say what is true. The server's variables are not set under their own names in the client's environment; the client does inherit mcp-everything's whole environment, as the README says. No behavior change. Filtering that environment is a design question for the secrets sortie, not this squawk.

## Evidence
- `src/proxy/mcp-proxy.ts:dockerConnector` — `// Secrets travel in a private file, not in argv (visible to \`ps\`) and not` / `// in the docker CLI's own environment (which they could then influence).`
- Same function — `for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;` then `new StdioClientTransport({ command: cfg.docker.bin, args, env, stderr: "pipe" })`.
- `README.md`, limitations — "The Docker client that starts a server inherits mcp-everything's whole environment…".

## Corrective Action
Rewrote the comment above the env-file code in `dockerConnector` (`src/proxy/mcp-proxy.ts`). It now says the server's variables are not set under their own names in the docker CLI's environment (so they cannot influence the client) and not in argv, and that the client still inherits mcp-everything's whole environment, prefixed variables included, as the README states. Comment only; no behavior change. Filtering the inherited environment stays with the secrets sortie.

## Verification
Ran `git diff src/proxy/mcp-proxy.ts`: my change is comment lines only (the other hunks belong to an earlier squawk). `npm run typecheck`: clean. `npx vitest run --testTimeout 20000`: 349 passed, 17 skipped.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff
**Verdict**: confirmed; comment lines only
**Commit**: `squawk: turnaround 2026-11-16` (trailer `Squawks: 0008, 0009, 0010, 0011, 0012, 0014, 0015, 0016, 0017, 0018, 0019, 0020, 0021, 0022, 0023, 0024, 0025`) on branch `squawk/turnaround-2026-11-16`
