# Integration tests and the test entry points

## Entry points

| Command | Runs |
| --- | --- |
| `npm test` | The `default` vitest project: every `test/**/*.test.ts` except the two slow files. Fast, no Docker. |
| `npm run test:slow` | The `slow` project: `test/proxy-server.test.ts` (real sockets) and `test/docker-shell.test.ts` (the walk and probe scripts run in a local shell). |
| `npm run test:docker` | The files in `test/integration/` against a real Docker daemon and github.com, with `MCPE_DOCKER_TESTS=1`. The verbose reporter prints each test's duration. |
| `npm run test:docker:pressure` | The same, plus `MCPE_PRESSURE_TESTS=1`, running only the cases named "under fork pressure". |

A bare `npx vitest run` runs the `default` and `slow` projects together, as CI does (see `vitest.config.ts`). The integration files are part of the `default` project but are gated by `MCPE_DOCKER_TESTS`, so the skipped tests in `npm test` are the Docker-gated describes. `test/integration/gvisor.test.ts` needs `MCPE_DOCKER_RUNTIME` set as well and normally runs only in the gVisor workflow.

## The convention for cases that make or remove Docker objects

Each describe that creates or deletes Docker objects:

- uses its own data directory under the system temporary directory, and so its own installation id;
- labels every object with that id, and names it under the suite's prefix (`mcpe-it-<pid>-`; the two-installation cases use `mcpe-<id>-gron` for ids made for the run);
- cleans up by the owner-label filter, and only through the checked removers, which refuse any name that is not one of the suite's own.

The helpers are in `docker.test.ts`:

- `mayRemove(name, ids)`: the one name check every removal goes through.
- `removeContainerChecked`, `removeContainerWithVolumesChecked`, `removeVolumeChecked`, `removeNetworkChecked`: the removers; never call `docker rm` or `docker volume rm` directly.
- `assertNameCheckBehaves`: the name check's own assertions (no Docker command).
- `isUnderTmp`: whether a path lies strictly inside the temporary directory; check it before deleting a data directory.

The header comment of `docker.test.ts` says how to find what an interrupted run left behind.
