import type { Config } from "../config.js";
import { isUnusableValueError } from "../proxy/host-env.js";
import type { McpProxy, UpstreamTool } from "../proxy/mcp-proxy.js";
import type { SandboxRef } from "../sandbox/docker-base.js";
import { DockerUnavailableError } from "../sandbox/errors.js";
import { SandboxRefusedError } from "../sandbox/ownership.js";
import { BIN_DIR, REPO_DIR, VENV_DIR, WORK_DIR } from "../sandbox/scripts.js";
import { checkToolText, failedToolCheck } from "../scan/tool-text.js";
import { levelAtLeast, type Finding } from "../scan/types.js";
import { buildToolsWithText, crawlCommand, fetchRootHelp, type SandboxExec } from "../toolgen/discover.js";
import { parseHelp } from "../toolgen/help-parser.js";
import { helpLaunches, manifestLaunches, type LaunchCandidate } from "../toolgen/mcp-launch.js";
import type { CommandSpec, McpServerSpec, ParsedHelp, ProjectMeta, ProjectRecord, ToolCheck, ToolDef, WithheldTool } from "../types.js";
import { cleanTerminalText } from "../util/text.js";
import { NODE_DISCOVERY, PYTHON_DISCOVERY } from "./recipes.js";

const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const COMMAND_PATH = /^\/[A-Za-z0-9._+/-]{1,200}$/;
const MAX_COMMANDS = 12;
/** Upper bound on a project's catalog; what is advertised is far smaller. */
const MAX_CATALOG = 1500;
const NO_EXECUTABLES =
  "No executables were discovered. Use sandbox_exec to explore or build manually, then discover_tools with the executables you produced.";
/** Warnings about MCP proxying and tool publication are recomputed on every discovery. */
const MCP_WARNING = "MCP: ";
/** Handshake budget when merely probing whether a command is an MCP server. */
const MCP_PROBE_SEC = 15;
const MAX_MCP_PROBES = 6;

