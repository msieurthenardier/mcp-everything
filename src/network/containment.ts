import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Config } from "../config.js";
import type { Registry } from "../registry.js";
import type { Ecosystem, ProjectRecord } from "../types.js";
import {
  makeRef,
  networkModeOf,
  newProjectProxyName,
  PROJECT_LABEL,
  type ContainedNetwork,
  type ContainmentHook,
  type ContainmentHookMode,
  type NetworkMode,
  type ProjectProxy,
  type SandboxInspectFacts,
  type SandboxRef,
} from "../sandbox/docker.js";
import { buildHosts, DEFAULT_HOSTS_VERSION, sandboxHosts } from "./defaults.js";
import { formatHostEntry, parseHostEntry, PROXY_PORT, type HostEntry } from "./hosts.js";
import { localAccessFor, type LocalTarget } from "./local-access.js";
import { proxyConfig, PROXY_PROGRAM_VERSION, type ProxyConfig } from "./proxy/config.js";
import { startupAction, STARTUP_WARNING_PREFIX, type StartupKind, type StartupStepResult } from "./startup.js";

/**
 * Containment (flight 02, leg 7): the logic above the Docker layer that turns a project's record and the session's
 * configuration into a contained network and a proxy, keeps them right, and supplies the proxy environment that
 * every exec and every sandbox start goes through (`ensureContained`, installed as the Docker class's hook).
 *
 * Keys. Docker objects are named by the sandbox's name and the project label exactly as the sandbox carries it (from
 * the facts). The in-process mutex, the lock file, the startup promises and the cache groups are keyed by the
 * lower-cased repository id (`key`).
 */

/** The labels a project's proxy carries. */
export const RECORD_LABEL = "mcp-everything.proxy-record";
export const SESSION_LABEL = "mcp-everything.proxy-session";
export const VERSION_LABEL = "mcp-everything.proxy-version";

/** The proxy's address from the sandbox's side: its alias on the project network and the port it listens on. */
const PROXY_URL = `http://mcpe-proxy:${PROXY_PORT}`;

/** The environment a contained sandbox's commands get. */
export function proxyEnvironment(): Record<string, string> {
  return {
    HTTP_PROXY: PROXY_URL,
    HTTPS_PROXY: PROXY_URL,
    http_proxy: PROXY_URL,
    https_proxy: PROXY_URL,
    NO_PROXY: "",
    no_proxy: "",
    NODE_USE_ENV_PROXY: "1",
  };
}

export class ContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
/** The lock for a project could not be had within the wait: refused, which fails closed. */
export class ContainmentBusyError extends ContainmentError {}
/** The overall deadline of a replacement passed. */
export class ContainmentDeadlineError extends ContainmentError {}
/** The lock file's token is no longer ours: another process took the lock over. */
export class ContainmentLockLostError extends ContainmentError {}
/** The registry could not be read. */
export class ContainmentUnreadableError extends ContainmentError {}
/**
 * A startup step for the project was rejected; its sandbox's execs are refused until a contain or replace succeeds.
 * With `gate: true` it is the startup gate that failed (the listing of the sandboxes did): the hook then judges each
 * sandbox by its fresh facts instead of refusing every one.
 */
export class ContainmentStartupError extends ContainmentError {
  readonly gate: boolean;
  constructor(message: string, opts: { gate?: boolean } = {}) {
    super(message);
    this.gate = opts.gate ?? false;
  }
}

