import type { OptionSpec, ParsedHelp, SubcommandSpec } from "../types.js";
import { cleanTerminalText, oneLine } from "../util/text.js";

/**
 * Heuristic parser for `--help` output. It understands the conventions of the
 * common CLI frameworks (argparse, click, clap, cobra, commander, yargs, Go's
 * `flag`, GNU getopt_long) well enough to recover options and subcommands,
 * and degrades to "no structure found" rather than guessing.
 */

type Section = "usage" | "commands" | "options" | "args" | "examples" | "other" | null;

const RESERVED_PROPS = new Set(["args", "stdin", "cwd", "timeout_seconds"]);
const HIDDEN_FLAGS = new Set(["--help", "-h", "--version", "-V", "-?"]);
const HIDDEN_COMMANDS = new Set(["help"]);
const MAX_DESC = 240;

function classifyHeader(title: string): Exclude<Section, null> {
  if (/\busage\b/i.test(title)) return "usage";
  if (/\bexamples?\b/i.test(title)) return "examples";
  if (/\b(options?|flags?|switches)\b/i.test(title)) return "options";
  if (/\b(sub-?)?commands?\b/i.test(title)) return "commands";
  if (/\b(arguments?|args|positionals?)\b/i.test(title)) return "args";
  return "other";
}

interface Header {
  kind: Exclude<Section, null>;
  /** Text after the header on the same line ("Usage: foo [options]"). */
  inline: string;
}

function parseHeader(line: string): Header | null {
  const indent = line.length - line.trimStart().length;
  const t = line.trim();
  if (!t || indent > 3 || t.startsWith("-")) return null;
  // Go's flag package: "Usage of <program>:" followed directly by the flags.
  if (/^usage of .*:$/i.test(t)) return { kind: "options", inline: "" };
  const usage = /^usage:?(?:\s+(.*))?$/i.exec(t);
  if (usage) return { kind: "usage", inline: usage[1] ?? "" };
  if (t.length <= 70 && t.endsWith(":") && !/\s{2,}/.test(t)) {
    return { kind: classifyHeader(t.slice(0, -1)), inline: "" };
  }
  if (/^[A-Z][A-Z0-9 _-]{2,40}$/.test(t)) return { kind: classifyHeader(t), inline: "" };
  return null;
}

