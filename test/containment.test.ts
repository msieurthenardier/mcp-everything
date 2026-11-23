import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../src/config.js";
import {
  allowanceFor,
  canonicalJson,
  Containment,
  ContainmentBusyError,
  ContainmentDeadlineError,
  ContainmentError,
  ContainmentLockLostError,
  ContainmentStartupError,
  ContainmentUnreadableError,
  LIMITS,
  phaseOf,
  proxyEnvironment,
  proxyVersionOf,
  RECORD_LABEL,
  recordLabelOf,
  SESSION_LABEL,
  sessionLabelOf,
  VERSION_LABEL,
  type Clock,
  type ContainmentDocker,
} from "../src/network/containment.js";
import { buildHosts, sandboxHosts } from "../src/network/defaults.js";
import { PROXY_PROGRAM_VERSION, type ProxyConfig } from "../src/network/proxy/config.js";
import { Registry } from "../src/registry.js";
import { makeRef } from "../src/sandbox/docker.js";
import type { AfterStartHook, ContainmentHook, SandboxRef } from "../src/sandbox/docker-base.js";
import type { ContainedNetwork, ProjectProxy } from "../src/sandbox/docker-network.js";
import { networkModeOf, proxyAddress, type NetworkMode } from "../src/sandbox/network-spec.js";
import { PROJECT_LABEL, type SandboxInspectFacts } from "../src/sandbox/ownership.js";
import type { ProjectRecord } from "../src/types.js";
import { record } from "./helpers.js";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
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

/** A clock that moves only when a test (or a poll's sleep) moves it. */
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
  /** Attached to its network at the proxy address (leg 13: there is no alias any more; the name is kept from before). */
  alias: boolean;
  config?: ProxyConfig;
}

const idOf = (name: string) => sha(name);

/** The Docker layer as Containment sees it: networks, sandboxes and proxies in memory, every call logged. */
class FakeLayer implements ContainmentDocker {
  calls: string[] = [];
  nets = new Map<string, ContainedNetwork>();
  sandboxes = new Map<string, { running: boolean; networks: string[]; labels: Record<string, string> }>();
  proxies: FakeProxy[] = [];
  resolverFailures = 0;
  createGate?: Deferred;
  createError?: Error;
  afterCreate?: () => void;
  setNetworkError?: Error;
  onEnsureImage?: () => void;
  hook?: ContainmentHook;
  private n = 0;
  private proxyN = 0;

  log(c: string) {
    this.calls.push(c);
  }
  count(prefix: string) {
    return this.calls.filter((c) => c === prefix || c.startsWith(`${prefix}:`)).length;
  }
  async ensureImage() {
    this.log("ensureImage");
    this.onEnsureImage?.();
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
  findError?: Error;
  async findProjectNetwork(sandbox: string) {
    this.log("findProjectNetwork");
    if (this.findError) throw this.findError;
    return this.nets.get(`${sandbox}-net`);
  }
  /** Leg 14: what each attach was told about the sandbox (`running` and its runtime), parallel to the attach calls. */
  attachInfo: Array<{ running: boolean; runtime?: string | null } | undefined> = [];
  async attachProjectNetwork(ref: SandboxRef, net: { id: string; name: string }, running?: { running: boolean; runtime?: string | null }) {
    this.log(`attachProjectNetwork:${ref.name}`);
    this.attachInfo.push(running);
    const s = this.sandboxes.get(ref.name);
    if (s && !s.networks.includes(net.name)) s.networks.push(net.name);
  }
  async restartSandbox(name: string) {
    this.log(`restartSandbox:${name}`);
  }
  async listProjectProxies(sandbox: string): Promise<ProjectProxy[]> {
    this.log("listProjectProxies");
    return this.proxies.filter((p) => p.name.startsWith(`${sandbox}-proxy-`)).map((p) => ({ id: p.id, name: p.name, running: p.running, labels: { ...p.labels } }));
  }
  async projectProxyAttached(id: string, net: { id: string }) {
    this.log("projectProxyAttached");
    const p = this.proxies.find((x) => x.id === id);
    return p?.netId === net.id && p.alias;
  }
  /** Leg 13. Replacement's first step: the proxy leaves the network (and so its address). */
  detachError?: Error;
  /** Leg 14: runs after each proxy is detached (a test steals the lock here: after the detach, before the create). */
  afterDetach?: () => void;
  async detachProjectProxy(id: string) {
    this.log("detachProjectProxy");
    if (this.detachError) throw this.detachError;
    const p = this.proxies.find((x) => x.id === id);
    if (p) p.alias = false;
    this.afterDetach?.();
  }
  /** Leg 13. Rollback: the old proxy comes back at the address; `restoreError` makes it fail, and an address held by another proxy is refused. */
  restoreError?: Error;
  async restoreProjectProxy(id: string) {
    this.log("restoreProjectProxy");
    if (this.restoreError) throw this.restoreError;
    const p = this.proxies.find((x) => x.id === id);
    if (!p) throw new Error("it no longer exists");
    if (this.proxies.some((x) => x !== p && x.alias && x.netId === p.netId)) throw new Error("Address already in use");
    p.alias = true;
    p.running = true;
  }
  /** Leg 13: each write of the sandbox's local-access lines, as `address names...`; `writeError` makes it fail. */
  writes: Array<{ id: string; address: string; names: string[] }> = [];
  writeError?: Error;
  async writeLocalAccess(ref: { id: string; name: string }, address: string, names: string[]) {
    this.log(`writeLocalAccess:${ref.name}`);
    if (this.writeError) throw this.writeError;
    this.writes.push({ id: ref.id, address, names: [...names] });
  }
  async createProjectProxy(sandbox: string, project: string, config: ProxyConfig, labels: Record<string, string>, opts: { name?: string } = {}) {
    this.log(`createProjectProxy:${opts.name}`);
    const net = this.nets.get(`${sandbox}-net`);
    if (this.createGate) await this.createGate.promise;
    if (this.createError) throw this.createError;
    // Two containers cannot hold one address: a proxy still attached to the network refuses the new one.
    if (this.proxies.some((x) => x.alias && x.netId === net?.id)) throw new Error("Address already in use");
    const name = opts.name ?? `${sandbox}-proxy-${String(++this.proxyN).padStart(8, "0")}`;
    const p: FakeProxy = { id: idOf(name), name, running: true, labels: { [PROJECT_LABEL]: project, ...labels }, netId: net?.id, alias: true, config };
    this.proxies.push(p);
    this.afterCreate?.();
    return { id: p.id, name };
  }
  async startProjectProxy(id: string) {
    this.log("startProjectProxy");
    this.proxies.find((p) => p.id === id)!.running = true;
  }
  async projectProxyStatus() {
    this.log("projectProxyStatus");
    return { ready: true, version: PROXY_PROGRAM_VERSION, resolverFailures: this.resolverFailures };
  }
  async removeProjectProxy(id: string) {
    this.log("removeProjectProxy");
    this.proxies = this.proxies.filter((p) => p.id !== id);
  }
  async removeProjectProxyNamed(_sandbox: string, name: string) {
    this.log(`removeProjectProxyNamed:${name}`);
    this.proxies = this.proxies.filter((p) => p.name !== name);
  }
  async readUpstreamResolvers() {
    this.log("readUpstreamResolvers");
    return ["192.0.2.53"];
  }
  invalidateResolvers() {
    this.log("invalidateResolvers");
  }
  async setNetwork(target: string, mode: NetworkMode) {
    this.log(`setNetwork:${mode}`);
    if (this.setNetworkError && mode === "contained") throw this.setNetworkError;
    const s = this.sandboxes.get(target);
    if (!s) return;
    if (mode === "contained") s.networks = [`${target}-net`];
    if (mode === "open") s.networks = ["bridge"];
    if (mode === "off") {
      s.networks = [];
      this.proxies = this.proxies.filter((p) => !p.name.startsWith(`${target}-proxy-`));
      this.nets.delete(`${target}-net`);
    }
  }
  /** Leg 9: the network state of a sandbox as its networks say (a missing one is off). */
  async networkState(target: string | SandboxRef): Promise<NetworkMode> {
    const name = typeof target === "string" ? target : target.name;
    this.log(`networkState:${name}`);
    const s = this.sandboxes.get(name);
    return s ? networkModeOf(name, s.networks) : "off";
  }
  /** Leg 8: the first start of a sandbox that was created stopped. A name in `startError` makes it throw; a missing sandbox is undefined. */
  startError?: Error;
  async startForContainment(name: string): Promise<SandboxRef | undefined> {
    this.log(`startForContainment:${name}`);
    if (this.startError) throw this.startError;
    const s = this.sandboxes.get(name);
    if (!s) return undefined;
    s.running = true;
    return makeRef(idOf(name), name);
  }
  async inspectSandbox(name: string): Promise<SandboxInspectFacts | undefined> {
    this.log("inspectSandbox");
    const s = this.sandboxes.get(name);
    return s ? { id: idOf(name), name, running: s.running, labels: s.labels, networks: [...s.networks], runtime: this.runtime } : undefined;
  }
  /** Leg 14: the runtime every sandbox here reports (undefined: none named, runc). */
  runtime: string | undefined;
  invalidate(f?: { id?: string; sandbox?: string; key?: string }) {
    this.log(`invalidate:${f?.sandbox ?? ""}`);
  }
  afterStart?: AfterStartHook;
  setContainment(hook: ContainmentHook | undefined, afterStart?: AfterStartHook) {
    this.hook = hook;
    this.afterStart = afterStart;
  }
}

let dir: string;
let clock: FakeClock;
let layer: FakeLayer;
let cfg: Config;

const rec = (over: Partial<ProjectRecord> = {}): ProjectRecord => ({ ...record("app"), ecosystems: ["node"], ...over });
const SANDBOX = "mcpe-app";
const PROJECT = "github:owner/app";
const KEY = PROJECT;
const NET = `${SANDBOX}-net`;

function registryWith(...records: ProjectRecord[]): Registry {
  const r = new Registry(dir);
  for (const x of records) r.put(x);
  return r;
}

function make(registry?: Registry, c: Config = cfg): Containment {
  return new Containment(c, registry ?? new Registry(dir), layer, { dataDir: dir, clock });
}

/** A sandbox on `bridge`, or contained on its own network. */
function sandbox(networks: string[], labels: Record<string, string> = { [PROJECT_LABEL]: PROJECT }): SandboxInspectFacts {
  layer.sandboxes.set(SANDBOX, { running: true, networks, labels });
  return { id: idOf(SANDBOX), name: SANDBOX, running: true, labels, networks, runtime: undefined };
}

/** The environment the sandbox's network calls for (leg 13): the proxy's ADDRESS, from the network's subnet. */
const envNow = () => proxyEnvironment(proxyAddress(layer.nets.get(NET)!.subnet));

const lockFiles = () => fs.readdirSync(dir).filter((n) => n.endsWith(".lock") && n.includes(".proxy-"));
const lockPath = (key = KEY) => path.join(dir, `registry.json.proxy-${sha(key.toLowerCase()).slice(0, 16)}.lock`);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-containment-"));
  clock = new FakeClock();
  layer = new FakeLayer();
  cfg = loadConfig({ MCPE_NETWORK: "contained", MCPE_DATA_DIR: dir });
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the configuration", () => {
  const net = { id: idOf("n"), subnet: "172.30.9.0/24" };

