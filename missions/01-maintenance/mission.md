# Mission: Maintenance

**Status**: active

## Outcome
Resolve codebase health issues identified in maintenance report 2026-11-15: a change to `main` is checked before it reaches the people who install from it, a failed or interrupted install no longer leaves a sandbox online, and the state mcp-everything leaves on disk is reconciled when it starts.

## Context
The first routine-maintenance inspection, run after sorties 01 to 03, assessed the codebase as Maintenance Required. See the [maintenance report](../../maintenance/2026-11-15.md) for every finding, its evidence and how each claim was established (ran, read or inferred).

This mission takes the bounded Action Required findings: 7, 4, 5, 6a, and the Advisory 6d that shares a flight with 6a. It does **not** take:

- **Finding 1a** (the README says the agent never sees variable values). It is squawk [0014](../../squawks/0014-readme-says-the-agent-never-sees-variable-values.md), severity grounding, and should be completed before this mission starts.
- **Findings 1b, 2 and 3** (who may read a project's variables, what a slug identifies, who owns a sandbox). They need design and go to one sortie after this mission, with squawk 0008. Flight 03's tests are the net that sortie will rely on.
- **Eleven Advisory findings** logged as squawks 0015 to 0025, for a turnaround.
- **The structure of `installer.ts` and `server.ts`.** The Architect advised against refactoring before the design sortie changes the launch path. Flight 02 touches `disconnectMcp` only as far as its finding requires.

## Success Criteria
- [x] Every pull request and every push to `main` runs install, typecheck, unit tests and build on a hosted runner, and `engines`, the README and a Node version file state the same Node floor (finding 7).
- [ ] After an install fails or is interrupted, the project's sandbox is off the network, its record says so, and the record does not stay `installing`; shutdown cannot hang; `disconnectMcp` does not store an emptied record when the sandbox is gone; the install failure branches have unit tests (finding 4).
- [ ] A test fails if a variable's value appears in the command line of a proxied launch or if the env file is not private, and env files left by a crash are removed at startup (finding 5).
- [ ] A registry file written by a newer version is refused with a clear message and never rewritten (finding 6a).
- [ ] Registry temp files left by a crash are removed at startup (finding 6d).

## Stakeholders
The operator, who maintains the project and runs it daily with two clients; and anyone who installs it with `npx` from the default branch.

## Constraints
- No new behavior beyond what the findings require; anything that grows goes back to the operator.
- Startup reconciliation must be safe when several mcp-everything processes share one data directory: the registry is built for that (a lock file, and a reload when another process changes the file).
- The pipeline needs no secret and must not be given one.
- Snapshot or golden-file baselines are not committed (operator's standing rule); none is expected here.

## Environment Requirements
- Node 22.12 or later, Docker for the integration suite (`npm run test:docker`).
- Flight 01 needs GitHub Actions on the repository (enabled; the repository is public, so hosted-runner minutes are free) and, after its first green run, a ruleset on `main` that only the operator can create.

## Open Questions
N/A — the two small design calls (how to treat a newer registry version, how to reconcile without disturbing another live process) are recorded with a default in the flights that own them.

## Known Issues
N/A

## Flights

> **Note:** These are tentative suggestions, not commitments. Flights are planned and created one at a time as work progresses. This list will evolve based on discoveries during implementation.

- [x] Flight 1: [CI gate](flights/01-ci-gate/flight.md) — the Tier A check, the Node floor, Dependabot (finding 7). First, so the others land under it.
- [x] Flight 2: [Install failure and interruption paths](flights/02-install-failure-paths/flight.md) — finding 4.
- [ ] Flight 3: [Local state hygiene and secret hand-off tests](flights/03-local-state-and-secret-handoff-tests/flight.md) — findings 5, 6a, 6d.
