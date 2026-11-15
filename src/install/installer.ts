import type { Config } from "../config.js";
import type { McpProxy, UpstreamTool } from "../proxy/mcp-proxy.js";
import type { Registry } from "../registry.js";
import { BIN_DIR, Docker, REPO_DIR, VENV_DIR, WORK_DIR } from "../sandbox/docker.js";
import { buildTools, crawlCommand, type SandboxExec } from "../toolgen/discover.js";
import { makeSlug } from "../toolgen/naming.js";
import type { CommandSpec, Ecosystem, McpServerSpec, ProjectMeta, ProjectRecord, RepoRef } from "../types.js";
import { cleanTerminalText } from "../util/text.js";
import { detect } from "./detect.js";
import { NODE_DISCOVERY, PYTHON_DISCOVERY, recipeFor } from "./recipes.js";

export interface InstallParams {
  repo: RepoRef;
  ref?: string;
  /** Leave outbound network enabled after installation (default: off). */
  network?: boolean;
  image?: string;
  ecosystem?: Ecosystem;
  submodules?: boolean;
  timeoutSec?: number;
  reinstall?: boolean;
}

export type Logger = (line: string) => void;

const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const COMMAND_PATH = /^\/[A-Za-z0-9._+/-]{1,200}$/;
const MAX_COMMANDS = 12;
/** Warnings about MCP proxying are recomputed on every discovery. */
const MCP_WARNING = "MCP: ";
/** Handshake budget when merely probing whether a command is an MCP server. */
const MCP_PROBE_SEC = 15;
const MAX_MCP_PROBES = 4;
const NO_EXECUTABLES =
  "No executables were discovered. Use sandbox_exec to explore or build manually, then discover_tools with the executables you produced.";

/** Keeps the last N characters of a stream; install failures are at the end. */
class Tail {
  private text = "";
  constructor(private readonly max: number) {}
  push(chunk: string): void {
    this.text = (this.text + chunk).slice(-this.max);
  }
  toString(): string {
    return cleanTerminalText(this.text);
  }
}

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

export class Installer {
  constructor(
    private readonly cfg: Config,
    private readonly docker: Docker,
    private readonly registry: Registry,
    private readonly proxy: McpProxy,
  ) {}

  /** An exec function bound to one project's sandbox. */
  execFor(project: ProjectRecord): SandboxExec {
    return (argv, opts) => this.docker.exec(project.container, argv, opts);
  }