  it("phase comes from the record's status alone: installing is build, anything else is run", () => {
    expect(phaseOf({ status: "installing" })).toBe("build");
    expect(phaseOf({ status: "ready" })).toBe("run");
    expect(phaseOf({ status: "failed" })).toBe("run");
  });

  it("allows the build's hosts while installing and the sandbox's hosts afterwards, plus the record's own", async () => {
    const c = make(registryWith(rec()));
    const build = await c.buildConfig(rec({ status: "installing" }), net);
    const hosts = build.config.allow.map((a) => a.host);
    expect(hosts).toContain("registry.npmjs.org");
    expect(hosts).toContain("github.com");
    expect(hosts).toContain("deb.debian.org");
    const run = await c.buildConfig(rec({ status: "ready" }), net);
    const runHosts = run.config.allow.map((a) => a.host);
    expect(runHosts).toContain("registry.npmjs.org");
    expect(runHosts).not.toContain("github.com");
    expect(runHosts).not.toContain("deb.debian.org");
    const own = await c.buildConfig({ ...rec(), hosts: ["api.example.com:8443", "*.cdn.example.org"] } as ProjectRecord, net);
    expect(own.config.allow.find((a) => a.host === "api.example.com")?.ports).toEqual([8443]);
    expect(own.config.allow.find((a) => a.host === "cdn.example.org")?.wildcard).toBe(true);
  });

  it("re-validates every host in agent mode: an invalid or local entry is dropped with a warning", async () => {
    const c = make(registryWith(rec()));
    const r = await c.buildConfig({ ...rec(), hosts: ["ok.example.com", "10.0.0.1", "printer.local", "*.com", 7 as unknown as string, "bad host"] } as ProjectRecord, net);
    const hosts = r.config.allow.map((a) => a.host);
    expect(hosts).toContain("ok.example.com");
    expect(hosts).not.toContain("10.0.0.1");
    expect(hosts).not.toContain("printer.local");
    expect(r.warnings.length).toBe(5);
    expect(r.warnings.join("\n")).toMatch(/10\.0\.0\.1/);
  });

  // Leg 13 removed "refuses a forward target named mcpe-proxy": the proxy has no name on the network any more, so nothing collides with it.
  it("takes the forwards from local access, reads the resolvers and listens on the subnet", async () => {
    const c2 = loadConfig({ MCPE_NETWORK: "contained", MCPE_DATA_DIR: dir, MCPE_LOCAL_ACCESS: "owner/app=db.lan:5432" });
    const c = make(registryWith(rec()), c2);
    const r = await c.buildConfig(rec(), net);
    expect(r.config.forwards).toEqual([{ host: "db.lan", port: 5432 }]);
    expect(r.warnings).toEqual([]);
    expect(r.config.resolvers).toEqual(["192.0.2.53"]);
    expect(r.config.listenCidr).toBe("172.30.9.0/24");
  });

  it("local access applies to the sandbox only: a build proxy has no forwards, a run proxy has them, and the session labels follow", async () => {
    const c2 = loadConfig({ MCPE_NETWORK: "contained", MCPE_DATA_DIR: dir, MCPE_LOCAL_ACCESS: "owner/app=db.lan:5432" });
    const c = make(registryWith(rec()), c2);
    const build = await c.buildConfig(rec({ status: "installing" }), net);
    expect(build.config.forwards).toEqual([]);
    expect(build.labels[SESSION_LABEL]).toBe(sessionLabelOf(c2, [], ["192.0.2.53"]));
    const run = await c.buildConfig(rec({ status: "ready" }), net);
    expect(run.config.forwards).toEqual([{ host: "db.lan", port: 5432 }]);
    expect(run.labels[SESSION_LABEL]).toBe(sessionLabelOf(c2, [{ host: "db.lan", port: 5432 }], ["192.0.2.53"]));
    expect(run.labels[SESSION_LABEL]).not.toBe(build.labels[SESSION_LABEL]);
  });

  it("builds the three labels: record, session, version", async () => {
    const c = make(registryWith(rec()));
    const r = await c.buildConfig(rec(), net);
    expect(Object.keys(r.labels).sort()).toEqual([RECORD_LABEL, SESSION_LABEL, VERSION_LABEL].sort());
    expect(r.labels[VERSION_LABEL]).toBe(PROXY_PROGRAM_VERSION);
    expect(r.labels[RECORD_LABEL]).toMatch(/^[0-9a-f]{64}$/);
    expect(r.labels[SESSION_LABEL]).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the labels", () => {
  const net = { id: idOf("n"), subnet: "172.30.9.0/24" };

  it("canonical JSON sorts keys at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: 3 } })).toBe('{"a":{"c":3,"d":[{"x":2,"y":1}]},"b":1}');
  });

  it("the record label is the same for reordered input and differs when the phase, a host, the version table or the network differ", () => {
    const a = recordLabelOf(allowanceFor({ status: "ready", ecosystems: ["node", "python"] }), net);
    const b = recordLabelOf(allowanceFor({ status: "ready", ecosystems: ["python", "node"] }), net);
    expect(a).toBe(b);
    const withHosts = (hosts: string[]) => allowanceFor({ ...rec(), status: "ready", ecosystems: ["node"], hosts } as ProjectRecord);
    expect(recordLabelOf(withHosts(["a.example.com", "b.example.com"]), net)).toBe(recordLabelOf(withHosts(["b.example.com", "a.example.com", "a.example.com"]), net));
    expect(recordLabelOf(withHosts(["a.example.com"]), net)).not.toBe(recordLabelOf(withHosts([]), net));
    expect(recordLabelOf(allowanceFor({ status: "installing", ecosystems: ["node"] }), net)).not.toBe(recordLabelOf(allowanceFor({ status: "ready", ecosystems: ["node"] }), net));
    // The network is part of the label: a recreated one (new id, new subnet) forces a replacement.
    expect(recordLabelOf(allowanceFor({ status: "ready", ecosystems: ["node"] }), { id: idOf("other"), subnet: net.subnet })).not.toBe(a);
    expect(recordLabelOf(allowanceFor({ status: "ready", ecosystems: ["node"] }), { id: net.id, subnet: "172.30.10.0/24" })).not.toBe(a);
  });

  it("the session label is the same for reordered forwards and resolvers and differs when any input does", () => {
    const f = [{ host: "a.lan", port: 1 }, { host: "b.lan", port: 2 }];
    const x = sessionLabelOf(cfg, f, ["1.1.1.1", "9.9.9.9"]);
    expect(sessionLabelOf(cfg, [...f].reverse(), ["9.9.9.9", "1.1.1.1"])).toBe(x);
    expect(sessionLabelOf(cfg, f.slice(0, 1), ["1.1.1.1", "9.9.9.9"])).not.toBe(x);
    expect(sessionLabelOf(cfg, f, ["1.1.1.1"])).not.toBe(x);
    const other = loadConfig({ MCPE_NETWORK: "contained", MCPE_DATA_DIR: dir, MCPE_EXTRA_HOSTS: "git.example.com=gitlab" });
    expect(sessionLabelOf(other, f, ["1.1.1.1", "9.9.9.9"])).not.toBe(x);
    const image = loadConfig({ MCPE_NETWORK: "contained", MCPE_DATA_DIR: dir });
    image.docker.proxyImage = "other:1";
    expect(sessionLabelOf(image, f, ["1.1.1.1", "9.9.9.9"])).not.toBe(x);
  });

  it("the version label is not in either hash: the same record and session give the same labels whatever the program version", async () => {
    const c = make(registryWith(rec()));
    const r = await c.buildConfig(rec(), net);
    // The version has its own label; replacing an older program's proxy is decided on that label, not on a hash.
    expect(r.labels[RECORD_LABEL]).toBe(recordLabelOf(allowanceFor(rec()), net));
    expect(r.labels[SESSION_LABEL]).toBe(sessionLabelOf(cfg, [], ["192.0.2.53"]));
  });

  it("a proxy's version comes from its label; missing or unparseable counts as 0", () => {
    expect(proxyVersionOf({ labels: { [VERSION_LABEL]: "7" } })).toBe(7);
    expect(proxyVersionOf({ labels: {} })).toBe(0);
    expect(proxyVersionOf({ labels: { [VERSION_LABEL]: "x" } })).toBe(0);
    expect(proxyVersionOf({ labels: { [VERSION_LABEL]: "1.5" } })).toBe(0);
  });

  it("the proxy environment names the proxy by its address in both cases, holds no host name, and turns on Node's env proxy", () => {
    const e = proxyEnvironment("172.22.255.254");
    expect(e.HTTP_PROXY).toBe("http://172.22.255.254:3128");
    expect(e.HTTPS_PROXY).toBe("http://172.22.255.254:3128");
    expect(e.http_proxy).toBe("http://172.22.255.254:3128");
    expect(e.https_proxy).toBe("http://172.22.255.254:3128");
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) expect(e[k]).toMatch(/^http:\/\/\d{1,3}(\.\d{1,3}){3}:3128$/);
    expect(JSON.stringify(e)).not.toMatch(/mcpe-proxy/);
    expect(e.NO_PROXY).toBe("");
    expect(e.no_proxy).toBe("");
    expect(e.NODE_USE_ENV_PROXY).toBe("1");
  });
});

