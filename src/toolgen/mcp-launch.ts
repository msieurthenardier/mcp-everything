import type { ParsedHelp } from "../types.js";

/**
 * Working out how a project's MCP server is started.
 *
 * Projects say this in two machine-readable places: `server.json` (the MCP
 * registry manifest) and `mcp.json` / `.mcp.json` (a client configuration).
 * Both describe launching the *published* package ("npx -y pkg mcp"); here
 * that is mapped onto the command built from the checkout ("pkg mcp").
 * Failing a manifest, a command's own help text may advertise an MCP mode.
 */

export interface LaunchCandidate {
  /** Name for the server within the project. */
  name: string;
  argv: string[];
  /** Where the launch command came from, for messages. */
  source: string;
}

export interface LaunchContext {
  /** Commands available in the sandbox (after alias folding). */
  commands: string[];
  /** Alias name -> the command it was folded into. */
  aliasOf: Map<string, string>;
  /** Package names the checkout provides (npm names, Python distributions). */
  packages: string[];
  /** Command -> the package that installs it, where known. */
  owners?: Map<string, string>;
  pythonModules: string[];
}

type Dict = Record<string, unknown>;
const dict = (v: unknown): Dict => (v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function parseJson(text: string | undefined): Dict {
  try {
    return dict(JSON.parse(text ?? ""));
  } catch {
    return {};
  }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
/** An argument the user is expected to fill in: no use guessing it. */
const PLACEHOLDER = /\$\{|\{\w+\}|<[^>]+>|YOUR[_-]|\/path\/to|\/absolute\/path|xxx+/i;

/** "@scope/pkg@1.2.3" or "pkg==1.2" -> ["@scope/pkg", "pkg"]. */
function packageNames(spec: string): string[] {
  const bare = spec.replace(/(?!^)@[^/@]*$/, "").replace(/[=<>~!].*$/, "");
  return [...new Set([bare, bare.split("/").pop() ?? bare])];
}

function resolveCommand(spec: string, ctx: LaunchContext): string | undefined {
  const names = [...packageNames(spec), ...packageNames(spec.split("/").pop() ?? spec)];
  for (const n of names) {
    if (ctx.commands.includes(n)) return n;
    const canonical = ctx.aliasOf.get(n);
    if (canonical) return canonical;
  }
  // The package is ours but its command is named differently: unambiguous
  // only when the package installs a single command, or the project has one.
  const same = (a: string, b: string) => a.toLowerCase().replace(/_/g, "-") === b.toLowerCase().replace(/_/g, "-");
  const owned = ctx.commands.filter((c) => {
    const owner = ctx.owners?.get(c);
    return owner !== undefined && names.some((n) => same(n, owner));
  });
  if (owned.length === 1) return owned[0];
  if (ctx.commands.length === 1 && names.some((n) => ctx.packages.includes(n))) return ctx.commands[0];
  return undefined;
}

const strings = (v: unknown): string[] | undefined => {
  const items = list(v);
  return items.every((x) => typeof x === "string") ? (items as string[]) : undefined;
};

/** Launches declared by an MCP registry manifest (server.json). */
function fromServerJson(text: string | undefined, ctx: LaunchContext): LaunchCandidate[] {
  const out: LaunchCandidate[] = [];
  for (const raw of list(parseJson(text).packages)) {
    const pkg = dict(raw);
    const transport = dict(pkg.transport).type;
    if (transport !== undefined && transport !== "stdio") continue;
    if (typeof pkg.identifier !== "string") continue;
    const command = resolveCommand(pkg.identifier, ctx);
    if (!command) continue;
    const argv = [command];
    let usable = true;
    for (const rawArg of list(pkg.packageArguments)) {
      const arg = dict(rawArg);
      const value = typeof arg.value === "string" ? arg.value : typeof arg.default === "string" ? arg.default : undefined;
      if (value !== undefined && PLACEHOLDER.test(value)) usable = false;
      if (arg.type === "positional") {
        if (value !== undefined) argv.push(value);
        else if (arg.isRequired === true) usable = false;
      } else if (arg.type === "named" && typeof arg.name === "string") {
        if (value !== undefined) argv.push(arg.name, value);
        else if (arg.isRequired === true) argv.push(arg.name);
      }
    }
    if (usable) out.push({ name: command, argv, source: "server.json" });
  }
  return out;
}

const RUNNERS: Record<string, { skip?: string[]; flagsWithValue: string[] }> = {
  npx: { flagsWithValue: ["-p", "--package", "-c", "--call"] },
  bunx: { flagsWithValue: [] },
  pnpx: { flagsWithValue: [] },
  uvx: { flagsWithValue: ["--from", "--with", "--python", "-p"] },
  pnpm: { skip: ["dlx"], flagsWithValue: [] },
  yarn: { skip: ["dlx"], flagsWithValue: [] },
  pipx: { skip: ["run"], flagsWithValue: ["--spec"] },
  uv: { skip: ["tool", "run"], flagsWithValue: ["--from", "--with"] },
};

/** Map one client-config entry ({command, args}) onto a command in the sandbox. */
function fromClientEntry(command: string, args: string[], ctx: LaunchContext): string[] | undefined {
  if ([command, ...args].some((a) => PLACEHOLDER.test(a))) return undefined;
  const base = command.split("/").pop() ?? command;

  const runner = RUNNERS[base];
  if (runner) {
    let rest = [...args];
    for (const word of runner.skip ?? []) if (rest[0] === word) rest = rest.slice(1);
    while (rest.length > 0 && rest[0]!.startsWith("-")) {
      rest = rest.slice(runner.flagsWithValue.includes(rest[0]!) ? 2 : 1);
    }
    const spec = rest[0];
    const resolved = spec ? resolveCommand(spec, ctx) : undefined;
    return resolved ? [resolved, ...rest.slice(1)] : undefined;
  }

  const direct = resolveCommand(base, ctx);
  if (direct && !command.includes("/")) return [direct, ...args];

  // Interpreter plus a file or module from the checkout.
  const first = args[0];
  if (!first) return undefined;
  const relative = !first.startsWith("-") && !first.startsWith("/") && !first.split("/").includes("..");
  if (["node", "bun", "deno", "tsx"].includes(base) && relative) return [base, ...args];
  if (["python", "python3"].includes(base)) {
    if (first === "-m" && args[1] && ctx.pythonModules.includes(args[1].split(".")[0]!)) return ["python", ...args];
    if (relative) return ["python", ...args];
  }
  return undefined;
}

/** Launches declared by a client configuration (mcp.json / .mcp.json). */
function fromClientConfig(text: string | undefined, source: string, ctx: LaunchContext): LaunchCandidate[] {
  const root = parseJson(text);
  const servers = dict(root.mcpServers ?? root.servers);
  const out: LaunchCandidate[] = [];
  for (const [key, raw] of Object.entries(servers)) {
    const entry = dict(raw);
    const args = strings(entry.args ?? []);
    if (typeof entry.command !== "string" || !args) continue;
    if (entry.type !== undefined && entry.type !== "stdio") continue;
    const argv = fromClientEntry(entry.command, args, ctx);
    if (!argv) continue;
    out.push({ name: NAME.test(key) ? key : argv[0]!, argv, source });
  }
  return out;
}

/** Launch commands the repository itself declares, most authoritative first, without duplicates. */
export function manifestLaunches(
  files: { serverJson?: string; mcpJson?: string; dotMcpJson?: string },
  ctx: LaunchContext,
): LaunchCandidate[] {
  const all = [
    ...fromServerJson(files.serverJson, ctx),
    ...fromClientConfig(files.mcpJson, "mcp.json", ctx),
    ...fromClientConfig(files.dotMcpJson, ".mcp.json", ctx),
  ];
  const seen = new Set<string>();
  return all.filter((c) => {
    const key = JSON.stringify(c.argv);
    if (seen.has(key) || c.argv.length > 32) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Ways a command's own help says it can run as an MCP server, most explicit
 * first. Deliberately narrow: `serve`/`server` usually mean HTTP and are not
 * tried.
 */
export function helpLaunches(command: string, help: ParsedHelp | null): string[][] {
  if (!help) return [];
  const flags = new Set(help.options.map((o) => o.flag));
  const subs = new Map(help.subcommands.map((s) => [s.name, s.description] as const));
  const out: string[][] = [];
  if (flags.has("--mcp")) out.push([command, "--mcp"]);
  // A subcommand named "mcp" may start the server or merely manage registrations.
  if (subs.has("mcp") && !/\b(register|install|configure|add)\b/i.test(subs.get("mcp") ?? "")) out.push([command, "mcp"]);
  if (subs.has("mcp-server")) out.push([command, "mcp-server"]);
  if (flags.has("--stdio")) out.push([command, "--stdio"]);
  if (subs.has("stdio")) out.push([command, "stdio"]);
  if (subs.has("mcp") && !out.some((v) => v[1] === "mcp")) out.push([command, "mcp"]);
  return out;
}
