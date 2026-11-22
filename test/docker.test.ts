import { describe, expect, it, vi, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";
import { TEST_INSTALLATION_ID } from "./helpers.js";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunOptions } from "../src/util/exec.js";
import {
  classifySandbox,
  Docker,
  DockerUnavailableError,
  isStoppedExecFailure,
  MANIFESTS,
  OWNER_SHOWN,
  parseProbeOutput,
  PROBE_SCRIPT,
  WALK_SCRIPT,
  WALK_SEPARATOR,
  walkArguments,
  SandboxRefusedError,
  VolumeNotUsableError,
  watchdogPollSec,
  type ExecResult,
  type OneShotSpec,
  type SandboxClass,
} from "../src/sandbox/docker.js";

type Reply = Partial<ExecResult>;
const reply = (r: Reply): ExecResult => ({ code: 0, stdout: "", stderr: "", timedOut: false, truncated: false, ...r });

const OTHER_ID = "deadbeef";
type Labels = Record<string, string> | null;
/** The three kinds of label sets, plus the ones that are no sandbox of ours. */
const LABELS: Record<SandboxClass, Labels> = {
  mine: { "mcp-everything": "1", "mcp-everything.owner": TEST_INSTALLATION_ID, "mcp-everything.project": "github:o/mine" },
  another: { "mcp-everything": "1", "mcp-everything.owner": OTHER_ID, "mcp-everything.project": "github:o/theirs" },
  before: { "mcp-everything": "1", "mcp-everything.project": "github:o/old" },
  "not-ours": { "com.example.thing": "x" },
};
const idFor = (name: string) => createHash("sha256").update(name).digest("hex");

interface FakeContainer {
  id: string;
  running: boolean;
  labels: Labels;
  networks: string[];
}

/**
 * A scripted daemon. It answers by the whole command line, from a small world of
 * containers and volumes, and overrides nothing of the class under test: only the
 * one method that would run the binary.
 */
class ScriptedDocker extends Docker {
  argvs: string[][] = [];
  /** The options each command was given, parallel to `argvs`. */
  optsList: Array<RunOptions | undefined> = [];
  /** What `docker start -a` prints for a one-shot container (the clone's script prints this). */
  startOutput = `HEAD ${"c".repeat(40)}\n`;
  /** What `docker create` was asked for: name, labels, the whole argument list. */
  created: Array<{ name: string; id: string; labels: Record<string, string>; args: string[] }> = [];
  containers = new Map<string, FakeContainer>();
  volumes = new Map<string, Labels>();
  execReplies: Reply[] = [];
  /** What `docker run -d` prints. */
  runOutput = `${"f".repeat(64)}\n`;
  /** Consulted first; return undefined to fall through to the world. May have side effects. */
  script: Array<(args: string[]) => Reply | undefined> = [];
  /** When set, only inspects, volume inspects and version requests are accepted; anything else is recorded in `violations` and throws. */
  strict = false;
  violations: string[][] = [];

  protected override async docker(args: string[], opts?: RunOptions) {
    this.argvs.push(args);
    this.optsList.push(opts);
    if (this.strict && !(args[0] === "inspect" || args[0] === "version" || (args[0] === "volume" && args[1] === "inspect"))) {
      this.violations.push(args);
      throw new Error(`unexpected command in a read-only double: ${args.join(" ")}`);
    }
    for (const s of this.script) {
      const r = s(args);
      if (r) return reply(r);
    }
    return reply(this.world(args));
  }

  private find(target: string): [string, FakeContainer] | undefined {
    for (const [name, c] of this.containers) if (name === target || c.id === target) return [name, c];
    return undefined;
  }

  private world(args: string[]): Reply {
    switch (args[0]) {
      case "version":
        return { stdout: "27.0.0\n" };
      case "image":
        return { stdout: "[]" };
      case "exec":
        return this.execReplies.shift() ?? {};
      case "inspect": {
        const target = args[args.length - 1]!;
        const found = this.find(target);
        if (!found) return { code: 1, stderr: `Error response from daemon: No such container: ${target}\n` };
        const [, c] = found;
        const format = args[args.indexOf("--format") + 1]!;
        const out: Record<string, unknown> = { id: c.id, running: c.running };
        if (format.includes('"labels"')) out.labels = c.labels;
        out.networks = Object.fromEntries(c.networks.map((n) => [n, { IPAddress: "10.0.0.2" }]));
        return { stdout: `${JSON.stringify(out)}\n` };
      }
      case "create": {
        const name = args[args.indexOf("--name") + 1]!;
        const labels: Record<string, string> = {};
        args.forEach((a, i) => {
          if (a === "--label") {
            const [k, ...v] = args[i + 1]!.split("=");
            labels[k!] = v.join("=");
          }
        });
        const id = idFor(name);
        this.created.push({ name, id, labels, args });
        this.containers.set(name, { id, running: false, labels, networks: ["bridge"] });
        return { stdout: `${id}\n` };
      }
      case "start": {
        const one = args[1] === "-a";
        const found = this.find(args[args.length - 1]!);
        if (!found) return { code: 1, stderr: "Error response from daemon: No such container\n" };
        found[1].running = true;
        return { stdout: one ? this.startOutput : `${args[1]}\n` };
      }
      case "rm": {
        const found = this.find(args[args.length - 1]!);
        if (found) this.containers.delete(found[0]);
        return {};
      }
      case "network": {
        const found = this.find(args[args.length - 1]!);
        if (found) found[1].networks = args[1] === "connect" ? ["bridge"] : [];
        return {};
      }
      case "volume": {
        const name = args[args.length - 1]!;
        if (args[1] === "inspect") {
          if (!this.volumes.has(name)) return { code: 1, stderr: `Error response from daemon: get ${name}: no such volume\n` };
          return { stdout: `${JSON.stringify(this.volumes.get(name))}\n` };
        }
        if (args[1] === "create") this.volumes.set(name, { "mcp-everything": "1", "mcp-everything.owner": TEST_INSTALLATION_ID });
        if (args[1] === "rm") this.volumes.delete(name);
        return {};
      }
      case "run":
        return args[1] === "-d" ? { stdout: this.runOutput } : { stdout: `HEAD ${"c".repeat(40)}\n` };
      default:
        return {};
    }
  }

  /** Put a container of the given class in the world, by name. */
  put(name: string, cls: SandboxClass, opts: { running?: boolean; networks?: string[] } = {}): string {
    const id = idFor(name);
    this.containers.set(name, { id, running: opts.running ?? true, labels: LABELS[cls], networks: opts.networks ?? [] });
    return id;
  }
  putVolume(name: string, cls: SandboxClass, role?: string): void {
    this.volumes.set(name, role === undefined ? LABELS[cls] : { ...LABELS[cls], "mcp-everything.role": role });
  }
  get execs() {
    return this.argvs.filter((a) => a[0] === "exec");
  }
  /** The first word of every command issued, with the second for `volume`, `network` and `image`. */
  get verbs(): string[] {
    return this.argvs.map((a) => (["volume", "network", "image"].includes(a[0]!) ? `${a[0]} ${a[1]}` : a[0]!));
  }
  count(verb: string): number {
    return this.verbs.filter((v) => v === verb).length;
  }
}

const mk = (env: Record<string, string> = {}) => new ScriptedDocker(loadConfig(env), TEST_INSTALLATION_ID);
const OPTS = { timeoutSec: 10 };
const DAEMON = "Error response from daemon: container abc123 is not running\n";
const STOPPED_STATE = "cannot exec in a stopped state\n";
const OCI = "OCI runtime exec failed: exec failed: cannot exec in a stopped container\n";
const N = "mcpe-0123abcd-box";
const V = "mcpe-0123abcd-box-vol";
const STAGING = "mcpe-0123abcd-stage";
const TARGET = "mcpe-0123abcd-target";
const SCANNER = { name: "s", image: "scan:1", command: ["scan", "--sarif", "."], network: false, timeoutSec: 60, env: [] };
const REPO = { forge: "github", host: "github.com", path: "o/r", cloneUrl: "https://github.com/o/r.git", id: "github:o/r", name: "r" } as const;
const READ_ONLY = new Set(["inspect", "volume inspect", "version"]);