function parseJsonLine(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export interface McpDiscovery {
  servers: McpServerSpec[];
  lists: Array<{ server: string; tools: UpstreamTool[] }>;
  /** Commands that are MCP servers when run without arguments: no CLI to crawl. */
  bare: Set<string>;
  /** Registered servers whose tool listing failed, with the first line of the error. */
  failed: Array<{ server: string; reason: string }>;
  /** Candidate launches that did not answer, and the first reason given. */
  unanswered: string[];
  reason: string;
}

/** Said where a server did not start and the cause may be a missing variable. */
function routeHint(slug: string): string {
  return `If it needs environment variables, set ${slug}__NAME in the environment of mcp-everything, reconnect it, and call refresh_mcp.`;
}

/** What discovery needs of the installer: exactly the members the code used through `this`. */
export interface DiscoveryContext {
  cfg: Config;
  proxy: Pick<McpProxy, "listTools">;
  /** An exec function bound to one checked sandbox: every command of an operation runs on the reference it was given. */
  execFor(sandbox: SandboxRef): SandboxExec;
  launchSpec(project: ProjectRecord, server: McpServerSpec): McpServerSpec;
  /** Apply the publication policy to the catalog and record what it left out. */
  publish(record: ProjectRecord): void;
}

export async function discover(
  ctx: DiscoveryContext,
  record: ProjectRecord,
  sandbox: SandboxRef,
  extraCommands: string[],
): Promise<McpDiscovery> {
  // Every command of a discovery has a place that reads its failure as "no": eight `.catch(() => null)` in this
  // file and the `catch` in `fetchHelp` (toolgen/discover.ts), which receives this wrapped function. "Docker could not be asked" must not become "no commands", so the first one
  // is remembered, thrown again on every later command, and thrown by the discovery before it writes or returns.
  // Only that type: a command on a held reference reads no labels, so it cannot raise a refusal.
  let unavailable: DockerUnavailableError | undefined;
  const bound = ctx.execFor(sandbox);
  const exec: SandboxExec = async (argv, opts) => {
    if (unavailable) throw unavailable;
    try {
      return await bound(argv, opts);
    } catch (e) {
      if (e instanceof DockerUnavailableError) unavailable = e;
      throw e;
    }
  };
  const checkAsked = () => {
    if (unavailable) throw unavailable;
  };
  const quick = { timeoutSec: 60, cwd: REPO_DIR };
  const commands = new Map<string, CommandSpec>();
  const add = (name: string, origin: string) => {
    const ok = COMMAND_NAME.test(name) || COMMAND_PATH.test(name);
    if (ok && !commands.has(name) && commands.size < MAX_COMMANDS) commands.set(name, { name, origin });
  };

  // Commands registered by hand survive re-discovery for as long as they exist.
  const exists = async (name: string) => {
    const res = await exec(["sh", "-c", 'command -v "$1" >/dev/null', "sh", name], quick).catch(() => null);
    checkAsked(); // not "there is no such executable"
    return res?.code === 0;
  };
  for (const c of record.commands) {
    if (c.origin === "registered" && (await exists(c.name))) add(c.name, c.origin);
  }
  for (const name of extraCommands) {
    if (!COMMAND_NAME.test(name) && !COMMAND_PATH.test(name)) {
      throw new Error(`"${name}" is not a valid executable name or absolute path`);
    }
    if (!(await exists(name))) throw new Error(`No executable "${name}" was found in the sandbox`);
    add(name, "registered");
  }

  const meta: ProjectMeta = { ...record.meta, pythonModules: [], nodePackages: [], hasPythonEnv: false, hasNode: false };
  // Commands whose own package depends on an MCP SDK, and the packages the checkout provides.
  const sdkCommands: string[] = [];
  const packages: string[] = [];
  const owners = new Map<string, string>();
  const own = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [command, owner] of Object.entries(value)) if (typeof owner === "string") owners.set(command, owner);
  };

  const py = await exec([`${VENV_DIR}/bin/python`, "-c", PYTHON_DISCOVERY], quick).catch(() => null);
  if (py && py.code === 0) {
    const info = parseJsonLine(py.stdout);
    meta.hasPythonEnv = true;
    meta.pythonModules = strings(info.modules).filter((m) => /^[A-Za-z_][\w.]{0,60}$/.test(m)).slice(0, 30);
    for (const script of strings(info.scripts)) add(script, "console_script");
    sdkCommands.push(...strings(info.mcp_scripts));
    packages.push(...strings(info.dists));
    own(info.owners);
  }

  const nodeCheck = await exec(["sh", "-c", `[ -f ${REPO_DIR}/package.json ] && command -v node`], quick).catch(() => null);
  if (nodeCheck && nodeCheck.code === 0) {
    meta.hasNode = true;
    const node = await exec(["node", "-e", NODE_DISCOVERY], quick).catch(() => null);
    if (node && node.code === 0) {
      const info = parseJsonLine(node.stdout);
      meta.nodePackages = strings(info.packages).filter((p) => /^[@\w./-]{1,80}$/.test(p)).slice(0, 20);
      sdkCommands.push(...strings(info.mcp));
      packages.push(...meta.nodePackages);
      own(info.owners);
      const missing = strings(info.missing).filter((n) => COMMAND_NAME.test(n));
      if (missing.length > 0) {
        record.warnings.push(`package.json bin targets missing (build step needed?): ${missing.slice(0, 8).join(", ")}`);
      }
    }
  }

  const bins = await exec(["ls", "-1", BIN_DIR], quick).catch(() => null);
  if (bins && bins.code === 0) {
    const names = bins.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    // The command named after the project is the one people came for.
    const repoName = record.repo.name.toLowerCase();
    names.sort((a, b) => Number(b.toLowerCase() === repoName) - Number(a.toLowerCase() === repoName));
    for (const name of names) add(name, `built by ${record.primary} recipe`);
  }

  const limits = {
    maxDepth: 2,
    maxSubcommands: 25,
    helpTimeoutSec: ctx.cfg.helpTimeoutSec,
    budget: { remaining: 90 },
  };

  // Top-level help of every command: it identifies aliases, may reveal an
  // MCP mode, and is where the subcommand crawl starts.
  const rootText = new Map<string, string | null>();
  for (const name of commands.keys()) rootText.set(name, await fetchRootHelp(exec, name, limits));
  const { kept, aliasOf } = await foldAliases(exec, [...commands.values()], rootText);
  const rootHelp = new Map<string, ParsedHelp | null>();
  for (const c of kept) {
    const text = rootText.get(c.name);
    rootHelp.set(c.name, text ? parseHelp(text) : null);
  }

  checkAsked(); // before any proxied server is opened
  const mcp = await discoverMcp(ctx, record, exec, {
    commands: kept.map((c) => c.name),
    aliasOf,
    packages,
    // An alias that was folded away hands its owner to the name that was kept.
    owners: new Map([...owners].map(([command, owner]) => [aliasOf.get(command) ?? command, owner] as const)),
    pythonModules: meta.pythonModules,
    sdkCommands: [...new Set(sdkCommands.map((c) => aliasOf.get(c) ?? c))],
    hinted: Boolean(meta.mcpHint),
    rootHelp,
  });

  const roots = [];
  for (const command of kept) {
    if (mcp.bare.has(command.name)) continue;
    const text = rootText.get(command.name);
    roots.push({ command, node: text ? await crawlCommand(exec, command.name, limits, text) : null });
  }

  checkAsked(); // before anything is written to the record
  record.meta = meta;
  record.commands = kept;
  record.mcpServers = mcp.servers;
  vetCatalog(
    ctx.cfg,
    record,
    buildToolsWithText({
      slug: record.slug,
      repoId: record.repo.id,
      meta,
      mcp: mcp.lists,
      roots,
      maxTools: MAX_CATALOG,
    }),
  );
  record.warnings = [...new Set(record.warnings)].filter((w) => w !== NO_EXECUTABLES);
  if (record.commands.length === 0 && mcp.lists.length === 0) record.warnings.push(NO_EXECUTABLES);
  ctx.publish(record);
  // Scratch dir may have been removed by the project; tools default to it.
  await exec(["mkdir", "-p", WORK_DIR], quick).catch(() => null);
  checkAsked();
  return mcp;
}

