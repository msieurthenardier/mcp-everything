import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { parseRepoRef } from "../src/forge/repo-ref.js";
import { Installer, staleInstallLimitSec } from "../src/install/installer.js";
import { McpProxy } from "../src/proxy/mcp-proxy.js";
import type { Connector, Launch } from "../src/proxy/mcp-proxy.js";
import { Registry } from "../src/registry.js";
import { App } from "../src/server.js";
import type { ExecOptions, ExecResult, ProbeData } from "../src/sandbox/docker.js";
import { FakeDocker, fakeUpstream, record as seedRecord, SECRET_VALUE, type FakeUpstream } from "./helpers.js";
import type { ProjectRecord } from "../src/types.js";

const TOOL_HELP = `Tool does things.

Usage: tool <command>

Commands:
  run    Run it

Options:
  --fast   Go fast
`;
const MULTI_HELP = "Usage: multi [--other]\n\nOptions:\n  --other   A different program in the same file\n";

/**
 * A sandbox scripted well enough for a whole install: a Node project whose
 * build leaves three commands, two of which are the same program.
 */
class ScriptedDocker extends FakeDocker {
  probeData: ProbeData = { commit: "c".repeat(40), entries: [{ name: "LICENSE", dir: false }], files: {} };

  /** Describe the repository root: its manifest files, by name. */
  set repoFiles(files: Record<string, string>) {
    this.probeData = {
      commit: "c".repeat(40),
      entries: [{ name: "LICENSE", dir: false }, ...Object.keys(files).map((name) => ({ name, dir: false }))],
      files,
    };
  }
  images: string[] = [];
  missingImages = new Set<string>();
  /** What the install recipe does on a given image. */
  recipe: (image: string) => Partial<ExecResult> = () => ({ stdout: "built\n" });
  files: Record<string, string> = {};
  sdkBins: string[] = [];

  private get image(): string {
    return this.images[this.images.length - 1] ?? "";
  }

  /** Make the clone step throw. */
  probeError?: Error;
  /** Throw from setNetwork on the given 1-based calls ("all" for every call). */
  setNetworkFails: number[] | "all" = [];
  removeContainerFails: number[] = [];
  destroyFails: number[] | "all" = [];
  private counts = { setNetwork: 0, removeContainer: 0, destroy: 0 };

  private fail(which: keyof ScriptedDocker["counts"], when: number[] | "all"): void {
    const n = ++this.counts[which];
    if (when === "all" || when.includes(n)) throw new Error(`${which} failed (call ${n})`);
  }
  /** For the startup reconciliation: count, fail or hook the reachability check and the detach. */
  availableCalls = 0;
  unavailable = false;
  onAvailable?: () => void;
  onSetNetwork?: () => void;
  override async setNetwork(container: string, enabled: boolean): Promise<void> {
    this.onSetNetwork?.();
    this.fail("setNetwork", this.setNetworkFails);
    return super.setNetwork(container, enabled);
  }
  override async removeContainer(container: string): Promise<void> {
    this.fail("removeContainer", this.removeContainerFails);
    return super.removeContainer(container);
  }
  override async destroy(container: string): Promise<void> {
    this.fail("destroy", this.destroyFails);
    return super.destroy(container);
  }

  override async assertAvailable(): Promise<void> {
    this.availableCalls++;
    this.onAvailable?.();
    if (this.unavailable) throw new Error("Docker CLI could not be run");
  }
  override async probe(): Promise<ProbeData> {
    if (this.probeError) throw this.probeError;
    return this.probeData;
  }
  override async ensureImage(image: string): Promise<void> {
    if (this.missingImages.has(image)) throw new Error(`Failed to pull image ${image}: not found`);
  }
  override async createContainer(opts: { image: string }): Promise<void> {
    this.images.push(opts.image);
  }

  private answer(argv: string[]): Partial<ExecResult> {
    const [cmd, a1, a2] = argv;
    if (cmd === "sh" && a2?.includes("soft_fail()")) return this.recipe(this.image);
    if (cmd === "sh" && a2?.includes("git clean")) return {};
    if (cmd === "sh" && a2?.includes("command -v node")) return {};
    if (cmd === "sh" && a2?.includes("readlink")) {
      return { stdout: "tool\t/workspace/repo/cli.js\ntool-alias\t/workspace/repo/cli.js\nmulti\t/workspace/repo/cli.js\n" };
    }
    if (cmd === "node" && a1 === "-e") {
      const info = { bins: [], packages: ["tool-pkg"], missing: [], mcp: this.sdkBins, owners: { tool: "tool-pkg" } };
      return { stdout: `${JSON.stringify(info)}\n` };
    }
    if (cmd === "ls") return { stdout: "tool\ntool-alias\nmulti\n" };
    if (cmd === "head") {
      const name = argv[argv.length - 1]!.split("/").pop()!;
      return name in this.files ? { stdout: this.files[name]! } : { code: 1 };
    }
    if (cmd === "mkdir") return {};
    if (argv.length === 2 && a1 === "--help") {
      if (cmd === "tool" || cmd === "tool-alias") return { stdout: TOOL_HELP };
      if (cmd === "multi") return { stdout: MULTI_HELP };
    }
    return { code: 1 };
  }

