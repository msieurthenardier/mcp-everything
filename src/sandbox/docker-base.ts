import { randomBytes } from "node:crypto";
import type { Config } from "../config.js";
import { isInstallationId } from "../installation.js";
import type { HostEntry } from "../network/hosts.js";
import { run, type RunResult } from "../util/exec.js";
import { oneLine } from "../util/text.js";
import { DockerUnavailableError, RuntimeMismatchError, RuntimeUnavailableError } from "./errors.js";
import type { ProxyReport } from "./network-spec.js";
import {
  classifySandbox,
  clean,
  OWNER_LABEL,
  PROJECT_LABEL,
  ROLE_LABEL,
  SandboxRefusedError,
  type SandboxFacts,
  type SandboxInspectFacts,
} from "./ownership.js";
import { DEFAULT_PATH } from "./scripts.js";

/** A checked container: its full id and its name, and nothing else. */
export interface SandboxRef {
  readonly id: string;
  readonly name: string;
  /** Variables every exec through this reference carries; they win over a caller's `ExecOptions.env`. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * What the hook is asked for: "full" may repair the sandbox's proxy and network before the start or exec that
 * follows; "observe" (cleanup: an exec with `restart: false`) only answers the environment and changes nothing.
 */
export type ContainmentHookMode = "full" | "observe";

/**
 * The containment hook (leg 7): given one inspect's facts, it returns the environment a command in that sandbox
 * needs (the proxy's variables) or undefined, and it may throw to refuse the start or exec. It must use only
 * primitives that do not pass through the hook itself (a test counts the entries).
 */
export type ContainmentHook = (facts: SandboxInspectFacts, mode: ContainmentHookMode) => Promise<Record<string, string> | undefined>;

/**
 * The post-start step (leg 13): called after a sandbox is running, with its facts and whether Docker started it just
 * now (`started`) or it was already running. It writes the sandbox's local-access names into its `/etc/hosts`, which
 * Docker rewrites on every start. It must never throw (a failure is logged by the step itself), and it may use only
 * primitives that do not pass through the hook.
 */
export type AfterStartHook = (facts: SandboxInspectFacts, started: boolean) => Promise<void>;

const NOT_THERE = /no such (container|object|volume)/i;
/** Docker's wording for a network that is not there: `No such network` or, on the daemon this was measured on, `network X not found`. Networks only. */
const NETWORK_NOT_THERE = /no such network|\bnetwork \S+ not found\b/i;
export const FULL_ID = /^[0-9a-f]{64}$/;
/** The roles of the containers a one-shot call makes (the label and the name carry one). A network has its own role, below. */
export const ONE_SHOT_ROLES = ["clone", "scan", "copy", "runtime-check", "resolv-read", "oneshot-proxy"] as const;
const UNKNOWN_RUNTIME = "unknown or invalid runtime name";

/** What a one-shot container is for; the label and the name carry it, and nothing a caller types. */
export type OneShotRole = (typeof ONE_SHOT_ROLES)[number];
/** The only capabilities a one-shot container may be given beyond none. */
export type OneShotCap = "CHOWN" | "FOWNER" | "DAC_OVERRIDE" | "FSETID";
export interface OneShotSpec {
  role: OneShotRole;
  image: string;
  /** Required without `egress`; an error with it (the call makes its own network). */
  network?: string;
  /** Run behind a one-shot proxy on a contained network, allowed only these hosts. `local` is a scanner's (DD12). */
  egress?: { allow: HostEntry[]; local?: boolean };
  /** `-v` values, `<volume>:<path>[:ro]`. Callers must have classified the volumes. */
  mounts?: string[];
  /** `--mount` values (a read-only mount needs the long form's `readonly`). Callers must have classified the volumes. */
  mountFlags?: string[];
  /** A file of NAME=value lines for `--env-file`; the caller writes it, guards it and removes it. */
  envFile?: string;
  workdir?: string;
  /** When omitted, no `--entrypoint` flag: the image's own entrypoint runs. */
  entrypoint?: string;
  caps?: OneShotCap[];
  /** Arguments after the image. */
  args: string[];
  timeoutMs: number;
  maxBytes: number;
}

/** What `runOnce` returns: the run, and (only for a failed run behind a proxy) what the proxy refused. */
export type OneShotResult = RunResult & { proxy?: ProxyReport };

/** `{ networkIds }` from an inspect's `NetworkSettings.Networks`: the full ids it carries, by network name; nothing when it carries none. */
function networkIdsOf(networks: unknown): { networkIds?: Record<string, string> } {
  if (networks === null || typeof networks !== "object" || Array.isArray(networks)) return {};
  const ids: Record<string, string> = {};
  for (const [name, v] of Object.entries(networks as Record<string, unknown>)) {
    const id = v !== null && typeof v === "object" ? (v as { NetworkID?: unknown }).NetworkID : undefined;
    if (typeof id === "string" && FULL_ID.test(id)) ids[name] = id;
  }
  return Object.keys(ids).length > 0 ? { networkIds: ids } : {};
}

// A format that label content cannot confuse (every value is JSON). Never `{{json .}}`: it holds the environment.
const NETWORKS = '"networks":{{json .NetworkSettings.Networks}}';
const RUNTIME = '"runtime":{{json .HostConfig.Runtime}}';
const NAME = '"name":{{json .Name}}';
const BASE_FORMAT = `{"id":{{json .Id}},${NAME},"running":{{json .State.Running}},${RUNTIME},${NETWORKS}}`;
const FULL_FORMAT = `{"id":{{json .Id}},${NAME},"running":{{json .State.Running}},"labels":{{json .Config.Labels}},${RUNTIME},${NETWORKS}}`;

export interface ContainerFacts {
  id: string;
  /** The container's name, without Docker's leading `/`; absent when the answer has none (a scripted double). */
  name?: string;
  running: boolean;
  networks: string[];
  /** The id of each network by name (NetworkSettings.Networks[name].NetworkID), for the entries that carry one. */
  networkIds?: Record<string, string>;
  labels: Record<string, string> | null;
  /** HostConfig.Runtime; absent, null or empty when the daemon (or a test double) does not say. */
  runtime?: string;
}

export class DockerBase {
  /** The runtime name that passed `assertRuntime()` in this process. */
  protected runtimeOk: string | undefined;
  /** The check in flight, shared by concurrent callers. */
  protected runtimeCheck: Promise<void> | undefined;
  /** The daemon's DefaultRuntime, once `docker info` has answered. */
  protected daemonDefaultRuntime: string | undefined;
  /** The upstream DNS servers (or the read in flight): per instance, a failure is not kept. */
  protected upstreamResolvers: Promise<string[]> | undefined;
  /** How long a proxy has to become ready, and how often it is asked. A field so that tests can shorten both. */
  protected proxyReadiness = { budgetMs: 10_000, pollMs: 250 };
  /** The containment hook, once `setContainment` installed one. With none, every method behaves as it did before leg 7. */
  protected hook: ContainmentHook | undefined;
  /** The post-start step, installed with the hook. */
  private afterStartHook: AfterStartHook | undefined;
  /** The hook's answers for execs by reference on a running sandbox, by container id (see `hookedExecEnv`). */
  private hookCache = new Map<string, { env: Record<string, string> | undefined; expires: number; name: string; key: string | undefined }>();
  /** Bumped by every invalidation: a hook answer that was in flight across one is not cached. */
  private hookGeneration = 0;
  /** How long a hook answer is reused for an exec by reference. A field so that tests can shorten it. */
  protected hookTtlMs = 5_000;

