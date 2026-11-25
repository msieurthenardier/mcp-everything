/** Shared types for scanning a project's own code before it runs. Every later scan module imports from here. */

export type Level = "error" | "warning" | "note";

/** Highest first. */
export const LEVELS: readonly Level[] = ["error", "warning", "note"];

/** True when `a` is at least as severe as `b`. */
export function levelAtLeast(a: Level, b: Level): boolean {
  return LEVELS.indexOf(a) <= LEVELS.indexOf(b);
}

/** One operator-configured scanner, validated from the scanners file. */
export interface ScannerSpec {
  name: string;
  image: string;
  command: string[];
  /** Overrides the image's entrypoint; "" clears it; absent leaves it. */
  entrypoint?: string;
  network: boolean;
  /** Hosts the scanner may reach under containment, normalized (`host` or `host:port`, IPv6 bracketed). */
  hosts: string[];
  timeoutSec: number;
  env: string[];
  /** When the scanner runs: "source" (the default, over the checkout before the build) or "build" (over the sandbox's volume after it). */
  stage?: "source" | "build";
}

export interface Finding {
  check: string;
  ruleId: string;
  level: Level;
  message: string;
  location?: string;
  securitySeverity?: string;
}

export interface CheckOutcome {
  name: string;
  kind: "builtin" | "scanner";
  status: "ran" | "failed" | "incomplete" | "not-run";
  counts: Record<Level, number>;
  findings: Finding[];
  omitted: number;
  /** Statements that are not findings and never count for the policy. */
  notes: string[];
  error?: string;
  /** The outside services a request was actually sent to, in order. Rendered as a fixed statement, never a note. */
  contacted?: ("github" | "osv")[];
  /** How many packages were sent to OSV. A structured count, not a note, so it never counts for the policy. */
  lookedUp?: number;
}

/** A build-relevant file read from the clone. `truncated` when cut at the walk's per-file cap. */
export interface BuildFile {
  path: string;
  content: string;
  truncated?: boolean;
}

/** What the walk of the clone produces and the built-in analysis reads. */
export interface BuildWalk {
  files: BuildFile[];
  /** Why the walk stopped short, when it did. */
  incomplete?: string;
  /** Build files skipped because they are symbolic links. */
  skippedLinks?: string[];
}

export interface ScanDecision {
  mode: "off" | "warn" | "block";
  /** The configured threshold, whatever the mode. */
  blockAt: Level;
  verdict: "build" | "block";
  reason: string;
}

/** What the scanners that run after the build found, judged on their own. */
export interface BuildReport {
  checks: CheckOutcome[];
  decision: ScanDecision;
  /** ISO time. */
  at: string;
}

export interface ScanReport {
  commit: string;
  checks: CheckOutcome[];
  decision: ScanDecision;
  /** ISO time. */
  at: string;
  /** The check after the build; absent when it did not run (or the project was installed before it existed). */
  build?: BuildReport;
}

/** The scanners that run at one stage; a scanner with no `stage` runs at the source stage. */
export function scannersAt(scanners: readonly ScannerSpec[], stage: "source" | "build"): ScannerSpec[] {
  return scanners.filter((s) => (s.stage ?? "source") === stage);
}

/**
 * Read a stored `scan.build` safely: it is returned only when it is an object whose `checks` is an array and whose
 * `decision.verdict` is "build" or "block". Anything else is treated as absent, so a malformed stored value never
 * holds a project and never throws.
 */
export function buildReport(scan: ScanReport | undefined): BuildReport | undefined {
  const b: unknown = scan?.build;
  if (typeof b !== "object" || b === null) return undefined;
  const { checks, decision } = b as { checks?: unknown; decision?: unknown };
  if (!Array.isArray(checks)) return undefined;
  if (typeof decision !== "object" || decision === null) return undefined;
  const verdict = (decision as { verdict?: unknown }).verdict;
  if (verdict !== "build" && verdict !== "block") return undefined;
  return b as BuildReport;
}
