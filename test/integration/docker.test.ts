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
// The fork-pressure cases are slow, so they are opt-in on their own switch.
const pressureEnabled = enabled && process.env.MCPE_PRESSURE_TESTS === "1";
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

/**
 * Idle stopping with a 6 s timeout (poll 1 s): a sandbox stops between 6 and
 * about 9 s after its last activity. "Never stopped" means .State.StartedAt is
 * unchanged, since Docker.exec would quietly restart a wrongly stopped sandbox.
 */
describe.skipIf(!enabled)("docker integration: sandbox idle timeout", () => {
  const IDLE = 6;
  const POLL = 1;
  const STOP_DEADLINE_MS = (IDLE + 15) * 1000;
  const names: Array<{ name: string; volume: string }> = [];
  let dir: string;
  let cfg: ReturnType<typeof loadConfig>;
  let docker: Docker;
  let n = 0;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const inspect = async (name: string, format: string) =>
    (await run("docker", ["inspect", "--format", format, name], { timeoutMs: 30_000 })).stdout.trim();
  const startedAt = (name: string) => inspect(name, "{{.State.StartedAt}}");

  async function create(d: Docker = docker): Promise<string> {
    const name = `${prefix}idle-${++n}`;
    names.push({ name, volume: name });
    const vol = await run("docker", ["volume", "create", "--label", "mcp-everything=1", name], { timeoutMs: 30_000 });
    expect(vol.code).toBe(0);
    await d.createContainer({ name, volume: name, image: cfg.docker.images.generic, project: "idle-test" });
    return name;
  }
  async function waitStopped(name: string): Promise<void> {
    const deadline = Date.now() + STOP_DEADLINE_MS;
    while (Date.now() < deadline) {
      if ((await docker.state(name)) === "stopped") return;
      await sleep(500);
    }
    throw new Error(`${name} was still running after ${STOP_DEADLINE_MS} ms`);
  }
  const sh = (name: string, script: string, stdin?: string) =>
    docker.exec(name, ["sh", "-c", script], { timeoutSec: 30, stdin });

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-it-idle-"));
    cfg = loadConfig({
      ...process.env,
      MCPE_DATA_DIR: dir,
      MCPE_NAME_PREFIX: prefix,
      MCPE_SANDBOX_IDLE_TIMEOUT: String(IDLE),
    });
    docker = new Docker(cfg);
  }, 30_000);

  afterAll(async () => {
    for (const { name, volume } of names) await docker.destroy(name, volume).catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("stops an idle sandbox, keeps its files, and restarts it on the next exec", async () => {
    const name = await create();
    expect((await sh(name, "mkdir -p /opt/mcpe/bin /workspace/work && echo tool > /opt/mcpe/bin/t && echo data > /workspace/work/w")).code).toBe(0);
    await docker.setNetwork(name, false);
    expect(await inspect(name, "{{index .Config.Labels \"mcp-everything.idle-timeout\"}}")).toBe(String(IDLE));

    await waitStopped(name);
    expect(await inspect(name, "{{.State.ExitCode}}")).toBe("0");
    expect(await docker.hasNetwork(name)).toBe(false);

    expect(await docker.ensureRunning(name)).toBe(true);
    expect(await docker.state(name)).toBe("running");
    expect(await docker.hasNetwork(name)).toBe(false);
    const after = await sh(name, "cat /opt/mcpe/bin/t /workspace/work/w; ls /sys/class/net");
    expect(after.stdout.trim().split("\n")).toEqual(["tool", "data", "lo"]);

    // An exec against the stopped sandbox restarts it on the way.
    await waitStopped(name);
    const res = await sh(name, "cat /workspace/work/w");
    expect(res).toMatchObject({ code: 0, stdout: "data\n" });
  }, 120_000);

  it("keeps a network-enabled sandbox online, and applies setNetwork while stopped", async () => {
    const name = await create();
    await waitStopped(name);
    await docker.ensureRunning(name);
    expect(await docker.hasNetwork(name)).toBe(true);

    await waitStopped(name);
    await docker.setNetwork(name, false);
    expect(await docker.state(name)).toBe("stopped");
    await docker.ensureRunning(name);
    expect(await docker.hasNetwork(name)).toBe(false);
    expect((await sh(name, "ls /sys/class/net")).stdout.trim()).toBe("lo");
  }, 120_000);

  it("does not stop a sandbox during an exec longer than the timeout", async () => {
    const name = await create();
    const before = await startedAt(name);
    const res = await docker.exec(name, ["sleep", String(IDLE + 2 * POLL + 1 + 2)], { timeoutSec: 60 });
    expect(res.code).toBe(0);
    expect(await startedAt(name)).toBe(before);
  }, 60_000);

  it("does not stop a sandbox used by short execs between polls", async () => {
    const name = await create();
    const before = await startedAt(name);
    for (let i = 0; i < 6; i++) {
      expect((await docker.exec(name, ["true"], { timeoutSec: 10 })).code).toBe(0);
      await sleep(3000);
    }
    expect(await startedAt(name)).toBe(before);
  }, 60_000);

  it("keeps the sandbox up while a proxied MCP server is open, and lets it stop after", async () => {
    const name = await create();
    expect((await sh(name, "mkdir -p /workspace/work && cat > /workspace/work/sh-mcp.sh", SH_MCP_SERVER)).code).toBe(0);
    const before = await startedAt(name);
    const proxy = new McpProxy(cfg, docker);
    try {
      const tools = await proxy.listTools(name, {
        name: "sh-mcp",
        argv: ["sh", "/workspace/work/sh-mcp.sh"],
        cwd: "/workspace/work",
        env: {},
        origin: "registered",
      });
      expect(tools.map((t) => t.name)).toContain("whereami");
      await sleep((IDLE + 2 * POLL + 1) * 1000);
      expect(await docker.state(name)).toBe("running");
      expect(await startedAt(name)).toBe(before);
    } finally {
      await proxy.closeAll();
    }
    await waitStopped(name);
  }, 90_000);

  it("keeps sleep infinity when the timeout is 0", async () => {
    const off = new Docker(loadConfig({ ...process.env, MCPE_DATA_DIR: dir, MCPE_NAME_PREFIX: prefix, MCPE_SANDBOX_IDLE_TIMEOUT: "0" }));
    const name = await create(off);
    const before = await startedAt(name);
    await sleep(12_000);
    expect(await docker.state(name)).toBe("running");
    expect(await startedAt(name)).toBe(before);
    expect(await inspect(name, "{{json .Config.Entrypoint}} {{json .Config.Cmd}}")).toBe('["sleep"] ["infinity"]');
    expect(await inspect(name, "{{index .Config.Labels \"mcp-everything.idle-timeout\"}}")).toBe("0");
  }, 60_000);
});