/** At most this many withheld tools are described one by one; `withheldNames` still names them all. */
const MAX_WITHHELD = 50;

const safeName = (s: string): boolean => COMMAND_NAME.test(s) || COMMAND_PATH.test(s);

/**
 * Set `record.tools` from what discovery built, after the tool-description check. Pure: no I/O. With scanning off the
 * catalog is as built and `toolCheck` is removed (a stale one would otherwise ride along in the caller's spread of the
 * record). Under warn nothing is removed. Under block a tool with a finding at or above `blockAt` is withheld, in one
 * assignment after the check completes. A check that throws withholds nothing and its text is never stored.
 * Nothing project-derived enters `toolCheck`: only generated names and names validated at registration.
 */
export function vetCatalog(cfg: Config, record: ProjectRecord, built: ReturnType<typeof buildToolsWithText>): void {
  const { mode, blockAt } = cfg.scan;
  if (mode === "off") {
    record.tools = built.tools;
    delete record.toolCheck;
    return;
  }
  let outcome;
  let byTool = new Map<string, Finding[]>();
  try {
    const entries = built.tools.flatMap((t) => {
      const fields = built.sources.get(t);
      return fields ? [{ tool: t.name, fields }] : [];
    });
    ({ outcome, byTool } = checkToolText(entries));
  } catch {
    outcome = failedToolCheck();
    byTool = new Map();
  }
  const highest = (findings: Finding[]): Finding => {
    let best = findings[0]!;
    for (const f of findings) if (f.level !== best.level && levelAtLeast(f.level, best.level)) best = f;
    return best;
  };
  const withheldTools: ToolDef[] = [];
  if (mode === "block" && outcome.status === "ran") {
    for (const t of built.tools) {
      const findings = byTool.get(t.name);
      if (findings?.some((f) => levelAtLeast(f.level, blockAt))) withheldTools.push(t);
    }
  }
  const withheld: WithheldTool[] = withheldTools.slice(0, MAX_WITHHELD).map((t) => {
    const top = highest(byTool.get(t.name)!);
    const entry: WithheldTool = { tool: t.name, ruleId: top.ruleId, level: top.level };
    if (t.mcp && safeName(t.mcp.server)) entry.server = t.mcp.server;
    if (t.kind === "cli" && t.argv.length > 0 && t.argv.every(safeName)) entry.command = t.argv.join(" ");
    return entry;
  });
  const gone = new Set(withheldTools);
  const kept = built.tools.filter((t) => !gone.has(t));
  const allWithheldServers = (record.mcpServers ?? [])
    .map((s) => s.name)
    .filter((name) => safeName(name) && built.tools.some((t) => t.mcp?.server === name) && !kept.some((t) => t.mcp?.server === name));
  const toolCheck: ToolCheck = {
    at: new Date().toISOString(),
    mode: mode === "block" ? "block" : "warn",
    blockAt,
    outcome,
    withheld,
    withheldNames: withheldTools.map((t) => t.name),
    withheldOmitted: withheldTools.length - withheld.length,
    allWithheldServers,
  };
  record.tools = kept;
  record.toolCheck = toolCheck;
}

