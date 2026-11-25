import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryTransport, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { DockerUnavailableError } from "../src/sandbox/errors.js";
import { SandboxRefusedError } from "../src/sandbox/ownership.js";
import { dockerConnector, McpProxy, sweepEnvFiles, validateEnv, type Connector } from "../src/proxy/mcp-proxy.js";
import type { SandboxRef } from "../src/sandbox/docker-base.js";
import type { McpServerSpec } from "../src/types.js";
import { FakeDocker, fakeSandboxId, fakeUpstream, SECRET_VALUE, type FakeUpstream } from "./helpers.js";

const spec = (over: Partial<McpServerSpec> = {}): McpServerSpec => ({
  name: "srv",
  argv: ["srv"],
  cwd: "/workspace/repo",
  env: {},
  origin: "registered",
  ...over,
});
/** A checked reference as the Docker double would hand it out. */
const refOf = (name: string): SandboxRef => Object.freeze({ id: fakeSandboxId(name), name });
const textOf = (res: unknown) => (res as { content: Array<{ text: string }> }).content[0]!.text;

let dir: string;
let cfg: Config;
let docker: FakeDocker;
let up: FakeUpstream;
let proxy: McpProxy;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-proxy-"));
  cfg = loadConfig({ HOME: dir, MCPE_DATA_DIR: dir, MCPE_MCP_IDLE_TIMEOUT: "60" });
  docker = new FakeDocker(cfg);
  up = fakeUpstream();
  proxy = new McpProxy(cfg, docker, up.connector);
});
afterEach(async () => {
  await proxy.closeAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The in-sandbox kill commands the proxy issued, as pid file paths. */
const kills = () => docker.calls.filter((c) => c.argv[0] === "sh" && c.argv[2]?.includes("kill")).map((c) => c.argv[4]);

describe("McpProxy", () => {
  it("lists upstream tools and forwards calls over one shared session", async () => {
    const tools = await proxy.listTools("c1", spec());
    expect(tools.map((t) => t.name)).toEqual(["add", "whoami", "hang", "mixed"]);
    expect(tools[0]).toMatchObject({ description: "Add two numbers", inputSchema: { type: "object", required: ["a", "b"] } });

    expect(textOf(await proxy.callTool("c1", spec(), "add", { a: 2, b: 40 }, 5))).toBe("42");
    expect(textOf(await proxy.callTool("c1", spec(), "add", { a: 1, b: 1 }, 5))).toBe("2");
    expect(up.launches).toHaveLength(1);
    expect(up.received.map((r) => r.arguments)).toEqual([{ a: 2, b: 40 }, { a: 1, b: 1 }]);
    expect(up.launches[0]).toMatchObject({ container: "c1", server: { argv: ["srv"] } });
    expect(up.launches[0]!.pidFile).toMatch(/^\/tmp\/mcpe-mcp-[0-9a-f]{12}\.pid$/);
  });

  it("starts concurrent first calls only once", async () => {
    const results = await Promise.all([1, 2, 3].map((n) => proxy.callTool("c1", spec(), "add", { a: n, b: 0 }, 5)));
    expect(results.map(textOf)).toEqual(["1", "2", "3"]);
    expect(up.launches).toHaveLength(1);
  });

  it("uses separate sessions per container, per server, and per launch spec", async () => {
    await proxy.callTool("c1", spec(), "whoami", {}, 5);
    await proxy.callTool("c2", spec(), "whoami", {}, 5);
    await proxy.callTool("c1", spec({ name: "other" }), "whoami", {}, 5);
    const withEnv = await proxy.callTool("c1", spec({ env: { TOKEN: "t" } }), "whoami", {}, 5);
    expect(textOf(withEnv)).toBe("srv env=TOKEN");
    await proxy.callTool("c1", spec({ argv: ["srv", "--flag"] }), "whoami", {}, 5);
    expect(up.launches).toHaveLength(5);
    expect(proxy.size).toBe(5);
  });

  it("refuses to start when the sandbox is gone", async () => {
    docker.exists = false;
    await expect(proxy.listTools("c1", spec())).rejects.toThrow(/no longer exists/);
    expect(up.launches).toHaveLength(0);
    expect(proxy.size).toBe(0);
  });

  it("reports a server that never completes the handshake, with its stderr, and cleans up", async () => {
    up.answer = false;
    await expect(proxy.listTools("c1", spec({ argv: ["srv", "--x"] }), 0.05)).rejects.toThrow(
      /MCP server "srv" \(srv --x\) did not start: no MCP handshake within 0\.05s\n--- server stderr ---\nupstream stderr tail/,
    );
    expect(proxy.size).toBe(0);
    expect(kills()).toEqual([up.launches[0]!.pidFile]);
    // The next attempt launches again rather than reusing the failure.
    up.answer = true;
    await proxy.listTools("c1", spec({ argv: ["srv", "--x"] }));
    expect(up.launches).toHaveLength(2);
  });

  it("stops a server whose tool call times out and restarts it on the next call", async () => {
    await expect(proxy.callTool("c1", spec(), "hang", {}, 0.05)).rejects.toThrow(/timed out after 0\.05s; the server was stopped/);
    expect(proxy.size).toBe(0);
    expect(kills()).toEqual([up.launches[0]!.pidFile]);
    expect(textOf(await proxy.callTool("c1", spec(), "add", { a: 1, b: 2 }, 5))).toBe("3");
    expect(up.launches).toHaveLength(2);
  });

  it("surfaces upstream tool errors without tearing the session down", async () => {
    await expect(proxy.callTool("c1", spec(), "nope", {}, 5)).rejects.toThrow(/rejected the call to "nope".*no such tool nope/);
    expect(proxy.size).toBe(1);
    await proxy.callTool("c1", spec(), "add", { a: 1, b: 1 }, 5);
    expect(up.launches).toHaveLength(1);
  });

  it("notices a server that exits on its own and relaunches it", async () => {
    await proxy.callTool("c1", spec(), "add", { a: 1, b: 1 }, 5);
    await up.servers[0]!.close();
    await new Promise((r) => setTimeout(r, 10));
    expect(proxy.size).toBe(0);
    await proxy.callTool("c1", spec(), "add", { a: 1, b: 1 }, 5);
    expect(up.launches).toHaveLength(2);
  });

  it("closes one project's servers without touching another's", async () => {
    await proxy.callTool("c1", spec(), "add", { a: 1, b: 1 }, 5);
    await proxy.callTool("c1", spec({ name: "second" }), "add", { a: 1, b: 1 }, 5);
    await proxy.callTool("c10", spec(), "add", { a: 1, b: 1 }, 5);
    await proxy.closeProject("c1");
    expect(proxy.size).toBe(1);
    expect(kills().sort()).toEqual([up.launches[0]!.pidFile, up.launches[1]!.pidFile].sort());
  });

  it("reaps idle sessions but not ones that are busy or recently used", async () => {
    await proxy.callTool("c1", spec(), "add", { a: 1, b: 1 }, 5);
    const busy = proxy.callTool("c1", spec({ name: "busy" }), "hang", {}, 0.2).catch(() => "timed out");
    await new Promise((r) => setTimeout(r, 20));
    await proxy.reapIdle(Date.now() + 30_000);
    expect(proxy.size).toBe(2);
    await proxy.reapIdle(Date.now() + 61_000);
    expect(proxy.size).toBe(1); // the idle one is gone, the busy one survives
    expect(await busy).toBe("timed out");
  });
});

/**
 * A raw upstream: answers `initialize` by hand and hands every other request to `answer`, which returns the
 * message to send back (or nothing). Counts the launches it served.
 */
function rawUpstream(
  answer: (m: { id: number; method: string; params?: { cursor?: string } }, close: () => void) => object | undefined,
  capabilities: Record<string, unknown> = { tools: {} },
) {
  const state = { launches: 0 };
  const connector: Connector = () => {
    state.launches++;
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    serverSide.onmessage = (msg) => {
      const m = msg as unknown as { id?: number; method?: string; params?: { protocolVersion?: string; cursor?: string } };
      if (m.id === undefined || m.method === undefined) return;
      if (m.method === "initialize") {
        void serverSide.send({
          jsonrpc: "2.0",
          id: m.id,
          result: { protocolVersion: m.params?.protocolVersion, capabilities, serverInfo: { name: "raw", version: "1" } },
        });
        return;
      }
      const reply = answer({ id: m.id, method: m.method, params: m.params }, () => void serverSide.close());
      if (reply) void serverSide.send({ jsonrpc: "2.0", id: m.id, ...reply } as never);
    };
    void serverSide.start();
    return { transport: clientSide, stderr: () => "raw stderr tail" };
  };
  return { state, connector };
}

describe("McpProxy error classification", () => {
  const rawProxy = (connector: Connector) => new McpProxy(cfg, docker, connector);

  it("reports a server that goes away during a call as stopped, with its stderr, and drops the session", async () => {
    const raw = rawUpstream((m, close) => (m.method === "tools/call" ? void close() : undefined));
    const p = rawProxy(raw.connector);
    await expect(p.callTool("c1", spec(), "add", {}, 5)).rejects.toThrow(
      /^MCP server "srv" stopped while running "add": .+\n--- server stderr ---\nraw stderr tail$/s,
    );
    // The client's onclose has already retired the session, so no kill was issued; nothing here asserts one.
    expect(p.size).toBe(0);
  });

  it("treats an error that is neither of the SDK's classes as the server gone: stops it and launches again on the next call", async () => {
    const up2 = fakeUpstream();
    let first = true;
    const connector: Connector = (launch) => {
      const conn = up2.connector(launch);
      if (first) {
        first = false;
        const send = conn.transport.send.bind(conn.transport);
        conn.transport.send = async (msg, opts) => {
          if ((msg as { method?: string }).method === "tools/call") throw new Error("pipe broke");
          return send(msg, opts);
        };
      }
      return conn;
    };
    const p = rawProxy(connector);
    await expect(p.callTool("c1", spec(), "add", { a: 1, b: 2 }, 5)).rejects.toThrow(
      /^MCP server "srv" stopped while running "add": pipe broke\n--- server stderr ---\nupstream stderr tail$/,
    );
    expect(p.size).toBe(0);
    expect(kills()).toEqual([up2.launches[0]!.pidFile]);
    expect(textOf(await p.callTool("c1", spec(), "add", { a: 1, b: 2 }, 5))).toBe("3");
    expect(up2.launches).toHaveLength(2);
    await p.closeAll();
  });

  // Every local code of the client library, with the outcome chosen for it on purpose. A code that is missing here
  // (a release added one) or stale (a release removed one) fails the test below: classify it deliberately.
  const OUTCOME: Record<string, "timeout" | "gone" | "rejected"> = {
    [SdkErrorCode.RequestTimeout]: "timeout",
    [SdkErrorCode.ConnectionClosed]: "gone",
    [SdkErrorCode.SendFailed]: "gone",
    [SdkErrorCode.NotConnected]: "gone",
    [SdkErrorCode.AlreadyConnected]: "rejected",
    [SdkErrorCode.NotInitialized]: "rejected",
    [SdkErrorCode.CapabilityNotSupported]: "rejected",
    [SdkErrorCode.InvalidResult]: "rejected",
    [SdkErrorCode.UnsupportedResultType]: "rejected",
    [SdkErrorCode.InputRequiredRoundsExceeded]: "rejected",
    [SdkErrorCode.ListPaginationExceeded]: "rejected",
    [SdkErrorCode.MethodNotSupportedByProtocolVersion]: "rejected",
    [SdkErrorCode.EraNegotiationFailed]: "rejected",
    [SdkErrorCode.ClientHttpNotImplemented]: "rejected",
    [SdkErrorCode.ClientHttpAuthentication]: "rejected",
    [SdkErrorCode.ClientHttpForbidden]: "rejected",
    [SdkErrorCode.ClientHttpUnexpectedContent]: "rejected",
    [SdkErrorCode.ClientHttpFailedToOpenStream]: "rejected",
    [SdkErrorCode.ClientHttpFailedToTerminateSession]: "rejected",
  };

  it("has an outcome chosen on purpose for every code of the client library, and none for a code it no longer has", () => {
    const codes = Object.values(SdkErrorCode) as string[];
    const unclassified = codes.filter((c) => !(c in OUTCOME));
    const stale = Object.keys(OUTCOME).filter((c) => !codes.includes(c));
    expect(
      unclassified,
      `A new SdkErrorCode has appeared (${unclassified.join(", ")}); it must be classified deliberately as timeout, gone or rejected: ` +
        `add it to OUTCOME here, and to GONE_CODES in src/proxy/mcp-proxy.ts if the transport is broken by it.`,
    ).toEqual([]);
    expect(stale, `OUTCOME names codes that SdkErrorCode no longer has: ${stale.join(", ")}`).toEqual([]);
  });

  it.each(Object.values(SdkErrorCode) as string[])("sorts the client's error code %s into its chosen outcome", async (code) => {
    const outcome = OUTCOME[code];
    expect(outcome, `SdkErrorCode ${code} has no chosen outcome; a new code must be classified deliberately`).toBeDefined();
    const up2 = fakeUpstream();
    let thrown = false;
    const connector: Connector = (launch) => {
      const conn = up2.connector(launch);
      const send = conn.transport.send.bind(conn.transport);
      conn.transport.send = async (msg, opts) => {
        // The first tools/call of the whole run fails with this code; the client lets the error through unchanged.
        if (!thrown && (msg as { method?: string }).method === "tools/call") {
          thrown = true;
          throw new SdkError(code as SdkErrorCode, "chosen failure");
        }
        return send(msg, opts);
      };
      return conn;
    };
    const p = rawProxy(connector);
    const err = await p.callTool("c1", spec(), "add", { a: 1, b: 2 }, 5).catch((e: unknown) => e as Error);
    const msg = (err as Error).message;
    const kinds = {
      timeout: /timed out after 5s; the server was stopped/,
      gone: /stopped while running "add": .*chosen failure/s,
      rejected: /rejected the call to "add": .*chosen failure/s,
    } as const;
    for (const [kind, re] of Object.entries(kinds)) {
      if (kind === outcome) expect(msg).toMatch(re);
      else expect(msg).not.toMatch(re);
    }
    // Kept or dropped, and what the next call on the same server reaches.
    expect(p.size).toBe(outcome === "rejected" ? 1 : 0);
    expect(textOf(await p.callTool("c1", spec(), "add", { a: 1, b: 2 }, 5))).toBe("3");
    expect(up2.launches).toHaveLength(outcome === "rejected" ? 1 : 2);
    await p.closeAll();
  });

  it.each([-32000, -32001])("treats a server's own error of code %d as a rejected call and keeps the session", async (code) => {
    const raw = rawUpstream((m) => (m.method === "tools/call" ? { error: { code, message: "mine" } } : undefined));
    const p = rawProxy(raw.connector);
    const expected = `MCP server "srv" rejected the call to "add": MCP error ${code}: mine`;
    await expect(p.callTool("c1", spec(), "add", {}, 5)).rejects.toThrow(expected);
    expect(p.size).toBe(1);
    await expect(p.callTool("c1", spec(), "add", {}, 5)).rejects.toThrow(expected);
    expect(raw.state.launches).toBe(1);
    await p.closeAll();
  });

  it("treats a malformed tools/call result as a rejected call, keeps the session, and reuses the launch", async () => {
    const raw = rawUpstream((m) => (m.method === "tools/call" ? { result: { content: "bad" } } : undefined));
    const p = rawProxy(raw.connector);
    const err = await p.callTool("c1", spec(), "add", {}, 5).catch((e: unknown) => e as Error);
    expect((err as Error).message).toContain(`MCP server "srv" rejected the call to "add"`);
    expect((err as Error).message).not.toContain("stopped while running");
    // describeError carries the client's own words for SdkErrorCode.InvalidResult.
    expect((err as Error).message).toContain("Invalid result for tools/call");
    expect(p.size).toBe(1);
    await expect(p.callTool("c1", spec(), "add", {}, 5)).rejects.toThrow(/rejected the call to "add"/);
    expect(raw.state.launches).toBe(1);
    await p.closeAll();
  });

  it("writes a server's error as `MCP error <code>: <message>` in a rejected call", async () => {
    await expect(proxy.callTool("c1", spec(), "nope", {}, 5)).rejects.toThrow(
      new Error('MCP server "srv" rejected the call to "nope": MCP error -32603: no such tool nope'),
    );
  });

  it("closes the session and writes a server's error with its prefix when listing tools fails", async () => {
    const raw = rawUpstream((m) => (m.method === "tools/list" ? { error: { code: -32000, message: "no list" } } : undefined));
    const p = rawProxy(raw.connector);
    await expect(p.listTools("c1", spec())).rejects.toThrow(
      new Error('MCP server "srv" failed to list its tools: MCP error -32000: no list'),
    );
    expect(p.size).toBe(0);
  });

  it("asks a server that does not advertise tools for its tools, and writes nothing to stdout", async () => {
    const tool = { name: "t1", description: "one", inputSchema: { type: "object" } };
    const raw = rawUpstream((m) => (m.method === "tools/list" ? { result: { tools: [tool] } } : undefined), {});
    const p = rawProxy(raw.connector);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const dbg = vi.spyOn(console, "debug");
    try {
      const tools = await p.listTools("c1", spec());
      expect(tools).toEqual([{ name: "t1", description: "one", inputSchema: { type: "object" } }]);
      expect(out).not.toHaveBeenCalled();
      expect(dbg).not.toHaveBeenCalled();
    } finally {
      out.mockRestore();
      dbg.mockRestore();
    }
    await p.closeAll();
  });

  it("closes the session when a tools/list answer is malformed", async () => {
    const raw = rawUpstream((m) => (m.method === "tools/list" ? { result: { tools: "bad" } } : undefined));
    const p = rawProxy(raw.connector);
    await expect(p.listTools("c1", spec())).rejects.toThrow(/MCP server "srv" failed to list its tools/);
    expect(p.size).toBe(0);
  });

  describe("paging a tool list", () => {
    const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object" } });
    /** An upstream whose page `n` (cursor "p<n>", none for the first) holds `size(n)` tools and points on to `next(n)`. */
    const paging = (size: (n: number) => number, next: (n: number) => string | undefined) => {
      const cursors: Array<string | undefined> = [];
      const raw = rawUpstream((m) => {
        if (m.method !== "tools/list") return undefined;
        cursors.push(m.params?.cursor);
        const n = m.params?.cursor ? Number(m.params.cursor.slice(1)) : 0;
        const tools = Array.from({ length: size(n) }, (_, i) => tool(`t${n}-${i}`));
        const nextCursor = next(n);
        return { result: nextCursor ? { tools, nextCursor } : { tools } };
      });
      return { cursors, raw, proxy: rawProxy(raw.connector) };
    };

    it("follows nextCursor through every page, in order", async () => {
      const x = paging(() => 2, (n) => (n < 2 ? `p${n + 1}` : undefined));
      expect((await x.proxy.listTools("c1", spec())).map((t) => t.name)).toEqual([
        "t0-0", "t0-1", "t1-0", "t1-1", "t2-0", "t2-1",
      ]);
      expect(x.cursors).toEqual([undefined, "p1", "p2"]);
      await x.proxy.closeAll();
    });

    it("stops after 10 pages of a server that never stops giving a cursor, without an error or closing the session", async () => {
      const x = paging(() => 1, (n) => `p${n + 1}`);
      const tools = await x.proxy.listTools("c1", spec());
      expect(x.cursors).toHaveLength(10);
      expect(tools.map((t) => t.name)).toEqual(Array.from({ length: 10 }, (_, n) => `t${n}-0`));
      expect(x.proxy.size).toBe(1);
      await x.proxy.closeAll();
    });

    it("stops at the first page that brings the total to 500 or more, and does not ask again", async () => {
      const x = paging(() => 200, (n) => `p${n + 1}`);
      const tools = await x.proxy.listTools("c1", spec());
      expect(x.cursors).toEqual([undefined, "p1", "p2"]);
      expect(tools).toHaveLength(600);
      expect(x.proxy.size).toBe(1);
      await x.proxy.closeAll();
    });
  });
});

describe("validateEnv", () => {
  it("accepts identifier names with single-line string values", () => {
    expect(validateEnv({ API_KEY: "a b=c", _x1: "" })).toEqual({ API_KEY: "a b=c", _x1: "" });
  });
  it.each([
    [{ "BAD-NAME": "x" }, /Invalid environment variable name/],
    [{ "A=B": "x" }, /Invalid environment variable name/],
    [{ "": "x" }, /Invalid environment variable name/],
    [{ A: 1 }, /must be a string/],
    [{ A: "line1\nINJECTED=1" }, /line breaks/],
  ])("rejects %j", (env, message) => {
    expect(() => validateEnv(env as Record<string, unknown>)).toThrow(message);
  });
});

describe("dockerConnector", () => {
  it("passes the environment through a private env file, never through argv", () => {
    const conn = dockerConnector(cfg)({
      container: "mcpe-x",
      sandbox: refOf("mcpe-x"),
      server: spec({ argv: ["node", "server.js", "--stdio"], env: { API_KEY: "s3cret" } }),
      pidFile: "/tmp/p.pid",
    });
    const params = (conn.transport as unknown as { _serverParams: { command: string; args: string[] } })._serverParams;
    expect(params.command).toBe("docker");
    expect(params.args.join(" ")).not.toContain("s3cret");
    const envFile = params.args[params.args.indexOf("--env-file") + 1]!;
    expect(fs.readFileSync(envFile, "utf8")).toBe("API_KEY=s3cret\n");
    expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
    // docker exec -i -w <cwd> --env-file <f> <container> sh -c <script> <pidfile> <argv...>
    expect(params.args.slice(0, 4)).toEqual(["exec", "-i", "-w", "/workspace/repo"]);
    // The container is named by its id, and its name appears nowhere on the command line.
    const id = fakeSandboxId("mcpe-x");
    expect(params.args).not.toContain("mcpe-x");
    expect(params.args.join(" ")).not.toContain("mcpe-x");
    expect(params.args.slice(params.args.indexOf(id))).toEqual([
      id, "sh", "-c", expect.stringContaining('exec "$@"'), "/tmp/p.pid", "node", "server.js", "--stdio",
    ]);
    conn.cleanup?.();
    expect(fs.existsSync(envFile)).toBe(false);
  });

  it("keeps the env file directory private and the value out of the docker client's own environment", () => {
    const name = "MCPE_TEST_HANDOFF_VAR";
    expect(process.env[name]).toBeUndefined();
    const conn = dockerConnector(cfg)({
      container: "mcpe-x",
      sandbox: refOf("mcpe-x"),
      server: spec({ env: { [name]: "handoff-value-1" } }),
      pidFile: "/tmp/p.pid",
    });
    const params = (conn.transport as unknown as { _serverParams: { env: Record<string, string> } })._serverParams;
    expect(fs.statSync(path.join(dir, "tmp")).mode & 0o777).toBe(0o700);
    expect(Object.keys(params.env)).not.toContain(name);
    expect(Object.values(params.env)).not.toContain("handoff-value-1");
    conn.cleanup?.();
  });

  it("throws on a value the env file cannot carry and leaves no file behind", () => {
    expect(() =>
      dockerConnector(cfg)({ container: "mcpe-x", sandbox: refOf("mcpe-x"), server: spec({ env: { A: "one\nB=injected" } }), pidFile: "/tmp/p.pid" }),
    ).toThrow(/line breaks/);
    expect(fs.readdirSync(path.join(dir, "tmp"))).toEqual([]);
  });

  it("removes the env file and rethrows when the connector throws after writing it", () => {
    // argv is spread after the file is written; a non-iterable one makes that throw.
    const bad = spec({ env: { API_KEY: "s3cret" } });
    (bad as unknown as { argv: unknown }).argv = undefined;
    expect(() => dockerConnector(cfg)({ container: "mcpe-x", sandbox: refOf("mcpe-x"), server: bad, pidFile: "/tmp/p.pid" })).toThrow(TypeError);
    expect(fs.readdirSync(path.join(dir, "tmp"))).toEqual([]);
  });

  it("removes a partially written env file when the write itself throws", () => {
    const real = fs.writeFileSync;
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, data: unknown, opts: unknown) => {
      real(file, "API_", opts as fs.WriteFileOptions);
      throw new Error("ENOSPC: no space left on device");
    }) as typeof fs.writeFileSync);
    try {
      expect(() =>
        dockerConnector(cfg)({ container: "mcpe-x", sandbox: refOf("mcpe-x"), server: spec({ env: { API_KEY: "s3cret" } }), pidFile: "/tmp/p.pid" }),
      ).toThrow(/ENOSPC/);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readdirSync(path.join(dir, "tmp"))).toEqual([]);
  });

  it("adds -e flags for the sandbox's own environment after --env-file and before the container id", () => {
    const sandbox = { ...refOf("mcpe-x"), env: { HTTP_PROXY: "http://172.30.1.254:3128", NO_PROXY: "" } };
    const conn = dockerConnector(cfg)({
      container: "mcpe-x",
      sandbox,
      server: spec({ env: { API_KEY: "s3cret" } }),
      pidFile: "/tmp/p.pid",
    });
    const args = (conn.transport as unknown as { _serverParams: { args: string[] } })._serverParams.args;
    const id = fakeSandboxId("mcpe-x");
    // Docker gives -e precedence over --env-file whatever the order; the order is pinned only as documentation.
    expect(args.indexOf("--env-file")).toBeGreaterThan(-1);
    expect(args.indexOf("--env-file")).toBeLessThan(args.indexOf("-e"));
    expect(args.slice(args.indexOf("-e"), args.indexOf(id))).toEqual(["-e", "HTTP_PROXY=http://172.30.1.254:3128", "-e", "NO_PROXY="]);
    expect(args.join(" ")).not.toContain("s3cret");
    conn.cleanup?.();
  });

  it("adds no -e flag when the sandbox carries no environment", () => {
    const conn = dockerConnector(cfg)({ container: "mcpe-x", sandbox: refOf("mcpe-x"), server: spec(), pidFile: "/tmp/p.pid" });
    expect((conn.transport as unknown as { _serverParams: { args: string[] } })._serverParams.args).not.toContain("-e");
  });

  it("throws on a sandbox variable Docker could not carry, and leaves no env file behind", () => {
    const sandbox = { ...refOf("mcpe-x"), env: { "BAD-NAME": "x" } };
    expect(() => dockerConnector(cfg)({ container: "mcpe-x", sandbox, server: spec({ env: { API_KEY: "s3cret" } }), pidFile: "/tmp/p.pid" })).toThrow(/environment variable/i);
    expect(fs.readdirSync(path.join(dir, "tmp"))).toEqual([]);
  });

  it("creates no env file when there is no environment", () => {
    const conn = dockerConnector(cfg)({ container: "mcpe-x", sandbox: refOf("mcpe-x"), server: spec(), pidFile: "/tmp/p.pid" });
    const params = (conn.transport as unknown as { _serverParams: { args: string[] } })._serverParams;
    expect(params.args).not.toContain("--env-file");
    expect(fs.existsSync(path.join(dir, "tmp"))).toBe(false);
  });
});

