import type { Config } from "../config.js";
import { hostVariableNames, isUnusableValueError, launchVariables } from "../proxy/host-env.js";
import type { McpProxy, UpstreamTool } from "../proxy/mcp-proxy.js";
import type { Registry } from "../registry.js";
import {
  BIN_DIR,
  Docker,
  DockerUnavailableError,
  REPO_DIR,
  OWNER_SHOWN,
  SandboxRefusedError,
  VENV_DIR,
  WORK_DIR,
  WORKSPACE,
  type ExecResult,
  type ProbeData,
  type SandboxFacts,
  type SandboxRef,
} from "../sandbox/docker.js";
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
import { cleanTerminalText, oneLine } from "../util/text.js";
import { analyzeBuildHooks } from "../scan/build-hooks.js";
import { decide } from "../scan/policy.js";
import { runScanners } from "../scan/run.js";
import { emptyCounts } from "../scan/sarif.js";
import type { CheckOutcome, ScanReport } from "../scan/types.js";
import { detect } from "./detect.js";
import { NODE_DISCOVERY, PYTHON_DISCOVERY, recipeFor } from "./recipes.js";
import { chooseToolchain, type ToolchainChoice } from "./toolchain.js";

/** Where an install is, for its failure branch. A later state before "old" can be added as a member. */
type InstallState =
  /** A reinstall whose old sandbox has not been retired yet; `before` is the record to put back. */
  | { phase: "old"; before: ProjectRecord }
  /** The old sandbox is gone (or there was none); `sandbox` once this install made a container. */
  | { phase: "new"; sandbox?: SandboxRef };

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

/** Added to a record when a reinstall could not remove the sandbox the record names. Carries no part of the error. */
const OLD_SANDBOX_WARNING =
  "A reinstall could not remove this project's old sandbox, which may be partly removed; reinstall again to retry.";

/** One part of a sandbox that was left alone, and whose it is. Built from facts, never from a message. */
export function describeLeftPart(f: SandboxFacts): string {
  const what = `${f.kind} "${oneLine(f.sandbox, 80)}"`;
  switch (f.cls) {
    case "another":
      return `${what} is another installation's (owner label "${oneLine(f.owner ?? "", OWNER_SHOWN)}")`;
    case "not-ours":
      return `${what} was not created by mcp-everything`;
    case "before":
      return `${what} was made before ownership was recorded`;
    default:
      return `${what} is this installation's`;
  }
}

const describeLeft = (facts: readonly SandboxFacts[]): string => facts.map(describeLeftPart).join("; ");

/**
 * Added to the new record of a reinstall that let go of a sandbox because it is
 * not this installation's to remove. Must not begin with the prefixes that
 * discovery and publishing use for the warnings they recompute.
 */
function leftInPlaceWarning(facts: readonly SandboxFacts[]): string {
  return `The previous sandbox of this project was left in place, untouched, because it is not this installation's to remove: ${describeLeft(facts)}. It now has no record; remove it by hand in Docker if it is not wanted.`;
}

/** Added to a record put back after a reinstall met a sandbox at the very names it needs. */
function nameHeldWarning(facts: readonly SandboxFacts[]): string {
  return `The name this project's sandbox needs is held by a sandbox that is not this installation's: ${describeLeft(facts)}. It was not touched. Remove or rename it by hand in Docker.`;
}

export type Logger = (line: string) => void;

/**
 * How long an `installing` record may say so before it is taken to belong to
 * no live install: two build attempts at the longest recipe limit (a caller's
 * timeout_seconds is clamped to 7200, the environment default is not), plus
 * three hours for the clone, image pulls and discovery, which add up to well
 * under one with default settings. Seven hours by default.
 *
 * Several processes share one registry, and a record carries no owner, so age
 * is all that tells a dead install from a neighbor's live one. The rule does
 * not cover an install in which every step runs to its limit, a neighbor
 * process whose MCPE_INSTALL_TIMEOUT is larger than ours, or a wall clock that
 * jumped forward. In those cases the live install's own final write restores
 * its record.
 */
export function staleInstallLimitSec(cfg: Config): number {
  return 2 * Math.max(7200, cfg.installTimeoutSec) + 10800;
}

