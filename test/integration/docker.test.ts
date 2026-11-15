import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { parseRepoRef } from "../../src/forge/repo-ref.js";
import { Installer } from "../../src/install/installer.js";
import { McpProxy } from "../../src/proxy/mcp-proxy.js";
import { Registry } from "../../src/registry.js";
import { Docker, type ExecOptions, type ExecResult } from "../../src/sandbox/docker.js";
import { App } from "../../src/server.js";
import { run } from "../../src/util/exec.js";

/**
 * End-to-end against a real Docker daemon and github.com. Opt in with
 * MCPE_DOCKER_TESTS=1 (npm run test:docker). Uses its own name prefix and data
 * directory, so it never touches real installs.
 */
const enabled = process.env.MCPE_DOCKER_TESTS === "1";
const prefix = `mcpe-it-${process.pid}-`;
const text = (res: Awaited<ReturnType<App["callTool"]>>) => (res.content[0] as { text: string }).text;

/**
 * A minimal stdio MCP server in POSIX shell, so the proxy can be tested end to
 * end without installing a third-party MCP project. It echoes back the
 * protocol version the client asks for.
 */
const SH_MCP_SERVER = String.raw`#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      ver=$(printf '%s' "$line" | sed -n 's/.*"protocolVersion":"\([^"]*\)".*/\1/p')
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"%s","capabilities":{"tools":{}},"serverInfo":{"name":"sh-mcp","version":"1"}}}\n' "$id" "$ver";;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"whereami","description":"Report where this server runs","inputSchema":{"type":"object","properties":{}}},{"name":"stall","description":"Never answers","inputSchema":{"type":"object","properties":{}}}]}}\n' "$id";;
    *'"name":"whereami"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"host=%s cwd=%s greeting=%s arg=%s"}]}}\n' "$id" "$(hostname)" "$(pwd)" "$GREETING" "$1";;
    *'"name":"stall"'*)
      sleep 300;;
  esac
done
`;

