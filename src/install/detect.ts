import { parse as parseToml } from "smol-toml";
import type { ProbeData } from "../sandbox/scripts.js";
import type { Ecosystem } from "../types.js";

export interface Detection {
  /** Every ecosystem with evidence in the repository root, strongest first. */
  ecosystems: Ecosystem[];
  primary: Ecosystem;
  license?: string;
  npmScripts: string[];
  makeTargets: string[];
  /** The root manifests depend on an MCP SDK. */
  mcpHint: boolean;
  notes: string[];
}

type Dict = Record<string, unknown>;
const dict = (v: unknown): Dict => (v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : {});

function safeJson(text: string | undefined): Dict {
  if (!text) return {};
  try {
    return dict(JSON.parse(text));
  } catch {
    return {};
  }
}

function safeToml(text: string | undefined): Dict {
  if (!text) return {};
  try {
    return dict(parseToml(text));
  } catch {
    return {};
  }
}

const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,60}$/;

/** Explicit, non-pattern targets of a Makefile, in file order. */
export function parseMakeTargets(makefile: string): string[] {
  const targets: string[] = [];
  for (const line of makefile.split("\n")) {
    const m = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\s*:(?!=)/.exec(line);
    if (!m) continue;
    const name = m[1]!;
    if (name.includes("%") || /\.(o|c|h|a|so)$/.test(name) || targets.includes(name)) continue;
    targets.push(name);
    if (targets.length >= 40) break;
  }
  return targets;
}

function licenseOf(data: ProbeData, pkg: Dict, cargo: Dict, pyproject: Dict): string | undefined {
  const declared = [
    pkg.license,
    dict(cargo.package).license,
    dict(pyproject.project).license,
    dict(dict(pyproject.project).license).text,
  ].find((v): v is string => typeof v === "string" && v.length > 0 && v.length < 80);
  if (declared) return declared;
  const file = data.entries.find((e) => !e.dir && /^(licen[sc]e|copying|unlicense)([.-].*)?$/i.test(e.name));
  return file ? `see ${file.name}` : undefined;
}

const PY_MCP = /^\s*["']?(mcp|fastmcp)(\[[^\]]*\])?\s*(["',;<>=!~@ ]|$)/im;

/** Do the root manifests declare a dependency on a known MCP server SDK? */
function dependsOnMcpSdk(data: ProbeData, pkg: Dict, pyproject: Dict, cargo: Dict): boolean {
  const npmDeps = { ...dict(pkg.dependencies), ...dict(pkg.peerDependencies) };
  if (Object.keys(npmDeps).some((d) => d.startsWith("@modelcontextprotocol/") || d === "fastmcp" || d === "mcp-framework")) {
    return true;
  }
  const pyDeps = dict(pyproject.project).dependencies;
  if (Array.isArray(pyDeps) && pyDeps.some((d) => typeof d === "string" && PY_MCP.test(d))) return true;
  const poetry = dict(dict(dict(pyproject.tool).poetry).dependencies);
  if ("mcp" in poetry || "fastmcp" in poetry) return true;
  if (PY_MCP.test(data.files["requirements.txt"] ?? "")) return true;
  const crates = dict(cargo.dependencies);
  if (["rmcp", "rust-mcp-sdk", "mcp-server", "mcp-sdk"].some((c) => c in crates)) return true;
  return /github\.com\/(mark3labs\/mcp-go|modelcontextprotocol\/go-sdk|metoro-io\/mcp-golang)\b/.test(data.files["go.mod"] ?? "");
}

/**
 * Decide how to build a repository from its root listing and manifests.
 *
 * Priority when several ecosystems are present: a compiled toolchain at the
 * root (Rust, Go) usually *is* the project, with Python/Node manifests there
 * for packaging or docs; Python packaging beats a package.json that merely
 * carries frontend/dev tooling.
 */
export function detect(data: ProbeData): Detection {
  const names = new Set(data.entries.map((e) => e.name));
  const has = (n: string) => names.has(n);
  const notes: string[] = [];

  const pkg = safeJson(data.files["package.json"]);
  const pyproject = safeToml(data.files["pyproject.toml"]);
  const cargo = safeToml(data.files["Cargo.toml"]);

  const strong: Ecosystem[] = [];
  const weak: Ecosystem[] = [];

  if (has("Cargo.toml") && (cargo.package || cargo.workspace)) strong.push("rust");
  if (has("go.mod")) strong.push("go");

  const pyPackaged =
    has("setup.py") ||
    Boolean(pyproject.project || pyproject["build-system"] || dict(pyproject.tool).poetry) ||
    /^\[metadata\]/m.test(data.files["setup.cfg"] ?? "");
  if (pyPackaged) strong.push("python");
  else if (has("requirements.txt") || has("pyproject.toml")) weak.push("python");

  if (has("package.json")) {
    const real = Boolean(pkg.bin || pkg.main || pkg.exports || pkg.dependencies || pkg.module);
    (real ? strong : weak).push("node");
  }

  if (has("Gemfile") || data.entries.some((e) => !e.dir && e.name.endsWith(".gemspec"))) strong.push("ruby");
  if (has("CMakeLists.txt")) weak.push("cmake");
  if (has("configure") || has("configure.ac")) weak.push("autotools");
  const makefile = data.files.Makefile ?? data.files.GNUmakefile ?? data.files.makefile;
  if (makefile !== undefined) weak.push("make");

  const ecosystems = [...strong, ...weak];
  if (ecosystems.length === 0) {
    ecosystems.push("generic");
    notes.push("No recognized build manifest in the repository root; nothing was built automatically.");
  }
  if (strong.length > 1) {
    notes.push(`Multiple ecosystems detected (${strong.join(", ")}); built as ${ecosystems[0]}.`);
  }

  const scripts = Object.keys(dict(pkg.scripts)).filter((s) => SCRIPT_NAME.test(s)).slice(0, 40);

  return {
    ecosystems,
    primary: ecosystems[0]!,
    license: licenseOf(data, pkg, cargo, pyproject),
    npmScripts: scripts,
    makeTargets: makefile ? parseMakeTargets(makefile) : [],
    mcpHint: dependsOnMcpSdk(data, pkg, pyproject, cargo),
    notes,
  };
}
