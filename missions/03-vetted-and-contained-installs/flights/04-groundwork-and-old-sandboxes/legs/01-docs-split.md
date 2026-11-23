# Leg: docs-split

**Status**: completed
**Flight**: [Groundwork, and Leaving Old Sandboxes Alone](../flight.md)

## Objective
Move the README's three security chapters, unchanged in wording, into `docs/checking.md`, `docs/containment.md` and `docs/security-model.md`. Leave a short summary and link for each in the README, rewrite every link that pointed into the moved text, ship `docs/` in the npm package, and make `test/readme.test.ts` read the moved sections from their new files.

## Context
- Flight DD2 (the operator's decision at flight 3's HAT; the name is not `SECURITY.md`).
- Low risk: documentation, one `package.json` field and one test file. No source code changes.
- Baseline (2026-11-23, `72a0420`): `npx vitest run` gives 2988 passed, 71 skipped, 0 failed.

## Inputs
`README.md` at `5a5f3fa` (1,596 lines). Chapters and their `###` subsections:

| Chapter (moves) | Lines | Subsections |
|---|---|---|
| `## Checking projects before they run` → `docs/checking.md` | 339–753 | Turning it on (402), Adding a scanner (436), The built-in check (531), The dependency check (621), The tool-description check (662), What none of this protects against (720) |
| `## Network containment` → `docs/containment.md` | 754–1094 | Turning it on (766), How it works (787), What each stage reaches (858), The default hosts (872), A project's hosts (893), Local access (`MCPE_LOCAL_ACCESS`) (914), Scanners' hosts (971), What reaches outside services (988), When something is refused (1005), Upgrading, and switching from open to contained (1030), What containment does not stop (1063) |
| `## Security model` → `docs/security-model.md` | 1095–1276 | The isolation runtime (1205) |

Links that point into the moved text from outside it are at README lines 52, 71, 74, 101, 220, 1467, 1470–1472, 1475, 1505, 1534, 1556 and 1564. These numbers come from `grep -n "](#" README.md` and are only a starting list. The leg's test is the actual check.

## Outputs
- `docs/checking.md`, `docs/containment.md` and `docs/security-model.md` (new).
- `README.md`: each of the three chapters is replaced by its `##` heading, a summary and a link.
- `package.json`: `"files"` gains `"docs"`.
- `test/readme.test.ts`: reads moved sections from the docs files, and gains link-resolution tests.

## Acceptance Criteria
- [ ] **The three docs files.**
  - Each file starts with a `#` title: the chapter's old `##` heading text, promoted one level. Every subsection is promoted one level (`###` becomes `##`, `####` becomes `###`).
  - The body text of each chapter, from just after its `##` heading line to just before the next chapter's, is in its file byte for byte. Only two kinds of change are allowed:
    - heading levels;
    - link targets (`(#x)` becoming `(other-file.md#x)`, `(../README.md#x)` or `(#x)` with the same text).
  - A one-line lead under the title is allowed, e.g. "Part of mcp-everything's documentation; see the [README](../README.md)."
- [ ] **The README.**
  - Each moved chapter keeps its `##` heading, with the same text, so `#checking-projects-before-they-run`, `#network-containment` and `#security-model` still resolve.
  - Under each heading is a summary of at most 12 lines that says what the chapter covers, plus a link to the docs file.
  - The summaries are new text: plain, no claims beyond what the moved chapter says, and no environment variable or default that the moved chapter does not state.
  - Nothing else in the README changes except link targets.
- [ ] **Every link resolves.**
  - **Same-file anchors:** every `](#anchor)` in `README.md` and in each `docs/*.md` names a heading in the same file.
  - **Cross-file links:** every relative link of the form `](docs/<f>.md#anchor)`, `](<f>.md#anchor)` or `](../README.md#anchor)` names an existing file and a heading in it.
  - **Slug rule:** anchors follow GitHub's rule: lower case; punctuation removed except `-` and `_`; spaces become `-`; backticks dropped. For example, ``Local access (`MCPE_LOCAL_ACCESS`)`` gives `local-access-mcpe_local_access`.
  - **Duplicate headings** (such as "Turning it on" in two chapters, which now live in different files) need no `-1` suffix, because each file has its own anchors. Where a file holds two headings with the same text, the second gets `-1`, as on GitHub.
  - **Pinned by test:** a new test in `test/readme.test.ts` implements this check over `README.md` and the three docs files. It fails on any link that does not resolve.