describe("replace", () => {
  it("runs the steps in order: image outside the lock, network, list, configuration, list, create, then removal of the others", async () => {
    registryWith(rec());
    sandbox([NET]);
    layer.onEnsureImage = () => expect(lockFiles()).toEqual([]);
    const old = await make().replace(KEY);
    expect(old.kind).toBe("replaced");
    layer.calls = [];
    layer.proxies[0]!.labels[RECORD_LABEL] = "stale";
    const r = await make().replace(KEY);
    expect(r.kind).toBe("replaced");
    const order = layer.calls.map((c) => c.split(":")[0]);
    // Leg 13: the old proxy leaves the network before the new one is made (two containers cannot hold one address).
    expect(order).toEqual([
      "ensureImage",
      "ensureProjectNetwork",
      "listProjectProxies",
      "readUpstreamResolvers",
      "listProjectProxies",
      "detachProjectProxy",
      "createProjectProxy",
      "projectProxyAttached",
      "removeProjectProxy",
      "invalidate",
    ]);
    expect(layer.proxies.length).toBe(1);
    expect(lockFiles()).toEqual([]);
  });

  it("does nothing when exactly one running proxy has an equal record label and is on the current network", async () => {
    registryWith(rec());
    sandbox([NET]);
    await make().replace(KEY);
    layer.calls = [];
    const r = await make().replace(KEY);
    expect(r.kind).toBe("unchanged");
    expect(layer.count("createProjectProxy")).toBe(0);
    expect(layer.proxies.length).toBe(1);
  });

  it("replaces when the proxy is not on the current network, even with an equal label", async () => {
    registryWith(rec());
    sandbox([NET]);
    await make().replace(KEY);
    layer.proxies[0]!.alias = false;
    const r = await make().replace(KEY);
    expect(r.kind).toBe("replaced");
    expect(layer.proxies.length).toBe(1);
  });

  it("compareSession replaces when the session label differs; without it the same proxy stands", async () => {
    registryWith(rec());
    sandbox([NET]);
    await make().replace(KEY);
    layer.proxies[0]!.labels[SESSION_LABEL] = "other session";
    expect((await make().replace(KEY)).kind).toBe("unchanged");
    expect((await make().replace(KEY, { compareSession: true })).kind).toBe("replaced");
    expect(layer.proxies.length).toBe(1);
  });

  it("force replaces an equal proxy", async () => {
    registryWith(rec());
    sandbox([NET]);
    await make().replace(KEY);
    expect((await make().replace(KEY, { force: true })).kind).toBe("replaced");
    expect(layer.proxies.length).toBe(1);
  });

  it("a failure to create keeps the old proxy and removes the new one by the name chosen beforehand", async () => {
    registryWith(rec());
    sandbox([NET]);
    await make().replace(KEY);
    const before = layer.proxies.map((p) => p.name);
    layer.proxies[0]!.labels[RECORD_LABEL] = "stale";
    layer.createError = new Error("proxy never became ready");
    await expect(make().replace(KEY)).rejects.toThrow(/never became ready/);
    expect(layer.proxies.map((p) => p.name)).toEqual(before);
    const created = layer.calls.filter((c) => c.startsWith("createProjectProxy:")).at(-1)!;
    const name = created.split(":")[1]!;
    expect(layer.calls).toContain(`removeProjectProxyNamed:${name}`);
    expect(name).toMatch(/^mcpe-app-proxy-[0-9a-f]{8}$/);
    expect(lockFiles()).toEqual([]);
  });

  it("refuses when the registry cannot be read, before anything changes", async () => {
    registryWith(rec());
    sandbox([NET]);
    fs.writeFileSync(path.join(dir, "registry.json"), "{ not json");
    await expect(make().replace(KEY)).rejects.toBeInstanceOf(ContainmentUnreadableError);
    expect(layer.count("createProjectProxy")).toBe(0);
    expect(lockFiles()).toEqual([]);
  });

  it("refuses a project that has no record", async () => {
    await expect(make().replace("github:nobody/nothing")).rejects.toBeInstanceOf(ContainmentError);
    expect(layer.calls).toEqual([]);
  });

  it("a failed image pull throws before the lock and nothing changes", async () => {
    registryWith(rec());
    layer.onEnsureImage = () => {
      throw new Error("pull failed");
    };
    await expect(make().replace(KEY)).rejects.toThrow(/pull failed/);
    expect(layer.calls).toEqual(["ensureImage"]);
    expect(lockFiles()).toEqual([]);
  });

  it("reads the record fresh inside the lock: a status change between two replacements changes the phase", async () => {
    const reg = registryWith(rec({ status: "installing" }));
    sandbox([NET]);
    const c = make(reg);
    await c.replace(KEY);
    const build = layer.proxies[0]!.labels[RECORD_LABEL];
    reg.put(rec({ status: "ready" }));
    expect((await c.replace(KEY)).kind).toBe("replaced");
    expect(layer.proxies[0]!.labels[RECORD_LABEL]).not.toBe(build);
    expect(layer.proxies.length).toBe(1);
  });

  it("finds the record by repository id whatever the case", async () => {
    registryWith(rec({ repo: { ...record("app").repo, id: "github:Owner/App" } }));
    sandbox([NET]);
    const r = await make().replace("github:OWNER/app");
    expect(r.kind).toBe("replaced");
    expect(layer.calls.find((c) => c.startsWith("ensureProjectNetwork"))).toBe(`ensureProjectNetwork:${SANDBOX}:github:Owner/App`);
  });
});

