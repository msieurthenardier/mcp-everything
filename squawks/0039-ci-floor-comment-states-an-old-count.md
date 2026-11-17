# Squawk 0039: The comment above the hosted floor states an old test count

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-16
**Completed**: 2026-11-17

## Report
The hosted check fails when fewer than a floor of unit tests pass. The comment above that step says how many pass today, and it was written at the end of leg 4 of mission 02's flight 01; the review fix that followed added two cases. Correct the number in the comment.

**Updated 2026-11-17, after sortie 05.** The comment is wrong again by the same two. Sortie 05 raised the floor and the comment by the 57 tests it added, starting from the comment's old number: the comment now says 888 where 890 pass, and the floor is 867. Correct the comment to the count of the day, and so that it does not happen a third time, word the comment so that it does not need a number that goes stale (the step already prints the count and the floor on every run), or say in it that the number is the count at the date given and is not maintained. The floor (867, which is 23 under the count) stays as it is unless the operator wants it nearer.

## Evidence
- `.github/workflows/ci.yml` — `# 888 tests pass as of 2026-11-17.` and `const floor = 867;` (was `# 831 tests pass as of 2026-11-16.` and `const floor = 810;` when this squawk was logged).
- `npm test` on `main` at `82faddc`, run for sortie 05's debrief: 890 passed, 24 skipped. (At `df7fa8d`: 833 passed, 24 skipped.)
- `sorties/05-serve-the-2026-07-28-protocol/flight-debrief.md`, Process.

## Corrective Action
Changed only the comment above "Minimum passed tests" in `.github/workflows/ci.yml`. The floor is unchanged at `const floor = 867;`, as the Report says (the first pass moved it to 890; the review put it back, since that was the operator's call). The comment now reads: "Vitest already fails when no test file matches, so this catches a suite that was mostly skipped or excluded. The floor is kept somewhat under the passing count: 867 since 2026-11-17, when 890 passed. The step prints the current count on every run. Raise the floor as the suite grows." It states no rule for setting the floor: the first pass wrote "the passing count rounded down to the ten, less twenty", but the history of the floor (350, 430, 480, 810, 867) fits that rule for two of the earlier values and not the other two, so it did not describe how the floor was set. 867 became the floor in the commit that merged sortie 05 (`82faddc`). The comment says 890, not the 888 of the old comment: the old comment's count was the error this squawk corrects, and 890 is what passed on `82faddc` (this squawk's Evidence: `npm test` on `main` at `82faddc`, 890 passed, and the hosted check on that commit). There is no present-tense "N tests pass" sentence, so adding a test cannot make the comment false.

## Verification
- `timeout 120 npm test`: 916 passed, 24 skipped (940 total); 21 test files passed, 1 skipped (after the review round).
- `git diff -- .github/workflows/ci.yml` shows only comment lines: three removed (`# 888 tests pass as of 2026-11-17. ...`) and four added; the `const floor` line is unchanged from `main`.
- YAML parse: `python3 -c 'import yaml; yaml.safe_load(...)'` succeeded (PyYAML available).
- Script run against a real report (`--reporter=json` into `<temporary directory>`, script lines copied from the file): printed `916 tests passed (floor 867)`, exit 0 (re-run after the review round).
- Gate can fail (command-line copy only, floor written as 9000; file not edited): printed `only 915 tests passed, floor is 9000`, exit 1.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), review scoped to the batch's diff. It ran typecheck, the unit suite (915 passed, 24 skipped), the build, a real-pipe check of the built entry (every stdout line JSON; version `0.5.1`) and the Docker suite once (22 passed, 2 skipped, 210.8 s; the operator's four container ids the same before and after), and made sixteen trial changes to the source, each undone by editing. For this squawk it found that the first pass had moved the floor to 890 against the Report, on a rule that fits two of the four earlier floors; the floor was put back and the comment reworded to state no rule. A second independent Reviewer (Sonnet) reviewed the fix round alone and confirmed it (916 passed, 24 skipped). It confirmed the diff of the workflow file is comment lines only, that both facts in the comment are true (867 arrived in `82faddc` on 2026-11-17; 890 passed there), that the file parses, and ran the step's script against a real report (`916 tests passed (floor 867)`, exit 0).
**Verdict**: confirmed
**Commit**: `squawk: turnaround 2026-11-17` on branch `squawk/turnaround-2026-11-17`, with squawks 0039 and 0043 to 0048.
