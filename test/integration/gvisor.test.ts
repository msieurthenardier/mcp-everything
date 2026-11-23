import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { parseRepoRef } from "../../src/forge/repo-ref.js";
import { Registry } from "../../src/registry.js";
import { Docker } from "../../src/sandbox/docker.js";
import type { SandboxRef } from "../../src/sandbox/docker-base.js";
import { RuntimeMismatchError } from "../../src/sandbox/errors.js";
import { App } from "../../src/server.js";
import type { ProjectRecord } from "../../src/types.js";
import { run, type RunResult } from "../../src/util/exec.js";
import { record } from "../helpers.js";

/**
 * The isolation runtime, proven end to end (flight 02, leg 12). Enabled only with MCPE_DOCKER_TESTS=1 and
 * MCPE_DOCKER_RUNTIME=runsc, so it reports itself skipped everywhere else (Docker Desktop with no runtime named, and the
 * unit suite). The `docker-gvisor` job runs it as its own step, after the rest of the Docker suite has run under the runtime.
 *
 * It follows the Docker suite's guard rules, with its own copies of the helpers (importing docker.test.ts would register
 * that file's suites here): a random owner id for each Docker layer, names under `mcpe-it-<pid>-gv-`, every removal through
 * one name check and found by the owner label, and a temporary data directory of its own.
 */
const RUNTIME = "runsc";
const enabled = process.env.MCPE_DOCKER_TESTS === "1" && process.env.MCPE_DOCKER_RUNTIME === RUNTIME;
const prefix = `mcpe-it-${process.pid}-gv-`;
const text = (res: Awaited<ReturnType<App["callTool"]>>) => (res.content[0] as { text: string }).text;

/** `alpine`, the same pinned reference as `ALPINE` in docker.test.ts (the trivial scanner's image); bump the two together. */
const ALPINE = "alpine:3.24.4@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf";
const EMPTY_SARIF = JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "trivial" } }, results: [] }] });

/** The one check every removal goes through: a name under this describe's prefix, with something after it. */
function checkedForRemoval(name: string): string {
  if (typeof name !== "string" || !/^[a-z0-9][a-z0-9_.-]*$/.test(name) || !name.startsWith(prefix) || name.length <= prefix.length) {
    throw new Error(`refusing to remove ${JSON.stringify(name)}: not an object this describe made`);
  }
  return name;
}

/**
 * Real Docker that records every container it creates: on each successful `create` or `run`, the id is taken from stdout and
 * its HostConfig.Runtime is inspected at once, before the container starts, while even a one-shot still exists.
 */
class Recording extends Docker {
  readonly created: { role: string; id: string; runtime: string; argv: string[] }[] = [];
  readonly stateAfterCreate: string[] = [];
  readonly stateBeforeStart: string[] = [];

  protected override async docker(args: string[], opts: Parameters<typeof run>[2] = {}): Promise<RunResult> {
    const res = await super.docker(args, opts);
    if ((args[0] === "create" || args[0] === "run") && res.code === 0) {
      const id = res.stdout.trim().split("\n").pop()?.trim() ?? "";
      const at = args.findIndex((a) => a.startsWith("mcp-everything.role="));
      const role = at >= 0 ? args[at]!.slice("mcp-everything.role=".length) : "sandbox";
      if (/^[0-9a-f]{64}$/.test(id)) {
        const seen = await super.docker(["inspect", "--type", "container", "--format", "{{.HostConfig.Runtime}}", id], { timeoutMs: 30_000 });
        this.created.push({ role, id, runtime: seen.stdout.trim(), argv: [...args] });
      } else {
        this.created.push({ role, id: `unreadable: ${JSON.stringify(res.stdout.slice(0, 80))}`, runtime: "", argv: [...args] });
      }
    }
    return res;
  }

  override async createContainer(opts: Parameters<Docker["createContainer"]>[0]): Promise<SandboxRef> {
    const ref = await super.createContainer(opts);
    this.stateAfterCreate.push(await this.networkState(ref.name));
    return ref;
  }

  override async startForContainment(name: string): Promise<SandboxRef | undefined> {
    this.stateBeforeStart.push(await this.networkState(name));
    return super.startForContainment(name);
  }
}