describe("the lock", () => {
  it("one instance waits for the other, then sees equal labels and does nothing", async () => {
    registryWith(rec());
    sandbox([NET]);
    layer.createGate = new Deferred();
    const a = make();
    const b = make();
    const pa = a.replace(KEY);
    await flush();
    expect(lockFiles().length).toBe(1);
    const pb = b.replace(KEY);
    await flush(80);
    expect(layer.count("createProjectProxy")).toBe(1);
    layer.createGate.resolve();
    layer.createGate = undefined;
    const [ra, rb] = await Promise.all([pa, pb]);
    expect(ra.kind).toBe("replaced");
    expect(rb.kind).toBe("unchanged");
    expect(layer.count("createProjectProxy")).toBe(1);
    expect(layer.proxies.length).toBe(1);
    expect(lockFiles()).toEqual([]);
  });

  it("takes over a lock file whose mtime is stale", async () => {
    registryWith(rec());
    sandbox([NET]);
    fs.writeFileSync(lockPath(), "dead:token");
    const old = (clock.now() - LIMITS.staleMs - 5_000) / 1000;
    fs.utimesSync(lockPath(), old, old);
    const r = await make().replace(KEY);
    expect(r.kind).toBe("replaced");
    expect(lockFiles()).toEqual([]);
  });

  it("does not take over a fresh lock file; the caller is refused after 60 s of waiting", async () => {
    registryWith(rec());
    sandbox([NET]);
    fs.writeFileSync(lockPath(), "other:token");
    const t = clock.now() / 1000;
    fs.utimesSync(lockPath(), t, t);
    const keep = setInterval(() => fs.utimesSync(lockPath(), clock.now() / 1000, clock.now() / 1000), 1);
    try {
      await expect(make().replace(KEY)).rejects.toBeInstanceOf(ContainmentBusyError);
    } finally {
      clearInterval(keep);
    }
    expect(layer.count("createProjectProxy")).toBe(0);
    expect(fs.readFileSync(lockPath(), "utf8")).toBe("other:token");
  });

  it("the in-process mutex is bounded too: a second call in the same process is refused after 60 s", async () => {
    registryWith(rec());
    sandbox([NET]);
    layer.createGate = new Deferred();
    const c = make();
    const first = c.replace(KEY);
    await flush();
    const second = c.replace(KEY);
    const outcome = second.then(() => "done", (e: unknown) => e);
    await flush();
    clock.advance(LIMITS.lockWaitMs + 1);
    expect(await outcome).toBeInstanceOf(ContainmentBusyError);
    // The first one is unaffected; it ends at its own deadline or completes.
    layer.createGate.resolve();
    layer.createGate = undefined;
    expect((await first).kind).toBe("replaced");
    // A third caller gets the lock: the refused one left no residue in the chain.
    expect((await c.replace(KEY)).kind).toBe("unchanged");
  });

  it("a stolen token makes the first instance remove its own new proxy and throw, with the old proxies kept and nothing removed", async () => {
    registryWith(rec());
    sandbox([NET]);
    await make().replace(KEY);
    const old = layer.proxies.map((p) => p.name);
    layer.proxies[0]!.labels[RECORD_LABEL] = "stale";
    layer.afterCreate = () => fs.writeFileSync(lockPath(), "thief:token");
    await expect(make().replace(KEY)).rejects.toBeInstanceOf(ContainmentLockLostError);
    expect(layer.proxies.map((p) => p.name)).toEqual(old);
    expect(layer.count("removeProjectProxy")).toBe(0);
    expect(layer.count("removeProjectProxyNamed")).toBe(1);
    // The release leaves a lock file that is no longer ours.
    expect(fs.readFileSync(lockPath(), "utf8")).toBe("thief:token");
  });

  it("a proxy of a newer program survives an older instance's replace, force included, and costs no resolver read", async () => {
    registryWith(rec());
    sandbox([NET]);
    layer.proxies.push({ id: idOf("n1"), name: `${SANDBOX}-proxy-aaaaaaaa`, running: true, labels: { [VERSION_LABEL]: "2", [RECORD_LABEL]: "newer's" }, alias: true });
    const logs: string[] = [];
    const c = new Containment(cfg, new Registry(dir), layer, { dataDir: dir, clock, log: (l) => logs.push(l) });
    for (const force of [false, true]) {
      const r = await c.replace(KEY, { force });
      expect(r.kind).toBe("kept-newer");
    }
    expect(layer.count("readUpstreamResolvers")).toBe(0);
    expect(layer.count("createProjectProxy")).toBe(0);
    expect(layer.count("removeProjectProxy")).toBe(0);
    expect(layer.proxies.length).toBe(1);
    // Logged once per process per project.
    expect(logs.filter((l) => /newer program version/.test(l)).length).toBe(1);
  });

  it("a newer proxy is kept at step 7 even when it appeared after the first listing", async () => {
    registryWith(rec());
    sandbox([NET]);
    await make().replace(KEY);
    layer.proxies[0]!.labels[RECORD_LABEL] = "stale";
    let n = 0;
    const real = layer.listProjectProxies.bind(layer);
    layer.listProjectProxies = async (s: string) => {
      const out = await real(s);
      // The second listing is the one that sees a newer proxy appear.
      if (++n === 2) layer.proxies.push({ id: idOf("n2"), name: `${SANDBOX}-proxy-bbbbbbbb`, running: true, labels: { [VERSION_LABEL]: "9" }, alias: true });
      return out;
    };
    const r = await make().replace(KEY);
    expect(r.kind).toBe("replaced");
    expect(layer.proxies.map((p) => p.labels[VERSION_LABEL])).toContain("9");
    expect(layer.proxies.length).toBe(2);
  });

  it("a stopped newer proxy is started and kept", async () => {
    registryWith(rec());
    sandbox([NET]);
    layer.proxies.push({ id: idOf("n3"), name: `${SANDBOX}-proxy-cccccccc`, running: false, labels: { [VERSION_LABEL]: "3" }, alias: true });
    const r = await make().replace(KEY);
    expect(r.kind).toBe("kept-newer");
    expect(layer.proxies[0]!.running).toBe(true);
    expect(layer.count("startProjectProxy")).toBe(1);
  });

  it("remembers 'kept newer' for 60 s: a replace within that time takes no lock and lists nothing", async () => {
    registryWith(rec());
    sandbox([NET]);
    layer.proxies.push({ id: idOf("n4"), name: `${SANDBOX}-proxy-dddddddd`, running: true, labels: { [VERSION_LABEL]: "2" }, alias: true });
    const c = make();
    await c.replace(KEY);
    layer.calls = [];
    expect((await c.replace(KEY)).kind).toBe("kept-newer");
    expect(layer.calls).toEqual([]);
    clock.advance(LIMITS.newerMemoryMs + 1);
    expect((await c.replace(KEY)).kind).toBe("kept-newer");
    expect(layer.count("listProjectProxies")).toBeGreaterThan(0);
  });

  it("an older proxy (and one with no version label) is replaced", async () => {
    registryWith(rec());
    sandbox([NET]);
    layer.proxies.push({ id: idOf("o1"), name: `${SANDBOX}-proxy-eeeeeeee`, running: true, labels: {}, alias: true });
    expect((await make().replace(KEY)).kind).toBe("replaced");
    expect(layer.proxies.length).toBe(1);
    expect(layer.proxies[0]!.labels[VERSION_LABEL]).toBe(PROXY_PROGRAM_VERSION);
  });

  it("the 90 s deadline starts once the lock is held: the call is refused, the lock released, and the straggler's proxy removed by name", async () => {
    registryWith(rec());
    sandbox([NET]);
    await make().replace(KEY);
    const old = layer.proxies.map((p) => p.name);
    layer.proxies[0]!.labels[RECORD_LABEL] = "stale";
    layer.createGate = new Deferred();
    const gate = layer.createGate;
    const p = make().replace(KEY);
    const outcome = p.then(() => "done", (e: unknown) => e);
    await flush();
    clock.advance(LIMITS.deadlineMs + 1);
    expect(await outcome).toBeInstanceOf(ContainmentDeadlineError);
    // The caller is refused, but the lock is released only once the straggler has settled.
    expect(lockFiles().length).toBe(1);
    layer.createGate = undefined;
    gate.resolve();
    await flush();
    expect(lockFiles()).toEqual([]);
    expect(layer.proxies.map((x) => x.name)).toEqual(old);
    expect(layer.count("removeProjectProxy")).toBe(0);
    expect(layer.count("removeProjectProxyNamed")).toBe(1);
    expect(clock.pending).toBe(0);
  });

  it("after the first caller got the deadline error, a second waiter still cannot take the lock until the first function settles", async () => {
    registryWith(rec());
    sandbox([NET]);
    await make().replace(KEY);
    layer.proxies[0]!.labels[RECORD_LABEL] = "stale";
    layer.createGate = new Deferred();
    const gate = layer.createGate;
    const a = make();
    const before = layer.count("createProjectProxy");
    const first = a.replace(KEY).then(() => "done", (e: unknown) => e);
    await flush();
    clock.advance(LIMITS.deadlineMs + 1);
    expect(await first).toBeInstanceOf(ContainmentDeadlineError);
    const second = a.replace(KEY).then((r) => r.kind, (e: unknown) => e);
    await flush(80);
    // The straggler is still inside createProjectProxy: nobody else has run.
    expect(layer.count("createProjectProxy")).toBe(before + 1);
    expect(lockFiles().length).toBe(1);
    layer.createGate = undefined;
    gate.resolve();
    expect(typeof (await second)).toBe("string");
    expect(lockFiles()).toEqual([]);
  });

  it("two waiters judging a lock stale: the second takeover never deletes the first's fresh lock", async () => {
    registryWith(rec());
    sandbox([NET]);
    fs.writeFileSync(lockPath(), "dead:token");
    const old = (clock.now() - LIMITS.staleMs - 5_000) / 1000;
    fs.utimesSync(lockPath(), old, old);
    const c = (make() as unknown as { locks: { removeIfStale(file: string): void } }).locks;
    c.removeIfStale(lockPath()); // the first waiter removes the stale lock...
    expect(fs.existsSync(lockPath())).toBe(false);
    fs.writeFileSync(lockPath(), "first:fresh"); // ...and takes a fresh one
    const t = clock.now() / 1000;
    fs.utimesSync(lockPath(), t, t);
    c.removeIfStale(lockPath()); // the second, still believing it stale, must not remove it
    expect(fs.readFileSync(lockPath(), "utf8")).toBe("first:fresh");
    expect(fs.readdirSync(dir).filter((n) => n.includes(".stale-"))).toEqual([]);
  });

  it("two real contenders on a stale lock: both get through, one at a time", async () => {
    registryWith(rec());
    sandbox([NET]);
    fs.writeFileSync(lockPath(), "dead:token");
    const old = (clock.now() - LIMITS.staleMs - 5_000) / 1000;
    fs.utimesSync(lockPath(), old, old);
    const [ra, rb] = await Promise.all([make().replace(KEY), make().replace(KEY)]);
    expect([ra.kind, rb.kind].sort()).toEqual(["replaced", "unchanged"]);
    expect(layer.count("createProjectProxy")).toBe(1);
    expect(lockFiles()).toEqual([]);
  });
});

describe("contain", () => {
  it("makes the network, then the proxy, then moves the sandbox, then clears the cache, in that order", async () => {
    registryWith(rec());
    sandbox(["bridge"]);
    const r = await make().contain(KEY);
    expect(r.ok).toBe(true);
    const order = layer.calls.map((c) => c.split(":")[0]);
    expect(order.indexOf("ensureProjectNetwork")).toBeLessThan(order.indexOf("createProjectProxy"));
    expect(order.indexOf("createProjectProxy")).toBeLessThan(order.indexOf("setNetwork"));
    expect(layer.calls).toContain("setNetwork:contained");
    expect(order.lastIndexOf("invalidate")).toBeGreaterThan(order.indexOf("setNetwork"));
    expect(layer.sandboxes.get(SANDBOX)!.networks).toEqual([NET]);
    expect(layer.proxies.length).toBe(1);
    expect(lockFiles()).toEqual([]);
  });

  it.each([
    ["the proxy cannot be created", (l: FakeLayer) => (l.createError = new Error("no proxy"))],
    ["the sandbox cannot be moved", (l: FakeLayer) => (l.setNetworkError = new Error("move failed"))],
  ])("when %s, the sandbox ends on no network, never on bridge, and the error is returned", async (_n, break_) => {
    registryWith(rec());
    sandbox(["bridge"]);
    break_(layer);
    const r = await make().contain(KEY);
    expect(r.ok).toBe(false);
    expect((r as { error: Error }).error.message).toMatch(/no proxy|move failed/);
    expect(layer.sandboxes.get(SANDBOX)!.networks).toEqual([]);
    expect(layer.calls).not.toContain("setNetwork:open");
    expect(layer.calls.at(-1)).toBe("setNetwork:off");
    expect(lockFiles()).toEqual([]);
  });

  it("after a failed contain the sandbox is set to off exactly once", async () => {
    registryWith(rec());
    sandbox(["bridge"]);
    layer.createError = new Error("no proxy");
    const r = await make().contain(KEY);
    expect(r.ok).toBe(false);
    expect(layer.calls.filter((c) => c === "setNetwork:off").length).toBe(1);
  });

  it("returns an error, and touches nothing, for a project with no record", async () => {
    const r = await make().contain("github:nobody/nothing");
    expect(r.ok).toBe(false);
    expect(layer.calls).toEqual([]);
  });

  it("a successful contain clears a failed startup", async () => {
    registryWith(rec());
    sandbox(["bridge"]);
    const c = make();
    const failed = Promise.reject(new Error("pass failed"));
    c.registerStartup(KEY, failed);
    await expect(c.waitFor(KEY)).rejects.toBeInstanceOf(ContainmentStartupError);
    expect((await c.contain(KEY)).ok).toBe(true);
    expect(await c.waitFor(KEY)).toBe(false);
  });

  describe("with { start: true } (leg 8: the first start of a sandbox created stopped)", () => {
    it("moves it to its network, then starts it through the unhooked start, and returns the started reference", async () => {
      registryWith(rec({ status: "installing" }));
      layer.sandboxes.set(SANDBOX, { running: false, networks: ["bridge"], labels: { [PROJECT_LABEL]: PROJECT } });
      const r = await make().contain(KEY, { start: true });
      expect(r.ok).toBe(true);
      expect((r as { sandbox?: SandboxRef }).sandbox).toEqual(makeRef(idOf(SANDBOX), SANDBOX));
      const order = layer.calls.map((c) => c.split(":")[0]);
      expect(order.indexOf("createProjectProxy")).toBeLessThan(order.indexOf("setNetwork"));
      expect(order.indexOf("setNetwork")).toBeLessThan(order.indexOf("startForContainment"));
      expect(layer.calls).toContain(`startForContainment:${SANDBOX}`);
      expect(layer.sandboxes.get(SANDBOX)).toMatchObject({ running: true, networks: [NET] });
      expect(layer.calls).not.toContain("setNetwork:open");
      expect(lockFiles()).toEqual([]);
    });

    it("does not start without the option (the default is today's contain)", async () => {
      registryWith(rec());
      sandbox(["bridge"]);
      const r = await make().contain(KEY);
      expect(r.ok).toBe(true);
      expect((r as { sandbox?: SandboxRef }).sandbox).toBeUndefined();
      expect(layer.count("startForContainment")).toBe(0);
    });

    it.each([
      ["the start fails", (l: FakeLayer) => (l.startError = new Error("start refused")), /start refused/],
      ["the sandbox is gone", (l: FakeLayer) => l.sandboxes.delete(SANDBOX), /is gone/],
    ])("when %s, the sandbox is put on no network and the error is returned", async (_n, break_, message) => {
      registryWith(rec());
      sandbox(["bridge"]);
      break_(layer);
      const r = await make().contain(KEY, { start: true });
      expect(r.ok).toBe(false);
      expect((r as { error: Error }).error.message).toMatch(message);
      expect(layer.calls.at(-1)).toBe("setNetwork:off");
      expect(layer.calls).not.toContain("setNetwork:open");
      expect(layer.sandboxes.get(SANDBOX)?.networks ?? []).toEqual([]);
    });

    it("does not start when the containment itself failed", async () => {
      registryWith(rec());
      sandbox(["bridge"]);
      layer.createError = new Error("no proxy");
      await make().contain(KEY, { start: true });
      expect(layer.count("startForContainment")).toBe(0);
    });
  });
});