/** How long things take; a field of the options so that a test can move the clock instead of waiting. */
export interface Clock {
  /** Wall-clock milliseconds: what a lock file's age is judged by. */
  now(): number;
  /** Monotonic milliseconds: what the deadline is judged by. */
  mono(): number;
  /** A timer: resolves after `ms` unless cancelled. */
  after(ms: number): { promise: Promise<void>; cancel(): void };
  /** Wait `ms`. */
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  mono: () => performance.now(),
  after(ms) {
    let timer: NodeJS.Timeout | undefined;
    const promise = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    return { promise, cancel: () => clearTimeout(timer) };
  },
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

export const LIMITS = {
  /** The whole replacement, measured from the moment the lock is held. */
  deadlineMs: 90_000,
  /** How long a caller waits for the lock (mutex and file together). */
  lockWaitMs: 60_000,
  /** A lock file older than this belongs to a process that died. Longer than the deadline, so a live holder is never stale. */
  staleMs: 120_000,
  pollMs: 100,
  /** The proxy's resolver failures are read at most this often per project. */
  statusEveryMs: 60_000,
  /** How long "a newer proxy was kept" is remembered. */
  newerMemoryMs: 60_000,
  /** Resolver failures that make the proxy's resolvers suspect. */
  resolverFailures: 3,
} as const;

/** What `Containment` needs of the Docker layer; `Docker` is one, and a test's double is another. */
export interface ContainmentDocker {
  ensureImage(image: string): Promise<void>;
  ensureProjectNetwork(sandbox: string, project: string): Promise<ContainedNetwork & { created: boolean }>;
  findProjectNetwork(sandbox: string, project: string): Promise<ContainedNetwork | undefined>;
  attachProjectNetwork(sandbox: SandboxRef, net: { id: string; name: string }): Promise<void>;
  listProjectProxies(sandbox: string): Promise<ProjectProxy[]>;
  projectProxyAttached(id: string, net: { id: string; name: string }): Promise<boolean>;
  createProjectProxy(sandbox: string, project: string, config: ProxyConfig, labels: Record<string, string>, opts?: { name?: string }): Promise<{ id: string; name: string }>;
  startProjectProxy(id: string): Promise<void>;
  projectProxyStatus(id: string): Promise<unknown>;
  removeProjectProxy(id: string): Promise<void>;
  removeProjectProxyNamed(sandbox: string, name: string): Promise<void>;
  readUpstreamResolvers(): Promise<string[]>;
  invalidateResolvers(): void;
  setNetwork(target: string | SandboxRef, mode: NetworkMode): Promise<void>;
  networkState(target: string | SandboxRef): Promise<NetworkMode>;
  startForContainment(name: string): Promise<SandboxRef | undefined>;
  inspectSandbox(name: string): Promise<SandboxInspectFacts | undefined>;
  invalidate(filter?: { id?: string; sandbox?: string; key?: string }): void;
  setContainment(hook: ContainmentHook | undefined): void;
}

export interface ContainmentOptions {
  /** The directory the registry lives in: the lock files go beside it. */
  dataDir: string;
  log?: (line: string) => void;
  clock?: Clock;
  /**
   * A test-only seam: the default host table (leg 8). Defaults to `buildHosts` and `sandboxHosts`. It reaches every place
   * a record's allowance is computed (the configuration and the staleness check alike), so that a proxy built under it is
   * judged right by the hook. `App` never passes it.
   */
  defaults?: DefaultHosts;
}

type RegistryView = Pick<Registry, "refresh" | "findByRepo" | "update" | "putKeeping">;

/** The phase a record's proxy is for: the build's hosts while it installs, the sandbox's afterwards. */
export type Phase = "build" | "run";

/** The default host table as `allowanceFor` reads it. A test's seam replaces it (never a flag or a variable: `App` does not pass one). */
export interface DefaultHosts {
  build(ecosystems: readonly Ecosystem[]): string[];
  run(ecosystems: readonly Ecosystem[]): string[];
}
const DEFAULT_TABLE: DefaultHosts = { build: buildHosts, run: sandboxHosts };

export function phaseOf(record: Pick<ProjectRecord, "status">): Phase {
  return record.status === "installing" ? "build" : "run";
}

/** The same JSON with every object's keys sorted, so that the text is canonical. */
export function canonicalJson(value: unknown): string {
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) out[k] = sorted((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sorted(value));
}

const sha256 = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

/** What the record says the proxy may reach: the phase, the validated entries and the warnings for the ones dropped. */
export interface Allowance {
  phase: Phase;
  entries: HostEntry[];
  /** `formatHostEntry` of each entry, sorted. */
  texts: string[];
  warnings: string[];
}

/**
 * The allow list of a record: the build's hosts while it installs, the sandbox's afterwards, plus the record's own
 * `hosts`, each re-validated in agent mode. An entry that fails is dropped and named in `warnings`.
 */
export function allowanceFor(record: Pick<ProjectRecord, "status" | "ecosystems" | "hosts">, table: DefaultHosts = DEFAULT_TABLE): Allowance {
  const phase = phaseOf(record);
  const defaults = phase === "build" ? table.build(record.ecosystems) : table.run(record.ecosystems);
  // A file may have been edited by hand: whatever is not an array is no hosts, and each entry is judged below.
  const own: unknown = record.hosts;
  const raw: unknown[] = [...defaults, ...(Array.isArray(own) ? (own as unknown[]) : [])];
  const warnings: string[] = [];
  const seen = new Map<string, HostEntry>();
  for (const r of raw) {
    try {
      if (typeof r !== "string") throw new Error("is not a string");
      const entry = parseHostEntry(r, "agent");
      seen.set(formatHostEntry(entry), entry);
    } catch (e) {
      warnings.push(`The host ${JSON.stringify(String(r).slice(0, 80))} was dropped: ${(e as Error).message}`);
    }
  }
  const texts = [...seen.keys()].sort();
  return { phase, entries: texts.map((t) => seen.get(t)!), texts, warnings };
}

/** The label of what the record and the network decide: the phase, the allow list, the defaults' version, the `-net`'s id and subnet. */
export function recordLabelOf(allow: Allowance, net: { id: string; subnet: string }): string {
  return sha256(canonicalJson({ phase: allow.phase, allow: allow.texts, defaults: DEFAULT_HOSTS_VERSION, net: { id: net.id, subnet: net.subnet } }));
}

/** The label of what the session decides: the forwards, the resolvers, `MCPE_EXTRA_HOSTS` and the proxy image. */
export function sessionLabelOf(cfg: Pick<Config, "hosts" | "docker">, forwards: readonly LocalTarget[], resolvers: readonly string[]): string {
  return sha256(
    canonicalJson({
      forwards: [...forwards].map((f) => ({ host: f.host, port: f.port })).sort((a, b) => (a.host === b.host ? a.port - b.port : a.host < b.host ? -1 : 1)),
      resolvers: [...resolvers].sort(),
      extraHosts: cfg.hosts,
      image: cfg.docker.proxyImage,
    }),
  );
}

/** A proxy's program version from its label; absent or unparseable counts as 0, the oldest. */
export function proxyVersionOf(p: Pick<ProjectProxy, "labels">): number {
  const v = p.labels[VERSION_LABEL];
  return typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : 0;
}

const OUR_VERSION = Number(PROXY_PROGRAM_VERSION);

/** The proxy this record and network need: its configuration, its three labels and what was dropped on the way. */
export interface ProxyPlan {
  config: ProxyConfig;
  labels: Record<string, string>;
  warnings: string[];
}

export type ReplaceResult =
  | { kind: "unchanged"; proxy: { id: string; name: string }; warnings: string[] }
  | { kind: "replaced"; proxy: { id: string; name: string }; removed: number; warnings: string[] }
  /** A proxy of a newer program version is in place and was kept (an older session never replaces it). */
  | { kind: "kept-newer"; proxy?: { id: string; name: string }; warnings: string[] };

/** `sandbox` is the started reference, present only when `contain` was asked to start the sandbox. */
export type ContainResult = { ok: true; result: ReplaceResult; sandbox?: SandboxRef } | { ok: false; error: Error };

/** The project a call is about: the key, the sandbox's name and the project label exactly as the sandbox carries it. */
interface Subject {
  key: string;
  sandbox: string;
  project: string;
}

type Assessment = { kind: "ok" | "start"; proxy: ProjectProxy; newer: boolean } | { kind: "replace" };

/** A held lock: the mutex and the lock file, with the deadline and the token to check before anything is removed. */
interface HeldLock {
  /** Throws when the deadline has passed or the lock file's token is no longer ours. Called before others are removed. */
  assertLive(): void;
}

export class Containment {
  private readonly clock: Clock;
  private readonly log: (line: string) => void;
  /** The tail of each project's mutex chain. */
  private readonly tails = new Map<string, Promise<void>>();
  private readonly startups = new Map<string, { promise: Promise<void>; failed?: unknown }>();
  /** The startup gate (leg 10): covers the window before the pass has listed the sandboxes and registered each key. */
  private gate?: { promise: Promise<void>; pending: boolean; failed?: unknown };
  /** Keys a later successful contain, replace or repair cleared of a failed gate. */
  private readonly gateCleared = new Set<string>();
  /** When a project's resolver failures were last read, and until when "a newer proxy was kept" is remembered. */
  private readonly statusRead = new Map<string, number>();
  private readonly newerUntil = new Map<string, number>();
  private readonly newerLogged = new Set<string>();

