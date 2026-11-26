# Squawk 0066: The clone script's fallback passes the URL and ref without `--`

**Status**: completed
**Type**: defect
**Severity**: routine
**Reported**: 2026-11-25
**Completed**: 2026-11-25 (squawk turnaround 2026-11-25)

## Report
The probe's clone script ends git's options with `--` in its first `git clone`, but not in the fallback used when `--branch` fails. There, `git remote add origin "$url"` and `fetch … origin "$ref"` take the URL and the ref as plain operands. `validateGitRef` rejects a ref that starts with `-`, and the URL is built by `parseRepoRef`, so nothing exploits this today. The guard is defence in depth, consistent with the primary path.

## Evidence
- `src/sandbox/scripts.ts:66`: `git -C ${REPO_DIR} remote add origin "$url" >&2`.
- `src/sandbox/scripts.ts:67`: `… fetch --quiet --depth 1 origin "$ref" >&2`.
- `src/forge/repo-ref.ts`, `validateGitRef`: the first character must be `[A-Za-z0-9_]`.

## Corrective Action
`src/sandbox/scripts.ts` (clone script, fallback branch, lines 66-67): `git remote add -- origin "$url"` and `git fetch --quiet --depth 1 -- origin "$ref"`. Checked in a throwaway repo with git 2.43.0: `git remote add origin -- -evil` and `git remote add -- o2 -evil2` both succeed and record the URL literally; `git fetch -- origin -x` treats `origin` and `-x` as operands. Both subcommands accept `--` (the squawk's doubt about `remote add` does not hold in this git); the form with `--` before the operands is used. The sandbox's git version is the image's, so the Docker run is the confirmation there.

## Verification
- No test pins the script text (grep for `remote add` in `test/` finds only `discover.test.ts` fixtures).
- `npm test`: 2961 passed, 72 skipped; `npm run test:slow` (includes `test/docker-shell.test.ts`): 115 passed.
- Not run: the Docker suite's pinned-ref cowsay install (Flight Director).

## Sign-Off
Reviewer (Sonnet), 2026-11-25: `[HANDOFF:confirmed]` for the batch, scoped to the diff, with mutation trials (0051, 0067, 0061 and 0049 each made a test fail). Unit: 3,076 passed (both projects). Docker suite: 67 passed, 5 skipped, 0 failed (1,665 s), run by the Flight Director, with object lists unchanged apart from another tool's transient containers.

## Disposition
Logged at the routine maintenance of 2026-11-25 (Security finding S1, Advisory).
