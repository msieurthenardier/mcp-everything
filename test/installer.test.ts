import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { parseRepoRef } from "../src/forge/repo-ref.js";
import { Installer, staleInstallLimitSec } from "../src/install/installer.js";
import { McpProxy } from "../src/proxy/mcp-proxy.js";
import type { Connector, Launch } from "../src/proxy/mcp-proxy.js";
import { Registry } from "../src/registry.js";
import { App } from "../src/server.js";
import {
  DockerUnavailableError,
  SandboxRefusedError,
  type ExecOptions,
  type ExecResult,
  OWNER_SHOWN,
  type ProbeData,
  type SandboxFacts,
  type SandboxRef,
} from "../src/sandbox/docker.js";
import { FakeDocker, fakeUpstream, record as seedRecord, SECRET_VALUE, targetName, TEST_INSTALLATION_ID, type FakeUpstream, type SandboxTarget } from "./helpers.js";
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
  /** Throw from createContainer on the given 1-based calls. */
  createContainerFails: number[] = [];
  /** References whose container `removeContainer` has removed: `setNetwork` on one throws, as Docker does. */
  private gone = new Set<string>();
  destroyFails: number[] | "all" = [];
  /** Throw this from `destroy` of the container with this name (a refusal or "could not be asked"). */
  destroyErrors: Record<string, Error> = {};
  /** Throw this from `setNetwork` (any call). */
  setNetworkError?: Error;
  /** Throw what this returns from an `exec` whose argv it accepts. */
  execError?: (argv: string[]) => Error | undefined;
  private counts = { setNetwork: 0, removeContainer: 0, destroy: 0 };
  /**
   * Every call the installer makes into this double, with the arguments and the
   * widget record as registry.json holds it on disk at that moment (not an
   * object the installer may still be changing).
   */
  trace: Array<{ call: string; args: string[]; rec: ProjectRecord | undefined }> = [];
  traced(call: string, ...args: string[]): void {
    this.trace.push({ call, args, rec: onDisk("widget") });
  }

  private fail(which: keyof ScriptedDocker["counts"], when: number[] | "all"): void {
    const n = ++this.counts[which];
    if (when === "all" || when.includes(n)) throw new Error(`${which} failed (call ${n})`);
  }
  /** For the startup reconciliation: count, fail or hook the reachability check and the detach. */
  availableCalls = 0;
  unavailable = false;
  onAvailable?: () => void;
  onSetNetwork?: () => void;
  override async setNetwork(target: SandboxTarget, enabled: boolean): Promise<void> {
    this.traced("setNetwork", targetName(target), String(enabled));
    this.onSetNetwork?.();
    if (typeof target !== "string" && this.gone.has(target.id)) throw new Error(`Sandbox ${target.name} no longer exists`);
    if (this.setNetworkError) throw this.setNetworkError;
    this.fail("setNetwork", this.setNetworkFails);
    return super.setNetwork(target, enabled);
  }
  override async removeContainer(container: string): Promise<void> {
    this.traced("removeContainer", container);
    this.fail("removeContainer", this.removeContainerFails);
    for (const ref of this.created) if (ref.name === container) this.gone.add(ref.id);
    return super.removeContainer(container);
  }
  override async destroy(container: string, volume?: string): Promise<void> {
    this.traced("destroy", container, volume ?? "");
    this.fail("destroy", this.destroyFails);
    const refused = this.destroyErrors[container];
    if (refused) throw refused;
    return super.destroy(container, volume);
  }

  override async assertAvailable(): Promise<void> {
    this.availableCalls++;
    this.onAvailable?.();
    if (this.unavailable) throw new Error("Docker CLI could not be run");
  }
  override async probe(): Promise<ProbeData> {
    this.traced("probe");
    if (this.probeError) throw this.probeError;
    return this.probeData;
  }
  override async ensureImage(image: string): Promise<void> {
    if (this.missingImages.has(image)) throw new Error(`Failed to pull image ${image}: not found`);
  }
  /** Every reference `createContainer` handed out, in order; each has a different id. */
  created: SandboxRef[] = [];
  private createCalls = 0;
  override async createContainer(opts: { image: string; name: string }): Promise<SandboxRef> {
    this.traced("createContainer", opts.name);
    const call = ++this.createCalls;
    if (this.createContainerFails.includes(call)) throw new Error(`createContainer failed (call ${call})`);
    this.images.push(opts.image);
    const ref = Object.freeze({ id: `${this.created.length + 1}`.padStart(64, "e"), name: opts.name });
    this.created.push(ref);
    return ref;
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

  override async exec(target: SandboxTarget, argv: string[], opts: ExecOptions): Promise<ExecResult> {
    this.calls.push({ container: targetName(target), argv, opts, sandbox: typeof target === "string" ? undefined : target });
    const failure = this.execError?.(argv);
    if (failure) throw failure;
    const res = { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false, ...this.answer(argv) };
    if (res.stdout) opts.onOutput?.(res.stdout);
    return res;
  }
}

/** The sandbox name a fresh install of acme/widget gets: prefix, installation id, slug. */
const WIDGET = `mcpe-${TEST_INSTALLATION_ID}-widget`;

/** A refusal as the Docker layer raises it, built from the facts of the parts it found. */
const refusal = (...facts: SandboxFacts[]) => new SandboxRefusedError(facts, TEST_INSTALLATION_ID);
const part = (kind: "container" | "volume", sandbox: string, cls: SandboxFacts["cls"], owner?: string): SandboxFacts => ({ kind, sandbox, cls, owner });
const OTHER = "deadbeef";

const SOFT_FAIL = { stdout: "MCPE_SOFT_FAIL\nMCPE_WARN build script failed; binaries that need a build step may be missing\n" };
const pkg = (body: object) => JSON.stringify({ name: "tool-pkg", bin: { tool: "cli.js" }, ...body });

