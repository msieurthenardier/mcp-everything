import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { DockerUnavailableError, OWNER_SHOWN, parseProbeOutput, SandboxRefusedError } from "../src/sandbox/docker.js";
import { Registry } from "../src/registry.js";
import { App } from "../src/server.js";
import { serveApp } from "../src/entry.js";
import type { ProjectRecord, ToolDef } from "../src/types.js";
import { McpProxy } from "../src/proxy/mcp-proxy.js";
import type { Connector } from "../src/proxy/mcp-proxy.js";
import { FakeDocker, fakeSandboxId, fakeUpstream, record, SECRET_VALUE, type FakeUpstream } from "./helpers.js";

const tool: ToolDef = {
  name: "demo__demo_build",
  description: "[sandboxed github:owner/demo] Runs `demo build`.",
  inputSchema: { type: "object", properties: { release: { type: "boolean" } } },
  kind: "cli",
  argv: ["demo", "build"],
  options: [{ prop: "release", flag: "--release", takesValue: false, description: "" }],
  cwd: "/workspace/work",
};

let dir: string;
let docker: FakeDocker;
let up: FakeUpstream;
let app: App;

function seed(...records: ProjectRecord[]): void {
  for (const r of records) app.registry.put(r);
}
const body = (res: Awaited<ReturnType<App["callTool"]>>) => (res.content[0] as { text: string }).text;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-srv-"));
  const cfg = loadConfig({ HOME: dir, MCPE_DATA_DIR: dir, MCPE_MCP_STARTUP_TIMEOUT: "1" });
  docker = new FakeDocker(cfg);
  up = fakeUpstream();
  app = new App({ cfg, docker, proxy: new McpProxy(cfg, docker, up.connector) });
  seed({ ...record("demo"), tools: [tool], commands: [{ name: "demo", origin: "test" }] });
});
afterEach(async () => {
  await app.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("tool lookup", () => {
  it("finds and calls a tool of a project whose slug contains a double underscore", async () => {
    seed({ ...record("abc__def"), tools: [{ ...tool, name: "abc__def__build", argv: ["abc", "build"] }] });
    expect(body(await app.callTool("abc__def__build", {}))).not.toMatch(/Unknown tool/);
    expect(body(await app.callTool("call_project_tool", { tool: "abc__def__build", arguments: {} }))).not.toMatch(/Unknown tool/);
    expect(docker.calls.filter((c) => c.argv[0] === "abc")).toHaveLength(2);
  });
  it("resolves a tool whose name begins with another project's slug to the project that has it", async () => {
    seed({ ...record("abc"), tools: [{ ...tool, name: "abc__def__x", argv: ["abc-x"] }] });
    seed({ ...record("abc__def"), tools: [{ ...tool, name: "abc__def__build", argv: ["abc-def-build"] }] });
    expect(body(await app.callTool("abc__def__x", {}))).not.toMatch(/Unknown tool/);
    expect(body(await app.callTool("abc__def__build", {}))).not.toMatch(/Unknown tool/);
    expect(docker.calls.map((c) => [c.container, c.argv[0]])).toEqual([
      ["mcpe-abc", "abc-x"],
      ["mcpe-abc__def", "abc-def-build"],
    ]);
  });
});

describe("tool listing", () => {
  it("lists built-in tools plus generated tools of ready projects only", () => {
    seed({ ...record("broken"), status: "failed", tools: [{ ...tool, name: "broken__x" }] });
    const names = app.listTools().map((t) => t.name as string);
    expect(names).toContain("search_projects");
    expect(names).toContain("install_project");
    expect(names).toContain("demo__demo_build");
    expect(names).not.toContain("broken__x");
    for (const n of names) expect(n).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});

describe("generated tools", () => {
  it("run in the project's container with the built argv", async () => {
    docker.next = { stdout: "built\n" };
    const res = await app.callTool("demo__demo_build", { release: true, args: ["x"] });
    expect(res.isError).toBe(false);
    expect(body(res)).toBe("exit code: 0\n--- stdout ---\nbuilt");
    expect(docker.calls[0]).toMatchObject({
      container: "mcpe-demo",
      argv: ["demo", "build", "--release", "x"],
      opts: { cwd: "/workspace/work", timeoutSec: 120 },
    });
  });

  it("report non-zero exits, stderr, truncation and timeouts as errors", async () => {
    docker.next = { code: 2, stderr: "\u001b[31mboom\u001b[0m\n", truncated: true };
    const failed = await app.callTool("demo__demo_build", {});
    expect(failed.isError).toBe(true);
    expect(body(failed)).toBe("exit code: 2\n--- stderr ---\nboom\n[output truncated at 100000 bytes per stream]");

    docker.next = { code: 124, timedOut: true };
    const slow = await app.callTool("demo__demo_build", { timeout_seconds: 3 });
    expect(slow.isError).toBe(true);
    expect(body(slow)).toMatch(/^Timed out after 3s/);
    expect(docker.calls[1]!.opts.timeoutSec).toBe(3);
  });

  it("reject bad input before touching the sandbox", async () => {
    const res = await app.callTool("demo__demo_build", { nope: true });
    expect(res.isError).toBe(true);
    expect(body(res)).toMatch(/Unknown argument\(s\): nope/);
    expect(docker.calls).toEqual([]);
  });

  it("explain how to recover when the sandbox container is gone", async () => {
    docker.exists = false;
    const res = await app.callTool("demo__demo_build", {});
    expect(body(res)).toMatch(/no longer exists.*install_project\(repo: "github:owner\/demo", reinstall: true\)/);
  });

  it("are unreachable for unknown names and for projects that are not ready", async () => {
    expect(body(await app.callTool("demo__missing", {}))).toMatch(/Unknown tool "demo__missing"\. Tools of demo: demo__demo_build/);
    expect(body(await app.callTool("ghost__x", {}))).toMatch(/Unknown tool "ghost__x"\. Use list_projects/);
    seed({ ...record("demo"), status: "failed", tools: [tool] });
    expect(body(await app.callTool("demo__demo_build", {}))).toMatch(/not ready \(status: failed\)/);
  });

  it("can be invoked through call_project_tool, which refuses built-in names", async () => {
    await app.callTool("call_project_tool", { tool: "demo__demo_build", arguments: { release: true } });
    expect(docker.calls[0]!.argv).toEqual(["demo", "build", "--release"]);
    const res = await app.callTool("call_project_tool", { tool: "uninstall_project", arguments: { project: "demo" } });
    expect(res.isError).toBe(true);
    expect(docker.destroyed).toEqual([]);
  });
});

describe("built-in tools", () => {
  it("sandbox_exec passes the command as one argv element to sh -c", async () => {
    await app.callTool("sandbox_exec", { project: "github:owner/demo", command: "ls; echo $HOME", cwd: "/workspace/repo/src" });
    expect(docker.calls[0]).toMatchObject({ argv: ["sh", "-c", "ls; echo $HOME"], opts: { cwd: "/workspace/repo/src" } });
    const outside = await app.callTool("sandbox_exec", { project: "demo", command: "ls", cwd: "/" });
    expect(body(outside)).toMatch(/inside \/workspace/);
  });

  it("sandbox_write_file sends content on stdin and the path as an argument", async () => {
    const res = await app.callTool("sandbox_write_file", { project: "demo", path: "in/a b$(x).txt", content: "héllo" });
    expect(body(res)).toBe("Wrote 6 bytes to /workspace/work/in/a b$(x).txt");
    const call = docker.calls[0]!;
    expect(call.opts.stdin).toBe("héllo");
    expect(call.argv.slice(-1)).toEqual(["/workspace/work/in/a b$(x).txt"]);
    expect(call.argv[2]).not.toContain("a b");
  });

  it("sandbox_read_file reads with a byte cap and reports failures", async () => {
    docker.next = { stdout: "contents" };
    expect(body(await app.callTool("sandbox_read_file", { project: "demo", path: "/workspace/repo/README.md", max_bytes: 10 }))).toBe("contents");
    expect(docker.calls[0]!.argv).toEqual(["head", "-c", "10", "--", "/workspace/repo/README.md"]);
    docker.next = { code: 1, stderr: "head: cannot open\n" };
    const missing = await app.callTool("sandbox_read_file", { project: "demo", path: "nope" });
    expect(missing.isError).toBe(true);
    expect(body(missing)).toMatch(/Could not read \/workspace\/work\/nope: head: cannot open/);
  });

  it("set_project_network toggles the container and records the state", async () => {
    const res = await app.callTool("set_project_network", { project: "demo", enabled: true });
    expect(body(res)).toMatch(/now ON/);
    expect(docker.network).toEqual([["mcpe-demo", true]]);
    expect(app.registry.get("demo")!.network).toBe(true);
    expect((await app.callTool("set_project_network", { project: "demo" })).isError).toBe(true);
  });

  it("list_projects and project_info describe what is installed", async () => {
    expect(body(await app.callTool("list_projects", {}))).toMatch(/^Installation id: 0123abcd\n\ndemo — github:owner\/demo \(ready\)[\s\S]*tools: 1 published$/);
    const info = body(await app.callTool("project_info", { project: "owner/demo" }));
    expect(info).toContain("demo__demo_build: [sandboxed github:owner/demo] Runs `demo build`.");
    expect(info).toContain("arguments: release");
  });

  it("states the installation id first, with projects and without, and says so in the tool's description", async () => {
    expect(body(await app.callTool("list_projects", {})).split("\n").slice(0, 2)).toEqual(["Installation id: 0123abcd", ""]);
    app.registry.delete("demo");
    expect(body(await app.callTool("list_projects", {}))).toBe(
      "Installation id: 0123abcd\n\nNo projects installed. Use search_projects and install_project.",
    );
    expect(app.listTools().find((t) => t.name === "list_projects")!.description).toMatch(/installation's id/);
  });

  it("still reports an unreadable registry from list_projects as its own error", async () => {
    fs.writeFileSync(path.join(dir, "registry.json"), "{ not json");
    const res = await app.callTool("list_projects", {});
    expect(res.isError).toBe(true);
    expect(body(res)).toMatch(/unreadable/);
    expect(body(res)).not.toMatch(/Installation id/);
  });

  it("shows the sandbox's name in the full description only", async () => {
    expect(body(await app.callTool("project_info", { project: "demo" }))).toContain("  sandbox: mcpe-demo\n");
    expect(body(await app.callTool("list_projects", {}))).not.toContain("sandbox:");
  });

  it("uninstall_project removes the volume the record names, which can differ from the container's name", async () => {
    seed({ ...record("split"), volume: "mcpe-split-data" });
    await app.callTool("uninstall_project", { project: "split" });
    expect(docker.destroyed).toEqual(["mcpe-split"]);
    expect(docker.destroyedVolumes).toEqual(["mcpe-split-data"]);
  });

  it("uninstall_project destroys the sandbox and forgets the project", async () => {
    await app.callTool("uninstall_project", { project: "demo" });
    expect(docker.destroyed).toEqual(["mcpe-demo"]);
    expect(app.registry.list()).toEqual([]);
    expect(app.listTools().map((t) => t.name)).not.toContain("demo__demo_build");
  });

  it("report unknown projects and validate install_project input without running anything", async () => {
    expect(body(await app.callTool("project_info", { project: "nope" }))).toMatch(/No installed project "nope"\. Installed: demo/);
    for (const args of [
      { repo: "https://evil.example/a/b" },
      { repo: "a/b", ref: "--upload-pack=x" },
      { repo: "a/b", image: "bad image!" },
      { repo: "a/b", ecosystem: "cobol" },
      {},
    ]) {
      const res = await app.callTool("install_project", args);
      expect(res.isError).toBe(true);
    }
    expect(docker.calls).toEqual([]);
  });
});

describe("install_project joining a running install", () => {
  const JOINED = /already being installed.*joined that install.*options \(other than wait_seconds\) were not applied/s;
  const stub = (status: "ready" | "failed") => {
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    let calls = 0;
    (app.installer as unknown as { install: unknown }).install = async () => {
      calls++;
      await gate;
      return { ...record("demo"), status };
    };
    return { finish, calls: () => calls };
  };

  it("says so, with the options not applied, in every response shape of a joining call", async () => {
    const s = stub("ready");
    const first = await app.callTool("install_project", { repo: "owner/demo", wait_seconds: 0 });
    expect(body(first)).toMatch(/^Still installing/);
    expect(body(first)).not.toMatch(/joined/);

    const second = await app.callTool("install_project", { repo: "owner/demo", network: false, wait_seconds: 0 });
    expect(body(second)).toMatch(JOINED);
    expect(body(second)).toMatch(/Still installing/);
    expect(s.calls()).toBe(1);

    const finished = app.callTool("install_project", { repo: "owner/demo", network: false });
    s.finish();
    const res = await finished;
    expect(res.isError).toBe(false);
    expect(body(res)).toMatch(JOINED);
    expect(s.calls()).toBe(1);
  });

  it("says so when the joined install failed, and not to a call that started it", async () => {
    const s = stub("failed");
    const starter = app.callTool("install_project", { repo: "owner/demo" });
    const joiner = app.callTool("install_project", { repo: "owner/demo", reinstall: true });
    s.finish();
    const [a, b] = [await starter, await joiner];
    expect(a.isError).toBe(true);
    expect(body(a)).not.toMatch(/joined/);
    expect(b.isError).toBe(true);
    expect(body(b)).toMatch(JOINED);
  });
});

describe("proxied MCP servers", () => {
  const connect = (extra: Record<string, unknown> = {}) => {
    docker.next = { code: 1 }; // discovery finds no executables in this fake sandbox
    return app.callTool("connect_mcp_server", { project: "demo", command: ["node", "server.js"], ...extra });
  };

  it("connect_mcp_server publishes the upstream tools with their own schemas", async () => {
    const res = await connect();
    expect(res.isError).toBe(false);
    expect(body(res)).toMatch(/^Connected MCP server "node" of demo: 4 tool\(s\) published\. The sandbox is offline/);
    expect(app.registry.get("demo")!.mcpServers).toEqual([
      { name: "node", argv: ["node", "server.js"], cwd: "/workspace/repo", env: {}, origin: "registered" },
    ]);
    const add = app.listTools().find((t) => t.name === "demo__add")!;
    expect(add.description).toBe('[sandboxed github:owner/demo] MCP tool `add` of server "node". Add two numbers');
    expect(add.inputSchema).toEqual({ type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] });
  });

  it("forwards calls with their arguments untouched", async () => {
    await connect();
    const res = await app.callTool("demo__add", { a: 2, b: 40 });
    expect(res).toEqual({ content: [{ type: "text", text: "42" }], isError: false });
    expect(up.received).toEqual([{ name: "add", arguments: { a: 2, b: 40 } }]);
    const viaMeta = await app.callTool("call_project_tool", { tool: "demo__add", arguments: { a: 1, b: 1 } });
    expect(body(viaMeta)).toBe("2");
  });

  it("rebuilds upstream results from known parts only", async () => {
    await connect();
    const res = await app.callTool("demo__mixed", {});
    expect(res).toEqual({
      isError: true,
      content: [
        { type: "text", text: "x".repeat(300) },
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "text", text: "[image omitted: 4 base64 characters]" },
        { type: "text", text: "[file:///a.txt]\nembedded" },
        { type: "text", text: "[resource link: file:///b.txt; resources are not proxied]" },
      ],
    });
  });

  it("caps proxied text like any other tool output", async () => {
    const cfg = loadConfig({ HOME: dir, MCPE_DATA_DIR: dir, MCPE_MAX_OUTPUT_BYTES: "100" });
    const small = new App({ cfg, docker, proxy: new McpProxy(cfg, docker, up.connector) });
    docker.next = { code: 1 };
    await small.callTool("connect_mcp_server", { project: "demo", command: ["srv"] });
    const res = await small.callTool("demo__mixed", {});
    expect(res.content[0]).toEqual({ type: "text", text: `${"x".repeat(100)}\n[output truncated]` });
    expect(res.content.filter((c) => c.type === "text")).toHaveLength(1);
    await small.shutdown();
  });

  it("stores the environment but never prints its values", async () => {
    const res = await connect({ name: "api", env: { API_KEY: "s3cret-value" } });
    expect(body(res)).not.toContain("s3cret-value");
    expect(body(res)).toContain('mcp server "api" (registered): node server.js; env: API_KEY');
    expect(app.registry.get("demo")!.mcpServers![0]!.env).toEqual({ API_KEY: "s3cret-value" });
    expect(body(await app.callTool("demo__whoami", {}))).toBe("api env=API_KEY");
    expect(body(await app.callTool("project_info", { project: "demo" }))).not.toContain("s3cret-value");
    expect(body(await app.callTool("list_projects", {}))).not.toContain("s3cret-value");
  });

  it("replaces a registration of the same name and restarts it with the new spec", async () => {
    await connect({ name: "api", env: { A: "1" } });
    await connect({ name: "api", env: { B: "2" } });
    expect(app.registry.get("demo")!.mcpServers).toHaveLength(1);
    expect(body(await app.callTool("demo__whoami", {}))).toBe("api env=B");
  });

  it("leaves the project unchanged when the server does not start", async () => {
    up.answer = false;
    const res = await connect();
    expect(res.isError).toBe(true);
    expect(body(res)).toMatch(/MCP server "node" \(node server\.js\) did not start: no MCP handshake within 1s/);
    expect(app.registry.get("demo")!.mcpServers).toBeUndefined();
    expect(app.listTools().map((t) => t.name)).toContain("demo__demo_build");
  });

  it.each([
    [{ command: "node server.js" }, /"command" must be a non-empty array/],
    [{ command: [] }, /"command" must be a non-empty array/],
    [{ command: ["has space"] }, /program name/],
    [{ command: ["./weird name!"], name: "bad name" }, /program name|"name" may only contain/],
    [{ command: ["srv"], name: "bad name" }, /"name" may only contain/],
    [{ command: ["srv"], env: { "BAD-KEY": "x" } }, /Invalid environment variable name/],
    [{ command: ["srv"], env: { A: "x\ny" } }, /line breaks/],
    [{ command: ["srv"], env: ["A=1"] }, /"env" must be an object/],
    [{ command: ["srv"], cwd: "../../etc" }, /inside \/workspace/],
  ])("connect_mcp_server rejects %j", async (args, message) => {
    const res = await app.callTool("connect_mcp_server", { project: "demo", ...args });
    expect(res.isError).toBe(true);
    expect(body(res)).toMatch(message);
    expect(up.launches).toEqual([]);
  });

  it("resolves a relative cwd against the checkout", async () => {
    await connect({ cwd: "packages/server" });
    expect(app.registry.get("demo")!.mcpServers![0]!.cwd).toBe("/workspace/repo/packages/server");
  });

  it("connect_mcp_server announces a tool list change once", async () => {
    let changed = 0;
    app.announceToolListChanged = () => {
      changed++;
    };
    expect((await connect()).isError).toBe(false);
    expect(changed).toBe(1);
  });

  it("disconnect_mcp_server announces a tool list change once", async () => {
    await connect({ name: "api" });
    let changed = 0;
    app.announceToolListChanged = () => {
      changed++;
    };
    expect((await app.callTool("disconnect_mcp_server", { project: "demo", name: "api" })).isError).toBe(false);
    expect(changed).toBe(1);
  });

  it("disconnect_mcp_server stops the server, forgets its secrets and removes its tools", async () => {
    await connect({ name: "api", env: { API_KEY: "s3cret-value" } });
    await app.callTool("demo__add", { a: 1, b: 1 });
    const res = await app.callTool("disconnect_mcp_server", { project: "demo", name: "api" });
    expect(res.isError).toBe(false);
    expect(app.proxy.size).toBe(0);
    expect(fs.readFileSync(path.join(dir, "registry.json"), "utf8")).not.toContain("s3cret-value");
    expect(app.listTools().map((t) => t.name)).not.toContain("demo__add");
    expect(body(await app.callTool("demo__add", { a: 1, b: 1 }))).toMatch(/Unknown tool "demo__add"/);
    expect(body(await app.callTool("disconnect_mcp_server", { project: "demo", name: "api" }))).toMatch(/no MCP server named "api"/);
  });

  describe("disconnect_mcp_server when the sandbox is gone", () => {
    /** A ready project with a registered server, an open session, a registered command and a tool of its own. */
    async function seedRegistered(): Promise<ProjectRecord> {
      await connect({ name: "api" });
      await app.callTool("demo__add", { a: 1, b: 1 });
      const seeded = app.registry.get("demo")!;
      app.registry.put({ ...seeded, commands: [...seeded.commands, { name: "demo", origin: "registered" }], tools: [...seeded.tools, tool] });
      return structuredClone(app.registry.get("demo")!);
    }
    const sandboxGone = () => {
      docker.exists = false;
      docker.next = { code: 1 };
    };

    it("refuses, closes nothing and stores nothing", async () => {
      const before = await seedRegistered();
      expect(before.mcpServers).toHaveLength(1);
      expect(before.commands.some((c) => c.origin === "registered")).toBe(true);
      expect(before.tools.length).toBeGreaterThan(0);
      expect(app.proxy.size).toBe(1);
      sandboxGone();
      const res = await app.callTool("disconnect_mcp_server", { project: "demo", name: "api" });
      expect(res.isError).toBe(true);
      expect(body(res)).toBe("Error: Sandbox for demo no longer exists; reinstall it with install_project(reinstall: true).");
      expect(app.registry.get("demo")).toEqual(before);
      expect(app.proxy.size).toBe(1);
    });

    it("refuses an unknown name and a detected server first, with no Docker call", async () => {
      await seedRegistered();
      const stored = app.registry.get("demo")!;
      app.registry.put({ ...stored, mcpServers: [...stored.mcpServers!, { name: "auto", argv: ["auto"], cwd: "/workspace/repo", env: {}, origin: "detected" }] });
      sandboxGone();
      docker.calls = [];
      docker.ensureCalls = [];
      expect(body(await app.callTool("disconnect_mcp_server", { project: "demo", name: "nope" }))).toMatch(/no MCP server named "nope"/);
      expect(body(await app.callTool("disconnect_mcp_server", { project: "demo", name: "auto" }))).toMatch(/was detected automatically/);
      expect(docker.calls).toEqual([]);
      expect(docker.ensureCalls).toEqual([]);
    });
  });

  it("uninstall_project stops the project's servers", async () => {
    await connect();
    await app.callTool("demo__add", { a: 1, b: 1 });
    expect(app.proxy.size).toBe(1);
    await app.callTool("uninstall_project", { project: "demo" });
    expect(app.proxy.size).toBe(0);
  });

  it("reports a tool whose server registration has vanished", async () => {
    await connect();
    const project = app.registry.get("demo")!;
    app.registry.put({ ...project, mcpServers: [] });
    expect(body(await app.callTool("demo__add", { a: 1, b: 1 }))).toMatch(/MCP server "node" of demo is no longer registered/);
  });
});

describe("catalog, search and selection", () => {
  /** A project whose catalog is larger than what it publishes. */
  function seedCatalog(): void {
    const mk = (name: string, description: string, over: Partial<ToolDef> = {}): ToolDef => ({
      ...tool,
      name,
      description,
      inputSchema: { type: "object", properties: { path: { type: "string" }, deep: { type: "boolean" } }, required: ["path"] },
      ...over,
    });
    seed({
      ...record("big"),
      tools: [
        mk("big__big", "[sandboxed x] Runs `big`.", { argv: ["big"] }),
        mk("big__open_binary", "[sandboxed x] MCP tool `open_binary`. Open an app for analysis.", { kind: "mcp", argv: [], mcp: { server: "srv", tool: "open_binary" } }),
        mk("big__list_strings", "[sandboxed x] MCP tool `list_strings`. List strings of the open binary.", { kind: "mcp", argv: [], mcp: { server: "srv", tool: "list_strings" } }),
        mk("big__big_scan", "[sandboxed x] Runs `big scan`. Scan a directory.", { argv: ["big", "scan"] }),
      ],
      published: ["big__big"],
      mcpServers: [{ name: "srv", argv: ["big", "mcp"], cwd: "/workspace/repo", env: {}, origin: "detected" }],
    });
  }

  it("advertises only published tools, but keeps the whole catalog callable", async () => {
    seedCatalog();
    const names = app.listTools().map((t) => t.name);
    expect(names).toContain("big__big");
    expect(names).not.toContain("big__open_binary");
    expect(names).not.toContain("big__big_scan");

    docker.next = { stdout: "scanned" };
    expect(body(await app.callTool("call_project_tool", { tool: "big__big_scan", arguments: { args: ["/x"] } }))).toContain("scanned");
    expect(docker.calls[0]!.argv).toEqual(["big", "scan", "/x"]);
    // A proxied tool that is not published is reachable the same way.
    expect(body(await app.callTool("call_project_tool", { tool: "big__open_binary", arguments: {} }))).toMatch(/no such tool open_binary|rejected/);
    expect(up.launches[0]!.server.argv).toEqual(["big", "mcp"]);
  });

  it("treats records without a published list as fully published", () => {
    seed({ ...record("old"), published: undefined, tools: [{ ...tool, name: "old__a" }, { ...tool, name: "old__b" }] });
    expect(app.listTools().map((t) => t.name)).toEqual(expect.arrayContaining(["old__a", "old__b"]));
  });

  it("find_project_tools ranks name matches first and marks unpublished tools", async () => {
    seedCatalog();
    const res = body(await app.callTool("find_project_tools", { query: "binary" }));
    const lines = res.split("\n");
    expect(lines[0]).toBe("2 of 5 generated tools match. Run one with call_project_tool(tool, arguments).");
    // "binary" is in open_binary's name, only in list_strings' description.
    expect(lines[1]).toBe("big__open_binary  [not published]");
    expect(lines[3]).toBe("    arguments (* required): path*: string, deep: boolean");
    expect(lines[4]).toBe("big__list_strings  [not published]");
    expect(res).not.toContain("big__big_scan");
  });

  it("find_project_tools requires every keyword, ignores separators and case, and can scope to a project", async () => {
    seedCatalog();
    expect(body(await app.callTool("find_project_tools", { query: "Open-Binary" }))).toContain("big__open_binary");
    expect(body(await app.callTool("find_project_tools", { query: "open scan" }))).toMatch(/^No generated tool matches "open scan" \(5 searched\)/);
    expect(body(await app.callTool("find_project_tools", { query: "runs", project: "demo" }))).toMatch(/^1 of 1 generated tools match/);
    const listing = body(await app.callTool("find_project_tools", { project: "big", limit: 2 }));
    expect(listing).toMatch(/^4 of 4 generated tools match; showing the best 2\./);
    expect(listing).toContain("big__big\n");
    const empty = await app.callTool("find_project_tools", {});
    expect(empty.isError).toBe(true);
  });

  it("find_project_tools can return full schemas", async () => {
    seedCatalog();
    const res = body(await app.callTool("find_project_tools", { query: "open_binary", schema: true }));
    expect(res).toContain('schema: {"type":"object","properties":{"path":{"type":"string"},"deep":{"type":"boolean"}},"required":["path"]}');
  });

  it("select_project_tools publishes a chosen subset and reset restores the default", async () => {
    seedCatalog();
    const res = await app.callTool("select_project_tools", { project: "big", include: ["open_binary", "list_*"] });
    expect(res.isError).toBe(false);
    expect(body(res)).toContain("tool selection: include open_binary, list_*");
    expect(body(res)).toContain("tools published (2) (+2 not published");
    expect(app.registry.get("big")!.published).toEqual(["big__open_binary", "big__list_strings"]);
    const names = app.listTools().map((t) => t.name);
    expect(names).toContain("big__open_binary");
    expect(names).not.toContain("big__big");

    await app.callTool("select_project_tools", { project: "big", reset: true });
    const record = app.registry.get("big")!;
    expect(record.selection).toBeUndefined();
    // Default policy with the default limit: everything fits.
    expect(record.published).toEqual(["big__big", "big__open_binary", "big__list_strings", "big__big_scan"]);
  });

  it("select_project_tools announces a tool list change once per change", async () => {
    seedCatalog();
    let changed = 0;
    app.announceToolListChanged = () => {
      changed++;
    };
    await app.callTool("select_project_tools", { project: "big", include: ["open_binary"] });
    expect(changed).toBe(1);
    await app.callTool("select_project_tools", { project: "big", reset: true });
    expect(changed).toBe(2);
  });

  it("select_project_tools records notes for selections that match nothing or too much", async () => {
    seedCatalog();
    const none = body(await app.callTool("select_project_tools", { project: "big", include: ["nope"] }));
    expect(none).toContain("warning: Tools: The tool selection matches no tools, so none are published.");
    const capped = body(await app.callTool("select_project_tools", { project: "big", include: ["*"], max_tools: 1 }));
    expect(capped).toContain("warning: Tools: The tool selection matches 4 tools; only the first 1 are published (limit 1).");
    // Notes describe the current selection only: the earlier one is gone.
    expect(capped).not.toContain("matches no tools");
  });

  it.each([
    [{}, /Pass include and\/or exclude patterns/],
    [{ include: "open_binary" }, /"include" must be an array/],
    [{ include: [""] }, /"include" must be an array/],
    [{ reset: true, include: ["x"] }, /"reset" cannot be combined/],
  ])("select_project_tools rejects %j", async (args, message) => {
    seedCatalog();
    const res = await app.callTool("select_project_tools", { project: "big", ...args });
    expect(res.isError).toBe(true);
    expect(body(res)).toMatch(message);
  });

  it("shows why the runtime image was chosen and which names a command also goes by", async () => {
    seed({
      ...record("rt"),
      image: "node:24",
      imageReason: "Node 24, pinned by .nvmrc (24.22.1)",
      commands: [{ name: "rea", origin: "t", aliases: ["rea-agents"] }],
    });
    const info = body(await app.callTool("project_info", { project: "rt" }));
    expect(info).toContain("build: generic in node:24;");
    expect(info).toContain("runtime: Node 24, pinned by .nvmrc (24.22.1)");
    expect(info).toContain("commands: rea (also rea-agents)");
  });
});

describe("over the MCP protocol", () => {
  it("serves the tool list, executes calls and announces list changes", async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    let changed = 0;
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      changed++;
    });
    const handle = serveApp(app, serverSide);
    await client.connect(clientSide);

    expect(client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
    expect(client.getInstructions()).toContain("untrusted");
    const listed = await client.listTools();
    expect(listed.tools.find((t) => t.name === "demo__demo_build")?.inputSchema.properties).toHaveProperty("release");

    docker.next = { stdout: "ok" };
    const res = await client.callTool({ name: "demo__demo_build", arguments: { release: true } });
    expect((res.content as Array<{ text: string }>)[0]!.text).toContain("ok");

    await client.callTool({ name: "uninstall_project", arguments: { project: "demo" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(changed).toBe(1);
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain("demo__demo_build");
    await client.close();
    await handle.close();
  });
});

describe("parseProbeOutput", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");
  it("decodes entries and manifests and ignores forged or unknown lines", () => {
    const sha = "a".repeat(40);
    const data = parseProbeOutput(
      [
        `HEAD ${sha}`,
        `ENTRY f ${b64("package.json")}`,
        `ENTRY d ${b64("src")}`,
        `ENTRY f ${b64("odd\nFILE package.json e30=")}`,
        `FILE package.json ${b64('{"name":"x"}')}`,
        `FILE /etc/shadow ${b64("nope")}`,
        "HEAD not-a-sha",
        "garbage line",
      ].join("\n"),
    );
    expect(data.commit).toBe(sha);
    expect(data.entries.map((e) => [e.name, e.dir])).toEqual([
      ["package.json", false],
      ["src", true],
      ["odd\nFILE package.json e30=", false],
    ]);
    expect(data.files).toEqual({ "package.json": '{"name":"x"}' });
  });
});

describe("host environment variables for proxied MCP servers", () => {
  // Long and unlikely to occur in any output by accident.
  const OTHER = "hv-Zp9Wk2Tn6Bx1Lr4Gd8Mc3Va7Hs5Ye0Q";
  const apps: App[] = [];
  let lines: string[];

  const appWith = (env: Record<string, string | undefined>): App => {
    const cfg = loadConfig({ HOME: dir, MCPE_DATA_DIR: dir, MCPE_MCP_STARTUP_TIMEOUT: "1" });
    const a = new App({ cfg, docker, proxy: new McpProxy(cfg, docker, up.connector), env, log: (l) => lines.push(l) });
    apps.push(a);
    return a;
  };
  const mcpTool = (slug: string, name: string, server = "api"): ToolDef => ({
    ...tool,
    name: `${slug}__${name}`,
    kind: "mcp",
    argv: [],
    options: [],
    mcp: { server, tool: name },
  });
  const stored = (env: Record<string, string> = {}) => ({ name: "api", argv: ["node", "server.js"], cwd: "/workspace/repo", env, origin: "registered" as const });
  /** A project seeded with a stored server and its tool: no connect_mcp_server, so the call is the only launch. */
  const seeded = (a: App, slug: string, env: Record<string, string> = {}): void => {
    a.registry.put({ ...record(slug), mcpServers: [stored(env)], tools: [mcpTool(slug, "whoami")] });
  };
  const connect = (a: App, slug = "demo", extra: Record<string, unknown> = {}) => {
    docker.next = { code: 1 };
    return a.callTool("connect_mcp_server", { project: slug, command: ["node", "server.js"], name: "api", ...extra });
  };
  const registryBytes = () => fs.readFileSync(path.join(dir, "registry.json"), "utf8");

  beforeEach(() => {
    lines = [];
  });
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.shutdown();
  });

  it("callGenerated: a proxied tool call launches once, with the variable", async () => {
    const a = appWith({ demo__API_KEY: SECRET_VALUE });
    seeded(a, "demo");
    expect(body(await a.callTool("demo__whoami", {}))).toBe("api env=API_KEY");
    expect(up.launches).toHaveLength(1);
    expect(up.launches[0]!.server.env).toEqual({ API_KEY: SECRET_VALUE });
  });

  it("connectMcp: the first launch has the variable, and what is stored does not", async () => {
    const a = appWith({ demo__API_KEY: SECRET_VALUE });
    expect((await connect(a)).isError).toBe(false);
    expect(up.launches[0]!.server.env).toEqual({ API_KEY: SECRET_VALUE });
    expect(a.registry.get("demo")!.mcpServers![0]!.env).toEqual({});
    expect(registryBytes()).not.toContain(SECRET_VALUE);
  });

  it("discover_tools announces a tool list change once", async () => {
    const a = appWith({});
    seeded(a, "demo");
    let changed = 0;
    a.announceToolListChanged = () => {
      changed++;
    };
    docker.next = { code: 1 };
    expect((await a.callTool("discover_tools", { project: "demo" })).isError).toBe(false);
    expect(changed).toBe(1);
  });

  it("discoverMcp, registered servers: discover_tools launches the server with the variable", async () => {
    const a = appWith({ demo__API_KEY: SECRET_VALUE });
    seeded(a, "demo");
    docker.next = { code: 1 };
    await a.callTool("discover_tools", { project: "demo" });
    expect(up.launches.length).toBeGreaterThan(0);
    for (const l of up.launches) expect(l.server.env).toEqual({ API_KEY: SECRET_VALUE });
    expect(a.registry.get("demo")!.mcpServers![0]!.env).toEqual({});
  });

  it("the environment wins over a stored value of the same name, and says so in project_info", async () => {
    const a = appWith({ demo__GREETING: SECRET_VALUE });
    seeded(a, "demo", { GREETING: OTHER, KEEP: "kept" });
    expect(body(await a.callTool("demo__whoami", {}))).toBe("api env=GREETING,KEEP");
    expect(up.launches[0]!.server.env).toEqual({ GREETING: SECRET_VALUE, KEEP: "kept" });
    const info = body(await a.callTool("project_info", { project: "demo" }));
    expect(info).toContain("env: GREETING (overridden by demo__GREETING), KEEP");
    expect(info).not.toContain(SECRET_VALUE);
    expect(info).not.toContain(OTHER);
  });

  it("the object is read at each launch, not copied at construction", async () => {
    const env: Record<string, string> = {};
    const a = appWith(env);
    seeded(a, "demo");
    expect(body(await a.callTool("demo__whoami", {}))).toBe("api env=");
    env.demo__LATE = SECRET_VALUE;
    expect(body(await a.callTool("demo__whoami", {}))).toBe("api env=LATE");
    expect(up.launches.map((l) => l.server.env)).toEqual([{}, { LATE: SECRET_VALUE }]);
  });

  it("each project's launches carry only its own variables", async () => {
    const a = appWith({ demo__API_KEY: SECRET_VALUE, other__API_KEY: OTHER, other__ONLY_OTHER: "1" });
    seeded(a, "demo");
    seeded(a, "other");
    await a.callTool("demo__whoami", {});
    await a.callTool("other__whoami", {});
    const byContainer = (c: string) => up.launches.filter((l) => l.container === c).map((l) => l.server.env);
    expect(byContainer("mcpe-demo")).toEqual([{ API_KEY: SECRET_VALUE }]);
    expect(byContainer("mcpe-other")).toEqual([{ API_KEY: OTHER, ONLY_OTHER: "1" }]);
  });

  it("a project with no matching variable launches with exactly its stored environment", async () => {
    const a = appWith({ other__API_KEY: SECRET_VALUE, npm_config__x: "y" });
    seeded(a, "demo", { STORED: "s" });
    await a.callTool("demo__whoami", {});
    expect(up.launches.map((l) => l.server.env)).toEqual([{ STORED: "s" }]);
  });

  it.each([
    ["nothing stored", {}],
    ["the same name stored with the same value", { API_KEY: SECRET_VALUE }],
  ])("the session is still shared (%s)", async (_label, storedEnv) => {
    const a = appWith({ demo__API_KEY: SECRET_VALUE });
    docker.next = { code: 1 };
    await connect(a, "demo", { env: storedEnv });
    await a.callTool("demo__whoami", {});
    expect(up.launches).toHaveLength(1);
    expect(a.proxy.size).toBe(1);
    expect(up.launches[0]!.server.env).toEqual({ API_KEY: SECRET_VALUE });
    expect(a.registry.get("demo")!.mcpServers![0]!.env).toEqual(storedEnv);
  });

  it("the session is still shared for a project without a matching variable", async () => {
    const a = appWith({});
    await connect(a);
    await a.callTool("demo__whoami", {});
    expect(up.launches).toHaveLength(1);
    expect(a.proxy.size).toBe(1);
  });

  describe("an unusable value", () => {
    const BAD = "bad\nSECRET-LINE-2";
    const message = "Environment variable demo__API_KEY contains a line break or NUL character and cannot be passed to the MCP server.";

    it("fails a proxied call with the message, which is also logged, without the value; other projects are unaffected", async () => {
      const a = appWith({ demo__API_KEY: BAD, other__API_KEY: OTHER });
      seeded(a, "demo");
      seeded(a, "other");
      const res = await a.callTool("demo__whoami", {});
      expect(res.isError).toBe(true);
      expect(body(res)).toBe(`Error: ${message}`);
      expect(lines).toEqual([`demo__whoami failed: ${message}`]);
      expect(up.launches).toEqual([]);
      expect(body(await a.callTool("other__whoami", {}))).toBe("api env=API_KEY");
    });

    it("fails connect_mcp_server before any running server of the project is stopped", async () => {
      const env: Record<string, string> = {};
      const a = appWith(env);
      await connect(a);
      expect(a.proxy.size).toBe(1);
      const before = up.launches.length;
      env.demo__API_KEY = BAD;
      const res = await connect(a, "demo", { name: "second" });
      expect(res.isError).toBe(true);
      expect(body(res)).toBe(`Error: ${message}`);
      expect(a.proxy.size).toBe(1);
      expect(up.launches).toHaveLength(before);
      expect(a.registry.get("demo")!.mcpServers!.map((s) => s.name)).toEqual(["api"]);
    });

    it("leaves a registered server recorded with no tools and an MCP warning, in discovery", async () => {
      const a = appWith({ demo__API_KEY: BAD });
      seeded(a, "demo");
      docker.next = { code: 1 };
      const res = await a.callTool("discover_tools", { project: "demo" });
      expect(res.isError).toBe(false);
      const p = a.registry.get("demo")!;
      expect(p.status).toBe("ready");
      expect(p.mcpServers!.map((s) => s.name)).toEqual(["api"]);
      expect(p.tools.filter((t) => t.kind === "mcp")).toEqual([]);
      expect(p.warnings).toContain(`MCP: ${message}`);
      expect(up.launches).toEqual([]);
    });

    it("project_info still lists the name and prints no value", async () => {
      const a = appWith({ demo__API_KEY: BAD });
      const info = body(await a.callTool("project_info", { project: "demo" }));
      expect(info).toContain("API_KEY");
      expect(info).not.toContain("SECRET-LINE-2");
    });
  });

  describe("visibility", () => {
    it("project_info lists the names a project receives, and no values, before any server exists", async () => {
      const a = appWith({ demo__API_KEY: SECRET_VALUE, demo__REGION: "eu", other__NOT_MINE: OTHER });
      const info = body(await a.callTool("project_info", { project: "demo" }));
      expect(info).toContain("environment from demo__… variables");
      expect(info).toContain("API_KEY, REGION");
      expect(info).not.toContain("NOT_MINE");
      expect(info).not.toContain(SECRET_VALUE);
      expect(info).not.toContain("eu\n");
    });

    it("is byte for byte what it was for a project with no matching variable", async () => {
      const plain = appWith({});
      seeded(plain, "demo", { API_KEY: "stored-s3cret" });
      const infoPlain = body(await plain.callTool("project_info", { project: "demo" }));
      const listPlain = body(await plain.callTool("list_projects", {}));
      const unrelated = appWith({ other__API_KEY: SECRET_VALUE, npm_config__x: "y" });
      expect(body(await unrelated.callTool("project_info", { project: "demo" }))).toBe(infoPlain);
      expect(body(await unrelated.callTool("list_projects", {}))).toBe(listPlain);
      expect(infoPlain).toContain("env: API_KEY");
      expect(infoPlain).not.toContain("overridden");
    });

    it("still lists names for a project that is installing or failed", async () => {
      const a = appWith({ demo__API_KEY: SECRET_VALUE });
      a.registry.put({ ...record("demo"), status: "failed", error: "x" });
      expect(body(await a.callTool("list_projects", {}))).toContain("API_KEY");
    });
  });

  it("nothing mcp-everything writes contains the value: registry, tool results and log lines", async () => {
    const a = appWith({ demo__API_KEY: SECRET_VALUE });
    const results: string[] = [];
    const keep = async (p: Promise<Awaited<ReturnType<App["callTool"]>>>) => {
      const r = await p;
      results.push(...r.content.map((c) => (c as { text?: string }).text ?? ""));
      return r;
    };
    await keep(connect(a));
    await keep(a.callTool("demo__whoami", {}));
    docker.next = { code: 1 };
    await keep(a.callTool("discover_tools", { project: "demo" }));
    await keep(a.callTool("project_info", { project: "demo" }));
    await keep(a.callTool("list_projects", {}));
    // Presence: the launches did carry the value.
    expect(up.launches.length).toBeGreaterThan(0);
    for (const l of up.launches) expect(l.server.env.API_KEY).toBe(SECRET_VALUE);
    // Absence.
    expect(registryBytes()).not.toContain(SECRET_VALUE);
    for (const r of results) expect(r).not.toContain(SECRET_VALUE);
    for (const l of lines) expect(l).not.toContain(SECRET_VALUE);
    expect(results.length).toBeGreaterThan(4);
  });

  it("only MCP server processes receive it: command line tools and sandbox_exec do not", async () => {
    const a = appWith({ demo__API_KEY: SECRET_VALUE });
    seeded(a, "demo");
    a.registry.put({ ...a.registry.get("demo")!, tools: [tool, mcpTool("demo", "whoami")] });
    docker.next = { stdout: "ok\n" };
    await a.callTool("demo__demo_build", {});
    await a.callTool("sandbox_exec", { project: "demo", command: "env" });
    expect(docker.calls.length).toBeGreaterThanOrEqual(2);
    // Covers Docker.exec calls (command line tools and sandbox_exec); the arguments of a
    // proxied launch are covered in test/proxy.test.ts.
    expect(JSON.stringify(docker.calls.map((c) => ({ argv: c.argv, opts: c.opts })))).not.toContain(SECRET_VALUE);
    // Presence: a proxied call for the same project launches with it.
    await a.callTool("demo__whoami", {});
    expect(up.launches[0]!.server.env.API_KEY).toBe(SECRET_VALUE);
  });

  describe("refresh_mcp", () => {
    const KILL = (pidFile: string) => ["sh", "-c", expect.any(String), "sh", pidFile];
    type Conn = ReturnType<Connector>;
    /** A launch that fails at once: the transport is already dead, and stderr carries `stderr`. */
    const dead = (stderr = "no such file"): Conn => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      void serverSide.close();
      return { transport: clientSide, stderr: () => stderr };
    };
    /** Launches the predicate accepts reach the fake upstream; the others fail at once instead of waiting out a handshake. */
    const gated = (answers: (launch: Parameters<Connector>[0]) => boolean): Connector => (launch) => {
      if (answers(launch)) return up.connector(launch);
      up.launches.push(launch);
      return dead();
    };
    const appUsing = (env: Record<string, string | undefined>, connector: Connector): App => {
      const cfg = loadConfig({ HOME: dir, MCPE_DATA_DIR: dir, MCPE_MCP_STARTUP_TIMEOUT: "1" });
      const a = new App({ cfg, docker, proxy: new McpProxy(cfg, docker, connector), env, log: (l) => lines.push(l) });
      apps.push(a);
      return a;
    };
    const server = (name: string, env: Record<string, string> = {}, origin: "registered" | "detected" = "registered") => ({
      name,
      argv: origin === "registered" ? ["node", `${name}.js`] : [name],
      cwd: "/workspace/repo",
      env,
      origin,
    });
    const first = (res: Awaited<ReturnType<App["callTool"]>>) => body(res).split("\n")[0]!;
    const state = (a: App) => ({ calls: docker.calls.length, ensures: docker.ensureCalls.length, launches: up.launches.length, size: a.proxy.size });

    it("is a built-in tool with one required argument, project, and no others", () => {
      const t = app.listTools().find((x) => x.name === "refresh_mcp")!;
      const schema = t.inputSchema as { properties: Record<string, unknown>; required: string[] };
      expect(Object.keys(schema.properties)).toEqual(["project"]);
      expect(schema.required).toEqual(["project"]);
    });

    describe("refusals leave everything as it was", () => {
      const open = async (status: "ready" | "installing" | "failed", job: boolean) => {
        const a = appWith({});
        seeded(a, "demo");
        await a.callTool("demo__whoami", {});
        expect(a.proxy.size).toBe(1);
        a.registry.put({ ...a.registry.get("demo")!, status });
        if (job) {
          (a as unknown as { jobs: Map<string, unknown> }).jobs.set("github:owner/demo", { promise: new Promise(() => {}), log: [], startedAt: Date.now() });
        }
        return a;
      };
      it.each([
        ["an install job is running in this process", "ready", true, /still installing/],
        ["a job runs and the status says installing: the job check comes first", "installing", true, /still installing/],
        ["the status is installing and no job is running here", "installing", false, /reinstall if it does not finish/],
        ["the status is failed", "failed", false, /discover_tools.*install_project|install_project.*discover_tools/],
      ] as const)("when %s", async (_label, status, job, message) => {
        const a = await open(status, job);
        const before = state(a);
        const res = await a.callTool("refresh_mcp", { project: "demo" });
        expect(res.isError).toBe(true);
        expect(body(res)).toMatch(message);
        expect(state(a)).toEqual(before);
      });
    });

    it("fails before anything is stopped when a value is unusable, naming the variable and not the value", async () => {
      const env: Record<string, string> = { demo__API_KEY: SECRET_VALUE };
      const a = appWith(env);
      seeded(a, "demo");
      await a.callTool("demo__whoami", {});
      env.demo__API_KEY = "bad\nSECRET-LINE-9";
      const before = state(a);
      const res = await a.callTool("refresh_mcp", { project: "demo" });
      expect(res.isError).toBe(true);
      expect(body(res)).toContain("demo__API_KEY");
      expect(body(res)).not.toContain("SECRET-LINE-9");
      expect(state(a)).toEqual(before);
      expect(a.proxy.size).toBe(1);
    });

    it("stops nothing when the sandbox no longer exists", async () => {
      const a = appWith({});
      seeded(a, "demo");
      await a.callTool("demo__whoami", {});
      docker.exists = false;
      const res = await a.callTool("refresh_mcp", { project: "demo" });
      expect(res.isError).toBe(true);
      expect(body(res)).toMatch(/no longer exists/);
      expect(a.proxy.size).toBe(1);
    });

    it("connect_mcp_server stops nothing when the sandbox no longer exists", async () => {
      const a = appWith({});
      seeded(a, "demo");
      await a.callTool("demo__whoami", {});
      docker.exists = false;
      const res = await connect(a);
      expect(res.isError).toBe(true);
      expect(body(res)).toMatch(/no longer exists/);
      expect(a.proxy.size).toBe(1);
    });

    it("stops the sessions, discovers again, launches a server that had one, and says what it did", async () => {
      const a = appWith({ demo__API_KEY: SECRET_VALUE });
      seeded(a, "demo");
      let changed = 0;
      a.announceToolListChanged = () => {
        changed++;
      };
      docker.next = { code: 1 };
      await a.callTool("demo__whoami", {});
      expect(up.launches).toHaveLength(1);
      docker.ensureCalls = [];
      const res = await a.callTool("refresh_mcp", { project: "demo" });
      expect(res.isError).toBe(false);
      expect(docker.ensureCalls).toContain("mcpe-demo");
      // A kill for the earlier session's PID file, and the same launch spec once more.
      expect(docker.calls.map((c) => c.argv)).toContainEqual(KILL(up.launches[0]!.pidFile));
      expect(up.launches).toHaveLength(2);
      expect(up.launches[1]!.server).toEqual(up.launches[0]!.server);
      expect(up.launches[1]!.pidFile).not.toBe(up.launches[0]!.pidFile);
      expect(changed).toBe(1);
      const lines_ = body(res).split("\n");
      expect(lines_[0]).toBe("Refreshed demo: 1 MCP server(s) recorded, 0 with no tool in the catalog, 4 proxied tool(s) in the catalog.");
      expect(lines_[1]).toBe("Variables applied (names only): API_KEY.");
      expect(body(res)).toContain("The sandbox is offline");
      // project_info is the same description plus its one line about the sandbox's owner (leg 4)
      const info = body(await a.callTool("project_info", { project: "demo" }));
      expect(info).toMatch(/\n\nSandbox owner: [^\n]*$/);
      expect(body(res).endsWith(info.replace(/\n\nSandbox owner: [^\n]*$/, ""))).toBe(true);
      expect(body(res)).not.toContain(SECRET_VALUE);
      expect(a.registry.get("demo")!.tools.filter((t) => t.kind === "mcp")).toHaveLength(4);
    });

    it("says that no variable is set, and nothing about the network when it is on", async () => {
      const a = appWith({ other__X: "1" });
      a.registry.put({ ...record("demo"), network: true, mcpServers: [server("api")], tools: [] });
      docker.next = { code: 1 };
      const res = await a.callTool("refresh_mcp", { project: "demo" });
      expect(res.isError).toBe(false);
      expect(body(res).split("\n")[1]).toBe("No demo__<NAME> variable is set for this project.");
      expect(body(res)).not.toContain("offline");
    });

    describe("what makes it an error: each condition alone", () => {
      it("a registered server did not start while another publishes tools", async () => {
        const a = appUsing({}, gated((l) => l.server.name === "good"));
        a.registry.put({ ...record("demo"), mcpServers: [server("good"), server("bad")], tools: [] });
        docker.next = { code: 1 };
        const res = await a.callTool("refresh_mcp", { project: "demo" });
        expect(res.isError).toBe(true);
        expect(first(res)).toBe("Refreshed demo: 2 MCP server(s) recorded, 1 with no tool in the catalog, 4 proxied tool(s) in the catalog.");
        expect(body(res)).toMatch(/Did not start: "bad": MCP server "bad" \(node bad\.js\) did not start/);
        expect(body(res)).not.toContain("gone");
        expect(body(res)).not.toContain("did not answer");
        // The warning carries the route, with this project's slug.
        const warning = a.registry.get("demo")!.warnings.find((w) => w.startsWith("MCP:"))!;
        expect(warning).toContain("set demo__NAME in the environment of mcp-everything, reconnect it, and call refresh_mcp");
      });

      it("a detected server is gone while another publishes tools", async () => {
        const a = appWith({});
        a.registry.put({ ...record("demo"), mcpServers: [server("api"), server("ghost", {}, "detected")], tools: [] });
        docker.next = { code: 1 };
        const res = await a.callTool("refresh_mcp", { project: "demo" });
        expect(res.isError).toBe(true);
        expect(first(res)).toBe("Refreshed demo: 1 MCP server(s) recorded, 0 with no tool in the catalog, 4 proxied tool(s) in the catalog.");
        expect(body(res)).toContain('Recorded before and gone now: "ghost".');
        expect(body(res)).not.toContain("Did not start");
        expect(a.registry.get("demo")!.mcpServers!.map((s) => s.name)).toEqual(["api"]);
      });

      it("no proxied tool at all, with nothing failed and nothing gone", async () => {
        const a = appWith({});
        a.registry.put({ ...record("demo"), tools: [tool] });
        docker.next = { code: 1 };
        const res = await a.callTool("refresh_mcp", { project: "demo" });
        expect(res.isError).toBe(true);
        expect(first(res)).toBe("Refreshed demo: 0 MCP server(s) recorded, 0 with no tool in the catalog, 0 proxied tool(s) in the catalog.");
        expect(body(res)).not.toContain("Did not start");
        expect(body(res)).not.toContain("gone");
      });
    });

    it("the route hint is not added to the warning for an unusable value", async () => {
      const a = appWith({ demo__API_KEY: "bad\nSECRET-LINE-9" });
      seeded(a, "demo");
      docker.next = { code: 1 };
      await a.callTool("discover_tools", { project: "demo" });
      for (const w of a.registry.get("demo")!.warnings.filter((x) => x.startsWith("MCP:"))) {
        expect(w).toContain("demo__API_KEY");
        expect(w).not.toContain("refresh_mcp");
      }
    });

    it("nothing mcp-everything writes contains the value after a refresh: registry, tool result and log lines", async () => {
      const a = appWith({ demo__API_KEY: SECRET_VALUE });
      const results: string[] = [];
      const keep = async (p: Promise<Awaited<ReturnType<App["callTool"]>>>) => {
        const r = await p;
        results.push(...r.content.map((c) => (c as { text?: string }).text ?? ""));
        return r;
      };
      await keep(connect(a));
      docker.next = { code: 1 };
      const before = up.launches.length;
      const res = await keep(a.callTool("refresh_mcp", { project: "demo" }));
      expect(res.isError).toBe(false);
      // Presence: the refresh launched with the value.
      expect(up.launches.length).toBeGreaterThan(before);
      for (const l of up.launches) expect(l.server.env.API_KEY).toBe(SECRET_VALUE);
      expect(body(res)).toContain("API_KEY");
      // Absence.
      expect(registryBytes()).not.toContain(SECRET_VALUE);
      for (const r of results) expect(r).not.toContain(SECRET_VALUE);
      for (const l of lines) expect(l).not.toContain(SECRET_VALUE);
    });

    it("documents a limit: a server that prints its variable on stderr leaves it in the tool error and the log, not in the registry", async () => {
      const a = appUsing({ demo__API_KEY: SECRET_VALUE }, (launch) => {
        up.launches.push(launch);
        return dead(`invalid API key: ${launch.server.env.API_KEY}`);
      });
      seeded(a, "demo");
      const res = await a.callTool("demo__whoami", {});
      expect(res.isError).toBe(true);
      expect(up.launches[0]!.server.env.API_KEY).toBe(SECRET_VALUE);
      expect(body(res)).toContain(SECRET_VALUE);
      expect(lines.some((l) => l.includes(SECRET_VALUE))).toBe(true);
      docker.next = { code: 1 };
      await a.callTool("discover_tools", { project: "demo" });
      expect(a.registry.get("demo")!.warnings.some((w) => w.startsWith("MCP:"))).toBe(true);
      expect(registryBytes()).not.toContain(SECRET_VALUE);
    });

    it("documents a limit: a server that puts its variable in a protocol error leaves it in the registry as well", async () => {
      const a = appUsing({ demo__API_KEY: SECRET_VALUE }, (launch) => {
        up.launches.push(launch);
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        serverSide.onmessage = (msg) => {
          const m = msg as { id?: number; method?: string };
          if (m.method === "initialize") {
            void serverSide.send({ jsonrpc: "2.0", id: m.id!, error: { code: -32000, message: `rejected key ${launch.server.env.API_KEY}` } });
          }
        };
        void serverSide.start();
        return { transport: clientSide, stderr: () => "" };
      });
      seeded(a, "demo");
      const res = await a.callTool("demo__whoami", {});
      expect(res.isError).toBe(true);
      expect(up.launches[0]!.server.env.API_KEY).toBe(SECRET_VALUE);
      expect(body(res)).toContain(SECRET_VALUE);
      expect(body(res)).toContain("MCP error -32000: rejected key");
      expect(lines.some((l) => l.includes(SECRET_VALUE))).toBe(true);
      docker.next = { code: 1 };
      await a.callTool("discover_tools", { project: "demo" });
      expect(a.registry.get("demo")!.warnings.some((w) => w.includes(SECRET_VALUE))).toBe(true);
      expect(registryBytes()).toContain(SECRET_VALUE);
    });

    it("tells agents the route in the instructions and the descriptions of connect_mcp_server", async () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "t", version: "1" });
      const handle = serveApp(app, serverSide);
      await client.connect(clientSide);
      const instructions = client.getInstructions()!;
      expect(instructions).toContain("<slug>__<NAME>");
      expect(instructions).toContain("reconnects mcp-everything, then you call refresh_mcp");
      expect(instructions).toContain("Do not ask the user to paste secrets into the conversation");
      await client.close();
      await handle.close();
      const connectTool = app.listTools().find((t) => t.name === "connect_mcp_server")!;
      const description = connectTool.description as string;
      expect(description).toContain("part of the conversation and are stored unencrypted");
      expect(description).toContain("<slug>__<NAME> variables in mcp-everything's own environment");
      expect(description).toContain("outside the conversation");
      const envDescription = ((connectTool.inputSchema as { properties: { env: { description: string } } }).properties.env.description);
      expect(envDescription).toContain("in the conversation and stored unencrypted");
      expect(envDescription).toContain("<slug>__<NAME>");
      expect(envDescription).toContain("outside the conversation");
    });
  });
});

