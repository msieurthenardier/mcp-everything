# Squawk 0053: Anonymous test volumes left on the operator's Docker by flight 02

**Status**: deferred
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-23
**Completed**: —

## Report
Mission 03 flight 02's early Docker-suite runs left nine anonymous volumes on the operator's Docker daemon. They came from containers removed without `-v`, before the `-v` fixes (leg 6's one-shot `rm -f`, the test helpers, and `rmContainer` in the review), plus leg 6's deliberate fifth-trial volume. The flight removed none of them: anonymous volumes cannot be attributed by name, and the suite never removes what it did not create in that run. The cause is fixed, and runs since leave no volume. Only these nine remain.

## Evidence
The nine full ids follow. All carry `com.docker.volume.anonymous`, and none is used by any container (`docker ps -a --filter volume=<id>` is empty, checked 2026-11-23).

| Id | Created (UTC) | Source |
|---|---|---|
| `b4f275cf6ed11bb455562d76eb4ee5738d1fda7880a13f0526aa4dca49051d98` | 2026-11-23 04:55 | leg 5's run |
| `c66ce2d7bb437ba8b517b58729c5d904a4a990b23f7e2ee097434b57e666893c` | 2026-11-23 04:59 | leg 5's run |
| `86292c7ff0d049c300f25e0c77e8dfb51a832bdcbceb0b7a4b5d6f741be10b2a` | 2026-11-23 05:34 | leg 6's run |
| `36748c788610ef2403a4ba173ea68284daf25e415abbd572aeaa856c4d5d56e1` | 2026-11-23 05:40 | leg 6's fifth trial |
| `48f962bbcbed13056cc92897ab2f0bc40ecb9f997e3f13586d58b03d531de550` | 2026-11-23 06:07 | leg 7's run |
| `410f3978fd9f34c5a5686d63a22c6b10b2fe504e97633b0121edf512fa66aa0f` | 2026-11-23 06:39 | leg 8's run |
| `2b5accce61a5b41005a15e94a1238a96422eca5c6f97a9a019d0308302202a77` | 2026-11-23 07:22 | leg 9's run |
| `c750398d83029a7562f4ba7fe0aead743f89c2367bd589c99e60feb5ea48da34` | 2026-11-23 08:06 | leg 10's run |
| `c7c2619154980d383ba8dfa2d68412559596197d5df6b5c833d796cb15eb4ac6` | 2026-11-23 08:54 | first fix run, before `rmContainer -v` |

How the ids were attributed:
- **Legs 6–10 and the fix run:** the volume list diff against `leg6-volumes-before.txt`, matched to the ids in the flight log.
- **Leg 5:** it recorded only a count and a hash. The one pair whose removal from the leg 6 list reproduces leg 5's recorded before-hash (`1b198447fc48e0f8`) is `b4f275cf…` and `c66ce2d7…`.

## Corrective Action
*(written at completion)* Remove exactly these nine, by full id, after re-checking that each still has no container (`docker volume rm <id>`, never `prune`).

## Verification
The nine ids are gone, and the rest of the volume list is unchanged (a sorted diff of before against after shows only these nine).

## Sign-Off
*(written at completion)*

## Disposition
**Deferred**: logged at flight 02's HAT at the operator's choice. Removing objects from the operator's Docker needs their explicit OK at completion time. Revisit at the next turnaround after mission 03 flight 02 lands, or when the operator asks.