describe("a real env file taken through McpProxy", () => {
  const tmpDir = () => path.join(dir, "tmp");
  const withEnv = () => spec({ env: { API_KEY: "s3cret" } });
  /** The real connector for the env file and its cleanup, the in-memory upstream for the conversation. */
  const hybrid = (seen: Array<{ exists: boolean; mode: number }>, onFile?: (file: string) => void) => (launch: Parameters<typeof up.connector>[0]) => {
    const real = dockerConnector(cfg)(launch);
    const file = (real.transport as unknown as { _serverParams: { args: string[] } })._serverParams.args;
    const envFile = file[file.indexOf("--env-file") + 1]!;
    const fake = up.connector(launch);
    const look = () => {
      const exists = fs.existsSync(envFile);
      seen.push({ exists, mode: exists ? fs.statSync(envFile).mode & 0o777 : 0 });
    };
    const upstream = up.servers[up.servers.length - 1];
    if (upstream) upstream.oninitialized = look;
    else look();
    onFile?.(envFile);
    return { transport: fake.transport, stderr: fake.stderr, cleanup: real.cleanup };
  };

  it("exists with mode 0600 while the handshake runs and is gone after a launch that succeeds", async () => {
    const seen: Array<{ exists: boolean; mode: number }> = [];
    proxy = new McpProxy(cfg, docker, hybrid(seen));
    await proxy.listTools("c1", withEnv(), 5);
    expect(seen).toEqual([{ exists: true, mode: 0o600 }]);
    expect(fs.readdirSync(tmpDir())).toEqual([]);
  });

  it("exists with mode 0600 when the connector returns and is gone after a launch that fails", async () => {
    const seen: Array<{ exists: boolean; mode: number }> = [];
    up.answer = false;
    docker.stateResult = "running";
    proxy = new McpProxy(cfg, docker, hybrid(seen));
    await expect(proxy.listTools("c1", withEnv(), 0.05)).rejects.toThrow(/did not start/);
    expect(seen).toEqual([{ exists: true, mode: 0o600 }]);
    expect(fs.readdirSync(tmpDir())).toEqual([]);
  });
});

