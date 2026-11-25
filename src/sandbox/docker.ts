import { randomBytes } from "node:crypto";
import { cloneHosts } from "../network/defaults.js";
import { parseHostEntry } from "../network/hosts.js";
import { refusalLines } from "../network/refusals.js";
import type { RepoRef } from "../types.js";
import type { RunResult } from "../util/exec.js";
import { oneLine } from "../util/text.js";
import type { ScannerSpec } from "../scan/types.js";
import { FULL_ID, ONE_SHOT_ROLES, type ContainerFacts, type ContainmentHookMode, type OneShotResult, type SandboxRef } from "./docker-base.js";
import { DockerNetwork, ONESHOT_NET_ROLE, PROJECT_NET_ROLE } from "./docker-network.js";
import { CloneFailedError, VolumeNotUsableError } from "./errors.js";
import { networkModeOf, projectNetworkName, type NetworkMode } from "./network-spec.js";
import {
  clean,
  LABEL_MAX,
  OWNER_LABEL,
  PROJECT_LABEL,
  ROLE_LABEL,
  type OwnershipReport,
  type SandboxFacts,
  type SandboxInspectFacts,
} from "./ownership.js";
import {
  BIN_DIR,
  isStoppedExecFailure,
  MANIFESTS,
  parseProbeOutput,
  PREFIX,
  PROBE_SCRIPT,
  REPO_DIR,
  VENV_DIR,
  WALK_SEPARATOR,
  walkArguments,
  WATCHDOG_SCRIPT,
  watchdogPollSec,
  WORKSPACE,
  type ProbeData,
} from "./scripts.js";

export interface ExecOptions {
  cwd?: string;
  stdin?: string;
  timeoutSec: number;
  maxBytes?: number;
  onOutput?: (chunk: string) => void;
  /**
   * Start the sandbox and run the command once more when the first attempt
   * failed only because the container was stopped. Default true; cleanup that
   * must not wake a stopped sandbox passes false.
   */
  restart?: boolean;
  /**
   * Variables for this command (`docker exec -e NAME=value`). NOT for secrets: values are visible in `ps` and in
   * Docker's own listings. A checked reference's own `env` is merged over this one and wins, so a caller cannot
   * remove the variables the reference carries (the proxy's, once leg 7 sets them).
   */
  env?: Record<string, string>;
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `-e NAME=value` pairs for `docker exec`. Names are identifiers and values hold no line break or NUL. The one
 * validator for `execOnce` and the MCP connector, so that the two cannot drift. Nothing is secret here: argv is public.
 */
export function envFlags(env: Record<string, string> | undefined): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!ENV_NAME_PATTERN.test(k)) throw new Error(`Invalid environment variable name ${JSON.stringify(k.slice(0, 60))}`);
    if (typeof v !== "string" || /[\r\n\u0000]/.test(v)) throw new Error(`Environment variable ${k} must be a string without line breaks`);
    out.push("-e", `${k}=${v}`);
  }
  return out;
}

export interface ExecResult extends RunResult {
  timedOut: boolean;
}

/** A checked reference; `env` is copied and frozen. */
export function makeRef(id: string, name: string, env?: Record<string, string>): SandboxRef {
  return Object.freeze({ id, name, ...(env !== undefined ? { env: Object.freeze({ ...env }) } : {}) });
}

type Target = string | SandboxRef;

export class Docker extends DockerNetwork {
  /** The name must be free: never build on a volume somebody else may own. */
  private async assertNameFree(volume: string): Promise<void> {
    const existing = await this.inspectVolume(volume);
    if (existing) {
      this.refuseUnless([this.volumeFacts(volume, existing.labels)]);
      throw new Error(`Volume ${clean(volume)} already exists`);
    }
  }

  /** `docker volume create` with the generic and owner labels, and the role when it has one. */
  private async makeVolume(volume: string, role?: "staging"): Promise<void> {
    const vol = await this.docker(
      [
        "volume", "create", "--label", "mcp-everything=1", "--label", `${OWNER_LABEL}=${this.installationId}`,
        ...(role ? ["--label", `${ROLE_LABEL}=${role}`] : []),
        volume,
      ],
      { timeoutMs: 30_000 },
    );
    if (vol.code !== 0) throw new Error(`Failed to create volume: ${vol.stderr.trim()}`);
  }

  /**
   * An empty volume for a sandbox, labelled as `probe` labels a sandbox volume (generic and owner labels, no
   * role). It refuses when the name exists, by the rule `probe` applies: another's or not ours is a refusal, an
   * existing one of this installation is a plain error.
   */
  async createSandboxVolume(volume: string): Promise<void> {
    await this.assertNameFree(volume);
    await this.makeVolume(volume);
  }

