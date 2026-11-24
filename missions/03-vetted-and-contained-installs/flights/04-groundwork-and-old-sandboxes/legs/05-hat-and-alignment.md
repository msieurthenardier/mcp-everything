# Leg: hat-and-alignment

**Status**: completed
**Flight**: [Groundwork, and Leaving Old Sandboxes Alone](../flight.md)

## Objective
Walk the operator through the flight's visible changes on their own mcp-everything, and fix what surfaces until the operator is satisfied. The visible changes are the docs split, and refusing old sandboxes with their wording.

## Context
- **Legs 1–4** are committed as `5938d47`, in draft PR #33.
- **Unit suite:** 3012 passed, 71 skipped.
- **Docker suite:** 66 passed, 5 skipped. The baseline and three later runs were the same.
- **The operator's old sandbox.** `docker ps -a` (read-only, 2026-11-23) shows `mcpe-gron` with no owner label, "Up 8 days". It is a sandbox made before ownership labels. It is running uncontained today, and after this flight it is refused.
- **The operator's installation** is `e44f84eb` (`mcpe-e44f84eb-rea`). The other installation, `bde0aedf`, belongs to the operator's Windows side.
- **H1 (Flight Director, leg 4's design review)** narrowed DD4. Every message carries "Do not remove it yourself; ask the operator". The `docker` commands appear only in `project_info`'s owner line and the `uninstall_project` result. The operator confirms or changes this at step 4.
- **The fix-vs-feature gate applies.** Wording and look are fixed inline. New behavior gets a scoped design review first.
- **The operator's Docker.** Nothing is removed or changed except by the operator's own choice. Removing `mcpe-gron` is the operator's call (step 6).

## Acceptance Criteria (verification steps, one at a time)
- [x] 1. **Rebuild and reconnect.** `npm run build`, then `/mcp` to reconnect mcp-everything. `list_projects` answers.
- [x] 2. **Docs.** The operator reads the README's three summaries and one or two of `docs/checking.md`, `docs/containment.md` and `docs/security-model.md` on the PR branch on GitHub. Links resolve there, and the wording is the operator's to judge.
- [x] 3. **The old sandbox is refused.** One of `gron`'s tools (`gron__gron`) or `sandbox_exec` on `gron` answers an error with the prohibition and "See project_info". There is no `docker` command in it, and nothing ran.
- [x] 4. **`project_info gron`.** The owner line says the sandbox was made before ownership was recorded, then the prohibition, then both commands after "If the operator confirms…". The operator confirms H1's placement, or asks for a change.
- [x] 5. **Nothing else changed.** `list_projects` and one tool of `rea` (the operator's own, owner `e44f84eb`) still work.
- [x] 6. *(Optional; the operator decides.)* The operator removes `mcpe-gron` and its volume themselves, with the commands from step 4, and reinstalls `gron` if wanted. The reinstalled sandbox carries owner `e44f84eb`.

## Verification Steps
The operator reports each step's result. The Flight Director records it in the flight log before moving on.

## Implementation Guidance
- The Flight Director calls the mcp-everything tools in this session, and the operator watches and judges.
- The Flight Director never runs `docker rm` or `docker volume rm` on `mcpe-gron`; step 6 is the operator's own.
- A fix that needs code goes to a Developer (Sonnet), with the Edit/Write-only rule restated, and is then re-verified at the step that found it.

## Edge Cases
- **The client keeps the server's tools from session start.** After the reconnect, if `gron__gron` is not offered, use `call_project_tool`.
- **`project_info`'s owner line asks Docker** and can take up to 30 s if the daemon hangs.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