/**
 * Fold commands that are the same program under another name into one.
 * Two names are aliases only if they resolve to the same file *and* print
 * the same help: a multi-call binary (one file, behaviour chosen by the
 * name it is run as) keeps all of its names.
 */
async function foldAliases(
  exec: SandboxExec,
  commands: CommandSpec[],
  rootText: Map<string, string | null>,
): Promise<{ kept: CommandSpec[]; aliasOf: Map<string, string> }> {
  const real = new Map<string, string>();
  const script = 'for c in "$@"; do p=$(command -v "$c") && printf "%s\\t%s\\n" "$c" "$(readlink -f "$p")"; done; true';
  const res = await exec(["sh", "-c", script, "sh", ...commands.map((c) => c.name)], { timeoutSec: 60 }).catch(() => null);
  for (const line of (res?.stdout ?? "").split("\n")) {
    const [name, target] = line.split("\t");
    if (name && target) real.set(name, target);
  }
  const kept: CommandSpec[] = [];
  const aliasOf = new Map<string, string>();
  for (const command of commands) {
    const file = real.get(command.name);
    const help = rootText.get(command.name);
    const twin =
      command.origin === "registered" || !file || !help
        ? undefined
        : kept.find((k) => real.get(k.name) === file && rootText.get(k.name) === help);
    if (twin) {
      twin.aliases = [...(twin.aliases ?? []), command.name];
      aliasOf.set(command.name, twin.name);
    } else {
      kept.push({ name: command.name, origin: command.origin });
    }
  }
  return { kept, aliasOf };
}

/**
 * Work out which MCP servers the sandbox offers and what tools they list.
 *
 * Registered servers are kept as they are. Beyond those, launch commands
 * are tried in order of how much evidence backs them: what the repository
 * declares (server.json, mcp.json), then, for commands whose package
 * depends on an MCP SDK or whose repository hints at MCP, running the
 * command bare, then whatever MCP mode its help advertises. A command stops
 * being probed once one launch answers the handshake.
 */
