import { describe, expect, it, vi, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";
import { TEST_INSTALLATION_ID } from "./helpers.js";
import { createHash } from "node:crypto";
import {
  classifySandbox,
  Docker,
  DockerUnavailableError,
  isStoppedExecFailure,
  SandboxRefusedError,
  watchdogPollSec,
  type ExecResult,
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

  protected override async docker(args: string[]) {
    this.argvs.push(args);
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
      case "start": {
        const found = this.find(args[1]!);
        if (!found) return { code: 1, stderr: "Error response from daemon: No such container\n" };
        found[1].running = true;
        return { stdout: `${args[1]}\n` };
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
  putVolume(name: string, cls: SandboxClass): void {
    this.volumes.set(name, LABELS[cls]);
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
};
/** Setup: the resource of the case in a class. */
function setup(d: ScriptedDocker, c: MethodCase, cls: SandboxClass): string | undefined {
  if (c.resource === "volume") {
    d.putVolume(V, cls);
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
      expect(r.message).toContain(c === "mine" ? "this installation's" : c === "before" ? "from before" : c === "another" ? "another installation's" : "not created by mcp-everything");
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
    expect(d.count("run")).toBe(1);
  });

  it.each<SandboxClass>(["another", "not-ours"])("refuses a volume that is %s", async (cls) => {
    const d = mk();
    d.putVolume(V, cls);
    await expect(probe(d)).rejects.toBeInstanceOf(SandboxRefusedError);
    expect(d.count("volume create") + d.count("run")).toBe(0);
  });

  it.each<SandboxClass>(["mine", "before"])("says a volume that is %s already exists", async (cls) => {
    const d = mk();
    d.putVolume(V, cls);
    const e = await settle(probe(d));
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(SandboxRefusedError);
    expect(e).not.toBeInstanceOf(DockerUnavailableError);
    expect((e as Error).message).toMatch(/already exists/);
    expect(d.count("volume create") + d.count("run")).toBe(0);
  });

  it("says Docker could not be asked", async () => {
    const d = mk();
    d.script.push((a) => (a[0] === "volume" ? { code: 1, stderr: "Cannot connect" } : undefined));
    await expect(probe(d)).rejects.toBeInstanceOf(DockerUnavailableError);
    expect(d.count("volume create") + d.count("run")).toBe(0);
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
    expect((e as Error).message).toMatch(/from before/);
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
  /** Methods of the class that touch no sandbox, or are private helpers; each is judged by hand. */
  const NOT_GUARDED = [
    "assertAvailable", "ensureImage", "sandboxName", "docker", "imagePath", "limits", "ask", "isNotThere", "unreadable",
    "inspectContainer", "inspectVolume", "containerFacts", "volumeFacts", "refuseUnless", "resolveContainer", "startId",
    "doesNotExist", "startIfStopped", "execOnce", "look", "rmContainer",
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

  it.each(Object.keys(CASES))("%s is refused against another's sandbox on a double that accepts only inspects", async (method) => {
    const c = CASES[method]!;
    const d = mk();
    d.strict = true;
    setup(d, c, "another");
    const e = await settle(c.run(d));
    expect(d.violations).toEqual([]);
    expect(e).toBeInstanceOf(SandboxRefusedError);
    expect(d.verbs.some((v) => v === "inspect" || v === "volume inspect")).toBe(true);
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
          else if (a[0] === "start") where = a[1];
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
