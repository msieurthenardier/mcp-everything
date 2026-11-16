import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { dockerConnector, McpProxy, sweepEnvFiles, validateEnv } from "../src/proxy/mcp-proxy.js";
import type { McpServerSpec } from "../src/types.js";
import { FakeDocker, fakeUpstream, SECRET_VALUE, type FakeUpstream } from "./helpers.js";

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

  it("keeps the env file directory private and the value out of the docker client's own environment", () => {
    const name = "MCPE_TEST_HANDOFF_VAR";
    expect(process.env[name]).toBeUndefined();
    const conn = dockerConnector(cfg)({
      container: "mcpe-x",
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
      dockerConnector(cfg)({ container: "mcpe-x", server: spec({ env: { A: "one\nB=injected" } }), pidFile: "/tmp/p.pid" }),
    ).toThrow(/line breaks/);
    expect(fs.readdirSync(path.join(dir, "tmp"))).toEqual([]);
  });

  it("creates no env file when there is no environment", () => {
    const conn = dockerConnector(cfg)({ container: "mcpe-x", server: spec(), pidFile: "/tmp/p.pid" });
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
    expect(sweepEnvFiles(cfg, NOW)).toBe(0);
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
    const conn = dockerConnector(cfg)({ container: "mcpe-demo", server: launch, pidFile: "/tmp/p.pid" });
    const params = (conn.transport as unknown as { _serverParams: { args: string[] } })._serverParams;
    expect(params.args.join(" ")).not.toContain(SECRET_VALUE);
    const envFile = params.args[params.args.indexOf("--env-file") + 1]!;
    expect(fs.readFileSync(envFile, "utf8")).toBe(`API_KEY=${SECRET_VALUE}\n`);
    conn.cleanup?.();
    expect(fs.existsSync(envFile)).toBe(false);
  });
});