  constructor(
    private readonly cfg: Config,
    private readonly registry: RegistryView,
    private readonly docker: ContainmentDocker,
    private readonly opts: ContainmentOptions,
  ) {
    this.clock = opts.clock ?? realClock;
    this.log = opts.log ?? (() => {});
  }

  /** Install this as the Docker layer's hook. */
  install(): void {
    this.docker.setContainment((facts, mode) => this.ensureContained(facts, mode));
  }

  // --- the configuration and its labels --------------------------------------------------------------------------

  /**
   * The proxy a record needs on a network: `allow` is the phase's hosts plus the record's own, `forwards` the
   * session's local access for the repository (a target named `mcpe-proxy` is refused with a warning), `resolvers`
   * the upstream ones, `listenCidr` the `-net`'s subnet.
   */
  async buildConfig(record: ProjectRecord, net: { id: string; subnet: string }): Promise<ProxyPlan> {
    const allow = allowanceFor(record, this.opts.defaults);
    const warnings = [...allow.warnings];
    // Local access applies only to the sandbox with its network on, never to a build (DD10).
    const wanted = allow.phase === "run" ? localAccessFor(this.cfg, record.repo) : [];
    const forwards = wanted.filter((f) => {
      if (f.host !== "mcpe-proxy") return true;
      warnings.push(`The local-access target ${f.host}:${f.port} was dropped: mcpe-proxy is the proxy's own name`);
      return false;
    });
    const resolvers = await this.docker.readUpstreamResolvers();
    const config = proxyConfig({ allow: allow.entries, forwards, listenCidr: net.subnet, resolvers });
    return {
      config,
      labels: {
        [RECORD_LABEL]: recordLabelOf(allow, net),
        [SESSION_LABEL]: sessionLabelOf(this.cfg, forwards, resolvers),
        [VERSION_LABEL]: PROXY_PROGRAM_VERSION,
      },
      warnings,
    };
  }

  // --- the startup pass's wait -----------------------------------------------------------------------------------

  /**
   * Leg 10 registers the promise of each project's startup step here, synchronously and before the server accepts
   * tool calls. Until it settles, the hook waits; a rejection refuses that sandbox's execs until a later successful
   * `contain` or `replace` for the key clears it, or the session restarts.
   */
  registerStartup(key: string, promise: Promise<void>): void {
    const k = key.toLowerCase();
    const entry: { promise: Promise<void>; failed?: unknown } = { promise };
    this.startups.set(k, entry);
    promise.then(
      () => {
        if (this.startups.get(k) === entry) this.startups.delete(k);
      },
      (e: unknown) => {
        entry.failed = e ?? new Error("rejected");
      },
    );
  }

  /**
   * Leg 10: the startup gate, registered synchronously in `start()` under `contained`, before any tool call can arrive.
   * It is pending until the pass has listed the sandboxes and registered one promise per project (`registerStartup`);
   * a key with none of its own waits for the gate while it is pending, and is not held after. The gate rejects only when
   * that listing itself failed: then an exec into a sandbox is refused unless the fresh facts show it off or contained,
   * until a successful contain, replace or repair of its key clears it (`ensureContained`).
   */
  registerStartupGate(promise: Promise<void>): void {
    const entry: { promise: Promise<void>; pending: boolean; failed?: unknown } = { promise, pending: true };
    this.gate = entry;
    this.gateCleared.clear();
    promise.then(
      () => {
        entry.pending = false;
      },
      (e: unknown) => {
        entry.pending = false;
        entry.failed = e ?? new Error("rejected");
      },
    );
  }

  /**
   * Waits for the project's startup step if one is registered, else for the gate while it is pending; the wait loops,
   * so that a key registered while the gate was pending is picked up. True when it waited (so facts may be stale).
   * Throws when the key's step failed, or (with `gate: true`) when the gate failed and the key is not cleared.
   */
  async waitFor(key: string): Promise<boolean> {
    const k = key.toLowerCase();
    let waited = false;
    for (;;) {
      const entry = this.startups.get(k);
      if (entry) {
        if (entry.failed !== undefined) throw this.startupFailure(k, entry.failed);
        waited = true;
        await entry.promise.catch(() => undefined);
        // The settle handlers registered with the promise have run by now: the entry is gone (resolved) or failed. A key whose own
        // promise resolved is done: it is not held behind a gate that is still pending.
        const after = this.startups.get(k);
        if (entry.failed === undefined && (after === undefined || after === entry)) return waited;
        continue;
      }
      const gate = this.gate;
      if (gate?.pending) {
        waited = true;
        await gate.promise.catch(() => undefined);
        continue;
      }
      if (gate?.failed !== undefined && !this.gateCleared.has(k)) {
        const text = gate.failed instanceof Error ? gate.failed.message : String(gate.failed);
        throw new ContainmentStartupError(`network containment could not be checked at startup: ${text.slice(0, 200)}`, { gate: true });
      }
      return waited;
    }
  }