  /**
   * A fresh name for a staging volume: `<prefix><installation id>-stg-<8 hex>`, the form no slug produces (a slug
   * is lowercase letters, digits and underscores, never a hyphen). Issues no Docker command; the volume is made by `probe` with the role `staging`.
   */
  stagingName(): string {
    return `${this.cfg.docker.namePrefix}${this.installationId}-stg-${randomBytes(4).toString("hex")}`;
  }

  /**
   * Remove a staging volume. Guarded like the others: a volume that is not there is success; another's, not
   * ours, or made before ownership was recorded is a refusal; one of this installation's that is not a staging
   * volume (no role, or another role) is `VolumeNotUsableError` and is left alone. Nothing but a staging volume is
   * ever removed by this method.
   */
  async removeStagingVolume(volume: string): Promise<void> {
    const v = await this.inspectVolume(volume);
    if (!v) return;
    this.refuseUnless([this.volumeFacts(volume, v.labels)]);
    if (v.labels?.[ROLE_LABEL] !== "staging") {
      throw new VolumeNotUsableError(`Volume ${clean(volume)} is not a staging volume of this installation; it was not removed`);
    }
    const rm = await this.docker(["volume", "rm", "-f", volume], { timeoutMs: 120_000 });
    if (rm.code !== 0) throw new Error(`Failed to remove volume ${clean(volume)}: ${rm.stderr.trim()}`);
  }

  /**
   * Inspect every volume first, then require each to exist, be this installation's (the gate refuses anything else,
   * a volume made before ownership included) and carry the wanted role (`staging`) or none. Throws
   * before anything is created. A refusal names every volume it speaks of.
   */
  private async requireVolumes(wants: Array<{ name: string; role: "staging" | "none" }>): Promise<void> {
    const found: Array<Awaited<ReturnType<Docker["inspectVolume"]>>> = [];
    for (const w of wants) found.push(await this.inspectVolume(w.name));
    this.refuseUnless(wants.flatMap((w, i) => (found[i] ? [this.volumeFacts(w.name, found[i]!.labels)] : [])));
    wants.forEach((w, i) => {
      const v = found[i];
      if (!v) throw new VolumeNotUsableError(`Volume ${clean(w.name)} does not exist`);
      const role = v.labels?.[ROLE_LABEL];
      if (w.role === "staging" && role !== "staging") throw new VolumeNotUsableError(`Volume ${clean(w.name)} is not a staging volume`);
      if (w.role === "none" && role !== undefined) throw new VolumeNotUsableError(`Volume ${clean(w.name)} is not a sandbox volume (it has the role ${oneLine(role, LABEL_MAX)})`);
    });
  }

  /**
   * Run one operator scanner over a staging volume. The volume must be this installation's staging volume
   * (checked before any container exists). The image's own entrypoint runs with `spec.command` as its arguments (or `spec.entrypoint` replaces it; "" clears it), no
   * network unless the scanner is configured to have one, the checkout mounted read-only at /scan and the working
   * directory /scan/repo (a checkout with no `repo` directory makes `start` fail: the caller reports it as a failed run).
   */
  async runScanner(volume: string, spec: ScannerSpec, opts: { timeoutMs: number; envFile?: string }): Promise<OneShotResult> {
    await this.requireVolumes([{ name: volume, role: "staging" }]);
    // Under containment a scanner with a network reaches its own `hosts` and nothing else, local addresses included (DD12);
    // leg 1 refuses a networked scanner without `hosts` at startup.
    const egress =
      spec.network && this.cfg.network.mode === "contained"
        ? { allow: spec.hosts.map((h) => parseHostEntry(h, "scanner")), local: true }
        : undefined;
    return this.runOnce({
      role: "scan",
      image: spec.image,
      ...(egress ? { egress } : { network: spec.network ? "bridge" : "none" }),
      mountFlags: [`type=volume,src=${volume},dst=/scan,readonly`],
      workdir: "/scan/repo",
      envFile: opts.envFile,
      // Straight through: "" must reach `--entrypoint ""` (clears the image's entrypoint), so never `||`.
      entrypoint: spec.entrypoint,
      args: spec.command,
      timeoutMs: opts.timeoutMs,
      maxBytes: 8_000_000,
    });
  }