function isStaleInstall(record: ProjectRecord, now: number, cfg: Config): boolean {
  if (record.status !== "installing") return false;
  const started = Date.parse(record.installedAt);
  if (Number.isNaN(started) || started > now) return false;
  return now - started > staleInstallLimitSec(cfg) * 1000;
}

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
const MAX_BUILD_WARNINGS = 20;

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
  /** Registered servers whose tool listing failed, with the first line of the error. */
  failed: Array<{ server: string; reason: string }>;
  /** Candidate launches that did not answer, and the first reason given. */
  unanswered: string[];
  reason: string;
}

/** What `Installer.refreshMcp` hands back beside the record. */
export interface RefreshOutcome {
  record: ProjectRecord;
  /** Registered servers that did not start, each with the first line of the reason. */
  failed: Array<{ server: string; reason: string }>;
  /** Candidate launches that did not answer. */
  unanswered: string[];
  /** The reason the first of them gave. */
  reason: string;
  /** MCP server names recorded before the call and after it. */
  before: string[];
  after: string[];
}

/** Said where a server did not start and the cause may be a missing variable. */
function routeHint(slug: string): string {
  return `If it needs environment variables, set ${slug}__NAME in the environment of mcp-everything, reconnect it, and call refresh_mcp.`;
}

/** What an install that checks first came to. `kept` is the repository's existing record, whatever its status. */
export type InstallOutcome =
  | { kind: "installed"; record: ProjectRecord }
  | { kind: "blocked"; report: ScanReport; kept?: ProjectRecord }
  | { kind: "check-failed"; reason: string; kept?: ProjectRecord };

/** What a check on its own came to. */
export type CheckResult = { kind: "checked"; report: ScanReport } | { kind: "check-failed"; reason: string };

/** Called as an install that checks first moves from one stage to the next. */
export interface InstallHooks {
  onChecking?: () => void;
  onBuilding?: () => void;
}

/** What a warning about a blocked reinstall begins with; a later block replaces an earlier one. */
const BLOCKED_WARNING = "A reinstall at commit";
const CHECK_REASON_MAX = 300;

