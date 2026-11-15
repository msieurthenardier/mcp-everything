import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { dockerConnector, McpProxy, validateEnv } from "../src/proxy/mcp-proxy.js";
import type { McpServerSpec } from "../src/types.js";
import { FakeDocker, fakeUpstream, type FakeUpstream } from "./helpers.js";

const spec = (over: Partial<McpServerSpec> = {}): McpServerSpec => ({
  name: "srv",
  argv: ["srv"],
  cwd: "/workspace/repo",
  env: {},
  origin: "registered",
  ...over,
});
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
    expect(params.args.slice(params.args.indexOf("mcpe-x"))).toEqual([
      "mcpe-x", "sh", "-c", expect.stringContaining('exec "$@"'), "/tmp/p.pid", "node", "server.js", "--stdio",
    ]);
    conn.cleanup?.();
    expect(fs.existsSync(envFile)).toBe(false);
  });

  it("creates no env file when there is no environment", () => {
    const conn = dockerConnector(cfg)({ container: "mcpe-x", server: spec(), pidFile: "/tmp/p.pid" });
    const params = (conn.transport as unknown as { _serverParams: { args: string[] } })._serverParams;
    expect(params.args).not.toContain("--env-file");
    expect(fs.existsSync(path.join(dir, "tmp"))).toBe(false);
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
    const original = docker.ensureRunning.bind(docker);
    let n = 0;
    docker.ensureRunning = async (c: string) => ((n++ === 0 ? await original(c) : false));
    await expect(proxy.listTools("c1", spec(), 0.05)).rejects.toThrow(/did not start: no MCP handshake/);
    expect(up.launches).toHaveLength(1);
  });

  it("does not relaunch when the restart throws, and mentions why", async () => {
    up.answer = false;
    docker.stateResult = "stopped";
    let n = 0;
    docker.ensureRunning = async () => {
      if (n++ > 0) throw new Error("Failed to start sandbox c1: boom");
      return true;
    };
    await expect(proxy.listTools("c1", spec(), 0.05)).rejects.toThrow(/did not start[^]*Failed to start sandbox c1: boom/);
    expect(up.launches).toHaveLength(1);
  });

  it("gives up after one relaunch", async () => {
    up.answer = false;
    docker.stateResult = "stopped";
    proxy = new McpProxy(cfg, docker, spied());
    await expect(proxy.listTools("c1", spec(), 0.05)).rejects.toThrow(/did not start/);
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
