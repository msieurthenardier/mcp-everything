import { REPO_DIR, WORK_DIR } from "../sandbox/docker.js";
import type { CommandSpec, OptionSpec, ParsedHelp, ProjectMeta, ToolDef } from "../types.js";
import { oneLine } from "../util/text.js";
import { looksLikeHelp, parseHelp } from "./help-parser.js";
import { makeToolName } from "./naming.js";

/** Runs argv inside the project sandbox. */
export type SandboxExec = (
  argv: string[],
  opts: { timeoutSec: number; cwd?: string },
) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;

export interface HelpNode {
  /** Full command path, e.g. ["git", "remote", "add"]. */
  path: string[];
  help: ParsedHelp;
  /** Description of this node taken from its parent's command list. */
  blurb: string;
  children: HelpNode[];
}

export interface CrawlLimits {
  maxDepth: number;
  maxSubcommands: number;
  helpTimeoutSec: number;
  /** Shared across a whole project: total help invocations still allowed. */
  budget: { remaining: number };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchHelp(exec: SandboxExec, argv: string[], root: boolean, limits: CrawlLimits): Promise<string | null> {
  // Only the root command is probed with `-h` / `help`: for a subcommand those
  // may be real arguments ("-h" = human-readable) and would run it for real.
  const variants = root ? [["--help"], ["-h"], ["help"]] : [["--help"]];
  for (const variant of variants) {
    if (limits.budget.remaining <= 0) return null;
    limits.budget.remaining--;
    try {
      const res = await exec([...argv, ...variant], { timeoutSec: limits.helpTimeoutSec, cwd: WORK_DIR });
      const text = res.stdout.trim().split("\n").length >= 3 ? res.stdout : `${res.stdout}\n${res.stderr}`;
      if (looksLikeHelp(text)) return text;
    } catch {
      /* try the next variant */
    }
  }
  return null;
}

/** Recursively read `--help` for a command and its subcommands. */
export async function crawlCommand(exec: SandboxExec, command: string, limits: CrawlLimits): Promise<HelpNode | null> {
  const visit = async (path: string[], blurb: string, parentText: string | null): Promise<HelpNode | null> => {
    const text = await fetchHelp(exec, path, path.length === 1, limits);
    if (!text) return null;
    // A program that ignores the extra word prints its own help again.
    if (parentText !== null && text.trim() === parentText.trim()) return null;
    const help = parseHelp(text);
    const node: HelpNode = { path, help, blurb, children: [] };
    if (path.length - 1 < limits.maxDepth && help.subcommands.length > 0) {
      const subs = help.subcommands.slice(0, limits.maxSubcommands);
      const children = await mapLimit(subs, 4, (s) => visit([...path, s.name], s.description, text));
      node.children = children.filter((c): c is HelpNode => c !== null);
    }
    return node;
  };
  return visit([command], "", null);
}

const COMMON_PROPS = {
  args: {
    type: "array",
    items: { type: "string" },
    description: "Extra positional arguments/flags, appended verbatim.",
  },
  stdin: { type: "string", description: "Text piped to stdin." },
  cwd: {
    type: "string",
    description: `Working directory in the sandbox (default varies; scratch is ${WORK_DIR}, checkout is ${REPO_DIR}).`,
  },
  timeout_seconds: { type: "number", description: "Kill the command after this many seconds." },
} as const;

const MAX_OPTIONS_PER_TOOL = 40;

function optionSchema(opt: OptionSpec): Record<string, unknown> {
  const flags = opt.short ? `${opt.short}, ${opt.flag}` : opt.flag;
  const description = oneLine(`${flags}${opt.description ? `: ${opt.description}` : ""}`, 260);
  if (!opt.takesValue) return { type: "boolean", description };
  const schema: Record<string, unknown> = { type: "string", description };
  if (opt.choices) schema.enum = opt.choices;
  return schema;
}

function schemaFor(options: OptionSpec[], extra: Record<string, unknown> = {}, required: string[] = []) {
  const properties: Record<string, unknown> = { ...extra };
  for (const opt of options) properties[opt.prop] = optionSchema(opt);
  Object.assign(properties, COMMON_PROPS);
  const schema: Record<string, unknown> = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

function baseName(command: string): string {
  return command.split("/").filter(Boolean).pop() ?? command;
}

/** Marks every generated description as third-party text from a sandbox. */
function tag(repoId: string): string {
  return `[sandboxed ${repoId}]`;
}

function cliTool(slug: string, repoId: string, node: HelpNode, used: Set<string>): ToolDef {
  const display = [baseName(node.path[0]!), ...node.path.slice(1)].join(" ");
  const options = node.help.options.slice(0, MAX_OPTIONS_PER_TOOL);
  const summary = node.help.summary || node.blurb;
  const pieces = [`${tag(repoId)} Runs \`${display}\`.`];
  if (summary) pieces.push(summary.endsWith(".") ? summary : `${summary}.`);
  if (node.help.usage) pieces.push(`Usage: ${node.help.usage}`);
  if (node.help.subcommands.length > 0) {
    const names = node.help.subcommands.map((s) => s.name);
    const shown = names.slice(0, 30).join(", ");
    pieces.push(`Subcommands (pass as the first args): ${shown}${names.length > 30 ? ", …" : ""}.`);
  }
  if (node.help.options.length > options.length) {
    pieces.push(`${node.help.options.length - options.length} more options are available via args.`);
  }
  return {
    name: makeToolName(slug, [baseName(node.path[0]!), ...node.path.slice(1)], used),
    description: oneLine(pieces.join(" "), 900),
    inputSchema: schemaFor(options),
    kind: "cli",
    argv: node.path,
    options,
    cwd: WORK_DIR,
  };
}

function passthroughTool(slug: string, repoId: string, command: CommandSpec, used: Set<string>): ToolDef {
  return {
    name: makeToolName(slug, [baseName(command.name)], used),
    description: `${tag(repoId)} Runs \`${baseName(command.name)}\` (${command.origin}). No --help output was recognized, so pass everything via args.`,
    inputSchema: schemaFor([]),
    kind: "cli",
    argv: [command.name],
    options: [],
    cwd: WORK_DIR,
  };
}

function extraTools(slug: string, repoId: string, meta: ProjectMeta, used: Set<string>): ToolDef[] {
  const tools: ToolDef[] = [];
  if (meta.hasPythonEnv) {
    const mods = meta.pythonModules.slice(0, 12).join(", ");
    tools.push({
      name: makeToolName(slug, ["python"], used),
      description: `${tag(repoId)} Run Python code in the project's virtualenv, where the project is installed.${mods ? ` Importable modules: ${mods}.` : ""} args become sys.argv[1:].`,
      inputSchema: schemaFor([], { code: { type: "string", description: "Python source to execute." } }, ["code"]),
      kind: "code",
      argv: ["python", "-c"],
      options: [],
      cwd: WORK_DIR,
      valueProp: "code",
    });
  }
  if (meta.hasNode) {
    const pkgs = meta.nodePackages.slice(0, 6).join(", ");
    tools.push({
      name: makeToolName(slug, ["node"], used),
      description: `${tag(repoId)} Run JavaScript with Node.js from the repository root with dependencies installed${pkgs ? ` (packages: ${pkgs})` : ""}. Load the project with require("./") or await import(); print results with console.log.`,
      inputSchema: schemaFor([], { code: { type: "string", description: "JavaScript source to execute (CommonJS)." } }, ["code"]),
      kind: "code",
      argv: ["node", "-e"],
      options: [],
      cwd: REPO_DIR,
      valueProp: "code",
    });
  }
  if (meta.npmScripts.length > 0 && meta.hasNode) {
    tools.push({
      name: makeToolName(slug, ["npm_run"], used),
      description: `${tag(repoId)} Run one of the project's package.json scripts in the repository root. Put script arguments in args after "--".`,
      inputSchema: schemaFor([], { script: { type: "string", enum: meta.npmScripts, description: "Script name." } }, ["script"]),
      kind: "script",
      argv: ["npm", "run"],
      options: [],
      cwd: REPO_DIR,
      valueProp: "script",
    });
  }
  if (meta.makeTargets.length > 0) {
    tools.push({
      name: makeToolName(slug, ["make"], used),
      description: `${tag(repoId)} Run a Makefile target in the repository root.`,
      inputSchema: schemaFor([], { target: { type: "string", enum: meta.makeTargets, description: "Makefile target." } }, ["target"]),
      kind: "script",
      argv: ["make"],
      options: [],
      cwd: REPO_DIR,
      valueProp: "target",
    });
  }
  return tools;
}

const MAX_SCHEMA_BYTES = 20_000;

/**
 * Tools of an MCP server running inside the sandbox, republished under the
 * project's prefix. The upstream schema is passed through (the upstream
 * server validates the arguments); only its shape and size are checked.
 */
export function mcpTools(
  slug: string,
  repoId: string,
  server: string,
  upstream: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>,
  used: Set<string>,
): ToolDef[] {
  const tools: ToolDef[] = [];
  for (const t of upstream) {
    if (typeof t.name !== "string" || !t.name || t.name.length > 200) continue;
    let schema = t.inputSchema;
    let note = "";
    const ok = schema && typeof schema === "object" && !Array.isArray(schema) && schema.type === "object";
    if (!ok || JSON.stringify(schema).length > MAX_SCHEMA_BYTES) {
      schema = { type: "object", additionalProperties: true };
      note = " (Its argument schema was unusable or too large and has been replaced by a permissive one.)";
    }
    tools.push({
      name: makeToolName(slug, [t.name], used),
      description: oneLine(`${tag(repoId)} MCP tool \`${oneLine(t.name, 80)}\` of server "${server}". ${t.description}${note}`, 1000),
      inputSchema: schema,
      kind: "mcp",
      argv: [],
      options: [],
      cwd: REPO_DIR,
      mcp: { server, tool: t.name },
    });
  }
  return tools;
}

export interface BuildInput {
  slug: string;
  repoId: string;
  meta: ProjectMeta;
  /** Tools listed by MCP servers inside the sandbox; they are published first. */
  mcp?: Array<{ server: string; tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> }>;
  /** One entry per discovered command; `node` is null when it printed no usable help. */
  roots: Array<{ command: CommandSpec; node: HelpNode | null }>;
  maxTools: number;
}

/**
 * Turn crawl results into tool definitions. Proxied MCP tools come first: for
 * a project that is an MCP server they are the point. Then, breadth first: every command gets
 * its top-level tool, then the project-wide helpers, then subcommands level by
 * level (interleaved across commands) until the budget is spent. Whatever does
 * not fit stays reachable through the parent tool's `args`.
 */
export function buildTools(input: BuildInput): ToolDef[] {
  const used = new Set<string>();
  const tools: ToolDef[] = [];
  const room = () => tools.length < input.maxTools;

  for (const server of input.mcp ?? []) {
    for (const tool of mcpTools(input.slug, input.repoId, server.server, server.tools, used)) {
      if (!room()) break;
      tools.push(tool);
    }
  }
  for (const root of input.roots) {
    if (!room()) break;
    tools.push(
      root.node
        ? cliTool(input.slug, input.repoId, root.node, used)
        : passthroughTool(input.slug, input.repoId, root.command, used),
    );
  }
  for (const tool of extraTools(input.slug, input.repoId, input.meta, used)) {
    if (!room()) break;
    tools.push(tool);
  }

  let level = input.roots.map((r) => r.node?.children ?? []);
  while (room() && level.some((nodes) => nodes.length > 0)) {
    const widest = Math.max(...level.map((nodes) => nodes.length));
    for (let i = 0; i < widest && room(); i++) {
      for (const nodes of level) {
        const node = nodes[i];
        if (node && room()) tools.push(cliTool(input.slug, input.repoId, node, used));
      }
    }
    level = level.map((nodes) => nodes.flatMap((n) => n.children));
  }
  return tools;
}