describe("the default-table seam (leg 8)", () => {
  const net = { id: idOf("n"), subnet: "172.30.9.0/24" };
  const noNpm = { build: (e: readonly string[]) => buildHosts(e as never).filter((h) => h !== "registry.npmjs.org"), run: (e: readonly string[]) => sandboxHosts(e as never) };

  it("allowanceFor reads the table it is given, and the real one by default", () => {
    const rec1 = { status: "installing" as const, ecosystems: ["node" as const] };
    expect(allowanceFor(rec1).texts).toContain("registry.npmjs.org");
    expect(allowanceFor(rec1, noNpm).texts).not.toContain("registry.npmjs.org");
    expect(allowanceFor(rec1, noNpm).texts).toContain("github.com");
  });

  it("the configuration a Containment builds uses its seam", async () => {
    const c = new Containment(cfg, registryWith(rec()), layer, { dataDir: dir, clock, defaults: noNpm });
    const built = await c.buildConfig(rec({ status: "installing" }), net);
    expect(built.config.allow.map((a) => a.host)).not.toContain("registry.npmjs.org");
    expect(built.config.allow.map((a) => a.host)).toContain("github.com");
  });

  it("a proxy built under the seam is judged fine by the hook's check, and is not rebuilt with the real table", async () => {
    registryWith(rec({ status: "installing" }));
    sandbox([NET]);
    const c = new Containment(cfg, new Registry(dir), layer, { dataDir: dir, clock, defaults: noNpm });
    await c.replace(KEY);
    expect(layer.proxies[0]!.config!.allow.map((a) => a.host)).not.toContain("registry.npmjs.org");
    layer.calls = [];
    const env = await c.ensureContained({ id: idOf(SANDBOX), name: SANDBOX, running: true, labels: { [PROJECT_LABEL]: PROJECT }, networks: [NET], runtime: undefined }, "full");
    expect(env).toEqual(envNow());
    expect(layer.count("createProjectProxy")).toBe(0);
    expect(layer.count("removeProjectProxy")).toBe(0);
    // Without the seam the same proxy would be stale: a Containment that reads the real table replaces it.
    const real = new Containment(cfg, new Registry(dir), layer, { dataDir: dir, clock });
    await real.ensureContained({ id: idOf(SANDBOX), name: SANDBOX, running: true, labels: { [PROJECT_LABEL]: PROJECT }, networks: [NET], runtime: undefined }, "full");
    expect(layer.count("createProjectProxy")).toBe(1);
  });
});

