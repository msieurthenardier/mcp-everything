# Squawk 0003: README does not say how to tell whether a sandbox has the idle timeout

**Status**: completed
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-15
**Completed**: 2026-11-15

## Report
Sandboxes created before sortie 01 never idle-stop until reinstalled, and the README says so, but it does not say how to tell which sandboxes those are. Every sandbox created since carries the label `mcp-everything.idle-timeout=<seconds>` (`0` when disabled); older ones have no such label. That label is currently the only way to tell them apart, and it is undocumented. Raised in the sortie 01 debrief.

This squawk is the documentation note only. Showing the same information in `project_info` adds behavior and belongs to a sortie.

## Evidence
- `src/sandbox/docker.ts:createContainer` — `"--label", `mcp-everything.idle-timeout=${idle}``
- `README.md` — no occurrence of `idle-timeout`; the Limitations bullet on idle stopping says projects installed earlier "need a reinstall" without saying how to identify them
- Observed on a pre-change sandbox: `docker inspect --format '{{index .Config.Labels "mcp-everything.idle-timeout"}}' <container>` prints an empty string

## Corrective Action
Added a sub-bullet after the reinstall sub-bullet in the README Limitations section giving the `docker inspect` label command, how to find the container name, and what a number, `0` and empty output mean.

## Verification
Checked the text against `createContainer` in `src/sandbox/docker.ts` (label `mcp-everything.idle-timeout=${sandboxIdleSec}`, plus `mcp-everything=1`), `src/install/installer.ts` (container = `namePrefix` + slug) and `src/config.ts` (default prefix `mcpe-`). No Docker commands run. Expected: the README's idle-stopping note gives the `docker inspect` command and says what an empty result, `0` and a number each mean. The label value is the local `idle`, set from `cfg.sandboxIdleSec`.

## Sign-Off
**Reviewer**: independent Reviewer agent (Sonnet), batch review scoped to the diff
**Verdict**: confirmed — one non-blocking note accepted: the `docker inspect` command wraps across two lines in the raw README (it renders as one line); left as is
**Commit**: `squawk: turnaround 2026-11-15` on branch `squawk/turnaround-2026-11-15`