describe.skipIf(!enabled)("docker integration", () => {
  let dir: string;
  let app: App;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-it-"));
    app = new App({
      cfg: loadConfig({ ...process.env, MCPE_DATA_DIR: dir, MCPE_NAME_PREFIX: prefix, MCPE_TOOL_TIMEOUT: "5" }),
    });
  });

  afterAll(async () => {
    if (!app) return;
    await app.shutdown();
    for (const p of app.registry.list()) await app.installer.uninstall(p);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("installs a Go CLI, generates a typed tool and runs it offline", async () => {
    const installed = await app.callTool("install_project", { repo: "tomnomnom/gron" });
    expect(text(installed)).toMatch(/gron — github:tomnomnom\/gron \(ready\)/);
    expect(installed.isError).toBe(false);

    const project = app.registry.get("gron")!;
    expect(project.container).toBe(`${prefix}gron`);
    expect(project.commit).toMatch(/^[0-9a-f]{40}$/);
    const tool = project.tools.find((t) => t.name === "gron__gron")!;
    expect(tool.options.map((o) => o.flag)).toContain("--ungron");

    const out = await app.callTool("gron__gron", { stdin: '{"a":[1,2]}' });
    expect(text(out)).toContain("json.a[1] = 2;");

    const net = await app.callTool("sandbox_exec", {
      project: "gron",
      command: "getent hosts github.com >/dev/null && echo UP || echo DOWN",
    });
    expect(text(net)).toContain("DOWN");

    const again = await app.callTool("install_project", { repo: "https://github.com/tomnomnom/gron" });
    expect(text(again)).toMatch(/\(ready\)/);
    expect(app.registry.list()).toHaveLength(1);
  }, 600_000);

  it("kills commands that exceed their timeout, inside the container", async () => {
    const res = await app.callTool("sandbox_exec", { project: "gron", command: "sleep 60", timeout_seconds: 2 });
    expect(text(res)).toMatch(/^Timed out after 2s/);
    const ps = await run("docker", ["exec", `${prefix}gron`, "sh", "-c", "ps -eo args | grep -c '[s]leep 60' || true"]);
    expect(ps.stdout.trim()).toBe("0");
  }, 60_000);

  it("reports a clone failure as a failed install, not a crash", async () => {
    const res = await app.callTool("install_project", { repo: "tomnomnom/this-repo-does-not-exist-zzz" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/\(failed\)[\s\S]*Could not clone[\s\S]*Nothing was installed/);
    expect(app.registry.list().map((p) => p.slug)).toEqual(["gron"]);
  }, 120_000);

  it("proxies an MCP server running inside the sandbox", async () => {
    await app.callTool("sandbox_write_file", { project: "gron", path: "sh-mcp.sh", content: SH_MCP_SERVER });
    const connected = await app.callTool("connect_mcp_server", {
      project: "gron",
      name: "shmcp",
      command: ["sh", "/workspace/work/sh-mcp.sh", "argone"],
      env: { GREETING: "hello there" },
      cwd: "/workspace/work",
    });
    expect(text(connected)).toMatch(/^Connected MCP server "shmcp" of gron: 2 tool\(s\) published/);
    expect(connected.isError).toBe(false);
    // The env file handed to `docker exec` is gone once the server is up.
    expect(fs.readdirSync(path.join(dir, "tmp"))).toEqual([]);

    const where = await app.callTool("gron__whereami", {});
    expect(text(where)).toBe("host=sandbox cwd=/workspace/work greeting=hello there arg=argone");

    // The command line tool generated earlier is still there next to it.
    expect(text(await app.callTool("gron__gron", { stdin: "[1]" }))).toContain("json[0] = 1;");

    const ps = () => run("docker", ["exec", `${prefix}gron`, "sh", "-c", "ps -eo args | grep -E '[s]h-mcp|[s]leep 300' || true"]);
    expect((await ps()).stdout).toContain("sh-mcp.sh");

    // A call that never returns: the server and its child are killed in the sandbox.
    const stalled = await app.callTool("gron__stall", {});
    expect(stalled.isError).toBe(true);
    expect(text(stalled)).toMatch(/timed out after 5s; the server was stopped/);
    expect((await ps()).stdout.trim()).toBe("");

    // ...and the next call starts it again.
    expect(text(await app.callTool("gron__whereami", {}))).toContain("host=sandbox");

    await app.callTool("disconnect_mcp_server", { project: "gron", name: "shmcp" });
    expect((await ps()).stdout.trim()).toBe("");
    expect(app.registry.get("gron")!.tools.map((t) => t.name)).toEqual(["gron__gron"]);
  }, 120_000);

  it("uninstall removes the container and the volume", async () => {
    await app.callTool("uninstall_project", { project: "gron" });
    const c = await run("docker", ["inspect", `${prefix}gron`]);
    const v = await run("docker", ["volume", "inspect", `${prefix}gron`]);
    expect(c.code).not.toBe(0);
    expect(v.code).not.toBe(0);
  }, 60_000);
});

/**
 * Real Docker, except that the first build is made to fail softly after
 * leaving debris behind, to exercise the rebuild-on-another-image path.
 */
class FailsFirstBuild extends Docker {
  private builds = 0;
  override async exec(container: string, argv: string[], opts: ExecOptions): Promise<ExecResult> {
    if (argv[0] === "sh" && argv[2]?.includes("soft_fail()") && this.builds++ === 0) {
      const debris = "touch /workspace/repo/DEBRIS && mkdir -p /opt/mcpe/bin && touch /opt/mcpe/bin/stale && chmod +x /opt/mcpe/bin/stale";
      await super.exec(container, ["sh", "-c", debris], { timeoutSec: 30 });
      return { code: 0, stdout: "MCPE_SOFT_FAIL\nMCPE_WARN simulated build failure\n", stderr: "", timedOut: false, truncated: false };
    }
    return super.exec(container, argv, opts);
  }
}

describe.skipIf(!enabled)("docker integration: rebuilding on another image", () => {
  it("replaces the container, cleans the checkout and builds again", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-it-retry-"));
    const cfg = loadConfig({ ...process.env, MCPE_DATA_DIR: dir, MCPE_NAME_PREFIX: `${prefix}retry-` });
    const docker = new FailsFirstBuild(cfg);
    const registry = new Registry(dir);
    // Both "versions" are the same image: what is under test is the mechanics.
    const installer = new Installer(cfg, docker, registry, new McpProxy(cfg, docker), () => ({
      image: "golang:1",
      fallbacks: ["golang:1"],
      reason: "test",
    }));
    try {
      const record = await installer.install({ repo: parseRepoRef("tomnomnom/gron", cfg.hosts) });
      expect(record.status).toBe("ready");
      expect(record.warnings).toContain("The build did not succeed on golang:1 (simulated build failure); it was rebuilt on golang:1.");
      expect(record.tools.map((t) => t.name)).toContain("gron__gron");

      const state = await docker.exec(
        record.container,
        ["sh", "-c", "ls /opt/mcpe/bin; test -e /workspace/repo/DEBRIS && echo debris-left; git -C /workspace/repo status --porcelain | wc -l"],
        { timeoutSec: 30 },
      );
      // Only the real build's output: no stale binary from the first container,
      // no debris in the checkout, and a clean working tree.
      expect(state.stdout.trim().split("\n")).toEqual(["gron", "0"]);
    } finally {
      for (const p of registry.list()) await installer.uninstall(p);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