describe("the hook", () => {
  const facts = (over: Partial<SandboxInspectFacts> = {}): SandboxInspectFacts => ({
    id: idOf(SANDBOX),
    name: SANDBOX,
    running: true,
    labels: { [PROJECT_LABEL]: PROJECT },
    networks: [NET],
    runtime: undefined,
    ...over,
  });

  /** A contained sandbox with its proxy made through `replace`, and the calls cleared. */
  async function contained(registry = registryWith(rec())) {
    sandbox([NET]);
    const c = make(registry);
    await c.replace(KEY);
    layer.calls = [];
    return c;
  }

  it("installs itself as the Docker layer's hook", () => {
    const c = make();
    c.install();
    expect(layer.hook).toBeTypeOf("function");
    expect(c).toBeInstanceOf(Containment);
  });

  describe("no-ops", () => {
    it.each([
      ["no network", []],
      ["bridge", ["bridge"]],
      ["bridge and its own network", ["bridge", NET]],
      ["a foreign network", ["other-net"]],
    ])("%s: no environment, and nothing is asked or changed", async (_n, networks) => {
      registryWith(rec());
      const c = make();
      expect(await c.ensureContained(facts({ networks }), "full")).toBeUndefined();
      expect(layer.calls).toEqual([]);
      expect(lockFiles()).toEqual([]);
    });

    it("a sandbox with no project label gets no environment and nothing is done", async () => {
      registryWith(rec());
      expect(await make().ensureContained(facts({ labels: {} }), "full")).toBeUndefined();
      expect(await make().ensureContained(facts({ labels: null }), "full")).toBeUndefined();
      expect(layer.calls).toEqual([]);
    });

    it("a contained sandbox with no record gets no environment: the exec fails closed", async () => {
      expect(await make().ensureContained(facts(), "full")).toBeUndefined();
      expect(layer.calls).toEqual([]);
    });

    it("a sandbox that is not the record's (a renamed reinstall's old one) gets the environment only, never the record's configuration", async () => {
      registryWith(rec());
      layer.nets.set("mcpe-app-old-net", { id: idOf("old-net"), name: "mcpe-app-old-net", subnet: "172.30.7.0/24" });
      const env = await make().ensureContained(facts({ name: "mcpe-app-old", networks: ["mcpe-app-old-net"] }), "full");
      expect(env).toEqual(proxyEnvironment("172.30.7.254"));
      // Only the network is read (for its subnet): no listing, no registry write, no lock, nothing changed.
      expect(layer.calls).toEqual(["findProjectNetwork"]);
    });
  });

  // Leg 13: the environment names the proxy by its address, so even a read-only answer needs the network's subnet. It is read
  // once per network (its id) and then kept: a network's subnet never changes.
  describe("observe mode", () => {
    /** The project network in the layer, with its id in the facts as Docker's inspect gives it. */
    const withNet = () => {
      layer.nets.set(NET, { id: idOf("the-net"), name: NET, subnet: "172.30.9.0/24" });
      return { networkIds: { [NET]: idOf("the-net") } };
    };

    it("returns the environment for a contained sandbox with one read of its network, no listing, no registry read and no change", async () => {
      withNet();
      const c = make();
      expect(await c.ensureContained(facts(), "observe")).toEqual(proxyEnvironment("172.30.9.254"));
      expect(await c.ensureContained(facts({ networks: ["bridge"] }), "observe")).toBeUndefined();
      expect(await c.ensureContained(facts({ networks: [] }), "observe")).toBeUndefined();
      expect(layer.calls).toEqual(["findProjectNetwork"]);
      expect(lockFiles()).toEqual([]);
    });

    it("reads a network once: later answers for the same network id make no Docker call", async () => {
      const ids = withNet();
      const c = make();
      for (let i = 0; i < 4; i++) expect(await c.ensureContained(facts(ids), "observe")).toEqual(proxyEnvironment("172.30.9.254"));
      expect(layer.count("findProjectNetwork")).toBe(1);
      // A different network id is read once more.
      layer.nets.set(NET, { id: idOf("other-net"), name: NET, subnet: "172.30.10.0/24" });
      expect(await c.ensureContained(facts({ networkIds: { [NET]: idOf("other-net") } }), "observe")).toEqual(proxyEnvironment("172.30.10.254"));
      expect(layer.count("findProjectNetwork")).toBe(2);
    });

    it("gives no environment, and does not fail, when the network cannot be read", async () => {
      const c = make();
      expect(await c.ensureContained(facts(), "observe")).toBeUndefined(); // no network in the layer
      layer.findError = new Error("daemon gone");
      expect(await c.ensureContained(facts(), "observe")).toBeUndefined();
    });

    it("does not wait for a startup step and ignores a missing or unreadable registry", async () => {
      withNet();
      fs.writeFileSync(path.join(dir, "registry.json"), "{ not json");
      const c = make();
      c.registerStartup(KEY, new Promise(() => {}));
      expect(await c.ensureContained(facts(), "observe")).toEqual(envNow());
    });
  });

  describe("under open", () => {
    it("never waits, never repairs, and returns the environment only when the facts say contained", async () => {
      registryWith(rec());
      layer.nets.set(NET, { id: idOf("the-net"), name: NET, subnet: "172.30.9.0/24" });
      const c = make(undefined, loadConfig({ MCPE_NETWORK: "open", MCPE_DATA_DIR: dir }));
      c.registerStartup(KEY, new Promise(() => {}));
      expect(await c.ensureContained(facts(), "full")).toEqual(envNow());
      expect(await c.ensureContained(facts({ networks: ["bridge"] }), "full")).toBeUndefined();
      expect(layer.calls).toEqual(["findProjectNetwork"]);
    });
  });

  describe("a contained sandbox, full mode", () => {
    it("with everything in place returns the environment, creates nothing and takes no lock", async () => {
      const c = await contained();
      expect(await c.ensureContained(facts(), "full")).toEqual(envNow());
      expect(layer.count("createProjectProxy")).toBe(0);
      expect(layer.calls.map((x) => x.split(":")[0])).toEqual(["findProjectNetwork", "listProjectProxies", "projectProxyAttached", "projectProxyStatus"]);
      expect(lockFiles()).toEqual([]);
    });

    it("makes a proxy when there is none, and returns the environment", async () => {
      const c = await contained();
      layer.proxies = [];
      expect(await c.ensureContained(facts(), "full")).toEqual(envNow());
      expect(layer.proxies.length).toBe(1);
      expect(lockFiles()).toEqual([]);
    });

    it("replaces several proxies with one", async () => {
      const c = await contained();
      layer.proxies.push({ ...layer.proxies[0]!, id: idOf("dup"), name: `${SANDBOX}-proxy-ffffffff` });
      await c.ensureContained(facts(), "full");
      expect(layer.proxies.length).toBe(1);
    });

    it("replaces a proxy whose record label differs (the record changed)", async () => {
      const reg = registryWith(rec());
      const c = await contained(reg);
      reg.put({ ...rec(), hosts: ["new.example.com"] } as ProjectRecord);
      await c.ensureContained(facts(), "full");
      expect(layer.proxies.length).toBe(1);
      expect(layer.proxies[0]!.config!.allow.map((a) => a.host)).toContain("new.example.com");
    });

    it("never compares the session label on use: a proxy with another session label stands", async () => {
      const c = await contained();
      layer.proxies[0]!.labels[SESSION_LABEL] = "another session's";
      await c.ensureContained(facts(), "full");
      expect(layer.count("createProjectProxy")).toBe(0);
      expect(layer.count("readUpstreamResolvers")).toBe(0);
    });

    it("starts a stopped proxy and does not replace it", async () => {
      const c = await contained();
      layer.proxies[0]!.running = false;
      await c.ensureContained(facts(), "full");
      expect(layer.count("startProjectProxy")).toBe(1);
      expect(layer.count("createProjectProxy")).toBe(0);
      expect(layer.proxies[0]!.running).toBe(true);
    });

    it("leaves a newer proxy alone, whatever its labels", async () => {
      const c = await contained();
      layer.proxies[0]!.labels[VERSION_LABEL] = "5";
      layer.proxies[0]!.labels[RECORD_LABEL] = "whatever";
      expect(await c.ensureContained(facts(), "full")).toEqual(envNow());
      expect(layer.count("createProjectProxy")).toBe(0);
      expect(layer.count("removeProjectProxy")).toBe(0);
    });

    it("a running sandbox under runsc whose network is made again is attached with its facts (the Docker layer stops and starts it)", async () => {
      const c = await contained();
      layer.nets.clear();
      await c.ensureContained({ ...facts(), running: true, runtime: "runsc" }, "full");
      expect(layer.attachInfo.at(-1)).toEqual({ running: true, runtime: "runsc" });
    });

    it("recreates a missing network and attaches the sandbox to it, then a proxy for the new network", async () => {
      const c = await contained();
      layer.nets.clear();
      await c.ensureContained(facts({ running: false }), "full");
      expect(layer.calls).toContain(`attachProjectNetwork:${SANDBOX}`);
      // Leg 14: the repair says whether the sandbox is running and under which runtime, so the Docker layer can stop it first under gVisor.
      expect(layer.attachInfo.at(-1)).toEqual({ running: false, runtime: undefined });
      expect(layer.nets.has(NET)).toBe(true);
      // The old proxy sat on the old network: a recreated network changes the label, so it was replaced.
      expect(layer.proxies.length).toBe(1);
      expect(layer.proxies[0]!.netId).toBe(layer.nets.get(NET)!.id);
      expect(lockFiles()).toEqual([]);
    });

    it("with resolver failures at 3 or more, forgets the resolvers and replaces the proxy by force", async () => {
      const c = await contained();
      const before = layer.proxies[0]!.id;
      layer.resolverFailures = 3;
      await c.ensureContained(facts(), "full");
      expect(layer.calls).toContain("invalidateResolvers");
      expect(layer.proxies.length).toBe(1);
      expect(layer.proxies[0]!.id).not.toBe(before);
    });

    it("reads resolver failures at most once a minute per project", async () => {
      const c = await contained();
      await c.ensureContained(facts(), "full");
      await c.ensureContained(facts(), "full");
      expect(layer.count("projectProxyStatus")).toBe(1);
      clock.advance(LIMITS.statusEveryMs + 1);
      await c.ensureContained(facts(), "full");
      expect(layer.count("projectProxyStatus")).toBe(2);
      // A genuine outage therefore causes one replacement a minute per project at most.
      layer.resolverFailures = 9;
      clock.advance(LIMITS.statusEveryMs + 1);
      await c.ensureContained(facts(), "full");
      await c.ensureContained(facts(), "full");
      await c.ensureContained(facts(), "full");
      expect(layer.count("createProjectProxy")).toBe(1);
    });

    it("finds the record whatever the case of the project label, and names Docker's objects by the label as the sandbox carries it", async () => {
      const c = await contained(registryWith(rec({ repo: { ...record("app").repo, id: "github:Owner/App" } })));
      layer.proxies = [];
      await c.ensureContained(facts({ labels: { [PROJECT_LABEL]: "github:owner/app" } }), "full");
      expect(layer.proxies.length).toBe(1);
      expect(layer.calls.find((x) => x.startsWith("ensureProjectNetwork"))).toBe(`ensureProjectNetwork:${SANDBOX}:github:owner/app`);
    });

    it("refuses a contained sandbox when the registry cannot be read", async () => {
      const c = await contained();
      fs.writeFileSync(path.join(dir, "registry.json"), "{ not json");
      await expect(c.ensureContained(facts(), "full")).rejects.toBeInstanceOf(ContainmentUnreadableError);
      expect(layer.calls).toEqual([]);
    });

    it("two repairs at once in one process end with exactly one proxy", async () => {
      const c = await contained();
      layer.proxies = [];
      const [a, b] = await Promise.all([c.ensureContained(facts(), "full"), c.ensureContained(facts(), "full")]);
      expect(a).toEqual(envNow());
      expect(b).toEqual(envNow());
      expect(layer.proxies.length).toBe(1);
      expect(layer.count("createProjectProxy")).toBe(1);
      expect(lockFiles()).toEqual([]);
    });

    it("two repairs at once by two instances (two processes) end with exactly one proxy", async () => {
      registryWith(rec());
      sandbox([NET]);
      layer.createGate = new Deferred();
      const gate = layer.createGate;
      const a = make();
      const b = make();
      const pa = a.ensureContained(facts(), "full");
      const pb = b.ensureContained(facts(), "full");
      await flush(80);
      layer.createGate = undefined;
      gate.resolve();
      await Promise.all([pa, pb]);
      expect(layer.proxies.length).toBe(1);
      expect(layer.count("createProjectProxy")).toBe(1);
      expect(lockFiles()).toEqual([]);
    });

    it("a refused wait for the lock refuses the exec, which fails closed", async () => {
      const c = await contained();
      layer.proxies = [];
      fs.writeFileSync(lockPath(), "other:token");
      const keep = setInterval(() => fs.utimesSync(lockPath(), clock.now() / 1000, clock.now() / 1000), 1);
      try {
        await expect(c.ensureContained(facts(), "full")).rejects.toBeInstanceOf(ContainmentBusyError);
      } finally {
        clearInterval(keep);
      }
    });
  });

  describe("the startup step", () => {
    it("waitFor resolves at once when nothing is registered", async () => {
      expect(await make().waitFor(KEY)).toBe(false);
    });

    it("a legacy sandbox on bridge waits for the step, then branches on the fresh facts: contained, so it is repaired", async () => {
      registryWith(rec());
      const c = make();
      sandbox(["bridge"]);
      const gate = new Deferred();
      c.registerStartup(KEY, gate.promise.then(async () => {
        await c.contain(KEY);
      }));
      let settled = false;
      const p = c.ensureContained(facts({ networks: ["bridge"] }), "full").then((e) => {
        settled = true;
        return e;
      });
      await flush();
      expect(settled).toBe(false);
      expect(layer.calls).toEqual([]);
      gate.resolve();
      expect(await p).toEqual(envNow());
      expect(layer.sandboxes.get(SANDBOX)!.networks).toEqual([NET]);
      expect(layer.count("inspectSandbox")).toBe(1);
    });

    it("a legacy sandbox the step left open gets no environment and nothing is repaired", async () => {
      registryWith(rec());
      const c = make();
      sandbox(["bridge"]);
      const gate = new Deferred();
      c.registerStartup(KEY, gate.promise);
      const p = c.ensureContained(facts({ networks: ["bridge"] }), "full");
      gate.resolve();
      expect(await p).toBeUndefined();
      expect(layer.count("createProjectProxy")).toBe(0);
    });

    it("a rejected step refuses that sandbox's execs, with its reason, until a contain or replace succeeds", async () => {
      registryWith(rec());
      const c = make();
      sandbox([NET]);
      c.registerStartup(KEY, Promise.reject(new Error("the pass could not contain it")));
      await expect(c.ensureContained(facts(), "full")).rejects.toThrow(/could not contain it/);
      await expect(c.ensureContained(facts(), "full")).rejects.toBeInstanceOf(ContainmentStartupError);
      // Observe mode (cleanup) is never refused.
      layer.nets.set(NET, { id: idOf("the-net"), name: NET, subnet: "172.30.9.0/24" });
      expect(await c.ensureContained(facts(), "observe")).toEqual(envNow());
      expect((await c.replace(KEY)).kind).toBe("replaced");
      expect(await c.ensureContained(facts(), "full")).toEqual(envNow());
    });

    it("registering a promise attaches a no-op catch at once: a rejection nobody waits for is not unhandled", async () => {
      const c = make();
      const unhandled: unknown[] = [];
      const on = (e: unknown) => unhandled.push(e);
      process.on("unhandledRejection", on);
      try {
        c.registerStartup(KEY, Promise.reject(new Error("nobody waits")));
        await flush(10);
      } finally {
        process.off("unhandledRejection", on);
      }
      expect(unhandled).toEqual([]);
    });

    it("keys are case-insensitive", async () => {
      const c = make();
      c.registerStartup("github:Owner/App", Promise.reject(new Error("x")));
      await expect(c.waitFor("GITHUB:owner/app")).rejects.toBeInstanceOf(ContainmentStartupError);
    });
  });
});