  async install(params: InstallParams, log: Logger = () => {}): Promise<ProjectRecord> {
    await this.docker.assertAvailable();
    this.registry.refresh();
    const existing = this.registry.findByRepo(params.repo.id);
    if (existing && existing.status === "ready" && !params.reinstall) return existing;

    const owner = params.repo.path.split("/")[0] ?? "";
    const slug = existing?.slug ?? makeSlug(params.repo.name, owner, (s) => this.registry.get(s) !== undefined);
    const container = `${this.cfg.docker.namePrefix}${slug}`;
    const volume = container;

    const record: ProjectRecord = {
      slug,
      repo: params.repo,
      ref: params.ref,
      image: "",
      container,
      volume,
      ecosystems: [],
      primary: "generic",
      network: true,
      status: "installing",
      warnings: [],
      commands: [],
      tools: [],
      meta: { npmScripts: [], makeTargets: [], pythonModules: [], nodePackages: [], hasPythonEnv: false, hasNode: false },
      installedAt: new Date().toISOString(),
    };
    this.registry.put(record);

    let sandboxCreated = false;
    try {
      await this.proxy.closeProject(container);
      await this.docker.destroy(container, volume);

      log(`Cloning ${params.repo.cloneUrl}${params.ref ? ` @ ${params.ref}` : ""}…`);
      const probe = await this.docker.probe(params.repo, volume, {
        ref: params.ref,
        submodules: params.submodules,
        onOutput: (c) => log(c.trimEnd()),
      });
      record.commit = probe.commit;

      const detection = detect(probe);
      record.ecosystems = detection.ecosystems;
      record.primary = params.ecosystem ?? detection.primary;
      record.license = detection.license;
      record.warnings.push(...detection.notes);
      if (!detection.license) {
        record.warnings.push("No license was detected in the repository root; verify that this project is open source.");
      }
      record.meta.npmScripts = detection.npmScripts;
      record.meta.makeTargets = detection.makeTargets;
      record.meta.mcpHint = detection.mcpHint || /(^|[^a-z])mcp([^a-z]|$)/i.test(params.repo.name);
      record.image = params.image ?? this.cfg.docker.images[record.primary];

      log(`Detected ${detection.ecosystems.join(", ")}; building as ${record.primary} in ${record.image}…`);
      await this.docker.ensureImage(record.image, (c) => log(c.trimEnd()));
      await this.docker.createContainer({ name: container, volume, image: record.image, project: params.repo.id });
      sandboxCreated = true;

      const tail = new Tail(6000);
      const res = await this.docker.exec(container, ["sh", "-c", recipeFor(record.primary)], {
        cwd: REPO_DIR,
        timeoutSec: params.timeoutSec ?? this.cfg.installTimeoutSec,
        maxBytes: 4_000_000,
        onOutput: (chunk) => {
          tail.push(chunk);
          for (const line of chunk.split("\n")) if (line.trim()) log(line.trimEnd());
        },
      });
      for (const m of `${res.stdout}\n${res.stderr}`.matchAll(/^MCPE_WARN (.+)$/gm)) {
        record.warnings.push(cleanTerminalText(m[1]!).slice(0, 300));
      }

      // From here on the project's code only runs with the network policy the
      // caller asked for (off unless requested).
      const wantNetwork = params.network === true;
      await this.docker.setNetwork(container, wantNetwork);
      record.network = wantNetwork;

      if (res.code !== 0) {
        record.status = "failed";
        record.error = res.timedOut
          ? `Install timed out after ${params.timeoutSec ?? this.cfg.installTimeoutSec}s.`
          : `Install recipe for ${record.primary} exited with code ${res.code}.`;
        record.errorLog = tail.toString().slice(-2500);
        this.registry.put(record);
        return record;
      }

      log("Discovering commands and generating tools…");
      await this.discover(record, []);
      record.status = "ready";
      this.registry.put(record);
      return record;
    } catch (e) {
      record.status = "failed";
      record.error = e instanceof Error ? e.message : String(e);
      if (sandboxCreated) {
        this.registry.put(record);
      } else {
        // Nothing usable exists (bad repository, clone or image failure):
        // leave no half-project behind.
        await this.docker.destroy(container, volume).catch(() => {});
        this.registry.delete(slug);
      }
      return record;
    }
  }

  /**
   * (Re)build a project's toolset from what is installed in its sandbox right
   * now. `extraCommands` are executables the caller vouches for, e.g. after a
   * manual build via sandbox_exec.
   */
  async rediscover(project: ProjectRecord, extraCommands: string[]): Promise<ProjectRecord> {
    if (!(await this.docker.ensureRunning(project.container))) {
      throw new Error(`Sandbox for ${project.slug} no longer exists; reinstall it with install_project(reinstall: true).`);
    }
    const record: ProjectRecord = { ...project, warnings: [...project.warnings] };
    await this.discover(record, extraCommands);
    record.status = "ready";
    record.error = undefined;
    record.errorLog = undefined;
    this.registry.put(record);
    return record;
  }

