import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { serveApp, type Serving } from "../src/entry.js";
import { McpProxy } from "../src/proxy/mcp-proxy.js";
import { App } from "../src/server.js";
import type { ToolDef } from "../src/types.js";
import { FakeDocker, fakeUpstream, record } from "./helpers.js";

const tool: ToolDef = {
  name: "demo__demo_build",
  description: "[sandboxed github:owner/demo] Runs `demo build`.",
  inputSchema: { type: "object", properties: { release: { type: "boolean" } } },
  kind: "cli",
  argv: ["demo", "build"],
  options: [{ prop: "release", flag: "--release", takesValue: false, description: "" }],
  cwd: "/workspace/work",
};

const MODERN = "2026-07-28";
const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "raw", version: "1" },
};
const LIST_CHANGED = "notifications/tools/list_changed";

let dir: string;
let docker: FakeDocker;
let app: App;
let lines: string[];
const handles: Serving[] = [];
const clients: Client[] = [];

type Wire = { id?: number; method?: string; result?: Record<string, unknown>; error?: { code: number }; params?: Record<string, unknown> };

/** The client side of a linked pair, driven by hand: sends JSON-RPC and keeps everything that comes back, in order. */
function raw(target: App = app) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = serveApp(target, serverSide);
  handles.push(handle);
  const got: Wire[] = [];
  let wake: Array<() => void> = [];
  clientSide.onmessage = (m) => {
    got.push(m as Wire);
    for (const w of wake.splice(0)) w();
  };
  let next = 0;
  const until = async (pred: (m: Wire) => boolean): Promise<Wire> => {
    for (;;) {
      const hit = got.find(pred);
      if (hit) return hit;
      await new Promise<void>((r) => wake.push(r));
    }
  };
  const send = async (method: string, params?: Record<string, unknown>, id?: number) =>
    clientSide.send({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) } as JSONRPCMessage);
  return {
    handle,
    got,
    /** A request with the revision's envelope; resolves with its answer. */
    async modern(method: string, params: Record<string, unknown> = {}): Promise<Wire> {
      const id = ++next;
      await send(method, { ...params, _meta: { ...ENVELOPE, ...((params._meta as object) ?? {}) } }, id);
      return until((m) => m.id === id);
    },
    /** A request as the 2025 handshake sends it; resolves with its answer. */
    async legacy(method: string, params?: Record<string, unknown>): Promise<Wire> {
      const id = ++next;
      await send(method, params, id);
      return until((m) => m.id === id);
    },
    initialize: (version: string) => {
      const id = ++next;
      return send("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "raw", version: "1" } }, id).then(() =>
        until((m) => m.id === id),
      );
    },
    notify: (method: string) => send(method),
    changes: () => got.filter((m) => m.method === LIST_CHANGED).length,
  };
}

/** A real client that counts `notifications/tools/list_changed` and lets a test wait for the nth. */
async function connected(options: ConstructorParameters<typeof Client>[1] = {}, target: App = app, subscribe = false) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const handle = serveApp(target, serverSide);
  handles.push(handle);
  const client = new Client({ name: "test", version: "0" }, options);
  clients.push(client);
  let count = 0;
  let waiting: Array<[number, () => void]> = [];
  client.setNotificationHandler(LIST_CHANGED, () => {
    count++;
    waiting = waiting.filter(([n, r]) => (count >= n ? (r(), false) : true));
  });
  await client.connect(clientSide);
  if (subscribe) await client.listen({ toolsListChanged: true });
  return {
    client,
    handle,
    count: () => count,
    /** Resolves once the nth notification has arrived (at once if it has). */
    nth: (n: number) => (count >= n ? Promise.resolve() : new Promise<void>((r) => waiting.push([n, r]))),
  };
}
const pin = { versionNegotiation: { mode: { pin: MODERN } } } as const;

/** Replaces the installer: `install` calls `lines` for each progress line and then resolves when the gate opens. */
function stubInstall(progress: string[] = []) {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  (app.installer as unknown as { install: unknown }).install = async (_o: unknown, onLine?: (l: string) => void) => {
    for (const l of progress) onLine?.(l);
    await gate;
    return { ...record("demo"), status: "ready" };
  };
  return { open };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-srv2-"));
  const cfg = loadConfig({ HOME: dir, MCPE_DATA_DIR: dir, MCPE_MCP_STARTUP_TIMEOUT: "1" });
  docker = new FakeDocker(cfg);
  lines = [];
  app = new App({ cfg, docker, proxy: new McpProxy(cfg, docker, fakeUpstream().connector), log: (l) => lines.push(l) });
  app.registry.put({ ...record("demo"), tools: [tool], commands: [{ name: "demo", origin: "test" }] });
});
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
  for (const h of handles.splice(0)) await h.close();
  await app.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

const connectionLines = () => lines.filter((l) => l.startsWith("connection: "));
const names = (r: { tools: Array<{ name: string }> }) => r.tools.map((t) => t.name);

