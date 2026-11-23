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
import { Docker, MANIFESTS, parseProbeOutput, proxyAddress, proxyMac, ProxyStartError, WALK_SCRIPT, walkArguments, type ExecOptions, type ExecResult, type OneShotSpec, type ProxyRefusalRow, type SandboxRef } from "../../src/sandbox/docker.js";
import { Containment } from "../../src/network/containment.js";
import { buildHosts, sandboxHosts } from "../../src/network/defaults.js";
import { refusalLines } from "../../src/network/refusals.js";
import type { ProjectRecord } from "../../src/types.js";
import { record } from "../helpers.js";
import { parseHostEntry } from "../../src/network/hosts.js";
import { proxyConfig } from "../../src/network/proxy/config.js";
import { randomBytes } from "node:crypto";
import net from "node:net";
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
 * The names of a sandbox's network interfaces, one per line, from /proc/net/dev (header lines skipped). gVisor implements
 * /proc/net/dev and leaves /sys/class/net empty, so the same assertion runs under runc and runsc.
 */
const IFACES = "tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ' | sort";

/**
 * The URL a contained sandbox's proxy variables carry (leg 13): the proxy's ADDRESS on the network, the last usable host of the
 * network's subnet, read from the network itself. The sandbox names the proxy by this address, never by a name.
 */