  /**
   * Register (or replace) an MCP server that runs inside the project's sandbox
   * and publish its tools. Fails with the server's own error if it does not
   * start, leaving the project unchanged.
   */
  async connectMcp(project: ProjectRecord, spec: McpServerSpec): Promise<ProjectRecord> {
    if (!(await this.docker.ensureRunning(project.container))) {
      throw new Error(`Sandbox for ${project.slug} no longer exists; reinstall it with install_project(reinstall: true).`);
    }
    await this.proxy.closeProject(project.container);
    await this.proxy.listTools(project.container, spec);
    const others = (project.mcpServers ?? []).filter((s) => s.name !== spec.name);
    const record: ProjectRecord = { ...project, mcpServers: [...others, spec], warnings: [...project.warnings] };
    await this.discover(record, []);
    record.status = "ready";
    record.error = undefined;
    record.errorLog = undefined;
    this.registry.put(record);
    return record;
  }

  /** Forget a registered MCP server (and whatever environment was stored for it). */
  async disconnectMcp(project: ProjectRecord, name: string): Promise<ProjectRecord> {
    const server = (project.mcpServers ?? []).find((s) => s.name === name);
    if (!server) throw new Error(`${project.slug} has no MCP server named "${name}"`);
    if (server.origin !== "registered") {
      throw new Error(`"${name}" was detected automatically and would be found again; uninstall the project to remove it.`);
    }
    await this.proxy.closeProject(project.container);
    const record: ProjectRecord = {
      ...project,
      mcpServers: (project.mcpServers ?? []).filter((s) => s.name !== name),
      warnings: [...project.warnings],
    };
    await this.discover(record, []);
    this.registry.put(record);
    return record;
  }