describe("sweepEnvFiles", () => {
  const NOW = 1_800_000_000_000;
  const HOUR = 3600;
  const tmpDir = () => path.join(dir, "tmp");
  const HEX = "0123456789abcdef";
  /** Writes a file under tmp whose modification time is `ageSec` before NOW. */
  const put = (name: string, ageSec: number, body = "API_KEY=s3cret\n") => {
    fs.mkdirSync(tmpDir(), { recursive: true, mode: 0o700 });
    const file = path.join(tmpDir(), name);
    fs.writeFileSync(file, body);
    const t = NOW / 1000 - ageSec;
    fs.utimesSync(file, t, t);
    return file;
  };
  afterEach(() => vi.restoreAllMocks());

  it("removes a matching file older than the bound and counts it", () => {
    const old = put(`env-${HEX}`, HOUR + 1);
    const log: string[] = [];
    expect(sweepEnvFiles(cfg, NOW, (l) => log.push(l))).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(log).toEqual([]);
  });

  it("leaves a matching file at or under the bound", () => {
    const atBound = put(`env-${HEX}`, HOUR);
    const fresh = put("env-fedcba9876543210", 5);
    expect(sweepEnvFiles(cfg, NOW)).toBe(0);
    expect(fs.existsSync(atBound)).toBe(true);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("scales the bound with a long startup timeout", () => {
    const slow = loadConfig({ HOME: dir, MCPE_DATA_DIR: dir, MCPE_MCP_STARTUP_TIMEOUT: "3600" });
    const young = put(`env-${HEX}`, 7200);
    const old = put("env-fedcba9876543210", 7201);
    expect(sweepEnvFiles(slow, NOW)).toBe(1);
    expect(fs.existsSync(young)).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
  });

  it.each([
    ["15 hex digits", "env-0123456789abcde"],
    ["17 hex digits", "env-0123456789abcdef0"],
    ["uppercase hex", "env-0123456789ABCDEF"],
    ["a suffix", "env-0123456789abcdef.bak"],
    ["a prefix", "x-env-0123456789abcdef"],
    ["a non-hex digit", "env-0123456789abcdeg"],
  ])("leaves a file whose name has %s", (_why, name) => {
    const file = put(name, 10 * HOUR);
    expect(sweepEnvFiles(cfg, NOW)).toBe(0);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("leaves a directory and a symbolic link with a matching name, and the link's target", () => {
    fs.mkdirSync(tmpDir(), { recursive: true, mode: 0o700 });
    const old = NOW / 1000 - 10 * HOUR;
    const sub = path.join(tmpDir(), `env-${HEX}`);
    fs.mkdirSync(sub);
    fs.utimesSync(sub, old, old);
    const target = path.join(dir, "elsewhere");
    fs.writeFileSync(target, "keep");
    fs.utimesSync(target, old, old);
    const link = path.join(tmpDir(), "env-fedcba9876543210");
    fs.symlinkSync(target, link);
    const log: string[] = [];
    expect(sweepEnvFiles(cfg, NOW, (l) => log.push(l))).toBe(0);
    // Skipped, not attempted: unlink on the directory would fail and be logged.
    expect(log).toEqual([]);
    expect(fs.statSync(sub).isDirectory()).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("keep");
  });

  it("touches nothing outside tmp", () => {
    const outside = path.join(dir, `env-${HEX}`);
    fs.writeFileSync(outside, "x");
    const old = NOW / 1000 - 10 * HOUR;
    fs.utimesSync(outside, old, old);
    put("unrelated", 10 * HOUR);
    expect(sweepEnvFiles(cfg, NOW)).toBe(0);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("does not create tmp when it is missing, and does not throw", () => {
    expect(sweepEnvFiles(cfg, NOW)).toBe(0);
    expect(fs.existsSync(tmpDir())).toBe(false);
  });

  it("logs the directory and returns 0 when it cannot be listed", () => {
    fs.writeFileSync(tmpDir(), "not a directory");
    const log: string[] = [];
    expect(sweepEnvFiles(cfg, NOW, (l) => log.push(l))).toBe(0);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain(tmpDir());
  });

  it("logs a failure by file name and still examines the rest", () => {
    const first = put(`env-${HEX}`, 2 * HOUR);
    const second = put("env-fedcba9876543210", 2 * HOUR);
    const real = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation((p) => {
      if (p === first) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return real(p);
    });
    const log: string[] = [];
    expect(sweepEnvFiles(cfg, NOW, (l) => log.push(l))).toBe(1);
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(false);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain(path.basename(first));
  });

  it("ignores a file that has gone, and never reads or logs contents", () => {
    const gone = put(`env-${HEX}`, 2 * HOUR, "API_KEY=do-not-log\n");
    const other = put("env-fedcba9876543210", 2 * HOUR, "API_KEY=do-not-log\n");
    const real = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation((p) => {
      if (p === gone) {
        real(p);
        throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      }
      return real(p);
    });
    const reads = vi.spyOn(fs, "readFileSync");
    const log: string[] = [];
    expect(sweepEnvFiles(cfg, NOW, (l) => log.push(l))).toBe(1);
    expect(fs.existsSync(other)).toBe(false);
    expect(reads).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });
});

describe("McpProxy start-up after an idle stop", () => {
  let cleanups: number[];
  /** The fake connector, with a cleanup spy on every connection (index = launch order). */
  const spied = () => {
    cleanups = [];
    return (launch: Parameters<typeof up.connector>[0]) => {
      const i = cleanups.push(0) - 1;
      const conn = up.connector(launch);
      return { ...conn, cleanup: () => void cleanups[i]!++ };
    };
  };
  const failFirst = () => {
    up.answerIf = (l) => l !== up.launches[0];
    docker.stateResult = "stopped";
    proxy = new McpProxy(cfg, docker, spied());
  };

  it("restarts a stopped sandbox and launches once more with a fresh launch", async () => {
    failFirst();
    await proxy.listTools("c1", spec(), 0.05);
    expect(docker.ensureCalls).toEqual(["c1", "c1"]);
    expect(up.launches).toHaveLength(2);
    expect(up.launches[1]!.pidFile).not.toBe(up.launches[0]!.pidFile);
    expect(cleanups).toEqual([1, 1]);
    expect(kills()).toEqual([up.launches[0]!.pidFile]);
    await proxy.closeAll();
    // The session holds the second launch.
    expect(kills()).toEqual([up.launches[0]!.pidFile, up.launches[1]!.pidFile]);
  });

  it.each(["running", "missing"] as const)("does not relaunch when the sandbox is %s", async (state) => {
    up.answer = false;
    docker.stateResult = state;
    proxy = new McpProxy(cfg, docker, spied());
    await expect(proxy.listTools("c1", spec(), 0.05)).rejects.toThrow(/did not start: no MCP handshake within 0\.05s/);
    expect(up.launches).toHaveLength(1);
    expect(docker.ensureCalls).toEqual(["c1"]);
    expect(cleanups).toEqual([1]);
  });

  it("does not relaunch when Docker.state rejects", async () => {
    up.answer = false;
    docker.state = async () => {
      throw new Error("daemon down");
    };
    await expect(proxy.listTools("c1", spec(), 0.05)).rejects.toThrow(/did not start: no MCP handshake/);
    expect(up.launches).toHaveLength(1);
  });

  it("does not relaunch when the restart reports the sandbox gone", async () => {
    up.answer = false;
    docker.stateResult = "stopped";
    // The first ensureRunning of the session is the restart: open's own check is `acquire`.
    docker.ensureRunning = async () => false;
    await expect(proxy.listTools("c1", spec(), 0.05)).rejects.toThrow(/did not start: no MCP handshake/);
    expect(up.launches).toHaveLength(1);
  });

  it("does not relaunch when the restart throws, and mentions why", async () => {
    up.answer = false;
    docker.stateResult = "stopped";
    docker.ensureRunning = async () => {
      throw new Error("Failed to start sandbox c1: boom");
    };
    await expect(proxy.listTools("c1", spec(), 0.05)).rejects.toThrow(/did not start[^]*Failed to start sandbox c1: boom/);
    expect(up.launches).toHaveLength(1);
  });

  it("gives up after one relaunch", async () => {
    up.answer = false;
    docker.stateResult = "stopped";
    proxy = new McpProxy(cfg, docker, spied());
    const failure = proxy.listTools("c1", spec(), 0.05);
    await expect(failure).rejects.toThrow(/did not start/);
    await expect(failure).rejects.toThrow(
      /MCP server "srv" \(srv\) did not start \(after restarting the sandbox\): no MCP handshake within 0\.05s/,
    );
    expect(up.launches).toHaveLength(2);
    expect(cleanups).toEqual([1, 1]);
  });

  it("propagates a connector that throws, without asking for the state", async () => {
    let asked = 0;
    docker.state = async () => (asked++, "stopped");
    proxy = new McpProxy(cfg, docker, () => {
      throw new Error("spawn failed");
    });
    await expect(proxy.listTools("c1", spec(), 0.05)).rejects.toThrow("spawn failed");
    expect(asked).toBe(0);
  });

  it("kills without restarting a stopped sandbox", async () => {
    await proxy.listTools("c1", spec());
    await proxy.closeAll();
    expect(docker.calls.filter((c) => c.argv[0] === "sh").map((c) => c.opts.restart)).toEqual([false]);
  });
});

describe("host variables and the real docker connector", () => {
  it("hands a variable of the launch spec to docker through the env file only, never on a command line", async () => {
    const { Installer } = await import("../src/install/installer.js");
    const { Registry } = await import("../src/registry.js");
    const { record } = await import("./helpers.js");
    const registry = new Registry(dir);
    const project = record("demo");
    const installer = new Installer(cfg, docker, registry, proxy, undefined, { demo__API_KEY: SECRET_VALUE });
    const launch = installer.launchSpec(project, spec({ argv: ["node", "server.js"] }));
    const conn = dockerConnector(cfg)({ container: "mcpe-demo", sandbox: refOf("mcpe-demo"), server: launch, pidFile: "/tmp/p.pid" });
    const params = (conn.transport as unknown as { _serverParams: { args: string[] } })._serverParams;
    expect(params.args.join(" ")).not.toContain(SECRET_VALUE);
    const envFile = params.args[params.args.indexOf("--env-file") + 1]!;
    expect(fs.readFileSync(envFile, "utf8")).toBe(`API_KEY=${SECRET_VALUE}\n`);
    conn.cleanup?.();
    expect(fs.existsSync(envFile)).toBe(false);
  });
});

describe("McpProxy and the checked reference", () => {
  const refusal = () =>
    new SandboxRefusedError([{ kind: "container", sandbox: "c1", cls: "another", owner: "ffff0000", project: "github:o/r" }], "0123abcd");
  const unavailable = () => new DockerUnavailableError("Docker could not be asked: down");

  it("carries the reference with the launch, beside the container's name, and keys the session by the name", async () => {
    await proxy.listTools("c1", spec());
    expect(docker.acquired).toHaveLength(1);
    expect(up.launches[0]!.container).toBe("c1");
    expect(up.launches[0]!.sandbox).toBe(docker.acquired[0]);
    expect(up.launches[0]!.sandbox.id).toBe(fakeSandboxId("c1"));
    await proxy.closeProject("c1"); // by name
    expect(proxy.size).toBe(0);
  });

  it("runs the kill on the launch's reference, without restarting, whichever way the session ends", async () => {
    await proxy.listTools("c1", spec());
    await proxy.closeAll();
    const kill = docker.calls.filter((c) => c.argv[0] === "sh");
    expect(kill).toHaveLength(1);
    expect(kill[0]!.sandbox).toBe(up.launches[0]!.sandbox);
    expect(kill[0]!.opts).toMatchObject({ restart: false });
    // Opening acquired once; the kill did not acquire or resolve the name again.
    expect(docker.ensureCalls).toEqual(["c1"]);
  });

  it("swallows a failing kill", async () => {
    await proxy.listTools("c1", spec());
    docker.exec = async () => {
      throw new DockerUnavailableError("Docker could not be asked: down");
    };
    await expect(proxy.closeAll()).resolves.toBeUndefined();
    expect(proxy.size).toBe(0);
  });

  it.each([
    ["a refusal", refusal],
    ["a Docker that could not be asked", unavailable],
  ])("rejects the open with the typed error on %s, leaves no session, and tries again next time", async (_n, make) => {
    const error = make();
    docker.acquireError = error;
    await expect(proxy.listTools("c1", spec())).rejects.toBe(error);
    await expect(proxy.callTool("c1", spec(), "add", { a: 1, b: 1 }, 5)).rejects.toBe(error);
    expect(proxy.size).toBe(0);
    expect(up.launches).toHaveLength(0);
    expect(docker.calls).toEqual([]);
    expect(docker.ensureCalls).toEqual(["c1", "c1"]); // asked again, not remembered
    docker.acquireError = undefined;
    expect(textOf(await proxy.callTool("c1", spec(), "add", { a: 1, b: 1 }, 5))).toBe("2");
    expect(proxy.size).toBe(1);
  });

  it("gives a sandbox that is not there the message it gave, with no session left", async () => {
    docker.exists = false;
    await expect(proxy.listTools("c1", spec())).rejects.toThrow("The sandbox c1 no longer exists; reinstall the project.");
    expect(proxy.size).toBe(0);
  });

  it("restarts a stopped sandbox and makes the second attempt on the reference it opened with", async () => {
    up.answerIf = (l) => l !== up.launches[0];
    docker.stateResult = "stopped";
    const state = vi.spyOn(docker, "state");
    const ensure = vi.spyOn(docker, "ensureRunning");
    await proxy.listTools("c1", spec(), 0.05);
    expect(docker.acquired).toHaveLength(1); // one check; the restart did not resolve the name again
    expect((state.mock.calls as unknown[][]).map((c) => c[0])).toEqual([docker.acquired[0]]);
    expect((ensure.mock.calls as unknown[][]).map((c) => c[0])).toEqual([docker.acquired[0]]);
    expect(up.launches).toHaveLength(2);
    expect(up.launches[0]!.sandbox).toBe(docker.acquired[0]);
    expect(up.launches[1]!.sandbox).toBe(docker.acquired[0]);
    // The failed first attempt was killed on that reference too.
    expect(docker.calls.filter((c) => c.argv[0] === "sh").map((c) => c.sandbox)).toEqual([docker.acquired[0]]);
  });

  it("drops a session whose container was replaced under its name, and opens a new one on the new container", async () => {
    await proxy.listTools("c1", spec());
    const old = up.launches[0]!.sandbox;
    // Another session reinstalled the project: the old container's server dies while a call is in flight.
    const pending = proxy.callTool("c1", spec(), "hang", {}, 5);
    await new Promise((r) => setTimeout(r, 10));
    await up.servers[0]!.close();
    await expect(pending).rejects.toThrow(/stopped while running "hang"/);
    expect(proxy.size).toBe(0);

    const replacement = Object.freeze({ id: "9".repeat(64), name: "c1" });
    docker.acquire = async () => replacement;
    expect(textOf(await proxy.callTool("c1", spec(), "add", { a: 1, b: 1 }, 5))).toBe("2");
    expect(up.launches).toHaveLength(2);
    expect(up.launches[1]!.sandbox).toBe(replacement);
    expect(up.launches[1]!.sandbox.id).not.toBe(old.id);
    expect(proxy.size).toBe(1);
  });
});