describe.skipIf(!enabled)("docker integration under gVisor (leg 12)", () => {
  // Named here, made in `beforeAll`: a skipped describe still runs this body, and must leave nothing behind.
  const dataDir = path.join(os.tmpdir(), `mcpe-it-gv-${randomBytes(4).toString("hex")}`);
  beforeAll(() => {
    fs.mkdirSync(dataDir, { recursive: true });
  });
  const ids: string[] = [];
  const newId = (): string => {
    const id = randomBytes(4).toString("hex");
    ids.push(id);
    return id;
  };
  const baseEnv = (): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const k of ["MCPE_SCAN_BLOCK_AT", "MCPE_SCAN_TIMEOUT", "MCPE_SCANNERS"]) delete env[k];
    return {
      ...env,
      MCPE_NAME_PREFIX: prefix,
      MCPE_SANDBOX_IDLE_TIMEOUT: "0",
      MCPE_NETWORK: "contained",
      MCPE_DATA_DIR: dataDir,
      MCPE_LOCAL_ACCESS: "",
      MCPE_SCAN: "off",
    };
  };
  const lines = async (args: string[]) => (await run("docker", args, { timeoutMs: 60_000 })).stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const remainingOf = async (id: string) => {
    const owned = `label=mcp-everything.owner=${id}`;
    return {
      containers: (await lines(["ps", "-a", "--filter", owned, "--format", "{{.Names}}"])).sort(),
      networks: (await lines(["network", "ls", "--filter", owned, "--format", "{{.Name}}"])).sort(),
      volumes: (await lines(["volume", "ls", "--filter", owned, "--format", "{{.Name}}"])).sort(),
    };
  };
  const NONE = { containers: [], networks: [], volumes: [] };
  const sweepOwn = async () => {
    for (const id of ids) {
      const left = await remainingOf(id);
      for (const n of left.containers) await run("docker", ["rm", "-f", "-v", checkedForRemoval(n)], { timeoutMs: 120_000 });
      for (const n of left.networks) await run("docker", ["network", "rm", checkedForRemoval(n)], { timeoutMs: 120_000 });
      for (const n of left.volumes) await run("docker", ["volume", "rm", checkedForRemoval(n)], { timeoutMs: 120_000 });
    }
    try {
      const r = new Registry(dataDir);
      r.refresh();
      for (const p of r.list()) r.delete(p.slug);
    } catch {
      // no registry yet
    }
  };
  const networksOf = async (name: string) =>
    (await lines(["inspect", "--format", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}}\n{{end}}", checkedForRemoval(name)])).sort();

  afterAll(async () => {
    await sweepOwn();
    if (path.basename(dataDir).startsWith("mcpe-it-gv-") && path.dirname(dataDir) === path.resolve(os.tmpdir())) fs.rmSync(dataDir, { recursive: true, force: true });
  }, 300_000);

  it("every container mcp-everything starts runs under the named runtime: a contained, scanned install of tomnomnom/gron with the network on", async () => {
    const id = newId();
    const scanners = path.join(dataDir, "scanners.json");
    fs.writeFileSync(scanners, JSON.stringify({ scanners: [{ name: "trivial", image: ALPINE, command: ["sh", "-c", `printf '%s' '${EMPTY_SARIF}'`], timeout_seconds: 60 }] }));
    const cfg = loadConfig({ ...baseEnv(), MCPE_DOCKER_RUNTIME: RUNTIME, MCPE_SCAN: "warn", MCPE_SCANNERS: scanners });
    expect(cfg.docker.runtime).toBe(RUNTIME);
    const docker = new Recording(cfg, id);
    const app = new App({ cfg, docker });
    const since = Math.floor(Date.now() / 1000) - 2;
    try {
      const res = await app.callTool("install_project", { repo: "tomnomnom/gron", network: true });
      expect(res.isError, text(res)).toBe(false);
      app.registry.refresh();
      const rec = app.registry.get("gron")!;
      expect(rec.status, `${rec.error ?? ""}`).toBe("ready");
      expect(rec.network).toBe(true);
      expect(rec.scan, "the operator scanner ran").toBeDefined();

      // The roles seen: every kind of container the install makes (the sandbox has no role label).
      const roles = new Set(docker.created.map((c) => c.role));
      for (const want of ["clone", "resolv-read", "oneshot-proxy", "runtime-check", "scan", "copy", "sandbox", "project-proxy"]) {
        expect(roles.has(want), `a ${want} container was made (seen: ${[...roles].sort().join(", ")})`).toBe(true);
      }
      // Each one's runtime, read at creation, and the flag in the command that made it.
      for (const c of docker.created) {
        expect(c.id, `the id of a ${c.role} container`).toMatch(/^[0-9a-f]{64}$/);
        expect(c.runtime, `HostConfig.Runtime of a ${c.role} container`).toBe(RUNTIME);
        const at = c.argv.indexOf("--runtime");
        expect(at, `--runtime in the ${c.role} container's command`).toBeGreaterThanOrEqual(0);
        expect(c.argv[at + 1]).toBe(RUNTIME);
      }
      // Completeness: the daemon's create events for this installation match what was recorded.
      const until = Math.floor(Date.now() / 1000) + 1;
      const events = await run(
        "docker",
        ["events", "--since", String(since), "--until", String(until), "--filter", "type=container", "--filter", "event=create", "--filter", `label=mcp-everything.owner=${id}`, "--format", "{{.Actor.ID}}"],
        { timeoutMs: 120_000 },
      );
      expect(events.code, events.stderr).toBe(0);
      const eventIds = events.stdout.split("\n").map((l) => l.trim()).filter(Boolean).sort();
      expect(eventIds).toEqual(docker.created.map((c) => c.id).sort());

      // The create, contain, start sequence on native Linux (leg 8, resolution 16), then the sandbox runs contained.
      expect(docker.stateAfterCreate).toEqual(["open"]);
      expect(docker.stateBeforeStart).toEqual(["contained"]);
      expect(await docker.networkState(rec.container)).toBe("contained");
      expect(await networksOf(rec.container)).toEqual([`${rec.container}-net`]);

      // Inside the sandbox the kernel is gVisor's.
      const dmesg = await docker.exec(rec.container, ["sh", "-c", "dmesg"], { timeoutSec: 60 });
      console.log(`gvisor evidence dmesg (sandbox): exit ${dmesg.code}: ${`${dmesg.stdout}${dmesg.stderr}`.trim().split("\n")[0] ?? ""}`);
      expect(`${dmesg.stdout}${dmesg.stderr}`, "dmesg in the sandbox").toMatch(/gvisor/i);
    } finally {
      await app.shutdown();
      await sweepOwn();
    }
    expect(await remainingOf(id)).toEqual(NONE);
  }, 1_200_000);

  it("a missing runtime refuses before anything is created: check_project names DD11's message, and nothing of this owner exists", async () => {
    const id = newId();
    const cfg = loadConfig({ ...baseEnv(), MCPE_DOCKER_RUNTIME: "mcpe-no-such-runtime" });
    const app = new App({ cfg, docker: new Docker(cfg, id) });
    try {
      let message: string;
      try {
        const res = await app.callTool("check_project", { repo: "tomnomnom/gron" });
        expect(res.isError, text(res)).toBe(true);
        message = text(res);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("MCPE_DOCKER_RUNTIME names mcpe-no-such-runtime, but Docker cannot run containers with it");
      expect(await remainingOf(id)).toEqual(NONE);
    } finally {
      await app.shutdown();
      await sweepOwn();
    }
  }, 300_000);

  it("a sandbox made under runc is refused under runsc (reinstall), and set_project_network(false) on it still works", async () => {
    const id = newId();
    const runcCfg = loadConfig({ ...baseEnv(), MCPE_DOCKER_RUNTIME: "" });
    expect(runcCfg.docker.runtime).toBeUndefined();
    const runscCfg = loadConfig({ ...baseEnv(), MCPE_DOCKER_RUNTIME: RUNTIME });
    const runcDocker = new Docker(runcCfg, id);
    const runscDocker = new Docker(runscCfg, id);
    const app = new App({ cfg: runscCfg, docker: runscDocker });
    try {
      const slug = `gv${randomBytes(4).toString("hex")}`;
      const name = runcDocker.sandboxName(slug);
      checkedForRemoval(name);
      const repo = parseRepoRef(`github:o/${slug}`, runcCfg.hosts);
      await runcDocker.createSandboxVolume(name);
      await runcDocker.createContainer({ name, volume: name, image: runcCfg.docker.proxyImage, project: repo.id, start: false });
      await runcDocker.startForContainment(name);
      app.registry.put({ ...record(slug), container: name, volume: name, ecosystems: ["generic"], repo, network: true } as ProjectRecord);
      const made = await lines(["inspect", "--type", "container", "--format", "{{.HostConfig.Runtime}}", name]);
      expect(made[0], "the sandbox was made under the daemon's default runtime").not.toBe(RUNTIME);
      expect(await networksOf(name)).toEqual(["bridge"]);

      const refused = await runscDocker.acquire(name).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(refused).toBeInstanceOf(RuntimeMismatchError);
      expect((refused as Error).message).toMatch(/reinstall/i);

      const off = await app.callTool("set_project_network", { project: slug, enabled: false });
      expect(off.isError, text(off)).toBe(false);
      app.registry.refresh();
      expect(app.registry.get(slug)!.network).toBe(false);
      expect(await networksOf(name)).toEqual([]);
    } finally {
      await app.shutdown();
      await sweepOwn();
    }
    expect(await remainingOf(id)).toEqual(NONE);
  }, 300_000);
});