  constructor(
    protected readonly cfg: Config,
    /** The installation id: it is in the name and the owner label of every sandbox this layer creates. */
    readonly installationId: string,
    /** Where startup warnings go (the runtime check's); nowhere by default. */
    protected readonly log: (line: string) => void = () => {},
  ) {
    if (!isInstallationId(installationId)) {
      throw new Error(`The installation id must be eight lowercase hexadecimal characters, got ${JSON.stringify(installationId)}.`);
    }
  }

  /** The one place the name prefix is joined to anything: the name of a sandbox's container and volume. */
  sandboxName(slug: string): string {
    return `${this.cfg.docker.namePrefix}${this.installationId}-${slug}`;
  }

  protected docker(args: string[], opts: Parameters<typeof run>[2] = {}): Promise<RunResult> {
    return run(this.cfg.docker.bin, args, opts);
  }

  /** The time the hook's cache is judged by. A method, so that a test can move it. */
  protected clock(): number {
    return Date.now();
  }

  /**
   * Install (or, with undefined, remove) the containment hook. Every sandbox start and exec of this class passes
   * through it (`acquire`, `ensureRunning`, the restart inside `exec`, and `exec` itself); nothing else does.
   */
  setContainment(hook: ContainmentHook | undefined, afterStart?: AfterStartHook): void {
    this.hook = hook;
    this.afterStartHook = hook ? afterStart : undefined;
    this.invalidate();
  }