describe("createContainer", () => {
  const runArgs = async (env: Record<string, string>) => {
    const d = mk(env);
    d.putVolume("v", "mine");
    await d.createContainer({ name: "n", volume: "v", image: "img", project: "p" });
    return d.argvs.find((a) => a[0] === "run")!;
  };

  it("runs the watchdog entrypoint by default", async () => {
    const a = await runArgs({});
    const i = a.indexOf("--entrypoint");
    expect(a.slice(i, i + 3)).toEqual(["--entrypoint", "/bin/sh", "img"]);
    expect(a.slice(i + 3, i + 4)).toEqual(["-c"]);
    expect(a.slice(i + 5)).toEqual(["watchdog", "1800", "15"]);
    expect(a).toContain("mcp-everything.idle-timeout=1800");
    const script = a[i + 4]!;
    const path = script.indexOf("PATH=/usr/local/sbin");
    expect(path).toBeGreaterThanOrEqual(0);
    expect(path).toBeLessThan(script.indexOf("while"));
    expect(script).toContain("${up%%.*}");
    expect(script).toContain("${d#/proc/}");
    expect(script).not.toMatch(/sleep (60|300)/);
    expect(script).toContain("until command eval");
    expect(script).toContain("watchdog: cannot fork (process limit reached); retrying");
  });

  it("keeps sleep infinity when disabled", async () => {
    const a = await runArgs({ MCPE_SANDBOX_IDLE_TIMEOUT: "0" });
    expect(a.slice(-4)).toEqual(["--entrypoint", "sleep", "img", "infinity"]);
    expect(a).toContain("mcp-everything.idle-timeout=0");
  });

  it.each<Record<string, string>>([{}, { MCPE_SANDBOX_IDLE_TIMEOUT: "0" }])("keeps every existing flag (%j)", async (env) => {
    const a = await runArgs(env);
    const pairs = (flag: string) => a.flatMap((x, i) => (x === flag ? [a[i + 1]] : []));
    expect(a).toContain("--init");
    expect(a.slice(a.indexOf("--name"), a.indexOf("--name") + 2)).toEqual(["--name", "n"]);
    expect(a.slice(a.indexOf("--hostname"), a.indexOf("--hostname") + 2)).toEqual(["--hostname", "sandbox"]);
    expect(pairs("--label")).toEqual(expect.arrayContaining(["mcp-everything=1", `mcp-everything.owner=${TEST_INSTALLATION_ID}`, "mcp-everything.project=p"]));
    for (const f of ["--memory", "--cpus", "--pids-limit", "--security-opt", "--cap-drop"]) expect(a).toContain(f);
    expect(pairs("--cap-add")).toEqual(["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "SETUID", "SETGID"]);
    expect(pairs("--network")).toEqual(["bridge"]);
    expect(pairs("-v")).toEqual(["v:/workspace"]);
    expect(pairs("-w")).toEqual(["/workspace/repo"]);
    expect(pairs("-e")).toEqual(expect.arrayContaining(["HOME=/root", "TERM=dumb"]));
  });

  it("passes the timeout and poll interval as decimal strings", async () => {
    const a = await runArgs({ MCPE_SANDBOX_IDLE_TIMEOUT: "6" });
    expect(a.slice(-3)).toEqual(["watchdog", "6", "1"]);
    expect(a).toContain("mcp-everything.idle-timeout=6");
  });
});

describe("watchdogPollSec", () => {
  it.each([[1800, 15], [6, 1], [1, 1], [60, 15], [30, 7]])("%i s -> %i s", (idle, poll) => {
    expect(watchdogPollSec(idle)).toBe(poll);
  });
});

describe("isStoppedExecFailure", () => {
  const base = { timedOut: false, truncated: false };
  it("recognises the three docker failures", () => {
    expect(isStoppedExecFailure({ ...base, code: 1, stdout: "", stderr: DAEMON })).toBe(true);
    expect(isStoppedExecFailure({ ...base, code: 1, stdout: "", stderr: DAEMON.replace("container", "Container") })).toBe(true);
    expect(isStoppedExecFailure({ ...base, code: 128, stdout: STOPPED_STATE, stderr: "" })).toBe(true);
    expect(isStoppedExecFailure({ ...base, code: 128, stdout: OCI, stderr: "" })).toBe(true);
  });
  it("rejects look-alikes", () => {
    expect(isStoppedExecFailure({ ...base, code: 1, stdout: "", stderr: "Error response from daemon: container a b is not running" })).toBe(false);
    expect(isStoppedExecFailure({ ...base, code: 1, stdout: "x", stderr: DAEMON })).toBe(false);
  });
});

describe("Docker.exec retry", () => {
  afterEach(() => vi.restoreAllMocks());
  /** A stopped sandbox of this installation's, and its id. */
  const stopped = () => {
    const d = mk();
    const id = d.put("c", "mine", { running: false });
    return { d, id };
  };

  it.each([
    ["daemon line", { code: 1, stderr: DAEMON }],
    ["stopped state", { code: 128, stdout: STOPPED_STATE }],
    ["OCI line", { code: 128, stdout: OCI }],
  ])("restarts and retries once: %s", async (_n, first) => {
    const { d, id } = stopped();
    d.execReplies = [first, { code: 0, stdout: "ok" }];
    const res = await d.exec("c", ["true"], OPTS);
    expect(res.stdout).toBe("ok");
    expect(d.count("start")).toBe(1);
    expect(d.execs).toHaveLength(2);
    expect(d.argvs.find((a) => a[0] === "start")).toEqual(["start", id]);
  });

  it("starts the id it already holds and runs on it, without resolving the name again", async () => {
    const { d, id } = stopped();
    d.execReplies = [{ code: 1, stderr: DAEMON }, { code: 0 }];
    await d.exec("c", ["true"], OPTS);
    // resolve by name, exec, look at the id, start the id, exec: the name is used once.
    expect(d.argvs.map((a) => a[0])).toEqual(["inspect", "exec", "inspect", "start", "exec"]);
    expect(d.argvs.filter((a) => a.includes("c"))).toHaveLength(1);
    expect(d.argvs[2]!.at(-1)).toBe(id);
    expect(d.execs.map((a) => a[2])).toEqual([id, id]);
  });

  it("makes at most two attempts", async () => {
    const { d } = stopped();
    d.execReplies = [{ code: 1, stderr: DAEMON }, { code: 1, stderr: DAEMON }, { code: 0 }];
    const res = await d.exec("c", ["true"], OPTS);
    expect(res.code).toBe(1);
    expect(d.execs).toHaveLength(2);
    expect(d.count("start")).toBe(1);
  });

  it.each([
    ["timedOut", { code: 1, stderr: DAEMON, timedOut: true }],
    ["null exit code", { code: null, stderr: DAEMON }],
    ["exit 137", { code: 137, stdout: STOPPED_STATE }],
    ["daemon line plus stdout", { code: 1, stdout: "hi", stderr: DAEMON }],
    ["daemon line plus more stderr", { code: 1, stderr: `warn\n${DAEMON}` }],
    ["exit 2", { code: 2, stderr: DAEMON }],
    ["OCI line embedded", { code: 128, stdout: `before\n${OCI}after` }],
    ["truncated", { code: 1, stderr: DAEMON, truncated: true }],
  ])("does not retry: %s", async (_n, first) => {
    const { d } = stopped();
    d.execReplies = [first, { code: 0 }];
    await d.exec("c", ["true"], OPTS);
    expect(d.execs).toHaveLength(1);
    expect(d.count("start")).toBe(0);
    expect(d.count("inspect")).toBe(1); // only the resolve
  });

  it("returns the first result when the container is gone", async () => {
    const { d } = stopped();
    d.script.push((a) => {
      if (a[0] === "exec") d.containers.delete("c"); // removed while the first attempt ran
      return undefined;
    });
    d.execReplies = [{ code: 1, stderr: DAEMON }, { code: 0 }];
    const res = await d.exec("c", ["true"], OPTS);
    expect(res.code).toBe(1);
    expect(d.execs).toHaveLength(1);
  });

  it("propagates a failed restart without a second attempt", async () => {
    const { d } = stopped();
    d.script.push((a) => (a[0] === "start" ? { code: 1, stderr: "boom" } : undefined));
    d.execReplies = [{ code: 1, stderr: DAEMON }, { code: 0 }];
    await expect(d.exec("c", ["true"], OPTS)).rejects.toThrow(/Failed to start sandbox/);
    expect(d.execs).toHaveLength(1);
  });

  it("times the second attempt from its own start", async () => {
    const { d } = stopped();
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    d.script.push((a) => {
      if (a[0] === "start") now += 60_000; // the restart takes longer than the call's limit
      return undefined;
    });
    d.execReplies = [{ code: 1, stderr: DAEMON }, { code: 137 }];
    const res = await d.exec("c", ["true"], { timeoutSec: 10 });
    expect(res.code).toBe(137);
    expect(res.timedOut).toBe(false);
  });

  it("does not restart when asked not to", async () => {
    const { d } = stopped();
    d.execReplies = [{ code: 1, stderr: DAEMON }, { code: 0 }];
    const res = await d.exec("c", ["true"], { ...OPTS, restart: false });
    expect(res.code).toBe(1);
    expect(d.execs).toHaveLength(1);
    expect(d.count("start")).toBe(0);
  });
});

describe("setNetwork(container, false)", () => {
  const verbs = (d: ScriptedDocker) => d.argvs.map((a) => a.slice(0, 2).join(" "));

  it("returns without detaching, and without asking about the daemon, when the container is not there", async () => {
    const d = mk();
    await d.setNetwork("gone", false);
    expect(d.verbs).toEqual(["inspect"]);
  });

  it("rejects, and detaches nothing, when the networks cannot be read because the daemon does not answer", async () => {
    const d = mk();
    d.script.push((a) => (a[0] === "inspect" ? { code: 1, stderr: "Cannot connect to the Docker daemon" } : undefined));
    await expect(d.setNetwork("box", false)).rejects.toBeInstanceOf(DockerUnavailableError);
    expect(verbs(d)).not.toContain("network disconnect");
  });

  it("rejects when the inspect times out", async () => {
    const d = mk();
    d.script.push((a) => (a[0] === "inspect" ? { code: null as unknown as number, timedOut: true } : undefined));
    await expect(d.setNetwork("box", false)).rejects.toBeInstanceOf(DockerUnavailableError);
    expect(d.verbs).toEqual(["inspect"]);
  });

  it("disconnects when the container has a network", async () => {
    const d = mk();
    const id = d.put("box", "mine", { networks: ["bridge"] });
    await d.setNetwork("box", false);
    expect(d.argvs.find((a) => a[0] === "network")).toEqual(["network", "disconnect", "bridge", id]);
  });

  it("does nothing more when the inspect succeeded and listed no network", async () => {
    const d = mk();
    d.put("box", "mine");
    await d.setNetwork("box", false);
    expect(verbs(d)).not.toContain("network disconnect");
    expect(verbs(d)).not.toContain("version --format");
  });
});

describe("installation id", () => {
  it("is required, exposed read-only, and must be valid", () => {
    expect(mk().installationId).toBe(TEST_INSTALLATION_ID);
    for (const bad of ["", "0123abc", "0123abcde", "0123ABCD", "0123abcg", "0123abcd\n", undefined as unknown as string]) {
      expect(() => new ScriptedDocker(loadConfig({}), bad)).toThrow(/installation id/);
    }
  });

  it("names a sandbox <prefix><id>-<slug>", () => {
    expect(mk().sandboxName("widget")).toBe(`mcpe-${TEST_INSTALLATION_ID}-widget`);
    expect(mk({ MCPE_NAME_PREFIX: "box-" }).sandboxName("widget")).toBe(`box-${TEST_INSTALLATION_ID}-widget`);
  });

  it("labels the volume the probe creates with its owner", async () => {
    const d = mk();
    await d.probe({ forge: "github", host: "github.com", path: "o/r", cloneUrl: "https://github.com/o/r.git", id: "github:o/r", name: "r" }, "vol", {}).catch(() => {});
    const create = d.argvs.find((a) => a[0] === "volume" && a[1] === "create")!;
    expect(create).toEqual(["volume", "create", "--label", "mcp-everything=1", "--label", `mcp-everything.owner=${TEST_INSTALLATION_ID}`, "vol"]);
  });
});

describe("classifySandbox", () => {
  const ID = TEST_INSTALLATION_ID;
  const GEN = "mcp-everything";
  const OWN = "mcp-everything.owner";
  it.each<[string, Record<string, unknown> | null | undefined, SandboxClass]>([
    ["owner is this id, generic label 1", { [GEN]: "1", [OWN]: ID }, "mine"],
    ["owner is this id, no generic label", { [OWN]: ID }, "mine"],
    ["owner is another id, generic label 1", { [GEN]: "1", [OWN]: OTHER_ID }, "another"],
    ["owner is another id, no generic label", { [OWN]: OTHER_ID }, "another"],
    ["owner is empty", { [GEN]: "1", [OWN]: "" }, "another"],
    ["owner is malformed", { [GEN]: "1", [OWN]: "NOT-HEX!" }, "another"],
    ["owner is this id in capitals", { [GEN]: "1", [OWN]: ID.toUpperCase() }, "another"],
    ["owner is this id with a space", { [GEN]: "1", [OWN]: `${ID} ` }, "another"],
    ["generic label 1, no owner", { [GEN]: "1" }, "before"],
    ["generic label 1 and unrelated labels", { [GEN]: "1", "mcp-everything.project": "p", other: "x" }, "before"],
    ["labels null", null, "not-ours"],
    ["labels undefined", undefined, "not-ours"],
    ["labels empty", {}, "not-ours"],
    ["labels an array", ["mcp-everything=1"] as unknown as Record<string, unknown>, "not-ours"],
    ["generic label 0", { [GEN]: "0" }, "not-ours"],
    ["generic label true", { [GEN]: "true" }, "not-ours"],
    ["generic label empty", { [GEN]: "" }, "not-ours"],
    ["generic label '1 '", { [GEN]: "1 " }, "not-ours"],
    ["only the project label", { "mcp-everything.project": "p" }, "not-ours"],
  ])("%s -> %s", (_n, labels, cls) => {
    expect(classifySandbox(labels, ID)).toBe(cls);
  });
});

describe("the two error types", () => {
  it("a refusal carries the name, the kind, the reason and the owner, and is an Error", async () => {
    const d = mk();
    d.put(N, "another");
    const e = await d.state(N).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(SandboxRefusedError);
    expect(e).not.toBeInstanceOf(DockerUnavailableError);
    const r = e as SandboxRefusedError;
    expect([r.sandbox, r.kind, r.reason, r.owner, r.installationId]).toEqual([N, "container", "another", OTHER_ID, TEST_INSTALLATION_ID]);
    expect(r.message).toContain(N);
    expect(r.message).toContain(TEST_INSTALLATION_ID);
    expect(r.message).toContain(OTHER_ID);
    expect(r.message).toContain("github:o/theirs"); // the project label of a container
  });

  it("a refusal for a sandbox that is not ours has no owner; a volume has no project", async () => {
    const d = mk();
    d.putVolume(V, "not-ours");
    const r = (await d.probe(REPO, V, {}).then(() => null, (x: unknown) => x)) as SandboxRefusedError;
    expect([r.kind, r.reason, r.owner]).toEqual(["volume", "not-ours", undefined]);
    expect(r.message).toContain(V);
    expect(r.message).not.toMatch(/project/i);
  });

  it("cleans label values of terminal sequences, flattens them to one line and cuts them", async () => {
    const d = mk();
    const owner = `\u001b[31mevil\u001b[0m\nsecond line ${"x".repeat(300)}`;
    const project = `p\u001b]0;title\u0007\r\nq\u0000${"y".repeat(300)}`;
    d.containers.set(N, { id: idFor(N), running: true, labels: { "mcp-everything": "1", "mcp-everything.owner": owner, "mcp-everything.project": project }, networks: [] });
    const r = (await d.state(N).then(() => null, (x: unknown) => x)) as SandboxRefusedError;
    expect(r.owner).toBe(owner); // as recorded
    expect(r.message).not.toMatch(/[\u0000-\u001f\u007f]/); // no escape, no control, no line break
    expect(r.message).toContain("evil");
    expect(r.message).toContain("second line");
    expect(r.message).not.toContain("[31m");
    expect(r.message).not.toContain("title");
    expect(r.message).not.toContain("x".repeat(100));
    expect(r.message).not.toContain("y".repeat(100));
    expect(r.message.length).toBeLessThan(500);
  });

  it("cuts a long owner label to OWNER_SHOWN characters, the same cut the installer and project_info make", async () => {
    const d = mk();
    d.containers.set(N, { id: idFor(N), running: true, labels: { "mcp-everything.owner": "x".repeat(300) }, networks: [] });
    const r = (await d.state(N).then(() => null, (x: unknown) => x)) as SandboxRefusedError;
    expect(r.message).toContain(`owner label "${"x".repeat(OWNER_SHOWN - 1)}…"`);
  });

  it("flattens a line break on its own", async () => {
    const d = mk();
    d.containers.set(N, { id: idFor(N), running: true, labels: { "mcp-everything.owner": "one\ntwo\n\nthree" }, networks: [] });
    const r = (await d.state(N).then(() => null, (x: unknown) => x)) as SandboxRefusedError;
    expect(r.message).toContain("one two three");
  });

  it("assertAvailable throws the second type, with today's messages", async () => {
    const d = mk();
    d.script.push(() => ({ code: 1, stderr: "Cannot connect\n" }));
    const e = await d.assertAvailable().then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(DockerUnavailableError);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toBe("Docker daemon is not reachable: Cannot connect");
    class Throws extends ScriptedDocker {
      protected override async docker(): Promise<never> {
        throw new Error("spawn docker ENOENT");
      }
    }
    const t = new Throws(loadConfig({}), TEST_INSTALLATION_ID);
    const e2 = await t.assertAvailable().then(() => null, (x: unknown) => x);
    expect(e2).toBeInstanceOf(DockerUnavailableError);
    expect((e2 as Error).message).toBe('Docker CLI "docker" could not be run: spawn docker ENOENT');
    // and a binary that cannot be run while resolving is the same type
    await expect(t.state(N)).rejects.toBeInstanceOf(DockerUnavailableError);
  });
});

describe("resolving a container", () => {
  it("issues one inspect, of a container, in a format that cannot be confused by a label", async () => {
    const d = mk();
    d.put(N, "mine");
    expect(await d.state(N)).toBe("running");
    expect(d.argvs).toHaveLength(1);
    const a = d.argvs[0]!;
    expect(a.slice(0, 3)).toEqual(["inspect", "--type", "container"]);
    expect(a.at(-1)).toBe(N);
    const format = a[a.indexOf("--format") + 1]!;
    for (const f of ["json .Id", "json .State.Running", "json .Config.Labels", "json .NetworkSettings.Networks"]) expect(format).toContain(f);
    expect(format).not.toContain("{{json .}}"); // would include the environment
  });

  it.each([
    ["the daemon's wording", { code: 1, stderr: "Error response from daemon: No such container: x\n" }],
    ["another runtime's wording", { code: 1, stderr: "Error: No such object: x" }],
    ["capitals", { code: 1, stderr: "ERROR: NO SUCH CONTAINER" }],
    ["a volume's wording", { code: 125, stderr: "get x: no such volume" }],
  ])("is not there: %s", async (_n, r) => {
    const d = mk();
    d.script.push(() => r);
    expect(await d.state("x")).toBe("missing");
  });

  it.each<[string, Reply]>([
    ["a failure that says something else", { code: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" }],
    ["a failure that says nothing", { code: 1, stderr: "" }],
    ["a wording that matches none", { code: 1, stderr: "Error: container x not found" }],
    ["a timeout", { code: null as unknown as number, timedOut: true }],
    ["a timeout that printed the 'no such' words", { code: 1, timedOut: true, stderr: "No such container: x" }],
    ["a zero exit with 'no such' on stderr", { code: 0, stderr: "No such container: x", stdout: "" }],
    ["output that is not JSON", { stdout: "true\n" }],
    ["empty output", { stdout: "" }],
    ["an id of 63 characters", { stdout: JSON.stringify({ id: "a".repeat(63), running: true, labels: {}, networks: {} }) }],
    ["an id in capitals", { stdout: JSON.stringify({ id: "A".repeat(64), running: true, labels: {}, networks: {} }) }],
    ["running that is not a boolean", { stdout: JSON.stringify({ id: "a".repeat(64), running: "true", labels: {}, networks: {} }) }],
    ["labels that are an array", { stdout: JSON.stringify({ id: "a".repeat(64), running: true, labels: [], networks: {} }) }],
    ["a label value that is not a string", { stdout: JSON.stringify({ id: "a".repeat(64), running: true, labels: { a: 1 }, networks: {} }) }],
    ["networks that are a string", { stdout: JSON.stringify({ id: "a".repeat(64), running: true, labels: {}, networks: "bridge" }) }],
    ["labels missing", { stdout: JSON.stringify({ id: "a".repeat(64), running: true, networks: {} }) }],
    ["output cut short", { stdout: "{}", truncated: true }],
  ])("could not be asked: %s", async (_n, r) => {
    const d = mk();
    d.script.push(() => r);
    await expect(d.state("x")).rejects.toBeInstanceOf(DockerUnavailableError);
  });

  it("reads null labels and null networks", async () => {
    const d = mk();
    d.script.push(() => ({ stdout: JSON.stringify({ id: "a".repeat(64), running: false, labels: null, networks: null }) }));
    await expect(d.state("x")).rejects.toBeInstanceOf(SandboxRefusedError); // null labels: not ours
  });

  it("decides a volume by the same rule", async () => {
    const gone = mk();
    await gone.destroy("c", "v");
    expect(gone.verbs).toEqual(["inspect", "volume inspect"]); // both absent: two inspects, nothing removed
    for (const r of [
      { code: 1, stderr: "Cannot connect" },
      { code: null as unknown as number, timedOut: true },
      { code: 1, timedOut: true, stderr: "get v: no such volume" },
      { stdout: "not json" },
      { stdout: '"labels"' },
      { stdout: '["a"]' },
      { stdout: '{"a":1}' },
    ] as Reply[]) {
      const d = mk();
      d.script.push((a) => (a[0] === "volume" && a[1] === "inspect" ? r : undefined));
      await expect(d.destroy("c", "v")).rejects.toBeInstanceOf(DockerUnavailableError);
      expect(d.count("volume rm")).toBe(0);
    }
  });
});

/** What each guarded method does with a sandbox, by name. `resource` is what its guard is about. */
interface MethodCase {
  run: (d: ScriptedDocker) => Promise<unknown>;
  resource: "container" | "volume";
  /** Setup of the container for the acting cases. */
  container?: { running?: boolean; networks?: string[] };
  /**
   * The volumes a "volume" case takes, by position, each with the role the method requires of it (none by default).
   * Default: the one volume V, with no role.
   */
  volumes?: Array<{ name: string; role?: string }>;
  /** The command it must issue, on the id, when the sandbox is mine or from before. */
  acts: "exec" | "start" | "rm" | "network" | null;
}
const CASES: Record<string, MethodCase> = {
  exec: { run: (d) => d.exec(N, ["true"], OPTS), resource: "container", acts: "exec" },
  state: { run: (d) => d.state(N), resource: "container", acts: null },
  ensureRunning: { run: (d) => d.ensureRunning(N), resource: "container", container: { running: false }, acts: "start" },
  acquire: { run: (d) => d.acquire(N), resource: "container", container: { running: false }, acts: "start" },
  hasNetwork: { run: (d) => d.hasNetwork(N), resource: "container", acts: null },
  setNetwork: { run: (d) => d.setNetwork(N, false), resource: "container", container: { networks: ["bridge"] }, acts: "network" },
  removeContainer: { run: (d) => d.removeContainer(N), resource: "container", acts: "rm" },
  destroy: { run: (d) => d.destroy(N, V), resource: "container", acts: "rm" },
  probe: { run: (d) => d.probe(REPO, V, {}), resource: "volume", acts: null },
  createContainer: { run: (d) => d.createContainer({ name: N, volume: V, image: "img", project: "p" }), resource: "volume", acts: null },
  // Leg 6. The staging volume is read through a read-only mount; the target of a copy is a sandbox volume (no role).
  runScanner: { run: (d) => d.runScanner(STAGING, SCANNER, { timeoutMs: 20_000 }), resource: "volume", volumes: [{ name: STAGING, role: "staging" }], acts: null },
  copyVolume: { run: (d) => d.copyVolume(STAGING, TARGET), resource: "volume", volumes: [{ name: STAGING, role: "staging" }, { name: TARGET }], acts: null },
  createSandboxVolume: { run: (d) => d.createSandboxVolume(TARGET), resource: "volume", volumes: [{ name: TARGET }], acts: null },
  // Leg 7. Removes only a staging volume of this installation; "stagingName" issues no command and is listed in NOT_GUARDED.
  removeStagingVolume: { run: (d) => d.removeStagingVolume(STAGING), resource: "volume", volumes: [{ name: STAGING, role: "staging" }], acts: null },
};
/** The volume positions of a case: one for a container case's volume, none for the container itself. */
const slots = (c: MethodCase) => c.volumes ?? [{ name: V }];
/**
 * Setup: the resource of the case in a class. For a volume case with several volumes, `position` says which one
 * is in `cls`; the others are `mine`, each with the role the method requires of it (so a role check cannot make
 * the case pass vacuously).
 */
function setup(d: ScriptedDocker, c: MethodCase, cls: SandboxClass, position = 0): string | undefined {
  if (c.resource === "volume") {
    slots(c).forEach((v, i) => d.putVolume(v.name, i === position ? cls : "mine", v.role));
    return undefined;
  }
  return d.put(N, cls, c.container);
}
const settle = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e);
const EIGHT = ["exec", "state", "ensureRunning", "acquire", "hasNetwork", "setNetwork", "removeContainer", "destroy"];

describe("every method that takes a name resolves first", () => {
  describe.each(EIGHT)("%s", (method) => {
    const c = CASES[method]!;
    it.each<SandboxClass>(["another", "not-ours"])("refuses a sandbox that is %s, with inspects only", async (cls) => {
      const d = mk();
      setup(d, c, cls);
      const e = await settle(c.run(d));
      expect(e).toBeInstanceOf(SandboxRefusedError);
      expect((e as SandboxRefusedError).reason).toBe(cls);
      expect(d.verbs.length).toBeGreaterThan(0);
      for (const v of d.verbs) expect(READ_ONLY.has(v), `${method} issued ${v}`).toBe(true);
    });

    it("says Docker could not be asked, with inspects only", async () => {
      const d = mk();
      setup(d, c, "mine");
      d.script.push((a) => (a[0] === "inspect" || (a[0] === "volume" && a[1] === "inspect") ? { code: 1, stderr: "Cannot connect to the Docker daemon" } : undefined));
      expect(await settle(c.run(d))).toBeInstanceOf(DockerUnavailableError);
      for (const v of d.verbs) expect(READ_ONLY.has(v), `${method} issued ${v}`).toBe(true);
    });

    it.each<SandboxClass>(["mine", "before"])("acts on the id of a sandbox that is %s", async (cls) => {
      const d = mk();
      const id = setup(d, c, cls)!;
      expect(await settle(c.run(d))).toBeNull();
      if (c.acts === "exec") expect(d.execs[0]![2]).toBe(id);
      if (c.acts === "start") expect(d.argvs.find((a) => a[0] === "start")).toEqual(["start", id]);
      if (c.acts === "rm") expect(d.argvs.find((a) => a[0] === "rm")).toEqual(["rm", "-f", id]);
      if (c.acts === "network") expect(d.argvs.find((a) => a[0] === "network")).toEqual(["network", "disconnect", "bridge", id]);
    });
  });
});

describe("a sandbox that is not there, by name", () => {
  it("state answers missing; ensureRunning and hasNetwork answer false; acquire returns nothing", async () => {
    const d = mk();
    expect(await d.state(N)).toBe("missing");
    expect(await d.ensureRunning(N)).toBe(false);
    expect(await d.hasNetwork(N)).toBe(false);
    expect(await d.acquire(N)).toBeUndefined();
    expect(d.verbs.every((v) => v === "inspect")).toBe(true);
  });

  it("setNetwork(false) returns; setNetwork(true) and exec say it does not exist", async () => {
    const d = mk();
    await expect(d.setNetwork(N, false)).resolves.toBeUndefined();
    await expect(d.setNetwork(N, true)).rejects.toThrow(new RegExp(`${N}.*does not exist`));
    await expect(d.exec(N, ["true"], OPTS)).rejects.toThrow(new RegExp(`${N}.*does not exist`));
    expect(d.count("exec")).toBe(0);
  });

  it("removeContainer and destroy treat what is missing as removed", async () => {
    const d = mk();
    await d.removeContainer(N);
    await d.destroy(N, V);
    expect(d.count("rm") + d.count("volume rm")).toBe(0);
    const only = mk();
    only.put(N, "mine");
    await only.destroy(N, V); // the volume is missing
    expect(only.count("rm")).toBe(1);
    expect(only.count("volume rm")).toBe(0);
    const vol = mk();
    vol.putVolume(V, "mine");
    await vol.destroy(N, V); // the container is missing
    expect(vol.count("rm")).toBe(0);
    expect(vol.argvs.find((a) => a[0] === "volume" && a[1] === "rm")).toEqual(["volume", "rm", "-f", V]);
  });
});

describe("acquire", () => {
  it("returns the id and the name, nothing else, for a running sandbox that is mine", async () => {
    const d = mk();
    const id = d.put(N, "mine");
    const ref = await d.acquire(N);
    expect(ref).toEqual({ id, name: N });
    expect(Object.keys(ref!)).toEqual(["id", "name"]);
    expect(Object.isFrozen(ref)).toBe(true);
    expect(d.count("start")).toBe(0);
    expect(d.argvs).toHaveLength(1);
  });

  it.each<SandboxClass>(["mine", "before"])("starts a stopped sandbox that is %s, by id", async (cls) => {
    const d = mk();
    const id = d.put(N, cls, { running: false });
    expect(await d.acquire(N)).toEqual({ id, name: N });
    expect(d.argvs.filter((a) => a[0] === "start")).toEqual([["start", id]]);
  });

  it.each<SandboxClass>(["another", "not-ours"])("refuses a stopped sandbox that is %s, and does not start it", async (cls) => {
    const d = mk();
    d.put(N, cls, { running: false });
    await expect(d.acquire(N)).rejects.toBeInstanceOf(SandboxRefusedError);
    expect(d.count("start")).toBe(0);
  });
});

describe("a reference", () => {
  const setupRef = (cls: SandboxClass = "another", opts: { running?: boolean; networks?: string[] } = {}) => {
    const d = mk();
    const id = d.put(N, cls, opts); // even another's: a reference is trusted and its labels are not read
    return { d, id, ref: { id, name: N } };
  };
  const labelsRead = (d: ScriptedDocker) => d.argvs.some((a) => a.join(" ").includes("Config.Labels"));

  it("exec runs on the id and reads no labels", async () => {
    const { d, id, ref } = setupRef();
    await d.exec(ref, ["true"], OPTS);
    expect(d.verbs).toEqual(["exec"]);
    expect(d.execs[0]![2]).toBe(id);
    expect(labelsRead(d)).toBe(false);
  });

  it("state, ensureRunning and hasNetwork read by id, without labels", async () => {
    const { d, id, ref } = setupRef("another", { running: false, networks: ["bridge"] });
    expect(await d.state(ref)).toBe("stopped");
    expect(await d.hasNetwork(ref)).toBe(true);
    expect(await d.ensureRunning(ref)).toBe(true);
    expect(d.argvs.filter((a) => a[0] === "inspect").map((a) => a.at(-1))).toEqual([id, id, id]);
    expect(d.argvs.find((a) => a[0] === "start")).toEqual(["start", id]);
    expect(labelsRead(d)).toBe(false);
  });

  it("setNetwork issues one inspect, by id, then names the id", async () => {
    const { d, id, ref } = setupRef("another", { networks: ["bridge"] });
    await d.setNetwork(ref, false);
    expect(d.argvs.map((a) => a[0])).toEqual(["inspect", "network"]);
    expect(d.argvs[0]!.at(-1)).toBe(id);
    expect(d.argvs[1]).toEqual(["network", "disconnect", "bridge", id]);
    const on = setupRef("another");
    await on.d.setNetwork(on.ref, true);
    expect(on.d.argvs[1]).toEqual(["network", "connect", "bridge", on.id]);
    expect(labelsRead(d) || labelsRead(on.d)).toBe(false);
  });

  it("setNetwork by name issues one inspect in all", async () => {
    const d = mk();
    d.put(N, "mine");
    await d.setNetwork(N, true);
    expect(d.verbs).toEqual(["inspect", "network connect"]);
  });

  it("fails plainly when its container is gone; state says missing", async () => {
    const d = mk();
    const ref = { id: "a".repeat(64), name: N };
    expect(await d.state(ref)).toBe("missing");
    for (const e of [await settle(d.ensureRunning(ref)), await settle(d.setNetwork(ref, true)), await settle(d.setNetwork(ref, false))]) {
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(SandboxRefusedError);
      expect(e).not.toBeInstanceOf(DockerUnavailableError);
    }
    expect(await d.hasNetwork(ref)).toBe(false);
  });

  it("removeContainer by reference classifies the container by its id before removing it", async () => {
    const { d, ref } = setupRef("another");
    await expect(d.removeContainer(ref)).rejects.toBeInstanceOf(SandboxRefusedError);
    expect(d.count("rm")).toBe(0);
  });
});

describe("destroy classifies both before it removes either", () => {
  const classes: SandboxClass[] = ["mine", "before", "another", "not-ours"];
  const bad = (c: SandboxClass) => c === "another" || c === "not-ours";
  const pairs = classes.flatMap((c) => classes.map((v) => [c, v] as const));

  it.each(pairs)("container %s, volume %s", async (c, v) => {
    const d = mk();
    const id = d.put(N, c);
    d.putVolume(V, v);
    const e = await settle(d.destroy(N, V));
    if (bad(c) || bad(v)) {
      expect(e).toBeInstanceOf(SandboxRefusedError);
      const r = e as SandboxRefusedError;
      expect(r.message).toContain(N);
      expect(r.message).toContain(V);
      expect(r.message).toContain(c === "mine" ? "this installation's" : c === "before" ? "before ownership was recorded" : c === "another" ? "another installation's" : "not created by mcp-everything");
      expect(r.sandboxes.map((f) => [f.kind, f.cls])).toEqual([["container", c], ["volume", v]]);
      expect(d.count("rm") + d.count("volume rm")).toBe(0);
      expect(d.containers.has(N)).toBe(true);
      expect(d.volumes.has(V)).toBe(true);
    } else {
      expect(e).toBeNull();
      expect(d.argvs.find((a) => a[0] === "rm")).toEqual(["rm", "-f", id]);
      expect(d.argvs.find((a) => a[0] === "volume" && a[1] === "rm")).toEqual(["volume", "rm", "-f", V]);
      const lastInspect = Math.max(d.verbs.lastIndexOf("inspect"), d.verbs.lastIndexOf("volume inspect"));
      expect(lastInspect).toBeLessThan(d.verbs.indexOf("rm"));
    }
  });

  it("a volume that cannot be asked about leaves the container alone", async () => {
    const d = mk();
    d.put(N, "mine");
    d.script.push((a) => (a[0] === "volume" ? { code: 1, stderr: "Cannot connect" } : undefined));
    await expect(d.destroy(N, V)).rejects.toBeInstanceOf(DockerUnavailableError);
    expect(d.count("rm")).toBe(0);
  });

  it("a container that cannot be asked about leaves the volume alone", async () => {
    const d = mk();
    d.putVolume(V, "mine");
    d.script.push((a) => (a[0] === "inspect" ? { code: 1, stderr: "Cannot connect" } : undefined));
    await expect(d.destroy(N, V)).rejects.toBeInstanceOf(DockerUnavailableError);
    expect(d.count("volume rm")).toBe(0);
  });

  it("removeContainer removes a container alone, by id, and leaves the volume", async () => {
    const d = mk();
    const id = d.put(N, "mine");
    d.putVolume(V, "mine");
    await d.removeContainer(N);
    expect(d.argvs.find((a) => a[0] === "rm")).toEqual(["rm", "-f", id]);
    expect(d.volumes.has(V)).toBe(true);
  });

  it("reports a failed removal as today", async () => {
    const d = mk();
    d.put(N, "mine");
    d.script.push((a) => (a[0] === "rm" ? { code: 1, stderr: "busy" } : undefined));
    await expect(d.removeContainer(N)).rejects.toThrow(/Failed to remove container .*busy/);
  });
});

describe("probe's volume", () => {
  const probe = (d: ScriptedDocker) => d.probe(REPO, V, {});

  it("is created only when no volume has that name", async () => {
    const d = mk();
    await probe(d).catch(() => {});
    expect(d.count("volume create")).toBe(1);
    expect(d.count("create")).toBe(1);
  });

  it.each<SandboxClass>(["another", "not-ours"])("refuses a volume that is %s", async (cls) => {
    const d = mk();
    d.putVolume(V, cls);
    await expect(probe(d)).rejects.toBeInstanceOf(SandboxRefusedError);
    expect(d.count("volume create") + d.count("create")).toBe(0);
  });

  it.each<SandboxClass>(["mine", "before"])("says a volume that is %s already exists", async (cls) => {
    const d = mk();
    d.putVolume(V, cls);
    const e = await settle(probe(d));
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(SandboxRefusedError);
    expect(e).not.toBeInstanceOf(DockerUnavailableError);
    expect((e as Error).message).toMatch(/already exists/);
    expect(d.count("volume create") + d.count("create")).toBe(0);
  });

  it("says Docker could not be asked", async () => {
    const d = mk();
    d.script.push((a) => (a[0] === "volume" ? { code: 1, stderr: "Cannot connect" } : undefined));
    await expect(probe(d)).rejects.toBeInstanceOf(DockerUnavailableError);
    expect(d.count("volume create") + d.count("create")).toBe(0);
  });
});

/** The one-shot method is protected; a subclass reaches it, as this double does the binary. */
class OneShotDocker extends ScriptedDocker {
  once(spec: OneShotSpec) {
    return this.runOnce(spec);
  }
}
const mkOnce = (env: Record<string, string> = {}) => new OneShotDocker(loadConfig(env), TEST_INSTALLATION_ID);
const SPEC: OneShotSpec = {
  role: "scan",
  image: "img:1",
  network: "none",
  mounts: ["vol:/workspace:ro"],
  workdir: "/workspace",
  args: ["echo", "hi"],
  timeoutMs: 1234,
  maxBytes: 5678,
};
const NAME_SHAPE = new RegExp(`^mcpe-${TEST_INSTALLATION_ID}-scan-[0-9a-f]{8}$`);

describe("the one-shot method", () => {
  it("creates with the exact arguments: --rm, a name of prefix, installation, role and eight hex, the three labels, the limits, no -t", async () => {
    const d = mkOnce();
    await d.once(SPEC);
    const a = d.created[0]!.args;
    const name = d.created[0]!.name;
    expect(name).toMatch(NAME_SHAPE);
    const limits = ["--memory", "--cpus", "--pids-limit", "--security-opt", "no-new-privileges", "--cap-drop", "ALL"];
    expect(a.slice(0, 3)).toEqual(["create", "--rm", "--name"]);
    expect(a).not.toContain("-t");
    expect(a).not.toContain("-it");
    expect(a).not.toContain("--entrypoint");
    expect(a).not.toContain("--cap-add");
    for (const l of limits) expect(a).toContain(l);
    expect(d.created[0]!.labels).toEqual({
      "mcp-everything": "1",
      "mcp-everything.owner": TEST_INSTALLATION_ID,
      "mcp-everything.role": "scan",
    });
    expect(a.slice(a.indexOf("--network"), a.indexOf("--network") + 2)).toEqual(["--network", "none"]);
    expect(a.slice(a.indexOf("-v"), a.indexOf("-v") + 2)).toEqual(["-v", "vol:/workspace:ro"]);
    expect(a.slice(a.indexOf("-w"), a.indexOf("-w") + 2)).toEqual(["-w", "/workspace"]);
    expect(a.slice(-3)).toEqual(["img:1", "echo", "hi"]);
  });

  it("names two calls differently", async () => {
    const d = mkOnce();
    await d.once(SPEC);
    await d.once(SPEC);
    expect(d.created[0]!.name).not.toBe(d.created[1]!.name);
  });

  it("uses the configured name prefix", async () => {
    const d = mkOnce({ MCPE_NAME_PREFIX: "box-" });
    await d.once({ ...SPEC, role: "copy" });
    expect(d.created[0]!.name).toMatch(new RegExp(`^box-${TEST_INSTALLATION_ID}-copy-[0-9a-f]{8}$`));
  });

  it("passes an entrypoint when given, before the image, and none otherwise", async () => {
    const d = mkOnce();
    await d.once({ ...SPEC, entrypoint: "sh" });
    const a = d.created[0]!.args;
    expect(a.slice(a.indexOf("--entrypoint"), a.indexOf("--entrypoint") + 3)).toEqual(["--entrypoint", "sh", "img:1"]);
  });

  it("adds the extra capabilities after the limits, from a closed set only", async () => {
    const d = mkOnce();
    await d.once({ ...SPEC, caps: ["CHOWN", "FOWNER", "DAC_OVERRIDE", "FSETID"] });
    const a = d.created[0]!.args;
    const caps = a.flatMap((x, i) => (x === "--cap-add" ? [a[i + 1]] : []));
    expect(caps).toEqual(["CHOWN", "FOWNER", "DAC_OVERRIDE", "FSETID"]);
    expect(a.indexOf("--cap-add")).toBeGreaterThan(a.indexOf("--cap-drop"));
    const bad = mkOnce();
    await expect(bad.once({ ...SPEC, caps: ["SYS_ADMIN" as never] })).rejects.toThrow(/not one a one-shot container may have/);
    expect(bad.count("create")).toBe(0);
    await expect(bad.once({ ...SPEC, role: "x; rm" as never })).rejects.toThrow(/Unknown one-shot role/);
    expect(bad.count("create")).toBe(0);
  });

  it("starts attached by the id create printed, with the caller's timeout and cap, and returns what run reported", async () => {
    const d = mkOnce();
    d.startOutput = "out\n";
    const r = await d.once(SPEC);
    expect(r).toMatchObject({ code: 0, stdout: "out\n", timedOut: false, truncated: false });
    const i = d.argvs.findIndex((a) => a[0] === "start");
    expect(d.argvs[i]).toEqual(["start", "-a", d.created[0]!.id]);
    expect(d.optsList[i]).toEqual({ timeoutMs: 1234, maxBytes: 5678 });
    expect(d.optsList[d.argvs.findIndex((a) => a[0] === "create")]).toEqual({ timeoutMs: 60_000 });
  });

  const removed = (d: OneShotDocker) => d.argvs.filter((a) => a[0] === "rm");
  it.each([
    ["success", undefined],
    ["a non-zero exit", { code: 3, stderr: "boom" }],
    ["a timeout", { code: null as unknown as number, timedOut: true }],
  ] as Array<[string, Reply | undefined]>)("removes the container by id after %s", async (_n, r) => {
    const d = mkOnce();
    if (r) d.script.push((a) => (a[0] === "start" ? r : undefined));
    const res = await d.once(SPEC);
    if (r) expect(res).toMatchObject(r);
    expect(removed(d)).toEqual([["rm", "-f", d.created[0]!.id]]);
    expect(d.containers.has(d.created[0]!.name)).toBe(false);
    expect(d.verbs.at(-1)).toBe("rm");
  });

  it("removes the container by id when start throws, and the throw is the outcome", async () => {
    class StartThrows extends OneShotDocker {
      protected override async docker(args: string[], opts?: RunOptions) {
        if (args[0] === "start") {
          this.argvs.push(args);
          throw new Error("spawn docker ENOENT");
        }
        return super.docker(args, opts);
      }
    }
    const d = new StartThrows(loadConfig({}), TEST_INSTALLATION_ID);
    await expect(d.once(SPEC)).rejects.toThrow("spawn docker ENOENT");
    expect(removed(d)).toEqual([["rm", "-f", d.created[0]!.id]]);
  });

  it("treats 'No such container' from rm -f as success, and ignores any other rm failure", async () => {
    for (const stderr of ["Error response from daemon: No such container: x\n", "Error response from daemon: busy\n"]) {
      const d = mkOnce();
      d.script.push((a) => (a[0] === "rm" ? { code: 1, stderr } : undefined));
      expect(await d.once(SPEC)).toMatchObject({ code: 0 });
    }
    class RmThrows extends OneShotDocker {
      protected override async docker(args: string[], opts?: RunOptions) {
        if (args[0] === "rm") throw new Error("daemon gone");
        return super.docker(args, opts);
      }
    }
    expect(await new RmThrows(loadConfig({}), TEST_INSTALLATION_ID).once(SPEC)).toMatchObject({ code: 0 });
  });

  it("starts nothing and removes nothing when create fails", async () => {
    const d = mkOnce();
    d.script.push((a) => (a[0] === "create" ? { code: 125, stderr: "no space left\n" } : undefined));
    await expect(d.once(SPEC)).rejects.toThrow(/Could not create the scan container: no space left/);
    expect(d.count("start") + d.count("rm")).toBe(0);
  });

  it("removes by the call's own name when create times out, and fails as a creation failure", async () => {
    const d = mkOnce();
    d.script.push((a) => (a[0] === "create" ? { code: null as unknown as number, timedOut: true } : undefined));
    await expect(d.once(SPEC)).rejects.toThrow(/Could not create the scan container: docker create timed out/);
    const create = d.argvs.find((a) => a[0] === "create")!;
    const name = create[create.indexOf("--name") + 1]!;
    expect(name).toMatch(NAME_SHAPE);
    expect(d.argvs.filter((a) => a[0] === "rm")).toEqual([["rm", "-f", name]]);
    expect(d.count("start")).toBe(0);
  });

  it.each([["nothing", ""], ["a short id", "abc123\n"], ["a name", "mcpe-box\n"], ["capitals", `${"A".repeat(64)}\n`], ["two lines", `${"a".repeat(64)}\n${"b".repeat(64)}\n`]])(
    "rejects %s from create as the id, and starts nothing",
    async (_n, out) => {
      const d = mkOnce();
      d.script.push((a) => (a[0] === "create" ? { stdout: out } : undefined));
      await expect(d.once(SPEC)).rejects.toThrow(/Could not create the scan container: Docker printed no usable id/);
      expect(d.count("start") + d.count("rm")).toBe(0);
    },
  );
});

describe("probe's container and volume labels", () => {
  it("runs the clone as a one-shot container: role clone, bridge, the volume at /workspace, the same entrypoint, 600 s and 16 MB", async () => {
    const d = mk();
    const data = await d.probe(REPO, V, {});
    expect(data.commit).toBe("c".repeat(40));
    const c = d.created[0]!;
    expect(c.labels["mcp-everything.role"]).toBe("clone");
    expect(c.name).toMatch(new RegExp(`^mcpe-${TEST_INSTALLATION_ID}-clone-[0-9a-f]{8}$`));
    const a = c.args;
    expect(a.slice(a.indexOf("--network"), a.indexOf("--network") + 2)).toEqual(["--network", "bridge"]);
    expect(a.slice(a.indexOf("-v"), a.indexOf("-v") + 2)).toEqual(["-v", `${V}:/workspace`]);
    const i = a.indexOf("--entrypoint");
    expect(a.slice(i, i + 3)).toEqual(["--entrypoint", "sh", loadConfig({}).docker.probeImage]);
    expect(a.slice(i + 3, i + 4)).toEqual(["-c"]);
    expect(a[i + 5]).toBe("probe");
    expect(a.slice(i + 6, i + 9)).toEqual([REPO.cloneUrl, "", "0"]);
    const start = d.argvs.findIndex((x) => x[0] === "start");
    expect(d.optsList[start]).toEqual({ timeoutMs: 600_000, maxBytes: 16_000_000 });
    expect(d.count("run")).toBe(0);
  });

  it("takes a shorter timeout when a test gives one", async () => {
    const d = mk();
    await d.probe(REPO, V, { timeoutMs: 2000 });
    expect(d.optsList[d.argvs.findIndex((x) => x[0] === "start")]).toMatchObject({ timeoutMs: 2000 });
  });

  it("labels the volume as staging only when asked, and otherwise exactly as before", async () => {
    const plain = mk();
    await plain.probe(REPO, V, {});
    expect(plain.argvs.find((a) => a[0] === "volume" && a[1] === "create")).toEqual(["volume", "create", "--label", "mcp-everything=1", "--label", `mcp-everything.owner=${TEST_INSTALLATION_ID}`, V]);
    const staging = mk();
    await staging.probe(REPO, V, { volumeRole: "staging" });
    expect(staging.argvs.find((a) => a[0] === "volume" && a[1] === "create")).toEqual([
      "volume", "create", "--label", "mcp-everything=1", "--label", `mcp-everything.owner=${TEST_INSTALLATION_ID}`, "--label", "mcp-everything.role=staging", V,
    ]);
  });

  it("says a timed-out clone timed out, as a clone failure, and leaves no container", async () => {
    const d = mk();
    d.script.push((a) => (a[0] === "start" ? { code: null as unknown as number, timedOut: true } : undefined));
    await expect(d.probe(REPO, V, { timeoutMs: 2000 })).rejects.toThrow(/^Could not clone https:\/\/github.com\/o\/r.git:\ntimed out after 2s$/);
    expect(d.containers.size).toBe(0);
    expect(d.argvs.filter((a) => a[0] === "rm")).toEqual([["rm", "-f", d.created[0]!.id]]);
  });

  it("still reports a failed clone's stderr and a clone with no commit", async () => {
    const bad = mk();
    bad.script.push((a) => (a[0] === "start" ? { code: 128, stderr: "fatal: not found\n" } : undefined));
    await expect(bad.probe(REPO, V, { ref: "v1" })).rejects.toThrow(/Could not clone https:\/\/github.com\/o\/r.git at v1:\nfatal: not found/);
    const none = mk();
    none.startOutput = "";
    await expect(none.probe(REPO, V, {})).rejects.toThrow(/produced no commit/);
  });
});

describe("createContainer's volume and result", () => {
  const create = (d: ScriptedDocker) => d.createContainer({ name: N, volume: V, image: "img", project: "p" });

  it.each<SandboxClass>(["another", "not-ours"])("refuses a volume that is %s", async (cls) => {
    const d = mk();
    d.putVolume(V, cls);
    await expect(create(d)).rejects.toBeInstanceOf(SandboxRefusedError);
    expect(d.count("run")).toBe(0);
  });

  it("says a missing volume must be made first", async () => {
    const d = mk();
    const e = await settle(create(d));
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(SandboxRefusedError);
    expect(e).not.toBeInstanceOf(DockerUnavailableError);
    expect((e as Error).message).toMatch(/does not exist/);
    expect(d.count("run")).toBe(0);
  });

  it("says a volume from before cannot hold a new container", async () => {
    const d = mk();
    d.putVolume(V, "before");
    const e = await settle(create(d));
    expect(e).not.toBeInstanceOf(SandboxRefusedError);
    expect((e as Error).message).toMatch(/was made before ownership was recorded; it cannot hold/);
    expect(d.count("run")).toBe(0);
  });

  it("says Docker could not be asked", async () => {
    const d = mk();
    d.script.push((a) => (a[0] === "volume" ? { code: 1, stderr: "Cannot connect" } : undefined));
    await expect(create(d)).rejects.toBeInstanceOf(DockerUnavailableError);
    expect(d.count("run")).toBe(0);
  });

  it("returns a reference holding what docker run printed, trimmed, and the name", async () => {
    const d = mk();
    d.putVolume(V, "mine");
    d.runOutput = `${"ab12".repeat(16)}\n`;
    expect(await create(d)).toEqual({ id: "ab12".repeat(16), name: N });
  });

  it.each([["nothing", ""], ["a short id", "abc123\n"], ["a name", "mcpe-box\n"], ["capitals", `${"A".repeat(64)}\n`], ["two lines", `${"a".repeat(64)}\n${"b".repeat(64)}\n`], ["a warning first", `WARNING: x\n${"a".repeat(64)}\n`]])(
    "throws when docker run printed %s",
    async (_n, out) => {
      const d = mk();
      d.putVolume(V, "mine");
      d.runOutput = out;
      await expect(create(d)).rejects.toThrow(/no usable id/);
    },
  );
});

describe("the guard cannot be skipped unnoticed", () => {
  /**
   * Methods of the class that touch no sandbox, or are private helpers, or (runOnce) act only on the one
   * container they create themselves; each is judged by hand. The guarded table is for acting on caller-named sandboxes.
   */
  const NOT_GUARDED = [
    "assertAvailable", "ensureImage", "sandboxName", "docker", "imagePath", "limits", "ask", "isNotThere", "unreadable",
    "inspectContainer", "inspectVolume", "containerFacts", "volumeFacts", "refuseUnless", "resolveContainer", "startId",
    "doesNotExist", "startIfStopped", "execOnce", "look", "rmContainer",
    // Leg 6's private helpers of the guarded methods below (the name check, the volume creation, the role-aware volume check).
    "assertNameFree", "makeVolume", "requireVolumes",
    // Acts only on the one container it created itself, by the id `create` printed; the guarded table is for
    // acting on caller-named sandboxes. Callers classify the volumes they pass.
    "runOnce",
    // Leg 6: acts only on what it listed and re-verified by owner and role (the owner label equals this installation's
    // id on inspect, the role is in the allowlist, the age is known), never on a name a caller typed. Its own describe block.
    "sweepCheckLeftovers",
    // Leg 7: only forms a name from the prefix, the installation id and random bytes; issues no Docker command.
    "stagingName",
  ];
  /**
   * Methods that report instead of refusing: they never throw and issue only read-only commands, which the
   * test below checks for each. A method that acts on a sandbox does not belong here, and the guarded table
   * above is where it is judged.
   */
  const REPORTING = ["ownership"];
  const own = () =>
    Object.getOwnPropertyNames(Docker.prototype).filter((n) => n !== "constructor" && typeof Object.getOwnPropertyDescriptor(Docker.prototype, n)!.value === "function");

  it("the class's methods are exactly the guarded table plus the two written lists", () => {
    const methods = own();
    expect(methods.length).toBeGreaterThan(Object.keys(CASES).length);
    expect([...methods].sort()).toEqual([...Object.keys(CASES), ...NOT_GUARDED, ...REPORTING].sort());
  });

  // What this does not cover: a method that reports AND acts would pass the list but fail the read-only check
  // only if its test below reaches the acting path; each reporting method is judged by hand when it is added.
  describe("a method that reports", () => {
    const REPORTS: Record<string, (d: ScriptedDocker) => Promise<unknown>> = { ownership: (d) => d.ownership(N) };

    it("has a case for every method of the list, and no case for a method outside it", () => {
      expect(Object.keys(REPORTS).sort()).toEqual([...REPORTING].sort());
    });

    it.each(REPORTING)("%s says the class of each kind of container, on a double that accepts only inspects", async (method) => {
      for (const cls of ["mine", "before", "another", "not-ours"] as const) {
        const d = mk();
        d.strict = true;
        d.put(N, cls);
        const r = (await REPORTS[method]!(d)) as { state: string; owner?: string };
        expect(r.state, cls).toBe(cls);
        expect(r.owner, cls).toBe(cls === "another" ? OTHER_ID : undefined);
        expect(d.violations).toEqual([]);
        expect(d.verbs, cls).toEqual(["inspect"]);
      }
    });

    it.each(REPORTING)("%s says missing for a container that is not there, and unavailable (not missing) when Docker cannot say", async (method) => {
      const gone = mk();
      gone.strict = true;
      expect(await REPORTS[method]!(gone)).toEqual({ state: "missing" });
      for (const r of [
        { code: 1, stderr: "Cannot connect to the Docker daemon" },
        { code: null as unknown as number, timedOut: true },
        { stdout: "not json" },
        { stdout: "" },
        { stdout: "{}", truncated: true },
      ] as Reply[]) {
        const d = mk();
        d.strict = true;
        d.script.push(() => r);
        expect(await REPORTS[method]!(d)).toEqual({ state: "unavailable" });
        expect(d.violations).toEqual([]);
        expect(d.verbs).toEqual(["inspect"]);
      }
      class Throws extends ScriptedDocker {
        protected override async docker(): Promise<never> {
          throw new Error("spawn docker ENOENT");
        }
      }
      expect(await REPORTS[method]!(new Throws(loadConfig({}), TEST_INSTALLATION_ID))).toEqual({ state: "unavailable" });
    });

    it.each(REPORTING)("%s classifies with the function everything else uses: its answer for each label set is classifySandbox's", async (method) => {
      const odd: Labels[] = [
        { "mcp-everything": "1", "mcp-everything.owner": "" },
        { "mcp-everything": "2" },
        { "mcp-everything.owner": TEST_INSTALLATION_ID },
        {},
        ...Object.values(LABELS),
      ];
      for (const labels of odd) {
        const d = mk();
        d.containers.set(N, { id: idFor(N), running: true, labels, networks: [] });
        expect(((await REPORTS[method]!(d)) as { state: string }).state).toBe(classifySandbox(labels, TEST_INSTALLATION_ID));
      }
    });
  });

  it.each(Object.keys(CASES))("%s is refused against another's or not-ours sandbox, in every volume position, on a double that accepts only inspects", async (method) => {
    const c = CASES[method]!;
    const positions = c.resource === "volume" ? slots(c).map((_, i) => i) : [0];
    for (const position of positions) {
      for (const cls of ["another", "not-ours"] as const) {
        const d = mk();
        d.strict = true;
        setup(d, c, cls, position);
        const e = await settle(c.run(d));
        expect(d.violations, `${method} ${cls} at ${position}`).toEqual([]);
        expect(e, `${method} ${cls} at ${position}`).toBeInstanceOf(SandboxRefusedError);
        expect((e as SandboxRefusedError).reason).toBe(cls);
        expect(d.verbs.some((v) => v === "inspect" || v === "volume inspect")).toBe(true);
      }
    }
  });

  it.each(Object.keys(CASES))("%s does not refuse a sandbox that is mine", async (method) => {
    const c = CASES[method]!;
    const d = mk();
    setup(d, c, "mine");
    expect(await settle(c.run(d))).not.toBeInstanceOf(SandboxRefusedError);
  });

  it("every exec, start, rm and network command names a 64-character id, never a name", async () => {
    const seen = new Set<string>();
    for (const cls of ["mine", "before"] as const) {
      for (const [method, c] of Object.entries(CASES)) {
        const d = mk();
        setup(d, c, cls);
        if (c.resource === "container") d.putVolume(V, cls);
        await settle(c.run(d));
        // and by reference, for the methods that accept one
        const ref = { id: idFor(`${N}-ref`), name: N };
        d.put(N, cls, { running: false, networks: ["bridge"] });
        d.containers.get(N)!.id = ref.id;
        for (const f of [() => d.exec(ref, ["true"], OPTS), () => d.ensureRunning(ref), () => d.setNetwork(ref, false)]) await settle(f());
        d.execReplies = [{ code: 1, stderr: DAEMON }];
        d.containers.get(N)!.running = false;
        await settle(d.exec(ref, ["true"], OPTS));
        for (const a of d.argvs) {
          let where: string | undefined;
          if (a[0] === "exec") where = a[2] === "-w" ? a[4] : a[2];
          else if (a[0] === "start") where = a.at(-1);
          else if (a[0] === "rm") where = a.at(-1);
          else if (a[0] === "network") where = a.at(-1);
          if (where === undefined) continue;
          seen.add(a[0]!);
          expect(where, `${cls} ${method}: ${a.join(" ")}`).toMatch(/^[0-9a-f]{64}$/);
        }
      }
    }
    expect([...seen].sort()).toEqual(["exec", "network", "rm", "start"]);
  });
});

// ---------------------------------------------------------------------------
// The clone's walk (leg 5)
// ---------------------------------------------------------------------------

describe("walkArguments", () => {
  it("is exactly the prune names, then one quadruple per build-file pattern", () => {
    expect(walkArguments()).toEqual([
      "7",
      ".git", "node_modules", "target", "vendor", ".venv", "venv", "__pycache__",
      "name", "package.json", "0", "0",
      "name", "binding.gyp", "0", "0",
      "name", ".pnpmfile.cjs", "1", "0",
      "name", ".yarnrc.yml", "1", "0",
      "name", ".yarnrc", "1", "0",
      "name", ".npmrc", "1", "0",
      "name", "pnpm-lock.yaml", "1", "1",
      "name", "yarn.lock", "1", "1",
      "name", "setup.py", "1", "0",
      "name", "setup.cfg", "1", "0",
      "name", "pyproject.toml", "1", "0",
      "name", "hatch.toml", "1", "0",
      "name", "hatch_build.py", "1", "0",
      "name", "requirements.txt", "1", "0",
      "name", "meson.build", "1", "0",
      "name", "meson.options", "1", "0",
      "name", "meson_options.txt", "1", "0",
      "name", "Cargo.toml", "0", "0",
      "name", "build.rs", "0", "0",
      "path", ".cargo/config.toml", "1", "0",
      "path", ".cargo/config", "1", "0",
      "name", "CMakeLists.txt", "0", "0",
      "glob", "*.cmake", "0", "0",
      "name", "configure", "1", "0",
      "name", "configure.ac", "1", "0",
      "name", "Makefile.am", "1", "0",
      "name", "Makefile.in", "1", "0",
      "glob", "*.m4", "1", "0",
      "name", "Makefile", "0", "0",
      "name", "makefile", "0", "0",
      "name", "GNUmakefile", "0", "0",
      "glob", "*.mk", "0", "0",
      "name", "Gemfile", "1", "0",
      "glob", "*.gemspec", "1", "0",
      "name", "extconf.rb", "0", "0",
      "name", "Rakefile", "0", "0",
    ]);
  });

  it("holds no shell-special character other than the glob *, and a glob only for -name", () => {
    const a = walkArguments();
    const n = Number(a[0]);
    const rest = a.slice(1 + n);
    expect(rest.length % 4).toBe(0);
    for (const x of [...a.slice(1, 1 + n), ...rest.filter((_, i) => i % 4 === 1)]) expect(x).toMatch(/^[A-Za-z0-9._*/-]+$/);
    for (let i = 0; i < rest.length; i += 4) {
      expect(["name", "glob", "path"]).toContain(rest[i]);
      expect(["0", "1"]).toContain(rest[i + 2]);
      expect(["0", "1"]).toContain(rest[i + 3]);
      if (rest[i] !== "glob") expect(rest[i + 1]).not.toContain("*");
    }
  });

  it("marks exactly the two lockfiles for presence only", () => {
    const all = walkArguments();
    const rest = all.slice(1 + Number(all[0]));
    const marked: string[] = [];
    for (let i = 0; i < rest.length; i += 4) if (rest[i + 3] === "1") marked.push(rest[i + 1]!);
    expect(marked).toEqual(["pnpm-lock.yaml", "yarn.lock"]);
  });
});

describe("parseProbeOutput: the walk", () => {
  const b = (s: string) => Buffer.from(s).toString("base64");
  const HEAD = `HEAD ${"a".repeat(40)}\n`;

  it("always has a walk", () => {
    expect(parseProbeOutput(HEAD).walk).toEqual({ files: [] });
  });

  it("reads BUILD lines: path, truncation flag and UTF-8 content, with an empty file valid", () => {
    const w = parseProbeOutput(`${HEAD}BUILD ${b("a/b.json")} 0 ${b("café")}\nBUILD ${b("big")} 1 ${b("xx")}\nBUILD ${b("empty")} 0 \n`).walk;
    expect(w.files).toEqual([
      { path: "a/b.json", content: "café" },
      { path: "big", content: "xx", truncated: true },
      { path: "empty", content: "" },
    ]);
    expect(w.incomplete).toBeUndefined();
  });

  it("ignores malformed BUILD, LINK and INCOMPLETE lines", () => {
    const bad = [
      `BUILD ${b("x")} 0`, // three parts
      `BUILD ${b("x")} 0 ${b("y")} extra`, // five parts
      `BUILD ${b("x")} 2 ${b("y")}`, // bad flag
      `BUILD ${b("x")}  ${b("y")}`, // empty flag
      ` BUILD ${b("x")} 0 ${b("y")}`, // no trimming
      `BUILD ${b("x")} 0 ${b("y")} `, // a trailing space makes five parts
      `LINK`, `LINK a b`, `INCOMPLETE`, `INCOMPLETE files extra`, `INCOMPLETE nonsense`, `INCOMPLETE FILES`, `link ${b("x")}`,
    ];
    expect(parseProbeOutput(`${HEAD}${bad.join("\n")}\n`).walk).toEqual({ files: [] });
  });

  it("reads LINK lines and keeps the first INCOMPLETE reason", () => {
    const w = parseProbeOutput(`${HEAD}LINK ${b("setup.py")}\nINCOMPLETE depth\nLINK ${b("x/y")}\nINCOMPLETE files\n`).walk;
    expect(w.skippedLinks).toEqual(["setup.py", "x/y"]);
    expect(w.incomplete).toBe("depth");
  });

  it.each(["pattern", "newline", "depth", "files", "bytes", "walk"])("accepts the reason %s", (r) => {
    expect(parseProbeOutput(`${HEAD}INCOMPLETE ${r}\n`).walk.incomplete).toBe(r);
  });

  it("does not trim lines: a carriage return spoils the reason", () => {
    expect(parseProbeOutput(`${HEAD}INCOMPLETE files\r\n`).walk.incomplete).toBeUndefined();
  });

  it("drops the last, possibly partial, line of truncated output and says incomplete: output", () => {
    const w = parseProbeOutput(`${HEAD}BUILD ${b("a")} 0 ${b("one")}\nBUILD ${b("b")} 0 ${b("two")}`.slice(0, -3), true).walk;
    expect(w.files).toEqual([{ path: "a", content: "one" }]);
    expect(w.incomplete).toBe("output");
    // The cut wins over an earlier reason.
    expect(parseProbeOutput(`${HEAD}INCOMPLETE pattern\nBUILD ${b("a")} 0 ${b("o")}\nBUI`, true).walk.incomplete).toBe("output");
  });

  it("leaves FILE and ENTRY handling as it was", () => {
    const d = parseProbeOutput(`${HEAD}ENTRY d ${b("src")}\nFILE package.json ${b("{}")}\nFILE other ${b("x")}\n`);
    expect(d.entries).toEqual([{ name: "src", dir: true }]);
    expect(d.files).toEqual({ "package.json": "{}" });
  });
});

describe("probe passes the separator and the walk's arguments after the manifests", () => {
  it("puts --walk-- after every manifest, then the walk's arguments", async () => {
    const d = mk();
    await d.probe(REPO, V, {});
    const a = d.created[0]!.args;
    const i = a.indexOf("probe");
    const tail = a.slice(i + 4);
    const sep = tail.indexOf(WALK_SEPARATOR);
    expect(WALK_SEPARATOR).toBe("--walk--");
    expect(sep).toBeGreaterThan(0);
    expect(tail.slice(0, sep)).toContain("package.json");
    expect(tail.slice(0, sep)).not.toContain("--walk--");
    expect(tail.slice(sep + 1)).toEqual(walkArguments());
    // The script is the clone followed by the walk.
    expect(a[i - 1]).toContain('"--walk--"');
    expect(a[i - 1]).toContain(WALK_SCRIPT);
  });
});

/** The walk run in the host's own sh over a scratch directory (the integration case runs it in the pinned image). */
describe("the walk script, in a local shell", () => {
  const hasSh = fs.existsSync("/bin/sh");
  const head = `HEAD ${"a".repeat(40)}\n`;
  const exec = (dir: string) => {
    const script = WALK_SCRIPT.replace("cd /workspace/repo", `cd '${dir}'`);
    return execFileSync("/bin/sh", ["-c", script, "walk", ...walkArguments()], { encoding: "utf8", maxBuffer: 64_000_000 });
  };
  const withDir = (fn: (dir: string) => void) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-walk-"));
    try {
      fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const put = (dir: string, rel: string, content: string | Buffer = "x\n") => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  const walkOf = (raw: string) => parseProbeOutput(head + raw).walk;
  const it2 = (name: string, fn: () => void) => it.skipIf(!hasSh)(name, { timeout: 60_000 }, fn);

  it2("reads the root and nested package.json, prunes node_modules, and does not follow a link", () => {
    withDir((dir) => {
      put(dir, "package.json", '{"r":1}');
      put(dir, "sub/package.json", '{"s":1}');
      put(dir, "node_modules/x/package.json", "{}");
      fs.writeFileSync(path.join(dir, "secret"), "s");
      fs.symlinkSync(path.join(dir, "secret"), path.join(dir, "setup.py"));
      const w = walkOf(exec(dir));
      expect(w.files.map((f) => f.path)).toEqual(["package.json", "sub/package.json"]);
      expect(w.skippedLinks).toEqual(["setup.py"]);
      expect(w.incomplete).toBeUndefined();
    });
  });

  it2("reports a nested link that a find pattern matches, and never reads it", () => {
    withDir((dir) => {
      fs.writeFileSync(path.join(dir, "outside"), "secret");
      put(dir, "sub/x", "x");
      fs.symlinkSync(path.join(dir, "outside"), path.join(dir, "sub/package.json"));
      fs.symlinkSync("sub", path.join(dir, "linkdir"));
      const w = walkOf(exec(dir));
      expect(w.files).toEqual([]);
      expect(w.skippedLinks).toEqual(["sub/package.json"]);
    });
  });

  it2("reads root-only entries only at the root, once, and prints nothing for an empty tree", () => {
    withDir((dir) => {
      put(dir, ".cargo/config.toml", "a");
      put(dir, "nested/.cargo/config.toml", "b");
      put(dir, "nested/setup.py", "c");
      put(dir, "setup.py", "d");
      expect(walkOf(exec(dir)).files.map((f) => f.path).sort()).toEqual([".cargo/config.toml", "setup.py"]);
    });
    withDir((dir) => {
      expect(exec(dir)).toBe("");
    });
  });

  it2("reads a 5 MB pnpm-lock.yaml for presence only: empty, not truncated, no budget used", () => {
    withDir((dir) => {
      put(dir, "pnpm-lock.yaml", Buffer.alloc(5_000_000, 97));
      put(dir, "yarn.lock", "y");
      for (let i = 0; i < 30; i++) put(dir, `d${i}/Makefile`, Buffer.alloc(70_000, 98));
      const raw = exec(dir);
      const w = walkOf(raw);
      expect(w.files.find((f) => f.path === "pnpm-lock.yaml")).toEqual({ path: "pnpm-lock.yaml", content: "" });
      expect(w.files.find((f) => f.path === "yarn.lock")).toEqual({ path: "yarn.lock", content: "" });
      expect(w.files.filter((f) => f.path.endsWith("Makefile"))).toHaveLength(30);
      expect(w.incomplete).toBeUndefined();
      expect(raw.length).toBeLessThan(3_500_000);
    });
  });

  it2("reports a presence-only lockfile that is a link, and reads none that is not a file", () => {
    withDir((dir) => {
      fs.symlinkSync("/etc/hostname", path.join(dir, "yarn.lock"));
      fs.mkdirSync(path.join(dir, "pnpm-lock.yaml"));
      const w = walkOf(exec(dir));
      expect(w.files).toEqual([]);
      expect(w.skippedLinks).toEqual(["yarn.lock"]);
    });
  });

  it2("truncates a file over 64 KB at 64 KB and flags it", () => {
    withDir((dir) => {
      put(dir, "configure", Buffer.alloc(70_000, 99));
      put(dir, "Makefile", Buffer.alloc(65_536, 100));
      const w = walkOf(exec(dir));
      const c = w.files.find((f) => f.path === "configure")!;
      expect(c.truncated).toBe(true);
      expect(c.content).toHaveLength(65_536);
      const m = w.files.find((f) => f.path === "Makefile")!;
      expect(m.truncated).toBeUndefined();
      expect(m.content).toHaveLength(65_536);
    });
  });

  it2("reports a directory name with a newline as INCOMPLETE newline and skips what is inside it", () => {
    withDir((dir) => {
      put(dir, "package.json", "{}");
      put(dir, "a\nb/package.json", "{}");
      put(dir, "a\n./package.json", "{}");
      const raw = exec(dir);
      expect(raw.split("\n")).toContain("INCOMPLETE newline");
      expect(walkOf(raw).files.map((f) => f.path)).toEqual(["package.json"]);
    });
  });

  it2("reports INCOMPLETE depth for a match below the depth limit, and none at the limit", () => {
    withDir((dir) => {
      put(dir, "a/b/c/d/e/f/g/Makefile", "x"); // depth 8: read
      const ok = exec(dir);
      expect(ok).not.toContain("INCOMPLETE");
      expect(walkOf(ok).files).toHaveLength(1);
    });
    withDir((dir) => {
      put(dir, "a/b/c/d/e/f/g/h/Makefile", "x"); // depth 9: not read
      expect(exec(dir).split("\n")).toContain("INCOMPLETE depth");
    });
  });

  it2("caps a pattern at 40 files with INCOMPLETE pattern, and still exits 0 when head closes the pipe early", () => {
    withDir((dir) => {
      for (let i = 0; i < 300; i++) put(dir, `m/f${i}.cmake`, "x");
      const lines = exec(dir).split("\n"); // execFileSync throws on a non-zero exit
      expect(lines).toContain("INCOMPLETE pattern");
      expect(lines.filter((l) => l.startsWith("BUILD "))).toHaveLength(40);
    });
  });

  it2("enforces the file budget, reading the root package.json first", () => {
    withDir((dir) => {
      put(dir, "package.json", '{"root":1}');
      for (const n of ["package.json", "Cargo.toml", "build.rs", "binding.gyp", "CMakeLists.txt", "Rakefile"]) {
        for (let i = 0; i < 40; i++) put(dir, `d${i}/${n}`, "x");
      }
      const raw = exec(dir);
      const w = walkOf(raw);
      expect(w.files).toHaveLength(200);
      expect(raw.split("\n")).toContain("INCOMPLETE files");
      expect(w.files[0]).toEqual({ path: "package.json", content: '{"root":1}' });
    });
  });

  it2("enforces the byte budget", () => {
    withDir((dir) => {
      for (let i = 0; i < 40; i++) put(dir, `d${i}/x.mk`, Buffer.alloc(70_000, 97));
      const raw = exec(dir);
      const w = walkOf(raw);
      expect(w.files).toHaveLength(32); // 32 x 64 KB is exactly 2 MB
      expect(w.files.every((f) => f.truncated === true)).toBe(true);
      expect(raw.split("\n")).toContain("INCOMPLETE bytes");
    });
  });

  it2("keeps the root match of a pattern inside its cap when nested ones are more than 40", () => {
    withDir((dir) => {
      for (let i = 0; i < 60; i++) put(dir, `A${i}/Makefile`, "x");
      put(dir, "Makefile", "root\n");
      const w = walkOf(exec(dir));
      expect(w.files[0]).toEqual({ path: "Makefile", content: "root\n" });
      expect(w.incomplete).toBe("pattern");
    });
  });

  it2("treats file names as data: no expansion, no command substitution", () => {
    withDir((dir) => {
      // A stray file here would make the final check pass vacuously.
      expect(fs.existsSync(path.resolve("pwned"))).toBe(false);
      put(dir, "a.cmake", "x");
      put(dir, "$(touch pwned).cmake", "x");
      put(dir, "x;y.cmake", "x");
      const w = walkOf(exec(dir));
      expect(w.files.map((f) => f.path).sort()).toEqual(["$(touch pwned).cmake", "a.cmake", "x;y.cmake"]);
      expect(fs.existsSync(path.join(dir, "pwned"))).toBe(false);
      expect(fs.existsSync(path.resolve("pwned"))).toBe(false);
    });
  });

  it2("is silent about a tree with no matches", () => {
    withDir((dir) => {
      put(dir, "README", "x");
      expect(exec(dir)).toBe("");
    });
  });
});

/** The whole clone-and-walk script against a local git repository, with /workspace redirected to a scratch directory. */
describe("the whole probe script, in a local shell", () => {
  const hasTools = fs.existsSync("/bin/sh") && (() => { try { execFileSync("git", ["--version"]); return true; } catch { return false; } })();
  it.skipIf(!hasTools)("prints each manifest once, none outside MANIFESTS, and the walk's files after the separator split", { timeout: 60_000 }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-probe-"));
    try {
      const src = path.join(root, "src");
      fs.mkdirSync(src);
      fs.writeFileSync(path.join(src, "package.json"), '{"a":1}');
      fs.writeFileSync(path.join(src, "Makefile"), "all:\n");
      fs.writeFileSync(path.join(src, "go.mod"), "module x\n");
      fs.mkdirSync(path.join(src, "sub"));
      fs.writeFileSync(path.join(src, "sub", "Makefile"), "all:\n");
      const git = (...a: string[]) => execFileSync("git", ["-C", src, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "pipe" });
      git("init", "--quiet");
      git("add", ".");
      git("commit", "--quiet", "-m", "x");
      const ws = path.join(root, "ws");
      fs.mkdirSync(ws);
      const probeScript = PROBE_SCRIPT.split("/workspace").join(ws);
      const out = execFileSync("/bin/sh", ["-c", probeScript, "probe", src, "", "0", ...MANIFESTS, WALK_SEPARATOR, ...walkArguments()], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const names = out.split("\n").filter((l) => l.startsWith("FILE ")).map((l) => l.split(" ")[1]!);
      expect(names.sort()).toEqual(["Makefile", "go.mod", "package.json"]);
      for (const n of names) expect(MANIFESTS).toContain(n);
      const data = parseProbeOutput(out);
      expect(data.walk.files.map((f) => f.path).sort()).toEqual(["Makefile", "package.json", "sub/Makefile"]);
      expect(data.walk.incomplete).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Scanners, the copy and the leftovers sweep (leg 6)
// ---------------------------------------------------------------------------

describe("runScanner", () => {
  const stage = (d: ScriptedDocker, cls: SandboxClass = "mine", role: string | null = "staging") => d.putVolume(STAGING, cls, role ?? undefined);

  it("runs the image's own entrypoint with the command, no network, the volume read-only at /scan, in /scan/repo, capped at 8 MB", async () => {
    const d = mk();
    stage(d);
    await d.runScanner(STAGING, SCANNER, { timeoutMs: 20_000 });
    const a = d.created[0]!.args;
    expect(d.created[0]!.labels["mcp-everything.role"]).toBe("scan");
    expect(a).not.toContain("--entrypoint");
    expect(a).not.toContain("-v");
    expect(a).not.toContain("--env-file");
    expect(a).not.toContain("--cap-add");
    expect(a.slice(a.indexOf("--network"), a.indexOf("--network") + 2)).toEqual(["--network", "none"]);
    expect(a.slice(a.indexOf("--mount"), a.indexOf("--mount") + 2)).toEqual(["--mount", `type=volume,src=${STAGING},dst=/scan,readonly`]);
    expect(a.filter((x) => x === "--mount")).toHaveLength(1);
    expect(a.slice(a.indexOf("-w"), a.indexOf("-w") + 2)).toEqual(["-w", "/scan/repo"]);
    expect(a.slice(-4)).toEqual(["scan:1", "scan", "--sarif", "."]);
    const i = d.argvs.findIndex((x) => x[0] === "start");
    expect(d.optsList[i]).toEqual({ timeoutMs: 20_000, maxBytes: 8_000_000 });
  });

  it("uses the bridge network only when the scanner is configured for one, and passes the env file before the image", async () => {
    const d = mk();
    stage(d);
    await d.runScanner(STAGING, { ...SCANNER, network: true }, { timeoutMs: 20_000, envFile: "/data/tmp/env-0123456789abcdef" });
    const a = d.created[0]!.args;
    expect(a.slice(a.indexOf("--network"), a.indexOf("--network") + 2)).toEqual(["--network", "bridge"]);
    expect(a.slice(a.indexOf("--env-file"), a.indexOf("--env-file") + 2)).toEqual(["--env-file", "/data/tmp/env-0123456789abcdef"]);
    expect(a.indexOf("--env-file")).toBeLessThan(a.indexOf("scan:1"));
  });

  it.each<[string, (d: ScriptedDocker) => void, RegExp | undefined]>([
    ["another's", (d) => stage(d, "another"), undefined],
    ["not mcp-everything's", (d) => stage(d, "not-ours"), undefined],
    ["missing", () => undefined, /does not exist/],
    ["from before ownership", (d) => stage(d, "before"), /before ownership/],
    ["without a role", (d) => stage(d, "mine", null), /not a staging volume/],
    ["a sandbox volume's role", (d) => stage(d, "mine", "sandbox"), /not a staging volume/],
  ])("throws for a volume that is %s, and creates no container", async (_n, set, text) => {
    const d = mk();
    set(d);
    const e = await settle(d.runScanner(STAGING, SCANNER, { timeoutMs: 20_000 }));
    expect(e).toBeInstanceOf(Error);
    if (text) {
      expect(e).not.toBeInstanceOf(SandboxRefusedError);
      expect((e as Error).message).toMatch(text);
    } else {
      expect(e).toBeInstanceOf(SandboxRefusedError);
    }
    expect(d.count("create")).toBe(0);
    expect(d.count("start")).toBe(0);
  });
});

describe("copyVolume", () => {
  const both = (d: ScriptedDocker) => {
    d.putVolume(STAGING, "mine", "staging");
    d.putVolume(TARGET, "mine");
  };

  it("runs cp -a from the clone image: no network, the four capabilities, the source read-only, a 300 s limit", async () => {
    const d = mk();
    both(d);
    await d.copyVolume(STAGING, TARGET);
    const a = d.created[0]!.args;
    expect(d.created[0]!.labels["mcp-everything.role"]).toBe("copy");
    const caps = a.flatMap((x, i) => (x === "--cap-add" ? [a[i + 1]] : []));
    expect(caps).toEqual(["CHOWN", "FOWNER", "DAC_OVERRIDE", "FSETID"]);
    expect(a.slice(a.indexOf("--network"), a.indexOf("--network") + 2)).toEqual(["--network", "none"]);
    expect(a.slice(a.indexOf("--entrypoint"), a.indexOf("--entrypoint") + 2)).toEqual(["--entrypoint", "cp"]);
    const mounts = a.flatMap((x, i) => (x === "-v" ? [a[i + 1]] : []));
    expect(mounts).toEqual([`${STAGING}:/from:ro`, `${TARGET}:/to`]);
    expect(a.slice(-4)).toEqual([loadConfig({}).docker.probeImage, "-a", "/from/.", "/to/"]);
    expect(d.optsList[d.argvs.findIndex((x) => x[0] === "start")]!.timeoutMs).toBe(300_000);
  });

  it.each<[string, (d: ScriptedDocker) => void, boolean]>([
    ["the source is another's", (d) => { both(d); d.putVolume(STAGING, "another", "staging"); }, true],
    ["the target is another's", (d) => { both(d); d.putVolume(TARGET, "another"); }, true],
    ["the source is from before ownership", (d) => { both(d); d.putVolume(STAGING, "before", "staging"); }, false],
    ["the target is from before ownership", (d) => { both(d); d.putVolume(TARGET, "before"); }, false],
    ["the source has no role", (d) => { both(d); d.putVolume(STAGING, "mine"); }, false],
    ["the target has a role", (d) => { both(d); d.putVolume(TARGET, "mine", "staging"); }, false],
    ["the source is missing", (d) => d.putVolume(TARGET, "mine"), false],
    ["the target is missing", (d) => d.putVolume(STAGING, "mine", "staging"), false],
  ])("throws when %s, and creates no container", async (_n, set, refusal) => {
    const d = mk();
    set(d);
    const e = await settle(d.copyVolume(STAGING, TARGET));
    expect(e).toBeInstanceOf(Error);
    expect(e instanceof SandboxRefusedError).toBe(refusal);
    expect(d.count("create")).toBe(0);
  });

  it("throws with the cleaned stderr tail on a non-zero exit, and on a timeout", async () => {
    const d = mk();
    both(d);
    d.script.push((a) => (a[0] === "start" ? { code: 1, stderr: "cp: \u001b[31mcannot\u001b[0m stat '/from/x'\nPermission denied\n" } : undefined));
    await expect(d.copyVolume(STAGING, TARGET)).rejects.toThrow("Could not copy the checkout: cp: cannot stat '/from/x' Permission denied");
    const t = mk();
    both(t);
    t.script.push((a) => (a[0] === "start" ? { code: null as unknown as number, timedOut: true } : undefined));
    await expect(t.copyVolume(STAGING, TARGET)).rejects.toThrow(/timed out after 300s/);
  });
});

describe("createSandboxVolume", () => {
  it("creates an owned volume with the generic and owner labels and no role", async () => {
    const d = mk();
    await d.createSandboxVolume(TARGET);
    const create = d.argvs.find((a) => a[0] === "volume" && a[1] === "create")!;
    expect(create).toEqual(["volume", "create", "--label", "mcp-everything=1", "--label", `mcp-everything.owner=${TEST_INSTALLATION_ID}`, TARGET]);
  });

  it("refuses a name that exists: another's by refusal, this installation's by a plain error, and creates nothing", async () => {
    for (const cls of ["another", "not-ours"] as const) {
      const d = mk();
      d.putVolume(TARGET, cls);
      expect(await settle(d.createSandboxVolume(TARGET))).toBeInstanceOf(SandboxRefusedError);
      expect(d.count("volume create")).toBe(0);
    }
    const d = mk();
    d.putVolume(TARGET, "mine");
    await expect(d.createSandboxVolume(TARGET)).rejects.toThrow(/already exists/);
    expect(d.count("volume create")).toBe(0);
  });
});

describe("stagingName and removeStagingVolume", () => {
  it("stagingName is prefix, installation id, -stg-, eight hex digits; fresh each time; no command", () => {
    const d = mk();
    const a = d.stagingName();
    expect(a).toMatch(new RegExp(`^mcpe-${TEST_INSTALLATION_ID}-stg-[0-9a-f]{8}$`));
    expect(d.stagingName()).not.toBe(a);
    expect(d.argvs).toEqual([]);
  });

  it("removes a staging volume of this installation by its name", async () => {
    const d = mk();
    d.putVolume(STAGING, "mine", "staging");
    await d.removeStagingVolume(STAGING);
    expect(d.argvs.find((a) => a[0] === "volume" && a[1] === "rm")).toEqual(["volume", "rm", "-f", STAGING]);
  });

  it("a volume that is not there is success and nothing is removed", async () => {
    const d = mk();
    await d.removeStagingVolume(STAGING);
    expect(d.count("volume rm")).toBe(0);
  });

  it("leaves a volume of this installation that is not a staging volume: no role, another role, or from before", async () => {
    for (const [cls, role] of [["mine", undefined], ["mine", "other"], ["before", undefined]] as const) {
      const d = mk();
      d.putVolume(STAGING, cls, role);
      await expect(d.removeStagingVolume(STAGING)).rejects.toBeInstanceOf(VolumeNotUsableError);
      expect(d.count("volume rm")).toBe(0);
    }
  });

  it("a failed removal says so", async () => {
    const d = mk();
    d.putVolume(STAGING, "mine", "staging");
    d.script.push((a) => (a[0] === "volume" && a[1] === "rm" ? { code: 1, stderr: "volume in use" } : undefined));
    await expect(d.removeStagingVolume(STAGING)).rejects.toThrow(/Failed to remove volume/);
  });
});

describe("sweepCheckLeftovers", () => {
  const HOUR = 3600_000;
  const iso = (agoMs: number, offset = "Z") => new Date(Date.now() - agoMs).toISOString().replace("Z", offset);
  const cid = (n: number) => String(n).repeat(64).slice(0, 64);
  interface C { id: string; labels: Record<string, string>; created: string }
  interface Vol { name: string; labels: Record<string, string>; created: string }
  const mine = { "mcp-everything": "1", "mcp-everything.owner": TEST_INSTALLATION_ID };
  const role = (r: string, extra: Record<string, string> = mine) => ({ ...extra, "mcp-everything.role": r });

  /** A daemon with the given containers and volumes; `ps` and `volume ls` list them all, whatever the filters (the sweep must re-verify). */
  function world(cs: C[], vs: Vol[], more: Array<(a: string[]) => { code?: number; stderr?: string; stdout?: string } | undefined> = []) {
    const d = mk();
    d.script.push((a) => {
      for (const m of more) {
        const r = m(a);
        if (r) return r;
      }
      if (a[0] === "ps") return { stdout: cs.map((c) => `${c.id}\n`).join("") };
      if (a[0] === "volume" && a[1] === "ls") return { stdout: vs.map((v) => `${v.name}\n`).join("") };
      if (a[0] === "inspect") {
        const c = cs.find((x) => x.id === a.at(-1));
        return c ? { stdout: JSON.stringify({ id: c.id, labels: c.labels, created: c.created }) } : { code: 1, stderr: "Error response from daemon: No such container: x" };
      }
      if (a[0] === "volume" && a[1] === "inspect") {
        const v = vs.find((x) => x.name === a.at(-1));
        return v ? { stdout: JSON.stringify({ labels: v.labels, created: v.created }) } : { code: 1, stderr: "Error: No such volume: x" };
      }
      return undefined;
    });
    return d;
  }

  it("lists by this installation's owner label and the presence of a role label, with full ids", async () => {
    const d = world([], []);
    await d.sweepCheckLeftovers(60);
    expect(d.argvs).toContainEqual(["ps", "-a", "--no-trunc", "--filter", `label=mcp-everything.owner=${TEST_INSTALLATION_ID}`, "--filter", "label=mcp-everything.role", "--format", "{{.ID}}"]);
    expect(d.argvs).toContainEqual(["volume", "ls", "--filter", `label=mcp-everything.owner=${TEST_INSTALLATION_ID}`, "--filter", "label=mcp-everything.role=staging", "--format", "{{.Name}}"]);
  });

  it("removes an old copy container by its full id and an old staging volume by name, with a UTC offset in the volume's age", async () => {
    const d = world(
      [{ id: cid(1), labels: role("copy"), created: iso(2 * HOUR) }, { id: cid(2), labels: role("scan"), created: iso(2 * HOUR) }, { id: cid(3), labels: role("clone"), created: iso(2 * HOUR) }],
      [{ name: "mcpe-x-stage", labels: role("staging"), created: iso(2 * HOUR, "+00:00") }],
    );
    const r = await d.sweepCheckLeftovers(3600);
    expect(r).toEqual({ removed: [cid(1), cid(2), cid(3), "mcpe-x-stage"], failures: 0 });
    expect(d.argvs.filter((a) => a[0] === "rm")).toEqual([cid(1), cid(2), cid(3)].map((i) => ["rm", "-f", i]));
    expect(d.argvs).toContainEqual(["volume", "rm", "-f", "mcpe-x-stage"]);
  });

  it("leaves what it must: a sandbox with no role, another owner's scan container, an unlisted role, a young staging volume", async () => {
    const d = world(
      [
        { id: cid(1), labels: mine, created: iso(5 * HOUR) },
        { id: cid(2), labels: role("scan", { "mcp-everything": "1", "mcp-everything.owner": OTHER_ID }), created: iso(5 * HOUR) },
        { id: cid(3), labels: role("sandbox"), created: iso(5 * HOUR) },
        { id: cid(4), labels: role("scan"), created: iso(10_000) },
      ],
      [
        { name: "young", labels: role("staging"), created: iso(10_000) },
        { name: "theirs", labels: role("staging", { "mcp-everything": "1", "mcp-everything.owner": OTHER_ID }), created: iso(5 * HOUR) },
        { name: "norole", labels: mine, created: iso(5 * HOUR) },
        { name: "other-role", labels: role("sandbox"), created: iso(5 * HOUR) },
      ],
    );
    expect(await d.sweepCheckLeftovers(3600)).toEqual({ removed: [], failures: 0 });
    expect(d.count("rm")).toBe(0);
    expect(d.count("volume rm")).toBe(0);
  });

  it("skips what is gone by the time it is inspected or removed, and counts a failed inspect or remove without throwing", async () => {
    const old = iso(2 * HOUR);
    const d = world(
      [{ id: cid(1), labels: role("copy"), created: old }, { id: cid(2), labels: role("scan"), created: old }, { id: cid(3), labels: role("scan"), created: old }, { id: cid(4), labels: role("clone"), created: "not a date" }],
      [{ name: "v1", labels: role("staging"), created: old }, { name: "v2", labels: role("staging"), created: old }],
      [
        (a) => (a[0] === "inspect" && a.at(-1) === cid(1) ? { code: 1, stderr: "Error response from daemon: No such container: x" } : undefined),
        (a) => (a[0] === "inspect" && a.at(-1) === cid(2) ? { code: 1, stderr: "Cannot connect to the Docker daemon" } : undefined),
        (a) => (a[0] === "rm" && a.at(-1) === cid(3) ? { code: 1, stderr: "Error: No such container: x" } : undefined),
        (a) => (a[0] === "volume" && a[1] === "rm" && a.at(-1) === "v1" ? { code: 1, stderr: "volume is in use" } : undefined),
      ],
    );
    const r = await d.sweepCheckLeftovers(3600);
    // cid(1) gone: skipped; cid(2) failed inspect: failure; cid(3) gone at removal: skipped; cid(4) NaN age: failure; v1 in use: failure; v2 removed.
    expect(r).toEqual({ removed: ["v2"], failures: 3 });
    expect(d.argvs.filter((a) => a[0] === "rm").map((a) => a.at(-1))).toEqual([cid(3)]);
  });

  it("counts a failed listing and keeps going; an owner label that differs on inspect keeps the item", async () => {
    const d = world(
      [{ id: cid(1), labels: role("scan", { "mcp-everything": "1", "mcp-everything.owner": OTHER_ID }), created: iso(2 * HOUR) }],
      [{ name: "v", labels: role("staging"), created: iso(2 * HOUR) }],
      [(a) => (a[0] === "volume" && a[1] === "ls" ? { code: 1, stderr: "boom" } : undefined)],
    );
    expect(await d.sweepCheckLeftovers(3600)).toEqual({ removed: [], failures: 1 });
    expect(d.count("rm")).toBe(0);
  });

  it("never throws when Docker cannot be run at all", async () => {
    class Throws extends ScriptedDocker {
      protected override async docker(): Promise<never> {
        throw new Error("spawn docker ENOENT");
      }
    }
    const r = await new Throws(loadConfig({}), TEST_INSTALLATION_ID).sweepCheckLeftovers(0);
    expect(r).toEqual({ removed: [], failures: 2 });
  });
});

describe("runScanner and copyVolume on volumes that are mine with their roles", () => {
  it("do not throw", async () => {
    const d = mk();
    d.putVolume(STAGING, "mine", "staging");
    d.putVolume(TARGET, "mine");
    await d.runScanner(STAGING, SCANNER, { timeoutMs: 20_000 });
    await d.copyVolume(STAGING, TARGET);
    expect(d.count("create")).toBe(2);
  });
});