  /**
   * Copy a staging volume into a new sandbox volume, exactly (`cp -a`: owners, modes, links). `from` must be this
   * installation's staging volume and `to` its sandbox volume (no role); both are inspected before anything is
   * created. The container is the one place that has extra capabilities: it runs no repository code, has no
   * network and reads its source read-only, and without CHOWN, FOWNER, DAC_OVERRIDE and FSETID `cp -a` cannot
   * keep an owner other than root's or read a mode-000 directory. A failed copy leaves `to` partly written; the
   * caller removes it.
   */
  async copyVolume(from: string, to: string): Promise<void> {
    await this.requireVolumes([{ name: from, role: "staging" }, { name: to, role: "none" }]);
    await this.ensureImage(this.cfg.docker.probeImage);
    const res = await this.runOnce({
      role: "copy",
      image: this.cfg.docker.probeImage,
      network: "none",
      entrypoint: "cp",
      caps: ["CHOWN", "FOWNER", "DAC_OVERRIDE", "FSETID"],
      mounts: [`${from}:/from:ro`, `${to}:/to`],
      args: ["-a", "/from/.", "/to/"],
      timeoutMs: 300_000,
      maxBytes: 64_000,
    });
    if (res.timedOut) throw new Error("Could not copy the checkout: timed out after 300s");
    if (res.code !== 0) throw new Error(`Could not copy the checkout: ${oneLine(res.stderr.slice(-300), 300) || `exit code ${res.code}`}`);
  }

  /**
   * Remove what a check left behind that is this installation's and old: containers with a one-shot role (`clone`,
   * `scan`, `copy`, `runtime-check`, `resolv-read`, `oneshot-proxy`), volumes with the role `staging` and networks
   * with the role `oneshot-net`, in that order (a proxy goes before its network). It acts only on what it listed and
   * then re-verified by inspect (the owner label is this installation's id, the role is in the allowlist, the age is
   * known and over `maxAgeSec`), removing containers and networks by their full id. Anything that carries the
   * `mcp-everything.project` label at all, even empty, is never a candidate: it is a project's, whatever its role or
   * name (labels only decide). A thing that is gone meanwhile is skipped, and so is a network that still has
   * endpoints (not a failure: its holder goes first or is a live call's). It never throws: Docker failures are
   * counted, for the caller to log. Never anything without a role label or with another owner.
   *
   * `maxAgeSec` must exceed the longest a live check can hold these things, because another process of the same
   * installation may be mid-check: the clone (600 s), plus the pulls and the scan budget, plus the copy (300 s),
   * plus the staging volume's life through the rest of an install. Leg 7 computes it from the configuration.
   */
  async sweepCheckLeftovers(maxAgeSec: number): Promise<{ removed: string[]; failures: number }> {
    const removed: string[] = [];
    let failures = 0;
    const owned = `label=${OWNER_LABEL}=${this.installationId}`;
    const old = (created: unknown): boolean => {
      const t = typeof created === "string" ? Date.parse(created) : Number.NaN;
      if (Number.isNaN(t)) throw new Error("unreadable creation time");
      return Date.now() - t > maxAgeSec * 1000;
    };
    const listed = async (args: string[]): Promise<string[]> => {
      const res = await this.ask(args, 60_000);
      if (res.code !== 0 || res.timedOut || res.truncated) throw new Error("list failed");
      return res.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    };
    const read = async (args: string[]): Promise<{ labels: Record<string, unknown>; created: unknown; id?: unknown } | null> => {
      const res = await this.ask(args, 30_000);
      if (this.isNotThere(res)) return null;
      if (res.code !== 0 || res.timedOut || res.truncated) throw new Error("inspect failed");
      const v = JSON.parse(res.stdout.trim()) as { labels?: unknown; created?: unknown; id?: unknown } | null;
      if (!v || typeof v !== "object" || !v.labels || typeof v.labels !== "object" || Array.isArray(v.labels)) throw new Error("unreadable inspect");
      return { labels: v.labels as Record<string, unknown>, created: v.created, id: v.id };
    };
    const remove = async (args: string[], what: string): Promise<void> => {
      const res = await this.ask(args, 120_000);
      if (res.code === 0) removed.push(what);
      else if (!this.isNotThere(res)) throw new Error("remove failed");
    };

    let ids: string[] = [];
    try {
      ids = await listed(["ps", "-a", "--no-trunc", "--filter", owned, "--filter", `label=${ROLE_LABEL}`, "--format", "{{.ID}}"]);
    } catch {
      failures++;
    }
    for (const listedId of ids) {
      try {
        if (!FULL_ID.test(listedId)) throw new Error("not a full id");
        const c = await read(["inspect", "--type", "container", "--format", '{"id":{{json .Id}},"labels":{{json .Config.Labels}},"created":{{json .Created}}}', listedId]);
        if (!c) continue;
        if (c.id !== listedId) throw new Error("id mismatch");
        if (c.labels[OWNER_LABEL] !== this.installationId || !(ONE_SHOT_ROLES as readonly string[]).includes(String(c.labels[ROLE_LABEL]))) continue;
        if (Object.hasOwn(c.labels, PROJECT_LABEL)) continue;
        if (!old(c.created)) continue;
        await remove(["rm", "-f", listedId], listedId);
      } catch {
        failures++;
      }
    }

    let names: string[] = [];
    try {
      names = await listed(["volume", "ls", "--filter", owned, "--filter", `label=${ROLE_LABEL}=staging`, "--format", "{{.Name}}"]);
    } catch {
      failures++;
    }
    for (const name of names) {
      try {
        const v = await read(["volume", "inspect", "--format", '{"labels":{{json .Labels}},"created":{{json .CreatedAt}}}', name]);
        if (!v) continue;
        if (v.labels[OWNER_LABEL] !== this.installationId || v.labels[ROLE_LABEL] !== "staging") continue;
        if (Object.hasOwn(v.labels, PROJECT_LABEL)) continue;
        if (!old(v.created)) continue;
        await remove(["volume", "rm", "-f", name], name);
      } catch {
        failures++;
      }
    }

    let nets: string[] = [];
    try {
      nets = await listed(["network", "ls", "--no-trunc", "--filter", owned, "--filter", `label=${ROLE_LABEL}=${ONESHOT_NET_ROLE}`, "--format", "{{.ID}}"]);
    } catch {
      failures++;
    }
    for (const listedId of nets) {
      try {
        if (!FULL_ID.test(listedId)) throw new Error("not a full id");
        const res = await this.ask(["network", "inspect", "--format", '{"id":{{json .Id}},"labels":{{json .Labels}},"created":{{json .Created}}}', listedId], 30_000);
        if (this.isNetworkNotThere(res)) continue;
        if (res.code !== 0 || res.timedOut || res.truncated) throw new Error("inspect failed");
        const n = JSON.parse(res.stdout.trim()) as { id?: unknown; labels?: unknown; created?: unknown } | null;
        if (!n || typeof n !== "object" || n.id !== listedId) throw new Error("unreadable inspect");
        // No labels at all: not ours to judge, so skipped (not a failure).
        if (n.labels === null || typeof n.labels !== "object" || Array.isArray(n.labels)) continue;
        const labels = n.labels as Record<string, unknown>;
        if (labels[OWNER_LABEL] !== this.installationId || labels[ROLE_LABEL] !== ONESHOT_NET_ROLE) continue;
        if (Object.hasOwn(labels, PROJECT_LABEL)) continue;
        if (!old(n.created)) continue;
        const rm = await this.ask(["network", "rm", listedId], 120_000);
        if (rm.code === 0) removed.push(listedId);
        else if (!this.isNetworkNotThere(rm) && !/active endpoints/i.test(rm.stderr)) throw new Error("remove failed");
      } catch {
        failures++;
      }
    }
    return { removed, failures };
  }