  /** The post-start step for a sandbox that is running now (see `AfterStartHook`); nothing without one. */
  protected async afterStarted(c: ContainerFacts, label: string, started: boolean): Promise<void> {
    const step = this.afterStartHook;
    if (!step) return;
    await step(
      { id: c.id, name: c.name ?? label, running: true, labels: c.labels, networks: [...c.networks], ...(c.networkIds ? { networkIds: { ...c.networkIds } } : {}), runtime: c.runtime },
      started,
    );
  }

  /**
   * Forget the hook's cached answers: those for a container id, a sandbox name or a project key (lower-cased
   * repository id), or all of them with no filter. An answer that is being computed while this runs is discarded
   * when it arrives. Called by `setNetwork`, `destroy` and by containment after a replacement.
   */
  invalidate(filter: { id?: string; sandbox?: string; key?: string } = {}): void {
    this.hookGeneration++;
    const all = filter.id === undefined && filter.sandbox === undefined && filter.key === undefined;
    for (const [id, e] of this.hookCache) {
      if (all || filter.id === id || (filter.sandbox !== undefined && filter.sandbox === e.name) || (filter.key !== undefined && filter.key === e.key)) {
        this.hookCache.delete(id);
      }
    }
  }

  /**
   * The hook's answer for one inspect: the environment to give a command in this sandbox, or undefined (no hook,
   * or nothing to add). With `cache`, a sandbox that the inspect said is running keeps the answer for `hookTtlMs`.
   * The one place the hook is called; a stale answer for a contained sandbox fails closed.
   */
  protected async hooked(c: ContainerFacts, label: string, mode: ContainmentHookMode, cache = false): Promise<Record<string, string> | undefined> {
    const hook = this.hook;
    if (!hook) return undefined;
    const name = c.name ?? label;
    const generation = this.hookGeneration;
    const env = await hook(
      { id: c.id, name, running: c.running, labels: c.labels, networks: [...c.networks], ...(c.networkIds ? { networkIds: { ...c.networkIds } } : {}), runtime: c.runtime },
      mode,
    );
    if (cache && c.running && generation === this.hookGeneration) {
      this.hookCache.set(c.id, { env, expires: this.clock() + this.hookTtlMs, name, key: c.labels?.[PROJECT_LABEL]?.toLowerCase() });
    }
    return env;
  }

  /** A cached answer for an exec by reference, if one was stored within the last `hookTtlMs`. */
  protected hookCached(id: string): { env: Record<string, string> | undefined } | undefined {
    const e = this.hookCache.get(id);
    if (!e) return undefined;
    if (this.clock() >= e.expires) {
      this.hookCache.delete(id);
      return undefined;
    }
    return { env: e.env };
  }

