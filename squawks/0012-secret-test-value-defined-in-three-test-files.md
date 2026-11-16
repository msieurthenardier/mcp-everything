# Squawk 0012: The secret test value is defined separately in three test files

**Status**: open
**Type**: servicing
**Severity**: routine
**Reported**: 2026-11-15
**Completed**: —

## Report
The tests [sortie 03](../sorties/03-mcp-env-passthrough/flight.md) added for "the value never appears" use a long value that cannot occur by accident. The same literal is declared in three test files, and a second one in a fourth place. The fake upstream those tests use is shared in `test/helpers.ts`; the value is not. Test-code debt noted in the sortie 03 [debrief](../sorties/03-mcp-env-passthrough/flight-debrief.md) by the Developer.

Export one value from `test/helpers.ts` and use it where the copies are. Tests only.

## Evidence
- `test/server.test.ts:491` — `const VALUE = "hv-7Qz3kLx9Vb2NmR8tYw4Pa6Ud1Fs0Jc5";`
- `test/installer.test.ts:311` — the same literal.
- `test/proxy.test.ts:288` — the same literal.
- `test/installer.test.ts:395` — `const VALUE = "hv-4Mk8Rt2Qz7Wn1Xb6Yc3Ld9Pa5Hs0Ve2";`, a different one in a second block.

## Corrective Action
*(written at completion)*

## Verification
Expected: one definition; `npm test` passes with the same counts as before (340 passed, 16 skipped at the time of logging). If the second block needs a value distinct from the first, keep two named exports and say why.

## Sign-Off
*(written at completion)*