/**
 * A sandbox held at its process limit (24) by processes that keep forking must
 * not lose its watchdog: a failed fork of the watchdog's sleep used to exit it
 * and stop the container. Each case starts one self-ending pressure exec, waits
 * for the watchdog's one-line warning (proof that a fork actually failed), then
 * checks the sandbox was never stopped or restarted and idle-stops afterwards.
 * Docker.exec would restart a stopped sandbox, hence restart: false throughout.
 *
 * Opt-in: skipped unless MCPE_PRESSURE_TESTS=1 is set as well as
 * MCPE_DOCKER_TESTS=1 (`npm run test:docker:pressure`). The cases are slow (about
 * 30 s each) because they hold a sandbox at its process limit. Run them whenever
 * the watchdog script in src/sandbox/docker.ts or these cases change.
 */
describe.skipIf(!pressureEnabled)("docker integration: sandbox at its process limit", () => {
  const IDLE = 6;
  const WARNING = "watchdog: cannot fork (process limit reached); retrying";
  const WARN_DEADLINE_MS = 30_000;
  const STOP_DEADLINE_MS = (IDLE + 15) * 1000;
  const names: Array<{ name: string; volume: string }> = [];
  let dir: string;
  let cfg: ReturnType<typeof loadConfig>;
  let docker: Docker;
  let n = 0;

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const inspect = async (name: string, format: string) =>
    (await run("docker", ["inspect", "--format", format, name], { timeoutMs: 30_000 })).stdout.trim();
  const logs = async (name: string) => {
    const res = await run("docker", ["logs", name], { timeoutMs: 30_000 });
    return res.stdout + res.stderr;
  };
  const count = (haystack: string, needle: string) => haystack.split(needle).length - 1;

  async function create(image: string): Promise<string> {
    const name = `${prefix}fork-${++n}`;
    names.push({ name, volume: name });
    const vol = await run("docker", ["volume", "create", "--label", "mcp-everything=1", name], { timeoutMs: 30_000 });
    expect(vol.code).toBe(0);
    await docker.createContainer({ name, volume: name, image, project: "fork-test" });
    return name;
  }

  async function pressureCase(shell: string, image: string, argv: string[]): Promise<void> {
    const name = await create(image);
    const before = await inspect(name, "{{.State.StartedAt}}");
    const started = Date.now();
    // Never rejects, so it can be awaited on every path.
    const pressure = docker
      .exec(name, argv, { timeoutSec: 30, restart: false })
      .then((r) => r as unknown, (e) => ({ error: String(e) }));
    let pressureResult: unknown = "(pressure exec still running)";
    const diagnostics = async () =>
      `${name}: exit code ${await inspect(name, "{{.State.ExitCode}}")}, OOMKilled ${await inspect(name, "{{.State.OOMKilled}}")}, ` +
      `state ${await inspect(name, "{{.State.Status}}")}, run ${n}\n` +
      `pressure exec: ${JSON.stringify(pressureResult)}\nlogs:\n${await logs(name)}`;
    try {
      let seen = false;
      const deadline = started + WARN_DEADLINE_MS;
      while (Date.now() < deadline) {
        if ((await logs(name)).includes(WARNING)) {
          seen = true;
          break;
        }
        await sleep(250);
      }
      const took = Date.now() - started;
      console.log(`fork-pressure ${shell}: warning ${seen ? `after ${took} ms` : `not seen within ${took} ms`}`);
      if (!seen) {
        pressureResult = await Promise.race([pressure, sleep(15_000).then(() => "(pressure exec still running)")]);
        throw new Error(`the warning never appeared, so the pressure did not reach the watchdog or the watchdog died\n${await diagnostics()}`);
      }
    } finally {
      pressureResult = await pressure;
    }
    const diag = await diagnostics();
    expect(await docker.state(name), diag).toBe("running");
    expect(await inspect(name, "{{.State.StartedAt}}"), diag).toBe(before);
    expect(count(await logs(name), WARNING), diag).toBe(1);

    const deadline = Date.now() + STOP_DEADLINE_MS;
    while (Date.now() < deadline && (await docker.state(name)) !== "stopped") await sleep(500);
    const after = await diagnostics();
    expect(await docker.state(name), after).toBe("stopped");
    expect(await inspect(name, "{{.State.ExitCode}}"), after).toBe("0");
  }

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-it-fork-"));
    cfg = loadConfig({
      ...process.env,
      MCPE_DATA_DIR: dir,
      MCPE_NAME_PREFIX: prefix,
      MCPE_SANDBOX_IDLE_TIMEOUT: String(IDLE),
      MCPE_PIDS_LIMIT: "24",
    });
    docker = new Docker(cfg);
  }, 30_000);

  afterAll(async () => {
    for (const { name, volume } of names) await docker.destroy(name, volume).catch(() => undefined);
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("keeps a Debian (dash) sandbox running under fork pressure, then idle-stops it", { timeout: 120_000 }, async () => {
    await pressureCase("dash", cfg.docker.images.generic, [
      "perl",
      "-e",
      `$SIG{CHLD}="IGNORE"; my $end=time+8; while(time<$end){ my $p=fork(); if(defined $p && $p==0){ sleep 2; exit 0 } }`,
    ]);
  });

  it("keeps a busybox sandbox running under fork pressure, then idle-stops it", { timeout: 120_000 }, async () => {
    await pressureCase("busybox", cfg.docker.probeImage, [
      "sh",
      "-c",
      `for k in 1 2 3 4 5 6; do awk 'BEGIN{e=systime()+8; while(systime()<e) system("sleep 1 &")}' >/dev/null 2>&1 & done; wait`,
    ]);
  });
});
