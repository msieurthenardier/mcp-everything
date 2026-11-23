/**
 * The tool-description check: a reading aid over the text a generated tool carries to the agent that came from the
 * project. Pure, no I/O. Findings never quote the text they matched, the property names or the upstream names; they
 * hold a fixed sentence per rule and a location made of the generated tool name and mcp-everything's own field label.
 * Every regex is written with `\u{…}` escapes: no invisible character appears in this file.
 */
import { emptyCounts, MAX_FINDINGS } from "./sarif.js";
import { clean } from "./util.js";
import { LEVELS, type CheckOutcome, type Finding, type Level } from "./types.js";

export const CHECK_NAME = "tool-descriptions";
export const CHECK_FAILED = "the tool-description check could not complete";

export interface ToolTextField {
  /** Made only of mcp-everything's own words and positions. */
  field: string;
  text: string;
}

export interface ToolTextEntry {
  /** The generated tool name. */
  tool: string;
  fields: ToolTextField[];
}

interface Hit {
  codepoints?: Map<number, number>;
}

interface Rule {
  id: string;
  level: Level;
  message: string;
  /** `raw` is the field's text as it came; `norm` is the same text after NFKC. */
  match(raw: string, norm: string, field: string): Hit | undefined;
}

// Hidden characters: tag characters and bidirectional overrides and embeddings. A flag tag sequence (England,
// Scotland, Wales) is an emoji, not hidden text.
const FLAG_TAGS = /\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}/gu;
const HIDDEN = /[\u{E0000}-\u{E007F}\u{202A}-\u{202E}]/gu;
// Isolates and zero-width characters occur in genuine right-to-left and Persian text; a ZWJ between pictographs
// (with optional variation selector or skin tone) is an emoji sequence.
const INVISIBLE = /[\u{2066}-\u{2069}\u{200B}\u{200C}\u{200D}\u{2060}\u{FEFF}]/gu;
const EMOJI_ZWJ = /(?<=\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}]*)\u{200D}(?=\p{Extended_Pictographic})/gu;

