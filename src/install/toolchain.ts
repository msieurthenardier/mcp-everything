import semver from "semver";
import { parse as parseToml } from "smol-toml";
import type { ProbeData } from "../sandbox/docker.js";
import type { Ecosystem } from "../types.js";

/**
 * Choosing the language runtime a project asks for.
 *
 * Evidence is used in this order:
 *   1. an exact pin (.nvmrc, .python-version, .tool-versions, ...): what the
 *      project's own developers and CI run;
 *   2. a declared range (engines.node, requires-python): a claim about what
 *      should work, which is sometimes wider than what does;
 *   3. the configured default image.
 *
 * A range can admit several runtimes, so besides the first choice this
 * returns the other candidates, for a retry if the build fails.
 */

export interface ToolchainChoice {
  image: string;
  /** Other images that satisfy the same evidence, best first. */
  fallbacks: string[];
  /** Human-readable account of why this image was chosen. */
  reason: string;
}

/**
 * Runtime lines to consider when only a range is known, preferred first.
 * These lists age: extend them when new release lines appear. A pin never
 * consults them, so pinned projects keep working regardless.
 */
const NODE_LINES = [26, 24, 22, 20, 18];
const PYTHON_LINES = ["3.13", "3.14", "3.12", "3.11", "3.10", "3.9", "3.15", "3.8"];

const NODE_CODENAMES: Record<string, number> = { hydrogen: 18, iron: 20, jod: 22, krypton: 24 };

type Dict = Record<string, unknown>;
const dict = (v: unknown): Dict => (v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : {});
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function json(source: string | undefined): Dict {
  try {
    return dict(JSON.parse(source ?? ""));
  } catch {
    return {};
  }
}

function toml(source: string | undefined): Dict {
  try {
    return dict(parseToml(source ?? ""));
  } catch {
    return {};
  }
}