describe("replacement by address (leg 13)", () => {
  const stale = () => {
    layer.proxies[0]!.labels[RECORD_LABEL] = "stale";
  };
  const sandboxFacts = (): SandboxInspectFacts => ({ id: idOf(SANDBOX), name: SANDBOX, running: true, labels: { [PROJECT_LABEL]: PROJECT }, networks: [NET], runtime: undefined });
  const names = (): string[] => layer.calls.filter((c) => /^(detach|restore|createProject|removeProject)/.test(c)).map((c) => c.split(":")[0]!);

  it("takes the old proxy off the network, creates the new one at the address, checks it, and only then removes the old one", async () => {
    registryWith(rec());
    sandbox([NET]);
    await make().replace(KEY);
    stale();
    layer.calls = [];
    const r = await make().replace(KEY);
    expect(r.kind).toBe("replaced");
    // The fake refuses a second proxy on the network while one is attached (one address): so this order is the only one that works.
    expect(names()).toEqual(["detachProjectProxy", "createProjectProxy", "removeProjectProxy"]);
    expect(layer.calls.indexOf("projectProxyAttached")).toBeGreaterThan(layer.calls.findIndex((c) => c.startsWith("createProjectProxy")));
    expect(layer.proxies.length).toBe(1);
    expect(layer.proxies[0]!.alias).toBe(true);
  });

  it("takes EVERY current proxy off the network, then removes them all", async () => {
    registryWith(rec());
    sandbox([NET]);
    await make().replace(KEY);
    const net = layer.nets.get(NET)!;
    layer.proxies.push({ id: idOf("extra"), name: `${SANDBOX}-proxy-ffffffff`, running: true, labels: { [PROJECT_LABEL]: PROJECT }, netId: net.id, alias: true });
    layer.calls = [];
    expect((await make().replace(KEY)).kind).toBe("replaced");
    expect(names()).toEqual(["detachProjectProxy", "detachProjectProxy", "createProjectProxy", "removeProjectProxy", "removeProjectProxy"]);
    expect(layer.proxies.length).toBe(1);
  });

  it("a failed readiness removes the new proxy by name, then puts the old one back at the address", async () => {
    registryWith(rec());
    sandbox([NET]);
    await make().replace(KEY);
    const old = layer.proxies[0]!;
    stale();
    layer.calls = [];
    layer.createError = new Error("proxy never became ready");
    await expect(make().replace(KEY)).rejects.toThrow(/never became ready/);
    const order = layer.calls.map((c) => c.split(":")[0]);
    expect(order.indexOf("removeProjectProxyNamed")).toBeGreaterThan(order.indexOf("createProjectProxy"));
    expect(order.indexOf("restoreProjectProxy")).toBeGreaterThan(order.indexOf("removeProjectProxyNamed"));
    expect(layer.count("removeProjectProxy")).toBe(0); // the old proxy was never removed
    expect(layer.proxies.map((p) => p.id)).toEqual([old.id]);
    expect(old.alias).toBe(true); // old reconnected
    expect(lockFiles()).toEqual([]);
  });

  it("a new proxy that is not attached at the address is rolled back too, and the old one is put back", async () => {
    registryWith(rec());
    sandbox([NET]);
    await make().replace(KEY);
    const old = layer.proxies[0]!;
    stale();
    const real = layer.projectProxyAttached.bind(layer);
    let lied = false;
    layer.projectProxyAttached = async (id: string, net: { id: string }) => {
      if (id !== old.id && !lied) {
        lied = true;
        return false;
      }
      return real(id, net);
    };
    await expect(make().replace(KEY)).rejects.toThrow(/not attached/);
    expect(layer.proxies.map((p) => p.id)).toEqual([old.id]);
    expect(old.alias).toBe(true);
    expect(layer.count("removeProjectProxy")).toBe(0);
  });

  it("when the old proxy cannot be put back either, the project has no proxy: the next use repairs it", async () => {
    registryWith(rec());
    sandbox([NET]);
    const lines: string[] = [];
    const c = new Containment(cfg, new Registry(dir), layer, { dataDir: dir, clock, log: (l) => lines.push(l) });
    await c.replace(KEY);
    stale();
    layer.createError = new Error("proxy never became ready");
    layer.restoreError = new Error("Address already in use");
    await expect(c.replace(KEY)).rejects.toThrow(/never became ready/);
    expect(lines.join("\n")).toMatch(/no proxy now/);
    // No attached proxy is left: the detached old one stands, off the network, and the sandbox has no route.
    expect(layer.proxies.every((p) => !p.alias)).toBe(true);
    // The next use of the sandbox finds that and replaces it.
    layer.createError = undefined;
    layer.restoreError = undefined;
    const env = await c.ensureContained(sandboxFacts(), "full");
    expect(env).toEqual(envNow());
    expect(layer.proxies.length).toBe(1);
    expect(layer.proxies[0]!.alias).toBe(true);
  });

  it("a lock that was taken over puts nothing back (someone else may be replacing it now)", async () => {
    registryWith(rec());
    sandbox([NET]);
    await make().replace(KEY);
    stale();
    layer.calls = [];
    layer.afterCreate = () => fs.writeFileSync(lockPath(), "thief:token");
    await expect(make().replace(KEY)).rejects.toBeInstanceOf(ContainmentLockLostError);
    expect(layer.count("removeProjectProxyNamed")).toBe(1);
    expect(layer.count("restoreProjectProxy")).toBe(0);
  });

  // Leg 13's review follow-up: `assertLive` between the detach and the create was not pinned (removing it was not caught).
  it("a lock lost after the detach and before the create stops there: nothing is created, nothing is put back", async () => {
    registryWith(rec());
    sandbox([NET]);
    await make().replace(KEY);
    stale();
    layer.calls = [];
    layer.afterDetach = () => fs.writeFileSync(lockPath(), "thief:token");
    await expect(make().replace(KEY)).rejects.toBeInstanceOf(ContainmentLockLostError);
    expect(layer.count("detachProjectProxy")).toBe(1);
    expect(layer.count("createProjectProxy")).toBe(0);
    expect(layer.count("restoreProjectProxy")).toBe(0);
  });

  // Leg 14 (T18): a reconnected proxy gets a new MAC, so a rollback that put the old proxy back restarts a running non-runc sandbox.
  it.each([
    ["runsc", true, 1],
    ["runsc", false, 0],
    ["runc", true, 0],
    [undefined, true, 0],
  ])("a rolled-back replacement under runtime %s (sandbox running: %s) restarts the sandbox %i time(s)", async (runtime, running, restarts) => {
    registryWith(rec());
    sandbox([NET]);
    await make().replace(KEY);
    stale();
    layer.runtime = runtime;
    layer.sandboxes.get(SANDBOX)!.running = running;
    layer.calls = [];
    layer.createError = new Error("no");
    await expect(make().replace(KEY)).rejects.toThrow(/no/);
    expect(layer.count("restoreProjectProxy")).toBe(1);
    expect(layer.count("restartSandbox")).toBe(restarts);
  });

  it("a failed rollback (nothing put back) restarts nothing", async () => {
    registryWith(rec());
    sandbox([NET]);
    await make().replace(KEY);
    stale();
    layer.runtime = "runsc";
    layer.calls = [];
    layer.createError = new Error("no");
    layer.restoreError = new Error("Address already in use");
    await expect(make().replace(KEY)).rejects.toThrow(/no/);
    expect(layer.count("restartSandbox")).toBe(0);
  });

  // Leg 14: the fixed proxy MAC is relied on, so a replacement never restarts the sandbox (only a rollback does).
  it("a replacement of a running sandbox's proxy restarts nothing", async () => {
    registryWith(rec());
    sandbox([NET]);
    await make().replace(KEY);
    stale();
    layer.calls = [];
    expect((await make().replace(KEY)).kind).toBe("replaced");
    expect(layer.count("restartSandbox")).toBe(0);
  });

  it("only one of two old proxies is put back: they share the address", async () => {
    registryWith(rec());
    sandbox([NET]);
    await make().replace(KEY);
    const net = layer.nets.get(NET)!;
    layer.proxies.push({ id: idOf("extra"), name: `${SANDBOX}-proxy-ffffffff`, running: true, labels: { [PROJECT_LABEL]: PROJECT }, netId: net.id, alias: true });
    layer.createError = new Error("no");
    await expect(make().replace(KEY)).rejects.toThrow(/no/);
    expect(layer.count("restoreProjectProxy")).toBe(1);
    expect(layer.proxies.filter((p) => p.alias).length).toBe(1);
  });

  it("a proxy on the network but not attached at the address is replaced when the sandbox is used", async () => {
    registryWith(rec());
    sandbox([NET]);
    const c = make();
    await c.replace(KEY);
    layer.proxies[0]!.alias = false;
    layer.calls = [];
    expect(await c.ensureContained(sandboxFacts(), "full")).toEqual(envNow());
    expect(layer.count("createProjectProxy")).toBe(1);
    expect(layer.proxies.length).toBe(1);
  });
});