async function proxyUrlOf(netName: string): Promise<string> {
  const res = await run("docker", ["network", "inspect", "--format", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", netName], { timeoutMs: 30_000 });
  const subnet = res.stdout.trim().split(/\s+/).find((s) => /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(s));
  if (!subnet) throw new Error(`network ${netName} has no IPv4 subnet: ${res.stderr}`);
  return `http://${proxyAddress(subnet)}:3128`;
}

/** A raw CONNECT script's first line: the proxy's host and port come from the HTTPS_PROXY the sandbox was given (no name is ever looked up). */
const PROXY_HOST_JS = `const P=new URL(process.env.HTTPS_PROXY);`;

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
  // `-v`: a container's anonymous volumes go with it, so no run leaks one onto the operator's daemon.
  await run("docker", ["rm", "-f", "-v", checkedForRemoval(name, ids)], { timeoutMs: 120_000 });
}
async function removeVolumeChecked(name: string, ids: readonly string[]): Promise<void> {
  await run("docker", ["volume", "rm", checkedForRemoval(name, ids)], { timeoutMs: 120_000 });
}
/** The network helper: by name, through the same check as the other two. */
async function removeNetworkChecked(name: string, ids: readonly string[]): Promise<void> {
  await run("docker", ["network", "rm", checkedForRemoval(name, ids)], { timeoutMs: 120_000 });
}

/** A container and its anonymous volumes (`-v`: never a named volume), through the same check. */
async function removeContainerWithVolumesChecked(name: string, ids: readonly string[]): Promise<void> {
  await run("docker", ["rm", "-f", "-v", checkedForRemoval(name, ids)], { timeoutMs: 120_000 });
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
  // The names of a one-shot's network and proxy (leg 5): under the suite's prefix they may go; under the default
  // prefix (an operator's own, or a real install's) or another process's prefix they may not.
  for (const role of ["oneshot-net", "oneshot-proxy"]) {
    expect(mayRemove(`${prefix}aaaaaaaa-${role}-deadbeef`, [])).toBe(true);
    expect(mayRemove(`mcpe-aaaaaaaa-${role}-deadbeef`, ["aaaaaaaa"])).toBe(false);
    expect(mayRemove(`mcpe-it-${process.pid + 1}-aaaaaaaa-${role}-deadbeef`, ["aaaaaaaa"])).toBe(false);
    expect(mayRemove(`mcpe-it-0-aaaaaaaa-${role}-deadbeef`, [])).toBe(false);
  }
  // A project's network and proxy (leg 6) are named after the sandbox: the same rule decides them.
  expect(mayRemove(`${prefix}aaaaaaaa-box-net`, [])).toBe(true);
  expect(mayRemove(`${prefix}aaaaaaaa-box-proxy-deadbeef`, [])).toBe(true);
  for (const name of ["mcpe-aaaaaaaa-gron-net", "mcpe-aaaaaaaa-gron-proxy-deadbeef", "mcpe-it-0-aaaaaaaa-box-net"]) expect(mayRemove(name, ["aaaaaaaa"])).toBe(false);
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

    // Offline name resolution waits instead of failing at once under gVisor, so the command needs longer than the 5 s default there
    // (the measured difference of the first full gVisor run); it still ends in DOWN.
    const net = await app.callTool("sandbox_exec", {
      project: "gron",
      command: "getent hosts github.com >/dev/null && echo UP || echo DOWN",
      ...(process.env.MCPE_DOCKER_RUNTIME === "runsc" ? { timeout_seconds: 90 } : {}),
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
      // Under a named runtime the sandbox is made under it, as an earlier version would have: a sandbox of another runtime is rightly refused.
      const ctr = await run(
        "docker",
        ["run", "-d", "--name", name, "--label", "mcp-everything=1", ...(cfg.docker.runtime ? ["--runtime", cfg.docker.runtime] : []), "-v", `${name}:/workspace`, cfg.docker.images.generic, "sleep", "infinity"],
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
      this.attachedDuringBuild = (await this.networkState(container)) !== "off";
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
      expect((await docker.networkState(record.container)) !== "off").toBe(false);
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
    await docker.setNetwork(name, "off");
    expect(await inspect(name, "{{index .Config.Labels \"mcp-everything.idle-timeout\"}}")).toBe(String(IDLE));

    await waitStopped(name);
    expect(await inspect(name, "{{.State.ExitCode}}")).toBe("0");
    expect((await docker.networkState(name)) !== "off").toBe(false);

    expect(await docker.ensureRunning(name)).toBe(true);
    expect(await docker.state(name)).toBe("running");
    expect((await docker.networkState(name)) !== "off").toBe(false);
    // The interface names come from /proc/net/dev (gVisor leaves /sys/class/net empty). Under runsc the idle stop discards what
    // is outside volumes unless runsc was registered with --overlay2=none (the CI registration, and the README's requirement).
    const after = await sh(name, `cat /opt/mcpe/bin/t /workspace/work/w; ${IFACES}`);
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
    expect((await docker.networkState(name)) !== "off").toBe(true);

    await waitStopped(name);
    await docker.setNetwork(name, "off");
    expect(await docker.state(name)).toBe("stopped");
    await docker.ensureRunning(name);
    expect((await docker.networkState(name)) !== "off").toBe(false);
    expect((await sh(name, IFACES)).stdout.trim()).toBe("lo");
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
    name, image: ALPINE, command: ["sh", "-c", script], network: false, hosts: [], timeoutSec: 60, env: [], ...over,
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

  it("(c2) an entrypoint override replaces the image's own, and \"\" clears it (the pinned clone image's entrypoint is git)", async () => {
    try {
      await docker.ensureImage(cfg.docker.probeImage);
      const image = cfg.docker.probeImage;
      const out = await runScanners(docker, staging, [
        scanner("override", "", { image, entrypoint: "sh", command: ["-c", `printf '%s' '${SARIF}'`] }),
        scanner("cleared", "", { image, entrypoint: "", command: ["sh", "-c", `printf '%s' '${SARIF}'`] }),
      ], { totalTimeoutSec: 300, dataDir });
      expect(out[0], JSON.stringify(out[0])).toMatchObject({ name: "override", status: "ran", counts: { error: 1, warning: 0, note: 1 } });
      expect(out[1], JSON.stringify(out[1])).toMatchObject({ name: "cleared", status: "ran", counts: { error: 1, warning: 0, note: 1 } });
      expect(await gone()).toBe("");
    } finally {
      await sweepOwn();
    }
  }, 300_000);

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
    expect(text(res)).toMatch(/^Blocked by the scan policy: 1 finding at error or above, from fake\. Nothing was installed\./);
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
    expect(after.warnings.join("\n")).toMatch(/A reinstall at commit [0-9a-f]{12} was blocked by the scan policy on \d{4}-\d{2}-\d{2} \(UTC\)/);
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

/**
 * Contained networks and the one-shot proxy (flight 02, leg 5). Every object these cases make carries the describe's
 * own installation id as its owner label (random, so none is an operator's) and a name under the suite's prefix
 * `mcpe-it-<pid>-`. Every removal goes through `removeContainerChecked`, `removeNetworkChecked` or
 * `removeVolumeChecked`, so nothing the suite did not create can be removed. The prober is the proxy image running
 * `node -e` with `net.connect`, so the error code is printed. The cases that need a host listener open one in the
 * test process on 0.0.0.0, for the positive controls.
 */
describe.skipIf(!enabled)("docker integration: contained networks and the one-shot proxy", () => {
  const id = randomBytes(4).toString("hex");
  const cfg = loadConfig({ ...process.env, MCPE_NAME_PREFIX: prefix });
  const docker = new OneShotDocker(cfg, id);
  const owned = `label=mcp-everything.owner=${id}`;
  const lines = async (args: string[]) => (await run("docker", args, { timeoutMs: 30_000 })).stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const remaining = async () => ({
    containers: (await lines(["ps", "-a", "--filter", owned, "--format", "{{.Names}}"])).sort(),
    networks: (await lines(["network", "ls", "--filter", owned, "--format", "{{.Name}}"])).sort(),
    volumes: (await lines(["volume", "ls", "--filter", owned, "--format", "{{.Name}}"])).sort(),
  });
  const NONE = { containers: [], networks: [], volumes: [] };
  /** Removes whatever this describe's id left: containers, then networks, then volumes, each name through the checked removal. */
  const sweepOwn = async () => {
    const left = await remaining();
    for (const n of left.containers) await removeContainerChecked(n, []);
    for (const n of left.networks) await removeNetworkChecked(n, []);
    for (const n of left.volumes) await removeVolumeChecked(n, []);
  };
  /** What this describe's id owns, after giving a daemon that removes by `--rm` up to ten seconds. */
  const nothingRemains = async () => {
    const until = Date.now() + 10_000;
    let now = await remaining();
    while (JSON.stringify(now) !== JSON.stringify(NONE) && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500));
      now = await remaining();
    }
    return now;
  };

  /** A prober script: `net.connect` to each target, one line `host:port=CONNECTED|TIMEOUT|ERR <code>` each. It ignores the proxy variables (raw sockets). */
  const probeScript = (targets: Array<[string, number]>) =>
    `const net=require("net");const T=${JSON.stringify(targets)};let i=0;(function next(){if(i>=T.length)process.exit(0);const [h,p]=T[i++];` +
    `const s=net.connect({host:h,port:p});s.setTimeout(4000);let done=false;const fin=(r)=>{if(done)return;done=true;console.log(h+":"+p+"="+r);s.destroy();next()};` +
    `s.on("connect",()=>fin("CONNECTED"));s.on("timeout",()=>fin("TIMEOUT"));s.on("error",(e)=>fin("ERR "+e.code))})()`;
  /** A CONNECT script: a raw `CONNECT host:port` to the proxy, at the address in HTTPS_PROXY, for each target; prints `host:port=<status>`. */
  const connectScript = (targets: Array<[string, number]>) =>
    `${PROXY_HOST_JS}const net=require("net");const T=${JSON.stringify(targets)};let i=0;(function next(){if(i>=T.length)process.exit(0);const [h,p]=T[i++];` +
    `const s=net.connect({host:P.hostname,port:Number(P.port)});s.setTimeout(8000);let buf="";let done=false;const fin=(r)=>{if(done)return;done=true;console.log(h+":"+p+"="+r);s.destroy();next()};` +
    `s.on("connect",()=>s.write("CONNECT "+h+":"+p+" HTTP/1.1\\r\\nHost: "+h+":"+p+"\\r\\n\\r\\n"));` +
    `s.on("data",(d)=>{buf+=d;const m=/^HTTP\\/1\\.[01] (\\d{3})/.exec(buf);if(m)fin(m[1])});s.on("timeout",()=>fin("TIMEOUT"));s.on("error",(e)=>fin("ERR "+e.code));s.on("close",()=>fin("CLOSED"))})()`;
  const results = (stdout: string) =>
    Object.fromEntries(stdout.split("\n").filter(Boolean).map((l) => [l.slice(0, l.lastIndexOf("=")), l.slice(l.lastIndexOf("=") + 1)])) as Record<string, string>;
  /** Probe `targets` from a one-shot on `network` (no proxy variables: this is the plain path with a network given). */
  const probeFrom = async (network: string, targets: Array<[string, number]>) => {
    const res = await docker.once({ role: "scan", image: cfg.docker.proxyImage, network, entrypoint: "node", args: ["-e", probeScript(targets)], timeoutMs: 120_000, maxBytes: 100_000 });
    expect(res.code, res.stderr).toBe(0);
    return results(res.stdout);
  };
  const firstHost = (cidr: string) => {
    const o = cidr.split("/")[0]!.split(".").map(Number);
    o[3] = o[3]! + 1;
    return o.join(".");
  };
  const REFUSED = /^(ERR (ENETUNREACH|EHOSTUNREACH|ETIMEDOUT)|TIMEOUT)$/;
  const REACHED = /^(CONNECTED|ERR ECONNREFUSED)$/;
  const hex = () => randomBytes(4).toString("hex");

  let server: net.Server;
  let hostPort = 0;
  let desktop = false;
  let bridgeGateway = "";
  beforeAll(async () => {
    server = net.createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
    hostPort = (server.address() as net.AddressInfo).port;
    desktop = /docker desktop/i.test((await run("docker", ["info", "--format", "{{.OperatingSystem}}"], { timeoutMs: 30_000 })).stdout);
    bridgeGateway = (await run("docker", ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"], { timeoutMs: 30_000 })).stdout.trim();
  });
  afterAll(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await sweepOwn();
  });

  /** A listener container on `bridge`, owned by this describe; returns its name and address. Removed by the caller through the checked helper. */
  const listenerOnBridge = async () => {
    const name = `${prefix}${id}-listener-${hex()}`;
    expect(mayRemove(name, [])).toBe(true);
    await docker.ensureImage(cfg.docker.proxyImage);
    const made = await run(
      "docker",
      [
        "run", "-d", "--name", name, "--label", "mcp-everything=1", "--label", `mcp-everything.owner=${id}`,
        "--cap-drop", "ALL", "--read-only", "--memory", "64m", "--pids-limit", "64", "--network", "bridge",
        "--entrypoint", "node", cfg.docker.proxyImage, "-e", "require('net').createServer((s)=>s.destroy()).listen(9000,'0.0.0.0')",
      ],
      { timeoutMs: 60_000 },
    );
    expect(made.code, made.stderr).toBe(0);
    const address = (await run("docker", ["inspect", "--format", "{{.NetworkSettings.Networks.bridge.IPAddress}}", name], { timeoutMs: 30_000 })).stdout.trim();
    expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    // Positive control, and readiness: a prober on bridge connects.
    const until = Date.now() + 20_000;
    let seen = "";
    while (Date.now() < until) {
      seen = (await probeFrom("bridge", [[address, 9000]]))[`${address}:9000`] ?? "";
      if (seen === "CONNECTED") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(seen).toBe("CONNECTED");
    return { name, address };
  };

  it("runs git ls-remote behind its proxy, allowed github.com: alias resolution and CONNECT end to end, nothing left after", async () => {
    assertNameCheckBehaves();
    try {
      const res = await docker.once({
        role: "clone", image: cfg.docker.probeImage, egress: { allow: [parseHostEntry("github.com", "agent")] },
        args: ["ls-remote", "https://github.com/tomnomnom/gron", "HEAD"], timeoutMs: 120_000, maxBytes: 100_000,
      });
      expect(res.stderr).not.toMatch(/fatal/);
      expect(res.code).toBe(0);
      expect(res.stdout).toMatch(/^[0-9a-f]{40}\tHEAD/);
      expect(res.proxy).toBeUndefined();
      expect(await nothingRemains()).toEqual(NONE);
    } finally {
      await sweepOwn();
    }
  }, 300_000);

  it("allowed nothing: git ls-remote fails, and the refusals name github.com as not-allowed", async () => {
    try {
      const res = await docker.once({
        role: "clone", image: cfg.docker.probeImage, egress: { allow: [] },
        args: ["ls-remote", "https://github.com/tomnomnom/gron", "HEAD"], timeoutMs: 120_000, maxBytes: 100_000,
      });
      expect(res.code).not.toBe(0);
      expect(res.proxy).toBeDefined();
      expect(res.proxy).not.toEqual({ unavailable: true });
      const rows = (res.proxy as { rows: Array<{ host: string | null; reason: string }> }).rows;
      expect(rows.some((r) => r.host === "github.com" && r.reason === "not-allowed")).toBe(true);
      expect(await nothingRemains()).toEqual(NONE);
    } finally {
      await sweepOwn();
    }
  }, 300_000);

  it("a contained prober cannot reach the network's .1, the bridge gateway, 169.254.169.254, the Docker Desktop gateway or a container on bridge; each has a positive control from bridge", async () => {
    let listener: { name: string; address: string } | undefined;
    let contained: Awaited<ReturnType<Docker["createContainedNetwork"]>> | undefined;
    try {
      contained = await docker.createContainedNetwork({ role: "oneshot-net" });
      expect(mayRemove(contained.name, [])).toBe(true);
      listener = await listenerOnBridge();
      const dotOne = firstHost(contained.subnet);
      const targets: Array<[string, number]> = [[dotOne, hostPort], [bridgeGateway, hostPort], ["169.254.169.254", 80], [listener.address, 9000]];
      if (desktop) targets.push(["192.168.65.254", hostPort]);

      // Positive controls, from a prober on bridge: the same prober reaches the host listener (a real host on Linux; on Docker
      // Desktop the bridge gateway is not the host, T5, so any answer will do), the Desktop gateway, and the listener container.
      const control = await probeFrom("bridge", targets);
      expect(control[`${bridgeGateway}:${hostPort}`]).toMatch(desktop ? REACHED : /^CONNECTED$/);
      expect(control[`${listener.address}:9000`]).toBe("CONNECTED");
      if (desktop) expect(control[`192.168.65.254:${hostPort}`]).toMatch(REACHED);

      // The contained prober (no proxy variables) is refused. The network's own .1 has no gateway behind it, so nothing
      // may connect there either; only the others must be unreachable outright.
      const direct = await probeFrom(contained.name, targets);
      expect(Object.keys(direct).sort()).toEqual(targets.map(([h, p]) => `${h}:${p}`).sort());
      for (const [k, v] of Object.entries(direct)) expect(v, `${k} from the contained network`).not.toBe("CONNECTED");
      for (const [h, p] of targets) {
        if (h === dotOne) continue;
        expect(direct[`${h}:${p}`], `${h}:${p} from the contained network`).toMatch(REFUSED);
      }
    } finally {
      if (listener) await removeContainerChecked(listener.name, []).catch(() => undefined);
      if (contained) await removeNetworkChecked(contained.name, []).catch(() => undefined);
      await sweepOwn();
    }
  }, 300_000);

  it("through the proxy, CONNECT to host.docker.internal and to a container on bridge get 403: bridge is never reachable from a contained network", async () => {
    let listener: { name: string; address: string } | undefined;
    try {
      listener = await listenerOnBridge();
      const targets: Array<[string, number]> = [["host.docker.internal", 80], [listener.address, 9000], [bridgeGateway, hostPort]];
      const spec = (egress: { allow: ReturnType<typeof parseHostEntry>[]; local?: boolean }): OneShotSpec => ({
        role: "scan", image: cfg.docker.proxyImage, egress, entrypoint: "node", args: ["-e", connectScript(targets)], timeoutMs: 120_000, maxBytes: 100_000,
      });
      // Allowed nothing, then allowed those very names and addresses with `local`: the bridge's own subnet is the proxy's own, never reachable.
      for (const egress of [
        { allow: [parseHostEntry("github.com", "agent")] },
        {
          allow: [parseHostEntry("host.docker.internal", "local-access"), parseHostEntry(`${listener.address}:9000`, "scanner"), parseHostEntry(`${bridgeGateway}:${hostPort}`, "scanner")],
          local: true,
        },
      ]) {
        const res = await docker.once(spec(egress));
        expect(res.code, res.stderr).toBe(0);
        const got = results(res.stdout);
        // Not allowed is 403. Allowed by name or literal but refused by address (or by name resolution) is 502 as observed for
        // host.docker.internal on this daemon; never 200. Both are refusals; the first run must be 403 throughout.
        for (const [h, p] of targets) {
          const status = got[`${h}:${p}`];
          if (egress.local === undefined) expect(status, `${h}:${p} through the proxy`).toBe("403");
          else expect(status, `${h}:${p} through the proxy`).toMatch(/^(403|502)$/);
        }
      }
      expect(await nothingRemains()).toEqual({ ...NONE, containers: [listener.name] });
    } finally {
      if (listener) await removeContainerChecked(listener.name, []).catch(() => undefined);
      await sweepOwn();
    }
  }, 300_000);

  it("while it runs the proxy is hardened and joined to bridge and the one-shot network only, and is not reachable from bridge", async () => {
    // A one-shot that stays a while; the test looks at the live objects, then removes the one-shot (a checked removal of its own
    // container), which ends the call, and the call tears the rest down.
    const call = docker.once({ role: "clone", image: cfg.docker.proxyImage, egress: { allow: [] }, entrypoint: "sleep", args: ["120"], timeoutMs: 180_000, maxBytes: 10_000 });
    const settled = call.then(() => undefined, (e: unknown) => e);
    try {
      const until = Date.now() + 120_000;
      let proxyName = "";
      let oneShot = "";
      while (Date.now() < until && (proxyName === "" || oneShot === "")) {
        proxyName = (await lines(["ps", "--filter", owned, "--filter", "label=mcp-everything.role=oneshot-proxy", "--filter", "status=running", "--format", "{{.Names}}"]))[0] ?? "";
        oneShot = (await lines(["ps", "--filter", owned, "--filter", "label=mcp-everything.role=clone", "--filter", "status=running", "--format", "{{.Names}}"]))[0] ?? "";
        if (proxyName === "" || oneShot === "") await new Promise((r) => setTimeout(r, 500));
      }
      expect(mayRemove(proxyName, [])).toBe(true);
      expect(mayRemove(oneShot, [])).toBe(true);
      const fmt = '{"mode":{{json .HostConfig.NetworkMode}},"ro":{{json .HostConfig.ReadonlyRootfs}},"capDrop":{{json .HostConfig.CapDrop}},"capAdd":{{json .HostConfig.CapAdd}},"ports":{{json .HostConfig.PortBindings}},"user":{{json .Config.User}},"nets":{{json .NetworkSettings.Networks}}}';
      const p = JSON.parse((await run("docker", ["inspect", "--format", fmt, proxyName], { timeoutMs: 30_000 })).stdout) as {
        mode: string; ro: boolean; capDrop: string[]; capAdd: string[] | null; ports: Record<string, unknown> | null; user: string; nets: Record<string, { IPAddress: string }>;
      };
      // Leg 14: the proxy is created on the one-shot network (so its address and MAC are fixed at create) and `bridge` is joined after;
      // HostConfig.NetworkMode is the network it was created on. Both networks are checked through `nets` below.
      expect(p.mode).toMatch(/-oneshot-net-/);
      expect(Object.keys(p.nets).sort()).toEqual(["bridge", p.mode].sort());
      expect(p.ro).toBe(true);
      expect(p.capDrop).toEqual(["ALL"]);
      expect(p.capAdd ?? []).toEqual([]);
      expect(Object.keys(p.ports ?? {})).toEqual([]);
      expect(p.user).toBe("node");
      const contained = Object.keys(p.nets).filter((n) => n !== "bridge");
      expect(Object.keys(p.nets).sort()).toEqual(["bridge", ...contained].sort());
      expect(contained).toHaveLength(1);
      expect(contained[0]).toMatch(new RegExp(`^${prefix}${id}-oneshot-net-[0-9a-f]{8}$`));
      const o = JSON.parse((await run("docker", ["inspect", "--format", '{"mode":{{json .HostConfig.NetworkMode}}}', oneShot], { timeoutMs: 30_000 })).stdout) as { mode: string };
      expect(o.mode).toBe(contained[0]);
      // `docker exec` works into the read-only, non-root, capability-less proxy (readiness already depends on it).
      const exec = await run("docker", ["exec", proxyName, "node", "-e", "console.log(process.getuid()+' '+process.version)"], { timeoutMs: 30_000 });
      expect(exec.code, exec.stderr).toBe(0);
      expect(exec.stdout.trim()).toMatch(/^\d+ v(2[2-9]|[3-9]\d)\./);
      // Not reachable from bridge: the proxy binds only its internal address. The control is the host listener from the same prober.
      const address = p.nets.bridge!.IPAddress;
      expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      const seen = await probeFrom("bridge", [[address, 3128], [bridgeGateway, hostPort]]);
      expect(seen[`${address}:3128`]).toBe("ERR ECONNREFUSED");
      expect(seen[`${bridgeGateway}:${hostPort}`]).toMatch(desktop ? REACHED : /^CONNECTED$/);
      await removeContainerChecked(oneShot, []);
      expect(await settled).toBeUndefined();
      expect(await nothingRemains()).toEqual(NONE);
    } finally {
      await sweepOwn();
      await settled;
    }
  }, 400_000);

  it("a proxy that cannot start (an image without node) is ProxyStartError and leaves nothing", async () => {
    // The probe image has no node: `start` fails with "executable file not found".
    const cfg2 = loadConfig({ ...process.env, MCPE_NAME_PREFIX: prefix, MCPE_PROXY_IMAGE: cfg.docker.probeImage });
    const bad = new OneShotDocker(cfg2, id);
    try {
      const e = await bad.once({ role: "clone", image: cfg.docker.probeImage, egress: { allow: [] }, args: ["--version"], timeoutMs: 60_000, maxBytes: 10_000 }).then(
        () => undefined,
        (err: unknown) => err,
      );
      expect(e).toBeInstanceOf(ProxyStartError);
      expect((e as Error).message).toMatch(/^the network proxy did not start: /);
      expect(await nothingRemains()).toEqual(NONE);
    } finally {
      await sweepOwn();
    }
  }, 300_000);

  it("the sweep removes an aged one-shot network and proxy of this installation, and leaves one with a project label", async () => {
    const sweeper = new Docker(cfg, id);
    const netName = `${prefix}${id}-oneshot-net-${hex()}`;
    const proxyName = `${prefix}${id}-oneshot-proxy-${hex()}`;
    const projNet = `${prefix}${id}-project-net-${hex()}`;
    const projProxy = `${prefix}${id}-oneshot-proxy-${hex()}`;
    for (const n of [netName, proxyName, projNet, projProxy]) expect(mayRemove(n, [])).toBe(true);
    const base = ["--label", "mcp-everything=1", "--label", `mcp-everything.owner=${id}`];
    try {
      await docker.ensureImage(ALPINE);
      for (const [name, role, project] of [[netName, "oneshot-net", undefined], [projNet, "oneshot-net", "oneshot"]] as const) {
        const r = await run("docker", ["network", "create", "--internal", ...base, "--label", `mcp-everything.role=${role}`, ...(project ? ["--label", `mcp-everything.project=${project}`] : []), name], { timeoutMs: 60_000 });
        expect(r.code, r.stderr).toBe(0);
      }
      for (const [name, project] of [[proxyName, undefined], [projProxy, ""]] as const) {
        const r = await run("docker", ["create", "--name", name, ...base, "--label", "mcp-everything.role=oneshot-proxy", ...(project !== undefined ? ["--label", `mcp-everything.project=${project}`] : []), ALPINE, "true"], { timeoutMs: 60_000 });
        expect(r.code, r.stderr).toBe(0);
      }
      expect(await remaining()).toEqual({ containers: [proxyName, projProxy].sort(), networks: [netName, projNet].sort(), volumes: [] });
      await new Promise((r) => setTimeout(r, 1100));
      const swept = await sweeper.sweepCheckLeftovers(0);
      expect(swept.failures).toBe(0);
      expect(swept.removed).toHaveLength(2);
      for (const s of swept.removed) expect(s).toMatch(/^[0-9a-f]{64}$/);
      expect(await remaining()).toEqual({ containers: [projProxy], networks: [projNet], volumes: [] });
    } finally {
      await sweepOwn();
    }
  }, 120_000);
});

/**
 * Leg 6, the Docker layer of a project's contained network. Every object is made by the primitives under test
 * and owned by a random id of this describe's own, named under the suite's prefix; every removal here is
 * `removeContainerChecked`, `removeNetworkChecked` or `removeVolumeChecked` (the name check first), and a final
 * sweep of this owner's objects runs in `finally` and `afterAll`. Nothing touches an object the suite did not make.
 * The sandboxes run `alpine` (no declared volumes); the volume case uses the probe image on purpose.
 */
describe.skipIf(!enabled)("docker integration: project network primitives", () => {
  const id = randomBytes(4).toString("hex");
  const cfg = loadConfig({ ...process.env, MCPE_NAME_PREFIX: prefix, MCPE_SANDBOX_IDLE_TIMEOUT: "0" });
  const docker = new OneShotDocker(cfg, id);
  const owned = `label=mcp-everything.owner=${id}`;
  const PROJECT = "github:o/pnet-test";
  const hex = () => randomBytes(4).toString("hex");
  const lines = async (args: string[]) => (await run("docker", args, { timeoutMs: 30_000 })).stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const remaining = async () => ({
    containers: (await lines(["ps", "-a", "--filter", owned, "--format", "{{.Names}}"])).sort(),
    networks: (await lines(["network", "ls", "--filter", owned, "--format", "{{.Name}}"])).sort(),
    volumes: (await lines(["volume", "ls", "--filter", owned, "--format", "{{.Name}}"])).sort(),
  });
  const NONE = { containers: [], networks: [], volumes: [] };
  /** Containers (with their anonymous volumes), then networks, then volumes, each name through the checked removal. */
  const sweepOwn = async () => {
    const left = await remaining();
    for (const n of left.containers) await removeContainerWithVolumesChecked(n, []);
    for (const n of left.networks) await removeNetworkChecked(n, []);
    for (const n of left.volumes) await removeVolumeChecked(n, []);
  };
  /** The names of the networks a container is on, sorted. */
  const networksOf = async (name: string) =>
    (await lines(["inspect", "--format", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}", name])).sort();

  afterAll(async () => {
    await sweepOwn();
  });

  const makeSandbox = async () => {
    const name = docker.sandboxName(`pn${hex()}`);
    expect(mayRemove(name, [])).toBe(true);
    await docker.createSandboxVolume(name);
    const ref = await docker.createContainer({ name, volume: name, image: ALPINE, project: PROJECT });
    return { name, ref };
  };
  /** The project network and a proxy on it, from a fixed test configuration and labels. */
  const makeProxy = async (name: string) => {
    const network = await docker.ensureProjectNetwork(name, PROJECT);
    const config = proxyConfig({
      allow: [parseHostEntry("github.com", "agent")],
      listenCidr: network.subnet,
      resolvers: await docker.readUpstreamResolvers(),
      limits: { bindWaitMs: 3_000 },
    });
    const proxy = await docker.createProjectProxy(name, PROJECT, config, { "mcp-everything.config": "leg6" });
    expect(mayRemove(proxy.name, [])).toBe(true);
    return { network, proxy };
  };

  it("moves a sandbox between off, contained and open: contained is on the -net only, open removes the proxy and the -net, off leaves nothing", async () => {
    assertNameCheckBehaves();
    try {
      const { name, ref } = await makeSandbox();
      const netName = `${name}-net`;
      expect(mayRemove(netName, [])).toBe(true);
      expect(await networksOf(name)).toEqual(["bridge"]);
      expect(await docker.networkState(name)).toBe("open");

      const { network, proxy } = await makeProxy(name);
      expect(network.name).toBe(netName);
      expect(network.created).toBe(true);
      // The proxy is on bridge (the way out) and on the project network, under its alias, and it is ours.
      expect(await networksOf(proxy.name)).toEqual(["bridge", netName].sort());
      // At the last usable address of the network's subnet, given with `network connect --ip` (IPAMConfig), and under no alias.
      const configured = (await lines(["inspect", "--format", `{{json (index .NetworkSettings.Networks "${netName}").IPAMConfig}}`, proxy.name])).join("");
      expect(JSON.parse(configured)).toMatchObject({ IPv4Address: proxyAddress(network.subnet) });
      // Leg 14: created with `--network name=,ip=,mac-address=` (then `bridge` connected): the MAC is the network's fixed one.
      const mac = (await lines(["inspect", "--format", `{{(index .NetworkSettings.Networks "${netName}").MacAddress}}`, proxy.name])).join("").trim();
      expect(mac).toBe(proxyMac(network.id));
      expect(await docker.projectProxyAttached(proxy.id, network)).toBe(true);
      const aliases = (await lines(["inspect", "--format", `{{json (index .NetworkSettings.Networks "${netName}").Aliases}}`, proxy.name])).join("");
      expect(aliases).not.toContain("mcpe-proxy");
      expect((await docker.listProjectProxies(name)).map((p) => p.id)).toEqual([proxy.id]);

      await docker.setNetwork(name, "contained");
      expect(await networksOf(name)).toEqual([netName]);
      expect(await docker.networkState(name)).toBe("contained");
      expect(await docker.networkState(ref)).toBe("contained");
      expect((await docker.exec(ref, ["sh", "-c", IFACES], { timeoutSec: 30 })).stdout.trim().split(/\s+/).sort()).toEqual([expect.stringMatching(/^eth\d$/), "lo"]);

      await docker.setNetwork(name, "open");
      expect(await networksOf(name)).toEqual(["bridge"]);
      expect(await docker.networkState(name)).toBe("open");
      expect(await docker.listProjectProxies(name)).toEqual([]);
      expect((await run("docker", ["network", "inspect", netName], { timeoutMs: 30_000 })).code).not.toBe(0);
      expect((await remaining()).containers).toEqual([name]);
      expect((await remaining()).networks).toEqual([]);

      // Again: made anew, contained, then off.
      await makeProxy(name);
      await docker.setNetwork(name, "contained");
      expect(await docker.networkState(name)).toBe("contained");
      await docker.setNetwork(name, "off");
      expect(await networksOf(name)).toEqual([]);
      expect(await docker.networkState(name)).toBe("off");
      expect(await docker.listProjectProxies(name)).toEqual([]);
      expect((await remaining()).networks).toEqual([]);
      expect((await remaining()).containers).toEqual([name]);
    } finally {
      await sweepOwn();
    }
    expect(await remaining()).toEqual(NONE);
  }, 300_000);

  // runsc cannot clean up a container whose start failed (a stale containerd task), so a stopped sandbox whose -net was removed
  // must be recreated: the failed `docker start` below leaves it unable to start again (leg 14; the README's gVisor limits).
  it.skipIf(process.env.MCPE_DOCKER_RUNTIME === "runsc")("T14 in code: a stopped contained sandbox whose -net was removed starts again, on a new -net, after ensure and attach", async () => {
    try {
      const { name, ref } = await makeSandbox();
      const netName = `${name}-net`;
      const { network, proxy } = await makeProxy(name);
      await docker.setNetwork(name, "contained");
      expect(await networksOf(name)).toEqual([netName]);

      // Stop it, take its proxy and its -net away (the checked removals), as a daemon restart or a prune would.
      await run("docker", ["stop", name], { timeoutMs: 60_000 });
      await removeContainerWithVolumesChecked(proxy.name, []);
      await removeNetworkChecked(netName, []);
      // The stopped container still lists the network by name (T14); starting it fails.
      expect(await docker.networkState(name)).toBe("contained");
      expect((await run("docker", ["start", name], { timeoutMs: 60_000 })).code).not.toBe(0);

      const again = await docker.ensureProjectNetwork(name, PROJECT);
      expect(again.created).toBe(true);
      expect(again.id).not.toBe(network.id);
      await docker.attachProjectNetwork(ref, again);
      // Under gVisor this start failed in the first full run with no reason given: print Docker's own words and the container's state.
      const restarted = await run("docker", ["start", name], { timeoutMs: 60_000 });
      const state = await run("docker", ["inspect", "--format", "{{json .State}} networks={{json .NetworkSettings.Networks}}", name], { timeoutMs: 30_000 });
      expect(restarted.code, `docker start: ${restarted.stderr.trim()} | ${restarted.stdout.trim()}\ninspect: ${state.stdout.trim().slice(0, 1500)}`).toBe(0);
      expect(await docker.state(name)).toBe("running");
      expect(await networksOf(name)).toEqual([netName]);
    } finally {
      await sweepOwn();
    }
    expect(await remaining()).toEqual(NONE);
  }, 300_000);

  it("destroy of a contained project leaves no container, proxy, -net or volume of it", async () => {
    try {
      const { name } = await makeSandbox();
      const { proxy } = await makeProxy(name);
      await docker.setNetwork(name, "contained");
      expect((await remaining()).containers.sort()).toEqual([name, proxy.name].sort());
      expect((await remaining()).networks).toEqual([`${name}-net`]);
      expect((await remaining()).volumes).toEqual([name]);
      await docker.destroy(name, name);
      expect(await remaining()).toEqual(NONE);
    } finally {
      await sweepOwn();
    }
  }, 300_000);

  it("destroy finds the proxy and the -net after the container is gone, and removeContainer leaves them", async () => {
    try {
      const { name } = await makeSandbox();
      const { proxy } = await makeProxy(name);
      await docker.removeContainer(name);
      expect((await remaining()).containers).toEqual([proxy.name]);
      expect((await remaining()).networks).toEqual([`${name}-net`]);
      await docker.destroy(name, name);
      expect(await remaining()).toEqual(NONE);
    } finally {
      await sweepOwn();
    }
  }, 300_000);

  it("a one-shot of the probe image leaves no anonymous volume (the timed-out path removes it with rm -f -v)", async () => {
    // The control: the probe image does make an anonymous volume at create time (`alpine/git` declares VOLUME /git).
    // Without this, "no new volume" could be true of an image that never made one.
    const control = `${prefix}${id}-volctl-${hex()}`;
    expect(mayRemove(control, [])).toBe(true);
    await docker.ensureImage(cfg.docker.probeImage);
    try {
      const made = await run("docker", ["create", "--name", control, "--label", "mcp-everything=1", "--label", `mcp-everything.owner=${id}`, cfg.docker.probeImage], { timeoutMs: 60_000 });
      expect(made.code, made.stderr).toBe(0);
      const mounts = await lines(["inspect", "--format", "{{range .Mounts}}{{.Type}} {{.Destination}}\n{{end}}", control]);
      expect(mounts).toContain("volume /git");
    } finally {
      await removeContainerWithVolumesChecked(control, []);
    }

    const volumes = async () => new Set(await lines(["volume", "ls", "-q"]));
    const before = await volumes();
    const started = Date.now();
    const res = await docker.once({
      role: "clone", image: cfg.docker.probeImage, network: "none", entrypoint: "sleep", args: ["120"], timeoutMs: 3_000, maxBytes: 10_000,
    });
    expect(res.timedOut).toBe(true);
    // Not by count: the volumes that appeared, kept to those created inside this case's window (another process
    // on the daemon may make its own). `CreatedAt` is the daemon's clock; the margin covers a skew between it and ours.
    const appeared = [...(await volumes())].filter((v) => !before.has(v));
    const inWindow: string[] = [];
    for (const v of appeared) {
      const r = await run("docker", ["volume", "inspect", "--format", "{{.CreatedAt}}", v], { timeoutMs: 30_000 });
      if (r.code === 0 && Date.parse(r.stdout.trim()) >= started - 5_000) inWindow.push(v);
    }
    expect(inWindow).toEqual([]);
    expect((await remaining()).containers).toEqual([]);
  }, 120_000);
});

/**
 * Leg 7: containment through the hook. Sandboxes are made on the proxy image (it has Node, for the probers). Every
 * object carries this describe's own installation id and the suite's prefix, so the checked removals decide each one;
 * the registry the cases use is a temporary directory of this describe's own; nothing touches an object or a file the
 * suite did not create. The cases create sandboxes, volumes, networks and proxies, and remove only those, through
 * `removeContainerWithVolumesChecked`, `removeNetworkChecked` and `removeVolumeChecked` (`mayRemove` names).
 */
describe.skipIf(!enabled)("docker integration: containment hook (leg 7)", () => {
  const id = randomBytes(4).toString("hex");
  // A directory of this describe's own, named by its id; nothing makes it until a case writes the registry (so a skipped run makes none).
  const dataDir = path.join(os.tmpdir(), `mcpe-it-ct-${id}`);
  const cfg = loadConfig({ ...process.env, MCPE_NAME_PREFIX: prefix, MCPE_SANDBOX_IDLE_TIMEOUT: "0", MCPE_NETWORK: "contained", MCPE_DATA_DIR: dataDir, MCPE_LOCAL_ACCESS: "" });
  const docker = new Docker(cfg, id);
  const registry = new Registry(dataDir);
  const containment = new Containment(cfg, registry, docker, { dataDir });
  const owned = `label=mcp-everything.owner=${id}`;
  const hex = () => randomBytes(4).toString("hex");
  const lines = async (args: string[]) => (await run("docker", args, { timeoutMs: 30_000 })).stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const remaining = async () => ({
    containers: (await lines(["ps", "-a", "--filter", owned, "--format", "{{.Names}}"])).sort(),
    networks: (await lines(["network", "ls", "--filter", owned, "--format", "{{.Name}}"])).sort(),
    volumes: (await lines(["volume", "ls", "--filter", owned, "--format", "{{.Name}}"])).sort(),
  });
  const NONE = { containers: [], networks: [], volumes: [] };
  const sweepOwn = async () => {
    const left = await remaining();
    for (const n of left.containers) await removeContainerWithVolumesChecked(n, []);
    for (const n of left.networks) await removeNetworkChecked(n, []);
    for (const n of left.volumes) await removeVolumeChecked(n, []);
  };
  const networksOf = async (name: string) =>
    (await lines(["inspect", "--format", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}", name])).sort();
  const addressOn = async (name: string, network: string) =>
    (await lines(["inspect", "--format", `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, name]))[0]!;
  const proxiesOf = async (name: string) => (await docker.listProjectProxies(name)).map((p) => p.id);

  /** A raw connect to each target; prints `host:port=CONNECTED|TIMEOUT|ERR <code>`. It ignores the proxy variables. */
  const probeScript = (targets: Array<[string, number]>) =>
    `const net=require("net");const T=${JSON.stringify(targets)};let i=0;(function next(){if(i>=T.length)process.exit(0);const [h,p]=T[i++];` +
    `const s=net.connect({host:h,port:p});s.setTimeout(4000);let done=false;const fin=(r)=>{if(done)return;done=true;console.log(h+":"+p+"="+r);s.destroy();next()};` +
    `s.on("connect",()=>fin("CONNECTED"));s.on("timeout",()=>fin("TIMEOUT"));s.on("error",(e)=>fin("ERR "+e.code))})()`;
  /** A raw `CONNECT host:port` to the proxy, at the address in HTTPS_PROXY (pass it with `-e` for a raw docker exec), for each target; prints `host:port=<status>`. */
  const connectScript = (targets: Array<[string, number]>) =>
    `${PROXY_HOST_JS}const net=require("net");const T=${JSON.stringify(targets)};let i=0;(function next(){if(i>=T.length)process.exit(0);const [h,p]=T[i++];` +
    `const s=net.connect({host:P.hostname,port:Number(P.port)});s.setTimeout(8000);let buf="";let done=false;const fin=(r)=>{if(done)return;done=true;console.log(h+":"+p+"="+r);s.destroy();next()};` +
    `s.on("connect",()=>s.write("CONNECT "+h+":"+p+" HTTP/1.1\\r\\nHost: "+h+":"+p+"\\r\\n\\r\\n"));` +
    `s.on("data",(d)=>{buf+=d;const m=/^HTTP\\/1\\.[01] (\\d{3})/.exec(buf);if(m)fin(m[1])});s.on("timeout",()=>fin("TIMEOUT"));s.on("error",(e)=>fin("ERR "+e.code));s.on("close",()=>fin("CLOSED"))})()`;
  const results = (stdout: string) =>
    Object.fromEntries(stdout.split("\n").filter(Boolean).map((l) => [l.slice(0, l.lastIndexOf("=")), l.slice(l.lastIndexOf("=") + 1)])) as Record<string, string>;
  const REFUSED = /^(ERR (ENETUNREACH|EHOSTUNREACH|ETIMEDOUT)|TIMEOUT)$/;
  /**
   * The CONNECT status for `host:443` through the sandbox's proxy, asked again a few times until it is `want`: the first connect after a
   * proxy swap can be slow (the neighbour's ARP entry for the address is the old proxy's), and a retry is bounded (6 tries, 1 s apart).
   */
  const statusEventually = async (name: string, host: string, want = "200"): Promise<string> => {
    let got = "";
    for (let i = 0; i < 6; i++) {
      got = (await inside(name, connectScript([[host, 443]])))[`${host}:443`] ?? "";
      if (got === want) return got;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return got;
  };

  /**
   * A sandbox on the proxy image (Node inside), with a record for it in this describe's own registry. Left running on `bridge`:
   * since leg 8 `createContainer` refuses a start under containment, so it is created stopped and started by the test itself
   * (these cases want a running sandbox on `bridge` to contain, and a control that reaches its neighbour).
   */
  const makeProject = async (over: Record<string, unknown> = {}) => {
    const slug = `ct${hex()}`;
    const name = docker.sandboxName(slug);
    expect(mayRemove(name, [])).toBe(true);
    const project = `github:o/${slug}`;
    await docker.createSandboxVolume(name);
    await docker.createContainer({ name, volume: name, image: cfg.docker.proxyImage, project, start: false });
    const ref = (await docker.startForContainment(name))!;
    const base = record(slug);
    registry.put({ ...base, container: name, volume: name, ecosystems: ["generic"], repo: { ...base.repo, id: project, path: `o/${slug}` }, ...over } as ProjectRecord);
    return { slug, name, project, ref };
  };
  /** Run a Node script in a sandbox through the Docker layer (so the hook gives it the proxy environment). */
  const inside = async (target: string | SandboxRef, script: string) => {
    const res = await docker.exec(target, ["node", "-e", script], { timeoutSec: 90 });
    expect(res.code, res.stderr).toBe(0);
    return results(res.stdout);
  };
  /** A listener in a sandbox on port 9100, started detached (it dies with the container). */
  const listen = async (name: string) => {
    const r = await run("docker", ["exec", "-d", checkedForRemoval(name, []), "node", "-e", "require('net').createServer((s)=>s.destroy()).listen(9100,'0.0.0.0')"], { timeoutMs: 30_000 });
    expect(r.code, r.stderr).toBe(0);
    await new Promise((r2) => setTimeout(r2, 1500));
  };

  afterAll(async () => {
    await sweepOwn();
    if (isUnderTmp(dataDir) && path.basename(dataDir) === `mcpe-it-ct-${id}`) fs.rmSync(dataDir, { recursive: true, force: true });
  });
  beforeAll(() => {
    containment.install();
  });

  it("two contained projects cannot reach each other: no direct route, and a CONNECT to the other's address through the proxy gets 403; two open sandboxes do reach each other", async () => {
    assertNameCheckBehaves();
    try {
      const a = await makeProject();
      const b = await makeProject();
      const c = await makeProject();
      const d = await makeProject();
      // Positive control: two sandboxes left on bridge reach each other.
      await listen(d.name);
      const control = await inside(c.name, probeScript([[await addressOn(d.name, "bridge"), 9100]]));
      expect(Object.values(control)).toEqual(["CONNECTED"]);

      for (const p of [a, b]) {
        const r = await containment.contain(p.project);
        expect(r.ok, r.ok ? "" : String(r.error)).toBe(true);
        expect(await docker.networkState(p.name)).toBe("contained");
      }
      await listen(b.name);
      const bAddress = await addressOn(b.name, `${b.name}-net`);
      const refA = (await docker.acquire(a.name))!;
      expect(refA.env).toMatchObject({ HTTPS_PROXY: await proxyUrlOf(`${a.name}-net`), NODE_USE_ENV_PROXY: "1" });
      expect(refA.env!.HTTPS_PROXY).toMatch(/^http:\/\/\d{1,3}(\.\d{1,3}){3}:3128$/);
      const direct = await inside(refA, probeScript([[bAddress, 9100]]));
      expect(direct[`${bAddress}:9100`]).toMatch(REFUSED);
      const viaProxy = await inside(refA, connectScript([[bAddress, 9100]]));
      expect(viaProxy[`${bAddress}:9100`]).toBe("403");
    } finally {
      await sweepOwn();
    }
    expect(await remaining()).toEqual(NONE);
  }, 600_000);

  it("replacement without a reinstall: a host added to the record is reachable through the proxy after replace, and exactly one proxy remains", async () => {
    try {
      const p = await makeProject();
      expect((await containment.contain(p.project)).ok).toBe(true);
      const before = await proxiesOf(p.name);
      expect(before).toHaveLength(1);
      expect((await inside(p.name, connectScript([["github.com", 443]])))["github.com:443"]).toBe("403");
      const url = await proxyUrlOf(`${p.name}-net`);

      const rec = registry.get(p.slug)!;
      registry.put({ ...rec, hosts: ["github.com"] } as ProjectRecord);
      // Leg 13: there is no overlap any more (the old proxy leaves the network before the new one is made), so while it
      // replaces a connection is refused by the old proxy or fails for want of one, and the first answer of the new proxy is
      // the allowed one. A raw exec carries the proxy variable by hand (a raw `docker exec` is not hooked).
      const seen: string[] = [];
      let finished = false;
      const replacing = containment.replace(p.project).finally(() => {
        finished = true;
      });
      while (!finished && seen.length < 20) {
        const r = await run("docker", ["exec", "-e", `HTTPS_PROXY=${url}`, p.name, "node", "-e", connectScript([["github.com", 443]])], { timeoutMs: 60_000 });
        seen.push(results(r.stdout)["github.com:443"] ?? `exit ${r.code}`);
      }
      const result = await replacing;
      console.log(`leg 13 replacement: statuses seen while replacing: ${seen.join(",") || "(none)"}`);
      expect(result.kind).toBe("replaced");
      const after = await proxiesOf(p.name);
      expect(after).toHaveLength(1);
      expect(after[0]).not.toBe(before[0]);
      // The same address: nothing about the environment changed, so nothing had to be restarted for addressing.
      expect(await proxyUrlOf(`${p.name}-net`)).toBe(url);
      expect(await statusEventually(p.name, "github.com")).toBe("200");
    } finally {
      await sweepOwn();
    }
    expect(await remaining()).toEqual(NONE);
  }, 600_000);

  it("leg 13: a replacement keeps the proxy's address and the sandbox's environment; a failed replacement puts the old proxy back at that address", async () => {
    /** A Docker whose new proxy never becomes ready: the old one has already left the network when this throws. */
    class FailingCreate extends Docker {
      override async createProjectProxy(): Promise<{ id: string; name: string }> {
        throw new ProxyStartError("injected: the new proxy never became ready");
      }
    }
    try {
      const p = await makeProject({ hosts: ["github.com"] });
      expect((await containment.contain(p.project)).ok).toBe(true);
      const net = (await docker.findProjectNetwork(p.name, p.project))!;
      const url = await proxyUrlOf(`${p.name}-net`);
      expect(url).toBe(`http://${proxyAddress(net.subnet)}:3128`);
      expect((await docker.exec(p.name, ["sh", "-c", "echo $HTTPS_PROXY"], { timeoutSec: 60 })).stdout.trim()).toBe(url);

      // A forced replacement: another proxy, at the same address, and the same environment (nothing to restart for addressing).
      const [first] = await proxiesOf(p.name);
      const macOf = async (c: string) => (await lines(["inspect", "--format", `{{(index .NetworkSettings.Networks "${p.name}-net").MacAddress}}`, c])).join("").trim();
      const macBefore = await macOf(first!);
      expect((await containment.replace(p.project, { force: true })).kind).toBe("replaced");
      const [second] = await proxiesOf(p.name);
      expect(second).not.toBe(first);
      expect(await docker.projectProxyAttached(second!, net)).toBe(true);
      // Leg 14: the same MAC too (fixed from the network's id), so a sandbox's neighbor cache stays right across the swap.
      expect(macBefore).toBe(proxyMac(net.id));
      expect(await macOf(second!)).toBe(proxyMac(net.id));
      expect((await docker.exec(p.name, ["sh", "-c", "echo $HTTPS_PROXY"], { timeoutSec: 60 })).stdout.trim()).toBe(url);
      expect(await statusEventually(p.name, "github.com")).toBe("200");

      // A replacement whose new proxy fails: the old one is stopped, connected at the address, started and ready again.
      const failing = new Containment(cfg, registry, new FailingCreate(cfg, id), { dataDir });
      await expect(failing.replace(p.project, { force: true })).rejects.toThrow(/injected/);
      expect(await proxiesOf(p.name)).toEqual([second]);
      expect(await docker.projectProxyAttached(second!, net)).toBe(true);
      expect((await docker.listProjectProxies(p.name))[0]!.running).toBe(true);
      expect(await statusEventually(p.name, "github.com")).toBe("200");
      expect((await remaining()).containers.filter((n) => n.includes("-proxy-"))).toHaveLength(1);
    } finally {
      await sweepOwn();
    }
    expect(await remaining()).toEqual(NONE);
  }, 600_000);

  it("repair: a proxy removed by hand is made again by an exec, which has the environment; a stopped sandbox whose -net is gone is repaired by acquire and runs contained", async () => {
    try {
      const p = await makeProject({ hosts: ["github.com"] });
      expect((await containment.contain(p.project)).ok).toBe(true);
      const [old] = await proxiesOf(p.name);
      expect(old).toBeDefined();
      const oldName = (await docker.listProjectProxies(p.name))[0]!.name;
      await removeContainerWithVolumesChecked(oldName, []);
      expect(await proxiesOf(p.name)).toEqual([]);
      const echoed = await docker.exec(p.name, ["sh", "-c", "echo $HTTPS_PROXY"], { timeoutSec: 60 });
      expect(echoed.stdout.trim()).toBe(await proxyUrlOf(`${p.name}-net`));
      const again = await proxiesOf(p.name);
      expect(again).toHaveLength(1);
      expect(again[0]).not.toBe(old);

      // Stopped, its proxy and -net removed (the proxy first: a network with an endpoint cannot go).
      await run("docker", ["stop", checkedForRemoval(p.name, [])], { timeoutMs: 60_000 });
      for (const proxy of await docker.listProjectProxies(p.name)) await removeContainerWithVolumesChecked(proxy.name, []);
      await removeNetworkChecked(`${p.name}-net`, []);
      expect(await docker.state(p.name)).toBe("stopped");
      const ref = await docker.acquire(p.name);
      expect(ref).toBeDefined();
      expect(await docker.state(p.name)).toBe("running");
      expect(await networksOf(p.name)).toEqual([`${p.name}-net`]);
      expect(await docker.networkState(p.name)).toBe("contained");
      expect(await proxiesOf(p.name)).toHaveLength(1);
      expect((await inside(ref!, connectScript([["github.com", 443]])))["github.com:443"]).toBe("200");
    } finally {
      await sweepOwn();
    }
    expect(await remaining()).toEqual(NONE);
  }, 600_000);

  it("build phase: a record that is installing is contained with the build hosts, and an exec during that state does not replace the proxy", async () => {
    try {
      const p = await makeProject({ status: "installing", ecosystems: ["node"] });
      expect((await containment.contain(p.project)).ok).toBe(true);
      const [proxy] = await proxiesOf(p.name);
      const got = await inside(p.name, connectScript([["registry.npmjs.org", 443], ["github.com", 443], ["example.org", 443]]));
      expect(got["registry.npmjs.org:443"]).toBe("200");
      expect(got["github.com:443"]).toBe("200");
      expect(got["example.org:443"]).toBe("403");
      expect(await proxiesOf(p.name)).toEqual([proxy]);
      await docker.exec(p.name, ["true"], { timeoutSec: 30 });
      expect(await proxiesOf(p.name)).toEqual([proxy]);
    } finally {
      await sweepOwn();
    }
    expect(await remaining()).toEqual(NONE);
  }, 600_000);
});

/**
 * The contained install (leg 8). Real installs of two public repositories under MCPE_NETWORK=contained with the scan off:
 * `tomnomnom/gron` (Go) and `piuccio/cowsay` at a fixed commit (npm, a lockfile and a `prepare` script). Everything is the
 * describe's own: a random owner id, the suite's prefix, a registry in a temporary directory named by that id. Every removal
 * is the owner-filtered sweep through the checked helpers. The measurements (the proxy's refusal rows per install, the
 * client probes, the create/contain/start states) go to the log and, when MCPE_EVIDENCE_FILE names a file called `leg8-*`
 * under the temporary directory, to that file.
 */
const COWSAY_REF = "eef317a302d025e3f31787566727c49eaee43648";
describe.skipIf(!enabled)("docker integration: the contained install (leg 8)", () => {
  const id = randomBytes(4).toString("hex");
  const dataDir = path.join(os.tmpdir(), `mcpe-it-c8-${id}`);
  const cfg = loadConfig({
    ...process.env,
    MCPE_NAME_PREFIX: prefix,
    MCPE_SANDBOX_IDLE_TIMEOUT: "0",
    MCPE_NETWORK: "contained",
    MCPE_DATA_DIR: dataDir,
    MCPE_LOCAL_ACCESS: "",
    MCPE_SCAN: "off",
    MCPE_SCANNERS: "",
  });
  const registry = new Registry(dataDir);
  const owned = `label=mcp-everything.owner=${id}`;
  const lines = async (args: string[]) => (await run("docker", args, { timeoutMs: 30_000 })).stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const remaining = async () => ({
    containers: (await lines(["ps", "-a", "--filter", owned, "--format", "{{.Names}}"])).sort(),
    networks: (await lines(["network", "ls", "--filter", owned, "--format", "{{.Name}}"])).sort(),
    volumes: (await lines(["volume", "ls", "--filter", owned, "--format", "{{.Name}}"])).sort(),
  });
  const sweepOwn = async () => {
    const left = await remaining();
    for (const n of left.containers) await removeContainerWithVolumesChecked(n, []);
    for (const n of left.networks) await removeNetworkChecked(n, []);
    for (const n of left.volumes) await removeVolumeChecked(n, []);
    // The describe's own registry: a ready record left behind would make the next install of the same repository answer at once.
    for (const p of registry.list()) registry.delete(p.slug);
  };
  const networksOf = async (name: string) =>
    (await lines(["inspect", "--format", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}", name])).sort();
  const evidence = (what: string, data: unknown) => {
    const line = `leg8 evidence ${what}: ${JSON.stringify(data)}`;
    console.log(line);
    const file = process.env.MCPE_EVIDENCE_FILE;
    if (file && path.isAbsolute(file) && isUnderTmp(file) && path.basename(file).startsWith("leg8-")) fs.appendFileSync(file, `${line}\n`);
  };
  /** A GET with `fetch` in Node: it uses the proxy only through NODE_USE_ENV_PROXY. */
  const FETCH = `fetch("https://registry.npmjs.org/").then((r)=>console.log("STATUS "+r.status)).catch((e)=>console.log("ERR "+((e.cause&&e.cause.code)||e.message)))`;

  /**
   * Real Docker, recording: the network state right after the sandbox is created and right before it is started (T15), the
   * proxy's refusals as the install read them, and (when `probeBuild`) the clients' behavior from one exec before the build.
   */
  class Recording extends Docker {
    stateAfterCreate: string[] = [];
    stateBeforeStart: string[] = [];
    refusalRows: ProxyRefusalRow[][] = [];
    probes: Record<string, string> = {};
    probeBuild = false;
    private probed = false;
    override async createContainer(opts: Parameters<Docker["createContainer"]>[0]): Promise<SandboxRef> {
      const ref = await super.createContainer(opts);
      this.stateAfterCreate.push(await this.networkState(ref.name));
      return ref;
    }
    override async startForContainment(name: string): Promise<SandboxRef | undefined> {
      this.stateBeforeStart.push(await this.networkState(name));
      return super.startForContainment(name);
    }
    override async projectRefusals(sandbox: string): Promise<ProxyRefusalRow[]> {
      const rows = await super.projectRefusals(sandbox);
      this.refusalRows.push(rows);
      return rows;
    }
    override async exec(target: string | SandboxRef, argv: string[], opts: ExecOptions): Promise<ExecResult> {
      if (this.probeBuild && !this.probed && argv[0] === "sh" && argv[2]?.includes("soft_fail()")) {
        this.probed = true;
        const one = async (key: string, cmd: string[]) => {
          const r = await super.exec(target, cmd, { timeoutSec: 90 });
          this.probes[key] = `exit ${r.code}: ${`${r.stdout}${r.stderr}`.trim().replace(/\s+/g, " ").slice(0, 300)}`;
        };
        await one("node -v", ["node", "-v"]);
        await one("npm -v", ["npm", "-v"]);
        await one("fetch with the hook's environment", ["node", "-e", FETCH]);
        await one("fetch with NODE_USE_ENV_PROXY unset", ["sh", "-c", `unset NODE_USE_ENV_PROXY; node -e '${FETCH}'`]);
      }
      return super.exec(target, argv, opts);
    }
  }
  const stack = (over: { defaults?: ConstructorParameters<typeof Containment>[3]["defaults"]; probeBuild?: boolean } = {}) => {
    const docker = new Recording(cfg, id);
    docker.probeBuild = over.probeBuild ?? false;
    const containment = new Containment(cfg, registry, docker, { dataDir, ...(over.defaults ? { defaults: over.defaults } : {}) });
    containment.install();
    const installer = new Installer(cfg, docker, registry, new McpProxy(cfg, docker), undefined, undefined, containment);
    return { docker, containment, installer };
  };
  const noNpm = {
    build: (e: Parameters<typeof buildHosts>[0]) => buildHosts(e).filter((h) => h !== "registry.npmjs.org"),
    run: (e: Parameters<typeof sandboxHosts>[0]) => sandboxHosts(e),
  };
  /** Nothing in the log is a warning from the build or a refusal. */
  const buildWarnings = (log: string[]) => log.filter((l) => l.startsWith("MCPE_WARN"));
  const refusalWarnings = (w: string[]) => w.filter((x) => /refused/.test(x));

  afterAll(async () => {
    await sweepOwn();
    if (isUnderTmp(dataDir) && path.basename(dataDir) === `mcpe-it-c8-${id}`) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("installs tomnomnom/gron (Go): the sandbox is created on bridge, contained before its first start, built through the proxy, taken offline; ready, a gron__gron tool, no refusal or build warnings", async () => {
    assertNameCheckBehaves();
    const { docker, installer } = stack();
    const log: string[] = [];
    try {
      const record = await installer.install({ repo: parseRepoRef("tomnomnom/gron", cfg.hosts) }, (l) => log.push(l));
      evidence("gron refusal rows during the build", docker.refusalRows);
      evidence("gron warnings", record.warnings);
      expect(record.status, `${record.error ?? ""}\n${record.errorLog ?? ""}`).toBe("ready");
      expect(record.tools.map((t) => t.name)).toContain("gron__gron");
      expect(refusalWarnings(record.warnings)).toEqual([]);
      expect(buildWarnings(log)).toEqual([]);
      // T15: on bridge (open) right after create, contained right before its first start.
      expect(docker.stateAfterCreate).toEqual(["open"]);
      expect(docker.stateBeforeStart).toEqual(["contained"]);
      evidence("gron create/contain/start states", { afterCreate: docker.stateAfterCreate, beforeStart: docker.stateBeforeStart });
      // Offline at the end, with the proxy and the network gone.
      expect(record.network).toBe(false);
      expect(await docker.networkState(record.container)).toBe("off");
      expect(await networksOf(record.container)).toEqual([]);
      const left = await remaining();
      expect(left.networks).toEqual([]);
      expect(left.containers).toEqual([record.container]);
      expect(registry.get(record.slug)).toMatchObject({ status: "ready", network: false });
    } finally {
      await sweepOwn();
    }
    expect(await remaining()).toEqual({ containers: [], networks: [], volumes: [] });
  }, 900_000);

  it("installs tomnomnom/gron with the network on: discovery under the build's hosts, then the run allowlist (the sandbox's hosts), and the sandbox stays contained", async () => {
    const { docker, installer } = stack();
    try {
      const record = await installer.install({ repo: parseRepoRef("tomnomnom/gron", cfg.hosts), network: true });
      evidence("gron (network on) refusal rows during the build", docker.refusalRows);
      expect(record.status, `${record.error ?? ""}\n${record.errorLog ?? ""}`).toBe("ready");
      expect(record).toMatchObject({ network: true });
      expect(refusalWarnings(record.warnings)).toEqual([]);
      expect(await docker.networkState(record.container)).toBe("contained");
      expect(await networksOf(record.container)).toEqual([`${record.container}-net`]);
      const proxies = await docker.listProjectProxies(record.container);
      expect(proxies).toHaveLength(1);
      // The run allowlist: Go's rows (proxy.golang.org) and not the build's (github.com). bash's /dev/tcp, since the Go image has no Node;
      // the proxy's address is the one in HTTPS_PROXY, which every exec of the sandbox carries (http://<address>:3128).
      const connect = (host: string) =>
        `P=\${HTTPS_PROXY#http://}; exec 3<>/dev/tcp/\${P%:*}/\${P##*:} && printf 'CONNECT ${host}:443 HTTP/1.1\\r\\nHost: ${host}:443\\r\\n\\r\\n' >&3 && head -n 1 <&3`;
      const status = async (host: string) => (await docker.exec(record.container, ["timeout", "20", "bash", "-c", connect(host)], { timeoutSec: 60 })).stdout.trim();
      expect(await status("proxy.golang.org")).toMatch(/ 200 /);
      expect(await status("github.com")).toMatch(/ 403 /);
    } finally {
      await sweepOwn();
    }
    expect(await remaining()).toEqual({ containers: [], networks: [], volumes: [] });
  }, 900_000);

  it(`installs piuccio/cowsay at ${COWSAY_REF.slice(0, 12)} (npm): ready, a cowsay__cowsay tool, no refusal warnings; the clients' behavior is recorded from one exec before the build`, async () => {
    const { docker, installer } = stack({ probeBuild: true });
    try {
      const record = await installer.install({ repo: parseRepoRef("piuccio/cowsay", cfg.hosts), ref: COWSAY_REF });
      evidence("cowsay refusal rows during the build", docker.refusalRows);
      evidence("cowsay client probes (Node and npm versions, fetch with and without NODE_USE_ENV_PROXY)", docker.probes);
      evidence("cowsay warnings", record.warnings);
      expect(record.status, `${record.error ?? ""}\n${record.errorLog ?? ""}`).toBe("ready");
      expect(record.tools.map((t) => t.name)).toContain("cowsay__cowsay");
      expect(refusalWarnings(record.warnings)).toEqual([]);
      expect(docker.stateAfterCreate).toEqual(["open"]);
      expect(docker.stateBeforeStart).toEqual(["contained"]);
    } finally {
      await sweepOwn();
    }
    expect(await remaining()).toEqual({ containers: [], networks: [], volumes: [] });
  }, 1_200_000);

  it("a build host that the table lacks fails the install and names it: cowsay with registry.npmjs.org removed from the table (a test-only seam)", async () => {
    const { docker, installer } = stack({ defaults: noNpm });
    const started = Date.now();
    try {
      const record = await installer.install({ repo: parseRepoRef("piuccio/cowsay", cfg.hosts), ref: COWSAY_REF, timeoutSec: 90 });
      const seconds = Math.round((Date.now() - started) / 1000);
      evidence("cowsay without registry.npmjs.org: refusal rows, seconds, error", { rows: docker.refusalRows, seconds, error: record.error });
      expect(record.status).toBe("failed");
      const rows = docker.refusalRows.flat();
      expect(rows.some((r) => r.host === "registry.npmjs.org" && r.reason === "not-allowed")).toBe(true);
      // refusalLines' output reaches the record's error, and the sentence names the host with the advisory caution (leg 9:
      // no ready-made allow instruction carries the host).
      for (const line of refusalLines(rows, "build")) expect(record.error).toContain(line);
      expect(record.error).toContain("`registry.npmjs.org:443` was refused");
      expect(record.error).toContain("only if you expect this project to need it");
      expect(record.error).not.toContain('hosts: ["registry.npmjs.org"]');
      expect(registry.get(record.slug)).toMatchObject({ status: "failed" });
      // Offline after the failure: the proxy and the network are gone.
      expect(await docker.networkState(record.container)).toBe("off");
    } finally {
      await sweepOwn();
    }
    expect(await remaining()).toEqual({ containers: [], networks: [], volumes: [] });
    // The case's own refusal wait is 90 s (leg 12); the rest is room for a cold image pull on a fresh runner.
  }, 300_000);

  it("check_project's path (Installer.check) clones through the proxy and removes its staging volume, building nothing", async () => {
    const { installer } = stack();
    try {
      const out = await installer.check({ repo: parseRepoRef("tomnomnom/gron", cfg.hosts) });
      expect(out.kind).toBe("checked");
      expect(await remaining()).toEqual({ containers: [], networks: [], volumes: [] });
    } finally {
      await sweepOwn();
    }
  }, 300_000);

  it("the sequence by hand: created on bridge and stopped, contained (still stopped, on its network only), then started contained", async () => {
    const { docker, containment } = stack();
    try {
      const slug = `c8${randomBytes(4).toString("hex")}`;
      const name = docker.sandboxName(slug);
      expect(mayRemove(name, [])).toBe(true);
      const project = `github:o/${slug}`;
      await docker.createSandboxVolume(name);
      await docker.createContainer({ name, volume: name, image: cfg.docker.proxyImage, project, start: false });
      const base = record(slug);
      registry.put({ ...base, container: name, volume: name, ecosystems: ["generic"], status: "installing", repo: { ...base.repo, id: project, path: `o/${slug}` } } as ProjectRecord);
      expect(await docker.state(name)).toBe("stopped");
      expect(await docker.networkState(name)).toBe("open");
      expect(await networksOf(name)).toEqual(["bridge"]);
      const contained = await containment.contain(project);
      expect(contained.ok, contained.ok ? "" : String(contained.error)).toBe(true);
      expect(await docker.state(name)).toBe("stopped");
      expect(await docker.networkState(name)).toBe("contained");
      expect(await networksOf(name)).toEqual([`${name}-net`]);
      const ref = await docker.startForContainment(name);
      expect(ref).toBeDefined();
      expect(await docker.state(name)).toBe("running");
      expect(await networksOf(name)).toEqual([`${name}-net`]);
      expect(await docker.networkState(name)).toBe("contained");
      // And `createContainer` refuses to start one under containment.
      await expect(docker.createContainer({ name: `${name}-x`, volume: name, image: cfg.docker.proxyImage, project })).rejects.toThrow(/not started on bridge/);
    } finally {
      await sweepOwn();
    }
    expect(await remaining()).toEqual({ containers: [], networks: [], volumes: [] });
  }, 300_000);
});

/**
 * The network tools and the operator's local access, end to end (leg 9). Everything is the describe's own: a random owner id,
 * the suite's prefix, a registry and data directory `<tmp>/mcpe-it-c9-<id>` removed only after a location and basename check,
 * and every removal through the owner-filtered sweep and the checked helpers. The local service is a container of this
 * describe (a TCP echo server on the proxy image, publishing a random port), labelled with the describe's owner so the sweep
 * finds it. The first case is a measurement, not a regression: what `host-gateway` is inside a container and whether a
 * published port answers there; if it does not (Docker Desktop), the local-access case is skipped with the measured reason, and
 * leg 12's native Linux job carries that proof.
 */
describe.skipIf(!enabled)("docker integration: network tools and local access (leg 9)", () => {
  const id = randomBytes(4).toString("hex");
  const dataDir = path.join(os.tmpdir(), `mcpe-it-c9-${id}`);
  const base = { ...process.env, MCPE_NAME_PREFIX: prefix, MCPE_SANDBOX_IDLE_TIMEOUT: "0", MCPE_NETWORK: "contained", MCPE_DATA_DIR: dataDir };
  const cfg = loadConfig({ ...base, MCPE_LOCAL_ACCESS: "" });
  const owned = `label=mcp-everything.owner=${id}`;
  const hex = () => randomBytes(4).toString("hex");
  const lines = async (args: string[]) => (await run("docker", args, { timeoutMs: 30_000 })).stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const remaining = async () => ({
    containers: (await lines(["ps", "-a", "--filter", owned, "--format", "{{.Names}}"])).sort(),
    networks: (await lines(["network", "ls", "--filter", owned, "--format", "{{.Name}}"])).sort(),
    volumes: (await lines(["volume", "ls", "--filter", owned, "--format", "{{.Name}}"])).sort(),
  });
  const NONE = { containers: [], networks: [], volumes: [] };
  const sweepOwn = async () => {
    const left = await remaining();
    for (const n of left.containers) await removeContainerWithVolumesChecked(n, []);
    for (const n of left.networks) await removeNetworkChecked(n, []);
    for (const n of left.volumes) await removeVolumeChecked(n, []);
    // The describe's own registry records go with what they named.
    try {
      const r = new Registry(dataDir);
      r.refresh();
      for (const p of r.list()) r.delete(p.slug);
    } catch {
      // no registry yet
    }
  };
  const results = (stdout: string) =>
    Object.fromEntries(stdout.split("\n").filter(Boolean).map((l) => [l.slice(0, l.lastIndexOf("=")), l.slice(l.lastIndexOf("=") + 1)])) as Record<string, string>;
  /** A raw `CONNECT host:port` to the proxy, at the address in HTTPS_PROXY, for each target; prints `host:port=<status>`. */
  const connectScript = (targets: Array<[string, number]>) =>
    `${PROXY_HOST_JS}const net=require("net");const T=${JSON.stringify(targets)};let i=0;(function next(){if(i>=T.length)process.exit(0);const [h,p]=T[i++];` +
    `const s=net.connect({host:P.hostname,port:Number(P.port)});s.setTimeout(8000);let buf="";let done=false;const fin=(r)=>{if(done)return;done=true;console.log(h+":"+p+"="+r);s.destroy();next()};` +
    `s.on("connect",()=>s.write("CONNECT "+h+":"+p+" HTTP/1.1\\r\\nHost: "+h+":"+p+"\\r\\n\\r\\n"));` +
    `s.on("data",(d)=>{buf+=d;const m=/^HTTP\\/1\\.[01] (\\d{3})/.exec(buf);if(m)fin(m[1])});s.on("timeout",()=>fin("TIMEOUT"));s.on("error",(e)=>fin("ERR "+e.code));s.on("close",()=>fin("CLOSED"))})()`;
  /** A raw connect that writes `ping` and reads it back from an echo server; prints `host:port=ECHO <text>|TIMEOUT|ERR <code>`. Ignores the proxy variables. */
  const echoScript = (host: string, port: number) =>
    `const net=require("net");const h=${JSON.stringify(host)},p=${port};const s=net.connect({host:h,port:p});s.setTimeout(8000);let got="";` +
    `const fin=(r)=>{console.log(h+":"+p+"="+r);process.exit(0)};s.on("connect",()=>s.write("ping\\n"));` +
    `s.on("data",(d)=>{got+=d;if(got.includes("ping"))fin("ECHO "+got.trim())});s.on("timeout",()=>fin("TIMEOUT"));s.on("error",(e)=>fin("ERR "+e.code))`;
  const ECHO_SERVER = "require('net').createServer((s)=>s.pipe(s)).listen(9000,'0.0.0.0')";

  /** The local service: an echo server in a container of this describe's own, its port published on a random host port. */
  const startEcho = async (image: string): Promise<{ name: string; port: number }> => {
    const name = `${prefix}c9-echo-${hex()}`;
    expect(mayRemove(name, [])).toBe(true);
    const started = await run(
      "docker",
      ["run", "-d", "--name", checkedForRemoval(name, []), "--label", `mcp-everything.owner=${id}`, "-p", "0:9000", "--entrypoint", "node", image, "-e", ECHO_SERVER],
      { timeoutMs: 120_000 },
    );
    expect(started.code, started.stderr).toBe(0);
    const published = (await run("docker", ["port", name, "9000/tcp"], { timeoutMs: 30_000 })).stdout;
    const port = Number(/:(\d+)\s*$/m.exec(published)?.[1]);
    expect(port, published).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 1500));
    return { name, port };
  };

  /** A sandbox on the proxy image with a record in `reg`, created stopped and started by the test (on `bridge`, to be contained). */
  const makeProject = async (d: Docker, reg: Registry, c: ReturnType<typeof loadConfig>, over: Record<string, unknown> = {}) => {
    const slug = `c9${hex()}`;
    const name = d.sandboxName(slug);
    expect(mayRemove(name, [])).toBe(true);
    const repo = parseRepoRef(`github:o/${slug}`, c.hosts);
    await d.createSandboxVolume(name);
    await d.createContainer({ name, volume: name, image: c.docker.proxyImage, project: repo.id, start: false });
    await d.startForContainment(name);
    const rec = record(slug);
    reg.put({ ...rec, container: name, volume: name, ecosystems: ["generic"], repo, ...over } as ProjectRecord);
    return { slug, name, project: repo.id };
  };
  const inside = async (d: Docker, name: string, script: string) => {
    const res = await d.exec(name, ["node", "-e", script], { timeoutSec: 90 });
    expect(res.code, res.stderr).toBe(0);
    return results(res.stdout);
  };
  const proxiesOf = async (d: Docker, name: string) => (await d.listProjectProxies(name)).map((p) => p.id);
  /** The CONNECT status for `host:443` through the sandbox's proxy, asked again (6 tries, 1 s apart) until it is `want`: the first connect after a proxy swap can be slow (ARP). */
  const statusEventually = async (d: Docker, name: string, host: string, want: string): Promise<string> => {
    let got = "";
    for (let i = 0; i < 6; i++) {
      got = (await inside(d, name, connectScript([[host, 443]])))[`${host}:443`] ?? "";
      if (got === want) return got;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return got;
  };
  /** The sandbox's /etc/hosts lines that mcp-everything wrote (everything ending in the mark), as text. */
  const markedHosts = async (d: Docker, name: string) =>
    (await d.exec(name, ["sh", "-c", "grep '# mcpe-local-access$' /etc/hosts || true"], { timeoutSec: 30 })).stdout.trim();

  /** What the measurement found; undefined until it has run. */
  let reach: { resolved: string; connected: boolean; reason: string } | undefined;

  afterAll(async () => {
    await sweepOwn();
    if (isUnderTmp(dataDir) && path.basename(dataDir) === `mcpe-it-c9-${id}`) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("measurement: what host-gateway is inside a container, and whether a published port answers there", async () => {
    assertNameCheckBehaves();
    try {
      const echo = await startEcho(cfg.docker.proxyImage);
      const name = `${prefix}c9-probe-${hex()}`;
      expect(mayRemove(name, [])).toBe(true);
      const script =
        `const dns=require("dns"),net=require("net");dns.lookup("host.docker.internal",{all:true},(e,a)=>{console.log("RESOLVED "+(e?"ERR "+e.code:a.map((x)=>x.address).join(",")));` +
        `if(e)process.exit(0);const s=net.connect({host:a[0].address,port:${echo.port}});s.setTimeout(6000);s.on("connect",()=>s.write("ping\\n"));` +
        `s.on("data",(d)=>{console.log("CONNECT ECHO "+String(d).trim());process.exit(0)});s.on("timeout",()=>{console.log("CONNECT TIMEOUT");process.exit(0)});` +
        `s.on("error",(x)=>{console.log("CONNECT ERR "+x.code);process.exit(0)})})`;
      const r = await run(
        "docker",
        ["run", "--name", checkedForRemoval(name, []), "--label", `mcp-everything.owner=${id}`, "--add-host", "host.docker.internal:host-gateway", "--entrypoint", "node", cfg.docker.proxyImage, "-e", script],
        { timeoutMs: 120_000 },
      );
      const out = r.stdout.trim();
      const resolved = /^RESOLVED (.*)$/m.exec(out)?.[1] ?? "none";
      const connected = /^CONNECT ECHO ping$/m.test(out);
      reach = { resolved, connected, reason: `host-gateway resolved to ${resolved}; connect: ${/^CONNECT (.*)$/m.exec(out)?.[1] ?? "not attempted"}` };
      console.log(`leg 9 measurement: ${reach.reason} (published port ${echo.port}; exit ${r.code}; stderr ${r.stderr.trim().slice(0, 200)})`);
      expect(r.code, r.stderr).toBe(0);
    } finally {
      await sweepOwn();
    }
    expect(await remaining()).toEqual(NONE);
  }, 300_000);

  it("local access end to end: MCPE_LOCAL_ACCESS reaches the echo service from the entitled repository's sandbox, not from another's, and a CONNECT through the proxy to it is refused", async (ctx) => {
    if (reach && !reach.connected) ctx.skip(`Desktop-skipped: a published port is not reachable from a host-gateway name here (${reach.reason}); leg 12's native Linux job carries this proof`);
    try {
      const echo = await startEcho(cfg.docker.proxyImage);
      const slugA = `c9${hex()}`;
      const repoA = parseRepoRef(`github:o/${slugA}`, cfg.hosts).id;
      const localCfg = loadConfig({ ...base, MCPE_LOCAL_ACCESS: `${repoA}=host.docker.internal:${echo.port}` });
      const docker = new Docker(localCfg, id);
      const registry = new Registry(dataDir);
      const containment = new Containment(localCfg, registry, docker, { dataDir });
      containment.install();
      // A: the entitled repository (its record's repo id is the one MCPE_LOCAL_ACCESS names); B: another.
      const a = await (async () => {
        const name = docker.sandboxName(slugA);
        expect(mayRemove(name, [])).toBe(true);
        const repo = parseRepoRef(`github:o/${slugA}`, localCfg.hosts);
        await docker.createSandboxVolume(name);
        await docker.createContainer({ name, volume: name, image: localCfg.docker.proxyImage, project: repo.id, start: false });
        await docker.startForContainment(name);
        registry.put({ ...record(slugA), container: name, volume: name, ecosystems: ["generic"], repo } as ProjectRecord);
        return { slug: slugA, name, project: repo.id };
      })();
      const b = await makeProject(docker, registry, localCfg);
      for (const p of [a, b]) {
        const r = await containment.contain(p.project);
        expect(r.ok, r.ok ? "" : String(r.error)).toBe(true);
        expect(await docker.networkState(p.name)).toBe("contained");
      }
      const entitled = await inside(docker, a.name, echoScript("host.docker.internal", echo.port));
      expect(entitled[`host.docker.internal:${echo.port}`]).toBe("ECHO ping");
      const other = await inside(docker, b.name, echoScript("host.docker.internal", echo.port));
      expect(other[`host.docker.internal:${echo.port}`]).toMatch(/^(ERR |TIMEOUT)/);
      const viaProxy = await inside(docker, a.name, connectScript([["host.docker.internal", echo.port]]));
      expect(viaProxy[`host.docker.internal:${echo.port}`]).toBe("403");
    } finally {
      await sweepOwn();
    }
    expect(await remaining()).toEqual(NONE);
  }, 600_000);

  it("leg 13: the local-access names are in the sandbox's /etc/hosts at the proxy address, survive a stop and a start, and go when the forwards become empty", async () => {
    try {
      const slug = `c9${hex()}`;
      const project = parseRepoRef(`github:o/${slug}`, cfg.hosts).id;
      const localCfg = loadConfig({ ...base, MCPE_LOCAL_ACCESS: `${project}=db.lan:5432,host.docker.internal:9000` });
      const docker = new Docker(localCfg, id);
      const registry = new Registry(dataDir);
      const containment = new Containment(localCfg, registry, docker, { dataDir });
      containment.install();
      const name = docker.sandboxName(slug);
      expect(mayRemove(name, [])).toBe(true);
      await docker.createSandboxVolume(name);
      await docker.createContainer({ name, volume: name, image: localCfg.docker.proxyImage, project, start: false });
      await docker.startForContainment(name);
      registry.put({ ...record(slug), container: name, volume: name, ecosystems: ["generic"], repo: parseRepoRef(`github:o/${slug}`, localCfg.hosts) } as ProjectRecord);
      const made = await containment.contain(project);
      expect(made.ok, made.ok ? "" : String(made.error)).toBe(true);

      const address = (await proxyUrlOf(`${name}-net`)).replace(/^http:\/\//, "").replace(/:3128$/, "");
      const wanted = [`${address} db.lan   # mcpe-local-access`, `${address} host.docker.internal   # mcpe-local-access`].sort();
      const marked = async () => (await markedHosts(docker, name)).split("\n").filter(Boolean).sort();
      expect(await marked()).toEqual(wanted);
      // The names resolve to the proxy through /etc/hosts alone (no DNS server is asked for them).
      const resolve = await docker.exec(name, ["node", "-e", `require("dns").lookup("db.lan",(e,a)=>console.log(e?"ERR "+e.code:a))`], { timeoutSec: 60 });
      expect(resolve.stdout.trim()).toBe(address);
      // The sandbox's own entries are still there.
      expect((await docker.exec(name, ["sh", "-c", "grep -c localhost /etc/hosts"], { timeoutSec: 30 })).stdout.trim()).not.toBe("0");

      // Docker rewrites /etc/hosts on a start: the lines are written again after it (by acquire's post-start step), once each.
      await run("docker", ["stop", checkedForRemoval(name, [])], { timeoutMs: 60_000 });
      expect(await docker.state(name)).toBe("stopped");
      expect(await docker.acquire(name)).toBeDefined();
      expect(await docker.state(name)).toBe("running");
      expect(await marked()).toEqual(wanted);
      // A sandbox that was already running is checked, and not written twice.
      expect(await docker.acquire(name)).toBeDefined();
      expect(await marked()).toEqual(wanted);

      // The forwards become empty (another session's configuration, with the session label compared): the lines are taken out.
      const plain = loadConfig({ ...base, MCPE_LOCAL_ACCESS: "" });
      const result = await new Containment(plain, registry, docker, { dataDir }).replace(project, { compareSession: true });
      expect(result.kind).toBe("replaced");
      expect(await marked()).toEqual([]);
      expect((await docker.exec(name, ["sh", "-c", "grep -c localhost /etc/hosts"], { timeoutSec: 30 })).stdout.trim()).not.toBe("0");
    } finally {
      await sweepOwn();
    }
    expect(await remaining()).toEqual(NONE);
  }, 600_000);

  it("set_project_network(true) under containment on an offline sandbox contains it, and its proxy allows the run hosts", async () => {
    const docker = new Docker(cfg, id);
    const app = new App({ cfg, docker });
    try {
      const p = await makeProject(docker, app.registry, cfg, { ecosystems: ["node"], network: false });
      await docker.setNetwork(p.name, "off");
      expect(await docker.networkState(p.name)).toBe("off");
      const res = await app.callTool("set_project_network", { project: p.slug, enabled: true });
      expect(res.isError, text(res)).toBeFalsy();
      expect(text(res)).toContain("is now contained");
      expect(await docker.networkState(p.name)).toBe("contained");
      expect(await docker.state(p.name)).toBe("running");
      expect(await proxiesOf(docker, p.name)).toHaveLength(1);
      const got = await inside(docker, p.name, connectScript([["registry.npmjs.org", 443], ["github.com", 443]]));
      expect(got["registry.npmjs.org:443"]).toBe("200");
      expect(got["github.com:443"]).toBe("403");
      app.registry.refresh();
      expect(app.registry.get(p.slug)!.network).toBe(true);
    } finally {
      await app.shutdown();
      await sweepOwn();
    }
    expect(await remaining()).toEqual(NONE);
  }, 600_000);

  it("set_project_hosts without a reinstall: github.com is refused under containment, allowed after add, refused again after remove, with exactly one proxy each time", async () => {
    const docker = new Docker(cfg, id);
    const app = new App({ cfg, docker });
    try {
      const p = await makeProject(docker, app.registry, cfg, { ecosystems: ["node"], network: false });
      expect((await app.callTool("set_project_network", { project: p.slug, enabled: true })).isError).toBeFalsy();
      const before = await proxiesOf(docker, p.name);
      expect(before).toHaveLength(1);
      expect((await inside(docker, p.name, connectScript([["github.com", 443]])))["github.com:443"]).toBe("403");

      const added = await app.callTool("set_project_hosts", { project: p.slug, add: ["github.com"] });
      expect(added.isError, text(added)).toBeFalsy();
      expect(text(added)).toContain("Hosts for");
      const afterAdd = await proxiesOf(docker, p.name);
      expect(afterAdd).toHaveLength(1);
      expect(afterAdd[0]).not.toBe(before[0]);
      expect(await statusEventually(docker, p.name, "github.com", "200")).toBe("200");

      const removed = await app.callTool("set_project_hosts", { project: p.slug, remove: ["github.com"] });
      expect(removed.isError, text(removed)).toBeFalsy();
      expect(await proxiesOf(docker, p.name)).toHaveLength(1);
      // A tightening is effective at once (no overlap: the old proxy left the network first).
      expect(await statusEventually(docker, p.name, "github.com", "403")).toBe("403");
    } finally {
      await app.shutdown();
      await sweepOwn();
    }
    expect(await remaining()).toEqual(NONE);
  }, 600_000);
});

/**
 * Startup containment (leg 10). Everything is the describe's own: a random owner id (the `App` under test is given a Docker
 * with that id), the suite's prefix, a registry in a temporary directory named by that id. The sandboxes are made through the
 * Docker layer with the suite's prefix and removed only by the owner-filtered sweep through the checked helpers (names are
 * checked against the prefix before any removal). Nothing here touches an object or a file the describe did not create.
 */
describe.skipIf(!enabled)("docker integration: startup containment (leg 10)", () => {
  const id = randomBytes(4).toString("hex");
  const dataDir = path.join(os.tmpdir(), `mcpe-it-c10-${id}`);
  const cfg = loadConfig({ ...process.env, MCPE_NAME_PREFIX: prefix, MCPE_SANDBOX_IDLE_TIMEOUT: "0", MCPE_NETWORK: "contained", MCPE_DATA_DIR: dataDir, MCPE_LOCAL_ACCESS: "" });
  const owned = `label=mcp-everything.owner=${id}`;
  const hex = () => randomBytes(4).toString("hex");
  const lines = async (args: string[]) => (await run("docker", args, { timeoutMs: 30_000 })).stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const remaining = async () => ({
    containers: (await lines(["ps", "-a", "--filter", owned, "--format", "{{.Names}}"])).sort(),
    networks: (await lines(["network", "ls", "--filter", owned, "--format", "{{.Name}}"])).sort(),
    volumes: (await lines(["volume", "ls", "--filter", owned, "--format", "{{.Name}}"])).sort(),
  });
  const NONE = { containers: [], networks: [], volumes: [] };
  const sweepOwn = async () => {
    const left = await remaining();
    for (const n of left.containers) await removeContainerWithVolumesChecked(n, []);
    for (const n of left.networks) await removeNetworkChecked(n, []);
    for (const n of left.volumes) await removeVolumeChecked(n, []);
    // The describe's own registry records go with what they named.
    try {
      const r = new Registry(dataDir);
      r.refresh();
      for (const p of r.list()) r.delete(p.slug);
    } catch {
      // no registry yet
    }
  };
  const networksOf = async (name: string) => (await lines(["inspect", "--format", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}", checkedForRemoval(name, [])])).sort();
  const proxiesOf = async (d: Docker, name: string) => (await d.listProjectProxies(name)).map((p) => p.id);

  /** A running sandbox on `bridge`, on the proxy image, with a record in `reg` that says the network is `network` (the project label is the record's id). */
  const makeProject = async (d: Docker, reg: Registry, network: boolean) => {
    const slug = `c10${hex()}`;
    const name = d.sandboxName(slug);
    expect(mayRemove(name, [])).toBe(true);
    const repo = parseRepoRef(`github:o/${slug}`, cfg.hosts);
    await d.createSandboxVolume(name);
    await d.createContainer({ name, volume: name, image: cfg.docker.proxyImage, project: repo.id, start: false });
    await d.startForContainment(name);
    reg.put({ ...record(slug), container: name, volume: name, ecosystems: ["generic"], repo, network } as ProjectRecord);
    return { slug, name, project: repo.id };
  };

  afterAll(async () => {
    await sweepOwn();
    if (isUnderTmp(dataDir) && path.basename(dataDir) === `mcpe-it-c10-${id}`) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("an open sandbox whose record says on is contained at startup: on its -net only, with one proxy", async () => {
    assertNameCheckBehaves();
    const docker = new Docker(cfg, id);
    const app = new App({ cfg, docker });
    try {
      const p = await makeProject(docker, app.registry, true);
      expect(await networksOf(p.name)).toEqual(["bridge"]);
      app.start();
      await app.startup;
      expect(await networksOf(p.name)).toEqual([`${p.name}-net`]);
      expect(await docker.networkState(p.name)).toBe("contained");
      expect(await proxiesOf(docker, p.name)).toHaveLength(1);
    } finally {
      await app.shutdown();
      await sweepOwn();
    }
    expect(await remaining()).toEqual(NONE);
  }, 600_000);

  it("an exec issued right after start(), before startup resolves, completes only after containment and carries the proxy environment", async () => {
    const docker = new Docker(cfg, id);
    const app = new App({ cfg, docker });
    try {
      const p = await makeProject(docker, app.registry, true);
      app.start();
      // At once: the key is not yet registered (the listing has not returned), so this meets the gate.
      const res = await docker.exec(p.name, ["sh", "-c", "echo $HTTPS_PROXY"], { timeoutSec: 90 });
      expect(res.code, res.stderr).toBe(0);
      expect(res.stdout.trim()).toBe(await proxyUrlOf(`${p.name}-net`));
      expect(await networksOf(p.name)).toEqual([`${p.name}-net`]);
      await app.startup;
      expect(await proxiesOf(docker, p.name)).toHaveLength(1);
    } finally {
      await app.shutdown();
      await sweepOwn();
    }
    expect(await remaining()).toEqual(NONE);
  }, 600_000);

  it("a sandbox on bridge whose record says off is taken off at startup (fail-safe), the record stays off, and it carries a warning", async () => {
    const docker = new Docker(cfg, id);
    const app = new App({ cfg, docker });
    try {
      const p = await makeProject(docker, app.registry, false);
      expect(await networksOf(p.name)).toEqual(["bridge"]);
      app.start();
      await app.startup;
      expect(await networksOf(p.name)).toEqual([]);
      expect(await proxiesOf(docker, p.name)).toEqual([]);
      app.registry.refresh();
      const rec = app.registry.get(p.slug)!;
      expect(rec.network).toBe(false);
      expect(rec.warnings.some((w) => w.startsWith("Startup containment (taken off the network): "))).toBe(true);
    } finally {
      await app.shutdown();
      await sweepOwn();
    }
    expect(await remaining()).toEqual(NONE);
  }, 600_000);
});
