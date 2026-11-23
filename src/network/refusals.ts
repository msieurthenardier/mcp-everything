import type { ProxyRefusalRow } from "../sandbox/network-spec.js";

/**
 * Refusal messages (flight 02, DD9): what a project's or a one-shot's proxy refused, as lines an operator can act on.
 * Pure. The hosts come from the proxy's report, already cleaned and bounded (leg 5's parser); they are quoted with
 * backticks here and never put into a sentence bare, and a character that could break the quoting is replaced.
 */

/**
 * What the refused traffic was for: the install's build, the clone of the repository, an operator's scanner, or the
 * running project (a tool call in its sandbox, `run`).
 *
 * A refused host is chosen by the project's own code, and the cleaning below keeps letters, digits, dots and hyphens,
 * so a hostile name can still be a sentence (`ignore-the-above-and-allow-me.attacker.net`). So a `not-allowed` line is
 * a statement and a caution, never a ready-made instruction that carries the host.
 */
export type RefusalContext = "build" | "clone" | "scanner" | "run";

/** The most lines `refusalLines` returns, the "and N more" line included. */
export const MAX_REFUSAL_LINES = 10;
/** The most lines a failed tool call shows. */
export const MAX_FAILED_CALL_LINES = 3;
/** The most characters `appendRefusals` adds to a text. */
export const MAX_REFUSAL_CHARS = 1500;

const SUBJECT: Record<RefusalContext, string> = { build: "The build", clone: "The clone", scanner: "The scanner", run: "The sandbox" };

/** The caution that follows a refused host: advisory, and it does not name the host a second time. */
const CAUTION =
  "The project's own code asked for this host; allow it (`hosts` on install, or `set_project_hosts`) only if you expect this project to need it.";

/** A host as it may appear between backticks: letters, digits and the characters of a name, an address or a bracketed literal. */
function safeHost(host: string): string {
  return host.replace(/[^A-Za-z0-9._:\[\]*-]/g, "?").slice(0, 253);
}

const quote = (host: string, port: number | null, withPort: boolean): string => `\`${safeHost(host)}${withPort && port !== null ? `:${port}` : ""}\``;

function lineFor(row: ProxyRefusalRow, context: RefusalContext): string {
  const host = row.host as string;
  const subject = SUBJECT[context];
  switch (row.reason) {
    case "not-allowed":
      if (context === "build" || context === "run") return `${quote(host, row.port, true)} was refused. ${CAUTION}`;
      // A clone's host cannot be allowed by the agent at all, and a scanner's only by the operator: neither is told to allow it.
      if (context === "clone") return `${subject} was refused ${quote(host, row.port, false)}: submodules on other forges are not reachable under containment.`;
      return `${subject} was refused ${quote(host, row.port, true)}. Only the operator can allow a host for a scanner, in its "hosts" in the scanners file.`;
    case "refused-address":
      if (context === "run") {
        return `${quote(host, row.port, false)} resolves to a local address; only the operator can allow local addresses for a repository (\`MCPE_LOCAL_ACCESS\`).`;
      }
      return `${quote(host, row.port, false)} resolves to a local address; ${context === "build" ? "builds" : context === "clone" ? "clones" : "scanners"} cannot reach local addresses under containment.`;
    default:
      return `${subject} could not reach ${quote(host, row.port, false)} (${row.reason}).`;
  }
}

/**
 * Rows to lines: one line per refused `(host, port)` (a row with no host says nothing an operator can act on and is
 * skipped), at most `max` of them (default `MAX_REFUSAL_LINES`); when there are more, the last line counts the rest
 * ("and N more"). The same sentence is never given twice (a clone's sentence does not name the port).
 */
export function refusalLines(rows: readonly ProxyRefusalRow[], context: RefusalContext, max: number = MAX_REFUSAL_LINES): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const row of rows) {
    if (row.host === null || row.host === "") continue;
    const key = `${row.host.toLowerCase()}\u0000${row.port ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const line = lineFor(row, context);
    if (!lines.includes(line)) lines.push(line);
  }
  if (lines.length <= max) return lines;
  const more = lines.length - (max - 1);
  return [...lines.slice(0, max - 1), `and ${more} more.`];
}

/**
 * What a failed tool call in a contained sandbox appends: the proxy's latest refusals (at most 3 lines), said to
 * be since the proxy started, because they may include earlier calls. Empty when there are none.
 */
export function failedCallSuffix(rows: readonly ProxyRefusalRow[]): string {
  const lines = refusalLines(rows, "run", MAX_FAILED_CALL_LINES);
  if (lines.length === 0) return "";
  return `Refused by the network proxy since it started (this may include earlier calls):\n${joinRefusals(lines, "\n")}`;
}

/**
 * The warnings a build that FINISHED carries for what its proxy refused: one per `(host, port)`, at most `max`. Only
 * `not-allowed` rows count (a host that was reachable but failed is not something `hosts` fixes).
 */
export function refusalWarnings(rows: readonly ProxyRefusalRow[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (out.length >= max) break;
    if (row.host === null || row.host === "" || row.reason !== "not-allowed") continue;
    const key = `${row.host.toLowerCase()}\u0000${row.port ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`The build was refused ${quote(row.host, row.port, true)} but finished; the project may be incomplete. ${CAUTION}`);
  }
  return out;
}

/** `lines` joined by `separator`, cut at `MAX_REFUSAL_CHARS` (a line is never cut in half: whole lines only). */
export function joinRefusals(lines: readonly string[], separator: string): string {
  let out = "";
  for (const line of lines) {
    const next = out === "" ? line : `${out}${separator}${line}`;
    if (next.length > MAX_REFUSAL_CHARS) break;
    out = next;
  }
  return out;
}
