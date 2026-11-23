# Leg: hat-and-alignment

**Status**: completed
**Flight**: [Checking Dependencies and Tool Descriptions](../flight.md)

## Objective
Walk the operator through both new checks on their own mcp-everything (`MCPE_SCAN=on`, `MCPE_NETWORK=contained`), against real repositories and a real MCP server, and fix what surfaces until the operator is satisfied.

## Context
- Legs 1–3 are committed (`06b42c9`, PR #31, draft). Their unit and Docker results are in the flight log.
- The operator's configuration (flight 02's HAT): scanning `on` (warn), the Trivy scanner configured, containment on. `rea` is installed as an MCP server with 263 upstream tools, which makes it a real-world sample for false positives.
- Targets chosen at planning time, 2026-11-23:
  - `OWASP/NodeGoat`: 1,085 exact npm versions from a lockfile, including `lodash@4.13.1`, which is known to be vulnerable;
  - `tomnomnom/gron` with a pinned tag;
  - one GitLab repository.
- The fix-vs-feature gate applies: look-and-feel fixes are made inline; new behavior gets a scoped design review first.

## Acceptance Criteria (verification steps, one at a time)
- [x] 1. **Rebuild and reconnect.** `npm run build`, then `/mcp` to reconnect mcp-everything. The server instructions name `dependencies` (with what it sends) and `tool-descriptions`.
- [x] 2. **`check_project OWASP/NodeGoat`.**
  - The report has a `dependencies` line that ran or is incomplete, with vulnerable-package warnings (including lodash) and no errors unless OSV lists something as malicious.
  - The "sent:" line names GitHub and OSV with a package count.
  - It is followed by `build-hooks` and Trivy.
  - The operator judges the wording and length.
- [x] 3. **`check_project` with a pinned ref** (`tomnomnom/gron` at a tag): `dependencies` is not-run, and the reason names the default branch. The "sent:" line names GitHub only.
- [x] 4. **`check_project` of a GitLab repository**: `dependencies` is not-run, with "GitLab has no public dependency graph" and no "sent:" line.
- [x] 5. **`refresh_mcp rea`, then `project_info rea`.**
  - The `tool descriptions:` line says "checked … under warn".
  - Any findings on rea's 263 real tools are read together. Each is either a real signal or a false positive to fix inline.
- [ ] 6. *(Skipped by the operator, 2026-11-23.)* *(Optional; the operator decides.)* **Withholding under block.** Reconnect with `MCPE_SCAN=block`, register a tiny MCP server in a sandbox whose tool description names `set_project_hosts`, and see:
  - the tool absent from the list;
  - `call_project_tool` answering "withheld";
  - `project_info` naming the tool.

  Then restore `MCPE_SCAN=on`.
- [x] 7. **README**: the operator reads "The dependency check" and "The tool-description check" sections.

## Verification Steps
The operator reports each step's result; the Flight Director records it in the flight log before moving on.

## Implementation Guidance
- The Flight Director calls the mcp-everything tools in this session; the operator watches and judges.
- Fixes needing code go to a Developer (Sonnet) with the Edit-only rule restated. Each fix is then re-verified at the step that found it.
- The operator's Docker objects are not touched beyond what the tools create and remove.

## Edge Cases
- **GitHub rate limit during the HAT** (60 an hour unauthenticated): step 2 or 3 reports `failed` with "rate limit". That is accepted behavior, not a defect. Retry later, or set `GITHUB_TOKEN` in mcp-everything's environment.

---

## Post-Completion
Completion steps — status transitions, flight-log update, checking off in the parent flight, and commit — are Flight Control protocol, driven by the execution workflow. Not repeated here.
