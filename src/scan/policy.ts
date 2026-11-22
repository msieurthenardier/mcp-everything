import { emptyCounts } from "./sarif.js";
import { LEVELS, levelAtLeast, type CheckOutcome, type Level, type ScanDecision, type ScannerSpec } from "./types.js";

export { emptyCounts };

/** Sum of counts across checks. Pass `only` to restrict to some statuses. */
export function totalCounts(checks: CheckOutcome[], only?: CheckOutcome["status"][]): Record<Level, number> {
  const total = emptyCounts();
  for (const c of checks) {
    if (only && !only.includes(c.status)) continue;
    for (const l of LEVELS) total[l] += c.counts[l];
  }
  return total;
}

function countsText(counts: Record<Level, number>): string {
  return LEVELS.map((l) => `${counts[l]} ${l}`).join(", ");
}

/** Every finding of a check at or above `blockAt` counts; at `note`, the check's notes count as notes too. */
function countAtOrAbove(c: CheckOutcome, blockAt: Level): number {
  let n = 0;
  for (const l of LEVELS) if (levelAtLeast(l, blockAt)) n += c.counts[l];
  if (blockAt === "note") n += c.notes.length;
  return n;
}

/** The scanning decision. Failed and not-run checks never count; the reason says so. */
export function decide(mode: ScanDecision["mode"], blockAt: Level, checks: CheckOutcome[]): ScanDecision {
  if (mode === "off") return { mode, blockAt, verdict: "build", reason: "scanning is off" };

  const counted = checks.filter((c) => c.status === "ran" || c.status === "incomplete");
  const uncounted = checks.filter((c) => c.status === "failed" || c.status === "not-run");
  const tail = uncounted.map((c) => `${c.name} ${c.status === "failed" ? "failed" : "did not run"} and was not counted`);
  const withTail = (head: string) => [head, ...tail].join("; ");

  if (mode === "warn") {
    return { mode, blockAt, verdict: "build", reason: withTail(`findings: ${countsText(totalCounts(counted))}`) };
  }

  const hits = counted.map((c) => ({ c, n: countAtOrAbove(c, blockAt) })).filter((h) => h.n > 0);
  if (hits.length > 0) {
    const n = hits.reduce((s, h) => s + h.n, 0);
    const names = hits.map((h) => h.c.name).join(", ");
    return {
      mode,
      blockAt,
      verdict: "block",
      reason: withTail(`blocked: ${n} ${n === 1 ? "finding" : "findings"} at ${blockAt} or above, from ${names}`),
    };
  }
  return { mode, blockAt, verdict: "build", reason: withTail(`no findings at ${blockAt} or above`) };
}

/**
 * Blocking at `error` with no operator scanners can never block: the built-in check reports at most
 * `warning`. Returns a sentence for the startup log and the server instructions, else undefined.
 */
export function unreachableBlock(blockAt: Level, scanners: ScannerSpec[], mode: ScanDecision["mode"] = "block"): string | undefined {
  if (mode !== "block" || blockAt !== "error" || scanners.length > 0) return undefined;
  return "MCPE_SCAN=block with MCPE_SCAN_BLOCK_AT=error cannot block anything: no scanners are configured (MCPE_SCANNERS), and the built-in check never reports above warning. Set MCPE_SCAN_BLOCK_AT=warning or add a scanner.";
}
