import type { Config } from "../config.js";
import type { McpProxy, UpstreamTool } from "../proxy/mcp-proxy.js";
import type { Registry } from "../registry.js";
import { BIN_DIR, Docker, REPO_DIR, VENV_DIR, WORK_DIR, WORKSPACE, type ExecResult } from "../sandbox/docker.js";
import { buildTools, crawlCommand, fetchRootHelp, selectPublished, type SandboxExec } from "../toolgen/discover.js";
import { parseHelp } from "../toolgen/help-parser.js";
import { helpLaunches, manifestLaunches, type LaunchCandidate } from "../toolgen/mcp-launch.js";
import { makeSlug } from "../toolgen/naming.js";
import type {
  CommandSpec,
  Ecosystem,
  McpServerSpec,
  ParsedHelp,
  ProjectMeta,
  ProjectRecord,
  RepoRef,
  ToolSelection,
} from "../types.js";
import { cleanTerminalText } from "../util/text.js";
import { detect } from "./detect.js";
import { NODE_DISCOVERY, PYTHON_DISCOVERY, recipeFor } from "./recipes.js";
import { chooseToolchain, type ToolchainChoice } from "./toolchain.js";

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
/** Upper bound on a project's catalog; what is advertised is far smaller. */
const MAX_CATALOG = 1500;
const NO_EXECUTABLES =
  "No executables were discovered. Use sandbox_exec to explore or build manually, then discover_tools with the executables you produced.";
/** Warnings about MCP proxying and tool publication are recomputed on every discovery. */
const MCP_WARNING = "MCP: ";
const TOOLS_WARNING = "Tools: ";
/** Handshake budget when merely probing whether a command is an MCP server. */
const MCP_PROBE_SEC = 15;
const MAX_MCP_PROBES = 6;

// Returns the checkout to a pristine state before rebuilding on another image.
const CLEAN_SCRIPT = `cd ${REPO_DIR} && git clean -xfdq && git checkout -q -- . ; rm -rf ${WORKSPACE}/target ${WORKSPACE}/build`;

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

interface McpDiscovery {
  servers: McpServerSpec[];
  lists: Array<{ server: string; tools: UpstreamTool[] }>;
  /** Commands that are MCP servers when run without arguments: no CLI to crawl. */
  bare: Set<string>;
}