describe("a 2026-07-28 client", () => {
  it.each([
    ["pinned", pin],
    ["auto", { versionNegotiation: { mode: "auto" } } as const],
  ])("is served in its own revision when it is %s: lists, calls, and reads the instructions", async (_name, options) => {
    const { client } = await connected(options);
    expect(client.getNegotiatedProtocolVersion()).toBe(MODERN);
    expect(client.getProtocolEra()).toBe("modern");
    expect(client.getInstructions()).toContain("untrusted");
    const listed = await client.listTools();
    expect(names(listed)).toContain("install_project");
    expect(names(listed)).toContain("demo__demo_build");
    docker.next = { stdout: "built here\n" };
    const res = await client.callTool({ name: "demo__demo_build", arguments: {} });
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain("built here");
  });

  it("is told in server/discover that the server's tool list can change", async () => {
    const r = raw();
    const res = await r.modern("server/discover");
    expect((res.result!.capabilities as { tools?: { listChanged?: boolean } }).tools?.listChanged).toBe(true);
  });

  it("is sent tool listings as not cacheable (ttlMs 0, private scope)", async () => {
    const r = raw();
    const res = await r.modern("tools/list");
    expect(res.result!.ttlMs).toBe(0);
    expect(res.result!.cacheScope).toBe("private");
  });

  it("is sent progress on the wire before the result of a call that asked for it", async () => {
    const s = stubInstall(["cloning", "building"]);
    const r = raw();
    const answer = r.modern("tools/call", { name: "install_project", arguments: { repo: "owner/demo" }, _meta: { progressToken: "p1" } });
    await new Promise((res) => setImmediate(res));
    s.open();
    const result = await answer;
    expect(result.result).toBeDefined();
    const at = (m: Wire) => r.got.indexOf(m);
    const progress = r.got.filter((m) => m.method === "notifications/progress");
    expect(progress.length).toBe(2);
    for (const p of progress) expect(at(p)).toBeLessThan(at(result));
    expect(progress.map((p) => p.params!.message)).toEqual(["cloning", "building"]);
  });
});

describe("a 2025 client", () => {
  it("is served in 2025-11-25: lists, calls, and reads the instructions", async () => {
    const { client } = await connected();
    expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
    expect(client.getProtocolEra()).toBe("legacy");
    expect(client.getInstructions()).toContain("untrusted");
    const listed = await client.listTools();
    expect(names(listed)).toContain("demo__demo_build");
    docker.next = { stdout: "built here\n" };
    const res = await client.callTool({ name: "demo__demo_build", arguments: {} });
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain("built here");
  });

  it("sees that the server's tool list can change", async () => {
    const { client } = await connected();
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
  });

  it("that asks for 2026-07-28 through initialize is answered 2025-11-25, since that revision has no initialize", async () => {
    const r = raw();
    const res = await r.initialize(MODERN);
    expect(res.result!.protocolVersion).toBe("2025-11-25");
  });
});

describe("a change to the tool list", () => {
  it("reaches a 2025 client before the answer of an install that waited for its job", async () => {
    const s = stubInstall();
    const c = await connected();
    s.open();
    await c.client.callTool({ name: "install_project", arguments: { repo: "owner/demo" } });
    expect(c.count()).toBe(1);
  });

  it("reaches a 2025 client when an install that answered `still installing` finishes later", async () => {
    const s = stubInstall();
    const c = await connected();
    const res = await c.client.callTool({ name: "install_project", arguments: { repo: "owner/demo", wait_seconds: 0 } });
    expect((res.content as Array<{ text: string }>)[0]!.text).toMatch(/^Still installing/);
    expect(c.count()).toBe(0);
    s.open();
    await c.nth(1);
    expect(c.count()).toBe(1);
  });

  it("reaches a 2025 client after uninstall_project, without being asked", async () => {
    const c = await connected();
    await c.client.callTool({ name: "uninstall_project", arguments: { project: "demo" } });
    await c.nth(1);
    expect(c.count()).toBe(1);
  });

  it("reaches a subscribed 2026-07-28 client after an install that waited, and after uninstall_project", async () => {
    const s = stubInstall();
    const c = await connected(pin, app, true);
    s.open();
    await c.client.callTool({ name: "install_project", arguments: { repo: "owner/demo" } });
    await c.nth(1);
    await c.client.callTool({ name: "uninstall_project", arguments: { project: "demo" } });
    await c.nth(2);
    expect(c.count()).toBe(2);
  });

  it("reaches a subscribed 2026-07-28 client when an install that answered `still installing` finishes later", async () => {
    const s = stubInstall();
    const c = await connected(pin, app, true);
    await c.client.callTool({ name: "install_project", arguments: { repo: "owner/demo", wait_seconds: 0 } });
    expect(c.count()).toBe(0);
    s.open();
    await c.nth(1);
  });

  it("is told to a 2026-07-28 client only if it subscribed (that revision's rule), and a subscriber on another connection hears it", async () => {
    const r = raw();
    await r.modern("tools/list");
    expect(app.connections).toBe(1);
    app.announceToolListChanged();
    await r.modern("tools/list"); // notifications are written before a later answer, so none is in `got` by now
    expect(r.changes()).toBe(0);

    const sub = await connected(pin, app, true);
    expect(app.connections).toBe(2);
    app.announceToolListChanged();
    await sub.nth(1);
    expect(sub.count()).toBe(1);
    await r.modern("tools/list");
    expect(r.changes()).toBe(0);
  });

  it("reaches a 2025 client and a subscribed 2026-07-28 client at once, on two connections", async () => {
    const old = await connected();
    const modern = await connected(pin, app, true);
    expect(app.connections).toBe(2);
    app.announceToolListChanged();
    await Promise.all([old.nth(1), modern.nth(1)]);
    expect([old.count(), modern.count()]).toEqual([1, 1]);
  });

  it("is announced once, on one live instance, to a client that probed with server/discover and then initialized", async () => {
    const r = raw();
    const discovered = await r.modern("server/discover");
    expect(discovered.result!.supportedVersions).toContain(MODERN);
    const init = await r.initialize("2025-11-25");
    expect(init.result!.protocolVersion).toBe("2025-11-25");
    await r.notify("notifications/initialized");
    await r.legacy("tools/list");
    expect(app.connections).toBe(1);
    app.announceToolListChanged();
    await r.legacy("tools/list");
    expect(r.changes()).toBe(1);
    expect(connectionLines()).toEqual(["connection: MCP protocol 2025-11-25"]);
  });

  it("is announced to nobody, without a throw, when no connection is live", () => {
    expect(app.connections).toBe(0);
    expect(() => app.announceToolListChanged()).not.toThrow();
  });
});

