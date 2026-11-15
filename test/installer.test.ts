import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { parseRepoRef } from "../src/forge/repo-ref.js";
import { Installer } from "../src/install/installer.js";
import { McpProxy } from "../src/proxy/mcp-proxy.js";
import { Registry } from "../src/registry.js";
import type { ExecOptions, ExecResult, ProbeData } from "../src/sandbox/docker.js";
import { FakeDocker, fakeUpstream, type FakeUpstream } from "./helpers.js";

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

  override async assertAvailable(): Promise<void> {}
  override async probe(): Promise<ProbeData> {
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