  /** Clone the repository into a fresh volume and report what is in it. */
  async probe(
    repo: RepoRef,
    volume: string,
    // `timeoutMs` is for tests only.
    opts: { ref?: string; submodules?: boolean; onOutput?: (chunk: string) => void; volumeRole?: "staging"; timeoutMs?: number },
  ): Promise<ProbeData> {
    await this.assertNameFree(volume);
    await this.ensureImage(this.cfg.docker.probeImage, opts.onOutput);
    await this.makeVolume(volume, opts.volumeRole);
    const timeoutMs = opts.timeoutMs ?? 600_000;
    // Under containment the clone reaches its own forge and nothing else (DD5), through a one-shot proxy. A forge named in
    // MCPE_EXTRA_HOSTS is self-hosted and may be local (DD10); github.com and gitlab.com never are.
    const egress =
      this.cfg.network.mode === "contained"
        ? { allow: cloneHosts(repo).map((h) => parseHostEntry(h, "scanner")), local: repo.host !== "github.com" && repo.host !== "gitlab.com" }
        : undefined;
    const res = await this.runOnce({
      role: "clone",
      image: this.cfg.docker.probeImage,
      ...(egress ? { egress } : { network: "bridge" }),
      mounts: [`${volume}:${WORKSPACE}`],
      entrypoint: "sh",
      args: [
        "-c", PROBE_SCRIPT, "probe",
        repo.cloneUrl, opts.ref ?? "", opts.submodules ? "1" : "0",
        ...MANIFESTS,
        WALK_SEPARATOR,
        ...walkArguments(),
      ],
      timeoutMs,
      maxBytes: 16_000_000,
    });
    if (res.code !== 0) {
      const detail = res.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : res.stderr.trim().split("\n").slice(-6).join("\n");
      const text = `Could not clone ${repo.cloneUrl}${opts.ref ? ` at ${opts.ref}` : ""}:\n${detail || "git failed"}`;
      // Only a report that was read says anything; a proxy that did not start never reaches here (it threw `ProxyStartError`).
      const rows = res.proxy && "rows" in res.proxy ? res.proxy.rows : [];
      throw egress ? new CloneFailedError(text, refusalLines(rows, "clone")) : new Error(text);
    }
    const data = parseProbeOutput(res.stdout, res.truncated);
    if (!data.commit) throw new Error(`Clone of ${repo.cloneUrl} produced no commit`);
    return data;
  }