/** Split an option spec into alternatives at top-level `,` `|` `/` or before a new `-flag`. */
function splitAlternatives(spec: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < spec.length; i++) {
    const ch = spec[i]!;
    if ("<[{(".includes(ch)) depth++;
    else if (">]})".includes(ch)) depth = Math.max(0, depth - 1);
    if (depth === 0) {
      const next = spec[i + 1];
      if (ch === "," || ch === "|" || (ch === "/" && /^\s*-/.test(spec.slice(i + 1)))) {
        parts.push(cur);
        cur = "";
        continue;
      }
      if (/\s/.test(ch) && next === "-" && cur.trim().startsWith("-")) {
        parts.push(cur);
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

const VALUE_TOKEN = String.raw`(?:<[^>]+>|\[[^\]]+\]|\{[^}]+\}|[A-Za-z_][\w|.:=-]*)`;
const VALUE = new RegExp(String.raw`^${VALUE_TOKEN}(?:\s+(?:<[^>]+>|\[[^\]]+\]|[A-Z_][A-Z0-9_]*))*(?:\.\.\.)?$`);

interface Alt {
  flag: string;
  long: boolean;
  negatable: boolean;
  value?: string;
  optionalValue: boolean;
}

function parseAlternative(alt: string): Alt | null {
  const m = /^(--?)(\[no-\])?([A-Za-z0-9?@#][\w.-]*)(.*)$/.exec(alt);
  if (!m) return null;
  const dash = m[1]!;
  const name = m[3]!;
  let rest = m[4]!.replace(/\.\.\.$/, "").trimEnd();
  let value: string | undefined;
  let optionalValue = false;
  if (rest !== "") {
    if (rest.startsWith("[") && rest.endsWith("]") && !rest.startsWith("[no-")) {
      optionalValue = true;
      value = rest.slice(1, -1).replace(/^=/, "").trim();
    } else if (rest.startsWith("=")) {
      value = rest.slice(1).trim();
    } else if (/^\s/.test(rest) || (dash === "-" && name.length === 1)) {
      value = rest.trim();
    } else {
      return null;
    }
    if (!value || !VALUE.test(value)) return null;
  }
  return {
    flag: `${dash}${name}`,
    long: dash === "--" || name.length > 1,
    negatable: Boolean(m[2]),
    value,
    optionalValue,
  };
}

function choicesFrom(value: string | undefined, description: string): string[] | undefined {
  const lists: string[] = [];
  if (value) {
    const inner = /^[<{[](.*)[>}\]]$/.exec(value)?.[1] ?? value;
    if (/[|,]/.test(inner)) lists.push(inner);
  }
  const inDesc = /[[(](?:possible values|choices|one of|allowed values)\s*:\s*([^\])]+)[\])]/i.exec(description);
  if (inDesc) lists.push(inDesc[1]!);
  for (const list of lists) {
    const items = list
      .split(/[|,]/)
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    if (items.length >= 2 && items.length <= 30 && items.every((s) => /^[\w.:+-]{1,40}$/.test(s))) return items;
  }
  return undefined;
}

interface RawOption {
  flag: string;
  short?: string;
  takesValue: boolean;
  optionalValue: boolean;
  valueName?: string;
  negatable: boolean;
  description: string;
}

/**
 * Parse one help line as an option definition, or return null.
 *
 * `lenient` also accepts `--flag Description text` with a single space before
 * the description. That shape is ambiguous with wrapped prose, so callers only
 * enable it for lines aligned with a previously recognized option.
 */
export function parseOptionLine(line: string, lenient = false): RawOption | null {
  const t = line.trim();
  if (!t.startsWith("-") || t.startsWith("---")) return null;
  const gap = /\s{2,}/.exec(t);
  let spec = gap ? t.slice(0, gap.index) : t;
  let description = gap ? t.slice(gap.index).trim() : "";
  let alts = spec.length > 90 ? [null] : splitAlternatives(spec).map(parseAlternative);
  if (lenient && (alts.length === 0 || alts.some((a) => a === null))) {
    const m = /^((?:-[A-Za-z0-9],\s*)?--?[A-Za-z0-9][\w.-]*)\s([A-Z(].*\s.*)$/.exec(t);
    if (!m || /^[A-Z0-9_]+\s/.test(m[2]!)) return null;
    spec = m[1]!;
    description = m[2]!.trim();
    alts = splitAlternatives(spec).map(parseAlternative);
  }
  if (alts.length === 0 || alts.length > 4 || alts.some((a) => a === null)) return null;
  const parsed = alts as Alt[];
  const long = parsed.find((a) => a.long);
  const short = parsed.find((a) => !a.long);
  const withValue = parsed.find((a) => a.value !== undefined);
  return {
    flag: (long ?? short)!.flag,
    short: long && short ? short.flag : undefined,
    takesValue: Boolean(withValue),
    optionalValue: Boolean(withValue?.optionalValue),
    valueName: withValue?.value,
    negatable: parsed.some((a) => a.negatable),
    description,
  };
}

function propName(flag: string, taken: Set<string>): string {
  let base = flag.replace(/^-+/, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "flag";
  if (/^[0-9]/.test(base)) base = `n${base}`;
  if (RESERVED_PROPS.has(base)) base = `opt_${base}`;
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
  taken.add(name);
  return name;
}

const COMMAND_LINE =
  /^(\s{1,10})([A-Za-z0-9][\w:.+-]*)((?:[,|]\s*[\w:.+-]+)*)((?:\s(?:[<[][^\s]*[>\]](?:\.\.\.)?|[A-Z_]{2,}(?:\.\.\.)?))*)(?:\s{2,}(\S.*))?$/;
const COMMAND_LIST = /^\s+[\w:.+-]+(?:,\s*[\w:.+-]+){2,},?\s*$/;
const COMMAND_NAME = /^[A-Za-z0-9][\w:.+-]{0,40}$/;

export function parseHelp(raw: string): ParsedHelp {
  const lines = cleanTerminalText(raw).split("\n").slice(0, 2000);
  const options: RawOption[] = [];
  const subs = new Map<string, SubcommandSpec>();
  const summaryLines: string[] = [];
  const usageLines: string[] = [];

  let section: Section = null;
  let summaryDone = false;
  let commandIndent = -1;
  let lastOption: RawOption | null = null;
  let lastOptionIndent = 0;
  let lastSub: SubcommandSpec | null = null;
  let argparseSubs: Set<string> | null = null;

  const addSub = (name: string, description: string): SubcommandSpec | null => {
    if (!COMMAND_NAME.test(name) || HIDDEN_COMMANDS.has(name)) return null;
    const existing = subs.get(name);
    if (existing) {
      if (!existing.description && description) existing.description = description;
      return existing;
    }
    const spec = { name, description };
    subs.set(name, spec);
    return spec;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const indent = line.length - line.trimStart().length;

    if (!trimmed) {
      if (section === "usage") section = null;
      if (summaryLines.length > 0) summaryDone = true;
      lastOption = null;
      lastSub = null;
      continue;
    }

    const header = parseHeader(line);
    if (header) {
      section = header.kind;
      commandIndent = -1;
      lastOption = null;
      lastSub = null;
      if (header.kind === "usage" && header.inline) usageLines.push(header.inline);
      if (summaryLines.length > 0) summaryDone = true;
      continue;
    }

    // Terse tools list their flags right under the usage line, with no blank between.
    if (section === "usage" && trimmed.startsWith("-") && parseOptionLine(line)) section = null;
    if (section === "usage") {
      if (usageLines.length < 4) usageLines.push(trimmed);
      continue;
    }
    if (section === "examples") continue;

    // argparse: "{init,run,build}" enumerates subcommands; details follow, deeper.
    const braces = /^\s+\{([\w:.+-]+(?:,[\w:.+-]+)*)\}/.exec(line);
    if (braces && !trimmed.startsWith("-")) {
      argparseSubs = new Set(braces[1]!.split(","));
      for (const name of argparseSubs) addSub(name, "");
      continue;
    }
    if (argparseSubs) {
      const detail = /^\s+([\w:.+-]+)\s{2,}(\S.*)$/.exec(line);
      if (detail && argparseSubs.has(detail[1]!)) {
        addSub(detail[1]!, oneLine(detail[2]!, MAX_DESC));
        continue;
      }
    }

    if (trimmed.startsWith("-")) {
      const opt = parseOptionLine(line, lastOption !== null && indent === lastOptionIndent);
      if (opt) {
        options.push(opt);
        lastOption = opt;
        lastOptionIndent = indent;
        lastSub = null;
        continue;
      }
    }

    if (section === "commands") {
      if (COMMAND_LIST.test(line)) {
        for (const name of trimmed.split(",")) addSub(name.trim(), "");
        continue;
      }
      const m = COMMAND_LINE.exec(line);
      if (m && (commandIndent < 0 || indent === commandIndent)) {
        commandIndent = indent;
        lastSub = addSub(m[2]!, oneLine(m[5] ?? "", MAX_DESC));
        continue;
      }
      if (lastSub && indent > commandIndent && lastSub.description.length < MAX_DESC) {
        lastSub.description = oneLine(`${lastSub.description} ${trimmed}`, MAX_DESC);
      }
      continue;
    }

    if (lastOption && indent > lastOptionIndent && lastOption.description.length < MAX_DESC) {
      lastOption.description = `${lastOption.description} ${trimmed}`.trim();
      continue;
    }

    if (section === null && !summaryDone && indent <= 2 && summaryLines.length < 3) {
      summaryLines.push(trimmed);
    }
  }

  const taken = new Set<string>();
  const seenFlags = new Set<string>();
  const specs: OptionSpec[] = [];
  for (const o of options) {
    if (HIDDEN_FLAGS.has(o.flag)) continue;
    if (seenFlags.has(o.flag)) continue;
    seenFlags.add(o.flag);
    const choices = o.takesValue ? choicesFrom(o.valueName, o.description) : undefined;
    let description = oneLine(o.description, MAX_DESC);
    if (o.negatable) description = `${description} (negate with --no-${o.flag.replace(/^-+/, "")} via args)`.trim();
    specs.push({
      prop: propName(o.flag, taken),
      flag: o.flag,
      short: o.short,
      takesValue: o.takesValue,
      optionalValue: o.optionalValue || undefined,
      valueName: o.valueName,
      choices,
      description,
    });
  }

  return {
    summary: oneLine(summaryLines.join(" "), 300),
    usage: oneLine(usageLines.join(" "), 240),
    options: specs,
    subcommands: [...subs.values()],
  };
}

/** Does this text plausibly document a command line interface? */
export function looksLikeHelp(text: string): boolean {
  const t = cleanTerminalText(text);
  if (t.trim().length < 20) return false;
  if (/\b(usage|options|commands|flags|synopsis)\b/i.test(t)) return true;
  return t.split("\n").filter((l) => parseOptionLine(l) !== null).length >= 2;
}
