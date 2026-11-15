import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { parseProbeOutput } from "../src/sandbox/docker.js";
import { App } from "../src/server.js";
import type { ProjectRecord, ToolDef } from "../src/types.js";
import { McpProxy } from "../src/proxy/mcp-proxy.js";
import { FakeDocker, fakeUpstream, record, type FakeUpstream } from "./helpers.js";

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
    expect(body(await app.callTool("list_projects", {}))).toMatch(/^demo — github:owner\/demo \(ready\)[\s\S]*tools: 1 published$/);
    const info = body(await app.callTool("project_info", { project: "owner/demo" }));
    expect(info).toContain("demo__demo_build: [sandboxed github:owner/demo] Runs `demo build`.");
    expect(info).toContain("arguments: release");
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
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      changed++;
    });
    await Promise.all([app.server.connect(serverSide), client.connect(clientSide)]);

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
