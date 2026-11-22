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
import { Docker, MANIFESTS, parseProbeOutput, WALK_SCRIPT, walkArguments, type ExecOptions, type ExecResult, type OneShotSpec } from "../../src/sandbox/docker.js";
import { randomBytes } from "node:crypto";
import { App } from "../../src/server.js";
import { runScanners } from "../../src/scan/run.js";
import type { ScannerSpec } from "../../src/scan/types.js";
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

/**
 * `alpine`, for the test scanner of later legs, pinned by the index digest with the tag it was read under
 * (Docker Hub, 2026-11-22: `latest` = `3.24.4`; `docker buildx imagetools inspect alpine:latest`).
 * To bump, read both again the same way.
 */
export const ALPINE = "alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf";

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

/** The one-shot method is protected; a test subclass reaches it. */
class OneShotDocker extends Docker {
  /** The stdout of the last one-shot command, whoever ran it (`probe` included). */
  lastStdout = "";
  once(spec: OneShotSpec) {
    return this.runOnce(spec);
  }
  protected override async runOnce(spec: OneShotSpec) {
    const res = await super.runOnce(spec);
    this.lastStdout = res.stdout;
    return res;
  }
}

describe.skipIf(!enabled)("docker integration: the owned one-shot container", () => {
  /** An installation id made for this describe alone: every container it makes carries it, so none is the operator's. */
  const id = randomBytes(4).toString("hex");
  const cfg = loadConfig({ ...process.env, MCPE_NAME_PREFIX: prefix });
  const own = ["ps", "-a", "--filter", `label=mcp-everything.owner=${id}`, "--format", '{{.Names}}\t{{.Label "mcp-everything.role"}}'];
  const left = async () => (await run("docker", own, { timeoutMs: 30_000 })).stdout.trim();
  /** Removes whatever this describe's id left, each name through the checked removal. Run after each case. */
  const sweepOwn = async () => {
    for (const line of (await left()).split("\n").filter(Boolean)) await removeContainerChecked(line.split("\t")[0]!, []);
  };
  const gone = async (): Promise<string> => {
    const until = Date.now() + 10_000;
    let now = await left();
    while (now !== "" && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500));
      now = await left();
    }
    return now;
  };

  it("clones into a staging volume, returns a commit and leaves no container with role clone", async () => {
    assertNameCheckBehaves();
    const docker = new OneShotDocker(cfg, id);
    const volume = `${prefix}clone-${randomBytes(4).toString("hex")}`;
    expect(mayRemove(volume, [])).toBe(true);
    try {
      const data = await docker.probe(parseRepoRef("tomnomnom/gron", cfg.hosts), volume, { volumeRole: "staging" });
      expect(data.commit).toMatch(/^[0-9a-f]{40}$/);
      // The walk reports no gap (gron, a Go project, has none of the walked files, so `files` may be empty).
      expect(data.walk.incomplete).toBeUndefined();
      // The raw stdout shows the separator split: each FILE name at most once, none outside MANIFESTS, well under the cap.
      const names = docker.lastStdout.split("\n").filter((l) => l.startsWith("FILE ")).map((l) => l.split(" ")[1]!);
      expect(new Set(names).size).toBe(names.length);
      for (const n of names) expect(MANIFESTS).toContain(n);
      expect(docker.lastStdout.length).toBeLessThan(1_000_000);
      const labels = await run("docker", ["volume", "inspect", "--format", "{{json .Labels}}", volume], { timeoutMs: 30_000 });
      expect(JSON.parse(labels.stdout)).toEqual({ "mcp-everything": "1", "mcp-everything.owner": id, "mcp-everything.role": "staging" });
      expect(await gone()).toBe("");
    } finally {
      await sweepOwn();
      await removeVolumeChecked(volume, []);
    }
  }, 300_000);

  it("walks a fixture in the pinned clone image: reads, prunes, links, truncation and the three gaps", async () => {
    const docker = new OneShotDocker(cfg, id);
    const volume = `${prefix}walk-${randomBytes(4).toString("hex")}`;
    expect(mayRemove(volume, [])).toBe(true);
    const fixture = [
      "set -e",
      "mkdir -p /workspace/repo && cd /workspace/repo",
      "echo '{\"root\":1}' > package.json",
      "mkdir -p sub node_modules/x",
      "echo '{\"sub\":1}' > sub/package.json",
      "echo '{\"pruned\":1}' > node_modules/x/package.json",
      "ln -s /etc/passwd setup.py",
      "head -c 70000 /dev/zero | tr '\\0' a > configure",
      "nl=$(printf 'a\\nb'); mkdir -p \"$nl\"; echo '{}' > \"$nl/package.json\"",
      "mkdir -p l1/l2/l3/l4/l5/l6/l7/l8/l9; echo all: > l1/l2/l3/l4/l5/l6/l7/l8/l9/Makefile",
      "mkdir -p cm; i=0; while [ $i -lt 41 ]; do echo x > cm/f$i.cmake; i=$((i+1)); done",
    ].join("\n");
    await docker.ensureImage(ALPINE);
    await docker.ensureImage(cfg.docker.probeImage);
    try {
      const made = await run("docker", ["volume", "create", "--label", "mcp-everything=1", "--label", `mcp-everything.owner=${id}`, volume], { timeoutMs: 30_000 });
      expect(made.code).toBe(0);
      const built = await docker.once({ role: "clone", image: ALPINE, network: "none", mounts: [`${volume}:/workspace`], entrypoint: "sh", args: ["-c", fixture], timeoutMs: 120_000, maxBytes: 1_000_000 });
      expect(built.code).toBe(0);
      const res = await docker.once({
        role: "clone", image: cfg.docker.probeImage, network: "none", mounts: [`${volume}:/workspace`], entrypoint: "sh",
        args: ["-c", WALK_SCRIPT, "walk", ...walkArguments()], timeoutMs: 120_000, maxBytes: 16_000_000,
      });
      expect(res.code).toBe(0);
      const lines = res.stdout.split("\n");
      const b = (s: string) => Buffer.from(s).toString("base64");
      expect(lines).toContain("INCOMPLETE newline");
      expect(lines).toContain("INCOMPLETE depth");
      expect(lines).toContain("INCOMPLETE pattern");
      expect(lines).toContain(`LINK ${b("setup.py")}`);
      const w = parseProbeOutput(`HEAD ${"a".repeat(40)}\n${res.stdout}`).walk;
      const paths = w.files.map((f) => f.path);
      expect(paths).toContain("package.json");
      expect(paths).toContain("sub/package.json");
      expect(paths.some((p) => p.includes("node_modules"))).toBe(false);
      expect(paths.some((p) => p.includes("l9"))).toBe(false);
      expect(paths.some((p) => p.includes("\n"))).toBe(false);
      expect(paths).not.toContain("setup.py");
      expect(w.skippedLinks).toEqual(["setup.py"]);
      const cfgFile = w.files.find((f) => f.path === "configure")!;
      expect(cfgFile.truncated).toBe(true);
      expect(cfgFile.content).toHaveLength(65_536);
      expect(w.files.filter((f) => f.path.endsWith(".cmake"))).toHaveLength(40);
      expect(await gone()).toBe("");
    } finally {
      await sweepOwn();
      await removeVolumeChecked(volume, []);
    }
  }, 300_000);

  it("times out a one-shot command, reports it and leaves no container", async () => {
    const docker = new OneShotDocker(cfg, id);
    await docker.ensureImage(ALPINE);
    try {
      const res = await docker.once({ role: "clone", image: ALPINE, network: "none", args: ["sleep", "30"], timeoutMs: 2000, maxBytes: 1_000_000 });
      expect(res.timedOut).toBe(true);
      expect(await gone()).toBe("");
    } finally {
      await sweepOwn();
    }
  }, 120_000);
});