async function discoverMcp(
  deps: DiscoveryContext,
  record: ProjectRecord,
  exec: SandboxExec,
  ctx: {
    commands: string[];
    aliasOf: Map<string, string>;
    packages: string[];
    owners: Map<string, string>;
    pythonModules: string[];
    sdkCommands: string[];
    hinted: boolean;
    rootHelp: Map<string, ParsedHelp | null>;
  },
): Promise<McpDiscovery> {
  record.warnings = record.warnings.filter((w) => !w.startsWith(MCP_WARNING));
  const servers: McpServerSpec[] = [];
  const lists: McpDiscovery["lists"] = [];
  const bare = new Set<string>();
  const startFailures: McpDiscovery["failed"] = [];
  // Commands that need no further probing: registered, or already answered.
  const claimed = new Set<string>();
  const brief = (e: unknown) => cleanTerminalText(e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 240);

  for (const server of record.mcpServers ?? []) {
    if (server.origin !== "registered") continue;
    servers.push(server);
    claimed.add(ctx.aliasOf.get(server.argv[0]!) ?? server.argv[0]!);
    if (server.argv.length === 1) bare.add(server.argv[0]!);
    try {
      lists.push({ server: server.name, tools: await deps.proxy.listTools(record.container, deps.launchSpec(record, server)) });
    } catch (e) {
      // A refusal or "could not be asked" is not "the server did not start": it ends the discovery.
      if (e instanceof SandboxRefusedError || e instanceof DockerUnavailableError) throw e;
      const text = brief(e);
      startFailures.push({ server: server.name, reason: text });
      // The hint goes after the cut; an unusable value already says what to fix.
      record.warnings.push(`${MCP_WARNING}${text}${isUnusableValueError(e) ? "" : ` ${routeHint(record.slug)}`}`);
    }
  }

  const read = async (file: string) => {
    const res = await exec(["head", "-c", "200000", `${REPO_DIR}/${file}`], { timeoutSec: 30 }).catch(() => null);
    return res && res.code === 0 ? res.stdout : undefined;
  };
  const declared = manifestLaunches(
    { serverJson: await read("server.json"), mcpJson: await read("mcp.json"), dotMcpJson: await read(".mcp.json") },
    ctx,
  );

  const candidates: LaunchCandidate[] = [...declared];
  const suspects = ctx.sdkCommands.filter((c) => ctx.commands.includes(c));
  // Without a declared launch or a telling dependency, a repository that
  // merely hints at MCP gets each of its commands tried bare.
  const bareProbes = suspects.length > 0 ? suspects : ctx.hinted && declared.length === 0 ? ctx.commands : [];
  for (const command of ctx.commands) {
    if (bareProbes.includes(command)) candidates.push({ name: command, argv: [command], source: "run without arguments" });
    for (const argv of helpLaunches(command, ctx.rootHelp.get(command) ?? null)) {
      candidates.push({ name: command, argv, source: "its help text" });
    }
  }

  const tried = new Set<string>();
  const failed: string[] = [];
  let reason = "";
  let reasonUnusable = false;
  let probes = 0;
  for (const candidate of candidates) {
    const command = candidate.argv[0]!;
    const key = JSON.stringify(candidate.argv);
    if (claimed.has(command) || tried.has(key) || probes >= MAX_MCP_PROBES) continue;
    tried.add(key);
    probes++;
    let name = COMMAND_NAME.test(candidate.name) ? candidate.name : command;
    if (servers.some((s) => s.name === name)) name = `${name}-${probes}`;
    const spec: McpServerSpec = { name, argv: candidate.argv, cwd: REPO_DIR, env: {}, origin: "detected" };
    try {
      const tools = await deps.proxy.listTools(record.container, deps.launchSpec(record, spec), MCP_PROBE_SEC);
      servers.push(spec);
      lists.push({ server: spec.name, tools });
      claimed.add(command);
      if (candidate.argv.length === 1) bare.add(command);
    } catch (e) {
      // Same rule as above: not "did not answer the handshake".
      if (e instanceof SandboxRefusedError || e instanceof DockerUnavailableError) throw e;
      failed.push(candidate.argv.join(" "));
      if (!reason) {
        reason = brief(e);
        reasonUnusable = isUnusableValueError(e);
      }
    }
  }
  // Launches that failed for a command which then answered another way are not news.
  const unanswered = failed.filter((f) => !claimed.has(f.split(" ")[0]!));
  if (unanswered.length > 0) {
    record.warnings.push(
      `${MCP_WARNING}this project looks like an MCP server, but none of these completed an MCP handshake: ${unanswered.map((u) => `\`${u}\``).join(", ")} (${reason}). ${
        reasonUnusable
          ? "If it needs other arguments, environment variables or network access, register it with connect_mcp_server."
          : `${routeHint(record.slug)} If it needs other arguments or network access, register it with connect_mcp_server.`
      }`,
    );
  }
  return { servers, lists, bare, failed: startFailures, unanswered, reason };
}