  /**
   * Make the long-lived sandbox container for a project. By default it is started at once (`docker run -d`, on `bridge`).
   * With `start: false` it is only created (`docker create`, the same arguments, still on `bridge`) so that containment
   * can move it to its own network before its first start (T15). Under `MCPE_NETWORK=contained` a start here is refused:
   * a sandbox that began on `bridge` would have reached the network before it was contained.
   */
  async createContainer(opts: { name: string; volume: string; image: string; project: string; start?: boolean }): Promise<SandboxRef> {
    const start = opts.start !== false;
    if (start && this.cfg.network.mode === "contained") {
      throw new Error("A sandbox is not started on bridge under MCPE_NETWORK=contained: create it with start: false, contain it, then start it.");
    }
    await this.assertRuntime();
    // Only on a volume that exists and is this installation's: `docker run -v` would otherwise make or use any volume.
    const vol = await this.inspectVolume(opts.volume);
    if (!vol) throw new Error(`Volume ${clean(opts.volume)} does not exist; it must be created first`);
    this.refuseUnless([this.volumeFacts(opts.volume, vol.labels)]);
    await this.ensureImage(opts.image);
    const basePath = await this.imagePath(opts.image);
    const path = [BIN_DIR, `${VENV_DIR}/bin`, "/root/.cargo/bin", "/usr/local/go/bin", basePath].join(":");
    const env: Record<string, string> = {
      PATH: path,
      HOME: "/root",
      TERM: "dumb",
      NO_COLOR: "1",
      CARGO_TERM_COLOR: "never",
      DEBIAN_FRONTEND: "noninteractive",
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PIP_ROOT_USER_ACTION: "ignore",
      PYTHONDONTWRITEBYTECODE: "1",
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
      npm_config_audit: "false",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      // Libraries installed next to binaries under the prefix (cmake/autotools).
      LD_LIBRARY_PATH: `${PREFIX}/lib:${PREFIX}/lib64`,
      GIT_TERMINAL_PROMPT: "0",
    };
    const idle = this.cfg.sandboxIdleSec;
    // The arguments after the verb: the same for `run -d` and `create`. Two literal verbs, so that the bypass test reads both.
    const rest = [
      "--init",
      "--name", opts.name,
      "--hostname", "sandbox",
      "--label", "mcp-everything=1",
      "--label", `mcp-everything.owner=${this.installationId}`,
      "--label", `mcp-everything.project=${opts.project}`,
      "--label", `mcp-everything.idle-timeout=${idle}`,
      ...this.limits(),
      // Root inside the container needs these to run package managers
      // (chown/setuid when unpacking and dropping privileges); nothing else.
      "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER",
      "--cap-add", "FSETID", "--cap-add", "SETUID", "--cap-add", "SETGID",
      "--network", "bridge",
      "-v", `${opts.volume}:${WORKSPACE}`,
      "-w", REPO_DIR,
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      ...(idle > 0
        ? ["--entrypoint", "/bin/sh", opts.image, "-c", WATCHDOG_SCRIPT, "watchdog", String(idle), String(watchdogPollSec(idle))]
        : ["--entrypoint", "sleep", opts.image, "infinity"]),
    ];
    const res = start ? await this.docker(["run", "-d", ...rest], { timeoutMs: 120_000 }) : await this.docker(["create", ...rest], { timeoutMs: 120_000 });
    if (res.code !== 0) {
      const refusal = this.runtimeRefusal(res.stderr);
      if (refusal) throw refusal;
      throw new Error(`Failed to ${start ? "start" : "create"} sandbox container: ${res.stderr.trim()}`);
    }
    const id = res.stdout.trim();
    if (!FULL_ID.test(id)) throw new Error(`Docker ${start ? "started" : "created"} a sandbox container but printed no usable id: ${oneLine(id, 80) || "(nothing)"}`);
    return makeRef(id, opts.name);
  }

  /**
   * Whose a container is, for a report to the operator: one read-only inspect by
   * name, classified by the same function as every guard. Never throws and never
   * changes anything: a failure to ask is "unavailable", which is not "missing".
   * It can take as long as the inspect's own limit (30 s) when the daemon hangs.
   */
  async ownership(name: string): Promise<OwnershipReport> {
    try {
      const c = await this.inspectContainer(name, true);
      if (!c) return { state: "missing" };
      const facts = this.containerFacts(name, c);
      return facts.owner === undefined || facts.cls !== "another" ? { state: facts.cls } : { state: facts.cls, owner: facts.owner };
    } catch {
      return { state: "unavailable" };
    }
  }

