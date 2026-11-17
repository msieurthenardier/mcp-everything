import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { parseRepoRef } from "../../src/forge/repo-ref.js";
import { Installer } from "../../src/install/installer.js";
import { McpProxy } from "../../src/proxy/mcp-proxy.js";
import { loadInstallationId } from "../../src/installation.js";
import { Registry } from "../../src/registry.js";
import { Docker, type ExecOptions, type ExecResult } from "../../src/sandbox/docker.js";
import { App } from "../../src/server.js";
import { run } from "../../src/util/exec.js";

/**
 * End-to-end against a real Docker daemon and github.com. Opt in with
 * MCPE_DOCKER_TESTS=1 (npm run test:docker). Uses its own name prefix and data
 * directory, so it never touches real installs.
 *
 * Finding what an interrupted run left behind. Most cases name their sandboxes
 * with the suite's prefix, `mcpe-it-<pid>-`. The two-installation cases do not:
 * they run with the default prefix, so their sandboxes are named
 * `mcpe-<id>-gron` with an id made for the run, which the run prints
 * ("two installations: ..."). Find them by owner label, not by name:
 *
 *   docker ps -a --filter label=mcp-everything=1 --format '{{.Names}}\t{{.Label "mcp-everything.owner"}}'
 *   docker volume ls --filter label=mcp-everything=1 --format '{{.Name}}\t{{.Label "mcp-everything.owner"}}'
 *
 * An empty owner is a sandbox from before ownership was recorded (an operator's
 * real one, as likely as not). A test installation's id is also in the file
 * `installation-id` of its data directory, `mcpe-it-two-*` under the system's
 * temporary directory, for as long as that directory exists. Remove only what
 * you have matched to an id this suite printed.
 */
const enabled = process.env.MCPE_DOCKER_TESTS === "1";
// The fork-pressure cases are slow, so they are opt-in on their own switch.
const pressureEnabled = enabled && process.env.MCPE_PRESSURE_TESTS === "1";
const prefix = `mcpe-it-${process.pid}-`;
const text = (res: Awaited<ReturnType<App["callTool"]>>) => (res.content[0] as { text: string }).text;

const HEX8 = /^[0-9a-f]{8}$/;

/** Whether `p` lies strictly inside the system's temporary directory. */
function isUnderTmp(p: string): boolean {
  if (typeof p !== "string" || !path.isAbsolute(p)) return false;
  const rel = path.relative(path.resolve(os.tmpdir()), path.resolve(p));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * The one check every removal in this file goes through. A name may be removed
 * only if it is `mcpe-<id>-gron` for one of the ids given (each of eight
 * hexadecimal characters), or begins with the suite's own prefix
 * `mcpe-it-<pid>-` and has something after it. A sandbox of the operator's is
 * named `mcpe-<slug>` or `mcpe-<their id>-<slug>`: neither passes, because the
 * ids given are the test installations' and the prefix carries this process's id.
 */
function mayRemove(name: string, ids: readonly string[]): boolean {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_.-]*$/.test(name)) return false;
  if (ids.some((id) => HEX8.test(id) && name === `mcpe-${id}-gron`)) return true;
  return name.startsWith(prefix) && name.length > prefix.length;
}

/** Throws unless `mayRemove`; the removals below call it first, so nothing else removes. */
function checkedForRemoval(name: string, ids: readonly string[]): string {
  if (!mayRemove(name, ids)) throw new Error(`refusing to remove ${JSON.stringify(name)}: not a sandbox this suite made`);
  return name;
}
async function removeContainerChecked(name: string, ids: readonly string[]): Promise<void> {
  await run("docker", ["rm", "-f", checkedForRemoval(name, ids)], { timeoutMs: 120_000 });
}
async function removeVolumeChecked(name: string, ids: readonly string[]): Promise<void> {
  await run("docker", ["volume", "rm", checkedForRemoval(name, ids)], { timeoutMs: 120_000 });
}

