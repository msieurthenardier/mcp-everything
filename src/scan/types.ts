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

export interface ScanReport {
  commit: string;
  checks: CheckOutcome[];
  decision: ScanDecision;
  /** ISO time. */
  at: string;
}