/**
 * Scanners, the copy and the leftovers sweep (leg 6). Every container and volume these cases make carries the
 * describe's own installation id (cases a to d) or the sweep case's own (case e, over a fresh temporary data
 * directory), and a name under the suite's prefix; every removal goes through the checked helpers.
 */
describe.skipIf(!enabled)("docker integration: scanners, the copy and the sweep", () => {
  /** An installation id made for this describe alone. */
  const id = randomBytes(4).toString("hex");
  const cfg = loadConfig({ ...process.env, MCPE_NAME_PREFIX: prefix });
  const docker = new OneShotDocker(cfg, id);
  const own = ["ps", "-a", "--filter", `label=mcp-everything.owner=${id}`, "--format", '{{.Names}}\t{{.Label "mcp-everything.role"}}'];
  const left = async () => (await run("docker", own, { timeoutMs: 30_000 })).stdout.trim();
  const sweepOwn = async () => {
    for (const line of (await left()).split("\n").filter(Boolean)) await removeContainerChecked(line.split("\t")[0]!, []);
  };
  const gone = async (): Promise<string> => {
    const until = Date.now() + 10_000;
    let now = await left();
    while (now !== "" && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500));
      now = await left();
    }
    return now;
  };
  const hex = () => randomBytes(4).toString("hex");
  const staging = `${prefix}scanstage-${hex()}`;
  let dataDir: string;
  let commit = "";
  const scanner = (name: string, script: string, over: Partial<ScannerSpec> = {}): ScannerSpec => ({
    name, image: ALPINE, command: ["sh", "-c", script], network: false, timeoutSec: 60, env: [], ...over,
  });
  const SARIF = JSON.stringify({
    version: "2.1.0",
    runs: [{ tool: { driver: { name: "fake" } }, results: [{ level: "error", ruleId: "E1", message: { text: "bad" } }, { level: "note", ruleId: "N1", message: { text: "fyi" } }] }],
  });
  /** A throwaway container over volumes, through the checked one-shot method (role clone). */
  const over = (image: string, mounts: string[], script: string, caps: OneShotSpec["caps"] = []) =>
    docker.once({ role: "clone", image, network: "none", mounts, entrypoint: "sh", caps, args: ["-c", script], timeoutMs: 120_000, maxBytes: 1_000_000 });

  beforeAll(async () => {
    expect(mayRemove(staging, [])).toBe(true);
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-it-scan-"));
    await docker.ensureImage(ALPINE);
    const data = await docker.probe(parseRepoRef("tomnomnom/gron", cfg.hosts), staging, { volumeRole: "staging" });
    commit = data.commit;
  }, 300_000);

  afterAll(async () => {
    await sweepOwn();
    await removeVolumeChecked(staging, []).catch(() => undefined);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }, 120_000);

  it("(a) turns a scanner's SARIF into counts, and a scanner cannot write to the checkout", async () => {
    try {
      const out = await runScanners(docker, staging, [scanner("fake", `printf '%s' '${SARIF}'`), scanner("writer", "touch /scan/repo/x; echo \"touch exit $?\" >&2")], { totalTimeoutSec: 300, dataDir });
      expect(out[0]).toMatchObject({ name: "fake", kind: "scanner", status: "ran", counts: { error: 1, warning: 0, note: 1 } });
      expect(out[1]!.status).toBe("failed");
      expect(out[1]!.error).toMatch(/Read-only file system/i);
      const check = await over(ALPINE, [`${staging}:/w:ro`], "test ! -e /w/repo/x && test -d /w/repo/.git");
      expect(check.code).toBe(0);
      expect(await gone()).toBe("");
    } finally {
      await sweepOwn();
    }
  }, 300_000);

  it("(b) fails a scanner that prints garbage, passes it a credential through a file that is gone afterwards, and redacts the value", async () => {
    try {
      const token = `tok-${hex()}-${hex()}`;
      const out = await runScanners(docker, staging, [scanner("garbage", "echo not-sarif"), scanner("creds", 'echo "got $MCPE_IT_SCAN_TOKEN" >&2; echo nope', { env: ["MCPE_IT_SCAN_TOKEN"] })], {
        totalTimeoutSec: 300, dataDir, env: { MCPE_IT_SCAN_TOKEN: token },
      });
      expect(out[0]).toMatchObject({ status: "failed", error: expect.stringContaining("output is not valid JSON") });
      expect(out[1]!.status).toBe("failed");
      expect(out[1]!.error).toContain("got [redacted]");
      expect(JSON.stringify(out)).not.toContain(token);
      const tmp = path.join(dataDir, "tmp");
      expect(fs.existsSync(tmp) ? fs.readdirSync(tmp) : []).toEqual([]);
      expect(await gone()).toBe("");
    } finally {
      await sweepOwn();
    }
  }, 300_000);

  it("(c) times out a sleeping scanner within its budget and leaves no container", async () => {
    try {
      const t0 = Date.now();
      const res = await docker.runScanner(staging, scanner("sleeper", "sleep 60"), { timeoutMs: 5000 });
      expect(res.timedOut).toBe(true);
      expect(Date.now() - t0).toBeLessThan(40_000);
      expect(await gone()).toBe("");
    } finally {
      await sweepOwn();
    }
  }, 120_000);

  it("(d) copies a staging volume exactly: an owner other than root's, a mode-000 directory, a link, an executable, and the checkout's HEAD", async () => {
    const target = `${prefix}scancopy-${hex()}`;
    expect(mayRemove(target, [])).toBe(true);
    try {
      // The container that adds the files is one-shot too; it needs CHOWN to give a file to uid 1234 and DAC_OVERRIDE to fill the directory it then locks.
      await docker.ensureImage(cfg.docker.probeImage);
      const add = await over(
        ALPINE,
        [`${staging}:/w`],
        "set -e; cd /w/repo; echo owned > f1234; chown 1234:1234 f1234; mkdir noaccess; echo hidden > noaccess/inner; chmod 000 noaccess; ln -s no-such-target lnk; printf '#!/bin/sh\\n' > exe.sh; chmod 755 exe.sh",
        ["CHOWN", "FOWNER", "DAC_OVERRIDE", "FSETID"],
      );
      expect(add.code).toBe(0);
      await docker.createSandboxVolume(target);
      await docker.copyVolume(staging, target);
      const seen = await over(ALPINE, [`${target}:/w:ro`], "cd /w/repo; stat -c '%n %u:%g %a' f1234 noaccess exe.sh lnk; readlink lnk; cat noaccess/inner", ["DAC_OVERRIDE"]);
      expect(seen.code, seen.stderr).toBe(0);
      expect(seen.stdout.split("\n")).toEqual(["f1234 1234:1234 644", "noaccess 0:0 0", "exe.sh 0:0 755", "lnk 0:0 777", "no-such-target", "hidden", ""]);
      const head = await docker.once({
        role: "clone", image: cfg.docker.probeImage, network: "none", mounts: [`${target}:/w:ro`], entrypoint: "git",
        args: ["-c", "safe.directory=*", "-C", "/w/repo", "rev-parse", "HEAD"], timeoutMs: 120_000, maxBytes: 1_000_000,
      });
      expect(head.stdout.trim()).toBe(commit);
      // The target is a sandbox volume: owned, and with no role.
      const labels = await run("docker", ["volume", "inspect", "--format", "{{json .Labels}}", target], { timeoutMs: 30_000 });
      expect(JSON.parse(labels.stdout)).toEqual({ "mcp-everything": "1", "mcp-everything.owner": id });
      expect(await gone()).toBe("");
    } finally {
      await sweepOwn();
      await removeVolumeChecked(target, []).catch(() => undefined);
    }
  }, 300_000);

  it("(e) sweeps this installation's old staging volume and scan container, and leaves another owner's volume and container", async () => {
    // Its own data directory, so its own installation id: never the operator's default, whose live staging a maxAgeSec of 0 would sweep.
    const sweepDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-it-sweep-"));
    const sid = loadInstallationId(sweepDir);
    const other = sid === "deadbeef" ? "feedface" : "deadbeef";
    const sweeper = new Docker(loadConfig({ ...process.env, MCPE_DATA_DIR: sweepDir, MCPE_NAME_PREFIX: prefix }), sid);
    const n = (what: string) => `${prefix}sweep-${what}-${hex()}`;
    const mineStaging = n("stage");
    const mineScan = n("scan");
    const mineSandboxVol = n("sbvol");
    const otherVol = n("othervol");
    const otherScan = n("otherscan");
    const labels = (owner: string, role?: string) => ["--label", "mcp-everything=1", "--label", `mcp-everything.owner=${owner}`, ...(role ? ["--label", `mcp-everything.role=${role}`] : [])];
    const volume = (name: string, owner: string, role?: string) => run("docker", ["volume", "create", ...labels(owner, role), name], { timeoutMs: 30_000 });
    const container = async (name: string, owner: string, role: string) => (await run("docker", ["create", "--name", name, ...labels(owner, role), ALPINE, "true"], { timeoutMs: 60_000 })).stdout.trim();
    const names = [mineStaging, mineScan, mineSandboxVol, otherVol, otherScan];
    for (const name of names) expect(mayRemove(name, [])).toBe(true);
    const listed = async (owner: string) => ({
      containers: (await run("docker", ["ps", "-a", "--filter", `label=mcp-everything.owner=${owner}`, "--format", "{{.Names}}"], { timeoutMs: 30_000 })).stdout.split("\n").filter(Boolean).sort(),
      volumes: (await run("docker", ["volume", "ls", "--filter", `label=mcp-everything.owner=${owner}`, "--format", "{{.Name}}"], { timeoutMs: 30_000 })).stdout.split("\n").filter(Boolean).sort(),
    });
    try {
      expect((await listed(sid)).containers).toEqual([]);
      expect((await listed(sid)).volumes).toEqual([]);
      for (const r of [await volume(mineStaging, sid, "staging"), await volume(mineSandboxVol, sid), await volume(otherVol, other, "staging")]) expect(r.code).toBe(0);
      const mineScanId = await container(mineScan, sid, "scan");
      expect(mineScanId).toMatch(/^[0-9a-f]{64}$/);
      expect(await container(otherScan, other, "scan")).toMatch(/^[0-9a-f]{64}$/);
      // Before sweeping, what this installation's id owns is exactly what this case made, and nothing else.
      expect(await listed(sid)).toEqual({ containers: [mineScan], volumes: [mineSandboxVol, mineStaging].sort() });
      await new Promise((r) => setTimeout(r, 1100));

      const r = await sweeper.sweepCheckLeftovers(0);
      expect(r.failures).toBe(0);
      expect([...r.removed].sort()).toEqual([mineScanId, mineStaging].sort());
      expect(await listed(sid)).toEqual({ containers: [], volumes: [mineSandboxVol] });
      expect(await listed(other)).toEqual({ containers: [otherScan], volumes: [otherVol] });
    } finally {
      for (const name of [mineScan, otherScan]) await removeContainerChecked(name, []).catch(() => undefined);
      for (const name of [mineStaging, mineSandboxVol, otherVol]) await removeVolumeChecked(name, []).catch(() => undefined);
      fs.rmSync(sweepDir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe.skipIf(!enabled)("docker integration: the checked install through the server", () => {
  /** Set by `beforeAll` when every guard has passed, and by nothing else. */
  let safe = false;
  let dir = "";
  let id = "";
  const apps: App[] = [];
  let blocking: App;
  let scanOff: App;
  let warning: App;
  const proceed = (): void => {
    if (!safe) throw new Error("a guard failed in beforeAll: no Docker command is issued");
  };
  /** One fake scanner from the pinned alpine that always prints one `error` result. */
  const SARIF = JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "fake" } }, results: [{ level: "error", ruleId: "FAKE1", message: { text: "always an error" } }] }] });

  /** An App on this describe's own directory, with a name prefix under the suite's, whatever the ambient environment says. */
  function appOn(mode: "off" | "warn" | "block"): App {
    if (!isUnderTmp(dir) || !dir.includes("mcpe-it-chk-")) throw new Error("not the directory this describe made");
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of ["MCPE_SCAN_BLOCK_AT", "MCPE_SCAN_TIMEOUT", "MCPE_SCANNERS"]) delete env[k];
    Object.assign(env, {
      MCPE_DATA_DIR: dir,
      MCPE_NAME_PREFIX: `${prefix}chk-`,
      MCPE_SCAN: mode,
      MCPE_SCANNERS: path.join(dir, "scanners.json"),
      MCPE_TOOL_TIMEOUT: "20",
    });
    const cfg = loadConfig(env);
    expect(cfg.dataDir).toBe(dir);
    expect(cfg.docker.namePrefix.startsWith(prefix)).toBe(true);
    const made = new App({ cfg });
    apps.push(made);
    return made;
  }

  /** This installation's containers and volumes: name and role, by owner label. */
  const objects = async () => {
    const list = async (args: string[]) => (await run("docker", args, { timeoutMs: 60_000 })).stdout.split("\n").filter(Boolean);
    const format = '{{.Names}}\t{{.Label "mcp-everything.role"}}';
    const vformat = '{{.Name}}\t{{.Label "mcp-everything.role"}}';
    return {
      containers: await list(["ps", "-a", "--filter", `label=mcp-everything.owner=${id}`, "--format", format]),
      volumes: await list(["volume", "ls", "--filter", `label=mcp-everything.owner=${id}`, "--format", vformat]),
    };
  };
  const roleLabelled = async () => {
    const o = await objects();
    return [...o.containers, ...o.volumes].filter((l) => (l.split("\t")[1] ?? "") !== "");
  };
  const noRoleLeft = async (): Promise<string[]> => {
    const until = Date.now() + 10_000;
    let now = await roleLabelled();
    while (now.length > 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500));
      now = await roleLabelled();
    }
    return now;
  };
  const containerId = async (name: string) => {
    const res = await run("docker", ["inspect", "--type", "container", "--format", "{{.Id}}", name], { timeoutMs: 30_000 });
    expect(res.code, `inspect ${name}: ${res.stderr}`).toBe(0);
    return res.stdout.trim();
  };

  beforeAll(() => {
    assertNameCheckBehaves();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-it-chk-"));
    expect(isUnderTmp(dir)).toBe(true);
    // Never the operator's default data directory or registry.
    expect(dir).not.toBe(loadConfig({ ...process.env, MCPE_SCAN: "off", MCPE_SCANNERS: "" }).dataDir);
    fs.writeFileSync(
      path.join(dir, "scanners.json"),
      JSON.stringify({ scanners: [{ name: "fake", image: ALPINE, command: ["sh", "-c", `printf '%s' '${SARIF}'`], timeout_seconds: 60 }] }),
    );
    blocking = appOn("block");
    scanOff = appOn("off");
    warning = appOn("warn");
    id = blocking.docker.installationId;
    expect(id).toMatch(HEX8);
    // Its own installation: the id came from this directory's file, and all three Apps share it.
    expect(fs.readFileSync(path.join(dir, "installation-id"), "utf8").trim()).toBe(id);
    expect(scanOff.docker.installationId).toBe(id);
    expect(warning.docker.installationId).toBe(id);
    expect(blocking.registry.list()).toEqual([]);
    console.log(`checked install: installation ${id} (${dir})`);
    safe = true;
  }, 30_000);

  afterAll(async () => {
    try {
      await Promise.allSettled(apps.map((a) => a.shutdown()));
      if (safe) {
        warning.registry.refresh();
        for (const p of warning.registry.list()) await warning.installer.uninstall(p).catch(() => undefined);
        // Anything left that carries this installation's label (names are under the suite's prefix, which the checked helpers insist on).
        const left = await objects();
        for (const l of left.containers) await removeContainerChecked(l.split("\t")[0]!, []);
        for (const l of left.volumes) await removeVolumeChecked(l.split("\t")[0]!, []);
        const after = await objects();
        expect(after.containers, `containers of ${id}`).toEqual([]);
        expect(after.volumes, `volumes of ${id}`).toEqual([]);
      }
    } finally {
      if (isUnderTmp(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);

  it("(a) a blocked first install leaves no record and no role-labelled container or volume of this installation", async () => {
    proceed();
    const res = await blocking.callTool("install_project", { repo: "tomnomnom/gron" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^Blocked by the scan policy: blocked: 1 finding at error or above, from fake\. Nothing was installed\./);
    expect(text(res)).toContain("[error] FAKE1: always an error");
    expect(text(res)).not.toMatch(/Generated tools are callable/);
    blocking.registry.refresh();
    expect(blocking.registry.list()).toEqual([]);
    expect(await noRoleLeft()).toEqual([]);
    expect(await objects()).toEqual({ containers: [], volumes: [] });
  }, 900_000);

  it("(b) a blocked reinstall leaves the project as it was: its tool still runs, and the warning names the commit", async () => {
    proceed();
    const first = await scanOff.callTool("install_project", { repo: "tomnomnom/gron" });
    expect(first.isError).toBe(false);
    expect(text(first)).toMatch(/gron — github:tomnomnom\/gron \(ready\)/);
    const before = scanOff.registry.get("gron")!;
    expect(before.scan).toBeUndefined();
    const containerBefore = await containerId(before.container);

    const res = await blocking.callTool("install_project", { repo: "tomnomnom/gron", reinstall: true });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/^Blocked by the scan policy: /);
    expect(text(res)).toContain(`gron was left as it was, at commit ${before.commit!.slice(0, 12)}.`);

    const run1 = await blocking.callTool("call_project_tool", { tool: "gron__gron", arguments: { stdin: '{"a":[1,2]}' } });
    expect(text(run1)).toContain("json.a[1] = 2;");
    expect(await containerId(before.container)).toBe(containerBefore);

    blocking.registry.refresh();
    const after = blocking.registry.get("gron")!;
    expect(after.status).toBe("ready");
    expect(after.container).toBe(before.container);
    expect(after.warnings.some((w) => w.includes(after.commit!.slice(0, 12)) || /blocked by the scan policy/.test(w))).toBe(true);
    // The warning names the scanned commit, which a blocked reinstall of an unchanged head shares with the record's.
    expect(after.warnings.join("\n")).toMatch(/A reinstall at commit [0-9a-f]{12} was blocked by the scan policy on \d{4}-\d{2}-\d{2}/);
    expect(await noRoleLeft()).toEqual([]);
  }, 900_000);

  it("(c) in warn mode a reinstall builds, records the scan, and its checkout is the scanned commit", async () => {
    proceed();
    const res = await warning.callTool("install_project", { repo: "tomnomnom/gron", reinstall: true });
    expect(res.isError).toBe(false);
    expect(text(res)).toMatch(/gron — github:tomnomnom\/gron \(ready\)/);
    warning.registry.refresh();
    const rec = warning.registry.get("gron")!;
    expect(rec.status).toBe("ready");
    expect(rec.scan).toBeDefined();
    const fake = rec.scan!.checks.find((c) => c.name === "fake")!;
    expect(fake.status).toBe("ran");
    expect(fake.counts.error).toBe(1);
    expect(rec.scan!.decision.verdict).toBe("build");
    expect(rec.scan!.decision.mode).toBe("warn");
    const head = await warning.callTool("sandbox_exec", { project: "gron", command: "git -c safe.directory='*' -C /workspace/repo rev-parse HEAD" });
    expect(text(head)).toContain(rec.scan!.commit);
    expect(rec.commit).toBe(rec.scan!.commit);
    const out = await warning.callTool("gron__gron", { stdin: '{"a":[1,2]}' });
    expect(text(out)).toContain("json.a[1] = 2;");
    expect(await noRoleLeft()).toEqual([]);
  }, 900_000);
});

describe.skipIf(!enabled)("docker integration: the check tool", () => {
  /** Set by `beforeAll` when every guard has passed, and by nothing else. */
  let safe = false;
  let dir = "";
  let id = "";
  let checker: App;
  const proceed = (): void => {
    if (!safe) throw new Error("a guard failed in beforeAll: no Docker command is issued");
  };

  /** This installation's containers and volumes: name and role, by owner label. */
  const objects = async () => {
    const list = async (args: string[]) => (await run("docker", args, { timeoutMs: 60_000 })).stdout.split("\n").filter(Boolean);
    return {
      containers: await list(["ps", "-a", "--filter", `label=mcp-everything.owner=${id}`, "--format", '{{.Names}}\t{{.Label "mcp-everything.role"}}']),
      volumes: await list(["volume", "ls", "--filter", `label=mcp-everything.owner=${id}`, "--format", '{{.Name}}\t{{.Label "mcp-everything.role"}}']),
    };
  };
  const roleLabelled = async () => {
    const o = await objects();
    return [...o.containers, ...o.volumes].filter((l) => (l.split("\t")[1] ?? "") !== "");
  };

  beforeAll(() => {
    assertNameCheckBehaves();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-it-ckt-"));
    expect(isUnderTmp(dir)).toBe(true);
    // Never the operator's default data directory or registry.
    expect(dir).not.toBe(loadConfig({ ...process.env, MCPE_SCAN: "off", MCPE_SCANNERS: "" }).dataDir);
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of ["MCPE_SCAN_BLOCK_AT", "MCPE_SCAN_TIMEOUT", "MCPE_SCANNERS"]) delete env[k];
    Object.assign(env, { MCPE_DATA_DIR: dir, MCPE_NAME_PREFIX: `${prefix}ckt-`, MCPE_SCAN: "off" });
    const cfg = loadConfig(env);
    expect(cfg.dataDir).toBe(dir);
    expect(cfg.docker.namePrefix.startsWith(prefix)).toBe(true);
    expect(cfg.scan.scanners).toEqual([]);
    checker = new App({ cfg });
    id = checker.docker.installationId;
    expect(id).toMatch(HEX8);
    expect(fs.readFileSync(path.join(dir, "installation-id"), "utf8").trim()).toBe(id);
    expect(checker.registry.list()).toEqual([]);
    console.log(`check tool: installation ${id} (${dir})`);
    safe = true;
  }, 30_000);

  afterAll(async () => {
    try {
      await checker?.shutdown();
      if (safe) {
        const left = await objects();
        for (const l of left.containers) await removeContainerChecked(l.split("\t")[0]!, []);
        for (const l of left.volumes) await removeVolumeChecked(l.split("\t")[0]!, []);
        const after = await objects();
        expect(after.containers, `containers of ${id}`).toEqual([]);
        expect(after.volumes, `volumes of ${id}`).toEqual([]);
      }
    } finally {
      if (isUnderTmp(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("(d) with scanning off, check_project of gron reports the commit and a build-hooks check, and leaves nothing behind", async () => {
    proceed();
    const res = await checker.callTool("check_project", { repo: "tomnomnom/gron" });
    expect(res.isError).toBe(false);
    const t = text(res);
    expect(t).toMatch(/Checked github:tomnomnom\/gron at commit [0-9a-f]{40}\./);
    expect(t).toMatch(/- build-hooks: ran;/);
    expect(t).toMatch(/`go install` runs nothing from the repository/);
    expect(t).toContain("Installs are not scanned at present");
    checker.registry.refresh();
    expect(checker.registry.list()).toEqual([]);
    const until = Date.now() + 10_000;
    let left = await roleLabelled();
    while (left.length > 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500));
      left = await roleLabelled();
    }
    expect(left).toEqual([]);
    expect(await objects()).toEqual({ containers: [], volumes: [] });
  }, 900_000);
});