describe("local access names in the sandbox's /etc/hosts (leg 13)", () => {
  const FWD = "owner/app=db.lan:5432,host.docker.internal:8080";
  const withForwards = (extra = "") => loadConfig({ MCPE_NETWORK: "contained", MCPE_DATA_DIR: dir, MCPE_LOCAL_ACCESS: `${FWD}${extra}` });
  const sfacts = (over: Partial<SandboxInspectFacts> = {}): SandboxInspectFacts => ({
    id: idOf(SANDBOX), name: SANDBOX, running: true, labels: { [PROJECT_LABEL]: PROJECT }, networks: [NET], runtime: undefined, ...over,
  });
  const address = () => proxyAddress(layer.nets.get(NET)!.subnet);

  it("a replacement that makes a proxy writes the names once, at the proxy's address", async () => {
    registryWith(rec());
    sandbox([NET]);
    await make(undefined, withForwards()).replace(KEY);
    expect(layer.writes).toEqual([{ id: idOf(SANDBOX), address: address(), names: ["db.lan", "host.docker.internal"] }]);
  });

  it("a replacement that changes nothing writes nothing, and a project with no forwards is never written to", async () => {
    registryWith(rec());
    sandbox([NET]);
    const c = make(undefined, withForwards());
    await c.replace(KEY);
    layer.writes = [];
    expect((await c.replace(KEY)).kind).toBe("unchanged");
    expect(layer.writes).toEqual([]);
  });

  it("a project with no forwards is never written to, however often its proxy is replaced", async () => {
    registryWith(rec());
    sandbox([NET]);
    const plain = make();
    await plain.replace(KEY);
    layer.proxies[0]!.labels[RECORD_LABEL] = "stale"; // a hosts-only change
    await plain.replace(KEY, { force: true });
    expect(layer.calls.some((x) => x.startsWith("writeLocalAccess"))).toBe(false);
  });

  it("when the forwards become empty the lines are taken out (a write with no names)", async () => {
    registryWith(rec());
    sandbox([NET]);
    await make(undefined, withForwards()).replace(KEY);
    layer.writes = [];
    await make().replace(KEY, { compareSession: true }); // the session label differs: the proxy is replaced
    expect(layer.writes).toEqual([{ id: idOf(SANDBOX), address: address(), names: [] }]);
  });

  it("a build has no forwards, so none are written", async () => {
    registryWith(rec({ status: "installing" }));
    sandbox([NET]);
    await make(undefined, withForwards()).replace(KEY);
    expect(layer.writes).toEqual([]);
  });

  it("contain writes the names to a sandbox that was already running, after it is on its network", async () => {
    registryWith(rec());
    sandbox(["bridge"]);
    const r = await make(undefined, withForwards()).contain(KEY);
    expect(r.ok).toBe(true);
    expect(layer.writes.length).toBeGreaterThanOrEqual(1);
    expect(layer.writes.at(-1)).toEqual({ id: idOf(SANDBOX), address: address(), names: ["db.lan", "host.docker.internal"] });
    expect(layer.calls.lastIndexOf("setNetwork:contained")).toBeLessThan(layer.calls.findIndex((x) => x.startsWith("writeLocalAccess")));
  });

  it("a write that fails is logged and never fails the replacement", async () => {
    registryWith(rec());
    sandbox([NET]);
    const lines: string[] = [];
    layer.writeError = new Error("exec failed");
    const c = new Containment(withForwards(), new Registry(dir), layer, { dataDir: dir, clock, log: (l) => lines.push(l) });
    expect((await c.replace(KEY)).kind).toBe("replaced");
    expect(lines.join("\n")).toMatch(/could not write the local-access names.*exec failed/);
  });

  describe("the post-start step", () => {
    it("is installed with the hook", () => {
      make().install();
      expect(layer.afterStart).toBeTypeOf("function");
    });

    it("writes the names after a start, at the address read from the network", async () => {
      registryWith(rec());
      sandbox([NET]);
      const c = make(undefined, withForwards());
      await c.replace(KEY);
      layer.writes = [];
      layer.calls = [];
      await c.afterStart(sfacts(), true);
      expect(layer.writes).toEqual([{ id: idOf(SANDBOX), address: address(), names: ["db.lan", "host.docker.internal"] }]);
    });

    it("also checks a sandbox that was already running (started: false): the same idempotent write", async () => {
      registryWith(rec());
      sandbox([NET]);
      const c = make(undefined, withForwards());
      await c.replace(KEY);
      layer.writes = [];
      await c.afterStart(sfacts(), false);
      await c.afterStart(sfacts(), false);
      expect(layer.writes.length).toBe(2); // the write is idempotent inside the sandbox; no state is kept here
      expect(layer.writes[0]).toEqual(layer.writes[1]);
    });

    it("is skipped entirely for a project with no forwards: no call, no registry read", async () => {
      registryWith(rec());
      sandbox([NET]);
      layer.calls = [];
      await make().afterStart(sfacts(), true);
      expect(layer.calls).toEqual([]);
    });

    it.each([
      ["a sandbox that is not contained", { networks: ["bridge"] }],
      ["a sandbox with no project label", { labels: {} }],
      ["a sandbox that is not the record's", { name: "mcpe-app-old", networks: ["mcpe-app-old-net"] }],
    ])("does nothing for %s", async (_n, over) => {
      registryWith(rec());
      sandbox([NET]);
      layer.nets.set("mcpe-app-old-net", { id: idOf("old"), name: "mcpe-app-old-net", subnet: "172.30.7.0/24" });
      await make(undefined, withForwards()).afterStart(sfacts(over), true);
      expect(layer.writes).toEqual([]);
    });

    it("does nothing when the session does not contain", async () => {
      registryWith(rec());
      sandbox([NET]);
      const open = loadConfig({ MCPE_NETWORK: "open", MCPE_DATA_DIR: dir, MCPE_LOCAL_ACCESS: FWD });
      await make(undefined, open).afterStart(sfacts(), true);
      expect(layer.writes).toEqual([]);
    });

    it("reads a network's subnet once (by id) across many starts", async () => {
      registryWith(rec());
      sandbox([NET]);
      const c = make(undefined, withForwards());
      await c.replace(KEY);
      layer.calls = [];
      const ids = { [NET]: layer.nets.get(NET)!.id };
      for (let i = 0; i < 3; i++) await c.afterStart(sfacts({ networkIds: ids }), true);
      expect(layer.count("findProjectNetwork")).toBe(0); // the replacement had already read it
      const fresh = make(undefined, withForwards());
      layer.calls = [];
      for (let i = 0; i < 3; i++) await fresh.afterStart(sfacts({ networkIds: ids }), true);
      expect(layer.count("findProjectNetwork")).toBe(1);
    });

    it("never throws: a failed write is logged", async () => {
      registryWith(rec());
      sandbox([NET]);
      const lines: string[] = [];
      const c = new Containment(withForwards(), new Registry(dir), layer, { dataDir: dir, clock, log: (l) => lines.push(l) });
      await c.replace(KEY);
      layer.writeError = new Error("exec failed");
      await expect(c.afterStart(sfacts(), true)).resolves.toBeUndefined();
      expect(lines.join("\n")).toMatch(/exec failed/);
    });
  });
});

describe("openUnlessContained (leg 9): never loosen, as one step under the project's lock", () => {
  it("a contained sandbox is left alone: the state is read, nothing is set", async () => {
    registryWith(rec());
    sandbox([NET]);
    const r = await make().openUnlessContained(KEY);
    expect(r).toEqual({ state: "contained", opened: false });
    expect(layer.count("setNetwork")).toBe(0);
  });

  it("an offline sandbox is opened, and a sandbox already on bridge is not touched", async () => {
    registryWith(rec());
    sandbox([]);
    expect(await make().openUnlessContained(KEY)).toEqual({ state: "off", opened: true });
    expect(layer.calls).toContain("setNetwork:open");
    layer.calls = [];
    expect(await make().openUnlessContained(KEY)).toEqual({ state: "open", opened: false });
    expect(layer.count("setNetwork")).toBe(0);
  });

  it("works under an open session too (Containment exists in both modes)", async () => {
    registryWith(rec());
    sandbox([NET]);
    const open = loadConfig({ MCPE_NETWORK: "open", MCPE_DATA_DIR: dir });
    expect((await make(undefined, open).openUnlessContained(KEY)).state).toBe("contained");
    expect(layer.count("setNetwork")).toBe(0);
  });

  it("takes the project's lock around the read and the write", async () => {
    registryWith(rec());
    sandbox([]);
    const seen: string[][] = [];
    const read = layer.networkState.bind(layer);
    layer.networkState = async (t) => {
      seen.push(lockFiles());
      return read(t);
    };
    await make().openUnlessContained(KEY);
    expect(seen).toEqual([[path.basename(lockPath())]]);
    expect(lockFiles()).toEqual([]);
  });

  it("waits for a replacement in progress: a containment that lands first is seen, and not undone", async () => {
    registryWith(rec());
    sandbox([]);
    layer.createGate = new Deferred();
    const c = make();
    const contain = c.contain(KEY);
    await flush();
    const open = c.openUnlessContained(KEY);
    await flush();
    expect(layer.count("setNetwork")).toBe(0);
    layer.createGate.resolve();
    layer.createGate = undefined;
    expect((await contain).ok).toBe(true);
    expect((await open).state).toBe("contained");
    expect(layer.calls.filter((c) => c === "setNetwork:open")).toEqual([]);
  });

  it("with a reference, the state is read and the change made on it", async () => {
    registryWith(rec());
    sandbox([]);
    const ref = makeRef(idOf(SANDBOX), SANDBOX);
    await make().openUnlessContained(KEY, ref);
    expect(layer.calls).toContain(`networkState:${SANDBOX}`);
  });
});

describe("proxyDiffers (leg 9)", () => {
  it("is false for a proxy this session built, true once the record's hosts change, undefined with no network or no running proxy", async () => {
    const reg = registryWith(rec());
    sandbox([NET]);
    const c = make(reg);
    expect(await c.proxyDiffers(KEY)).toBeUndefined(); // no network yet
    await c.replace(KEY);
    expect(await c.proxyDiffers(KEY)).toBe(false);
    reg.update("app", (cur) => ({ ...cur!, hosts: ["new.example"] }));
    expect(await c.proxyDiffers(KEY)).toBe(true);
    layer.proxies.forEach((p) => (p.running = false));
    expect(await c.proxyDiffers(KEY)).toBeUndefined();
  });

  it("never repairs or changes anything, and never throws", async () => {
    const reg = registryWith(rec());
    sandbox([NET]);
    const c = make(reg);
    await c.replace(KEY);
    layer.calls = [];
    layer.findProjectNetwork = async () => {
      throw new Error("down");
    };
    expect(await c.proxyDiffers(KEY)).toBeUndefined();
    expect(layer.calls.filter((x) => /^(create|remove|start|setNetwork|attach)/.test(x))).toEqual([]);
  });
});