  private startupFailure(key: string, reason: unknown): ContainmentStartupError {
    const text = reason instanceof Error ? reason.message : String(reason);
    return new ContainmentStartupError(`The startup step for ${key} failed (${text.slice(0, 200)}); its sandbox is refused until it is contained again.`);
  }

  /** A successful contain, replace, repair or startup step: the key's failed step is forgotten, and a failed gate no longer applies to it. */
  private clearFailedStartup(key: string): void {
    const e = this.startups.get(key);
    if (e && e.failed !== undefined) this.startups.delete(key);
    if (this.gate?.failed !== undefined) this.gateCleared.add(key);
  }

  // --- locks -----------------------------------------------------------------------------------------------------

  private lockPath(key: string): string {
    return path.join(this.opts.dataDir, `registry.json.proxy-${sha256(key).slice(0, 16)}.lock`);
  }

  /**
   * The one lock path: the in-process mutex and the lock file together, then the function under a 90 s deadline
   * that starts once both are held. The wait for both is bounded by 60 s (`ContainmentBusyError`, which fails
   * closed). The lock file is removed only if its token is still ours. "Locked" functions assume the caller holds it.
   */
  private async withProjectLock<T>(key: string, fn: (lock: HeldLock) => Promise<T>): Promise<T> {
    const waitStart = this.clock.mono();
    const releaseMutex = await this.acquireMutex(key);
    let file: { ours(): boolean; release(): void };
    try {
      file = await this.acquireFile(key, waitStart);
    } catch (e) {
      releaseMutex();
      throw e;
    }
    const startedMono = this.clock.mono();
    let aborted = false;
    const lock: HeldLock = {
      assertLive: () => {
        if (aborted || this.clock.mono() - startedMono > LIMITS.deadlineMs) {
          aborted = true;
          throw new ContainmentDeadlineError(`The replacement for ${key} passed its ${LIMITS.deadlineMs / 1000} s deadline.`);
        }
        if (!file.ours()) throw new ContainmentLockLostError(`The lock for ${key} was taken over while it was held; nothing was removed.`);
      },
    };
    // The mutex and the lock file are released only once `fn` has settled, even when the caller was refused at the
    // deadline earlier: a straggling `fn` (which keeps checking `assertLive`) never runs beside the next holder.
    const run = (async (): Promise<T> => {
      try {
        return await fn(lock);
      } finally {
        try {
          file.release();
        } finally {
          releaseMutex();
        }
      }
    })();
    const deadline = this.clock.after(LIMITS.deadlineMs);
    try {
      return await Promise.race([
        run,
        deadline.promise.then((): never => {
          aborted = true;
          throw new ContainmentDeadlineError(`The replacement for ${key} passed its ${LIMITS.deadlineMs / 1000} s deadline.`);
        }),
      ]);
    } finally {
      deadline.cancel();
    }
  }

  private async acquireMutex(key: string): Promise<() => void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    const timer = this.clock.after(LIMITS.lockWaitMs);
    try {
      const timedOut = await Promise.race([prev.then(() => false), timer.promise.then(() => true)]);
      if (timedOut) {
        // Our place in the chain stays, and is given up as soon as the one before us is done.
        void prev.then(release);
        throw new ContainmentBusyError(`Another replacement for ${key} is in progress and did not finish within ${LIMITS.lockWaitMs / 1000} s; this sandbox is refused rather than left uncontained.`);
      }
    } finally {
      timer.cancel();
    }
    return release;
  }