/** First meaningful line of a one-value file such as .nvmrc. */
function firstLine(source: string | undefined): string | undefined {
  for (const line of (source ?? "").split("\n")) {
    const t = line.replace(/#.*$/, "").trim();
    if (t) return t;
  }
  return undefined;
}

/** Version of `tool` in an asdf/mise `.tool-versions` file. */
export function toolVersion(source: string | undefined, ...tools: string[]): string | undefined {
  for (const line of (source ?? "").split("\n")) {
    const [tool, version] = line.replace(/#.*$/, "").trim().split(/\s+/);
    if (tool && version && tools.includes(tool)) return version;
  }
  return undefined;
}

interface Pin {
  value: string;
  source: string;
}

function firstPin(candidates: Array<[string | undefined, string]>): Pin | undefined {
  for (const [value, source] of candidates) if (value) return { value, source };
  return undefined;
}

// ---------------------------------------------------------------- Node.js

/** Major version named by a Node pin ("24.22.1", "v24", "lts/jod"), if it names one. */
export function nodeMajor(pin: string): number | undefined {
  const lts = /^lts\/([a-z]+)$/i.exec(pin);
  if (lts) return NODE_CODENAMES[lts[1]!.toLowerCase()];
  const m = /^v?(\d{1,3})(?:\.[\dx*]+){0,2}$/i.exec(pin);
  return m ? Number(m[1]) : undefined;
}

function chooseNode(data: ProbeData, fallbackImage: string): ToolchainChoice {
  const pkg = json(data.files["package.json"]);
  const pin = firstPin([
    [firstLine(data.files[".nvmrc"]), ".nvmrc"],
    [firstLine(data.files[".node-version"]), ".node-version"],
    [toolVersion(data.files[".tool-versions"], "nodejs", "node"), ".tool-versions"],
    [text(dict(pkg.volta).node), "volta.node in package.json"],
  ]);
  if (pin) {
    const major = nodeMajor(pin.value);
    if (major !== undefined && major >= 4) {
      return { image: `node:${major}`, fallbacks: [], reason: `Node ${major}, pinned by ${pin.source} (${pin.value})` };
    }
  }
  const range = text(dict(pkg.engines).node);
  if (range && semver.validRange(range)) {
    const lines = NODE_LINES.filter((major) => semver.intersects(range, `${major}.x`));
    if (lines.length > 0) {
      const [first, ...rest] = lines.map((major) => `node:${major}`);
      return {
        image: first!,
        fallbacks: rest,
        reason: `Node ${lines[0]}, the newest supported line allowed by engines.node (${range})`,
      };
    }
  }
  return { image: fallbackImage, fallbacks: [], reason: "default Node image; the project declares no usable Node version" };
}

// ----------------------------------------------------------------- Python

type Version = number[];

function parseVersion(value: string): Version | undefined {
  const m = /^v?(\d+(?:\.\d+)*)/.exec(value.trim());
  return m ? m[1]!.split(".").map(Number) : undefined;
}

function compare(a: Version, b: Version, width: number): number {
  for (let i = 0; i < width; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Does release line `line` ("3.12") satisfy a version specifier set?
 * Understands PEP 440 (">=3.9,<3.13", "~=3.11", "==3.12.*") and Poetry's
 * caret/tilde ("^3.9", "~3.11"). Comparison is on major.minor: a line
 * satisfies a bound if some patch release of it can.
 */
export function pythonLineSatisfies(line: string, spec: string): boolean {
  const have = parseVersion(line)!;
  for (const raw of spec.split(/[,|]{1,2}|\s+(?=[<>=!~^])/)) {
    const clause = raw.trim();
    if (!clause) continue;
    const m = /^(===|==|!=|>=|<=|~=|>|<|\^|~)?\s*v?(\d+(?:\.\d+)*)(\.\*)?$/.exec(clause);
    if (!m) return false;
    const op = m[1] ?? "==";
    const want = m[2]!.split(".").map(Number);
    const cmp = compare(have, want, 2);
    const sameMajor = have[0] === want[0];
    let ok: boolean;
    switch (op) {
      case ">=":
        ok = cmp >= 0;
        break;
      case ">":
        // ">3.9" admits 3.9.1, so only a bound with no minor excludes its own line.
        ok = want.length >= 2 ? cmp >= 0 : cmp > 0;
        break;
      case "<=":
        ok = cmp <= 0;
        break;
      case "<":
        // "<3.13" excludes all of 3.13; "<3.13.5" still admits 3.13.4.
        ok = want.length >= 3 ? cmp <= 0 : cmp < 0;
        break;
      case "!=":
        ok = want.length >= 3 ? true : cmp !== 0;
        break;
      case "~=":
      case "~":
        // ~=3.11 means >=3.11,<4 ; ~=3.11.2 and Poetry ~3.11 mean 3.11.x
        ok = want.length >= 3 || op === "~" ? cmp === 0 : sameMajor && cmp >= 0;
        break;
      case "^":
        ok = sameMajor && cmp >= 0;
        break;
      default:
        ok = want.length === 1 ? sameMajor : cmp === 0;
    }
    if (!ok) return false;
  }
  return true;
}

function pythonRange(data: ProbeData): Pin | undefined {
  const pyproject = toml(data.files["pyproject.toml"]);
  const cfg = /^\s*python_requires\s*=\s*(.+)$/m.exec(data.files["setup.cfg"] ?? "")?.[1];
  const setup = /python_requires\s*=\s*["']([^"']+)["']/.exec(data.files["setup.py"] ?? "")?.[1];
  return firstPin([
    [text(dict(pyproject.project)["requires-python"]), "requires-python in pyproject.toml"],
    [text(dict(dict(dict(pyproject.tool).poetry).dependencies).python), "tool.poetry.dependencies.python"],
    [text(cfg), "python_requires in setup.cfg"],
    [text(setup), "python_requires in setup.py"],
  ]);
}

function choosePython(data: ProbeData, fallbackImage: string): ToolchainChoice {
  const pin = firstPin([
    [firstLine(data.files[".python-version"]), ".python-version"],
    [toolVersion(data.files[".tool-versions"], "python"), ".tool-versions"],
  ]);
  const pinned = pin ? /^(?:cpython-)?(\d+)\.(\d+)/.exec(pin.value) : null;
  if (pin && pinned) {
    const line = `${pinned[1]}.${pinned[2]}`;
    return { image: `python:${line}`, fallbacks: [], reason: `Python ${line}, pinned by ${pin.source} (${pin.value})` };
  }
  const range = pythonRange(data);
  if (range) {
    const lines = PYTHON_LINES.filter((line) => pythonLineSatisfies(line, range.value));
    if (lines.length > 0) {
      const [first, ...rest] = lines.map((line) => `python:${line}`);
      return {
        image: first!,
        fallbacks: rest,
        reason: `Python ${lines[0]}, the preferred line allowed by ${range.source} (${range.value})`,
      };
    }
  }
  return { image: fallbackImage, fallbacks: [], reason: "default Python image; the project declares no usable Python version" };
}

// ------------------------------------------------------------------- Ruby

function chooseRuby(data: ProbeData, fallbackImage: string): ToolchainChoice {
  const gemfile = /^\s*ruby\s+["']\s*(?:[~>=]+\s*)?(\d+\.\d+(?:\.\d+)?)/m.exec(data.files.Gemfile ?? "")?.[1];
  const pin = firstPin([
    [firstLine(data.files[".ruby-version"])?.replace(/^ruby-/, ""), ".ruby-version"],
    [toolVersion(data.files[".tool-versions"], "ruby"), ".tool-versions"],
    [gemfile, "the ruby directive in Gemfile"],
  ]);
  const m = pin ? /^(\d+)\.(\d+)/.exec(pin.value) : null;
  if (pin && m) {
    const line = `${m[1]}.${m[2]}`;
    return { image: `ruby:${line}`, fallbacks: [], reason: `Ruby ${line}, pinned by ${pin.source} (${pin.value})` };
  }
  return { image: fallbackImage, fallbacks: [], reason: "default Ruby image; the project pins no Ruby version" };
}

// --------------------------------------------------------------- dispatch

/**
 * Pick the sandbox image for a project. `defaultImage` is the configured
 * image for the ecosystem; when `overridden` (the operator set it through the
 * environment) it is used as is.
 */
export function chooseToolchain(
  ecosystem: Ecosystem,
  data: ProbeData,
  defaultImage: string,
  overridden: boolean,
): ToolchainChoice {
  if (overridden) {
    return { image: defaultImage, fallbacks: [], reason: "image set by the server's configuration" };
  }
  switch (ecosystem) {
    case "node":
      return chooseNode(data, defaultImage);
    case "python":
      return choosePython(data, defaultImage);
    case "ruby":
      return chooseRuby(data, defaultImage);
    case "rust": {
      const pinned = data.files["rust-toolchain.toml"] !== undefined || data.files["rust-toolchain"] !== undefined;
      return {
        image: defaultImage,
        fallbacks: [],
        reason: pinned
          ? "default Rust image; rustup installs the toolchain pinned by rust-toolchain during the build"
          : "default Rust image (latest stable)",
      };
    }
    case "go": {
      const gomod = data.files["go.mod"] ?? "";
      const directive = (/^\s*(toolchain\s+go[\d.]+\S*)\s*$/m.exec(gomod) ?? /^\s*(go\s+[\d.]+\S*)\s*$/m.exec(gomod))?.[1];
      return {
        image: defaultImage,
        fallbacks: [],
        reason: directive
          ? `default Go image; the go command fetches the toolchain go.mod asks for (${directive.replace(/\s+/g, " ")}) if it is newer`
          : "default Go image",
      };
    }
    default:
      return { image: defaultImage, fallbacks: [], reason: "default image for this build system" };
  }
}