const OVERRIDE: RegExp[] = [
  /\b(ignore|disregard|forget)\s+(?:(?:all|any|the|of)\s+){0,3}(previous|prior|above|earlier|preceding)\s+(instructions?|directions|rules|prompts?)\b/i,
  /\b(do\s+not|don'?t)\s+(tell|inform|mention|reveal)\s+(this|that|it|anything)\b[^.]{0,30}\b(to\s+)?(the\s+)?user\b/i,
  /\bwithout\s+(telling|informing|notifying)\s+the\s+user\b/i,
  /\bthe\s+user\s+(must|should)\s+not\s+(know|see|be\s+told)\b/i,
];

// Alphanumeric lookarounds, not `\b`: `_` is a word character, so `\b` would miss the form a client shows the agent
// (`mcp__mcp-everything__install_project`).
const NAMES_CONTROL =
  /(?<![A-Za-z0-9])(?:install_project|uninstall_project|set_project_hosts|set_project_network|sandbox_exec|sandbox_write_file|connect_mcp_server|select_project_tools|call_project_tool)(?![A-Za-z0-9])/i;

// `<system>` is an ordinary placeholder in usage and option text, so the tag form counts only where a project
// writes prose for the agent.
const DIRECTIVE_TAG = /<\s*\/?\s*(important|system)\s*>/i;
const DIRECTIVE_TAG_FIELDS = new Set(["upstream.description", "help.summary"]);
const DIRECTIVE: RegExp[] = [
  /\bbefore\s+(using|calling|invoking)\s+(this|any(\s+other)?)\s+tools?\b(?!\s*chain)/i,
  /\byou\s+must\s+(first|always)\b[^.]{0,60}\b(read|send|call|upload)\b/i,
];

const SECRET_TERMS: RegExp[] = [
  /~\/\.ssh/i,
  /\bid_(rsa|ed25519)\b/i,
  /(?<![\w.])\.env\b/i,
  /\bmcp\.json\b/i,
  /claude_desktop_config/i,
  /\bcredentials\b/i,
  /\bapi[ _-]?key\b/i,
  /\bprivate key\b/i,
];
// No bare-destination alternative ("pass to the server" is ordinary help text); `post` only toward a URL.
const SENDING: RegExp[] = [
  /\b(send|upload|exfiltrate|attach|forward|transmit)\b/i,
  /\bpost\b[^.]{0,60}\bto\s+https?:\/\//i,
];
// A split on every `.` would cut `~/.ssh`, `.env` and `mcp.json` in half.
const SENTENCES = /[.!?]+(?=\s|$)|\n+/;

function countPoints(text: string, re: RegExp): Map<number, number> | undefined {
  const counts = new Map<number, number>();
  for (const m of text.matchAll(re)) {
    const cp = m[0].codePointAt(0)!;
    counts.set(cp, (counts.get(cp) ?? 0) + 1);
  }
  return counts.size > 0 ? counts : undefined;
}

function points(counts: Map<number, number>): string {
  return [...counts]
    .sort((a, b) => a[0] - b[0])
    .slice(0, 8)
    .map(([cp, n]) => `U+${cp.toString(16).toUpperCase().padStart(4, "0")} ×${n}`)
    .join(", ");
}

export const TOOL_TEXT_RULES: readonly Rule[] = [
  {
    id: "hidden-characters",
    level: "error",
    message: "Text of this tool contains hidden characters (tag characters or bidirectional overrides)",
    match(raw) {
      const codepoints = countPoints(raw.replace(FLAG_TAGS, ""), HIDDEN);
      return codepoints ? { codepoints } : undefined;
    },
  },
  {
    id: "override-instructions",
    level: "error",
    message: "Text of this tool tells the reader to disregard its instructions or to hide something from the user",
    match: (_raw, norm) => (OVERRIDE.some((re) => re.test(norm)) ? {} : undefined),
  },
  {
    id: "names-control-tool",
    level: "error",
    message: "Text of this tool names one of mcp-everything's own tools that change trust or reach",
    // A project that is itself an MCP server may own such a tool name; its descriptions are not exempt.
    match: (_raw, norm, field) => (field !== "upstream.name" && NAMES_CONTROL.test(norm) ? {} : undefined),
  },
  {
    id: "invisible-characters",
    level: "warning",
    message: "Text of this tool contains invisible characters (isolates or zero-width characters)",
    match(raw) {
      const codepoints = countPoints(raw.replace(EMOJI_ZWJ, ""), INVISIBLE);
      return codepoints ? { codepoints } : undefined;
    },
  },
  {
    id: "agent-directive",
    level: "warning",
    message: "Text of this tool contains a directive aimed at the agent",
    match(_raw, norm, field) {
      if (DIRECTIVE_TAG_FIELDS.has(field) && DIRECTIVE_TAG.test(norm)) return {};
      return DIRECTIVE.some((re) => re.test(norm)) ? {} : undefined;
    },
  },
  {
    id: "secret-reference",
    level: "warning",
    message: "Text of this tool names a credential or secret file in a sentence that sends something",
    match: (_raw, norm) =>
      norm.split(SENTENCES).some((s) => SECRET_TERMS.some((re) => re.test(s)) && SENDING.some((re) => re.test(s))) ? {} : undefined,
  },
];

function failedOutcome(): CheckOutcome {
  return { name: CHECK_NAME, kind: "builtin", status: "failed", counts: emptyCounts(), findings: [], omitted: 0, notes: [], error: CHECK_FAILED };
}

/**
 * One finding per (tool, rule), citing the first matching field in source order. `byTool` holds every finding of every
 * tool in rule-table order; the outcome keeps at most `MAX_FINDINGS` (errors first, then catalog order) and counts all.
 */
export function checkToolText(entries: ToolTextEntry[]): { outcome: CheckOutcome; byTool: Map<string, Finding[]> } {
  try {
    const byTool = new Map<string, Finding[]>();
    const all: Finding[] = [];
    for (const entry of entries) {
      const norms = entry.fields.map((f) => f.text.normalize("NFKC"));
      for (const rule of TOOL_TEXT_RULES) {
        for (let i = 0; i < entry.fields.length; i++) {
          const f = entry.fields[i]!;
          const hit = rule.match(f.text, norms[i]!, f.field);
          if (!hit) continue;
          const detail = hit.codepoints ? ` (${points(hit.codepoints)})` : "";
          const finding: Finding = {
            check: CHECK_NAME,
            ruleId: rule.id,
            level: rule.level,
            message: `${rule.message}${detail}`,
            location: clean(`${entry.tool}: ${f.field}`, 120),
          };
          const list = byTool.get(entry.tool) ?? [];
          list.push(finding);
          byTool.set(entry.tool, list);
          all.push(finding);
          break;
        }
      }
    }
    const counts = emptyCounts();
    for (const f of all) counts[f.level]++;
    const kept: Finding[] = [];
    for (const level of LEVELS) {
      for (const f of all) if (f.level === level && kept.length < MAX_FINDINGS) kept.push(f);
    }
    return {
      outcome: { name: CHECK_NAME, kind: "builtin", status: "ran", counts, findings: kept, omitted: all.length - kept.length, notes: [] },
      byTool,
    };
  } catch {
    return { outcome: failedOutcome(), byTool: new Map() };
  }
}

export { failedOutcome as failedToolCheck };
