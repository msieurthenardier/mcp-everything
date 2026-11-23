import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../src/config.js";
import {
  Containment,
  ContainmentStartupError,
  RECORD_LABEL,
  SESSION_LABEL,
  VERSION_LABEL,
  type Clock,
  type ContainmentDocker,
} from "../src/network/containment.js";
import { PROXY_PROGRAM_VERSION, type ProxyConfig } from "../src/network/proxy/config.js";
import {
  dockerStateOf,
  NOT_FINISHED,
  startContainmentPass,
  startupAction,
  STARTUP_CONCURRENCY,
  STARTUP_PASS_LIMIT_MS,
  STARTUP_WARNING_PREFIX,
} from "../src/network/startup.js";
import { isStaleInstall, staleInstallLimitSec } from "../src/install/installer.js";
import { Registry } from "../src/registry.js";
import {
  makeRef,
  networkModeOf,
  PROJECT_LABEL,
  type ContainedNetwork,
  type ContainmentHook,
  type NetworkMode,
  type ProjectProxy,
  type SandboxInspectFacts,
  type SandboxRef,
} from "../src/sandbox/docker.js";
import type { ProjectRecord } from "../src/types.js";
import { record } from "./helpers.js";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const idOf = (name: string) => sha(name);
const tick = () => new Promise<void>((r) => setImmediate(r));
const flush = async (n = 30) => {
  for (let i = 0; i < n; i++) await tick();
};

class Deferred {
  promise: Promise<void>;
  resolve!: () => void;
  constructor() {
    this.promise = new Promise<void>((r) => {
      this.resolve = r;
    });
  }
}

/** A clock that moves only when a test moves it (or a poll's sleep does). */
class FakeClock implements Clock {
  wall = Date.now();
  monoMs = 0;
  private timers = new Set<{ due: number; fire: () => void }>();
  now() {
    return this.wall;
  }
  mono() {
    return this.monoMs;
  }
  after(ms: number) {
    let fire!: () => void;
    const promise = new Promise<void>((r) => {
      fire = r;
    });
    const t = { due: this.monoMs + ms, fire };
    this.timers.add(t);
    return { promise, cancel: () => void this.timers.delete(t) };
  }
  advance(ms: number) {
    this.wall += ms;
    this.monoMs += ms;
    for (const t of [...this.timers].sort((a, b) => a.due - b.due)) {
      if (t.due <= this.monoMs) {
        this.timers.delete(t);
        t.fire();
      }
    }
  }
  async sleep(ms: number) {
    this.advance(ms);
    await tick();
  }
  get pending() {
    return this.timers.size;
  }
}

interface FakeProxy extends ProjectProxy {
  netId?: string;
  alias: boolean;
}

/** The Docker layer as the pass and Containment see it, in memory, every call logged. */
class FakeLayer implements ContainmentDocker {
  calls: string[] = [];
  nets = new Map<string, ContainedNetwork>();
  sandboxes = new Map<string, { running: boolean; networks: string[]; labels: Record<string, string> }>();
  proxies: FakeProxy[] = [];
  resolvers = ["192.0.2.53"];
  createGate?: Deferred;
  /** An error for the creation of a proxy of the named sandbox. */
  createErrorFor = new Map<string, Error>();
  setNetworkError?: Error;
  listError?: Error;
  /** Runs after the listing (a test's seam for "something changed meanwhile"). */
  afterList?: () => void;
  /** The locks held (lock files in the data directory) each time an image was ensured. */
  lockedAtImage: number[] = [];
  imageError?: Error;
  onInspect?: (name: string) => Promise<void>;
  hook?: ContainmentHook;
  private n = 0;
  private proxyN = 0;
  constructor(private readonly lockCount: () => number) {}