describe("the instances that are live", () => {
  it("are counted from a connection's start to its end, whichever side ends it", async () => {
    expect(app.connections).toBe(0);
    const a = await connected();
    expect(app.connections).toBe(1);
    await a.client.close();
    expect(app.connections).toBe(0);
    expect(() => app.announceToolListChanged()).not.toThrow();

    const b = await connected(pin);
    expect(app.connections).toBe(1);
    await b.handle.close();
    expect(app.connections).toBe(0);
    expect(() => app.announceToolListChanged()).not.toThrow();
  });
});

describe("the line written for a connection", () => {
  it("names 2025-11-25 for a default client, once, however many requests follow", async () => {
    const { client } = await connected();
    await client.listTools();
    await client.listTools();
    await client.callTool({ name: "demo__demo_build", arguments: {} });
    expect(connectionLines()).toEqual(["connection: MCP protocol 2025-11-25"]);
  });

  it("names what a 2025 handshake negotiated, here 2025-06-18, and writes it when the handshake completes", async () => {
    const r = raw();
    const init = await r.initialize("2025-06-18");
    expect(init.result!.protocolVersion).toBe("2025-06-18");
    expect(connectionLines()).toEqual([]);
    await r.notify("notifications/initialized");
    await r.legacy("ping"); // answered after the notification was handled
    expect(connectionLines()).toEqual(["connection: MCP protocol 2025-06-18"]);
  });

  it("is written for a 2026-07-28 connection at its first tool request, not for server/discover alone, and once", async () => {
    const r = raw();
    await r.modern("server/discover");
    expect(connectionLines()).toEqual([]);
    await r.modern("tools/list");
    expect(connectionLines()).toEqual(["connection: MCP protocol 2026-07-28"]);
    await r.modern("tools/list");
    await r.modern("tools/call", { name: "demo__demo_build", arguments: {} });
    expect(connectionLines()).toEqual(["connection: MCP protocol 2026-07-28"]);
  });

  it("is written for a 2026-07-28 connection whose first tool request is tools/call, once", async () => {
    const r = raw();
    await r.modern("tools/call", { name: "demo__demo_build", arguments: {} });
    expect(connectionLines()).toEqual(["connection: MCP protocol 2026-07-28"]);
    await r.modern("tools/call", { name: "demo__demo_build", arguments: {} });
    expect(connectionLines()).toEqual(["connection: MCP protocol 2026-07-28"]);
  });

  it("is written once for a client that probes and falls back, and names 2025-11-25", async () => {
    const r = raw();
    await r.modern("server/discover");
    await r.initialize("2025-11-25");
    await r.notify("notifications/initialized");
    await r.legacy("tools/list");
    await r.legacy("tools/list");
    expect(connectionLines()).toEqual(["connection: MCP protocol 2025-11-25"]);
  });

  it("is not written, and nothing throws, when the instance has negotiated nothing", async () => {
    const s = app.createServer();
    expect(app.connections).toBe(1);
    expect(() => s.oninitialized?.()).not.toThrow();
    expect(connectionLines()).toEqual([]);
  });
});