  /** Throws a readable error unless the Docker daemon is reachable. */
  async assertAvailable(): Promise<void> {
    let res: RunResult;
    try {
      res = await this.docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15_000 });
    } catch (e) {
      throw new DockerUnavailableError(`Docker CLI "${this.cfg.docker.bin}" could not be run: ${(e as Error).message}`);
    }
    if (res.code !== 0) {
      throw new DockerUnavailableError(`Docker daemon is not reachable: ${res.stderr.trim() || "unknown error"}`);
    }
  }

  /** Run docker; a binary that cannot be run is "could not be asked". */
  protected async ask(args: string[], timeoutMs: number): Promise<RunResult> {
    try {
      return await this.docker(args, { timeoutMs });
    } catch (e) {
      throw new DockerUnavailableError(`Docker CLI "${this.cfg.docker.bin}" could not be run: ${(e as Error).message}`);
    }
  }

  /** True only for a clean, non-zero exit whose own error text says the object is not there. */
  protected isNotThere(res: RunResult, wording: RegExp = NOT_THERE): boolean {
    return typeof res.code === "number" && res.code !== 0 && !res.timedOut && !res.truncated && wording.test(res.stderr);
  }

  /** The same for a network command, whose "not there" has its own wording; containers and volumes keep the narrower pattern. */
  protected isNetworkNotThere(res: RunResult): boolean {
    return this.isNotThere(res, NETWORK_NOT_THERE);
  }

  protected unreadable(what: string, res: RunResult): DockerUnavailableError {
    const why = res.timedOut ? "it timed out" : res.code !== 0 ? oneLine(res.stderr, 200) || `exit code ${res.code}` : "its answer could not be read";
    return new DockerUnavailableError(`Could not find out about ${what}: ${why}`);
  }

  /**
   * One inspect of a container, by name or by full id. Null when it is not there;
   * throws DockerUnavailableError for any other failure or an answer of the wrong shape.
   * Reads labels only when asked to. Never changes anything.
   */
  protected async inspectContainer(target: string, withLabels: boolean): Promise<ContainerFacts | null> {
    const what = `container ${clean(target)}`;
    const res = await this.ask(["inspect", "--type", "container", "--format", withLabels ? FULL_FORMAT : BASE_FORMAT, target], 30_000);
    if (this.isNotThere(res)) return null;
    if (res.code !== 0 || res.timedOut || res.truncated) throw this.unreadable(what, res);
    let v: unknown;
    try {
      v = JSON.parse(res.stdout.trim());
    } catch {
      throw this.unreadable(what, { ...res, code: 0 });
    }
    const o = v as { id?: unknown; running?: unknown; labels?: unknown; networks?: unknown } | null;
    const isMap = (x: unknown): x is Record<string, unknown> => x === null || (typeof x === "object" && !Array.isArray(x));
    const labelsOk = !withLabels || (isMap(o?.labels) && Object.values(o?.labels ?? {}).every((x) => typeof x === "string"));
    if (!o || typeof o !== "object" || typeof o.id !== "string" || !FULL_ID.test(o.id) || typeof o.running !== "boolean" || !isMap(o.networks) || !labelsOk) {
      throw this.unreadable(what, { ...res, code: 0 });
    }
    const rt = (v as { runtime?: unknown }).runtime;
    const nm = (v as { name?: unknown }).name;
    return {
      id: o.id,
      ...(typeof nm === "string" && nm !== "" ? { name: nm.replace(/^\//, "") } : {}),
      running: o.running,
      networks: Object.keys(o.networks ?? {}),
      ...networkIdsOf(o.networks),
      labels: withLabels ? ((o.labels as Record<string, string> | null) ?? null) : null,
      ...(typeof rt === "string" && rt !== "" ? { runtime: rt } : {}),
    };
  }

  /**
   * With a runtime named, refuse a container created under another. An absent runtime field counts as the
   * daemon's default (from `docker info`, `runc` until that is known). Exact strings: an operator naming
   * `io.containerd.runc.v2` is refused on sandboxes Docker reports as `runc`, and the message says so.
   */
  protected refuseRuntimeMismatch(name: string, c: ContainerFacts): void {
    const named = this.cfg.docker.runtime;
    if (!named) return;
    const actual = c.runtime ?? this.daemonDefaultRuntime ?? "runc";
    if (actual !== named) throw new RuntimeMismatchError(name, named, actual);
  }

  /** Docker's own refusal of an unregistered runtime (never a fallback): the error to throw, or undefined for any other failure. */
  protected runtimeRefusal(stderr: string): RuntimeUnavailableError | undefined {
    const named = this.cfg.docker.runtime;
    if (!named) return undefined;
    const line = stderr.split("\n").find((l) => l.includes(UNKNOWN_RUNTIME) && l.includes(named));
    if (line === undefined) return undefined;
    this.runtimeOk = undefined;
    return new RuntimeUnavailableError(named, oneLine(line, 200));
  }

  /** The labels of a volume, or null-for-absent as `undefined`. Same rule as for a container. */
  protected async inspectVolume(name: string): Promise<{ labels: Record<string, string> | null } | undefined> {
    const what = `volume ${clean(name)}`;
    const res = await this.ask(["volume", "inspect", "--format", "{{json .Labels}}", name], 30_000);
    if (this.isNotThere(res)) return undefined;
    if (res.code !== 0 || res.timedOut || res.truncated) throw this.unreadable(what, res);
    let v: unknown;
    try {
      v = JSON.parse(res.stdout.trim());
    } catch {
      throw this.unreadable(what, { ...res, code: 0 });
    }
    if (v !== null && (typeof v !== "object" || Array.isArray(v) || !Object.values(v).every((x) => typeof x === "string"))) {
      throw this.unreadable(what, { ...res, code: 0 });
    }
    return { labels: v as Record<string, string> | null };
  }

  protected containerFacts(name: string, c: ContainerFacts): SandboxFacts {
    const cls = classifySandbox(c.labels, this.installationId);
    return { kind: "container", sandbox: name, cls, owner: c.labels?.[OWNER_LABEL], project: c.labels?.[PROJECT_LABEL] };
  }

  protected volumeFacts(name: string, labels: Record<string, string> | null): SandboxFacts {
    return { kind: "volume", sandbox: name, cls: classifySandbox(labels, this.installationId), owner: labels?.[OWNER_LABEL] };
  }

  protected refuseUnless(facts: SandboxFacts[]): void {
    if (facts.some((f) => f.cls === "another" || f.cls === "not-ours" || f.cls === "before")) throw new SandboxRefusedError(facts, this.installationId);
  }

  /** Classify a container by name: its facts when it is mine, null when not there, a refusal otherwise (a sandbox made before ownership included). */
  protected async resolveContainer(name: string): Promise<ContainerFacts | null> {
    const c = await this.inspectContainer(name, true);
    if (c) this.refuseUnless([this.containerFacts(name, c)]);
    return c;
  }

  protected async startId(id: string, label: string, mapRuntime = false): Promise<void> {
    const res = await this.ask(["start", id], 60_000);
    if (res.code !== 0) {
      // Docker's own refusal of an unregistered runtime is never a plain failure (a new sandbox's first start meets it here).
      const refusal = mapRuntime ? this.runtimeRefusal(res.stderr) : undefined;
      if (refusal) throw refusal;
      throw new Error(`Failed to start sandbox ${clean(label)}: ${res.stderr.trim()}`);
    }
  }

  protected doesNotExist(name: string): Error {
    return new Error(`Sandbox ${clean(name)} does not exist`);
  }

  /** `pullTimeoutMs` bounds the pull only (default 900 s); the local inspect keeps its own 30 s. */
  async ensureImage(image: string, onOutput?: (chunk: string) => void, pullTimeoutMs = 900_000): Promise<void> {
    const have = await this.docker(["image", "inspect", "--format", "{{.Id}}", image], { timeoutMs: 30_000 });
    if (have.code === 0) return;
    onOutput?.(`Pulling image ${image}…\n`);
    const pull = await this.docker(["pull", "--quiet", image], { timeoutMs: pullTimeoutMs });
    if (pull.code !== 0) throw new Error(`Failed to pull image ${image}: ${pull.stderr.trim()}`);
  }

  protected async imagePath(image: string): Promise<string> {
    const res = await this.docker(["image", "inspect", "--format", "{{json .Config.Env}}", image], {
      timeoutMs: 30_000,
    });
    try {
      const env = JSON.parse(res.stdout) as string[] | null;
      const entry = (env ?? []).find((e) => e.startsWith("PATH="));
      if (entry) return entry.slice(5);
    } catch {
      /* fall through */
    }
    return DEFAULT_PATH;
  }

  protected limits(): string[] {
    const d = this.cfg.docker;
    const args = [
      "--memory", d.memory,
      "--cpus", d.cpus,
      "--pids-limit", String(d.pidsLimit),
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
    ];
    if (d.runtime) args.push("--runtime", d.runtime);
    return args;
  }

  /**
   * Create, start attached and remove by id one owned container on `network`. `extra` are flags added after the
   * network (the proxy variables of a one-shot behind a proxy; none otherwise). `state.started` is set just before
   * the start, so that a caller can tell a run that failed from a create that did.
   */
  protected async runCreated(spec: OneShotSpec, network: string, extra: string[], state?: { started: boolean }): Promise<RunResult> {
    const caps = spec.caps ?? [];
    const name =`${this.cfg.docker.namePrefix}${this.installationId}-${spec.role}-${randomBytes(4).toString("hex")}`;
    const created = await this.docker(
      [
        "create", "--rm",
        "--name", name,
        "--label", "mcp-everything=1",
        "--label", `${OWNER_LABEL}=${this.installationId}`,
        "--label", `${ROLE_LABEL}=${spec.role}`,
        ...this.limits(),
        ...caps.flatMap((c) => ["--cap-add", c]),
        "--network", network,
        ...extra,
        ...(spec.mounts ?? []).flatMap((m) => ["-v", m]),
        ...(spec.mountFlags ?? []).flatMap((m) => ["--mount", m]),
        ...(spec.envFile !== undefined ? ["--env-file", spec.envFile] : []),
        ...(spec.workdir !== undefined ? ["-w", spec.workdir] : []),
        ...(spec.entrypoint !== undefined ? ["--entrypoint", spec.entrypoint] : []),
        spec.image,
        ...spec.args,
      ],
      { timeoutMs: 60_000 },
    );
    if (created.timedOut) {
      // The daemon may have made the container under this call's own random name. Remove it by that name.
      // Residual risk: it may still be created after this; leg 6's startup sweep removes it.
      // `-v` takes its anonymous volumes with it (the probe image declares one); it never removes a named volume.
      await this.docker(["rm", "-f", "-v", name], { timeoutMs: 30_000 }).catch(() => undefined);
      throw new Error(`Could not create the ${spec.role} container: docker create timed out`);
    }
    const id = created.stdout.trim();
    if (created.code !== 0) {
      const refusal = this.runtimeRefusal(created.stderr);
      if (refusal) throw refusal;
    }
    if (created.code !== 0) throw new Error(`Could not create the ${spec.role} container: ${created.stderr.trim().split("\n").slice(-3).join("\n") || "docker create failed"}`);
    if (!FULL_ID.test(id)) throw new Error(`Could not create the ${spec.role} container: Docker printed no usable id: ${oneLine(id, 80) || "(nothing)"}`);
    try {
      if (state) state.started = true;
      return await this.docker(["start", "-a", id], { timeoutMs: spec.timeoutMs, maxBytes: spec.maxBytes });
    } finally {
      try {
        // "No such container" is success (--rm may have removed it). Any other failure is ignored: it must
        // never mask the command's outcome, and leg 6's startup sweep removes what is left.
        await this.docker(["rm", "-f", "-v", id], { timeoutMs: 60_000 });
      } catch {
        /* as above */
      }
    }
  }
}