export class Installer {
  constructor(
    private readonly cfg: Config,
    private readonly docker: Docker,
    private readonly registry: Registry,
    private readonly proxy: McpProxy,
    /** Replaceable for tests. */
    private readonly choose: typeof chooseToolchain = chooseToolchain,
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
      published: [],
      // What the user chose to publish outlives a reinstall.
      selection: existing?.selection,
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

      const defaultImage = this.cfg.docker.images[record.primary];
      const choice: ToolchainChoice = params.image
        ? { image: params.image, fallbacks: [], reason: "image chosen by the caller" }
        : this.choose(record.primary, probe, defaultImage, this.cfg.docker.imageOverridden[record.primary]);
      // One retry at most: each attempt is a full build.
      const attempts = [choice.image, ...choice.fallbacks.slice(0, 1)];
      record.imageReason = choice.reason;
      log(`Detected ${detection.ecosystems.join(", ")}; building as ${record.primary}.`);

      const timeoutSec = params.timeoutSec ?? this.cfg.installTimeoutSec;
      let res!: ExecResult;
      let tail!: Tail;
      for (let i = 0; i < attempts.length; i++) {
        let image = attempts[i]!;
        log(`Using ${image}: ${record.imageReason}.`);
        try {
          await this.docker.ensureImage(image, (c) => log(c.trimEnd()));
        } catch (e) {
          // A version tag that does not exist must not sink the install.
          if (image === defaultImage || params.image) throw e;
          record.warnings.push(`Image ${image} could not be pulled; used the default ${defaultImage} instead.`);
          record.imageReason = `default image, because ${image} (${choice.reason}) could not be pulled`;
          image = defaultImage;
          await this.docker.ensureImage(image, (c) => log(c.trimEnd()));
        }
        record.image = image;
        if (i > 0) await this.docker.removeContainer(container);
        await this.docker.createContainer({ name: container, volume, image, project: params.repo.id });
        sandboxCreated = true;
        if (i > 0) await this.docker.exec(container, ["sh", "-c", CLEAN_SCRIPT], { timeoutSec: 300 });

        tail = new Tail(6000);
        const output = tail;
        res = await this.docker.exec(container, ["sh", "-c", recipeFor(record.primary)], {
          cwd: REPO_DIR,
          timeoutSec,
          maxBytes: 4_000_000,
          onOutput: (chunk) => {
            output.push(chunk);
            for (const line of chunk.split("\n")) if (line.trim()) log(line.trimEnd());
          },
        });
        const text = `${res.stdout}\n${res.stderr}`;
        const warnings = [...text.matchAll(/^MCPE_WARN (.+)$/gm)].map((m) => cleanTerminalText(m[1]!).slice(0, 300));
        const unhealthy = (res.code !== 0 && !res.timedOut) || /^MCPE_SOFT_FAIL$/m.test(text);
        const next = attempts[i + 1];
        if (unhealthy && next) {
          const why = warnings[0] ?? `the ${record.primary} recipe exited with code ${res.code}`;
          record.warnings.push(`The build did not succeed on ${image} (${why}); it was rebuilt on ${next}.`);
          record.imageReason = `${next} after the build failed on ${image}; the project's declared range allows both`;
          log(`Build failed on ${image}; retrying on ${next}…`);
          continue;
        }
        record.warnings.push(...warnings);
        break;
      }

      // From here on the project's code only runs with the network policy the
      // caller asked for (off unless requested).
      const wantNetwork = params.network === true;
      await this.docker.setNetwork(container, wantNetwork);
      record.network = wantNetwork;

      if (res.code !== 0) {
        record.status = "failed";
        record.error = res.timedOut
          ? `Install timed out after ${timeoutSec}s.`
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

  private async requireSandbox(project: ProjectRecord): Promise<void> {
    if (!(await this.docker.ensureRunning(project.container))) {
      throw new Error(`Sandbox for ${project.slug} no longer exists; reinstall it with install_project(reinstall: true).`);
    }
  }

  private finish(record: ProjectRecord): ProjectRecord {
    record.status = "ready";
    record.error = undefined;
    record.errorLog = undefined;
    this.registry.put(record);
    return record;
  }

  /**
   * (Re)build a project's toolset from what is installed in its sandbox right
   * now. `extraCommands` are executables the caller vouches for, e.g. after a
   * manual build via sandbox_exec.
   */
  async rediscover(project: ProjectRecord, extraCommands: string[]): Promise<ProjectRecord> {
    await this.requireSandbox(project);
    const record: ProjectRecord = { ...project, warnings: [...project.warnings] };
    await this.discover(record, extraCommands);
    return this.finish(record);
  }

  /**
   * Register (or replace) an MCP server that runs inside the project's sandbox
   * and publish its tools. Fails with the server's own error if it does not
   * start, leaving the project unchanged.
   */
  async connectMcp(project: ProjectRecord, spec: McpServerSpec): Promise<ProjectRecord> {
    await this.requireSandbox(project);
    await this.proxy.closeProject(project.container);
    await this.proxy.listTools(project.container, spec);
    const others = (project.mcpServers ?? []).filter((s) => s.name !== spec.name);
    const record: ProjectRecord = { ...project, mcpServers: [...others, spec], warnings: [...project.warnings] };
    await this.discover(record, []);
    return this.finish(record);
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

  /**
   * Change which of a project's tools are advertised. Works on the stored
   * catalog, so it needs no sandbox. `undefined` restores the default policy.
   */
  reselect(project: ProjectRecord, selection: ToolSelection | undefined): ProjectRecord {
    const record: ProjectRecord = { ...project, selection, warnings: [...project.warnings] };
    this.publish(record);
    this.registry.put(record);
    return record;
  }

  /** Apply the publication policy to the catalog and record what it left out. */
  private publish(record: ProjectRecord): void {
    const { published, notes } = selectPublished(record.tools, record.selection, this.cfg.maxToolsPerProject);
    record.published = published;
    record.warnings = record.warnings.filter((w) => !w.startsWith(TOOLS_WARNING));
    record.warnings.push(...notes.map((n) => `${TOOLS_WARNING}${n}`));
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
      helpTimeoutSec: this.cfg.helpTimeoutSec,
      budget: { remaining: 90 },
    };

    // Top-level help of every command: it identifies aliases, may reveal an
    // MCP mode, and is where the subcommand crawl starts.
    const rootText = new Map<string, string | null>();
    for (const name of commands.keys()) rootText.set(name, await fetchRootHelp(exec, name, limits));
    const { kept, aliasOf } = await this.foldAliases(exec, [...commands.values()], rootText);
    const rootHelp = new Map<string, ParsedHelp | null>();
    for (const c of kept) {
      const text = rootText.get(c.name);
      rootHelp.set(c.name, text ? parseHelp(text) : null);
    }

    const mcp = await this.discoverMcp(record, exec, {
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

    record.meta = meta;
    record.commands = kept;
    record.mcpServers = mcp.servers;
    record.tools = buildTools({
      slug: record.slug,
      repoId: record.repo.id,
      meta,
      mcp: mcp.lists,
      roots,
      maxTools: MAX_CATALOG,
    });
    record.warnings = [...new Set(record.warnings)].filter((w) => w !== NO_EXECUTABLES);
    if (record.commands.length === 0 && mcp.lists.length === 0) record.warnings.push(NO_EXECUTABLES);
    this.publish(record);
    // Scratch dir may have been removed by the project; tools default to it.
    await exec(["mkdir", "-p", WORK_DIR], quick).catch(() => null);
  }

  /**
   * Fold commands that are the same program under another name into one.
   * Two names are aliases only if they resolve to the same file *and* print
   * the same help: a multi-call binary (one file, behaviour chosen by the
   * name it is run as) keeps all of its names.
   */
  private async foldAliases(
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
  private async discoverMcp(
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
    // Commands that need no further probing: registered, or already answered.
    const claimed = new Set<string>();
    const brief = (e: unknown) => cleanTerminalText(e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 240);

    for (const server of record.mcpServers ?? []) {
      if (server.origin !== "registered") continue;
      servers.push(server);
      claimed.add(ctx.aliasOf.get(server.argv[0]!) ?? server.argv[0]!);
      if (server.argv.length === 1) bare.add(server.argv[0]!);
      try {
        lists.push({ server: server.name, tools: await this.proxy.listTools(record.container, server) });
      } catch (e) {
        record.warnings.push(`${MCP_WARNING}${brief(e)}`);
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
        const tools = await this.proxy.listTools(record.container, spec, MCP_PROBE_SEC);
        servers.push(spec);
        lists.push({ server: spec.name, tools });
        claimed.add(command);
        if (candidate.argv.length === 1) bare.add(command);
      } catch (e) {
        failed.push(candidate.argv.join(" "));
        reason ||= brief(e);
      }
    }
    // Launches that failed for a command which then answered another way are not news.
    const unanswered = failed.filter((f) => !claimed.has(f.split(" ")[0]!));
    if (unanswered.length > 0) {
      record.warnings.push(
        `${MCP_WARNING}this project looks like an MCP server, but none of these completed an MCP handshake: ${unanswered.map((u) => `\`${u}\``).join(", ")} (${reason}). If it needs other arguments, environment variables or network access, register it with connect_mcp_server.`,
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