  /**
   * Remove a lock file judged stale, without ever removing a fresh one another waiter has just created: the file is
   * renamed to a name of our own, judged again there (a rename keeps the mtime), and only then deleted. If it turns
   * out fresh it is put back with an exclusive link.
   */
  private removeIfStale(file: string): void {
    const mine = `${file}.stale-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
    try {
      fs.renameSync(file, mine);
    } catch {
      return; // already gone
    }
    try {
      if (this.clock.now() - fs.statSync(mine).mtimeMs <= LIMITS.staleMs) {
        try {
          fs.linkSync(mine, file);
        } catch {
          // another lock was created meanwhile: this one is lost, and its holder finds out by its token
        }
      }
    } finally {
      fs.rmSync(mine, { force: true });
    }
  }

  private async acquireFile(key: string, waitStart: number): Promise<{ ours(): boolean; release(): void }> {
    const file = this.lockPath(key);
    fs.mkdirSync(this.opts.dataDir, { recursive: true, mode: 0o700 });
    const token = `${process.pid}:${crypto.randomBytes(16).toString("hex")}`;
    for (;;) {
      try {
        const fd = fs.openSync(file, "wx", 0o600);
        try {
          fs.writeSync(fd, token);
        } finally {
          fs.closeSync(fd);
        }
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      let age = 0;
      try {
        age = this.clock.now() - fs.statSync(file).mtimeMs;
      } catch {
        continue; // released between our two calls
      }
      if (age > LIMITS.staleMs) {
        this.removeIfStale(file);
        continue;
      }
      if (this.clock.mono() - waitStart >= LIMITS.lockWaitMs) {
        throw new ContainmentBusyError(`Another process is replacing the proxy for ${key} and did not finish within ${LIMITS.lockWaitMs / 1000} s; this sandbox is refused rather than left uncontained.`);
      }
      await this.clock.sleep(LIMITS.pollMs);
    }
    const ours = (): boolean => {
      try {
        return fs.readFileSync(file, "utf8") === token;
      } catch {
        return false;
      }
    };
    return {
      ours,
      release: () => {
        if (ours()) fs.rmSync(file, { force: true });
      },
    };
  }

  // --- the record ------------------------------------------------------------------------------------------------

  /** The project's record from the registry's file, read fresh; undefined when there is none. A registry that cannot be read is a refusal. */
  private peek(key: string): ProjectRecord | undefined {
    let captured: ProjectRecord | undefined;
    try {
      this.registry.refresh();
      const found = this.registry.findByRepo(key);
      if (found) {
        this.registry.update(found.slug, (cur) => {
          captured = cur === undefined ? undefined : structuredClone(cur);
          return undefined;
        });
      }
    } catch (e) {
      throw new ContainmentUnreadableError(`The registry could not be read: ${(e as Error).message}`);
    }
    return captured;
  }

  /** `peek`, but no record is an error, and (when asked) so is a record that now names another sandbox. */
  private fresh(key: string, expectContainer?: string): ProjectRecord {
    const captured = this.peek(key);
    if (!captured) throw new ContainmentError(`There is no record for ${key}.`);
    if (expectContainer !== undefined && captured.container !== expectContainer) {
      throw new ContainmentError(`The record for ${key} now names another sandbox (${captured.container}), not ${expectContainer}.`);
    }
    return captured;
  }

  private subjectFor(key: string): Subject {
    const k = key.toLowerCase();
    const record = this.fresh(k);
    return { key: k, sandbox: record.container, project: record.repo.id };
  }

  // --- replacement and containing --------------------------------------------------------------------------------

  /**
   * Replace a project's proxy with one for its record as it is now (the project's phase, hosts, forwards).
   * Steps: ensure the proxy image (outside the lock); take the lock; read the record fresh; ensure the network;
   * list the proxies; stop if a newer-version proxy is there (kept, never replaced, not even with `force`); build
   * the configuration; list again; unless `force`, stop if exactly one running proxy of this version has an equal
   * record label (and, with `compareSession`, session label) and is on the current network; create and wait for
   * the new proxy (removed again on any failure, the old ones kept); check the token; remove the others.
   */
  async replace(key: string, opts: { force?: boolean; compareSession?: boolean } = {}): Promise<ReplaceResult> {
    const k = key.toLowerCase();
    if ((this.newerUntil.get(k) ?? 0) > this.clock.now()) return { kind: "kept-newer", warnings: [] };
    const subject = this.subjectFor(k);
    await this.docker.ensureImage(this.cfg.docker.proxyImage);
    const result = await this.withProjectLock(k, (lock) => this.replaceLocked(lock, subject, opts));
    this.clearFailedStartup(k);
    return result;
  }

  /** The replacement, for a caller that holds the lock. */
  private async replaceLocked(lock: HeldLock, s: Subject, opts: { force?: boolean; compareSession?: boolean }): Promise<ReplaceResult> {
    const record = this.fresh(s.key, s.sandbox);
    const net = await this.docker.ensureProjectNetwork(s.sandbox, s.project);
    // The version is compared before the configuration is built: a newer proxy costs no resolver read.
    const first = await this.docker.listProjectProxies(s.sandbox);
    const keptEarly = await this.keepNewer(s, first);
    if (keptEarly) return keptEarly;
    const plan = await this.buildConfig(record, net);
    const current = await this.docker.listProjectProxies(s.sandbox);
    const keptLate = await this.keepNewer(s, current);
    if (keptLate) return { ...keptLate, warnings: plan.warnings };
    if (!opts.force && current.length === 1) {
      const p = current[0]!;
      const equal =
        p.running &&
        proxyVersionOf(p) === OUR_VERSION &&
        p.labels[RECORD_LABEL] === plan.labels[RECORD_LABEL] &&
        (!opts.compareSession || p.labels[SESSION_LABEL] === plan.labels[SESSION_LABEL]);
      if (equal && (await this.docker.projectProxyAttached(p.id, net))) return { kind: "unchanged", proxy: { id: p.id, name: p.name }, warnings: plan.warnings };
    }
    // The name is chosen here, so that it can be removed by name whatever happens to the call that creates it.
    const name = newProjectProxyName(s.sandbox);
    let keep = false;
    try {
      const made = await this.docker.createProjectProxy(s.sandbox, s.project, plan.config, plan.labels, { name });
      lock.assertLive();
      keep = true;
      let removed = 0;
      for (const p of current) {
        if (proxyVersionOf(p) > OUR_VERSION) continue; // never removed, not even by force
        await this.docker.removeProjectProxy(p.id);
        removed++;
      }
      return { kind: "replaced", proxy: made, removed, warnings: plan.warnings };
    } finally {
      try {
        if (!keep) await this.docker.removeProjectProxyNamed(s.sandbox, name);
      } catch (e) {
        this.log(`containment: could not remove the new proxy ${name} after a failure: ${(e as Error).message}`);
      }
      this.docker.invalidate({ sandbox: s.sandbox, key: s.key });
    }
  }

  /** When a proxy of a newer program is among these, keep it (starting it if none runs) and say so; else undefined. */
  private async keepNewer(s: Subject, proxies: ProjectProxy[]): Promise<ReplaceResult | undefined> {
    const newer = proxies.filter((p) => proxyVersionOf(p) > OUR_VERSION);
    if (newer.length === 0) return undefined;
    this.noteNewer(s.key);
    let chosen = newer.find((p) => p.running);
    if (!chosen) {
      chosen = newer[0]!;
      await this.docker.startProjectProxy(chosen.id);
    }
    return { kind: "kept-newer", proxy: { id: chosen.id, name: chosen.name }, warnings: [] };
  }

  private noteNewer(key: string): void {
    this.newerUntil.set(key, this.clock.now() + LIMITS.newerMemoryMs);
    if (!this.newerLogged.has(key)) {
      this.newerLogged.add(key);
      this.log(
        `containment: ${key} has a proxy built by a newer program version (this one is ${PROXY_PROGRAM_VERSION}); it is used as it is, under its allowlist. ` +
          `Hosts added since apply only when a session at least as new repairs it.`,
      );
    }
  }

  /**
   * Contain a project: its network, a ready proxy, then the sandbox on its own network only (attached before it
   * leaves `bridge`), then the hook's cache cleared. All under the project's lock. On a failure at any step the
   * sandbox is put on no network (never left on `bridge`) and the error is returned, not thrown.
   */
  async contain(key: string, opts: { start?: boolean } = {}): Promise<ContainResult> {
    const k = key.toLowerCase();
    let subject: Subject;
    try {
      subject = this.subjectFor(k);
    } catch (e) {
      return { ok: false, error: e as Error };
    }
    try {
      await this.docker.ensureImage(this.cfg.docker.proxyImage);
      const done = await this.withProjectLock(k, (lock) => this.containLocked(lock, subject, { start: opts.start }));
      this.clearFailedStartup(k);
      return { ok: true, result: done.result, ...(done.sandbox ? { sandbox: done.sandbox } : {}) };
    } catch (e) {
      // A failure inside the lock already took the sandbox off, inside the lock (`containLocked`); one before it (the
      // image, a busy lock) did not, and is handled here.
      if (!(typeof e === "object" && e !== null && this.offDone.delete(e))) {
        try {
          await this.docker.setNetwork(subject.sandbox, "off");
        } catch (off) {
          this.log(`containment: could not take ${subject.sandbox} off the network after a failure: ${(off as Error).message}`);
        }
      }
      return { ok: false, error: e as Error };
    }
  }

  /** Errors thrown by `containLocked` after it took the sandbox off, so that `contain` does not do it again. */
  private readonly offDone = new WeakSet<object>();

  /**
   * The contain, for a caller that holds the lock (`contain` and the startup step): the network and the proxy
   * (`replaceLocked`), then the sandbox on its own network only (attached before it leaves `bridge`), then the hook's cache
   * cleared, then (with `start`) the first start. On a failure at any step the sandbox is put on no network, inside the
   * lock, and the error is thrown. Calls no hooked method and neither waits nor takes the lock again.
   */
  private async containLocked(lock: HeldLock, subject: Subject, opts: { start?: boolean }): Promise<{ result: ReplaceResult; sandbox?: SandboxRef }> {
    try {
      const replaced = await this.replaceLocked(lock, subject, {}); // makes the network first, then the proxy
      await this.docker.setNetwork(subject.sandbox, "contained");
      this.docker.invalidate({ sandbox: subject.sandbox, key: subject.key });
      let started: SandboxRef | undefined;
      if (opts.start) {
        // The first start of a sandbox that was created stopped (T15): after it is contained, never before. The unhooked start,
        // because this is containment's own step; the lock is held and the network and the proxy were just made.
        started = await this.docker.startForContainment(subject.sandbox);
        if (!started) throw new ContainmentError(`The sandbox ${subject.sandbox} is gone: it could not be started.`);
      }
      return { result: replaced, ...(started ? { sandbox: started } : {}) };
    } catch (e) {
      if (typeof e === "object" && e !== null) this.offDone.add(e); // attempted here, once, whatever the outcome
      try {
        await this.docker.setNetwork(subject.sandbox, "off");
      } catch (off) {
        this.log(`containment: could not take ${subject.sandbox} off the network after a failure: ${(off as Error).message}`);
      }
      throw e;
    }
  }

  /** Take a sandbox off every network (its proxies and `-net` go with it), for a caller that holds the lock; then the hook's cache is cleared. */
  private async takeOffLocked(subject: Subject): Promise<void> {
    await this.docker.setNetwork(subject.sandbox, "off");
    this.docker.invalidate({ sandbox: subject.sandbox, key: subject.key });
  }

  /**
   * Opens a sandbox's network ("open", on `bridge`) unless it is contained: "never loosen" as one step. It takes the
   * project's lock, reads the network state, and calls `setNetwork("open")` only when the state is neither
   * `contained` nor already `open`, so a session that never contains cannot undo a containment another session made
   * between its own read and its write. Works under every session mode. `target` is the reference the caller checked
   * (the runtime comparison was made on it); without one the sandbox is addressed by name.
   */
  async openUnlessContained(key: string, target?: SandboxRef): Promise<{ state: NetworkMode; opened: boolean }> {
    const k = key.toLowerCase();
    const subject = this.subjectFor(k);
    const where = target ?? subject.sandbox;
    return this.withProjectLock(k, async () => {
      const state = await this.docker.networkState(where);
      if (state === "contained") return { state, opened: false };
      if (state === "open") return { state, opened: false };
      await this.docker.setNetwork(where, "open");
      return { state, opened: true };
    });
  }

  /**
   * Whether the project's proxy carries a different configuration than this session would build (another session's
   * hosts or defaults): true when no running proxy of the project has the record label this session computes.
   * Read-only, never repairs. Undefined when it cannot be told (nothing to compare, or Docker did not answer).
   */
  async proxyDiffers(key: string): Promise<boolean | undefined> {
    try {
      const k = key.toLowerCase();
      const subject = this.subjectFor(k);
      const net = await this.docker.findProjectNetwork(subject.sandbox, subject.project);
      if (!net) return undefined;
      const proxies = (await this.docker.listProjectProxies(subject.sandbox)).filter((p) => p.running);
      if (proxies.length === 0) return undefined;
      const wanted = recordLabelOf(allowanceFor(this.fresh(subject.key, subject.sandbox), this.opts.defaults), net);
      return !proxies.some((p) => p.labels[RECORD_LABEL] === wanted);
    } catch {
      return undefined;
    }
  }

  // --- repair and the hook ---------------------------------------------------------------------------------------

  private envIfContained(facts: SandboxInspectFacts): Record<string, string> | undefined {
    return networkModeOf(facts.name, facts.networks) === "contained" ? proxyEnvironment() : undefined;
  }

  /**
   * The Docker layer's hook. Facts come from one inspect; the answer is the proxy environment for a contained
   * sandbox, nothing otherwise.
   * - "observe" (cleanup): the environment if the facts say contained, nothing else, no record read.
   * - Under `open`: never waits, never repairs, never loosens; the environment if the facts say contained.
   * - Under `contained`: first await the project's startup step, then look again (if it waited) and branch on the
   *   fresh facts. No network or an open one is a no-op. A contained one is checked and repaired (the network by
   *   name, the proxy against the record label, never the session label) and given the environment.
   * A contained sandbox with no record gets no environment: the exec proceeds with no route and fails closed.
   */
  async ensureContained(facts: SandboxInspectFacts, mode: ContainmentHookMode): Promise<Record<string, string> | undefined> {
    const label = facts.labels?.[PROJECT_LABEL];
    if (label === undefined || label === "") return undefined; // a sandbox from before ownership: nothing is done
    if (mode === "observe" || this.cfg.network.mode !== "contained") return this.envIfContained(facts);
    const key = label.toLowerCase();
    let f = facts;
    // A per-key rejection (the pass failed to contain or repair this sandbox) propagates and refuses, whatever the state,
    // including a sandbox the failed contain left `off`: it stays refused until a later successful contain, replace or
    // repair of the key clears it (for example `set_project_network(true)`). Only the GATE's failure is caught here.
    let gateFailure: ContainmentStartupError | undefined;
    let waited = false;
    try {
      waited = await this.waitFor(key);
    } catch (e) {
      if (!(e instanceof ContainmentStartupError && e.gate)) throw e;
      gateFailure = e;
    }
    if (waited || gateFailure) {
      let again: SandboxInspectFacts | undefined;
      try {
        again = await this.docker.inspectSandbox(facts.name);
      } catch (e) {
        if (gateFailure) throw gateFailure; // the facts cannot be had: refused, with the gate's reason
        throw e;
      }
      if (!again) return undefined; // gone: the command fails on its own
      f = again;
    }
    const state = networkModeOf(f.name, f.networks);
    // The gate failed and this key was never checked: `bridge`, `open` and unknown are refused; `off` is safe; a contained
    // one goes on into the repair below (and a repair that succeeds clears the key).
    if (gateFailure && state === "open") throw gateFailure;
    if (state !== "contained") return undefined; // off and open are no-ops
    return this.repair(key, f, label);
  }

  private async repair(key: string, f: SandboxInspectFacts, label: string): Promise<Record<string, string> | undefined> {
    let record: ProjectRecord | undefined;
    try {
      this.registry.refresh();
      record = this.registry.findByRepo(key);
    } catch (e) {
      throw new ContainmentUnreadableError(`The registry could not be read: ${(e as Error).message}`);
    }
    if (!record) return undefined; // leg 10's pass removes orphans; with no proxy environment this fails closed
    // A sandbox that is not the record's (the old one of a renamed reinstall): observe only, never the record's configuration.
    if (record.container !== f.name) return proxyEnvironment();
    const s: Subject = { key, sandbox: f.name, project: label };
    const verdict = await this.checkUnlocked(s, record);
    if (verdict === "fine") {
      this.clearFailedStartup(key); // checked and right: a failed gate no longer applies to this key
      return proxyEnvironment();
    }
    // Only a repair needs the proxy image, and it is ensured outside the lock.
    if (verdict !== "start") await this.docker.ensureImage(this.cfg.docker.proxyImage);
    await this.withProjectLock(key, (lock) => this.repairLocked(lock, s, f, { resolverTrouble: verdict === "resolvers" }));
    this.clearFailedStartup(key);
    return proxyEnvironment();
  }

  /** The cheap, lock-free look: "fine", "start" (a stopped proxy), "resolvers" (many resolver failures) or "repair". */
  private async checkUnlocked(s: Subject, record: ProjectRecord): Promise<"fine" | "start" | "resolvers" | "repair"> {
    const net = await this.docker.findProjectNetwork(s.sandbox, s.project);
    if (!net) return "repair";
    const a = await this.assess(record, net, await this.docker.listProjectProxies(s.sandbox), s.key);
    if (a.kind === "replace") return "repair";
    if (a.kind === "start") return "start";
    return (await this.resolversFailing(s.key, a.proxy)) ? "resolvers" : "fine";
  }

  private async assess(record: ProjectRecord, net: ContainedNetwork, proxies: ProjectProxy[], key: string): Promise<Assessment> {
    const newer = proxies.filter((p) => proxyVersionOf(p) > OUR_VERSION);
    if (newer.length > 0) {
      this.noteNewer(key);
      const running = newer.find((p) => p.running);
      return running ? { kind: "ok", proxy: running, newer: true } : { kind: "start", proxy: newer[0]!, newer: true };
    }
    if (proxies.length !== 1) return { kind: "replace" };
    const p = proxies[0]!;
    // Never the session label here: that is compared at startup and on change, not on use.
    if (proxyVersionOf(p) !== OUR_VERSION || p.labels[RECORD_LABEL] !== recordLabelOf(allowanceFor(record, this.opts.defaults), net)) return { kind: "replace" };
    if (!(await this.docker.projectProxyAttached(p.id, net))) return { kind: "replace" };
    return { kind: p.running ? "ok" : "start", proxy: p, newer: false };
  }

  /** Whether the proxy reports enough resolver failures to distrust its resolvers; read at most once a minute per project. */
  private async resolversFailing(key: string, proxy: ProjectProxy): Promise<boolean> {
    const now = this.clock.now();
    const last = this.statusRead.get(key);
    if (last !== undefined && now - last < LIMITS.statusEveryMs) return false;
    this.statusRead.set(key, now);
    const st = (await this.docker.projectProxyStatus(proxy.id)) as { resolverFailures?: unknown } | undefined;
    const n = st?.resolverFailures;
    return typeof n === "number" && n >= LIMITS.resolverFailures;
  }

  /**
   * The repair, for a caller that holds the lock. Looks again, because the unlocked look may be out of date. With
   * `compareSession` (the startup step only) the session label is compared too, through the replacement's own check, so a
   * proxy built under another session's configuration is replaced; a newer-version proxy is kept. Returns the replacement's
   * result when it made one.
   */
  private async repairLocked(
    lock: HeldLock,
    s: Subject,
    f: SandboxInspectFacts,
    opts: { resolverTrouble?: boolean; compareSession?: boolean },
  ): Promise<ReplaceResult | undefined> {
    const record = this.fresh(s.key, s.sandbox);
    const net = await this.docker.ensureProjectNetwork(s.sandbox, s.project);
    // A network made again leaves the sandbox on the old one's name: attach it to the new one (T14).
    if (net.created) await this.docker.attachProjectNetwork(makeRef(f.id, f.name), net);
    if (opts.compareSession) return this.replaceLocked(lock, s, { compareSession: true });
    const a = await this.assess(record, net, await this.docker.listProjectProxies(s.sandbox), s.key);
    if (a.kind === "replace") return this.replaceLocked(lock, s, {});
    if (a.kind === "start") {
      await this.docker.startProjectProxy(a.proxy.id);
      return undefined;
    }
    if (opts.resolverTrouble && !a.newer) {
      this.docker.invalidateResolvers();
      return this.replaceLocked(lock, s, { force: true });
    }
    return undefined;
  }

  // --- the startup step (leg 10) ---------------------------------------------------------------------------------

  /**
   * One sandbox's step of the startup pass, as one locked step: under the project's lock it reads the record fresh and
   * inspects the sandbox fresh, decides with the pure `startupAction`, and acts with the lock-free internals
   * (`containLocked`, `repairLocked`, `takeOffLocked`). It never takes the lock itself again, never waits for a startup
   * promise and calls no hooked method (the unhooked start is the only start). It never starts a sandbox. A record that is
   * missing, a renamed container and a sandbox gone since the listing are "leave alone", not errors. A failed contain leaves
   * the sandbox off (as `contain` does) and throws; a failed repair throws and leaves the sandbox as it was. `settles` says
   * whether this is the sandbox the record names (the key's promise is its step's to settle). On success its key is cleared
   * of an earlier failure.
   */
  async startupStep(key: string, sandboxName: string): Promise<StartupStepResult> {
    const k = key.toLowerCase();
    const done = await this.withProjectLock(k, async (lock): Promise<StartupStepResult> => {
      const record = this.peek(k);
      const settles = record !== undefined && record.container === sandboxName;
      const facts = await this.docker.inspectSandbox(sandboxName);
      if (!facts) return { action: { kind: "leave-alone", reason: "gone" }, settles };
      const action = startupAction(record, facts, sandboxName, this.clock.now(), this.cfg);
      const subject: Subject = { key: k, sandbox: sandboxName, project: facts.labels?.[PROJECT_LABEL] ?? key };
      switch (action.kind) {
        case "leave-alone":
        case "skip":
        case "nothing":
          return { action, settles };
        case "reject":
          throw new ContainmentError(action.reason);
        case "contain":
          try {
            // A stopped sandbox stays stopped: the proxy is made and runs, the sandbox is only put on its network.
            await this.containLocked(lock, subject, { start: false });
          } catch (e) {
            this.startupWarning(record!, "contain-failed", `Network containment failed at startup and the sandbox was left off the network: ${(e as Error).message}`);
            throw e;
          }
          return { action, settles };
        case "repair": {
          const r = await this.repairLocked(lock, subject, facts, { compareSession: true });
          if (r?.kind === "kept-newer") {
            this.startupWarning(record!, "kept-newer-proxy", "A proxy built by a newer program version was kept as it is; it is used under its own allowlist.");
          }
          return { action, settles, ...(r ? { replaced: r.kind } : {}) };
        }
        case "take-off":
          await this.takeOffLocked(subject);
          if (action.warn) {
            this.startupWarning(record!, "take-off", "The sandbox was on the default network while its record says the network is off; it was taken off the network at startup.");
          }
          return { action, settles };
      }
    });
    if (done.settles) this.clearFailedStartup(k);
    return done;
  }

  /**
   * A warning on the record for the startup pass: bounded, written through `putKeeping` (the file's `hosts` and `network`
   * are kept, so a change another session made meanwhile is not undone), and replacing an earlier warning of the same kind.
   * A line is logged either way. Never throws.
   */
  private startupWarning(record: ProjectRecord, kind: StartupKind, text: string): void {
    const prefix = STARTUP_WARNING_PREFIX[kind];
    const line = `${prefix}${text.replace(/\s+/g, " ")}`.slice(0, 300);
    this.log(`startup: ${record.repo.id}: ${line}`);
    try {
      const next = structuredClone(record);
      next.warnings = [...next.warnings.filter((w) => !w.startsWith(prefix)), line];
      this.registry.putKeeping(next, ["hosts", "network"]);
    } catch (e) {
      this.log(`startup: ${record.repo.id}: the warning could not be written to its record: ${(e as Error).message}`);
    }
  }
}