  /**
   * Make a sandbox usable by name, or hold on to a checked reference. Returns the
   * reference for a container that is mine, started if it was stopped; undefined
   * when it is not there; throws a refusal for any other (another's, not ours, or made before ownership was recorded).
   */
  async acquire(name: string): Promise<SandboxRef | undefined> {
    const c = await this.resolveContainer(name);
    if (!c) return undefined;
    this.refuseRuntimeMismatch(name, c);
    // The hook comes first: it may have to repair the network or the proxy before the sandbox starts (T14).
    const env = await this.hooked(c, name, "full");
    if (!c.running) await this.startId(c.id, name);
    // After a start Docker has rewritten `/etc/hosts`; a sandbox that was running is checked for its lines (the step is cheap and idempotent).
    await this.afterStarted(c, name, !c.running);
    return makeRef(c.id, name, env);
  }

  /**
   * Start a sandbox by name WITHOUT the containment hook, for containment's own use (its `contain` and the startup
   * pass of leg 10), which makes the network and the proxy itself. Classified and runtime-checked like `acquire`.
   * Only `Containment` calls it (a source-scan test enforces that). Undefined when it is not there.
   */
  async startForContainment(name: string): Promise<SandboxRef | undefined> {
    const c = await this.resolveContainer(name);
    if (!c) return undefined;
    this.refuseRuntimeMismatch(name, c);
    if (!c.running) {
      await this.startId(c.id, name, true);
      await this.afterStarted(c, name, true);
    }
    return makeRef(c.id, name);
  }

  /**
   * One inspect of a sandbox by name, classified (another's or not-ours is a refusal), for containment to see the
   * facts again after it waited. Never starts, execs or changes anything, and never calls the hook. Undefined when gone.
   */
  async inspectSandbox(name: string): Promise<SandboxInspectFacts | undefined> {
    const c = await this.resolveContainer(name);
    if (!c) return undefined;
    return { id: c.id, name: c.name ?? name, running: c.running, labels: c.labels, networks: [...c.networks], ...(c.networkIds ? { networkIds: { ...c.networkIds } } : {}), runtime: c.runtime };
  }

  /**
   * Run argv inside a sandbox, given by name (classified first) or by checked
   * reference. The command is wrapped in coreutils `timeout` so it is killed
   * inside the container, with a host-side kill as backstop.
   *
   * With the hook installed it asks the hook for the environment first (`restart: false`, the cleanup's exec,
   * gets the observe-only form and no runtime comparison, so that cleanup never stops on what it cannot repair).
   * A reference's answer is reused for `hookTtlMs` when the inspect said running (the cache); by name the inspect
   * happens anyway.
   */
  async exec(target: Target, argv: string[], opts: ExecOptions): Promise<ExecResult> {
    let id: string;
    const mode: ContainmentHookMode = opts.restart === false ? "observe" : "full";
    // The reference's own environment wins: a caller's `env` cannot take away what the reference carries.
    const caller: Record<string, string> = { ...opts.env };
    const refEnv = typeof target === "string" ? undefined : target.env;
    let fromHook: Record<string, string> | undefined;
    if (typeof target === "string") {
      const c = await this.resolveContainer(target);
      if (!c) throw this.doesNotExist(target);
      this.refuseRuntimeMismatch(target, c);
      id = c.id;
      fromHook = await this.hooked(c, target, mode);
    } else {
      id = target.id;
      if (this.hook) {
        const hit = mode === "full" ? this.hookCached(id) : undefined;
        if (hit) {
          fromHook = hit.env;
        } else {
          const c = await this.inspectContainer(id, true);
          if (c) {
            if (mode === "full") this.refuseRuntimeMismatch(target.name, c);
            fromHook = await this.hooked(c, target.name, mode, mode === "full");
          }
        }
      }
    }
    const first = await this.execOnce(id, argv, opts, { ...caller, ...fromHook, ...refEnv });
    if (opts.restart === false || !isStoppedExecFailure(first)) return first;
    // The sandbox idled out between the caller's liveness check and this exec.
    const again = await this.startIfStopped(id);
    if (!again) return first;
    // The retry uses the fresh answer of the hook that ran before the start, not the one from before it.
    return this.execOnce(id, argv, opts, { ...caller, ...(this.hook ? again.env : fromHook), ...refEnv });
  }

  /** On an id already checked: ask the hook, then start it if stopped; undefined when it is gone, else the hook's environment. */
  private async startIfStopped(id: string): Promise<{ env: Record<string, string> | undefined } | undefined> {
    const c = await this.inspectContainer(id, this.hook !== undefined);
    if (!c) return undefined;
    this.refuseRuntimeMismatch(id, c);
    const env = await this.hooked(c, id, "full");
    if (!c.running) {
      await this.startId(id, id);
      await this.afterStarted(c, id, true);
    }
    return { env };
  }