  override async exec(container: string, argv: string[], opts: ExecOptions): Promise<ExecResult> {
    this.calls.push({ container, argv, opts });
    const res = { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false, ...this.answer(argv) };
    if (res.stdout) opts.onOutput?.(res.stdout);
    return res;
  }
}

const SOFT_FAIL = { stdout: "MCPE_SOFT_FAIL\nMCPE_WARN build script failed; binaries that need a build step may be missing\n" };
const pkg = (body: object) => JSON.stringify({ name: "tool-pkg", bin: { tool: "cli.js" }, ...body });

let dir: string;
let cfg: Config;
let docker: ScriptedDocker;
let up: FakeUpstream;
let registry: Registry;
let installer: Installer;

function setup(env: Record<string, string> = {}): void {
  cfg = loadConfig({ HOME: dir, MCPE_DATA_DIR: dir, ...env });
  docker = new ScriptedDocker(cfg);
  up = fakeUpstream();
  up.answer = false;
  registry = new Registry(dir);
  installer = new Installer(cfg, docker, registry, new McpProxy(cfg, docker, up.connector));
}
const install = (extra: object = {}) => installer.install({ repo: parseRepoRef("acme/widget", cfg.hosts), ...extra });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-inst-"));
  setup();
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("runtime selection during install", () => {
  it("builds on the pinned version and explains the choice", async () => {
    docker.repoFiles = { ".nvmrc": "24.22.1", "package.json": pkg({ engines: { node: ">=22" } }) };
    const record = await install();
    expect(docker.images).toEqual(["node:24"]);
    expect(record).toMatchObject({ status: "ready", image: "node:24", imageReason: "Node 24, pinned by .nvmrc (24.22.1)" });
  });

  it("keeps the first 20 build warnings and says how many more were dropped", async () => {
    docker.repoFiles = { "package.json": pkg({}) };
    docker.recipe = () => ({ stdout: Array.from({ length: 100 }, (_, n) => `MCPE_WARN warning ${n + 1}\n`).join("") });
    const record = await install();
    const build = record.warnings.filter((w) => /^warning \d+$|more build warnings/.test(w));
    expect(build).toHaveLength(21);
    expect(build[0]).toBe("warning 1");
    expect(build[19]).toBe("warning 20");
    expect(build[20]).toBe("80 more build warnings were dropped.");
  });

  it("rebuilds once on the next allowed version when the build fails softly", async () => {
    docker.repoFiles = { "package.json": pkg({ engines: { node: "^22.23.4 || ^24.22.1 || >=26.12.1" } }) };
    docker.recipe = (image) => (image === "node:26" ? SOFT_FAIL : { stdout: "built\n" });
    const record = await install();
    expect(docker.images).toEqual(["node:26", "node:24"]);
    expect(record.status).toBe("ready");
    expect(record.image).toBe("node:24");
    expect(record.imageReason).toBe("node:24 after the build failed on node:26; the project's declared range allows both");
    expect(record.warnings).toContain(
      "The build did not succeed on node:26 (build script failed; binaries that need a build step may be missing); it was rebuilt on node:24.",
    );
    // The stale warning from the failed attempt is not carried over.
    expect(record.warnings).not.toContain("build script failed; binaries that need a build step may be missing");
    // The container was replaced and the checkout cleaned; the volume was kept.
    expect(docker.destroyed.filter((d) => d.startsWith("container:"))).toEqual(["container:mcpe-widget"]);
    const order = docker.calls.map((c) => c.argv[2] ?? "").filter((s) => s.includes("git clean") || s.includes("soft_fail()"));
    expect(order.map((s) => (s.includes("git clean") ? "clean" : "recipe"))).toEqual(["recipe", "clean", "recipe"]);
  });

  it("also retries when the recipe fails outright, but only once", async () => {
    docker.repoFiles = { "package.json": pkg({ engines: { node: ">=20" } }) };
    docker.recipe = () => ({ code: 1, stderr: "npm ERR! boom\n" });
    const record = await install();
    expect(docker.images).toEqual(["node:26", "node:24"]);
    expect(record.status).toBe("failed");
    expect(record.error).toBe("Install recipe for node exited with code 1.");
    expect(registry.get("widget")?.status).toBe("failed");
  });

  it("does not retry a pinned project, a timeout, or a caller-chosen image", async () => {
    docker.repoFiles = { ".nvmrc": "24", "package.json": pkg({ engines: { node: ">=20" } }) };
    docker.recipe = () => SOFT_FAIL;
    const pinned = await install();
    expect(docker.images).toEqual(["node:24"]);
    expect(pinned.warnings).toContain("build script failed; binaries that need a build step may be missing");

    setup();
    docker.repoFiles = { "package.json": pkg({ engines: { node: ">=20" } }) };
    docker.recipe = () => ({ code: 124, timedOut: true });
    const slow = await install({ reinstall: true });
    expect(docker.images).toEqual(["node:26"]);
    expect(slow.error).toMatch(/^Install timed out after 900s/);

    setup();
    docker.repoFiles = { "package.json": pkg({ engines: { node: ">=20" } }) };
    docker.recipe = () => SOFT_FAIL;
    const chosen = await install({ image: "node:20", reinstall: true });
    expect(docker.images).toEqual(["node:20"]);
    expect(chosen.imageReason).toBe("image chosen by the caller");
  });

  it("falls back to the default image when the version's tag cannot be pulled", async () => {
    docker.repoFiles = { ".nvmrc": "31.0.0", "package.json": pkg({}) };
    docker.missingImages.add("node:31");
    const record = await install();
    expect(docker.images).toEqual(["node:lts"]);
    expect(record.status).toBe("ready");
    expect(record.warnings).toContain("Image node:31 could not be pulled; used the default node:lts instead.");
    expect(record.imageReason).toContain("could not be pulled");
  });

  it("leaves an operator-configured image alone", async () => {
    setup({ MCPE_IMAGE_NODE: "internal/node:9" });
    docker.repoFiles = { ".nvmrc": "24", "package.json": pkg({}) };
    await install();
    expect(docker.images).toEqual(["internal/node:9"]);
  });
});

