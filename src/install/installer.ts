import type { Config } from "../config.js";
import type { Registry } from "../registry.js";
import { BIN_DIR, Docker, REPO_DIR, VENV_DIR, WORK_DIR } from "../sandbox/docker.js";
import { buildTools, crawlCommand, type SandboxExec } from "../toolgen/discover.js";
import { makeSlug } from "../toolgen/naming.js";
import type { CommandSpec, Ecosystem, ProjectMeta, ProjectRecord, RepoRef } from "../types.js";
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

    const py = await exec([`${VENV_DIR}/bin/python`, "-c", PYTHON_DISCOVERY], quick).catch(() => null);
    if (py && py.code === 0) {
      const info = parseJsonLine(py.stdout);
      meta.hasPythonEnv = true;
      meta.pythonModules = strings(info.modules).filter((m) => /^[A-Za-z_][\w.]{0,60}$/.test(m)).slice(0, 30);
      for (const script of strings(info.scripts)) add(script, "console_script");
    }

    const nodeCheck = await exec(["sh", "-c", `[ -f ${REPO_DIR}/package.json ] && command -v node`], quick).catch(() => null);
    if (nodeCheck && nodeCheck.code === 0) {
      meta.hasNode = true;
      const node = await exec(["node", "-e", NODE_DISCOVERY], quick).catch(() => null);
      if (node && node.code === 0) {
        const info = parseJsonLine(node.stdout);
        meta.nodePackages = strings(info.packages).filter((p) => /^[@\w./-]{1,80}$/.test(p)).slice(0, 20);
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
    const roots = [];
    for (const command of commands.values()) {
      roots.push({ command, node: await crawlCommand(exec, command.name, limits) });
    }

    record.meta = meta;
    record.commands = [...commands.values()];
    record.tools = buildTools({
      slug: record.slug,
      repoId: record.repo.id,
      meta,
      roots,
      maxTools: this.cfg.maxToolsPerProject,
    });
    record.warnings = [...new Set(record.warnings)].filter((w) => w !== NO_EXECUTABLES);
    if (record.commands.length === 0) record.warnings.push(NO_EXECUTABLES);
    // Scratch dir may have been removed by the project; tools default to it.
    await exec(["mkdir", "-p", WORK_DIR], quick).catch(() => null);
  }

  async uninstall(project: ProjectRecord): Promise<void> {
    await this.docker.destroy(project.container, project.volume);
    this.registry.delete(project.slug);
  }
}
