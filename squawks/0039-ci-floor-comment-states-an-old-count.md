# Squawk 0039: The comment above the hosted floor states an old test count

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: —

## Report
The hosted check fails when fewer than a floor of unit tests pass. The comment above that step says how many pass today, and it was written at the end of leg 4 of mission 02's flight 01; the review fix that followed added two cases. Correct the number in the comment.

**Updated 2026-11-17, after sortie 05.** The comment is wrong again by the same two. Sortie 05 raised the floor and the comment by the 57 tests it added, starting from the comment's old number: the comment now says 888 where 890 pass, and the floor is 867. Correct the comment to the count of the day, and so that it does not happen a third time, word the comment so that it does not need a number that goes stale (the step already prints the count and the floor on every run), or say in it that the number is the count at the date given and is not maintained. The floor (867, which is 23 under the count) stays as it is unless the operator wants it nearer.

## Evidence
- `.github/workflows/ci.yml` — `# 888 tests pass as of 2026-11-17.` and `const floor = 867;` (was `# 831 tests pass as of 2026-11-16.` and `const floor = 810;` when this squawk was logged).
- `npm test` on `main` at `82faddc`, run for sortie 05's debrief: 890 passed, 24 skipped. (At `df7fa8d`: 833 passed, 24 skipped.)
- `sorties/05-serve-the-2026-07-28-protocol/flight-debrief.md`, Process.

## Corrective Action
*(written at completion)*

## Verification
*(written at completion)*

## Sign-Off
*(written at completion)*
