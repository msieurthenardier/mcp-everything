# Flight Log: Contained Network and Isolation Runtime

**Flight**: [Contained Network and Isolation Runtime](flight.md)

## Summary
Planning. Trials T1–T10 run on the operator's daemon on 2026-11-22 (see the flight's **Trials**).

---

## Leg Progress

---

## Decisions

---

## Deviations

---

## Anomalies

---

## Session Notes

### 2026-11-22 — Planning
- Trials T1–T10 run before the interview; T11–T13 after design review 1, to answer its question on how the proxy resolves a forward target that is also a network alias. All objects were named `mcpe-plan-<n>` and removed. The operator's daemon is Docker Desktop on WSL2 (server 29.8.2), not a native Linux engine; native Linux is covered by the new CI job (DD13).
- Design review 1 (Architect): approve with changes; folded in (see the flight's header note). Legs went from 9 to 11.
- Design review 2 (Architect, the last cycle): approve with changes. Its spec gaps were folded in by the Flight Director without a third review, as the method allows. Its two behavior questions went to the operator: an existing sandbox under another runtime is refused with "reinstall"; a draft pull request is opened at leg 4 for the native-Linux measurements.
- Items review 2 asked to be measured, not assumed, are carried as leg-4 prerequisites: the interface-bound listen, a read-only `node -e` proxy, a two-holder alias, `host-gateway` and the resolver on native Linux.