/** The name check's own assertions. They issue no Docker command. */
function assertNameCheckBehaves(): void {
  const ids = ["aaaaaaaa", "bbbbbbbb"];
  expect(mayRemove("mcpe-aaaaaaaa-gron", ids)).toBe(true);
  expect(mayRemove("mcpe-bbbbbbbb-gron", ids)).toBe(true);
  expect(mayRemove(`${prefix}before`, [])).toBe(true);
  expect(mayRemove(`${prefix}before`, ids)).toBe(true);
  // An operator's sandboxes, from before the change and after it.
  for (const name of ["mcpe-gron", "mcpe-rea", "mcpe-cowsay", "mcpe-ha_googlehome", "mcpe-12345678-gron"]) {
    expect(mayRemove(name, ids)).toBe(false);
    expect(mayRemove(name, [])).toBe(false);
  }
  // A third id, the right id with another slug, the empty string, a bare prefix, another process's prefix.
  for (const name of ["mcpe-cccccccc-gron", "mcpe-aaaaaaaa-rea", "mcpe-aaaaaaaa-gron-2", "mcpe-aaaaaaaa-", "", prefix, "mcpe-it-0-before", "gron", " mcpe-aaaaaaaa-gron"]) {
    expect(mayRemove(name, ids)).toBe(false);
  }
  // An id that is not eight hexadecimal characters never matches, even as its own name.
  expect(mayRemove("mcpe-AAAAAAAA-gron", ["AAAAAAAA"])).toBe(false);
  expect(mayRemove("mcpe--gron", [""])).toBe(false);
  expect(mayRemove("mcpe-aaaaaaaaa-gron", ["aaaaaaaaa"])).toBe(false);
  // No ids at all removes nothing of the two-installation kind.
  expect(mayRemove("mcpe-aaaaaaaa-gron", [])).toBe(false);
}

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

/**
 * A shell MCP server that starts only when MCPE_IT_GATE_Q7X2 is set (to
 * anything, an empty value included), and reports the value. It exits at once
 * when given an argument, so that help probing costs nothing, and at once
 * without the variable. Its own constant: the shell server above is shared by
 * other cases.
 */
const GATED_MCP_SERVER = String.raw`#!/bin/sh
[ "$#" -eq 0 ] || exit 2
printenv MCPE_IT_GATE_Q7X2 >/dev/null || exit 1
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      ver=$(printf '%s' "$line" | sed -n 's/.*"protocolVersion":"\([^"]*\)".*/\1/p')
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"%s","capabilities":{"tools":{}},"serverInfo":{"name":"gated","version":"1"}}}\n' "$id" "$ver";;
    *'"method":"tools/list"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"tools":[{"name":"reveal","description":"Report the gate variable","inputSchema":{"type":"object","properties":{}}}]}}\n' "$id";;
    *'"name":"reveal"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"content":[{"type":"text","text":"gate=%s"}]}}\n' "$id" "$MCPE_IT_GATE_Q7X2";;
  esac
done
`;