describe("command discovery", () => {
  beforeEach(() => {
    docker.repoFiles = { "package.json": pkg({}) };
  });

  it("folds names for the same program together but keeps multi-call binaries apart", async () => {
    const record = await install();
    // tool-alias: same file, same help. multi: same file, different help.
    expect(record.commands).toEqual([
      { name: "tool", origin: "built by node recipe", aliases: ["tool-alias"] },
      { name: "multi", origin: "built by node recipe" },
    ]);
    const names = record.tools.map((t) => t.name);
    expect(names).toContain("widget__tool");
    expect(names).toContain("widget__multi");
    expect(names.some((n) => n.includes("tool_alias"))).toBe(false);
    expect(record.tools.find((t) => t.name === "widget__tool")!.description).toContain("Also installed as tool-alias.");
    // The alias was never crawled beyond its top-level help.
    expect(docker.calls.filter((c) => c.argv[0] === "tool-alias").map((c) => c.argv)).toEqual([["tool-alias", "--help"]]);
  });
});

describe("MCP server detection", () => {
  const serverJson = JSON.stringify({ packages: [{ identifier: "tool-pkg", transport: { type: "stdio" }, packageArguments: [{ type: "positional", value: "mcp" }] }] });
  beforeEach(() => {
    docker.repoFiles = { "package.json": pkg({}) };
    up.answer = true;
  });

  it("launches the server the way the repository's manifest says, and keeps the command's CLI tools", async () => {
    docker.files["server.json"] = serverJson;
    docker.files["mcp.json"] = JSON.stringify({ mcpServers: { tool: { command: "npx", args: ["-y", "tool-pkg@1.0.0", "mcp"] } } });
    up.answerIf = (launch) => launch.server.argv.join(" ") === "tool mcp";
    const record = await install();
    expect(record.mcpServers).toEqual([{ name: "tool", argv: ["tool", "mcp"], cwd: "/workspace/repo", env: {}, origin: "detected" }]);
    // One probe, the declared one: nothing was started bare.
    expect(up.launches.map((l) => l.server.argv)).toEqual([["tool", "mcp"]]);
    const names = record.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["widget__add", "widget__whoami", "widget__tool", "widget__multi"]));
    expect(record.warnings.filter((w) => w.startsWith("MCP:"))).toEqual([]);
  });

  it("probes commands of a package that depends on an MCP SDK when run bare, and drops their CLI tools", async () => {
    docker.sdkBins = ["tool"];
    up.answerIf = (launch) => launch.server.argv.join(" ") === "tool";
    const record = await install();
    expect(record.mcpServers).toEqual([{ name: "tool", argv: ["tool"], cwd: "/workspace/repo", env: {}, origin: "detected" }]);
    expect(up.launches.map((l) => l.server.argv)).toEqual([["tool"]]);
    const names = record.tools.map((t) => t.name);
    expect(names).toContain("widget__add");
    expect(names).not.toContain("widget__tool"); // a bare MCP server has no CLI
    expect(names).toContain("widget__multi");
  });

  it("does not start anything when nothing points to MCP", async () => {
    const record = await install();
    expect(up.launches).toEqual([]);
    expect(record.mcpServers).toEqual([]);
  });

  it("reports the launches it tried when none answers", async () => {
    docker.files["server.json"] = serverJson;
    docker.sdkBins = ["tool"];
    up.answer = false;
    setup({ MCPE_MCP_STARTUP_TIMEOUT: "1" });
    docker.repoFiles = { "package.json": pkg({}) };
    docker.files["server.json"] = serverJson;
    docker.sdkBins = ["tool"];
    // Make the probe fail fast rather than wait out the handshake timeout.
    docker.exists = true;
    const proxy = new McpProxy(cfg, docker, () => {
      throw new Error("spawn failed");
    });
    installer = new Installer(cfg, docker, registry, proxy);
    const record = await install();
    const warning = record.warnings.find((w) => w.startsWith("MCP:"))!;
    expect(warning).toContain("none of these completed an MCP handshake: `tool mcp`, `tool`");
    expect(warning).toContain("connect_mcp_server");
    expect(record.status).toBe("ready");
  });
});

