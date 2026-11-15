import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { Docker, parseProbeOutput, type ExecOptions, type ExecResult } from "../src/sandbox/docker.js";
import { App } from "../src/server.js";
import type { ProjectRecord, ToolDef } from "../src/types.js";
import { record } from "./helpers.js";

interface ExecCall {
  container: string;
  argv: string[];
  opts: ExecOptions;
}

/** Docker double: records what would run and replays canned results. */
class FakeDocker extends Docker {
  calls: ExecCall[] = [];
  next: Partial<ExecResult> = {};
  exists = true;
  network: Array<[string, boolean]> = [];
  destroyed: string[] = [];

  override async exec(container: string, argv: string[], opts: ExecOptions): Promise<ExecResult> {
    this.calls.push({ container, argv, opts });
    return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false, ...this.next };
  }
  override async ensureRunning(): Promise<boolean> {
    return this.exists;
  }
  override async setNetwork(container: string, enabled: boolean): Promise<void> {
    this.network.push([container, enabled]);
  }
  override async destroy(container: string): Promise<void> {
    this.destroyed.push(container);
  }
}

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
let app: App;

function seed(...records: ProjectRecord[]): void {
  for (const r of records) app.registry.put(r);
}
const body = (res: Awaited<ReturnType<App["callTool"]>>) => (res.content[0] as { text: string }).text;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-srv-"));
  const cfg = loadConfig({ HOME: dir, MCPE_DATA_DIR: dir });
  docker = new FakeDocker(cfg);
  app = new App({ cfg, docker });
  seed({ ...record("demo"), tools: [tool], commands: [{ name: "demo", origin: "test" }] });
});
afterEach(() => {
  app.stop();
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
    expect(body(await app.callTool("list_projects", {}))).toMatch(/^demo — github:owner\/demo \(ready\)[\s\S]*tools: 1$/);
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