  /** `env` is already merged (reference over caller); it is validated here, before anything runs. */
  private async execOnce(container: string, argv: string[], opts: ExecOptions, env: Record<string, string> = {}): Promise<ExecResult> {
    const secs = Math.max(1, Math.floor(opts.timeoutSec));
    const args = ["exec", "-i"];
    if (opts.cwd) args.push("-w", opts.cwd);
    args.push(...envFlags(env));
    args.push(container, "timeout", "-k", "5", String(secs), ...argv);
    const started = Date.now();
    const res = await this.docker(args, {
      stdin: opts.stdin,
      timeoutMs: (secs + 15) * 1000,
      maxBytes: opts.maxBytes ?? this.cfg.maxOutputBytes,
      onOutput: opts.onOutput,
    });
    // 124: `timeout` fired. 137 once the limit has passed: SIGKILL after the
    // grace period. (137 earlier than that is something else, e.g. the OOM killer.)
    const overdue = Date.now() - started >= secs * 1000;
    const timedOut = res.timedOut || res.code === 124 || (res.code === 137 && overdue);
    return { ...res, timedOut };
  }

  /** The facts of a sandbox given by name (classified) or by reference (by id, labels not read); null when gone. */
  private async look(target: Target, withLabels = false): Promise<ContainerFacts | null> {
    return typeof target === "string" ? this.resolveContainer(target) : this.inspectContainer(target.id, withLabels);
  }

  /** "running", "stopped" or "missing". */
  async state(target: Target): Promise<"running" | "stopped" | "missing"> {
    const c = await this.look(target);
    if (!c) return "missing";
    return c.running ? "running" : "stopped";
  }

  /** Make sure the container is up; by name, returns false if it no longer exists. A reference that is gone is an error. */
  async ensureRunning(target: Target): Promise<boolean> {
    // A reference's labels are read only when a hook is there to be given them.
    const c = await this.look(target, this.hook !== undefined);
    if (!c) {
      if (typeof target === "string") return false;
      throw new Error(`Sandbox ${clean(target.name)} no longer exists`);
    }
    const label = typeof target === "string" ? target : target.name;
    this.refuseRuntimeMismatch(label, c);
    await this.hooked(c, label, "full");
    if (!c.running) {
      await this.startId(c.id, label);
      await this.afterStarted(c, label, true);
    }
    return true;
  }

  /**
   * "off" (on no network, or the container is gone), "contained" (on its own `-net` and nothing else) or "open"
   * (anything else: `bridge`, `bridge` and `-net`, another network). From one inspect. "contained" says only that
   * it is listed on its own network: whether that network exists is the caller's to check (T14).
   */
  async networkState(target: Target): Promise<NetworkMode> {
    const c = await this.look(target);
    if (!c) return "off";
    return networkModeOf(typeof target === "string" ? target : target.name, c.networks);
  }

  /**
   * "off": no network at all. "open": on `bridge`. "contained": on its own project network only (that network must
   * exist and be this project's; this method never makes it, and it never makes the proxy: leg 7 does). Leaving a
   * contained sandbox removes the project's proxies, then its `-net`, after all of them are classified. The sandbox
   * is never left with no network while it should be contained: it is attached to `-net` before `bridge` goes.
   */
  async setNetwork(target: Target, mode: NetworkMode): Promise<void> {
    try {
      await this.setNetworkNow(target, mode);
    } finally {
      // A change of network, whether or not it finished, ends what the hook last said about this sandbox.
      this.invalidate({ sandbox: typeof target === "string" ? target : target.name });
    }
  }