  log(c: string) {
    this.calls.push(c);
  }
  count(prefix: string) {
    return this.calls.filter((c) => c === prefix || c.startsWith(`${prefix}:`)).length;
  }
  async listOwnSandboxes(): Promise<SandboxInspectFacts[]> {
    this.log("listOwnSandboxes");
    if (this.listError) throw this.listError;
    const out = [...this.sandboxes.entries()].map(([name, s]) => ({ id: idOf(name), name, running: s.running, labels: s.labels, networks: [...s.networks], runtime: undefined }));
    this.afterList?.();
    return out;
  }
  async ensureImage() {
    this.log("ensureImage");
    this.lockedAtImage.push(this.lockCount());
    if (this.imageError) throw this.imageError;
  }
  private net(sandbox: string): ContainedNetwork {
    const name = `${sandbox}-net`;
    const n = this.nets.get(name) ?? { id: idOf(`net${++this.n}${name}`), name, subnet: `172.30.${this.n}.0/24` };
    this.nets.set(name, n);
    return n;
  }
  async ensureProjectNetwork(sandbox: string, project: string) {
    this.log(`ensureProjectNetwork:${sandbox}:${project}`);
    const had = this.nets.has(`${sandbox}-net`);
    return { ...this.net(sandbox), created: !had };
  }
  async findProjectNetwork(sandbox: string) {
    return this.nets.get(`${sandbox}-net`);
  }
  async attachProjectNetwork(ref: SandboxRef, net: { id: string; name: string }) {
    this.log(`attachProjectNetwork:${ref.name}`);
    const s = this.sandboxes.get(ref.name);
    if (s && !s.networks.includes(net.name)) s.networks.push(net.name);
  }
  async restartSandbox(name: string) {
    this.log(`restartSandbox:${name}`);
  }
  async listProjectProxies(sandbox: string): Promise<ProjectProxy[]> {
    return this.proxies.filter((p) => p.name.startsWith(`${sandbox}-proxy-`)).map((p) => ({ id: p.id, name: p.name, running: p.running, labels: { ...p.labels } }));
  }
  async projectProxyAttached(id: string, net: { id: string }) {
    const p = this.proxies.find((x) => x.id === id);
    return p?.netId === net.id && p.alias;
  }
  /** Leg 13: replacement takes the old proxy off its network first, and puts it back when the new one fails. */
  async detachProjectProxy(id: string) {
    const p = this.proxies.find((x) => x.id === id);
    if (p) p.alias = false;
  }
  async restoreProjectProxy(id: string) {
    const p = this.proxies.find((x) => x.id === id);
    if (!p) throw new Error("it no longer exists");
    p.alias = true;
  }
  async writeLocalAccess() {}
  async createProjectProxy(sandbox: string, project: string, _config: ProxyConfig, labels: Record<string, string>, opts: { name?: string } = {}) {
    this.log(`createProjectProxy:${sandbox}`);
    const net = this.nets.get(`${sandbox}-net`);
    if (this.createGate) await this.createGate.promise;
    const err = this.createErrorFor.get(sandbox);
    if (err) throw err;
    const name = opts.name ?? `${sandbox}-proxy-${String(++this.proxyN).padStart(8, "0")}`;
    const p: FakeProxy = { id: idOf(name), name, running: true, labels: { [PROJECT_LABEL]: project, ...labels }, netId: net?.id, alias: true };
    this.proxies.push(p);
    return { id: p.id, name };
  }
  async startProjectProxy(id: string) {
    this.log("startProjectProxy");
    this.proxies.find((p) => p.id === id)!.running = true;
  }
  async projectProxyStatus() {
    return { ready: true, version: PROXY_PROGRAM_VERSION, resolverFailures: 0 };
  }
  async removeProjectProxy(id: string) {
    this.log("removeProjectProxy");
    this.proxies = this.proxies.filter((p) => p.id !== id);
  }
  async removeProjectProxyNamed(_sandbox: string, name: string) {
    this.proxies = this.proxies.filter((p) => p.name !== name);
  }
  async readUpstreamResolvers() {
    return [...this.resolvers];
  }
  invalidateResolvers() {}
  async setNetwork(target: string | SandboxRef, mode: NetworkMode) {
    const name = typeof target === "string" ? target : target.name;
    this.log(`setNetwork:${name}:${mode}`);
    if (this.setNetworkError && mode === "contained") throw this.setNetworkError;
    const s = this.sandboxes.get(name);
    if (!s) return;
    if (mode === "contained") s.networks = [`${name}-net`];
    if (mode === "open") s.networks = ["bridge"];
    if (mode === "off") {
      s.networks = [];
      this.proxies = this.proxies.filter((p) => !p.name.startsWith(`${name}-proxy-`));
      this.nets.delete(`${name}-net`);
    }
  }
  async networkState(target: string | SandboxRef): Promise<NetworkMode> {
    const name = typeof target === "string" ? target : target.name;
    const s = this.sandboxes.get(name);
    return s ? networkModeOf(name, s.networks) : "off";
  }
  async startForContainment(name: string): Promise<SandboxRef | undefined> {
    this.log(`startForContainment:${name}`);
    const s = this.sandboxes.get(name);
    if (!s) return undefined;
    s.running = true;
    return makeRef(idOf(name), name);
  }
  async inspectSandbox(name: string): Promise<SandboxInspectFacts | undefined> {
    this.log(`inspectSandbox:${name}`);
    await this.onInspect?.(name);
    const s = this.sandboxes.get(name);
    return s ? { id: idOf(name), name, running: s.running, labels: s.labels, networks: [...s.networks], runtime: undefined } : undefined;
  }
  invalidate() {}
  setContainment(hook: ContainmentHook | undefined) {
    this.hook = hook;
  }
}

let dir: string;
let clock: FakeClock;
let passClock: FakeClock;
let layer: FakeLayer;
let cfg: Config;
let reg: Registry;
let lines: string[];

const lockFiles = () => fs.readdirSync(dir).filter((n) => n.endsWith(".lock") && n.includes(".proxy-"));
const keyOf = (slug: string) => `github:owner/${slug}`;
const nameOf = (slug: string) => `mcpe-${slug}`;
const netOf = (slug: string) => `${nameOf(slug)}-net`;

/** A project: its record (unless `record: false`) and its sandbox. */
function proj(
  slug: string,
  o: { network?: boolean; status?: ProjectRecord["status"]; networks?: string[]; running?: boolean; record?: boolean; container?: string; sandboxName?: string; installedAt?: string } = {},
): ProjectRecord {
  const r: ProjectRecord = { ...record(slug), ecosystems: ["node"], network: o.network ?? true, status: o.status ?? "ready", ...(o.container ? { container: o.container } : {}), ...(o.installedAt ? { installedAt: o.installedAt } : {}) };
  if (o.record !== false) reg.put(r);
  const name = o.sandboxName ?? r.container;
  layer.sandboxes.set(name, { running: o.running ?? true, networks: o.networks ?? ["bridge"], labels: { [PROJECT_LABEL]: r.repo.id } });
  return r;
}

