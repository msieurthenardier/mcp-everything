import { LEVELS, type Finding, type Level } from "./types.js";
import { clean, isObject, own } from "./util.js";

export type SarifResult =
  | { ok: true; counts: Record<Level, number>; findings: Finding[]; omitted: number; notes: string[] }
  | { ok: false; reason: string };

/** At most this many findings are kept (and cleaned) from one scanner's output. */
export const MAX_FINDINGS = 20;

export const RULE_ID_MAX = 80;
export const MESSAGE_MAX = 200;
export const LOCATION_MAX = 120;
export const SEVERITY_MAX = 16;
const SKIPPED_KINDS = new Set(["pass", "notApplicable", "informational"]);

export function emptyCounts(): Record<Level, number> {
  return { error: 0, warning: 0, note: 0 };
}

function isLevel(v: unknown): v is Level {
  return v === "error" || v === "warning" || v === "note";
}

interface Kept {
  result: Record<string, unknown>;
  level: Level;
}

/**
 * Parse SARIF 2.1.0 into exact counts and at most 20 cleaned findings. Everything in the input is
 * hostile: counts cover every result, but only the findings kept get cleaned. The failure reason is
 * fixed text; it never quotes the input or JSON.parse's message.
 */
export function parseSarif(stdout: string, check: string): SarifResult {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return { ok: false, reason: "output is not valid JSON" };
  }
  if (!isObject(doc)) return { ok: false, reason: "output is not a SARIF object" };
  if (own(doc, "version") !== "2.1.0") return { ok: false, reason: "output is not SARIF version 2.1.0" };
  const runs = own(doc, "runs");
  if (!Array.isArray(runs)) return { ok: false, reason: "output has no runs array" };

  const counts = emptyCounts();
  const buckets: Record<Level, Kept[]> = { error: [], warning: [], note: [] };
  let skipped = 0;
  let unknownLevels = 0;

  for (const run of runs) {
    if (!isObject(run)) continue;
    const results = own(run, "results");
    if (!Array.isArray(results)) continue;

    // Rule defaults, indexed once per run, only when a result needs them.
    let rules: unknown[] | undefined;
    let byId: Map<string, unknown> | undefined;
    const ruleLevel = (result: Record<string, unknown>): unknown => {
      if (rules === undefined) {
        const tool = own(run, "tool");
        const driver = isObject(tool) ? own(tool, "driver") : undefined;
        const list = isObject(driver) ? own(driver, "rules") : undefined;
        rules = Array.isArray(list) ? list : [];
        byId = new Map();
        for (const r of rules) {
          const id = isObject(r) ? own(r, "id") : undefined;
          if (typeof id === "string" && !byId.has(id)) byId.set(id, r);
        }
      }
      let rule: unknown;
      const idx = own(result, "ruleIndex");
      if (typeof idx === "number" && Number.isInteger(idx) && idx >= 0 && idx < rules.length) rule = rules[idx];
      if (!isObject(rule)) {
        const id = own(result, "ruleId");
        rule = typeof id === "string" ? byId!.get(id) : undefined;
      }
      if (!isObject(rule)) return undefined;
      const conf = own(rule, "defaultConfiguration");
      return isObject(conf) ? own(conf, "level") : undefined;
    };

    for (const result of results) {
      if (!isObject(result)) continue;
      const kind = own(result, "kind");
      if (typeof kind === "string" && SKIPPED_KINDS.has(kind)) {
        skipped++;
        continue;
      }
      const sup = own(result, "suppressions");
      if (Array.isArray(sup) && sup.some((s) => isObject(s) && own(s, "status") !== "rejected")) {
        skipped++;
        continue;
      }

      let raw = own(result, "level");
      if (raw === undefined) raw = ruleLevel(result);
      let level: Level;
      if (raw === undefined) level = "warning"; // SARIF's default
      else if (raw === "none") continue;
      else if (isLevel(raw)) level = raw;
      else {
        level = "warning"; // a level SARIF does not define: report, never drop
        unknownLevels++;
      }
      counts[level]++;
      if (buckets[level].length < MAX_FINDINGS) buckets[level].push({ result, level });
    }
  }

  const findings: Finding[] = [];
  for (const level of LEVELS) {
    for (const kept of buckets[level]) {
      if (findings.length >= MAX_FINDINGS) break;
      findings.push(toFinding(kept.result, level, check));
    }
  }
  const total = counts.error + counts.warning + counts.note;

  const notes: string[] = [];
  if (skipped > 0) notes.push(`${skipped} results were suppressed or not failures and were not counted`);
  if (unknownLevels > 0) notes.push(`${unknownLevels} results had a level SARIF does not define and were counted as warning`);
  return { ok: true, counts, findings, omitted: total - findings.length, notes };
}

function toFinding(result: Record<string, unknown>, level: Level, check: string): Finding {
  const id = own(result, "ruleId");
  const ruleId = typeof id === "string" && id !== "" ? clean(id, RULE_ID_MAX) : "(no rule id)";

  let text: unknown;
  const msg = own(result, "message");
  if (isObject(msg)) {
    text = own(msg, "text");
    if (typeof text !== "string") text = own(msg, "markdown");
  }
  const message = typeof text === "string" && text !== "" ? clean(text, MESSAGE_MAX) : "(no message)";

  const finding: Finding = { check, ruleId: ruleId || "(no rule id)", level, message: message || "(no message)" };

  const locs = own(result, "locations");
  const loc = Array.isArray(locs) ? locs[0] : undefined;
  const phys = isObject(loc) ? own(loc, "physicalLocation") : undefined;
  if (isObject(phys)) {
    const art = own(phys, "artifactLocation");
    const uri = isObject(art) ? own(art, "uri") : undefined;
    if (typeof uri === "string" && uri !== "") {
      const region = own(phys, "region");
      const line = isObject(region) ? own(region, "startLine") : undefined;
      const suffix = typeof line === "number" && Number.isInteger(line) && line > 0 ? `:${line}` : "";
      // Cap the uri to leave room for the line, so the line survives.
      const location = `${clean(uri, LOCATION_MAX - suffix.length)}${suffix}`;
      if (location) finding.location = location;
    }
  }

  const props = own(result, "properties");
  const sev = isObject(props) ? own(props, "security-severity") : undefined;
  if (typeof sev === "string" || typeof sev === "number") {
    const s = clean(String(sev), SEVERITY_MAX);
    if (s) finding.securitySeverity = s;
  }
  return finding;
}