describe.skipIf(!enabled)("docker integration", () => {
  let dir: string;
  let cfg: ReturnType<typeof loadConfig>;
  let app: App;
  /** The first project's sandbox name, as its record gives it: prefix, installation id, slug. */
  let gron = "";

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-it-"));
    cfg = loadConfig({ ...process.env, MCPE_DATA_DIR: dir, MCPE_NAME_PREFIX: prefix, MCPE_TOOL_TIMEOUT: "5" });
    app = new App({ cfg });
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
    expect(project.container).toBe(`${prefix}${app.docker.installationId}-gron`);
    gron = project.container;
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
    const ps = await run("docker", ["exec", gron, "sh", "-c", "ps -eo args | grep -c '[s]leep 60' || true"]);
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

    const ps = () => run("docker", ["exec", gron, "sh", "-c", "ps -eo args | grep -E '[s]h-mcp|[s]leep 300' || true"]);
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

  it("gives a proxied MCP server the host environment's value, which is never stored or run elsewhere", async () => {
    // Neither value is a substring of the other.
    const HOST_VALUE = "from-the-host-Qz3kLx9Vb2N";
    const STORED_VALUE = "stored-in-registry-Pa6Ud1Fs0";
    const second = new App({
      cfg: loadConfig({ ...process.env, MCPE_DATA_DIR: dir, MCPE_NAME_PREFIX: prefix, MCPE_TOOL_TIMEOUT: "5" }),
      env: { gron__GREETING: HOST_VALUE },
    });
    try {
      // Written again here; this case does not rely on the previous one having left it.
      await second.callTool("sandbox_write_file", { project: "gron", path: "sh-mcp.sh", content: SH_MCP_SERVER });
      const connected = await second.callTool("connect_mcp_server", {
        project: "gron",
        name: "shenv",
        command: ["sh", "/workspace/work/sh-mcp.sh", "argtwo"],
        env: { GREETING: STORED_VALUE },
        cwd: "/workspace/work",
      });
      expect(connected.isError).toBe(false);
      expect(text(connected)).not.toContain(HOST_VALUE);

      const where = await second.callTool("gron__whereami", {});
      expect(text(where)).toBe(`host=sandbox cwd=/workspace/work greeting=${HOST_VALUE} arg=argtwo`);

      const registryFile = fs.readFileSync(path.join(dir, "registry.json"), "utf8");
      expect(registryFile).not.toContain(HOST_VALUE);
      expect(registryFile).toContain(STORED_VALUE); // presence: what was stored is still there
      expect(fs.readdirSync(path.join(dir, "tmp"))).toEqual([]);

      const printed = await second.callTool("sandbox_exec", { project: "gron", command: "env" });
      expect(text(printed)).toContain("PATH="); // presence: the environment was printed
      expect(text(printed)).not.toContain(HOST_VALUE);
    } finally {
      await second.callTool("disconnect_mcp_server", { project: "gron", name: "shenv" }).catch(() => {});
      await second.shutdown();
    }
  }, 120_000);

  it("refresh_mcp finds a server that needs a variable once the variable is set, and the script's command line tool goes", async () => {
    const GATE_VALUE = "gate-value-Wk2Tn6Bx1Lr4Gd8";
    const GATE_FILE = "/opt/mcpe/bin/gated";
    const MANIFEST = "/workspace/repo/.mcp.json";
    const names = (a: App) => a.registry.get("gron")!.tools.map((t) => t.name).sort();
    const second = new App({
      cfg: loadConfig({ ...process.env, MCPE_DATA_DIR: dir, MCPE_NAME_PREFIX: prefix, MCPE_TOOL_TIMEOUT: "5" }),
      env: { gron__MCPE_IT_GATE_Q7X2: GATE_VALUE },
    });
    let failed = true;
    try {
      await app.callTool("sandbox_write_file", { project: "gron", path: GATE_FILE, content: GATED_MCP_SERVER });
      await app.callTool("sandbox_write_file", { project: "gron", path: MANIFEST, content: JSON.stringify({ mcpServers: { gated: { command: "gated" } } }) });
      const placed = await app.callTool("sandbox_exec", { project: "gron", command: `chmod +x ${GATE_FILE}` });
      expect(placed.isError).toBe(false);

      // Without the variable: no MCP server, a warning that names the route, and a command line tool for the script.
      const before = await app.callTool("discover_tools", { project: "gron" });
      expect(before.isError).toBe(false);
      const gron = app.registry.get("gron")!;
      expect(gron.mcpServers).toEqual([]);
      expect(gron.warnings.find((w) => w.startsWith("MCP:"))).toContain("set gron__NAME in the environment of mcp-everything, reconnect it, and call refresh_mcp");
      expect(names(app)).toEqual(["gron__gated", "gron__gron"]);

      // Through an App that has the variable.
      const started = Date.now();
      const refreshed = await second.callTool("refresh_mcp", { project: "gron" });
      console.log(`refresh_mcp (gron, one detected shell server): ${Date.now() - started} ms`);
      expect(refreshed.isError).toBe(false);
      expect(text(refreshed)).toContain("Variables applied (names only): MCPE_IT_GATE_Q7X2.");
      expect(text(refreshed)).not.toContain(GATE_VALUE);
      expect(names(second)).toEqual(["gron__gron", "gron__reveal"]);
      expect(second.registry.get("gron")!.mcpServers!.map((s) => [s.name, s.origin, s.env])).toEqual([["gated", "detected", {}]]);
      expect(text(await second.callTool("gron__reveal", {}))).toBe(`gate=${GATE_VALUE}`);
      expect(fs.readFileSync(path.join(dir, "registry.json"), "utf8")).not.toContain(GATE_VALUE);
      failed = false;
    } finally {
      // Its server session ends before its files go; then the catalog is rebuilt without them.
      await second.shutdown();
      await app.callTool("sandbox_exec", { project: "gron", command: `rm -f ${GATE_FILE} ${MANIFEST}` }).catch(() => {});
      await app.callTool("discover_tools", { project: "gron" }).catch(() => {});
      if (!failed) expect(names(app)).toEqual(["gron__gron"]);
    }
  }, 120_000);

  it("gives a proxied MCP server a variable whose value is empty as set and empty", async () => {
    const GATE_FILE = "/opt/mcpe/bin/gated";
    const MANIFEST = "/workspace/repo/.mcp.json";
    const names = (a: App) => a.registry.get("gron")!.tools.map((t) => t.name).sort();
    const second = new App({
      cfg: loadConfig({ ...process.env, MCPE_DATA_DIR: dir, MCPE_NAME_PREFIX: prefix, MCPE_TOOL_TIMEOUT: "5" }),
      env: { gron__MCPE_IT_GATE_Q7X2: "" },
    });
    try {
      await app.callTool("sandbox_write_file", { project: "gron", path: GATE_FILE, content: GATED_MCP_SERVER });
      await app.callTool("sandbox_write_file", { project: "gron", path: MANIFEST, content: JSON.stringify({ mcpServers: { gated: { command: "gated" } } }) });
      const placed = await app.callTool("sandbox_exec", { project: "gron", command: `chmod +x ${GATE_FILE}` });
      expect(placed.isError).toBe(false);

      // The script exits unless the variable is set, so a started server means "set"; the reply shows it is empty.
      const refreshed = await second.callTool("refresh_mcp", { project: "gron" });
      expect(refreshed.isError).toBe(false);
      expect(names(second)).toContain("gron__reveal");
      expect(text(await second.callTool("gron__reveal", {}))).toBe("gate=");
    } finally {
      await second.shutdown();
      await app.callTool("sandbox_exec", { project: "gron", command: `rm -f ${GATE_FILE} ${MANIFEST}` }).catch(() => {});
      await app.callTool("discover_tools", { project: "gron" }).catch(() => {});
    }
  }, 120_000);

  it("works on, describes and removes a sandbox made before ownership was recorded", async () => {
    // Made by hand with the generic label and no owner label, as an earlier version made it.
    // Named with the suite's prefix, so the one name check below accepts it and no operator's sandbox can match.
    const name = `${prefix}before`;
    const slug = "before";
    expect(mayRemove(name, [])).toBe(true);
    expect(isUnderTmp(cfg.dataDir)).toBe(true);
    expect(cfg.dataDir).toBe(dir);
    const base = app.registry.get("gron")!;
    expect(base).toBeDefined();
    try {
      const vol = await run("docker", ["volume", "create", "--label", "mcp-everything=1", name], { timeoutMs: 30_000 });
      expect(vol.code).toBe(0);
      const ctr = await run(
        "docker",
        ["run", "-d", "--name", name, "--label", "mcp-everything=1", "-v", `${name}:/workspace`, cfg.docker.images.generic, "sleep", "infinity"],
        { timeoutMs: 300_000 },
      );
      expect(ctr.code).toBe(0);
      const owner = await run("docker", ["inspect", "--type", "container", "--format", '{{index .Config.Labels "mcp-everything.owner"}}', name], { timeoutMs: 30_000 });
      expect(owner.stdout.trim()).toBe("");

      app.registry.put({
        ...base,
        slug,
        repo: { ...base.repo, path: "mcpe-it/before", id: "github:mcpe-it/before", name: "before", cloneUrl: "https://github.com/mcpe-it/before" },
        container: name,
        volume: name,
        status: "ready",
        network: false,
        error: undefined,
        errorLog: undefined,
        warnings: [],
        commands: [],
        mcpServers: [],
        tools: [],
        published: [],
        selection: undefined,
      });

      const ran = await app.callTool("sandbox_exec", { project: slug, command: "echo still-works", cwd: "/workspace" });
      expect(ran.isError).toBe(false);
      expect(text(ran)).toContain("still-works");

      const info = await app.callTool("project_info", { project: slug });
      expect(text(info)).toMatch(/Sandbox owner: container "[^"]+" was made before ownership was recorded/);

      const gone = await app.callTool("uninstall_project", { project: slug });
      expect(gone.isError).toBe(false);
      expect(text(gone)).toMatch(/^Removed before .* and its sandbox\.$/);
      expect(app.registry.get(slug)).toBeUndefined();
      expect((await run("docker", ["inspect", "--type", "container", name])).code).not.toBe(0);
      expect((await run("docker", ["volume", "inspect", name])).code).not.toBe(0);
    } finally {
      // Whatever state the case left. Exact name, checked.
      await removeContainerChecked(name, []);
      await removeVolumeChecked(name, []);
      app.registry.delete(slug);
    }
  }, 300_000);

  it("uninstall removes the container and the volume", async () => {
    await app.callTool("uninstall_project", { project: "gron" });
    const c = await run("docker", ["inspect", gron]);
    const v = await run("docker", ["volume", "inspect", gron]);
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
    const docker = new FailsFirstBuild(cfg, loadInstallationId(dir));
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

/** Real Docker, except that the build step records the network and then throws. */
class ThrowsInBuild extends Docker {
  attachedDuringBuild?: boolean;
  override async exec(container: string, argv: string[], opts: ExecOptions): Promise<ExecResult> {
    if (argv[0] === "sh" && argv[2]?.includes("soft_fail()")) {
      this.attachedDuringBuild = await this.hasNetwork(container);
      throw new Error("simulated failure in the build step");
    }
    return super.exec(container, argv, opts);
  }
}

describe.skipIf(!enabled)("docker integration: a failed install", () => {
  it("leaves the sandbox off the network even when network was requested", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-it-netoff-"));
    const cfg = loadConfig({ ...process.env, MCPE_DATA_DIR: dir, MCPE_NAME_PREFIX: `${prefix}netoff-` });
    const docker = new ThrowsInBuild(cfg, loadInstallationId(dir));
    const registry = new Registry(dir);
    const installer = new Installer(cfg, docker, registry, new McpProxy(cfg, docker));
    try {
      // The recipe never runs, so the image only has to start.
      const record = await installer.install({
        repo: parseRepoRef("tomnomnom/gron", cfg.hosts),
        network: true,
        image: cfg.docker.probeImage,
      });
      expect(docker.attachedDuringBuild).toBe(true);
      expect(record).toMatchObject({ status: "failed", network: false, error: "simulated failure in the build step" });
      expect(await docker.hasNetwork(record.container)).toBe(false);
      expect(registry.get(record.slug)).toMatchObject({ status: "failed", network: false });
    } finally {
      for (const p of registry.list()) await installer.uninstall(p);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
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
    const vol = await run("docker", ["volume", "create", "--label", "mcp-everything=1", "--label", `mcp-everything.owner=${d.installationId}`, name], { timeoutMs: 30_000 });
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
    docker = new Docker(cfg, loadInstallationId(dir));
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
    const off = new Docker(loadConfig({ ...process.env, MCPE_DATA_DIR: dir, MCPE_NAME_PREFIX: prefix, MCPE_SANDBOX_IDLE_TIMEOUT: "0" }), loadInstallationId(dir));
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
 * Two installations on one daemon: two Apps, each on a data directory of its
 * own, both with the default name prefix, installing the same repository.
 *
 * The cases depend on each other and run in the order written: the first two
 * install, the next three act on the second's record after it has been
 * pointed at the first's sandbox.
 *
 * What makes this safe on a machine that holds real sandboxes. A sandbox name
 * cannot reach an operator's sandbox: a name made by the code is always prefix,
 * id, slug. The data directory can: a configuration without MCPE_DATA_DIR falls
 * back to the real one, whose registry names real sandboxes that the code
 * treats as this installation's to remove. So:
 *  - every App here is built by `installationOn`, from a directory this
 *    describe has just made with mkdtemp under the system's temporary directory;
 *  - `beforeAll` checks, for each App, that its data directory is that
 *    directory, that its registry is empty and that its id came from that
 *    directory's file, and that the two ids differ; only then it sets `safe`;
 *  - every case starts with `proceed()`, which throws unless `safe` is set,
 *    before any Docker command is issued;
 *  - every removal is `removeContainerChecked` or `removeVolumeChecked`, which
 *    check the name with `mayRemove` first; nothing here removes by a filter.
 */
describe.skipIf(!enabled)("docker integration: two installations on one daemon", () => {
  /** Set by `beforeAll` when every guard has passed, and by nothing else. */
  let safe = false;
  /** The two test ids, set together with `safe`; the name check and cleanup use only these. */
  let testIds: readonly string[] = [];
  /** Directories this describe made with mkdtemp. */
  const made: string[] = [];
  let first: App | undefined;
  let second: App | undefined;
  let idA = "";
  let idB = "";
  /** Container and volume names of the first and second installation's gron: `mcpe-<id>-gron`. */
  let nameA = "";
  let nameB = "";
  /** The first's container as it was after its own install: id, running state, networks. */
  let beforeA = "";

  const proceed = (): void => {
    if (!safe) throw new Error("a guard failed in beforeAll: no Docker command is issued");
  };

  /** An App on exactly this directory, with the default prefix whatever the ambient environment says. */
  function installationOn(dataDir: string): { app: App; cfg: ReturnType<typeof loadConfig> } {
    if (!made.includes(dataDir) || !isUnderTmp(dataDir)) throw new Error("not a directory this describe made under the temporary directory");
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.MCPE_NAME_PREFIX;
    env.MCPE_DATA_DIR = dataDir;
    const cfg = loadConfig(env);
    return { app: new App({ cfg }), cfg };
  }

  const inspect = async (name: string, format: string) => {
    const res = await run("docker", ["inspect", "--type", "container", "--format", format, name], { timeoutMs: 30_000 });
    expect(res.code, `inspect ${name}: ${res.stderr}`).toBe(0);
    return res.stdout.trim();
  };
  /** The container's id, whether it is running, and the networks it is attached to. */
  const stateOf = (name: string) =>
    inspect(name, "{{.Id}} {{.State.Running}} {{range $k, $v := .NetworkSettings.Networks}}{{$k}},{{end}}");
  const containerOwner = (name: string) => inspect(name, '{{index .Config.Labels "mcp-everything.owner"}}');
  const volumeOwner = async (name: string) => {
    const res = await run("docker", ["volume", "inspect", "--format", '{{index .Labels "mcp-everything.owner"}}', name], { timeoutMs: 30_000 });
    expect(res.code, `volume inspect ${name}: ${res.stderr}`).toBe(0);
    return res.stdout.trim();
  };
  const runsGron = async (app: App) => text(await app.callTool("gron__gron", { stdin: '{"a":[1,2]}' }));

  /** Point the second installation's record for gron at the first's container and volume, through its own registry. */
  const pointSecondAtFirst = () => {
    const record = second!.registry.get("gron")!;
    second!.registry.put({ ...record, container: nameA, volume: nameA });
    expect(second!.registry.get("gron")).toMatchObject({ container: nameA, volume: nameA });
  };

  beforeAll(() => {
    // The name check first: it is what the removals rely on.
    assertNameCheckBehaves();

    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-it-two-a-"));
    made.push(dirA);
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-it-two-b-"));
    made.push(dirB);
    const a = installationOn(dirA);
    const b = installationOn(dirB);
    first = a.app;
    second = b.app;

    for (const [app, cfg, dataDir] of [
      [a.app, a.cfg, dirA],
      [b.app, b.cfg, dirB],
    ] as const) {
      expect(isUnderTmp(dataDir)).toBe(true);
      expect(cfg.dataDir).toBe(dataDir);
      expect(isUnderTmp(cfg.dataDir)).toBe(true);
      expect(cfg.docker.namePrefix).toBe("mcpe-");
      expect(app.registry.list()).toEqual([]);
      expect(app.docker.installationId).toMatch(HEX8);
      // The id came from this directory's file, not from anywhere else.
      expect(fs.readFileSync(path.join(dataDir, "installation-id"), "utf8").trim()).toBe(app.docker.installationId);
    }
    expect(a.cfg.dataDir).not.toBe(b.cfg.dataDir);
    expect(a.app.docker.installationId).not.toBe(b.app.docker.installationId);

    idA = a.app.docker.installationId;
    idB = b.app.docker.installationId;
    nameA = `mcpe-${idA}-gron`;
    nameB = `mcpe-${idB}-gron`;
    expect(mayRemove(nameA, [idA, idB])).toBe(true);
    expect(mayRemove(nameB, [idA, idB])).toBe(true);
    console.log(`two installations: first ${idA} (${dirA}), second ${idB} (${dirB})`);
    testIds = [idA, idB];
    safe = true;
  }, 30_000);

  afterAll(async () => {
    try {
      await Promise.allSettled([first?.shutdown(), second?.shutdown()]);
      // If a guard failed no case ran and nothing was made in Docker; the ids may be unset or not the test's.
      if (safe) {
        for (const name of [nameA, nameB]) {
          await removeContainerChecked(name, testIds);
          await removeVolumeChecked(name, testIds);
        }
        const list = async (args: string[]) => (await run("docker", args, { timeoutMs: 60_000 })).stdout.trim();
        for (const id of testIds) {
          expect(await list(["ps", "-a", "-q", "--filter", `label=mcp-everything.owner=${id}`]), `containers of ${id}`).toBe("");
          expect(await list(["volume", "ls", "-q", "--filter", `label=mcp-everything.owner=${id}`]), `volumes of ${id}`).toBe("");
        }
        expect(await list(["ps", "-a", "-q", "--filter", `name=${prefix}`]), "containers with the suite's prefix").toBe("");
        expect(await list(["volume", "ls", "-q", "--filter", `name=${prefix}`]), "volumes with the suite's prefix").toBe("");
      }
    } finally {
      for (const d of made) if (isUnderTmp(d)) fs.rmSync(d, { recursive: true, force: true });
    }
  }, 300_000);

  it("the first installation installs gron under its own names and label", async () => {
    proceed();
    const res = await first!.callTool("install_project", { repo: "tomnomnom/gron" });
    expect(text(res)).toMatch(/gron — github:tomnomnom\/gron \(ready\)/);
    expect(res.isError).toBe(false);
    const record = first!.registry.get("gron")!;
    expect(record).toMatchObject({ container: nameA, volume: nameA });
    expect(await containerOwner(nameA)).toBe(idA);
    expect(await volumeOwner(nameA)).toBe(idA);
    expect(await runsGron(first!)).toContain("json.a[1] = 2;");
    beforeA = await stateOf(nameA);
  }, 600_000);

  it("the second installation installs the same repository beside it, and the first's sandbox is unchanged", async () => {
    proceed();
    expect(beforeA).not.toBe("");
    const res = await second!.callTool("install_project", { repo: "tomnomnom/gron" });
    expect(text(res)).toMatch(/gron — github:tomnomnom\/gron \(ready\)/);
    expect(res.isError).toBe(false);
    expect(second!.registry.get("gron")).toMatchObject({ container: nameB, volume: nameB });
    expect(await containerOwner(nameB)).toBe(idB);
    expect(await volumeOwner(nameB)).toBe(idB);
    expect(await runsGron(second!)).toContain("json.a[1] = 2;");
    // The first's: the same container (same id), and its tool still runs.
    expect(await stateOf(nameA)).toBe(beforeA);
    expect(await containerOwner(nameA)).toBe(idA);
    expect(await runsGron(first!)).toContain("json.a[1] = 2;");
  }, 600_000);

  it("refuses a tool call, sandbox_exec and the network setting on a record that names the first's sandbox", async () => {
    proceed();
    pointSecondAtFirst();
    const refused = async (what: string, res: Awaited<ReturnType<App["callTool"]>>) => {
      expect(res.isError, what).toBe(true);
      expect(text(res), what).toContain(`owner label "${idA}"`);
      expect(await stateOf(nameA), what).toBe(beforeA);
    };
    await refused("generated tool", await second!.callTool("gron__gron", { stdin: "[1]" }));
    await refused("sandbox_exec", await second!.callTool("sandbox_exec", { project: "gron", command: "echo reached" }));
    await refused("set_project_network", await second!.callTool("set_project_network", { project: "gron", enabled: true }));
    // The refused network change was not recorded either.
    expect(second!.registry.get("gron")!.network).toBe(false);
  }, 120_000);

  it("reinstalls beside the first's sandbox, under its own names, and says it left the other in place", async () => {
    proceed();
    // Still pointed at the first's sandbox, from the case above.
    expect(second!.registry.get("gron")).toMatchObject({ container: nameA, volume: nameA });
    const res = await second!.callTool("install_project", { repo: "tomnomnom/gron", reinstall: true });
    expect(text(res)).toMatch(/\(ready\)/);
    expect(res.isError).toBe(false);
    const record = second!.registry.get("gron")!;
    expect(record).toMatchObject({ status: "ready", container: nameB, volume: nameB });
    expect(record.warnings.some((w) => w.startsWith("The previous sandbox of this project was left in place, untouched"))).toBe(true);
    expect(await containerOwner(nameB)).toBe(idB);
    expect(await runsGron(second!)).toContain("json.a[1] = 2;");
    expect(await stateOf(nameA)).toBe(beforeA);
    expect(await runsGron(first!)).toContain("json.a[1] = 2;");
  }, 600_000);

  it("lets go of the first's sandbox on uninstall, and says it was left", async () => {
    proceed();
    pointSecondAtFirst();
    const res = await second!.callTool("uninstall_project", { project: "gron" });
    expect(res.isError).toBe(false);
    expect(text(res)).toContain("Its sandbox was left in place");
    expect(second!.registry.get("gron")).toBeUndefined();
    expect(second!.registry.list()).toEqual([]);
    expect(await stateOf(nameA)).toBe(beforeA);
    expect(await runsGron(first!)).toContain("json.a[1] = 2;");
  }, 120_000);
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
    const vol = await run("docker", ["volume", "create", "--label", "mcp-everything=1", "--label", `mcp-everything.owner=${docker.installationId}`, name], { timeoutMs: 30_000 });
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
    docker = new Docker(cfg, loadInstallationId(dir));
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