  private async setNetworkNow(target: Target, mode: NetworkMode): Promise<void> {
    if (mode !== "off" && mode !== "open" && mode !== "contained") throw new Error(`Unknown network mode ${JSON.stringify(mode)}`);
    const name = typeof target === "string" ? target : target.name;
    const c = await this.look(target);
    if (!c) {
      if (mode === "off" && typeof target === "string") return; // gone: nothing to detach
      throw typeof target === "string" ? this.doesNotExist(target) : new Error(`Sandbox ${clean(target.name)} no longer exists`);
    }
    const own = projectNetworkName(name);
    const onOwn = c.networks.includes(own);
    const onBridge = c.networks.includes("bridge");
    if (mode === "contained") {
      const project = c.labels?.[PROJECT_LABEL];
      const net = await this.findContainedNetwork(own, { role: PROJECT_NET_ROLE, sandbox: name, ...(project !== undefined ? { project } : {}) });
      if (!net) throw new Error(`The project network ${clean(own)} does not exist; it must be made before ${clean(name)} is contained`);
      const move = async (): Promise<void> => {
        await this.attachProjectNetwork(makeRef(c.id, name), net);
        if (onBridge) {
          const res = await this.docker(["network", "disconnect", "bridge", c.id], { timeoutMs: 60_000 });
          if (res.code !== 0) throw new Error(`Failed to disable network for ${clean(name)}: ${res.stderr.trim()}`);
        }
      };
      // gVisor does not see a network joined to a running sandbox: stop, attach, leave bridge, start (runc changes it live).
      if (this.needsRestartToChangeNetwork(c)) await this.whileStopped(c.id, name, move);
      else await move();
      return;
    }
    if (mode === "open") {
      if (onBridge) return;
      if (onOwn) {
        const objs = await this.projectObjects(name);
        this.refuseUnless(objs.facts);
        for (const p of objs.proxies) await this.rmProxy(p.id, p.name);
        await this.disconnectForce(own, c.id, name);
        if (objs.net) await this.rmNetwork(objs.net.id, objs.net.name);
        await this.clearLocalAccess(c, name);
      }
      const res = await this.docker(["network", "connect", "bridge", c.id], { timeoutMs: 60_000 });
      if (res.code !== 0) throw new Error(`Failed to enable network for ${clean(name)}: ${res.stderr.trim()}`);
      return;
    }
    // off
    if (c.networks.length === 0) return;
    if (!onOwn && c.networks.every((n) => n === "bridge")) {
      const res = await this.docker(["network", "disconnect", "bridge", c.id], { timeoutMs: 60_000 });
      if (res.code !== 0) throw new Error(`Failed to disable network for ${clean(name)}: ${res.stderr.trim()}`);
      return;
    }
    const objs = onOwn ? await this.projectObjects(name) : undefined;
    if (objs) this.refuseUnless(objs.facts);
    for (const n of c.networks) await this.disconnectForce(n, c.id, name);
    if (objs) {
      for (const p of objs.proxies) await this.rmProxy(p.id, p.name);
      if (objs.net) await this.rmNetwork(objs.net.id, objs.net.name);
      await this.clearLocalAccess(c, name);
    }
  }

  /**
   * Take the local-access lines out of a running sandbox's `/etc/hosts` when it leaves its project network (they name an
   * address that is no longer its proxy). Best effort: a failure never fails the network change, and a stopped sandbox
   * gets a fresh `/etc/hosts` at its next start anyway.
   */
  private async clearLocalAccess(c: ContainerFacts, name: string): Promise<void> {
    if (!c.running) return;
    try {
      await this.writeLocalAccess({ id: c.id, name }, "127.0.0.1", []);
    } catch (e) {
      this.log(`could not take the local-access names out of ${clean(name)}: ${oneLine((e as Error).message, 200)}`);
    }
  }

  private async rmContainer(id: string, name: string): Promise<void> {
    // `-v` removes the container's anonymous volumes only, never a named one.
    const rm = await this.docker(["rm", "-f", "-v", id], { timeoutMs: 120_000 });
    if (rm.code !== 0) throw new Error(`Failed to remove container ${clean(name)}: ${rm.stderr.trim()}`);
  }

  /** Remove a sandbox container but keep its volume (to rebuild on another image). */
  async removeContainer(target: Target): Promise<void> {
    const name = typeof target === "string" ? target : target.name;
    const c = await this.resolveContainer(typeof target === "string" ? target : target.id);
    if (!c) return;
    await this.rmContainer(c.id, name);
  }

  /**
   * Remove a project's container and volume. Both are classified before either
   * is removed: if either is another's or not ours, or Docker cannot be asked,
   * neither is. Missing resources are not errors.
   */
  async destroy(container: string, volume: string): Promise<void> {
    try {
      await this.destroyNow(container, volume);
    } finally {
      this.invalidate({ sandbox: container });
    }
  }

  private async destroyNow(container: string, volume: string): Promise<void> {
    const c = await this.inspectContainer(container, true);
    const v = await this.inspectVolume(volume);
    // The project's proxies and `-net` are found by the sandbox's name, so they are found after its container is gone.
    const objs = await this.projectObjects(container);
    const facts: SandboxFacts[] = [];
    if (c) facts.push(this.containerFacts(container, c));
    if (v) facts.push(this.volumeFacts(volume, v.labels));
    facts.push(...objs.facts);
    this.refuseUnless(facts);
    // Container, then its proxies, then the network (nothing is on it any more), then the volume.
    if (c) await this.rmContainer(c.id, container);
    for (const p of objs.proxies) await this.rmProxy(p.id, p.name);
    if (objs.net) await this.rmNetwork(objs.net.id, objs.net.name);
    if (v) {
      const rm = await this.docker(["volume", "rm", "-f", volume], { timeoutMs: 120_000 });
      if (rm.code !== 0) throw new Error(`Failed to remove volume ${clean(volume)}: ${rm.stderr.trim()}`);
    }
  }
}