describe("publication at install time", () => {
  it("keeps an oversized MCP server out of the tool list but in the catalog, and keeps a selection across reinstalls", async () => {
    setup({ MCPE_MAX_TOOLS_PER_PROJECT: "3" });
    docker.repoFiles = { "package.json": pkg({}) };
    docker.sdkBins = ["multi"];
    up.answer = true;
    up.answerIf = (launch) => launch.server.argv.join(" ") === "multi";
    const record = await install();
    // Catalog: 4 proxied tools, tool, helpers, tool run. Published: gateways only.
    expect(record.tools.filter((t) => t.kind === "mcp")).toHaveLength(4);
    expect(record.published).toEqual(["widget__tool", "widget__node"]);
    expect(record.warnings).toContain(
      'Tools: MCP server "multi" offers 4 tools, more than the 1 that fit under the limit of 3, so none of them are published individually. Search them with find_project_tools and run them with call_project_tool, or publish a subset with select_project_tools.',
    );

    const selected = installer.reselect(record, { include: ["add", "whoami"], exclude: [] });
    expect(selected.published).toEqual(["widget__add", "widget__whoami"]);
    expect(selected.warnings.some((w) => w.startsWith("Tools:"))).toBe(false);

    const again = await install({ reinstall: true });
    expect(again.selection).toEqual({ include: ["add", "whoami"], exclude: [] });
    expect(again.published).toEqual(["widget__add", "widget__whoami"]);
  });
});

describe("host environment variables", () => {
  const withEnv = (env: Record<string, string | undefined>): void => {
    installer = new Installer(cfg, docker, registry, new McpProxy(cfg, docker, up.connector), undefined, env);
  };

  it("candidates: every launch of an install with detection carries the variable, and the record stores none", async () => {
    docker.repoFiles = { "package.json": pkg({}) };
    docker.sdkBins = ["tool"];
    up.answer = true;
    up.answerIf = (launch) => launch.server.argv.join(" ") === "tool";
    withEnv({ widget__API_KEY: SECRET_VALUE, other__API_KEY: "nope" });
    const record = await install();
    expect(up.launches.length).toBeGreaterThan(0);
    for (const l of up.launches) expect(l.server.env).toEqual({ API_KEY: SECRET_VALUE });
    expect(record.mcpServers).toEqual([{ name: "tool", argv: ["tool"], cwd: "/workspace/repo", env: {}, origin: "detected" }]);
    expect(fs.readFileSync(path.join(dir, "registry.json"), "utf8")).not.toContain(SECRET_VALUE);
  });

  it("candidates: an unusable value fails the candidate with the message and the install still finishes ready", async () => {
    docker.repoFiles = { "package.json": pkg({}) };
    docker.sdkBins = ["tool"];
    up.answer = true;
    withEnv({ widget__API_KEY: "a\nb-SECRET-3" });
    const record = await install();
    expect(record.status).toBe("ready");
    expect(up.launches).toEqual([]);
    const warning = record.warnings.find((w) => w.startsWith("MCP:"))!;
    expect(warning).toContain("Environment variable widget__API_KEY contains a line break");
    expect(warning).not.toContain("SECRET-3");
  });

  describe("launchSpec", () => {
    const stored = { name: "s", argv: ["s"], cwd: "/workspace/repo", env: { A: "1", B: "stored" }, origin: "registered" as const };
    const project = (slug: string) => ({ ...record(slug), mcpServers: [stored] });
    function record(slug: string) {
      return {
        slug,
        repo: { forge: "github" as const, host: "github.com", path: `o/${slug}`, cloneUrl: "", id: `github:o/${slug}`, name: slug },
        image: "", container: `mcpe-${slug}`, volume: `mcpe-${slug}`, ecosystems: [], primary: "generic" as const, network: false,
        status: "ready" as const, warnings: [], commands: [], tools: [],
        meta: { npmScripts: [], makeTargets: [], pythonModules: [], nodePackages: [], hasPythonEnv: false, hasNode: false },
        installedAt: "2026-01-01T00:00:00.000Z",
      };
    }

    it("overlays the project's variables on the stored environment, the host winning, and mutates nothing", () => {
      withEnv({ p__B: "host", p__C: "3" });
      const spec = installer.launchSpec(project("p"), stored);
      expect(spec).toEqual({ ...stored, env: { A: "1", B: "host", C: "3" } });
      expect(spec).not.toBe(stored);
      expect(stored.env).toEqual({ A: "1", B: "stored" });
    });

    it("returns the stored environment unchanged when no variable matches", () => {
      withEnv({ q__B: "host" });
      expect(installer.launchSpec(project("p"), stored).env).toEqual({ A: "1", B: "stored" });
    });

    it("gives a project that is not in the registry its variables", () => {
      withEnv({ p__C: "3" });
      expect(registry.get("p")).toBeUndefined();
      expect(installer.launchSpec(project("p"), stored).env).toEqual({ A: "1", B: "stored", C: "3" });
    });

    it("decides ownership against every record in the registry, whatever its status, in either order", () => {
      registry.put({ ...record("a"), status: "failed" });
      registry.put({ ...record("a__b"), status: "installing" });
      withEnv({ a__b__KEY: SECRET_VALUE });
      expect(installer.launchSpec(project("a__b"), stored).env).toEqual({ A: "1", B: "stored", KEY: SECRET_VALUE });
      expect(installer.launchSpec(project("a"), stored).env).toEqual({ A: "1", B: "stored" });
      expect(installer.hostVariableNames(project("a"))).toEqual([]);
      expect(installer.hostVariableNames(project("a__b"))).toEqual(["KEY"]);
    });

    it("throws a plain Error without the value for an unusable value", () => {
      withEnv({ p__B: "x\ry-SECRET-4" });
      expect(() => installer.launchSpec(project("p"), stored)).toThrow(/^Environment variable p__B contains a line break/);
      expect(() => installer.launchSpec(project("p"), stored)).not.toThrow(/SECRET-4/);
      expect(installer.hostVariableNames(project("p"))).toEqual(["B"]);
    });
  });
});