  private async discover(record: ProjectRecord, extraCommands: string[]): Promise<void> {
    const exec = this.execFor(record);
    const quick = { timeoutSec: 60, cwd: REPO_DIR };
    const commands = new Map<string, CommandSpec>();
    const add = (name: string, origin: string) => {
      const ok = COMMAND_NAME.test(name) || COMMAND_PATH.test(name);
      if (ok && !commands.has(name) && commands.size < MAX_COMMANDS) commands.set(name, { name, origin });
    };

    // Commands registered by hand survive re-discovery for as long as they exist.
    const exists = async (name: string) =>
      (await exec(["sh", "-c", 'command -v "$1" >/dev/null', "sh", name], quick).catch(() => null))?.code === 0;
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
    // Commands whose own package depends on an MCP SDK.
    const mcpCandidates: string[] = [];

    const py = await exec([`${VENV_DIR}/bin/python`, "-c", PYTHON_DISCOVERY], quick).catch(() => null);
    if (py && py.code === 0) {
      const info = parseJsonLine(py.stdout);
      meta.hasPythonEnv = true;
      meta.pythonModules = strings(info.modules).filter((m) => /^[A-Za-z_][\w.]{0,60}$/.test(m)).slice(0, 30);
      for (const script of strings(info.scripts)) add(script, "console_script");
      mcpCandidates.push(...strings(info.mcp_scripts));
    }

    const nodeCheck = await exec(["sh", "-c", `[ -f ${REPO_DIR}/package.json ] && command -v node`], quick).catch(() => null);
    if (nodeCheck && nodeCheck.code === 0) {
      meta.hasNode = true;
      const node = await exec(["node", "-e", NODE_DISCOVERY], quick).catch(() => null);
      if (node && node.code === 0) {
        const info = parseJsonLine(node.stdout);
        meta.nodePackages = strings(info.packages).filter((p) => /^[@\w./-]{1,80}$/.test(p)).slice(0, 20);
        mcpCandidates.push(...strings(info.mcp));
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
      helpTimeoutSec: this.cfg.helpTimeoutSec,
      budget: { remaining: 90 },
    };
    const mcp = await this.discoverMcp(record, [...commands.keys()], mcpCandidates, Boolean(meta.mcpHint));

    const roots = [];
    for (const command of commands.values()) {
      // A command that is an MCP server when run bare has no useful CLI surface.
      if (mcp.bare.has(command.name)) continue;
      roots.push({ command, node: await crawlCommand(exec, command.name, limits) });
    }

    record.meta = meta;
    record.commands = [...commands.values()];
    record.mcpServers = mcp.servers;
    record.tools = buildTools({
      slug: record.slug,
      repoId: record.repo.id,
      meta,
      mcp: mcp.lists,
      roots,
      maxTools: this.cfg.maxToolsPerProject,
    });
    record.warnings = [...new Set(record.warnings)].filter((w) => w !== NO_EXECUTABLES);
    if (record.commands.length === 0 && mcp.lists.length === 0) record.warnings.push(NO_EXECUTABLES);
    const offered = mcp.lists.reduce((n, l) => n + l.tools.length, 0);
    const published = record.tools.filter((t) => t.kind === "mcp").length;
    if (published < offered) {
      record.warnings.push(
        `${MCP_WARNING}only ${published} of the ${offered} tools offered by this project's MCP servers were published (limit MCPE_MAX_TOOLS_PER_PROJECT=${this.cfg.maxToolsPerProject}).`,
      );
    }
    // Scratch dir may have been removed by the project; tools default to it.
    await exec(["mkdir", "-p", WORK_DIR], quick).catch(() => null);
  }

  /**
   * Work out which MCP servers the sandbox offers and what tools they list.
   * Registered servers are kept as they are. Beyond those, commands are
   * probed by starting them without arguments and attempting an MCP
   * handshake: the ones whose package depends on an MCP SDK, or, when only
   * the repository as a whole hints at MCP, the first few commands.
   */
  private async discoverMcp(
    record: ProjectRecord,
    commands: string[],
    candidates: string[],
    hinted: boolean,
  ): Promise<{ servers: McpServerSpec[]; lists: Array<{ server: string; tools: UpstreamTool[] }>; bare: Set<string> }> {
    // `bare` collects the commands that turned out to be MCP servers.
    record.warnings = record.warnings.filter((w) => !w.startsWith(MCP_WARNING));
    const servers: McpServerSpec[] = [];
    const lists: Array<{ server: string; tools: UpstreamTool[] }> = [];
    const bare = new Set<string>();
    const brief = (e: unknown) => cleanTerminalText(e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 240);

    for (const server of record.mcpServers ?? []) {
      if (server.origin !== "registered") continue;
      servers.push(server);
      // However it is launched, a registered server's program is spoken for:
      // it is neither probed again nor given command line tools.
      bare.add(server.argv[0]!);
      try {
        lists.push({ server: server.name, tools: await this.proxy.listTools(record.container, server) });
      } catch (e) {
        record.warnings.push(`${MCP_WARNING}${brief(e)}`);
      }
    }

    let probe = candidates.filter((c) => commands.includes(c));
    if (probe.length === 0 && hinted) probe = commands;
    probe = [...new Set(probe)].filter((c) => !bare.has(c) && !servers.some((s) => s.name === c)).slice(0, MAX_MCP_PROBES);

    const failed: string[] = [];
    let reason = "";
    for (const command of probe) {
      const spec: McpServerSpec = { name: command, argv: [command], cwd: REPO_DIR, env: {}, origin: "detected" };
      try {
        const tools = await this.proxy.listTools(record.container, spec, MCP_PROBE_SEC);
        servers.push(spec);
        lists.push({ server: spec.name, tools });
        bare.add(command);
      } catch (e) {
        failed.push(command);
        reason ||= brief(e);
      }
    }
    if (failed.length > 0) {
      record.warnings.push(
        `${MCP_WARNING}this project looks like an MCP server, but ${failed.join(", ")} did not complete an MCP handshake when started without arguments (${reason}). If it needs arguments, environment variables or network access, register it with connect_mcp_server.`,
      );
    }
    return { servers, lists, bare };
  }

  async uninstall(project: ProjectRecord): Promise<void> {
    await this.proxy.closeProject(project.container);
    await this.docker.destroy(project.container, project.volume);
    this.registry.delete(project.slug);
  }
}