const make = (c: Config = cfg): Containment => new Containment(c, reg, layer, { dataDir: dir, clock, log: (l) => lines.push(l) });
const stored = (slug: string): ProjectRecord => {
  reg.refresh();
  return reg.get(slug)!;
};
const warnings = (slug: string) => stored(slug).warnings;
const nets = (name: string) => layer.sandboxes.get(name)!.networks;
const proxiesOf = (name: string) => layer.proxies.filter((p) => p.name.startsWith(`${name}-proxy-`));

function pass(c: Containment, over: Partial<Parameters<typeof startContainmentPass>[0]> = {}): Promise<void> {
  return startContainmentPass({ containment: c, docker: layer, registry: reg, cfg, clock: passClock, log: (l) => lines.push(l), ...over });
}

function facts(slug: string, networks: string[]): SandboxInspectFacts {
  return { id: idOf(nameOf(slug)), name: nameOf(slug), running: true, labels: { [PROJECT_LABEL]: keyOf(slug) }, networks, runtime: undefined };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-startup-"));
  clock = new FakeClock();
  passClock = new FakeClock();
  layer = new FakeLayer(() => lockFiles().length);
  cfg = loadConfig({ MCPE_NETWORK: "contained", MCPE_DATA_DIR: dir });
  reg = new Registry(dir);
  lines = [];
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("startupAction: the table, one case per row id (pure)", () => {
  const now = Date.now();
  const rec = (o: Partial<ProjectRecord> = {}): ProjectRecord => ({ ...record("app"), network: true, ...o });
  const NAME = "mcpe-app";
  const NET = `${NAME}-net`;
  const act = (r: ProjectRecord | undefined, networks: string[], name = NAME) => startupAction(r, { networks }, name, now, cfg);

  it("R1 no record: leave alone, whatever Docker shows", () => {
    for (const n of [[], ["bridge"], [NET]]) expect(act(undefined, n)).toEqual({ kind: "leave-alone", reason: "no-record" });
  });
  it("R2 the record names another container (a renamed reinstall's old sandbox, a twin): leave alone", () => {
    for (const n of [[], ["bridge"], [NET]]) expect(act(rec({ container: "mcpe-new" }), n)).toEqual({ kind: "leave-alone", reason: "other-sandbox" });
  });
  it("R3 installing and not stale: skip, whatever Docker shows", () => {
    const young = rec({ status: "installing", installedAt: new Date(now - 60_000).toISOString() });
    for (const n of [[], ["bridge"], [NET]]) expect(act(young, n)).toEqual({ kind: "skip" });
  });
  it("R3 a stale installing record follows its network flag like any other", () => {
    const stale = rec({ status: "installing", installedAt: new Date(now - (staleInstallLimitSec(cfg) + 10) * 1000).toISOString() });
    expect(act(stale, ["bridge"])).toEqual({ kind: "contain" });
  });
  it("R4 record on, bridge (alone or with -net), ready or failed: contain", () => {
    for (const status of ["ready", "failed"] as const) for (const n of [["bridge"], ["bridge", NET]]) expect(act(rec({ status }), n)).toEqual({ kind: "contain" });
  });
  it("R5 record on, -net only: repair", () => {
    expect(act(rec(), [NET])).toEqual({ kind: "repair" });
  });
  it("R6 record on, no network: contain (the record's on is the intent)", () => {
    expect(act(rec(), [])).toEqual({ kind: "contain" });
  });
  it("R7 record off, bridge (alone or with -net): take off, with a warning", () => {
    for (const n of [["bridge"], ["bridge", NET]]) expect(act(rec({ network: false }), n)).toEqual({ kind: "take-off", warn: true });
  });
  it("R8 record off, -net: take off, no warning", () => {
    expect(act(rec({ network: false }), [NET])).toEqual({ kind: "take-off", warn: false });
  });
  it("R9 record off, no network: nothing", () => {
    expect(act(rec({ network: false }), [])).toEqual({ kind: "nothing" });
  });
  it("R10 record on, a network mcp-everything does not manage: rejected with the reason", () => {
    for (const n of [["other"], ["bridge", "other"], [NET, "other"]]) {
      expect(act(rec(), n)).toEqual({ kind: "reject", reason: "attached to a network mcp-everything does not manage" });
    }
  });
  it("R11 record off, a network mcp-everything does not manage: take off, with a warning", () => {
    expect(act(rec({ network: false }), ["other"])).toEqual({ kind: "take-off", warn: true });
  });
  it("classifies Docker's networks: none, bridge, own, foreign", () => {
    expect(dockerStateOf(NAME, [])).toBe("none");
    expect(dockerStateOf(NAME, ["bridge"])).toBe("bridge");
    expect(dockerStateOf(NAME, ["bridge", NET])).toBe("bridge");
    expect(dockerStateOf(NAME, [NET])).toBe("own");
    expect(dockerStateOf(NAME, ["mcpe-x-net"])).toBe("foreign");
  });
});

describe("isStaleInstall (exported from the installer)", () => {
  it("is true only for an installing record older than the limit; never for another status or an unreadable date", () => {
    const now = Date.now();
    const limit = staleInstallLimitSec(cfg) * 1000;
    const r = (o: Partial<ProjectRecord>): ProjectRecord => ({ ...record("app"), ...o });
    expect(isStaleInstall(r({ status: "installing", installedAt: new Date(now - limit - 1000).toISOString() }), now, cfg)).toBe(true);
    expect(isStaleInstall(r({ status: "installing", installedAt: new Date(now - limit + 60_000).toISOString() }), now, cfg)).toBe(false);
    expect(isStaleInstall(r({ status: "ready", installedAt: new Date(now - limit - 1000).toISOString() }), now, cfg)).toBe(false);
    expect(isStaleInstall(r({ status: "installing", installedAt: "not a date" }), now, cfg)).toBe(false);
    expect(isStaleInstall(r({ status: "installing", installedAt: new Date(now + 60_000).toISOString() }), now, cfg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("the gate and waitFor", () => {
  const K = keyOf("app");

  it("an unregistered key waits for the gate while it is pending, and is not held after it", async () => {
    const c = make();
    const gate = new Deferred();
    c.registerStartupGate(gate.promise);
    let done = false;
    const w = c.waitFor(K).then((waited) => {
      done = true;
      return waited;
    });
    await flush();
    expect(done).toBe(false);
    gate.resolve();
    expect(await w).toBe(true);
    expect(await c.waitFor(K)).toBe(false);
  });

  it("with no gate and no key promise, waitFor resolves at once", async () => {
    expect(await make().waitFor(K)).toBe(false);
  });

  it("a key resolved early while the gate is pending is not held behind it", async () => {
    const c = make();
    c.registerStartupGate(new Promise<void>(() => {})); // never settles
    c.registerStartup(K, Promise.resolve());
    // It is its own promise that counts, not the gate: but a key with none is held (the contrast).
    let other = false;
    void c.waitFor(keyOf("other")).then(() => (other = true));
    expect(await c.waitFor(K)).toBe(true); // waited for its own promise, which is already settled; the gate is not awaited
    await flush();
    expect(other).toBe(false);
  });

  it("waitFor loops after the gate: a key registered while it was pending is waited for", async () => {
    const c = make();
    const gate = new Deferred();
    const own = new Deferred();
    c.registerStartupGate(gate.promise);
    let done = false;
    const w = c.waitFor(K).then(() => (done = true));
    await flush();
    c.registerStartup(K, own.promise); // the pass's synchronous block: register, then release
    gate.resolve();
    await flush();
    expect(done).toBe(false); // the key's own promise now holds it
    own.resolve();
    await w;
    expect(done).toBe(true);
  });

  it("a rejected key refuses with leg 7's message whatever the gate says", async () => {
    const c = make();
    const gate = new Deferred();
    c.registerStartupGate(gate.promise);
    c.registerStartup(K, Promise.reject(new Error("the pass could not contain it")));
    gate.resolve();
    await expect(c.waitFor(K)).rejects.toThrow(/startup step for github:owner\/app failed \(the pass could not contain it\)/);
    await expect(c.waitFor(K)).rejects.toSatisfy((e: unknown) => e instanceof ContainmentStartupError && !e.gate);
  });

  it("a rejected gate throws a distinguishable error with the reason", async () => {
    const c = make();
    c.registerStartupGate(Promise.reject(new Error("Docker is not reachable")));
    await expect(c.waitFor(K)).rejects.toSatisfy(
      (e: unknown) => e instanceof ContainmentStartupError && e.gate && e.message === "network containment could not be checked at startup: Docker is not reachable",
    );
  });

  it("a successful contain clears a failed gate for its key only", async () => {
    proj("app", { networks: ["bridge"] });
    const c = make();
    c.registerStartupGate(Promise.reject(new Error("down")));
    await expect(c.waitFor(K)).rejects.toBeInstanceOf(ContainmentStartupError);
    expect((await c.contain(K)).ok).toBe(true);
    expect(await c.waitFor(K)).toBe(false);
    await expect(c.waitFor(keyOf("other"))).rejects.toBeInstanceOf(ContainmentStartupError);
  });

  describe("the hook under a failed gate", () => {
    it("refuses a sandbox on bridge, with the gate's reason; an off sandbox passes; a contained one is repaired and cleared", async () => {
      proj("app", { networks: ["bridge"] });
      const c = make();
      c.registerStartupGate(Promise.reject(new Error("down")));
      await expect(c.ensureContained(facts("app", ["bridge"]), "full")).rejects.toThrow(/could not be checked at startup: down/);
      await expect(c.ensureContained(facts("app", ["bridge", netOf("app")]), "full")).rejects.toThrow(/could not be checked at startup/); // open
      layer.sandboxes.get(nameOf("app"))!.networks = [];
      expect(await c.ensureContained(facts("app", []), "full")).toBeUndefined(); // off: nothing to route

      // A contained one: the fresh inspect says contained, so the repair runs and the key is cleared.
      layer.sandboxes.set(nameOf("app"), { running: true, networks: [netOf("app")], labels: { [PROJECT_LABEL]: K } });
      expect(Object.keys((await c.ensureContained(facts("app", [netOf("app")]), "full")) ?? {})).toContain("HTTP_PROXY");
      expect(await c.waitFor(K)).toBe(false);
    });

    it("refuses when the fresh facts cannot be had, with the gate's reason", async () => {
      proj("app", { networks: ["bridge"] });
      const c = make();
      c.registerStartupGate(Promise.reject(new Error("down")));
      layer.onInspect = async () => {
        throw new Error("inspect failed");
      };
      await expect(c.ensureContained(facts("app", [netOf("app")]), "full")).rejects.toThrow(/could not be checked at startup: down/);
    });

    it("observe mode is never refused", async () => {
      const c = make();
      c.registerStartupGate(Promise.reject(new Error("down")));
      expect(await c.ensureContained(facts("app", ["bridge"]), "observe")).toBeUndefined();
    });

    it("a per-key rejection refuses whatever the state, including a sandbox the failed contain left off, until a contain succeeds", async () => {
      proj("app", { networks: ["bridge"] });
      const c = make();
      c.registerStartup(K, Promise.reject(new Error("could not contain")));
      layer.sandboxes.get(nameOf("app"))!.networks = [];
      await expect(c.ensureContained(facts("app", []), "full")).rejects.toBeInstanceOf(ContainmentStartupError);
      expect((await c.contain(K)).ok).toBe(true);
      expect(Object.keys((await c.ensureContained(facts("app", [netOf("app")]), "full")) ?? {})).toContain("HTTP_PROXY");
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("the pass", () => {
  it("registers the gate synchronously, before it returns: a wait started at once is held until the pass has listed", async () => {
    proj("app", { networks: ["bridge"] });
    const c = make();
    let reached = false;
    layer.afterList = () => {
      reached = true;
    };
    const after = new Deferred();
    const p = pass(c, { after: after.promise }); // not awaited
    let settled = false;
    const w = c.waitFor(keyOf("unknown")).then(() => (settled = true));
    await flush(5);
    expect(settled).toBe(false);
    after.resolve();
    await p;
    await w;
    expect(reached).toBe(true);
    expect(settled).toBe(true);
  });

  it("waits for the reconciliation before it lists (the records must be reconciled)", async () => {
    proj("app", { networks: ["bridge"] });
    const after = new Deferred();
    const p = pass(make(), { after: after.promise });
    await flush();
    expect(layer.count("listOwnSandboxes")).toBe(0);
    after.resolve();
    await p;
    expect(layer.count("listOwnSandboxes")).toBe(1);
  });

  describe("every row, end to end", () => {
    it("R4 an open sandbox with the record on is contained: its -net only, one proxy", async () => {
      proj("app", { networks: ["bridge"] });
      await pass(make());
      expect(nets("mcpe-app")).toEqual([netOf("app")]);
      expect(proxiesOf("mcpe-app")).toHaveLength(1);
      expect(lines.some((l) => /pass: contain 1/.test(l))).toBe(true);
    });

    it("R6 no network, the record on: contained", async () => {
      proj("app", { networks: [] });
      await pass(make());
      expect(nets("mcpe-app")).toEqual([netOf("app")]);
    });

    it("R4 a stopped sandbox is contained and stays stopped: the proxy runs, no start is made", async () => {
      proj("app", { networks: ["bridge"], running: false });
      await pass(make());
      expect(nets("mcpe-app")).toEqual([netOf("app")]);
      expect(layer.sandboxes.get("mcpe-app")!.running).toBe(false);
      expect(layer.count("startForContainment")).toBe(0);
      expect(proxiesOf("mcpe-app")[0]!.running).toBe(true);
    });

    it("R7 the record off on bridge: taken off (fail-safe), the record stays off, one warning on it", async () => {
      proj("app", { network: false, networks: ["bridge"] });
      await pass(make());
      expect(nets("mcpe-app")).toEqual([]);
      expect(layer.count("createProjectProxy")).toBe(0);
      expect(stored("app").network).toBe(false);
      const w = warnings("app").filter((x) => x.startsWith(STARTUP_WARNING_PREFIX["take-off"]));
      expect(w).toHaveLength(1);
      expect(w[0]!.length).toBeLessThanOrEqual(300);
      expect(lines.some((l) => l.includes("taken off the network"))).toBe(true);
    });

    it("R7 a second startup replaces the warning of its kind instead of piling up", async () => {
      proj("app", { network: false, networks: ["bridge"] });
      await pass(make());
      layer.sandboxes.get("mcpe-app")!.networks = ["bridge"];
      await pass(make());
      expect(warnings("app").filter((x) => x.startsWith(STARTUP_WARNING_PREFIX["take-off"]))).toHaveLength(1);
    });

    it("R8 the record off on its -net: taken off, with no warning", async () => {
      proj("app", { network: false, networks: [netOf("app")] });
      await pass(make());
      expect(nets("mcpe-app")).toEqual([]);
      expect(warnings("app")).toEqual([]);
    });

    it("R9 the record off, no network: nothing is changed", async () => {
      proj("app", { network: false, networks: [] });
      await pass(make());
      expect(layer.calls.filter((c) => c.startsWith("setNetwork") || c.startsWith("createProjectProxy"))).toEqual([]);
    });

    it("R1 no record: the sandbox is left alone, no lock is taken and nothing is registered", async () => {
      proj("app", { record: false, networks: ["bridge"] });
      const c = make();
      let registered = 0;
      const orig = c.registerStartup.bind(c);
      c.registerStartup = (k, p) => {
        registered++;
        orig(k, p);
      };
      await pass(c);
      expect(nets("mcpe-app")).toEqual(["bridge"]);
      expect(layer.calls.filter((x) => x.startsWith("setNetwork") || x.startsWith("inspectSandbox"))).toEqual([]);
      expect(registered).toBe(0);
      expect(await c.waitFor(keyOf("app"))).toBe(false);
    });

    it("R2 a sandbox the record does not name (a renamed reinstall's old one) is left alone", async () => {
      proj("app", { networks: ["bridge"], container: "mcpe-app-new", sandboxName: "mcpe-app-old" });
      await pass(make());
      expect(nets("mcpe-app-old")).toEqual(["bridge"]);
      expect(layer.calls.filter((x) => x.startsWith("setNetwork"))).toEqual([]);
    });

    it("R3 an installing record that is not stale is skipped", async () => {
      proj("app", { status: "installing", networks: ["bridge"], installedAt: new Date(clock.wall).toISOString() });
      await pass(make());
      expect(nets("mcpe-app")).toEqual(["bridge"]);
      expect(layer.calls.filter((x) => x.startsWith("setNetwork"))).toEqual([]);
    });

    it("R10 on -net plus a network that is not managed: the key is rejected with the reason and nothing is changed", async () => {
      proj("app", { networks: [netOf("app"), "somewhere"] });
      const c = make();
      await pass(c);
      expect(layer.calls.filter((x) => x.startsWith("setNetwork") || x.startsWith("createProjectProxy"))).toEqual([]);
      await expect(c.waitFor(keyOf("app"))).rejects.toThrow(/attached to a network mcp-everything does not manage/);
    });

    it("R5 on -net with the proxy fine and the session label equal: nothing is replaced", async () => {
      proj("app", { networks: ["bridge"] });
      await pass(make());
      layer.calls = [];
      await pass(make());
      expect(layer.count("createProjectProxy")).toBe(0);
      expect(layer.count("removeProjectProxy")).toBe(0);
      expect(proxiesOf("mcpe-app")).toHaveLength(1);
    });

    it("R5 the session label compared (startup only): a different session configuration replaces the proxy", async () => {
      proj("app", { networks: ["bridge"] });
      await pass(make());
      const before = proxiesOf("mcpe-app")[0]!;
      layer.resolvers = ["192.0.2.99"]; // another session's resolvers: the record label is the same, the session label is not
      await pass(make());
      const after = proxiesOf("mcpe-app");
      expect(after).toHaveLength(1);
      expect(after[0]!.id).not.toBe(before.id);
      expect(after[0]!.labels[SESSION_LABEL]).not.toBe(before.labels[SESSION_LABEL]);
    });

    it("R5 a stopped proxy, or one whose record label differs, is repaired", async () => {
      proj("app", { networks: ["bridge"] });
      await pass(make());
      proxiesOf("mcpe-app")[0]!.running = false;
      await pass(make());
      expect(proxiesOf("mcpe-app")).toHaveLength(1);
      expect(proxiesOf("mcpe-app")[0]!.running).toBe(true);
      proxiesOf("mcpe-app")[0]!.labels[RECORD_LABEL] = "stale";
      const stale = proxiesOf("mcpe-app")[0]!.id;
      await pass(make());
      expect(proxiesOf("mcpe-app")).toHaveLength(1);
      expect(proxiesOf("mcpe-app")[0]!.id).not.toBe(stale);
    });

    it("R5 a missing proxy is made, and a network made again is attached (T14)", async () => {
      proj("app", { networks: [netOf("app")] });
      await pass(make());
      expect(proxiesOf("mcpe-app")).toHaveLength(1);
      expect(layer.count("attachProjectNetwork")).toBe(1);
    });

    it("R5 a proxy of a newer program version is kept, with a warning of its kind", async () => {
      proj("app", { networks: ["bridge"] });
      await pass(make());
      proxiesOf("mcpe-app")[0]!.labels[VERSION_LABEL] = String(Number(PROXY_PROGRAM_VERSION) + 5);
      layer.calls = [];
      const c = make();
      await pass(c);
      expect(layer.count("createProjectProxy")).toBe(0);
      expect(layer.count("removeProjectProxy")).toBe(0);
      expect(warnings("app").filter((x) => x.startsWith(STARTUP_WARNING_PREFIX["kept-newer-proxy"]))).toHaveLength(1);
      expect(await c.waitFor(keyOf("app"))).toBe(false);
    });
  });

  describe("failures", () => {
    it("a failed contain leaves the sandbox off inside the lock, rejects the key with the reason, and puts a warning on the record", async () => {
      proj("app", { networks: ["bridge"] });
      layer.setNetworkError = new Error("address pools are exhausted");
      const c = make();
      await pass(c);
      expect(nets("mcpe-app")).toEqual([]);
      expect(layer.count("setNetwork:mcpe-app:off")).toBe(1);
      await expect(c.waitFor(keyOf("app"))).rejects.toThrow(/address pools are exhausted/);
      expect(warnings("app").filter((x) => x.startsWith(STARTUP_WARNING_PREFIX["contain-failed"]))).toHaveLength(1);
      expect(stored("app").network).toBe(true); // the record's intent is kept
      expect(lines.filter((l) => l.startsWith(`startup: ${keyOf("app")}: containment failed:`) && l.includes("address pools are exhausted"))).toHaveLength(1);
      expect(lockFiles()).toEqual([]);
      // Refused whatever the state until a contain succeeds.
      await expect(c.ensureContained(facts("app", []), "full")).rejects.toBeInstanceOf(ContainmentStartupError);
      layer.setNetworkError = undefined;
      expect((await c.contain(keyOf("app"))).ok).toBe(true);
      expect(await c.waitFor(keyOf("app"))).toBe(false);
    });

    it("a failed repair rejects the key and does not take the sandbox off: it is already contained or offline", async () => {
      proj("app", { networks: ["bridge"] });
      await pass(make());
      proxiesOf("mcpe-app")[0]!.labels[RECORD_LABEL] = "stale";
      layer.createErrorFor.set("mcpe-app", new Error("busy docker"));
      layer.calls = [];
      const c = make();
      await pass(c);
      expect(nets("mcpe-app")).toEqual([netOf("app")]);
      expect(layer.calls.filter((x) => x.includes(":off"))).toEqual([]);
      await expect(c.waitFor(keyOf("app"))).rejects.toThrow(/busy docker/);
    });

    it("an error on one key rejects that key only: the others are handled", async () => {
      proj("a", { networks: ["bridge"] });
      proj("b", { networks: ["bridge"] });
      layer.createErrorFor.set("mcpe-a", new Error("no containment available"));
      const c = make();
      await pass(c);
      await expect(c.waitFor(keyOf("a"))).rejects.toThrow(/no containment available/);
      expect(await c.waitFor(keyOf("b"))).toBe(false);
      expect(nets("mcpe-b")).toEqual([netOf("b")]);
    });

    it("a sandbox gone since the listing is left alone and its key resolved", async () => {
      proj("app", { networks: ["bridge"] });
      const c = make();
      layer.afterList = () => {
        layer.sandboxes.delete("mcpe-app");
      };
      await pass(c);
      expect(await c.waitFor(keyOf("app"))).toBe(false);
      expect(layer.calls.filter((x) => x.startsWith("setNetwork"))).toEqual([]);
    });

    it("the listing failing rejects the gate only, with the reason; the pass resolves and logs", async () => {
      proj("app", { networks: ["bridge"] });
      layer.listError = new Error("Docker daemon is not reachable");
      const c = make();
      await pass(c);
      await expect(c.waitFor(keyOf("app"))).rejects.toSatisfy((e: unknown) => e instanceof ContainmentStartupError && e.gate && /could not be checked at startup: Docker daemon is not reachable/.test(e.message));
      expect(lines.some((l) => l.includes("could not be listed"))).toBe(true);
      // `off` still passes, and `contain` (set_project_network(true)) clears the key.
      await expect(c.ensureContained(facts("app", ["bridge"]), "full")).rejects.toBeInstanceOf(ContainmentStartupError);
      layer.sandboxes.get(nameOf("app"))!.networks = [];
      expect(await c.ensureContained(facts("app", []), "full")).toBeUndefined();
      expect((await c.contain(keyOf("app"))).ok).toBe(true);
      expect(await c.waitFor(keyOf("app"))).toBe(false);
    });
  });

  describe("the stale-record race: each step re-reads the record fresh", () => {
    it("a turn-on that landed after the listing is not undone by a take-off", async () => {
      proj("app", { network: false, networks: ["bridge"] });
      layer.afterList = () => {
        // set_project_network(true) lands between the listing and the step (the sandbox is still on bridge).
        reg.update(stored("app").slug, (cur) => ({ ...cur!, network: true }));
      };
      await pass(make());
      expect(nets("mcpe-app")).toEqual([netOf("app")]);
      expect(proxiesOf("mcpe-app")).toHaveLength(1);
      expect(warnings("app")).toEqual([]);
    });

    it("a turn-off that landed after the listing is honored: taken off, not contained", async () => {
      proj("app", { network: true, networks: ["bridge"] });
      layer.afterList = () => {
        reg.update(stored("app").slug, (cur) => ({ ...cur!, network: false }));
      };
      await pass(make());
      expect(nets("mcpe-app")).toEqual([]);
      expect(layer.count("createProjectProxy")).toBe(0);
    });

    it("a record removed after the listing makes the step leave the sandbox alone and its key resolved", async () => {
      proj("app", { networks: ["bridge"] });
      const c = make();
      layer.afterList = () => {
        reg.delete(stored("app").slug);
      };
      await pass(c);
      expect(nets("mcpe-app")).toEqual(["bridge"]);
      expect(await c.waitFor(keyOf("app"))).toBe(false);
    });
  });

  describe("registration up front, and a twin", () => {
    it("every selected key is registered before any step runs: a wait is held for a key whose step has not started", async () => {
      proj("a", { networks: ["bridge"] });
      proj("b", { networks: ["bridge"] });
      const hold = new Deferred();
      layer.onInspect = () => hold.promise;
      const c = make();
      const p = pass(c);
      await flush();
      // The steps are running (held inside the first inspect); the gate is released; both keys are still held by their own promises.
      let a = false;
      let b = false;
      void c.waitFor(keyOf("a")).then(() => (a = true));
      void c.waitFor(keyOf("b")).then(() => (b = true));
      await flush();
      expect(a).toBe(false);
      expect(b).toBe(false);
      hold.resolve();
      await p;
      await flush();
      expect(a && b).toBe(true);
    });

    it("a key finished early is not held behind the rest", async () => {
      proj("a", { network: false, networks: [] });
      proj("b", { networks: ["bridge"] });
      const hold = new Deferred();
      layer.onInspect = async (name) => {
        if (name === "mcpe-b") await hold.promise;
      };
      const c = make();
      const p = pass(c);
      await flush();
      await c.waitFor(keyOf("a")); // resolved by its own step, while b is still held: not held behind the rest
      let b = false;
      void c.waitFor(keyOf("b")).then(() => (b = true));
      await flush();
      expect(b).toBe(false);
      hold.resolve();
      await p;
    });

    it("a twin (two listed sandboxes under one key): only the one the record names acts, and the key is registered and settled once", async () => {
      proj("app", { networks: ["bridge"] });
      layer.sandboxes.set("mcpe-app-twin", { running: true, networks: ["bridge"], labels: { [PROJECT_LABEL]: keyOf("app") } });
      const c = make();
      const registered: string[] = [];
      const orig = c.registerStartup.bind(c);
      c.registerStartup = (k, p) => {
        registered.push(k);
        orig(k, p);
      };
      await pass(c);
      expect(registered).toEqual([keyOf("app")]);
      expect(nets("mcpe-app")).toEqual([netOf("app")]);
      expect(nets("mcpe-app-twin")).toEqual(["bridge"]);
      expect(layer.calls.filter((x) => x.startsWith("setNetwork")).every((x) => x.includes("mcpe-app:"))).toBe(true);
      expect(await c.waitFor(keyOf("app"))).toBe(false);
    });

    it("a key with no matching listed sandbox is not registered (resolved at once)", async () => {
      proj("app", { networks: ["bridge"], container: "mcpe-app-new", sandboxName: "mcpe-app-old" });
      const c = make();
      await pass(c);
      expect(await c.waitFor(keyOf("app"))).toBe(false);
    });
  });

  describe("the proxy image", () => {
    it("is ensured once for the whole pass, never while a project lock is held, before a step whose record says on", async () => {
      for (const s of ["a", "b", "c"]) proj(s, { networks: ["bridge"] });
      proj("d", { network: false, networks: ["bridge"] });
      await pass(make());
      expect(layer.count("ensureImage")).toBe(1);
      expect(layer.lockedAtImage).toEqual([0]);
      expect(layer.calls.indexOf("ensureImage")).toBeLessThan(layer.calls.findIndex((x) => x.startsWith("createProjectProxy")));
    });

    it("is not ensured at all when no record says on", async () => {
      proj("d", { network: false, networks: ["bridge"] });
      await pass(make());
      expect(layer.count("ensureImage")).toBe(0);
    });

    it("a pull that failed rejects the keys that need the image only; a take-off is unaffected", async () => {
      proj("a", { networks: ["bridge"] });
      proj("b", { network: false, networks: ["bridge"] });
      layer.imageError = new Error("pull failed");
      const c = make();
      await pass(c);
      await expect(c.waitFor(keyOf("a"))).rejects.toThrow(/pull failed/);
      expect(await c.waitFor(keyOf("b"))).toBe(false);
      expect(nets("mcpe-b")).toEqual([]);
      expect(layer.count("ensureImage")).toBe(1);
    });
  });

  describe("concurrency and the bound", () => {
    it("runs at most 4 sandboxes' steps at once", async () => {
      const slugs = ["a", "b", "c", "d", "e", "f"];
      for (const s of slugs) proj(s, { networks: ["bridge"] });
      let inflight = 0;
      let max = 0;
      const hold = new Deferred();
      layer.onInspect = async () => {
        inflight++;
        max = Math.max(max, inflight);
        await hold.promise;
        inflight--;
      };
      const p = pass(make());
      await flush();
      expect(inflight).toBe(STARTUP_CONCURRENCY);
      hold.resolve();
      await p;
      expect(max).toBe(STARTUP_CONCURRENCY);
      for (const s of slugs) expect(nets(`mcpe-${s}`)).toEqual([`mcpe-${s}-net`]);
    });

    it("at the bound the steps not yet started do not start and every unsettled key is rejected; a step that finishes later clears its own key", async () => {
      const slugs = ["a", "b", "c", "d", "e"];
      for (const s of slugs) proj(s, { networks: ["bridge"] });
      layer.createGate = new Deferred();
      const c = make();
      const p = pass(c);
      await flush();
      expect(layer.count("createProjectProxy")).toBe(STARTUP_CONCURRENCY);
      passClock.advance(STARTUP_PASS_LIMIT_MS);
      await p; // the pass resolves at its bound, not when the held steps do
      expect(lines.filter((l) => l.includes(NOT_FINISHED) && l.includes("containment failed"))).toHaveLength(5);
      for (const s of slugs) await expect(c.waitFor(keyOf(s))).rejects.toThrow(/startup containment did not finish/);
      expect(layer.calls.filter((x) => x.startsWith("inspectSandbox")).length).toBe(STARTUP_CONCURRENCY); // the fifth never started
      layer.createGate.resolve();
      await flush(60);
      const started = slugs.filter((s) => layer.calls.includes(`inspectSandbox:mcpe-${s}`));
      expect(started).toHaveLength(STARTUP_CONCURRENCY);
      for (const s of started) expect(await c.waitFor(keyOf(s))).toBe(false); // cleared by its own successful step
      const never = slugs.find((s) => !started.includes(s))!;
      await expect(c.waitFor(keyOf(never))).rejects.toBeInstanceOf(ContainmentStartupError);
      expect(nets(`mcpe-${never}`)).toEqual(["bridge"]);
    });

    it("the bound firing before the listing is back rejects the gate, and a listing that returns late registers nothing", async () => {
      proj("app", { networks: ["bridge"] });
      const after = new Deferred();
      const c = make();
      const p = pass(c, { after: after.promise });
      await flush();
      passClock.advance(STARTUP_PASS_LIMIT_MS);
      await p;
      await expect(c.waitFor(keyOf("app"))).rejects.toSatisfy((e: unknown) => e instanceof ContainmentStartupError && e.gate && /did not finish/.test(e.message));
      after.resolve();
      await flush(40);
      expect(layer.count("setNetwork")).toBe(0);
      expect(nets("mcpe-app")).toEqual(["bridge"]);
    });

    it("does not leave a timer behind when it finishes in time", async () => {
      proj("app", { networks: ["bridge"] });
      await pass(make());
      expect(passClock.pending).toBe(0);
    });
  });

  it("does not take the lock itself: the locks are the step's, and none is left behind", async () => {
    proj("a", { networks: ["bridge"] });
    proj("b", { network: false, networks: ["bridge"] });
    proj("c", { networks: [netOf("c")] });
    await pass(make());
    expect(lockFiles()).toEqual([]);
  });
});