describe("refresh_mcp on a scripted sandbox", () => {
  const apps: App[] = [];
  const lines: string[] = [];
  /** A launch that fails at once, as a server that exits at start-up does. */
  const dead = (): ReturnType<Connector> => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    void serverSide.close();
    return { transport: clientSide, stderr: () => "" };
  };
  /** Launches the predicate accepts reach the fake upstream; the others fail at once. */
  const gated = (answers: (launch: Launch) => boolean): Connector => (launch) => {
    if (answers(launch)) return up.connector(launch);
    up.launches.push(launch);
    return dead();
  };
  const hasKey = (launch: Launch) => launch.server.env.API_KEY === SECRET_VALUE;
  /** An App on the shared data directory: another one with other `env` stands in for a reconnect. */
  const appWith = (env: Record<string, string | undefined>, connector: Connector): App => {
    const a = new App({ cfg, docker, proxy: new McpProxy(cfg, docker, connector), env, log: (l) => lines.push(l) });
    apps.push(a);
    return a;
  };
  const installWith = (a: App) => a.installer.install({ repo: parseRepoRef("acme/widget", cfg.hosts) });
  const text = (res: Awaited<ReturnType<App["callTool"]>>) => (res.content[0] as { text: string }).text;

  beforeEach(() => {
    lines.length = 0;
    docker.repoFiles = { "package.json": pkg({}) };
    up.answer = true;
  });
  afterEach(async () => {
    for (const a of apps.splice(0)) await a.shutdown();
  });

  it("a candidate that answers only with a variable: found by a refresh once the variable is there", async () => {
    docker.sdkBins = ["tool"];
    const without = appWith({}, gated(hasKey));
    const installed = await installWith(without);
    expect(installed.status).toBe("ready");
    expect(installed.mcpServers).toEqual([]);
    expect(installed.tools.filter((t) => t.kind === "mcp")).toEqual([]);
    const warning = installed.warnings.find((w) => w.startsWith("MCP:"))!;
    expect(warning).toContain("none of these completed an MCP handshake: `tool`");
    expect(warning).toContain("set widget__NAME in the environment of mcp-everything, reconnect it, and call refresh_mcp");
    expect(warning).toContain("connect_mcp_server");

    up.launches.length = 0;
    const withKey = appWith({ widget__API_KEY: SECRET_VALUE }, gated(hasKey));
    const res = await withKey.callTool("refresh_mcp", { project: "widget" });
    expect(res.isError).toBe(false);
    expect(up.launches.length).toBeGreaterThan(0);
    for (const l of up.launches) expect(l.server.env.API_KEY).toBe(SECRET_VALUE);
    const p = withKey.registry.get("widget")!;
    expect(p.mcpServers).toEqual([{ name: "tool", argv: ["tool"], cwd: "/workspace/repo", env: {}, origin: "detected" }]);
    expect(p.tools.filter((t) => t.kind === "mcp").length).toBeGreaterThan(0);
    expect(withKey.listTools().map((t) => t.name)).toContain("widget__add");
    expect(text(res)).toContain("API_KEY");
    expect(text(res)).not.toContain(SECRET_VALUE);
    expect(fs.readFileSync(path.join(dir, "registry.json"), "utf8")).not.toContain(SECRET_VALUE);
    for (const l of lines) expect(l).not.toContain(SECRET_VALUE);
  });

  it("the reverse: a server that needs the variable is gone after a refresh without it, and that is an error", async () => {
    docker.sdkBins = ["tool", "multi"];
    const answers = (l: Launch) => l.server.argv[0] === "multi" || hasKey(l);
    const withKey = appWith({ widget__API_KEY: SECRET_VALUE }, gated(answers));
    const installed = await installWith(withKey);
    expect(installed.mcpServers!.map((s) => s.name).sort()).toEqual(["multi", "tool"]);

    const without = appWith({}, gated(answers));
    const res = await without.callTool("refresh_mcp", { project: "widget" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('Recorded before and gone now: "tool".');
    expect(text(res)).not.toContain("Did not start");
    expect(without.registry.get("widget")!.mcpServers!.map((s) => s.name)).toEqual(["multi"]);
    expect(text(res).split("\n")[0]).toMatch(/^Refreshed widget: 1 MCP server\(s\) recorded, 0 with no tool in the catalog, [1-9]\d* proxied tool\(s\) in the catalog\.$/);
  });

  it("a candidate that did not answer is listed and is not an error while another server publishes tools", async () => {
    docker.sdkBins = ["tool", "multi"];
    const a = appWith({}, gated((l) => l.server.argv[0] === "multi"));
    const installed = await installWith(a);
    expect(installed.mcpServers!.map((s) => s.name)).toEqual(["multi"]);
    const res = await a.callTool("refresh_mcp", { project: "widget" });
    expect(res.isError).toBe(false);
    expect(text(res)).toContain("Candidates that did not answer: `tool`");
    expect(text(res)).not.toContain("Did not start");
    expect(text(res)).not.toContain("gone");
  });

  it("the candidates' warning gets no route hint when the reason is an unusable value", async () => {
    docker.sdkBins = ["tool"];
    const a = appWith({ widget__API_KEY: "a\nb-SECRET-5" }, gated(() => true));
    const installed = await installWith(a);
    const warning = installed.warnings.find((w) => w.startsWith("MCP:"))!;
    expect(warning).toContain("Environment variable widget__API_KEY contains a line break");
    expect(warning).not.toContain("refresh_mcp");
    expect(warning).not.toContain("SECRET-5");
  });
});

describe("install failure paths", () => {
  const lastNetwork = () => docker.network[docker.network.length - 1];
  const destroys = () => docker.destroyed.filter((d) => d === "mcpe-widget");
  const retryable = () => {
    docker.repoFiles = { "package.json": pkg({ engines: { node: "^22.23.4 || ^24.22.1 || >=26.12.1" } }) };
    docker.recipe = (image) => (image === "node:26" ? SOFT_FAIL : { stdout: "built\n" });
  };

  describe("no sandbox was created", () => {
    it("leaves nothing when the clone fails", async () => {
      docker.probeError = new Error("clone failed: not found");
      const record = await install();
      expect(record).toMatchObject({ status: "failed", error: "clone failed: not found" });
      expect(registry.get("widget")).toBeUndefined();
      // One destroy opens the install, a second is the rollback.
      expect(destroys()).toHaveLength(2);
      expect(docker.network).toEqual([]);
    });

    it("leaves nothing when the default image cannot be pulled", async () => {
      docker.repoFiles = { "package.json": pkg({}) };
      docker.missingImages.add("node:lts");
      const record = await install();
      expect(record).toMatchObject({ status: "failed", error: "Failed to pull image node:lts: not found" });
      expect(registry.get("widget")).toBeUndefined();
      expect(destroys()).toHaveLength(2);
    });

    it("drops the earlier record when a reinstall fails this way", async () => {
      docker.repoFiles = { "package.json": pkg({}) };
      expect((await install()).status).toBe("ready");
      docker.probeError = new Error("clone failed: not found");
      const record = await install({ reinstall: true });
      expect(record.status).toBe("failed");
      expect(registry.get("widget")).toBeUndefined();
    });
  });

  describe("the sandbox is kept", () => {
    it("takes it off the network when the recipe fails, also when network was requested", async () => {
      docker.repoFiles = { ".nvmrc": "24", "package.json": pkg({}) };
      docker.recipe = () => ({ code: 1, stderr: "boom\n" });
      const record = await install({ network: true });
      expect(record).toMatchObject({ status: "failed", network: false, error: "Install recipe for node exited with code 1." });
      expect(registry.get("widget")).toMatchObject({ status: "failed", network: false });
      expect(lastNetwork()).toEqual(["mcpe-widget", false]);
    });

    it("takes it off the network when the recipe times out, and names the limit", async () => {
      docker.repoFiles = { "package.json": pkg({}) };
      docker.recipe = () => ({ code: 124, timedOut: true });
      const record = await install({ network: true, timeoutSec: 45 });
      expect(record).toMatchObject({ status: "failed", network: false });
      expect(record.error).toMatch(/^Install timed out after 45s/);
      expect(registry.get("widget")?.network).toBe(false);
      expect(lastNetwork()).toEqual(["mcpe-widget", false]);
    });

    it("takes it off the network when the second attempt's image cannot be pulled", async () => {
      retryable();
      docker.missingImages.add("node:24").add("node:lts");
      const record = await install({ network: true });
      expect(record).toMatchObject({ status: "failed", network: false, error: "Failed to pull image node:lts: not found" });
      expect(registry.get("widget")).toMatchObject({ status: "failed", network: false });
      expect(lastNetwork()).toEqual(["mcpe-widget", false]);
    });

    it("takes it off the network when removing the container for the second attempt fails", async () => {
      retryable();
      // The fake destroy does not remove, so call 1 is the second attempt's removal.
      docker.removeContainerFails = [1];
      const record = await install({ network: true });
      expect(record).toMatchObject({ status: "failed", network: false, error: "removeContainer failed (call 1)" });
      expect(lastNetwork()).toEqual(["mcpe-widget", false]);
    });

    it("takes it off the network when a step fails after the requested policy was applied", async () => {
      docker.repoFiles = { "package.json": pkg({}) };
      // Discovery swallows exec errors, so make the step itself throw.
      (installer as unknown as { discover: () => Promise<void> }).discover = async () => {
        throw new Error("discovery lost the daemon");
      };
      const record = await install({ network: true });
      expect(record).toMatchObject({ status: "failed", network: false, error: "discovery lost the daemon" });
      expect(docker.network).toEqual([
        ["mcpe-widget", true],
        ["mcpe-widget", false],
      ]);
      expect(registry.get("widget")).toMatchObject({ status: "failed", network: false });
    });

    it("keeps the thrown error when applying the policy fails, then records the sandbox off", async () => {
      docker.repoFiles = { "package.json": pkg({}) };
      docker.setNetworkFails = [1];
      const record = await install({ network: true });
      expect(record).toMatchObject({ status: "failed", network: false, error: "setNetwork failed (call 1)" });
      expect(lastNetwork()).toEqual(["mcpe-widget", false]);
    });

    it("keeps the original error and records the network as on when it cannot be turned off", async () => {
      docker.repoFiles = { "package.json": pkg({}) };
      docker.recipe = () => ({ code: 1 });
      docker.setNetworkFails = "all";
      const record = await install({ network: true });
      expect(record).toMatchObject({ status: "failed", network: true, error: "Install recipe for node exited with code 1." });
      expect(record.warnings.filter((w) => w.includes("set_project_network"))).toHaveLength(1);
      expect(record.warnings.join("\n")).toContain("could not be taken off the network");
      expect(registry.get("widget")).toMatchObject({ status: "failed", network: true });
    });

    it("also keeps the original error when a throw is followed by a failed turn-off", async () => {
      retryable();
      docker.missingImages.add("node:24").add("node:lts");
      docker.setNetworkFails = "all";
      const record = await install();
      expect(record).toMatchObject({ status: "failed", network: true, error: "Failed to pull image node:lts: not found" });
      expect(record.warnings.join("\n")).toContain("set_project_network");
    });
  });

  describe("success", () => {
    it("leaves the sandbox attached and recorded on when network was requested", async () => {
      docker.repoFiles = { "package.json": pkg({}) };
      const record = await install({ network: true });
      expect(record).toMatchObject({ status: "ready", network: true });
      expect(docker.network).toEqual([["mcpe-widget", true]]);
    });

    it("leaves the sandbox detached and recorded off by default", async () => {
      docker.repoFiles = { "package.json": pkg({}) };
      const record = await install();
      expect(record).toMatchObject({ status: "ready", network: false });
      expect(docker.network).toEqual([["mcpe-widget", false]]);
    });
  });

  describe("uninstall", () => {
    it("rejects and keeps the entry when the sandbox cannot be destroyed", async () => {
      docker.repoFiles = { "package.json": pkg({}) };
      await install();
      docker.destroyFails = "all";
      await expect(installer.uninstall(registry.get("widget")!)).rejects.toThrow(/destroy failed/);
      expect(registry.get("widget")).toBeDefined();
    });
  });
});

describe("stale installs at startup", () => {
  const NOW = Date.parse("2026-11-16T12:00:00.000Z");
  const limitMs = () => staleInstallLimitSec(cfg) * 1000;
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const seed = (slug: string, over: Partial<ProjectRecord> = {}): ProjectRecord => {
    const r = { ...seedRecord(slug), status: "installing" as const, network: true, installedAt: ago(limitMs() + 1000), ...over };
    registry.put(r);
    return r;
  };
  const file = () => path.join(dir, "registry.json");
  const mtime = () => fs.statSync(file()).mtimeMs;
  const other = () => new Registry(dir);

  it("is seven hours by default and follows the install timeout", () => {
    expect(staleInstallLimitSec(cfg)).toBe(7 * 3600);
    expect(staleInstallLimitSec(loadConfig({ HOME: dir, MCPE_DATA_DIR: dir, MCPE_INSTALL_TIMEOUT: "3600" }))).toBe(7 * 3600);
    expect(staleInstallLimitSec(loadConfig({ HOME: dir, MCPE_DATA_DIR: dir, MCPE_INSTALL_TIMEOUT: "10000" }))).toBe(2 * 10000 + 10800);
  });

  it("marks a stale record failed, takes its sandbox off the network and says why", async () => {
    const r = seed("x", { errorLog: "old log" });
    const log: string[] = [];
    expect(await installer.reconcileStale(NOW, (l) => log.push(l))).toEqual(["x"]);
    expect(docker.network).toEqual([["mcpe-x", false]]);
    const stored = registry.get("x")!;
    expect(stored).toMatchObject({ status: "failed", network: false });
    expect(stored.error).toBe(
      `Install was interrupted: it started at ${r.installedAt} and never finished. Reinstall with install_project(reinstall: true).`,
    );
    expect(stored.errorLog).toBeUndefined();
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("x");
  });

  it("leaves a record one second under the limit, and one exactly at it, alone", async () => {
    seed("under", { installedAt: ago(limitMs() - 1000) });
    seed("at", { installedAt: ago(limitMs()) });
    const before = mtime();
    expect(await installer.reconcileStale(NOW)).toEqual([]);
    expect(docker.network).toEqual([]);
    expect(docker.availableCalls).toBe(0);
    expect(mtime()).toBe(before);
  });

  it("leaves old ready and failed records, and unparsable or future times, alone", async () => {
    seed("ready", { status: "ready" });
    seed("failed", { status: "failed", error: "x" });
    seed("junk", { installedAt: "not a date" });
    seed("future", { installedAt: ago(-3600_000) });
    const before = mtime();
    expect(await installer.reconcileStale(NOW)).toEqual([]);
    expect(docker.network).toEqual([]);
    expect(docker.availableCalls).toBe(0);
    expect(mtime()).toBe(before);
  });

  it("moves the limit with MCPE_INSTALL_TIMEOUT", async () => {
    setup({ MCPE_INSTALL_TIMEOUT: "10000" });
    seed("x", { installedAt: ago(limitMs() - 1000) });
    expect(await installer.reconcileStale(NOW)).toEqual([]);
    expect(docker.network).toEqual([]);
  });

  it("changes only the stale one of a stale and a fresh record", async () => {
    seed("old");
    const fresh = seed("new", { installedAt: ago(60_000) });
    expect(await installer.reconcileStale(NOW)).toEqual(["old"]);
    expect(docker.network).toEqual([["mcpe-old", false]]);
    expect(registry.get("new")).toEqual(fresh);
  });

  it("changes nothing and logs once when Docker does not answer, and reconciles at a later start", async () => {
    seed("a");
    seed("b");
    docker.unavailable = true;
    const before = mtime();
    const log: string[] = [];
    expect(await installer.reconcileStale(NOW, (l) => log.push(l))).toEqual([]);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("2");
    expect(docker.network).toEqual([]);
    expect(mtime()).toBe(before);
    expect(registry.get("a")?.status).toBe("installing");
    docker.unavailable = false;
    expect((await installer.reconcileStale(NOW)).sort()).toEqual(["a", "b"]);
  });

  it("records network: true with the warning when the detach fails, and still reconciles the others", async () => {
    seed("a");
    seed("b");
    docker.setNetworkFails = [1];
    expect((await installer.reconcileStale(NOW)).sort()).toEqual(["a", "b"]);
    const failed = registry.list().filter((p) => p.network);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ status: "failed", network: true });
    expect(failed[0]!.warnings.filter((w) => w.includes("set_project_network"))).toHaveLength(1);
    const ok = registry.list().find((p) => !p.network)!;
    expect(ok).toMatchObject({ status: "failed", network: false, warnings: [] });
  });

  it("skips a record that another process replaced while Docker was being asked", async () => {
    seed("x");
    const newer = { ...seedRecord("x"), status: "installing" as const, network: true, installedAt: ago(1000) };
    docker.onAvailable = () => other().put(newer);
    expect(await installer.reconcileStale(NOW)).toEqual([]);
    expect(docker.network).toEqual([]);
    expect(registry.get("x")).toEqual(newer);
  });

  it("skips a record another process finished or removed while Docker was being asked", async () => {
    seed("done");
    seed("gone");
    docker.onAvailable = () => {
      const o = other();
      o.refresh();
      o.put({ ...o.get("done")!, status: "ready" });
      o.delete("gone");
    };
    expect(await installer.reconcileStale(NOW)).toEqual([]);
    expect(docker.network).toEqual([]);
    expect(registry.get("done")?.status).toBe("ready");
    expect(registry.get("gone")).toBeUndefined();
  });

  it("keeps a field another process changed during the detach", async () => {
    seed("x");
    const selection = { mode: "all" } as unknown as ProjectRecord["selection"];
    docker.onSetNetwork = () => {
      const o = other();
      o.refresh();
      o.put({ ...o.get("x")!, selection });
    };
    expect(await installer.reconcileStale(NOW)).toEqual(["x"]);
    expect(registry.get("x")).toMatchObject({ status: "failed", network: false, selection });
  });

  it("writes nothing when the record was replaced during the detach", async () => {
    seed("x");
    const newer = { ...seedRecord("x"), status: "installing" as const, network: true, installedAt: ago(1000) };
    docker.onSetNetwork = () => other().put(newer);
    const log: string[] = [];
    expect(await installer.reconcileStale(NOW, (l) => log.push(l))).toEqual([]);
    expect(registry.get("x")).toEqual(newer);
    const written = mtime();
    expect(other().refresh()).toBe(true);
    expect(mtime()).toBe(written);
  });

  it("does not rewrite the file when the record changed during the detach", async () => {
    seed("x");
    let after = 0;
    docker.onSetNetwork = () => {
      const o = other();
      o.refresh();
      o.put({ ...o.get("x")!, status: "ready" });
      after = mtime();
    };
    expect(await installer.reconcileStale(NOW)).toEqual([]);
    expect(mtime()).toBe(after);
    expect(registry.get("x")?.status).toBe("ready");
  });

  it("appends its warning to the warnings the record has now", async () => {
    seed("x", { warnings: ["old"] });
    docker.setNetworkFails = "all";
    docker.onSetNetwork = () => {
      const o = other();
      o.refresh();
      o.put({ ...o.get("x")!, warnings: ["old", "added by a neighbor"] });
    };
    expect(await installer.reconcileStale(NOW)).toEqual(["x"]);
    const w = registry.get("x")!.warnings;
    expect(w.slice(0, 2)).toEqual(["old", "added by a neighbor"]);
    expect(w).toHaveLength(3);
    expect(w[2]).toContain("set_project_network");
    expect(registry.get("x")).toMatchObject({ status: "failed", network: true });
  });
});