let dir: string;
/** A record as registry.json holds it right now, read afresh. */
const onDisk = (slug: string): ProjectRecord | undefined => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(dir, "registry.json"), "utf8")) as { projects: Record<string, ProjectRecord> }).projects[slug];
  } catch {
    return undefined;
  }
};
let cfg: Config;
let proxy: McpProxy;
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
  proxy = new McpProxy(cfg, docker, up.connector);
  installer = new Installer(cfg, docker, registry, proxy);
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
    expect(docker.destroyed.filter((d) => d.startsWith("container:"))).toEqual([`container:${WIDGET}`]);
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
  const destroys = () => docker.destroyed.filter((d) => d === WIDGET);
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
      expect(lastNetwork()).toEqual([WIDGET, false]);
    });

    it("takes it off the network when the recipe times out, and names the limit", async () => {
      docker.repoFiles = { "package.json": pkg({}) };
      docker.recipe = () => ({ code: 124, timedOut: true });
      const record = await install({ network: true, timeoutSec: 45 });
      expect(record).toMatchObject({ status: "failed", network: false });
      expect(record.error).toMatch(/^Install timed out after 45s/);
      expect(registry.get("widget")?.network).toBe(false);
      expect(lastNetwork()).toEqual([WIDGET, false]);
    });

    it("takes it off the network when the second attempt's image cannot be pulled", async () => {
      retryable();
      docker.missingImages.add("node:24").add("node:lts");
      const record = await install({ network: true });
      expect(record).toMatchObject({ status: "failed", network: false, error: "Failed to pull image node:lts: not found" });
      expect(registry.get("widget")).toMatchObject({ status: "failed", network: false });
      expect(lastNetwork()).toEqual([WIDGET, false]);
    });

    it("takes it off the network when removing the container for the second attempt fails", async () => {
      retryable();
      // The fake destroy does not remove, so call 1 is the second attempt's removal.
      docker.removeContainerFails = [1];
      const record = await install({ network: true });
      expect(record).toMatchObject({ status: "failed", network: false, error: "removeContainer failed (call 1)" });
      expect(lastNetwork()).toEqual([WIDGET, false]);
    });

    it("keeps no claim about a container that is gone when the second container cannot be created", async () => {
      retryable();
      // Call 1 makes the first container; call 2 (the rebuild's) throws, after the first was removed.
      docker.createContainerFails = [2];
      const record = await install({ network: true });
      expect(record.status).toBe("failed");
      expect(record.error).toBe("createContainer failed (call 2)");
      expect(record.warnings.join("\n")).not.toContain("may still be online");
      // No container exists, so the install ends as one that never made one: the record is deleted ...
      expect(registry.get("widget")).toBeUndefined();
      // ... and what is at the new names is removed (opening destroy, then this rollback).
      expect(destroys()).toHaveLength(2);
      // The install never asked about the removed container's network.
      expect(docker.trace.filter((t) => t.call === "setNetwork")).toEqual([]);
    });

    it("takes the second container offline, through its own reference, when the second build fails", async () => {
      docker.repoFiles = { "package.json": pkg({ engines: { node: ">=20" } }) };
      docker.recipe = () => ({ code: 1, stderr: "boom\n" });
      const record = await install({ network: true });
      expect(record).toMatchObject({ status: "failed", network: false, error: "Install recipe for node exited with code 1." });
      expect(registry.get("widget")).toMatchObject({ status: "failed", network: false });
      expect(docker.created).toHaveLength(2);
      expect(record.warnings.join("\n")).not.toContain("may still be online");
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
        [WIDGET, true],
        [WIDGET, false],
      ]);
      expect(registry.get("widget")).toMatchObject({ status: "failed", network: false });
    });

    describe("a throw after discovery opened proxy sessions", () => {
      const spec = { name: "tool", argv: ["tool"], cwd: "/workspace/repo", env: {}, origin: "detected" as const };
      const openThenThrow = () => {
        docker.repoFiles = { "package.json": pkg({}) };
        up.answer = true;
        (installer as unknown as { discover: () => Promise<void> }).discover = async () => {
          await proxy.listTools(WIDGET, spec);
          expect(proxy.size).toBe(1);
          throw new Error("registry write failed");
        };
      };

      it("closes the project's sessions and reports the original error", async () => {
        openThenThrow();
        const record = await install();
        expect(record).toMatchObject({ status: "failed", error: "registry write failed" });
        expect(proxy.size).toBe(0);
      });

      it("does not let a failing close mask the original error", async () => {
        openThenThrow();
        // The first call is the install's own, before the sandbox exists; only the one in the catch fails.
        vi.spyOn(proxy, "closeProject").mockResolvedValueOnce(undefined).mockRejectedValue(new Error("close failed"));
        const record = await install({ network: true });
        expect(record).toMatchObject({ status: "failed", network: false, error: "registry write failed" });
        expect(registry.get("widget")).toMatchObject({ status: "failed", network: false });
      });
    });

    it("keeps the thrown error when applying the policy fails, then records the sandbox off", async () => {
      docker.repoFiles = { "package.json": pkg({}) };
      docker.setNetworkFails = [1];
      const record = await install({ network: true });
      expect(record).toMatchObject({ status: "failed", network: false, error: "setNetwork failed (call 1)" });
      expect(lastNetwork()).toEqual([WIDGET, false]);
    });

    it("keeps the original error and records the network as on when it cannot be turned off", async () => {
      docker.repoFiles = { "package.json": pkg({}) };
      docker.recipe = () => ({ code: 1 });
      docker.setNetworkFails = "all";
      const record = await install({ network: true });
      expect(record).toMatchObject({ status: "failed", network: true, error: "Install recipe for node exited with code 1." });
      expect(record.warnings.filter((w) => w.includes("set_project_network"))).toHaveLength(1);
      expect(record.warnings.join("\n")).toContain("could not be taken off the network after the failed install (");
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
      expect(docker.network).toEqual([[WIDGET, true]]);
    });

    it("leaves the sandbox detached and recorded off by default", async () => {
      docker.repoFiles = { "package.json": pkg({}) };
      const record = await install();
      expect(record).toMatchObject({ status: "ready", network: false });
      expect(docker.network).toEqual([[WIDGET, false]]);
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

    it("removes the volume the record names, not the container's name", async () => {
      docker.repoFiles = { "package.json": pkg({}) };
      await install();
      const record = { ...registry.get("widget")!, volume: "mcpe-widget-data" };
      registry.put(record);
      docker.destroyed = [];
      docker.destroyedVolumes = [];
      docker.trace = [];
      await installer.uninstall(record);
      expect(docker.trace.filter((t) => t.call === "destroy").map((t) => t.args)).toEqual([[WIDGET, "mcpe-widget-data"]]);
      expect(docker.destroyed).toEqual([WIDGET]);
      expect(docker.destroyedVolumes).toEqual(["mcpe-widget-data"]);
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
    expect(log[0]).toMatch(/^2 interrupted install\(s\) not reconciled, Docker is not reachable/);
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
    expect(failed[0]!.warnings.join("\n")).toContain("after the interrupted install (");
    expect(failed[0]!.warnings.join("\n")).not.toContain("failed install");
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
    let written = 0;
    docker.onSetNetwork = () => {
      other().put(newer);
      written = mtime();
    };
    const log: string[] = [];
    expect(await installer.reconcileStale(NOW, (l) => log.push(l))).toEqual([]);
    expect(registry.get("x")).toEqual(newer);
    expect(written).toBeGreaterThan(0);
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

describe("sandbox names and reinstall order", () => {
  const OLD = "mcpe-widget";
  const OLD_WARNING = "A reinstall could not remove this project's old sandbox, which may be partly removed; reinstall again to retry.";
  /** A project installed by an earlier version: names without the installation id. */
  const seedOld = (over: Partial<ProjectRecord> = {}): ProjectRecord => {
    const r: ProjectRecord = {
      ...seedRecord("widget", "acme/widget"),
      tools: [{ name: "widget__tool" } as ProjectRecord["tools"][number]],
      selection: { include: ["tool"], exclude: [], maxTools: 3 },
      ...over,
    };
    registry.put(r);
    return structuredClone(r);
  };
  /** What closing proxied servers sees, recorded like a Docker call. */
  const spyClose = () => {
    const real = proxy.closeProject.bind(proxy);
    vi.spyOn(proxy, "closeProject").mockImplementation(async (container: string) => {
      docker.traced("closeProject", container);
      return real(container);
    });
  };
  const steps = () => docker.trace.map((t) => `${t.call} ${t.args.join(" ")}`.trim());
  const named = (t: { rec: ProjectRecord | undefined }) => t.rec?.container;
  beforeEach(() => {
    docker.repoFiles = { "package.json": pkg({}) };
  });

  it("gives a first install names made of the prefix, the id and the slug, with one removal opening it", async () => {
    spyClose();
    const record = await install();
    expect(record).toMatchObject({ status: "ready", container: WIDGET, volume: WIDGET });
    expect(registry.get("widget")).toMatchObject({ container: WIDGET, volume: WIDGET });
    expect(steps().slice(0, 4)).toEqual([`closeProject ${WIDGET}`, `destroy ${WIDGET} ${WIDGET}`, "probe", `createContainer ${WIDGET}`]);
    expect(steps().some((s) => s.includes(OLD))).toBe(false);
    expect(docker.destroyed).toEqual([WIDGET]);
  });

  it("puts the chosen prefix before the id", async () => {
    setup({ MCPE_NAME_PREFIX: "box-" });
    const record = await install();
    expect(record).toMatchObject({ container: `box-${TEST_INSTALLATION_ID}-widget`, volume: `box-${TEST_INSTALLATION_ID}-widget` });
  });

  it("moves a reinstall from the old names to the new ones, never holding the new names before the old sandbox is gone", async () => {
    spyClose();
    const before = seedOld();
    const record = await install({ reinstall: true });
    expect(record).toMatchObject({ status: "ready", container: WIDGET, volume: WIDGET });
    expect(registry.get("widget")?.selection).toEqual(before.selection);
    expect(steps().slice(0, 6)).toEqual([
      `closeProject ${OLD}`,
      `destroy ${OLD} ${OLD}`,
      `closeProject ${WIDGET}`,
      `destroy ${WIDGET} ${WIDGET}`,
      "probe",
      `createContainer ${WIDGET}`,
    ]);
    // Until the old sandbox's removal has returned (the call after it), the record, read from disk, says installing with the old names.
    const [closeOld, destroyOld, closeNew, destroyNew, probe] = docker.trace;
    for (const t of [closeOld!, destroyOld!]) {
      expect(t.rec).toMatchObject({ status: "installing", container: OLD, volume: OLD });
    }
    for (const t of [closeNew!, destroyNew!, probe!]) {
      expect(t.rec).toMatchObject({ status: "installing", container: WIDGET, volume: WIDGET });
    }
    // At no call into the double does the record hold the new names while the old sandbox stands.
    const oldGone = docker.trace.findIndex((t) => t.call === "destroy" && t.args[0] === OLD) + 1;
    docker.trace.forEach((t, i) => expect(named(t)).toBe(i < oldGone ? OLD : WIDGET));
  });

  it("treats the two old names as two names", async () => {
    seedOld({ volume: "mcpe-widget-data" });
    spyClose();
    await install({ reinstall: true });
    expect(steps()[1]).toBe(`destroy ${OLD} mcpe-widget-data`);
  });

  it("removes the sandbox once, not twice, when the record already holds the names computed now", async () => {
    seedOld({ container: WIDGET, volume: WIDGET });
    await install({ reinstall: true });
    expect(docker.trace.filter((t) => t.call === "destroy").map((t) => t.args[0])).toEqual([WIDGET]);
  });

  it("puts the record back and rejects when that removal throws, instead of deleting the record of a project that was ready", async () => {
    spyClose();
    const before = seedOld({ container: WIDGET, volume: WIDGET, status: "ready" });
    docker.destroyFails = [1];
    await expect(install({ reinstall: true })).rejects.toThrow(/widget.*old sandbox could not be removed.*destroy failed \(call 1\).*left as it was/s);
    // The record is there, as it was, with the one warning; the sandbox was removed once, tried once, and nothing was built.
    expect(onDisk("widget")).toEqual({ ...before, warnings: [...before.warnings, OLD_WARNING] });
    expect(registry.get("widget")).toEqual({ ...before, warnings: [...before.warnings, OLD_WARNING] });
    expect(steps()).toEqual([`closeProject ${WIDGET}`, `destroy ${WIDGET} ${WIDGET}`]);
    expect(docker.created).toEqual([]);
    expect(docker.destroyed).toEqual([]);
  });

  it("does the same when closing proxied servers throws on unchanged names", async () => {
    const before = seedOld({ container: WIDGET, volume: WIDGET, status: "ready" });
    vi.spyOn(proxy, "closeProject").mockRejectedValue(new Error("close failed"));
    await expect(install({ reinstall: true })).rejects.toThrow(/old sandbox could not be removed.*close failed/s);
    expect(onDisk("widget")).toEqual({ ...before, warnings: [...before.warnings, OLD_WARNING] });
    expect(docker.trace.filter((t) => t.call === "destroy")).toEqual([]);
  });

  it("still takes today's branch for a failure after that removal, on unchanged names (no sandbox made: the record is removed)", async () => {
    seedOld({ container: WIDGET, volume: WIDGET, status: "ready" });
    docker.probeError = new Error("clone failed");
    const record = await install({ reinstall: true });
    expect(record.status).toBe("failed");
    expect(onDisk("widget")).toBeUndefined();
  });

  describe("when the old sandbox cannot be removed", () => {
    it("rejects, puts the record back as it was plus one warning, and starts nothing", async () => {
      spyClose();
      const before = seedOld({ status: "ready" });
      docker.destroyFails = [1];
      await expect(install({ reinstall: true })).rejects.toThrow(/widget.*old sandbox could not be removed.*destroy failed \(call 1\).*left as it was/s);
      expect(onDisk("widget")).toEqual({ ...before, warnings: [...before.warnings, OLD_WARNING] });
      expect(steps()).toEqual([`closeProject ${OLD}`, `destroy ${OLD} ${OLD}`]);
      expect(docker.destroyed).toEqual([]);
    });

    it("leaves exactly one copy of the warning after a second failure, and none of the error in it", async () => {
      seedOld();
      docker.destroyFails = "all";
      await expect(install({ reinstall: true })).rejects.toThrow();
      await expect(install({ reinstall: true })).rejects.toThrow();
      const warnings = onDisk("widget")!.warnings;
      expect(warnings).toEqual([OLD_WARNING]);
      expect(warnings[0]).not.toContain("destroy failed");
    });

    it("takes the same branch when closing proxied servers throws", async () => {
      const before = seedOld();
      vi.spyOn(proxy, "closeProject").mockRejectedValueOnce(new Error("close failed"));
      await expect(install({ reinstall: true })).rejects.toThrow(/close failed/);
      expect(onDisk("widget")).toEqual({ ...before, warnings: [OLD_WARNING] });
      expect(docker.trace).toEqual([]);
    });

    it("returns an error result through the tool, without the advice for a failed build", async () => {
      seedOld();
      docker.destroyFails = [1];
      const app = new App({ cfg, docker, proxy });
      try {
        const res = await app.callTool("install_project", { repo: "acme/widget", reinstall: true });
        const out = (res.content[0] as { text: string }).text;
        expect(res.isError).toBe(true);
        expect(out).toMatch(/old sandbox could not be removed.*destroy failed/s);
        expect(out).not.toContain("The sandbox was kept");
        expect(out).not.toContain("Nothing was installed");
      } finally {
        await app.shutdown();
      }
    });
  });

  describe("when the old sandbox is refused", () => {
    const another = () => refusal(part("container", OLD, "another", OTHER), part("volume", OLD, "mine"));
    const WARNING = /^The previous sandbox of this project was left in place, untouched/;

    it("leaves it alone, builds under its own names, and says what was left and whose it is", async () => {
      spyClose();
      const before = seedOld({ status: "ready" });
      docker.destroyErrors[OLD] = another();
      const record = await install({ reinstall: true });
      expect(record).toMatchObject({ status: "ready", container: WIDGET, volume: WIDGET });
      expect(registry.get("widget")).toMatchObject({ status: "ready", container: WIDGET, volume: WIDGET });
      expect(registry.get("widget")?.selection).toEqual(before.selection);
      const w = record.warnings.filter((x) => WARNING.test(x));
      expect(w).toHaveLength(1);
      expect(w[0]).toContain(`container "${OLD}" is another installation's (owner label "${OTHER}")`);
      expect(w[0]).toContain(`volume "${OLD}" is this installation's`);
      // Not removed by the filters that recompute the MCP and tool warnings.
      expect(w[0]).not.toMatch(/^(MCP|Tools): /);
      expect(onDisk("widget")!.warnings).toContain(w[0]);
      // Proxied servers on the old name were closed; only the new names were removed; the old record held the old names until then.
      expect(steps().slice(0, 4)).toEqual([`closeProject ${OLD}`, `destroy ${OLD} ${OLD}`, `closeProject ${WIDGET}`, `destroy ${WIDGET} ${WIDGET}`]);
      expect(docker.destroyed).toEqual([WIDGET]);
      expect(docker.trace.slice(0, 2).map(named)).toEqual([OLD, OLD]);
      expect(docker.trace.slice(2).every((t) => named(t) === WIDGET)).toBe(true);
    });

    it.each([
      ["a container that is not ours", refusal(part("container", OLD, "not-ours")), `container "${OLD}" was not created by mcp-everything`],
      ["only a container", refusal(part("container", OLD, "another", OTHER)), `container "${OLD}" is another installation's`],
      ["a volume that was made before ownership", refusal(part("container", OLD, "not-ours"), part("volume", OLD, "before")), `volume "${OLD}" was made before ownership was recorded`],
      [
        "an owner label with a line break and excessive length",
        refusal(part("container", OLD, "another", `ab\ncd${"x".repeat(200)}`)),
        'owner label "ab cdxxxxxxxx',
      ],
      [
        "an owner label cut to the length every message uses",
        refusal(part("container", OLD, "another", "x".repeat(300))),
        `owner label "${"x".repeat(OWNER_SHOWN - 1)}…"`,
      ],
    ])("words the warning from the facts: %s", async (_n, refused, expected) => {
      seedOld();
      docker.destroyErrors[OLD] = refused;
      const record = await install({ reinstall: true });
      const w = record.warnings.find((x) => WARNING.test(x))!;
      expect(w).toContain(expected);
      expect(w).not.toContain("\n");
      expect(w.length).toBeLessThan(400);
    });

    it("carries the warning on the failed record when the build then fails once a container exists", async () => {
      seedOld();
      docker.destroyErrors[OLD] = another();
      docker.recipe = () => ({ code: 1 });
      const record = await install({ reinstall: true });
      expect(record.status).toBe("failed");
      expect(record.warnings.filter((x) => WARNING.test(x))).toHaveLength(1);
      expect(onDisk("widget")).toMatchObject({ status: "failed", container: WIDGET });
      expect(onDisk("widget")!.warnings.filter((x) => WARNING.test(x))).toHaveLength(1);
    });

    it("deletes the record, as for any install that fails before a container exists, and the returned record carries the warning", async () => {
      seedOld();
      docker.destroyErrors[OLD] = another();
      docker.probeError = new Error("clone failed: not found");
      const record = await install({ reinstall: true });
      expect(record).toMatchObject({ status: "failed", error: "clone failed: not found" });
      expect(record.warnings.filter((x) => WARNING.test(x))).toHaveLength(1);
      expect(onDisk("widget")).toBeUndefined();
      expect(docker.created).toEqual([]);
    });

    it("does the same when what is at the new names is refused too, and touches neither", async () => {
      seedOld();
      docker.destroyErrors[OLD] = another();
      docker.destroyErrors[WIDGET] = refusal(part("container", WIDGET, "not-ours"));
      const record = await install({ reinstall: true });
      expect(record.status).toBe("failed");
      expect(record.error).toContain(`container "${WIDGET}" was not created by mcp-everything`);
      expect(record.warnings.filter((x) => WARNING.test(x))).toHaveLength(1);
      expect(onDisk("widget")).toBeUndefined();
      expect(docker.created).toEqual([]);
      expect(docker.destroyed).toEqual([]);
    });

    it("lets any other failure of the old sandbox's removal take leg 3's path: the record is put back and the install fails", async () => {
      const before = seedOld({ status: "ready" });
      docker.destroyErrors[OLD] = new DockerUnavailableError("Docker could not be asked");
      await expect(install({ reinstall: true })).rejects.toThrow(/old sandbox could not be removed.*Docker could not be asked.*left as it was/s);
      expect(onDisk("widget")).toEqual({ ...before, warnings: [OLD_WARNING] });
      expect(docker.created).toEqual([]);
    });
  });

  describe("when the name this install needs is held by a sandbox that is not this installation's", () => {
    const held = () => refusal(part("container", WIDGET, "not-ours"), part("volume", WIDGET, "mine"));

    it("puts the record back, and both the error and the warning say to remove or rename it by hand", async () => {
      const before = seedOld({ container: WIDGET, volume: WIDGET, status: "ready" });
      docker.destroyErrors[WIDGET] = held();
      const error = await install({ reinstall: true }).then(() => null, (e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      const stored = onDisk("widget")!;
      expect(stored).toEqual({ ...before, warnings: [stored.warnings[0]] });
      for (const text of [error!.message, stored.warnings[0]!]) {
        expect(text).toContain("held by a sandbox that is not this installation's");
        expect(text).toContain(`container "${WIDGET}" was not created by mcp-everything`);
        expect(text).toContain(`volume "${WIDGET}" is this installation's`);
        expect(text).toMatch(/removed or renamed by hand in Docker|Remove or rename it by hand in Docker/);
        expect(text).not.toMatch(/reinstall again to retry/i);
        expect(text).not.toMatch(/partly removed/i);
      }
      expect(error!.message).toContain("left as it was");
      expect(docker.created).toEqual([]);
      expect(docker.destroyed).toEqual([]);
    });

    it("leaves one copy of the warning after a second attempt", async () => {
      seedOld({ container: WIDGET, volume: WIDGET });
      docker.destroyErrors[WIDGET] = held();
      await expect(install({ reinstall: true })).rejects.toThrow();
      await expect(install({ reinstall: true })).rejects.toThrow();
      expect(onDisk("widget")!.warnings).toHaveLength(1);
    });

    it("keeps leg 3's warning and error for a plain failure and for 'Docker could not be asked' on unchanged names", async () => {
      for (const failure of [new Error("rm failed"), new DockerUnavailableError("Docker could not be asked")]) {
        registry.delete("widget");
        const before = seedOld({ container: WIDGET, volume: WIDGET, status: "ready" });
        docker.destroyErrors[WIDGET] = failure;
        await expect(install({ reinstall: true })).rejects.toThrow(new RegExp(`old sandbox could not be removed \\(${failure.message}\\)`));
        expect(onDisk("widget")).toEqual({ ...before, warnings: [OLD_WARNING] });
      }
    });
  });

  describe("failures after the record took the new names", () => {
    it("removes what is at the new names and deletes the record when the clone fails", async () => {
      seedOld();
      docker.probeError = new Error("clone failed: not found");
      const record = await install({ reinstall: true });
      expect(record).toMatchObject({ status: "failed", container: WIDGET });
      expect(registry.get("widget")).toBeUndefined();
      expect(docker.destroyed).toEqual([OLD, WIDGET, WIDGET]);
    });

    it("takes the sandbox offline and keeps the record as failed, with the new names, once a container exists", async () => {
      seedOld();
      docker.recipe = () => ({ code: 1 });
      const record = await install({ reinstall: true });
      expect(record.status).toBe("failed");
      expect(onDisk("widget")).toMatchObject({ status: "failed", container: WIDGET, volume: WIDGET, network: false });
      expect(docker.network).toEqual([[WIDGET, false]]);
    });
  });

  it.each(["failed", "installing"] as const)("takes the same path over a %s record without reinstall", async (status) => {
    spyClose();
    seedOld({ status, error: status === "failed" ? "boom" : undefined });
    const record = await install();
    expect(record).toMatchObject({ status: "ready", container: WIDGET });
    expect(steps().slice(0, 4)).toEqual([`closeProject ${OLD}`, `destroy ${OLD} ${OLD}`, `closeProject ${WIDGET}`, `destroy ${WIDGET} ${WIDGET}`]);
  });

  it("leaves a record with old names alone when it is not reinstalled", async () => {
    const before = seedOld();
    expect((await install()).container).toBe(OLD);
    expect(docker.trace).toEqual([]);
    expect(registry.get("widget")).toEqual(before);
  });
});

describe("the reference of one operation", () => {
  const FALLBACK_RANGE = { engines: { node: "^22.23.4 || ^24.22.1 || >=26.12.1" } };
  const ref = (c: { sandbox?: SandboxRef }) => c.sandbox?.id;

  describe("an install", () => {
    it("runs the recipe, the network setting and the whole discovery on the reference createContainer returned", async () => {
      docker.repoFiles = { "package.json": pkg({}) };
      const record = await install();
      expect(record.status).toBe("ready");
      expect(docker.created).toHaveLength(1);
      const id = docker.created[0]!.id;
      expect(docker.calls.length).toBeGreaterThan(5); // the recipe and a discovery, not an empty set
      expect(docker.calls.map(ref)).toEqual(docker.calls.map(() => id));
      expect(docker.network).toEqual([[WIDGET, false]]);
      expect(docker.networkRefs[0]).toBe(docker.created[0]);
      // Nothing resolved the name again: no acquire, no ensureRunning.
      expect(docker.ensureCalls).toEqual([]);
    });

    it("runs the clean step, the second recipe, the network setting and the discovery on the second reference after a rebuild, and only the first recipe on the first", async () => {
      docker.repoFiles = { "package.json": pkg(FALLBACK_RANGE) };
      docker.recipe = (image) => (image === "node:26" ? SOFT_FAIL : { stdout: "built\n" });
      const record = await install();
      expect(record.image).toBe("node:24");
      expect(docker.created).toHaveLength(2);
      const [first, second] = docker.created;
      expect(first!.id).not.toBe(second!.id);
      const kind = (c: { argv: string[] }) => (c.argv[2]?.includes("soft_fail()") ? "recipe" : c.argv[2]?.includes("git clean") ? "clean" : "other");
      const onFirst = docker.calls.filter((c) => ref(c) === first!.id).map(kind);
      expect(onFirst).toEqual(["recipe"]);
      const rest = docker.calls.filter((c) => ref(c) !== first!.id);
      expect(rest.map(ref)).toEqual(rest.map(() => second!.id));
      expect(rest.slice(0, 2).map(kind)).toEqual(["clean", "recipe"]);
      expect(rest.length).toBeGreaterThan(5); // and the discovery that follows
      expect(docker.networkRefs[0]).toBe(second);
    });
  });

  describe("an operation on an installed project", () => {
    let project: ProjectRecord;
    beforeEach(async () => {
      docker.repoFiles = { "package.json": pkg({}) };
      project = await install();
      expect(project.status).toBe("ready");
      docker.calls = [];
      docker.ensureCalls = [];
      docker.acquired = [];
    });

    const acquiredOnce = () => {
      expect(docker.ensureCalls).toEqual([WIDGET]);
      expect(docker.acquired).toHaveLength(1);
      expect(docker.calls.length).toBeGreaterThan(3);
      expect(docker.calls.every((c) => c.sandbox === docker.acquired[0])).toBe(true);
    };

    it("rediscover checks once and runs every command of the discovery on that reference", async () => {
      await installer.rediscover(registry.get("widget")!, []);
      acquiredOnce();
    });

    it("refreshMcp checks once and runs every command of the discovery on that reference", async () => {
      await installer.refreshMcp(registry.get("widget")!);
      acquiredOnce();
    });

    it("connectMcp and disconnectMcp: the check of the operation is the first, and every command runs on it", async () => {
      up.answer = true;
      await installer.connectMcp(registry.get("widget")!, { name: "srv", argv: ["node", "s.js"], cwd: "/workspace/repo", env: {}, origin: "registered" });
      // The second check is the proxied session being opened, by name; it runs no command.
      expect(docker.ensureCalls).toEqual([WIDGET, WIDGET]);
      expect(docker.calls.length).toBeGreaterThan(3);
      expect(docker.calls.every((c) => c.sandbox === docker.acquired[0])).toBe(true);

      const session = docker.acquired[1]; // the reference the open session was launched with
      docker.calls = [];
      docker.ensureCalls = [];
      docker.acquired = [];
      await installer.disconnectMcp(registry.get("widget")!, "srv");
      // Closing the session kills its server on the reference that session holds; everything else is this operation's.
      const isKill = (c: { argv: string[] }) => c.argv[2]?.includes("kill") === true;
      expect(docker.calls.filter(isKill).map((c) => c.sandbox)).toEqual([session]);
      docker.calls = docker.calls.filter((c) => !isKill(c));
      acquiredOnce();
    });

    it.each([
      ["rediscover", () => installer.rediscover(registry.get("widget")!, [])],
      ["refreshMcp", () => installer.refreshMcp(registry.get("widget")!)],
      ["connectMcp", () => installer.connectMcp(registry.get("widget")!, { name: "srv", argv: ["srv"], cwd: "/workspace/repo", env: {}, origin: "registered" })],
    ] as const)("%s: a sandbox that is not there still says so, and runs nothing", async (_n, call) => {
      docker.exists = false;
      await expect(call()).rejects.toThrow(/Sandbox for widget no longer exists; reinstall it with install_project\(reinstall: true\)\./);
      expect(docker.calls).toEqual([]);
    });

    it("rediscover lets a refusal or an unanswered Docker rise as itself", async () => {
      docker.acquireError = new DockerUnavailableError("Docker could not be asked: down");
      await expect(installer.rediscover(registry.get("widget")!, [])).rejects.toThrow("Docker could not be asked: down");
      expect(docker.calls).toEqual([]);
    });
  });
});

describe("what a refusal does to each operation", () => {
  const OLD = "mcpe-widget";
  const seedReady = (over: Partial<ProjectRecord> = {}): ProjectRecord => {
    const r: ProjectRecord = { ...seedRecord("widget", "acme/widget"), ...over };
    registry.put(r);
    return r;
  };

  describe("uninstall", () => {
    it("lets go of a sandbox the guard refuses: the record is deleted, nothing is destroyed, and the facts come back", async () => {
      const r = seedReady();
      const facts = [part("container", OLD, "another", OTHER), part("volume", OLD, "mine")];
      docker.destroyErrors[OLD] = refusal(...facts);
      const closed = vi.spyOn(proxy, "closeProject");
      expect(await installer.uninstall(r)).toEqual(facts);
      expect(closed).toHaveBeenCalledWith(OLD);
      expect(registry.get("widget")).toBeUndefined();
      expect(onDisk("widget")).toBeUndefined();
      expect(docker.destroyed).toEqual([]);
    });

    it("returns nothing when the sandbox was removed", async () => {
      const r = seedReady();
      expect(await installer.uninstall(r)).toEqual([]);
      expect(docker.destroyed).toEqual([OLD]);
      expect(registry.get("widget")).toBeUndefined();
    });

    it.each([
      ["Docker could not be asked", new DockerUnavailableError("Docker could not be asked")],
      ["a plain error from the removal", new Error("Failed to remove container mcpe-widget: busy")],
    ])("fails and keeps the record for %s", async (_n, failure) => {
      const r = seedReady();
      docker.destroyErrors[OLD] = failure;
      await expect(installer.uninstall(r)).rejects.toBe(failure);
      expect(registry.get("widget")).toEqual(r);
      expect(onDisk("widget")).toEqual(r);
    });
  });

  describe("discovery", () => {
    const argvMatches: Array<[string, (argv: string[]) => boolean]> = [
      ["the python probe", (a) => a[0]!.endsWith("/bin/python")],
      ["the node check", (a) => a[0] === "sh" && a[2]!.includes("command -v node")],
      ["the node probe", (a) => a[0] === "node"],
      ["the bin listing", (a) => a[0] === "ls"],
      ["the alias fold", (a) => a[0] === "sh" && a[2]!.includes("readlink")],
      ["a manifest read", (a) => a[0] === "head"],
      ["the root help of a command (fetchHelp)", (a) => a[0] === "tool" && a[1] === "--help"],
      ["a subcommand's help (fetchHelp)", (a) => a[0] === "tool" && a[1] === "run"],
      ["the scratch directory", (a) => a[0] === "mkdir"],
    ];
    const unavailable = () => new DockerUnavailableError("Docker could not be asked");
    let ready: ProjectRecord;
    beforeEach(async () => {
      docker.repoFiles = { "package.json": pkg({}) };
      ready = await install();
      expect(ready.status).toBe("ready");
      expect(ready.commands.length).toBeGreaterThan(0);
    });

    it.each(argvMatches)("ends the discovery with the error, and rewrites nothing, when %s could not be asked", async (_n, matches) => {
      docker.execError = (argv) => (matches(argv) ? unavailable() : undefined);
      const stored = structuredClone(registry.get("widget")!);
      const error = await installer.rediscover(stored, []).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(DockerUnavailableError);
      expect(registry.get("widget")).toEqual(stored);
      expect(onDisk("widget")).toEqual(stored);
    });

    it("writes nothing to the record it was given, even a live one, when a late command could not be asked", async () => {
      // The callers work on a copy; this pins the discovery's own promise, which an install's live record relies on.
      docker.execError = (argv) => (argv[0] === "tool" && argv[1] === "run" ? unavailable() : undefined);
      // Different from what a discovery would write, so that a write would show.
      const live: ProjectRecord = { ...structuredClone(registry.get("widget")!), commands: [], tools: [], published: [] };
      const snapshot = structuredClone(live);
      const discover = (installer as unknown as { discover: (r: ProjectRecord, s: SandboxRef, extra: string[]) => Promise<unknown> }).discover.bind(installer);
      await expect(discover(live, docker.created[0]!, [])).rejects.toBeInstanceOf(DockerUnavailableError);
      expect(live).toEqual(snapshot);
    });

    it("also ends refresh_mcp, without the 'no commands' warning or a rewrite", async () => {
      docker.execError = (argv) => (argv[0] === "ls" ? unavailable() : undefined);
      const stored = structuredClone(registry.get("widget")!);
      await expect(installer.refreshMcp(stored)).rejects.toBeInstanceOf(DockerUnavailableError);
      expect(registry.get("widget")).toEqual(stored);
    });

    it("does not call an executable that the caller vouched for missing when Docker could not be asked", async () => {
      docker.execError = (argv) => (argv[0] === "sh" && argv[2]!.includes('command -v "$1"') ? unavailable() : undefined);
      const stored = structuredClone(registry.get("widget")!);
      const error = await installer.rediscover(stored, ["tool"]).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(DockerUnavailableError);
      expect(registry.get("widget")).toEqual(stored);
    });

    it("keeps a registered command only when it exists, and still ends the discovery when that question could not be asked", async () => {
      const withRegistered = { ...structuredClone(registry.get("widget")!), commands: [{ name: "mine", origin: "registered" }] };
      registry.put(withRegistered);
      docker.execError = (argv) => (argv[0] === "sh" && argv[2]!.includes('command -v "$1"') ? unavailable() : undefined);
      await expect(installer.rediscover(withRegistered, [])).rejects.toBeInstanceOf(DockerUnavailableError);
      expect(registry.get("widget")).toEqual(withRegistered);
    });

    it("still reads a command that merely fails as it does today: the discovery completes", async () => {
      docker.execError = (argv) => (argv[0] === "ls" ? new Error("exec failed") : undefined);
      const record = await installer.rediscover(structuredClone(registry.get("widget")!), []);
      expect(record.status).toBe("ready");
    });

    it("ends an install with the error as its failed record, not as a project with no commands", async () => {
      registry.delete("widget");
      docker.execError = (argv) => (argv[0] === "ls" ? unavailable() : undefined);
      const record = await install();
      expect(record).toMatchObject({ status: "failed", error: "Docker could not be asked" });
      expect(onDisk("widget")).toMatchObject({ status: "failed" });
      expect(record.warnings.join("\n")).not.toContain("No executables");
    });
  });

  describe("opening a proxied server during discovery", () => {
    const registered = { name: "reg", argv: ["tool", "mcp"], cwd: "/workspace/repo", env: {}, origin: "registered" as const };
    const errors: Array<[string, () => Error]> = [
      ["a refusal", () => refusal(part("container", WIDGET, "another", OTHER))],
      ["'Docker could not be asked'", () => new DockerUnavailableError("Docker could not be asked")],
    ];
    beforeEach(() => {
      docker.repoFiles = { "package.json": pkg({}) };
      up.answer = true;
      up.answerIf = (launch) => launch.server.argv.join(" ") === "tool";
    });

    /** The first check of a refresh is the operation's own; the proxy's opening of a session is the second. */
    const failSecondAcquire = (error: Error) => {
      const real = docker.acquire.bind(docker);
      let n = 0;
      vi.spyOn(docker, "acquire").mockImplementation(async (name) => {
        if (++n >= 2) throw error;
        return real(name);
      });
    };

    it.each(errors)("ends the install of a detected server's probe with %s as the failed record's error, not an MCP warning", async (_n, make) => {
      docker.sdkBins = ["tool"];
      const error = make();
      docker.acquireError = error;
      const record = await install();
      expect(record).toMatchObject({ status: "failed", error: error.message });
      expect(record.warnings.filter((w) => w.startsWith("MCP:"))).toEqual([]);
      expect(record.mcpServers).toBeUndefined(); // discovery did not finish
    });

    it.each(errors)("ends a refresh over a detected server's probe with %s and rewrites nothing", async (_n, make) => {
      docker.sdkBins = ["tool"];
      const ready = await install();
      expect(ready.status).toBe("ready");
      const stored = structuredClone(registry.get("widget")!);
      const error = make();
      failSecondAcquire(error);
      await expect(installer.refreshMcp(stored)).rejects.toBe(error);
      expect(registry.get("widget")).toEqual(stored);
      expect(onDisk("widget")).toEqual(stored);
    });

    it.each(errors)("ends a refresh over a registered server with %s and rewrites nothing", async (_n, make) => {
      const ready = await install();
      const withServer = { ...structuredClone(ready), mcpServers: [registered] };
      registry.put(withServer);
      const error = make();
      failSecondAcquire(error);
      await expect(installer.refreshMcp(structuredClone(withServer))).rejects.toBe(error);
      expect(registry.get("widget")).toEqual(withServer);
    });

    it("still turns a failed handshake into the warning it always was", async () => {
      docker.sdkBins = ["tool"];
      // A launch that fails at once, so that no handshake has to time out.
      installer = new Installer(cfg, docker, registry, new McpProxy(cfg, docker, () => { throw new Error("spawn failed"); }));
      const record = await install();
      expect(record.status).toBe("ready");
      expect(record.warnings.filter((w) => w.startsWith("MCP:"))).toHaveLength(1);
    });
  });

  describe("taking a sandbox off the network", () => {
    it("an install does it through the reference it holds", async () => {
      docker.repoFiles = { "package.json": pkg({}) };
      docker.recipe = () => ({ code: 1 });
      await install({ network: true });
      expect(docker.networkRefs).toEqual([docker.created[0]]);
    });

    it("an install whose build fails after the setting still does, on the reference", async () => {
      docker.repoFiles = { "package.json": pkg({}) };
      (installer as unknown as { discover: () => Promise<void> }).discover = async () => {
        throw new Error("discovery lost the daemon");
      };
      await install({ network: true });
      expect(docker.networkRefs).toEqual([docker.created[0], docker.created[0]]);
      expect(docker.network.map((n) => n[1])).toEqual([true, false]);
    });

    describe("the startup reconciliation", () => {
      const NOW = Date.parse("2026-11-16T12:00:00.000Z");
      const seedStale = (): ProjectRecord => {
        const r = {
          ...seedRecord("x"),
          status: "installing" as const,
          network: true,
          installedAt: new Date(NOW - staleInstallLimitSec(cfg) * 1000 - 1000).toISOString(),
        };
        registry.put(r);
        return r;
      };

      it.each([
        ["another installation's", refusal(part("container", "mcpe-x", "another", OTHER)), `container "mcpe-x" is another installation's (owner label "${OTHER}")`],
        ["not created by mcp-everything", refusal(part("container", "mcpe-x", "not-ours")), 'container "mcpe-x" was not created by mcp-everything'],
      ])("marks the install failed, leaves network as it was, and says the sandbox is %s and was left alone", async (_n, refused, expected) => {
        seedStale();
        docker.setNetworkError = refused;
        expect(await installer.reconcileStale(NOW)).toEqual(["x"]);
        const stored = registry.get("x")!;
        expect(stored).toMatchObject({ status: "failed", network: true });
        expect(stored.error).toMatch(/^Install was interrupted/);
        expect(stored.warnings).toHaveLength(1);
        expect(stored.warnings[0]).toContain("not this installation's");
        expect(stored.warnings[0]).toContain("left alone");
        expect(stored.warnings[0]).toContain(expected);
        expect(stored.warnings.join("\n")).not.toContain("may still be online");
      });

      it("leaves a network that was off as off, with the same words", async () => {
        const r = seedStale();
        registry.put({ ...r, network: false });
        docker.setNetworkError = refusal(part("container", "mcpe-x", "not-ours"));
        await installer.reconcileStale(NOW);
        expect(registry.get("x")).toMatchObject({ status: "failed", network: false });
        expect(registry.get("x")!.warnings.join("\n")).not.toContain("may still be online");
      });

      it("behaves as before when Docker could not be asked: network on, the 'may still be online' warning", async () => {
        seedStale();
        docker.setNetworkError = new DockerUnavailableError("Docker could not be asked");
        expect(await installer.reconcileStale(NOW)).toEqual(["x"]);
        const stored = registry.get("x")!;
        expect(stored).toMatchObject({ status: "failed", network: true });
        expect(stored.warnings).toHaveLength(1);
        expect(stored.warnings[0]).toContain("may still be online");
        expect(stored.warnings[0]).toContain("Docker could not be asked");
      });
    });
  });
});