describe("startup work: sweeps and stale installs", () => {
  class Reachable extends FakeDocker {
    override async assertAvailable(): Promise<void> {}
  }
  let local: App;
  let fake: Reachable;
  beforeEach(() => {
    const cfg = loadConfig({ HOME: dir, MCPE_DATA_DIR: dir });
    fake = new Reachable(cfg);
    local = new App({ cfg, docker: fake, proxy: new McpProxy(cfg, fake, up.connector) });
  });
  afterEach(async () => {
    await local.startup;
    await local.shutdown();
  });
  const mtime = () => fs.statSync(path.join(dir, "registry.json")).mtimeMs;

  it("marks a stale installing record failed", async () => {
    local.registry.put({ ...record("old"), status: "installing", network: true });
    local.start();
    await local.startup;
    expect(local.registry.get("old")).toMatchObject({ status: "failed", network: false });
    expect(fake.network).toEqual([["mcpe-old", false]]);
  });

  it("leaves a fresh installing record and the file alone", async () => {
    const fresh = { ...record("new"), status: "installing" as const, network: true, installedAt: new Date().toISOString() };
    local.registry.put(fresh);
    const before = mtime();
    local.start();
    await local.startup;
    expect(local.registry.get("new")).toEqual(fresh);
    expect(mtime()).toBe(before);
    expect(fake.network).toEqual([]);
  });

  it("never rejects, and a second start does not begin a second reconciliation", async () => {
    local.registry.put({ ...record("old"), status: "installing", network: true });
    local.start();
    const first = local.startup;
    local.start();
    expect(local.startup).toBe(first);
    await expect(first).resolves.toBeUndefined();
  });

  it("announces a tool list change when another process changes the registry, and not when nothing changed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let changed = 0;
      local.announceToolListChanged = () => {
        changed++;
      };
      local.start();
      await local.startup;
      vi.advanceTimersByTime(5000);
      expect(changed).toBe(0);
      const other = new Registry(dir);
      other.put({ ...record("elsewhere"), tools: [] });
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(path.join(dir, "registry.json"), later, later);
      vi.advanceTimersByTime(5000);
      expect(changed).toBe(1);
      expect(local.registry.get("elsewhere")).toBeDefined();
      vi.advanceTimersByTime(5000);
      expect(changed).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("sweeps", () => {
    const NOW = Date.now();
    const HEX = "0123456789abcdef";
    /** An env file and a registry temp file, each aged `ageSec` seconds. */
    const leftovers = (suffix: string, ageSec: number) => {
      fs.mkdirSync(path.join(dir, "tmp"), { recursive: true, mode: 0o700 });
      const envFile = path.join(dir, "tmp", `env-${suffix}`);
      const regTmp = path.join(dir, `registry.json.${suffix.length}${ageSec}.tmp`);
      const t = (NOW - ageSec * 1000) / 1000;
      for (const f of [envFile, regTmp]) {
        fs.writeFileSync(f, "x");
        fs.utimesSync(f, t, t);
      }
      return { envFile, regTmp };
    };
    let cfg: ReturnType<typeof loadConfig>;
    const logged = (log: string[]) => {
      cfg = loadConfig({ HOME: dir, MCPE_DATA_DIR: dir });
      fake = new Reachable(cfg);
      local = new App({ cfg, docker: fake, proxy: new McpProxy(cfg, fake, up.connector), log: (l) => log.push(l) });
    };
    afterEach(() => vi.restoreAllMocks());

    it("have removed old files and kept fresh ones when start returns; the reconciliation follows", async () => {
      const log: string[] = [];
      logged(log);
      const old = leftovers(HEX, 2 * 3600);
      const fresh = leftovers("fedcba9876543210", 10);
      local.registry.put({ ...record("stale"), status: "installing", network: true });
      local.start();
      expect(fs.existsSync(old.envFile)).toBe(false);
      expect(fs.existsSync(old.regTmp)).toBe(false);
      expect(fs.existsSync(fresh.envFile)).toBe(true);
      expect(fs.existsSync(fresh.regTmp)).toBe(true);
      expect(log).toEqual(["startup: removed 1 leftover env file", "startup: removed 1 leftover registry temp file"]);
      await local.startup;
      expect(local.registry.get("stale")).toMatchObject({ status: "failed", network: false });
    });

    it("log nothing when nothing was removed", async () => {
      const log: string[] = [];
      logged(log);
      leftovers(HEX, 10);
      local.start();
      await local.startup;
      expect(log).toEqual([]);
    });

    it("run once per App: a second start sweeps nothing and the field holds the same promise", async () => {
      local.start();
      const first = local.startup;
      const again = leftovers(HEX, 2 * 3600);
      local.start();
      expect(local.startup).toBe(first);
      expect(fs.existsSync(again.envFile)).toBe(true);
      expect(fs.existsSync(again.regTmp)).toBe(true);
      await first;
    });

    it("do not stop each other: a throwing registry sweep is logged and the rest still run", async () => {
      const log: string[] = [];
      logged(log);
      vi.spyOn(local.registry, "sweepTemps").mockImplementation(() => {
        throw new Error("boom");
      });
      const old = leftovers(HEX, 2 * 3600);
      local.registry.put({ ...record("stale"), status: "installing", network: true });
      local.start();
      await local.startup;
      expect(fs.existsSync(old.envFile)).toBe(false);
      expect(log).toContain("startup: registry temp file sweep failed: boom");
      expect(local.registry.get("stale")).toMatchObject({ status: "failed" });
    });

    it("do not stop each other: a failing env file sweep is logged and the registry sweep and the reconciliation still run", async () => {
      const log: string[] = [];
      logged(log);
      // sweepEnvFiles is a module export and cannot be spied on; it reads this setting first, so a failing read makes it throw.
      Object.defineProperty(cfg, "mcpStartupTimeoutSec", {
        get() {
          throw new Error("no timeout");
        },
      });
      const old = leftovers(HEX, 2 * 3600);
      local.registry.put({ ...record("stale"), status: "installing", network: true });
      local.start();
      await local.startup;
      expect(log).toContain("startup: env file sweep failed: no timeout");
      expect(fs.existsSync(old.envFile)).toBe(true);
      expect(fs.existsSync(old.regTmp)).toBe(false);
      expect(log).toContain("startup: removed 1 leftover registry temp file");
      expect(local.registry.get("stale")).toMatchObject({ status: "failed" });
    });

    it("run when the registry file is corrupt", async () => {
      const log: string[] = [];
      logged(log);
      fs.writeFileSync(path.join(dir, "registry.json"), "{ nope");
      const old = leftovers(HEX, 2 * 3600);
      local.start();
      await expect(local.startup).resolves.toBeUndefined();
      expect(fs.existsSync(old.envFile)).toBe(false);
      expect(fs.existsSync(old.regTmp)).toBe(false);
      expect(log.some((l) => l.startsWith("registry: "))).toBe(true);
    });

    it("run when the registry file is from a newer version, which every tool call then reports", async () => {
      const log: string[] = [];
      logged(log);
      const text = '{"version":2,"projects":{}}';
      fs.writeFileSync(path.join(dir, "registry.json"), text);
      const old = leftovers(HEX, 2 * 3600);
      local.start();
      await expect(local.startup).resolves.toBeUndefined();
      expect(fs.existsSync(old.envFile)).toBe(false);
      expect(fs.existsSync(old.regTmp)).toBe(false);
      expect(log.some((l) => /^registry: Registry file \S+ was written by a newer version/.test(l))).toBe(true);
      expect(log.some((l) => /^reconcile: Registry file \S+ was written by a newer version/.test(l))).toBe(true);
      const res = await local.callTool("list_projects", {});
      expect(res.isError).toBe(true);
      expect(body(res)).toMatch(/^Error: Registry file \S+ was written by a newer version/);
      expect(log.some((l) => l.includes("newer version") && !l.startsWith("registry: ") && !l.startsWith("reconcile: "))).toBe(true);
      expect(fs.readFileSync(path.join(dir, "registry.json"), "utf8")).toBe(text);
    });

    it("are not waited for by shutdown", async () => {
      // A reconciliation that never finishes: shutdown has to complete anyway.
      let finish!: () => void;
      const reconcile = vi.spyOn(local.installer, "reconcileStale").mockReturnValue(new Promise<string[]>((resolve) => (finish = () => resolve([]))));
      local.start();
      expect(reconcile).toHaveBeenCalledTimes(1);
      try {
        await expect(local.shutdown()).resolves.toBeUndefined();
      } finally {
        finish(); // the afterEach above awaits startup
      }
    });
  });
});

describe("the installation id of an App", () => {
  it("is loaded from the data directory when no Docker double is injected", async () => {
    const cfg = loadConfig({ HOME: dir, MCPE_DATA_DIR: path.join(dir, "fresh") });
    const real = new App({ cfg });
    try {
      const content = fs.readFileSync(path.join(dir, "fresh", "installation-id"), "utf8");
      expect(content).toMatch(/^[0-9a-f]{8}\n$/);
      expect(real.docker.installationId).toBe(content.trim());
    } finally {
      await real.shutdown();
    }
  });

  it("creates no id file when a double is injected", () => {
    expect(fs.existsSync(path.join(dir, "installation-id"))).toBe(false);
    expect(app.docker.installationId).toBe("0123abcd");
  });
});

describe("one check per operation, and the command runs on what the check returned", () => {
  const ANOTHER = "ffff0000";
  const refusal = () =>
    new SandboxRefusedError([{ kind: "container", sandbox: "mcpe-demo", cls: "another", owner: ANOTHER, project: "github:owner/demo" }], "0123abcd");
  const unavailable = () => new DockerUnavailableError("Docker could not be asked about the sandbox: the daemon is not answering");

  /** Each tool that runs a command in the sandbox, as a call to make and a way to see that nothing ran. */
  const operations: Array<[string, () => Promise<Awaited<ReturnType<App["callTool"]>>>]> = [
    ["a generated command-line tool", () => app.callTool("demo__demo_build", {})],
    ["call_project_tool", () => app.callTool("call_project_tool", { tool: "demo__demo_build", arguments: {} })],
    ["sandbox_exec", () => app.callTool("sandbox_exec", { project: "demo", command: "ls" })],
    ["sandbox_read_file", () => app.callTool("sandbox_read_file", { project: "demo", path: "a.txt" })],
    ["sandbox_write_file", () => app.callTool("sandbox_write_file", { project: "demo", path: "a.txt", content: "x" })],
  ];

  it.each(operations)("%s: acquires once and runs its one command on that very reference", async (_n, call) => {
    await call();
    expect(docker.ensureCalls).toEqual(["mcpe-demo"]);
    expect(docker.acquired).toHaveLength(1);
    expect(docker.calls).toHaveLength(1);
    expect(docker.calls[0]!.container).toBe("mcpe-demo");
    expect(docker.calls[0]!.sandbox).toBe(docker.acquired[0]);
    expect(docker.calls[0]!.sandbox!.id).toBe(fakeSandboxId("mcpe-demo"));
  });

  it("set_project_network: acquires once, then sets the network on that reference", async () => {
    await app.callTool("set_project_network", { project: "demo", enabled: true });
    expect(docker.ensureCalls).toEqual(["mcpe-demo"]);
    expect(docker.network).toEqual([["mcpe-demo", true]]);
    expect(docker.networkRefs).toEqual([docker.acquired[0]]);
    expect(docker.networkRefs[0]).toBeDefined();
    expect(docker.calls).toEqual([]);
  });

  it("a proxied tool: the server checks once, and a session that has to be opened checks again by name", async () => {
    docker.next = { code: 1 };
    await app.callTool("connect_mcp_server", { project: "demo", command: ["node", "server.js"] });
    docker.ensureCalls = [];
    docker.acquired = [];
    docker.calls = [];
    expect(body(await app.callTool("demo__add", { a: 1, b: 2 }))).toBe("3");
    expect(docker.ensureCalls).toEqual(["mcpe-demo"]); // the session was open: the server's one check
    await app.proxy.closeProject("mcpe-demo");
    docker.ensureCalls = [];
    docker.acquired = [];
    up.launches.length = 0;
    expect(body(await app.callTool("demo__add", { a: 1, b: 2 }))).toBe("3");
    expect(docker.ensureCalls).toEqual(["mcpe-demo", "mcpe-demo"]); // the server's, and the session's own
    expect(up.launches).toHaveLength(1);
    expect(up.launches[0]!.container).toBe("mcpe-demo");
    expect(up.launches[0]!.sandbox).toBe(docker.acquired[1]);
  });

  describe.each([
    ["another installation's", refusal, new RegExp(`mcpe-demo[^]*${ANOTHER}`)],
    ["not answering (Docker could not be asked)", unavailable, /Docker could not be asked about the sandbox: the daemon is not answering/],
  ] as const)("when the sandbox is %s", (_label, make, message) => {
    it.each([...operations, ["set_project_network", () => app.callTool("set_project_network", { project: "demo", enabled: true })] as const])(
      "%s returns that error's own message, never the reinstall advice, and runs nothing",
      async (_n, call) => {
        docker.acquireError = make();
        const res = await call();
        expect(res.isError).toBe(true);
        expect(body(res)).toBe(`Error: ${docker.acquireError.message}`);
        expect(body(res)).toMatch(message);
        expect(body(res)).not.toMatch(/no longer exists|reinstall/);
        expect(docker.calls).toEqual([]);
        expect(docker.network).toEqual([]);
        expect(app.registry.get("demo")!.network).toBe(false);
      },
    );
  });

  it("a sandbox that is not there still gives the reinstall advice, word for word", async () => {
    docker.exists = false;
    const res = await app.callTool("sandbox_exec", { project: "demo", command: "ls" });
    expect(body(res)).toBe(
      'Error: The sandbox for demo no longer exists. Rebuild it with install_project(repo: "github:owner/demo", reinstall: true).',
    );
    expect(docker.calls).toEqual([]);
  });

  describe("uninstall_project", () => {
    it("fails with the error and keeps the record when Docker could not be asked", async () => {
      docker.destroyError = unavailable();
      const res = await app.callTool("uninstall_project", { project: "demo" });
      expect(res.isError).toBe(true);
      expect(body(res)).toBe(`Error: ${docker.destroyError.message}`);
      expect(app.registry.get("demo")).toBeDefined();
      expect(app.registry.list().map((p) => p.slug)).toEqual(["demo"]);
      expect(docker.destroyed).toEqual([]);
    });
  });
});

describe("refusal outcomes: uninstall_project and project_info", () => {
  const OTHER = "deadbeef";
  const part = (kind: "container" | "volume", sandbox: string, cls: "mine" | "another" | "before" | "not-ours", owner?: string) => ({ kind, sandbox, cls, owner });
  const refused = (...facts: ReturnType<typeof part>[]) => new SandboxRefusedError(facts, "0123abcd");
  const line = (info: string) => info.split("\n").filter((l) => l.startsWith("Sandbox owner:"));

  describe("uninstall_project", () => {
    it("lets go of a sandbox that is another's and one volume that is this installation's, and says which is which", async () => {
      docker.destroyError = refused(part("container", "mcpe-demo", "another", OTHER), part("volume", "mcpe-demo", "mine"));
      const res = await app.callTool("uninstall_project", { project: "demo" });
      expect(res.isError).toBe(false);
      const out = body(res);
      expect(out).toBe(
        'Removed demo (github:owner/demo) and its tools. Its sandbox was left in place, because it is not this installation\'s to remove: container "mcpe-demo" is another installation\'s (owner label "deadbeef"); volume "mcpe-demo" is this installation\'s. Nothing was removed from Docker; a part that is not wanted must be removed by hand there.',
      );
      expect(out).not.toContain("and its sandbox.");
      expect(app.registry.get("demo")).toBeUndefined();
      expect(app.listTools().map((t) => t.name)).not.toContain("demo__demo_build");
      expect(docker.destroyed).toEqual([]);
    });

    it.each([
      ["only a container", [part("container", "mcpe-demo", "another", OTHER)], 'container "mcpe-demo" is another installation\'s (owner label "deadbeef")', "volume"],
      ["a container that is not ours", [part("container", "mcpe-demo", "not-ours")], 'container "mcpe-demo" was not created by mcp-everything', "volume"],
      ["a volume made before ownership was recorded", [part("container", "mcpe-demo", "not-ours"), part("volume", "mcpe-demo", "before")], 'volume "mcpe-demo" was made before ownership was recorded', undefined],
    ])("names each part that exists: %s", async (_n, facts, expected, absent) => {
      docker.destroyError = refused(...facts);
      const out = body(await app.callTool("uninstall_project", { project: "demo" }));
      expect(out).toContain(expected);
      if (absent) expect(out).not.toContain(absent);
      expect(app.registry.get("demo")).toBeUndefined();
    });

    it("flattens an owner label to one line and cuts it", async () => {
      docker.destroyError = refused(part("container", "mcpe-demo", "another", `ab\r\ncd${"x".repeat(500)}`));
      const out = body(await app.callTool("uninstall_project", { project: "demo" }));
      expect(out.split("\n")).toHaveLength(1);
      expect(out).toContain('owner label "ab cdxxxxxxxx');
      expect(out.length).toBeLessThan(500);
      expect(out).not.toContain("x".repeat(60));
    });

    it("is word for word what it was when the sandbox was removed", async () => {
      expect(body(await app.callTool("uninstall_project", { project: "demo" }))).toBe("Removed demo (github:owner/demo) and its sandbox.");
    });

    it.each([
      ["Docker could not be asked", new DockerUnavailableError("Docker could not be asked")],
      ["a plain error from the removal", new Error("Failed to remove container mcpe-demo: busy")],
    ])("fails and keeps the record for %s", async (_n, failure) => {
      docker.destroyError = failure;
      const res = await app.callTool("uninstall_project", { project: "demo" });
      expect(res.isError).toBe(true);
      expect(body(res)).toBe(`Error: ${failure.message}`);
      expect(app.registry.get("demo")).toBeDefined();
    });

    it("says in the tool's description what it leaves and when it fails", () => {
      const d = app.listTools().find((t) => t.name === "uninstall_project")!.description as string;
      expect(d).toMatch(/another installation's/);
      expect(d).toMatch(/not created by mcp-everything/);
      expect(d).toMatch(/left in Docker/);
      expect(d).toMatch(/Docker cannot be asked|removal fails/);
    });
  });

  describe("project_info", () => {
    it.each([
      [{ state: "mine" }, 'Sandbox owner: container "mcpe-demo" is this installation\'s (0123abcd).'],
      [{ state: "before" }, 'Sandbox owner: container "mcpe-demo" was made before ownership was recorded; it is treated as this installation\'s.'],
      [{ state: "another", owner: "deadbeef" }, 'Sandbox owner: container "mcpe-demo" is another installation\'s (owner label "deadbeef"); this installation will not act on it.'],
      [{ state: "not-ours" }, 'Sandbox owner: container "mcpe-demo" was not created by mcp-everything; this installation will not act on it.'],
      [{ state: "missing" }, 'Sandbox owner: container "mcpe-demo" does not exist in Docker.'],
      [{ state: "unavailable" }, "Sandbox owner: could not be checked, because Docker did not answer."],
    ] as const)("says %j in one line, after the description, from one question", async (result, expected) => {
      docker.ownershipResult = { ...result };
      const info = body(await app.callTool("project_info", { project: "demo" }));
      expect(line(info)).toEqual([expected]);
      expect(info).toContain("tools published (1)"); // the description is all there
      expect(info.indexOf("Sandbox owner:")).toBeGreaterThan(info.indexOf("tools published"));
      expect(docker.ownershipCalls).toEqual(["mcpe-demo"]);
      expect(docker.calls).toEqual([]);
    });

    it("flattens and cuts another installation's owner label", async () => {
      docker.ownershipResult = { state: "another", owner: `a\nb${"y".repeat(300)}` };
      const out = line(body(await app.callTool("project_info", { project: "demo" })));
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('owner label "a byyyyyyy');
      expect(out[0]!.length).toBeLessThan(200);
    });

    it("cuts an owner label to the same length as the Docker layer and the installer", async () => {
      docker.ownershipResult = { state: "another", owner: "x".repeat(300) };
      const out = line(body(await app.callTool("project_info", { project: "demo" })));
      expect(out[0]).toContain(`owner label "${"x".repeat(OWNER_SHOWN - 1)}…"`);
    });

    it("never fails because of that question: the inspect fails and the tool still succeeds", async () => {
      docker.ownershipError = new Error("inspect blew up");
      const res = await app.callTool("project_info", { project: "demo" });
      expect(res.isError).toBe(false);
      expect(line(body(res))).toEqual(["Sandbox owner: could not be checked, because Docker did not answer."]);
      expect(body(res)).toContain("tools published (1)");
    });

    it("says the sandbox is being built, and asks nothing, while an install of the project runs here", async () => {
      let finish!: () => void;
      const gate = new Promise<void>((r) => (finish = r));
      (app.installer as unknown as { install: unknown }).install = async () => {
        await gate;
        return { ...record("demo"), status: "ready" };
      };
      await app.callTool("install_project", { repo: "owner/demo", wait_seconds: 0 });
      const info = body(await app.callTool("project_info", { project: "demo" }));
      expect(line(info)).toEqual(["Sandbox owner: the sandbox is being built by an install running here; it was not checked."]);
      expect(info).toContain("Install in progress");
      expect(docker.ownershipCalls).toEqual([]);
      finish();
      await new Promise((r) => setTimeout(r, 5));
      expect(line(body(await app.callTool("project_info", { project: "demo" })))).toHaveLength(1);
      expect(docker.ownershipCalls).toEqual(["mcpe-demo"]);
    });

    it("asks for a record that says installing when no install is running here (another session's, or a dead one)", async () => {
      app.registry.put({ ...record("demo"), status: "installing" });
      docker.ownershipResult = { state: "missing" };
      const info = body(await app.callTool("project_info", { project: "demo" }));
      expect(line(info)).toEqual(['Sandbox owner: container "mcpe-demo" does not exist in Docker.']);
      expect(info).toContain("started by another session or was interrupted");
      expect(docker.ownershipCalls).toEqual(["mcpe-demo"]);
    });

    it("speaks of the container only", async () => {
      docker.ownershipResult = { state: "mine" };
      expect(line(body(await app.callTool("project_info", { project: "demo" }))).join("")).not.toMatch(/volume/);
    });

    it("says in the tool's description that it asks Docker about the sandbox's owner", () => {
      const d = app.listTools().find((t) => t.name === "project_info")!.description as string;
      expect(d).toMatch(/whose the project's sandbox container is/);
    });
  });

  describe("no other tool asks", () => {
    it("list_projects and the result of an install issue no ownership question and no Docker command", async () => {
      expect(body(await app.callTool("list_projects", {}))).not.toContain("Sandbox owner");
      (app.installer as unknown as { install: unknown }).install = async () => ({ ...record("demo"), status: "ready" });
      const res = await app.callTool("install_project", { repo: "owner/demo" });
      expect(res.isError).toBe(false);
      expect(body(res)).not.toContain("Sandbox owner");
      expect(docker.ownershipCalls).toEqual([]);
      expect(docker.calls).toEqual([]);
      expect(docker.ensureCalls).toEqual([]);
    });
  });
});