- [ ] **`test/readme.test.ts`.**
  - Every existing assertion still runs and passes. An assertion about a moved section reads that section from its docs file.
  - `section()` (≈ line 12) gains a variant, or a parameter, for the docs files, whose top level is `#` and whose subsections are `##`.
  - No assertion is deleted or weakened.
  - The link-resolution test is new.
- [ ] **`package.json`:** `"files"` is `["dist", "README.md", "docs"]`. `npm pack --dry-run` lists the three docs files.
- [ ] **Checks:** `npm run typecheck` is clean, `npm run build` succeeds, and `npx vitest run` gives 2988 + N passed, 71 skipped, 0 failed, where N is the number of new tests.

## Verification Steps
1. **Moved text.** For each chapter, extract its old body from `git show 5a5f3fa:README.md` and the new body from its docs file. Normalize both by:
   - lowering heading levels;
   - replacing every `](…#x)` with `](#x)`;
   - dropping the new title line and the optional lead line.

   `diff` must be empty. Record the commands and their (empty) output in the flight log.
2. **README diff.** `git diff README.md`, read: the only changes outside the three chapters are link targets.
3. **Checks.** `npm run typecheck && npm run build && npx vitest run`, with the counts above.
4. **Package.** `npm pack --dry-run 2>&1 | grep docs/`: three lines.
5. **The new test can fail.** Temporarily break one anchor in the README by editing it, run `npx vitest run test/readme.test.ts` and see the failure, then restore the anchor by editing it back. Record this in the flight log.

## Implementation Guidance
1. **Make the docs files.** Create each from the chapter's text, copied exactly. Promote heading levels and add the title. Copy faithfully, then edit only headings and links. Don't retype paragraphs.
2. **Rewrite links.**
   - In the docs files, a link to a section in the same file stays `(#x)`. A link to another moved chapter becomes `(other.md#x)`. A link to a README section that stays, such as `#several-installations-on-one-docker-daemon`, `#configuration`, `#protocol-revisions` or `#limitations`, becomes `(../README.md#x)`.
   - In the README, a link to a moved subsection becomes `(docs/<file>.md#x)`, with `x` recomputed for the promoted heading. A heading's slug does not change when its level changes.
3. **Write the summaries.** Replace each chapter body in the README with its summary and a link: "Full chapter: [docs/checking.md](docs/checking.md)". Keep each summary under 12 lines and stick to what the chapter says.
4. **Update `test/readme.test.ts`.** Read each docs file. Point each assertion at the file that now holds its section. Add the link-resolution test, a small slugger following the rule above.
5. **`package.json`:** add `"docs"` to `files`.
6. **Run the checks** and the verification steps. Write the flight log entry.

## Edge Cases
- **Headings with code or punctuation:** ``Local access (`MCPE_LOCAL_ACCESS`)``, "Scanners' hosts" (apostrophe dropped: `scanners-hosts`), and "Upgrading, and switching from open to contained" (comma dropped). The test's slugger must match these exactly. The existing links use these forms and are the evidence.
- **Links inside code spans or fenced blocks** are not links. The checker skips fenced code blocks, and ignores text inside backticks.
- **External links** (`http…`) and links to files without an anchor are not anchors. The checker only requires the named file to exist.
- **The README's table of contents, if any**, is a set of links like any other and is covered by the checker.
- **A server instruction or tool message that names a README section:** none exists. `grep -rn README src` finds only a comment at `src/network/startup.ts:21`, which stays accurate ("stated in the README" becomes true through the summary and link). No source change.

## Files Affected
- `docs/checking.md`, `docs/containment.md` and `docs/security-model.md` (new)
- `README.md`
- `package.json`
- `test/readme.test.ts`

## Citation Audit
Checked 2026-11-23 against `5a5f3fa`:
- the chapter and subsection line numbers come from `grep -n "^#\{2,4\} " README.md`;
- the outside-link lines come from `grep -n "](#" README.md`;
- `package.json` `files` is `["dist", "README.md"]`;
- `grep -rn README src` finds only `src/network/startup.ts:21`.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