export class Installer {
  constructor(
    private readonly cfg: Config,
    private readonly docker: Docker,
    private readonly registry: Registry,
    private readonly proxy: McpProxy,
    /** Replaceable for tests. */
    private readonly choose: typeof chooseToolchain = chooseToolchain,
    /** Read at every launch, never copied: `{slug}__{NAME}` variables reach the project's MCP servers as `NAME`. */
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  private slugsWith(project: ProjectRecord): string[] {
    return [...this.registry.list().map((p) => p.slug), project.slug];
  }

  /**
   * The names of the host variables a project receives, for display. Never
   * throws, whatever the values are.
   */
  hostVariableNames(project: ProjectRecord): string[] {
    return hostVariableNames(project.slug, this.slugsWith(project), this.env);
  }

  /**
   * The one place a stored server spec becomes the spec to launch: a copy whose
   * environment is the stored one overlaid with the project's host variables
   * (the host wins). The result is passed to the proxy and never stored. Throws
   * when a value cannot be passed.
   */
  launchSpec(project: ProjectRecord, server: McpServerSpec): McpServerSpec {
    return { ...server, env: { ...server.env, ...launchVariables(project.slug, this.slugsWith(project), this.env) } };
  }

  /** An exec function bound to one checked sandbox: every command of an operation runs on the reference it was given. */
  execFor(sandbox: SandboxRef): SandboxExec {
    return (argv, opts) => this.docker.exec(sandbox, argv, opts);
  }

  async install(params: InstallParams, log: Logger = () => {}): Promise<ProjectRecord> {
    await this.docker.assertAvailable();
    this.registry.refresh();
    const existing = this.registry.findByRepo(params.repo.id);
    if (existing && existing.status === "ready" && !params.reinstall) return existing;

    const { record, slug, container, volume, before, renamed, state } = this.openInstall(params, existing);

    try {
      await this.retireOldSandbox(before, renamed, record, container, volume, state);

      log(`Cloning ${params.repo.cloneUrl}${params.ref ? ` @ ${params.ref}` : ""}…`);
      const probe = await this.docker.probe(params.repo, volume, {
        ref: params.ref,
        submodules: params.submodules,
        onOutput: (c) => log(c.trimEnd()),
      });
      return await this.finishInstall(params, record, probe, container, volume, state, log);
    } catch (e) {
      return this.settleFailure(e, record, slug, container, volume, state);
    }
  }

  /**
   * The checking stage, shared by `installChecked` and the check tool: clones the repository into a new staging
   * volume (never into an installed project's), runs the built-in check and the operator's scanners over the
   * clone, and decides. It touches no registry record and no installed sandbox. Returns the staging volume (the
   * caller removes it), the clone's data and the report. On any failure it removes the staging volume (best
   * effort) and throws an Error whose message is a cleaned, bounded one-line reason.
   */
  private async checkClone(params: InstallParams, log: Logger): Promise<{ staging: string; probe: ProbeData; report: ScanReport }> {
    const staging = this.docker.stagingName();
    try {
      log(`Cloning ${params.repo.cloneUrl}${params.ref ? ` @ ${params.ref}` : ""} to check it…`);
      const probe = await this.docker.probe(params.repo, staging, {
        ref: params.ref,
        submodules: params.submodules,
        onOutput: (c) => log(c.trimEnd()),
        volumeRole: "staging",
      });
      const primary = params.ecosystem ?? detect(probe).primary;
      let builtin: CheckOutcome;
      try {
        builtin = analyzeBuildHooks(primary, probe.walk);
      } catch {
        // Never the exception's text: it may carry repository content.
        builtin = {
          name: "build-hooks", kind: "builtin", status: "failed", counts: emptyCounts(), findings: [], omitted: 0, notes: [],
          error: "the built-in check could not analyze this repository",
        };
      }
      log("Running the scanners…");
      const scanned = await runScanners(this.docker, staging, this.cfg.scan.scanners, {
        totalTimeoutSec: this.cfg.scan.timeoutSec,
        dataDir: this.cfg.dataDir,
      });
      const checks = [builtin, ...scanned];
      const decision = decide(this.cfg.scan.mode, this.cfg.scan.blockAt, checks);
      return { staging, probe, report: { commit: probe.commit, checks, decision, at: new Date().toISOString() } };
    } catch (e) {
      await this.dropStaging(staging);
      throw new Error(oneLine(e instanceof Error ? e.message : String(e), CHECK_REASON_MAX));
    }
  }

  /** Removes a staging volume; best effort, never throws. */
  private async dropStaging(staging: string): Promise<void> {
    try {
      await this.docker.removeStagingVolume(staging);
    } catch {
      // The startup sweep removes what is left.
    }
  }

  /**
   * Clones and checks a repository without building or running anything from it, whatever the scan mode is: the
   * built-in check and every configured scanner run, and the report's decision uses the configured mode. It reads
   * and writes no registry record, touches no installed sandbox, and always removes its staging volume. Throws
   * only what `install` throws before it begins (Docker not answering).
   */
  async check(params: InstallParams, log: Logger = () => {}): Promise<CheckResult> {
    await this.docker.assertAvailable();
    let checked: { staging: string; probe: ProbeData; report: ScanReport };
    try {
      checked = await this.checkClone(params, log);
    } catch (e) {
      return { kind: "check-failed", reason: (e as Error).message };
    }
    await this.dropStaging(checked.staging);
    return { kind: "checked", report: checked.report };
  }

  /** The record for the repository as the registry holds it now, as a copy; absent when there is none. */
  private currentRecord(repoId: string): ProjectRecord | undefined {
    this.registry.refresh();
    const r = this.registry.findByRepo(repoId);
    return r ? structuredClone(r) : undefined;
  }

  /**
   * Installs after checking: the repository is cloned into a staging volume and checked first, and nothing of an
   * installed project is touched (no registry write, no proxy close, no removal, no network change) until the
   * policy has allowed the build. Then it opens the install as `install` does, retires the old sandbox, copies
   * exactly the checked bytes into the new sandbox's volume and builds from them (the clone is not repeated).
   *
   * Outcomes: `installed` (a build ran, or a ready record already existed), `blocked` (the policy refused; the
   * existing record, if any, gets one warning and is otherwise unchanged) or `check-failed` (the check could
   * not be made; nothing was changed). Throws what `install` throws before it opens (Docker not answering), and
   * the existing "could not reinstall" errors of the failure branch of a reinstall.
   */
  async installChecked(params: InstallParams, log: Logger = () => {}, hooks?: InstallHooks): Promise<InstallOutcome> {
    await this.docker.assertAvailable();
    this.registry.refresh();
    const existing = this.registry.findByRepo(params.repo.id);
    if (existing && existing.status === "ready" && !params.reinstall) return { kind: "installed", record: existing };

    hooks?.onChecking?.();
    let checked: { staging: string; probe: ProbeData; report: ScanReport };
    try {
      checked = await this.checkClone(params, log);
    } catch (e) {
      return { kind: "check-failed", reason: (e as Error).message, kept: this.currentRecord(params.repo.id) };
    }
    const { staging, probe, report } = checked;
    let stagingGone = false;
    const dropOnce = async () => {
      if (stagingGone) return;
      stagingGone = true;
      await this.dropStaging(staging);
    };

    try {
      if (report.decision.verdict === "block") {
        await dropOnce();
        let kept: ProjectRecord | undefined;
        if (existing) {
          const warning = `${BLOCKED_WARNING} ${report.commit.slice(0, 12)} was blocked by the scan policy on ${report.at.slice(0, 10)}; the project is unchanged.`;
          this.registry.update(existing.slug, (cur) => {
            if (!cur) return undefined;
            kept = { ...cur, warnings: [...cur.warnings.filter((w) => !w.startsWith(BLOCKED_WARNING)), warning] };
            return kept;
          });
        }
        return { kind: "blocked", report, kept: kept ? structuredClone(kept) : undefined };
      }

      // Allowed. Another session may have written the registry while the check ran.
      this.registry.refresh();
      const fresh = this.registry.findByRepo(params.repo.id);
      if (fresh && fresh.status === "ready" && !params.reinstall) {
        await dropOnce();
        return { kind: "installed", record: fresh };
      }

      hooks?.onBuilding?.();
      const { record, slug, container, volume, before, renamed, state } = this.openInstall(params, fresh);
      record.scan = report;
      try {
        await this.retireOldSandbox(before, renamed, record, container, volume, state);
        await this.docker.createSandboxVolume(volume);
        await this.docker.copyVolume(staging, volume);
        await dropOnce();
        return { kind: "installed", record: await this.finishInstall(params, record, probe, container, volume, state, log) };
      } catch (e) {
        return { kind: "installed", record: await this.settleFailure(e, record, slug, container, volume, state) };
      }
    } finally {
      await dropOnce();
    }
  }

  /**
   * The opening of an install, shared by `install` and `installChecked`: the slug and names, a copy of the record
   * being replaced, the record for the new install (`installedAt` is now; `selection` is carried from `existing`),
   * the state holder, and the first registry write (the renamed copy that keeps the old names, or the record).
   * `existing` is the registry's record for the repository, read by the caller just before.
   */
  private openInstall(params: InstallParams, existing: ProjectRecord | undefined) {
    const owner = params.repo.path.split("/")[0] ?? "";
    const slug = existing?.slug ?? makeSlug(params.repo.name, owner, (s) => this.registry.get(s) !== undefined);
    const container = this.docker.sandboxName(slug);
    const volume = container;
    // `existing` belongs to the registry: keep a copy that no later write can change.
    const before = existing ? structuredClone(existing) : undefined;
    const renamed = before !== undefined && (before.container !== container || before.volume !== volume);

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

    // Where the install is, for the failure branch: for a reinstall, "old" until
    // the removal that opens it (the previous sandbox's if the names changed, the
    // one at these names if not) has succeeded and the record holds the new
    // names; "new" from then on, and always for a first install.
    const state: { current: InstallState } = { current: before ? { phase: "old", before } : { phase: "new" } };
    if (before && renamed) {
      // The registry keeps the object it is given, so the record that carries the
      // old names is a separate one: the new names go on `record` only after the
      // old sandbox is gone.
      this.registry.put(structuredClone({ ...record, container: before.container, volume: before.volume }));
    } else {
      this.registry.put(record);
    }

    return { record, slug, container, volume, before, renamed, state };
  }

  /**
   * Everything of an install after the clone, shared by `install` and `installChecked`: detection, the image, the
   * build, the network policy, discovery and the final write. Every rejection must reach the caller's
   * `settleFailure`, so a caller awaits this inside its `try`.
   */
  private async finishInstall(
    params: InstallParams,
    record: ProjectRecord,
    probe: ProbeData,
    container: string,
    volume: string,
    state: { current: InstallState },
    log: Logger,
  ): Promise<ProjectRecord> {
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
    const { res, tail, sandbox } = await this.buildAttempts(
      record, attempts, choice, defaultImage, params, container, volume, timeoutSec, log, state,
    );

    if (res.code !== 0) {
      record.status = "failed";
      record.error = res.timedOut
        ? `Install timed out after ${timeoutSec}s.`
        : `Install recipe for ${record.primary} exited with code ${res.code}.`;
      record.errorLog = tail.toString().slice(-2500);
      await this.takeOffline(record, "failed", sandbox);
      this.registry.put(record);
      return record;
    }

    // From here on the project's code only runs with the network policy the
    // caller asked for (off unless requested).
    const wantNetwork = params.network === true;
    await this.docker.setNetwork(sandbox, wantNetwork);
    record.network = wantNetwork;

    log("Discovering commands and generating tools…");
    await this.discover(record, sandbox, []);
    record.status = "ready";
    this.registry.put(record);
    return record;
  }

  /**
   * Opens a (re)install: for a reinstall under new names, closes the proxied servers and removes the previous
   * sandbox (a refusal is only a warning on `record`), then removes whatever sits at the install's own names.
   * Sets `state` to "new" once the old sandbox is gone, and keeps it "old" until then.
   * Throws: Docker not answering or a failed removal of the previous or the own sandbox (a refusal at the own
   * names included). Leaves behind: on a throw in the renamed branch the state is still "old" and the old
   * sandbox may exist; a throw after it leaves the state "new", with the old sandbox gone.
   */
  private async retireOldSandbox(
    before: ProjectRecord | undefined,
    renamed: boolean,
    record: ProjectRecord,
    container: string,
    volume: string,
    state: { current: InstallState },
  ): Promise<void> {
    if (before && renamed) {
      await this.proxy.closeProject(before.container);
      try {
        await this.docker.destroy(before.container, before.volume);
      } catch (e) {
        // Only a refusal: the old sandbox is another installation's or not ours, so it is left exactly as it is
        // and the reinstall goes on beside it. Any other failure (Docker did not answer, a failed removal) rises
        // with the state still "old" and the old record is put back.
        if (!(e instanceof SandboxRefusedError)) throw e;
        record.warnings.push(leftInPlaceWarning(e.sandboxes));
      }
      this.registry.put(record);
      state.current = { phase: "new" };
    }
    await this.proxy.closeProject(container);
    await this.docker.destroy(container, volume);
    state.current = { phase: "new" };
  }

  /**
   * Builds the project in the install's sandbox: pulls the image (a version tag that cannot be pulled falls back
   * to the default), creates the container, runs the ecosystem recipe, and on an unhealthy build rebuilds once on
   * the fallback image. Returns the last attempt's result, its output tail and the sandbox it ran in.
   * Throws: the caller's own image that cannot be pulled, any Docker failure (create, exec, remove). Leaves
   * behind: whatever container exists, named by `state` as it happens (no sandbox between removing the first
   * attempt's container and creating the next), so the failure branch always knows what to take offline.
   */
  private async buildAttempts(
    record: ProjectRecord,
    attempts: string[],
    choice: ToolchainChoice,
    defaultImage: string,
    params: InstallParams,
    container: string,
    volume: string,
    timeoutSec: number,
    log: Logger,
    state: { current: InstallState },
  ): Promise<{ res: ExecResult; tail: Tail; sandbox: SandboxRef }> {
    // `attempts` always holds `choice.image`, so it is never empty and the last attempt always returns below.
    for (let i = 0; ; i++) {
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
      if (i > 0) {
        await this.docker.removeContainer(container);
        state.current = { phase: "new" };
        // The first attempt's container is gone: until `createContainer` returns the next one, this install holds none.
      }
      // The reference this attempt's container was made with; a rebuild replaces it.
      const made = await this.docker.createContainer({ name: container, volume, image, project: params.repo.id });
      state.current = { phase: "new", sandbox: made };
      if (i > 0) await this.docker.exec(made, ["sh", "-c", CLEAN_SCRIPT], { timeoutSec: 300 });

      const tail = new Tail(6000);
      const res = await this.docker.exec(made, ["sh", "-c", recipeFor(record.primary)], {
        cwd: REPO_DIR,
        timeoutSec,
        maxBytes: 4_000_000,
        onOutput: (chunk) => {
          tail.push(chunk);
          for (const line of chunk.split("\n")) if (line.trim()) log(line.trimEnd());
        },
      });
      const text = `${res.stdout}\n${res.stderr}`;
      const warnings = [...text.matchAll(/^MCPE_WARN (.+)$/gm)].map((m) => cleanTerminalText(m[1]!).slice(0, 300));
      const dropped = warnings.length - MAX_BUILD_WARNINGS;
      if (dropped > 0) warnings.splice(MAX_BUILD_WARNINGS, dropped, `${dropped} more build warnings were dropped.`);
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
      return { res, tail, sandbox: made };
    }
  }

  /**
   * Settles an install that threw. For a reinstall still "old" (the old sandbox may exist and no build has
   * started) it puts the old record back with a warning and throws. Otherwise the record becomes the failed one
   * and is returned: its sandbox taken offline when this install made one, else the install's new names rolled
   * back and the record deleted.
   * Throws: only in the "old" case, an Error whose message names the project and why (two forms: the name held
   * by a sandbox that is not this installation's, or the old sandbox could not be removed). Leaves behind: the
   * old record, unchanged but for a warning ("old"); the offline sandbox with a failed record, or nothing.
   */
  private async settleFailure(
    e: unknown,
    record: ProjectRecord,
    slug: string,
    container: string,
    volume: string,
    state: { current: InstallState },
  ): Promise<ProjectRecord> {
    const at = state.current;
    if (at.phase === "old") {
      const before = at.before;
      // The old sandbox may still exist and no build has started: put the record
      // back as it was, with a note, and report the failure rather than a failed build.
      const why = e instanceof Error ? e.message : String(e);
      // A refusal at the very names this install needs: the sandbox there is not this installation's, and "reinstall
      // again" can never succeed, so it gets its own words. Any other failure keeps the original warning and error.
      const held = e instanceof SandboxRefusedError;
      const warning = held ? nameHeldWarning(e.sandboxes) : OLD_SANDBOX_WARNING;
      this.registry.put({
        ...before,
        warnings: before.warnings.includes(warning) ? before.warnings : [...before.warnings, warning],
      });
      if (held) {
        throw new Error(
          `Could not reinstall ${before.slug}: the name of its sandbox is held by a sandbox that is not this installation's (${describeLeft(e.sandboxes)}). It was not touched and must be removed or renamed by hand in Docker. The project was left as it was; nothing new was built.`,
        );
      }
      throw new Error(
        `Could not reinstall ${before.slug}: the old sandbox could not be removed (${why}). The project was left as it was; nothing new was built.`,
      );
    }
    // Any failure of the build, a typed error included, becomes the failed record's error with its own message.
    record.status = "failed";
    record.error = e instanceof Error ? e.message : String(e);
    if (at.phase === "new" && at.sandbox) {
      // Discovery may have opened sessions to the project's MCP servers before the throw; the caller is told the
      // install failed, so none may stay open. Best effort: the original error is what is reported.
      await this.proxy.closeProject(container).catch(() => {});
      await this.takeOffline(record, "failed", at.sandbox);
      this.registry.put(record);
    } else {
      // Nothing usable exists (bad repository, clone or image failure):
      // leave no half-project behind. This rollback of the install's own new names
      // swallows every error on purpose, a refusal and "could not be asked" included:
      // a refusal means the thing at these names is not ours, so there is nothing of
      // this install to remove, and the record that names them is deleted just below.
      await this.docker.destroy(container, volume).catch(() => {});
      this.registry.delete(slug);
    }
    return record;
  }

  /**
   * Mark as failed every record that has said `installing` for longer than an
   * install can run, and take its sandbox off the network. Returns the slugs
   * it changed. Nothing is changed when Docker does not answer, so a later
   * start tries again. Never destroys anything.
   */
  async reconcileStale(now: number = Date.now(), log: Logger = () => {}): Promise<string[]> {
    this.registry.refresh();
    const stale = this.registry.list().filter((r) => isStaleInstall(r, now, this.cfg));
    if (stale.length === 0) return [];
    try {
      await this.docker.assertAvailable();
    } catch (e) {
      // Reachability only: whatever the failure, nothing is changed and the next start tries again.
      log(`${stale.length} interrupted install(s) not reconciled, Docker is not reachable: ${(e as Error).message.split("\n")[0]}`);
      return [];
    }
    const changed: string[] = [];
    for (const { slug, installedAt } of stale) {
      try {
        // The reachability check and earlier detaches take a while; another
        // process may have finished, replaced or removed this install since.
        this.registry.refresh();
        const current = this.registry.get(slug);
        if (!current || current.status !== "installing" || current.installedAt !== installedAt) continue;
        // A reinstall started after this check could still have its new
        // container detached; with no owner in the record that window (one
        // Docker round trip) cannot be closed. Its own final write and
        // setNetwork restore the record and the policy.
        const copy: ProjectRecord = { ...current, warnings: [...current.warnings] };
        await this.takeOffline(copy, "interrupted");
        const added = copy.warnings.slice(current.warnings.length);
        // A detach that already ran is not undone if this write is skipped:
        // the record then still says installing and the sandbox is offline,
        // which is harmless, and the next start tries again.
        const wrote = this.registry.update(slug, (locked) => {
          if (!locked || locked.status !== "installing" || locked.installedAt !== installedAt) return undefined;
          return {
            ...locked,
            status: "failed",
            error: `Install was interrupted: it started at ${installedAt} and never finished. Reinstall with install_project(reinstall: true).`,
            errorLog: undefined,
            network: copy.network,
            warnings: [...locked.warnings, ...added],
          };
        });
        if (wrote) {
          changed.push(slug);
          log(`${slug}: marked failed, its install was interrupted (started ${installedAt})`);
        }
      } catch (e) {
        // Per record: a failure is logged and the record stays as it was. `takeOffline` never throws, so this meets
        // only the registry and the guarded write; a refusal is reported by `takeOffline` itself, in the record.
        log(`${slug}: not reconciled: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    return changed;
  }

  /**
   * After a failed install the kept sandbox must not stay online, whatever the
   * caller asked for. Never throws: the record says what is known. An install
   * passes the reference it holds, so that it cannot meet a refusal; the startup
   * reconciliation resolves the record's name, and can.
   */
  private async takeOffline(record: ProjectRecord, occasion: "failed" | "interrupted", sandbox?: SandboxRef): Promise<void> {
    try {
      await this.docker.setNetwork(sandbox ?? record.container, false);
      record.network = false;
    } catch (e) {
      if (e instanceof SandboxRefusedError) {
        // The sandbox this record names is not this installation's: it was not touched, so what the record says
        // about its network stays as it was, and "may still be online" would be a claim about a stranger's sandbox.
        record.warnings.push(
          `The sandbox this record names is not this installation's and was left alone, so its network was not changed: ${describeLeft(e.sandboxes)}.`,
        );
        return;
      }
      // Anything else, "could not be asked" included, is reported as what it is: this sandbox may still be online.
      const reason = (e instanceof Error ? e.message : String(e)).split("\n")[0];
      record.network = true;
      record.warnings.push(
        `The sandbox could not be taken off the network after the ${occasion === "interrupted" ? "interrupted" : "failed"} install (${reason}); it may still be online. Turn it off with set_project_network.`,
      );
    }
  }

  /** Checks the project's sandbox once and returns the reference its operation then runs on. */
  private async requireSandbox(project: ProjectRecord): Promise<SandboxRef> {
    const sandbox = await this.docker.acquire(project.container);
    if (!sandbox) {
      throw new Error(`Sandbox for ${project.slug} no longer exists; reinstall it with install_project(reinstall: true).`);
    }
    return sandbox;
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
    const sandbox = await this.requireSandbox(project);
    const record: ProjectRecord = { ...project, warnings: [...project.warnings] };
    await this.discover(record, sandbox, extraCommands);
    return this.finish(record);
  }

  /**
   * Stop the project's MCP servers and rerun the whole of discovery, so that
   * servers started with the environment as it is now are the ones listed.
   * Reports what did not start and what disappeared. Nothing is stopped when a
   * variable's value is unusable.
   */
  async refreshMcp(project: ProjectRecord): Promise<RefreshOutcome> {
    // Before anything is stopped: an unusable value fails the call and changes nothing.
    launchVariables(project.slug, this.slugsWith(project), this.env);
    const sandbox = await this.requireSandbox(project);
    await this.proxy.closeProject(project.container);
    const record: ProjectRecord = { ...project, warnings: [...project.warnings] };
    const before = (project.mcpServers ?? []).map((s) => s.name);
    const mcp = await this.discover(record, sandbox, []);
    this.finish(record);
    return {
      record,
      failed: mcp.failed,
      unanswered: mcp.unanswered,
      reason: mcp.reason,
      before,
      after: (record.mcpServers ?? []).map((s) => s.name),
    };
  }

  /**
   * Register (or replace) an MCP server that runs inside the project's sandbox
   * and publish its tools. Fails with the server's own error if it does not
   * start, leaving the project unchanged.
   */
  async connectMcp(project: ProjectRecord, spec: McpServerSpec): Promise<ProjectRecord> {
    const sandbox = await this.requireSandbox(project);
    // Before anything is stopped: an unusable value fails the call and changes nothing.
    const launch = this.launchSpec(project, spec);
    await this.proxy.closeProject(project.container);
    await this.proxy.listTools(project.container, launch);
    const others = (project.mcpServers ?? []).filter((s) => s.name !== spec.name);
    const record: ProjectRecord = { ...project, mcpServers: [...others, spec], warnings: [...project.warnings] };
    await this.discover(record, sandbox, []);
    return this.finish(record);
  }

  /** Forget a registered MCP server (and whatever environment was stored for it). */
  async disconnectMcp(project: ProjectRecord, name: string): Promise<ProjectRecord> {
    const server = (project.mcpServers ?? []).find((s) => s.name === name);
    if (!server) throw new Error(`${project.slug} has no MCP server named "${name}"`);
    if (server.origin !== "registered") {
      throw new Error(`"${name}" was detected automatically and would be found again; uninstall the project to remove it.`);
    }
    const sandbox = await this.requireSandbox(project);
    await this.proxy.closeProject(project.container);
    const record: ProjectRecord = {
      ...project,
      mcpServers: (project.mcpServers ?? []).filter((s) => s.name !== name),
      warnings: [...project.warnings],
    };
    await this.discover(record, sandbox, []);
    return this.finish(record);
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

  private async discover(record: ProjectRecord, sandbox: SandboxRef, extraCommands: string[]): Promise<McpDiscovery> {
    // Every command of a discovery has a place that reads its failure as "no": eight `.catch(() => null)` in this
    // file and the `catch` in `fetchHelp` (toolgen/discover.ts), which receives this wrapped function. "Docker could not be asked" must not become "no commands", so the first one
    // is remembered, thrown again on every later command, and thrown by the discovery before it writes or returns.
    // Only that type: a command on a held reference reads no labels, so it cannot raise a refusal.
    let unavailable: DockerUnavailableError | undefined;
    const bound = this.execFor(sandbox);
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

    checkAsked(); // before any proxied server is opened
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

    checkAsked(); // before anything is written to the record
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
    checkAsked();
    return mcp;
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
        lists.push({ server: server.name, tools: await this.proxy.listTools(record.container, this.launchSpec(record, server)) });
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
        const tools = await this.proxy.listTools(record.container, this.launchSpec(record, spec), MCP_PROBE_SEC);
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

  /**
   * Remove a project's sandbox and its record. Returns what was left in Docker:
   * nothing when the sandbox was removed (or was not there), the facts of every
   * part found when Docker's guard refused it as another installation's or not
   * ours. A refusal still deletes the record, since a record that can be neither
   * used nor removed helps no one; any other failure (Docker did not answer, a
   * failed removal) rises before the record is deleted, so it can be tried again.
   */
  async uninstall(project: ProjectRecord): Promise<readonly SandboxFacts[]> {
    await this.proxy.closeProject(project.container);
    let left: readonly SandboxFacts[] = [];
    try {
      await this.docker.destroy(project.container, project.volume);
    } catch (e) {
      if (!(e instanceof SandboxRefusedError)) throw e;
      left = e.sandboxes;
    }
    this.registry.delete(project.slug);
    return left;
  }
}
