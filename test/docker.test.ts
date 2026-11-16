import { describe, expect, it, vi, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";
import { Docker, isStoppedExecFailure, watchdogPollSec, type ExecResult } from "../src/sandbox/docker.js";

type Reply = Partial<ExecResult>;
const reply = (r: Reply): ExecResult => ({ code: 0, stdout: "", stderr: "", timedOut: false, truncated: false, ...r });

/** Docker whose binary is never run: records argv and answers by argv. */
class ScriptedDocker extends Docker {
  argvs: string[][] = [];
  execReplies: Reply[] = [];
  ensureCalls = 0;
  ensureResult: boolean | Error = true;
  onEnsure?: () => void;
  /** Replies by first argument (inspect, version, network), ahead of the defaults. */
  replies: Record<string, Reply> = {};

  protected override async docker(args: string[]) {
    this.argvs.push(args);
    if (args[0]! in this.replies) return reply(this.replies[args[0]!]!);
    if (args[0] === "image") return reply({ stdout: "[]" });
    if (args[0] === "exec") return reply(this.execReplies.shift() ?? {});
    return reply({});
  }
  override async ensureRunning(): Promise<boolean> {
    this.ensureCalls++;
    this.onEnsure?.();
    if (this.ensureResult instanceof Error) throw this.ensureResult;
    return this.ensureResult;
  }
  get execs() {
    return this.argvs.filter((a) => a[0] === "exec");
  }
}

const mk = (env: Record<string, string> = {}) => new ScriptedDocker(loadConfig(env));
const OPTS = { timeoutSec: 10 };
const DAEMON = "Error response from daemon: container abc123 is not running\n";
const STOPPED_STATE = "cannot exec in a stopped state\n";
const OCI = "OCI runtime exec failed: exec failed: cannot exec in a stopped container\n";

describe("createContainer", () => {
  const runArgs = async (env: Record<string, string>) => {
    const d = mk(env);
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
    expect(pairs("--label")).toEqual(expect.arrayContaining(["mcp-everything=1", "mcp-everything.project=p"]));
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

  it.each([
    ["daemon line", { code: 1, stderr: DAEMON }],
    ["stopped state", { code: 128, stdout: STOPPED_STATE }],
    ["OCI line", { code: 128, stdout: OCI }],
  ])("restarts and retries once: %s", async (_n, first) => {
    const d = mk();
    d.execReplies = [first, { code: 0, stdout: "ok" }];
    const res = await d.exec("c", ["true"], OPTS);
    expect(res.stdout).toBe("ok");
    expect(d.ensureCalls).toBe(1);
    expect(d.execs).toHaveLength(2);
  });

  it("makes at most two attempts", async () => {
    const d = mk();
    d.execReplies = [{ code: 1, stderr: DAEMON }, { code: 1, stderr: DAEMON }, { code: 0 }];
    const res = await d.exec("c", ["true"], OPTS);
    expect(res.code).toBe(1);
    expect(d.execs).toHaveLength(2);
    expect(d.ensureCalls).toBe(1);
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
    const d = mk();
    d.execReplies = [first, { code: 0 }];
    await d.exec("c", ["true"], OPTS);
    expect(d.execs).toHaveLength(1);
    expect(d.ensureCalls).toBe(0);
  });

  it("returns the first result when the container is gone", async () => {
    const d = mk();
    d.ensureResult = false;
    d.execReplies = [{ code: 1, stderr: DAEMON }, { code: 0 }];
    const res = await d.exec("c", ["true"], OPTS);
    expect(res.code).toBe(1);
    expect(d.execs).toHaveLength(1);
  });

  it("propagates a failed restart without a second attempt", async () => {
    const d = mk();
    d.ensureResult = new Error("Failed to start sandbox c: boom");
    d.execReplies = [{ code: 1, stderr: DAEMON }, { code: 0 }];
    await expect(d.exec("c", ["true"], OPTS)).rejects.toThrow(/Failed to start sandbox/);
    expect(d.execs).toHaveLength(1);
  });

  it("times the second attempt from its own start", async () => {
    const d = mk();
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    d.onEnsure = () => {
      now += 60_000; // the restart takes longer than the call's limit
    };
    d.execReplies = [{ code: 1, stderr: DAEMON }, { code: 137 }];
    const res = await d.exec("c", ["true"], { timeoutSec: 10 });
    expect(res.code).toBe(137);
    expect(res.timedOut).toBe(false);
  });

  it("does not restart when asked not to", async () => {
    const d = mk();
    d.execReplies = [{ code: 1, stderr: DAEMON }, { code: 0 }];
    const res = await d.exec("c", ["true"], { ...OPTS, restart: false });
    expect(res.code).toBe(1);
    expect(d.execs).toHaveLength(1);
    expect(d.ensureCalls).toBe(0);
  });
});

describe("setNetwork(container, false)", () => {
  const verbs = (d: ScriptedDocker) => d.argvs.map((a) => a.slice(0, 2).join(" "));

  it("returns without detaching when the container is gone and the daemon answers", async () => {
    const d = mk();
    d.replies.inspect = { code: 1, stderr: "Error: No such object: gone" };
    d.replies.version = { stdout: "27.0.0\n" };
    await d.setNetwork("gone", false);
    expect(verbs(d)).toContain("version --format");
    expect(verbs(d)).not.toContain("network disconnect");
  });

  it("rejects when the networks cannot be read and the daemon does not answer", async () => {
    const d = mk();
    d.replies.inspect = { code: 1, stderr: "Cannot connect to the Docker daemon" };
    d.replies.version = { code: 1, stderr: "Cannot connect to the Docker daemon" };
    await expect(d.setNetwork("box", false)).rejects.toThrow(/Failed to disable network for box: Docker daemon is not reachable/);
    expect(verbs(d)).not.toContain("network disconnect");
  });

  it("rejects when the inspect and the daemon probe both time out", async () => {
    const d = mk();
    d.replies.inspect = { code: null as unknown as number, timedOut: true };
    d.replies.version = { code: null as unknown as number, timedOut: true };
    await expect(d.setNetwork("box", false)).rejects.toThrow(/Failed to disable network for box/);
  });

  it("disconnects when the container has a network", async () => {
    const d = mk();
    d.replies.inspect = { stdout: "bridge \n" };
    await d.setNetwork("box", false);
    expect(d.argvs.find((a) => a[0] === "network")).toEqual(["network", "disconnect", "bridge", "box"]);
  });

  it("does nothing more when the inspect succeeded and listed no network", async () => {
    const d = mk();
    d.replies.inspect = { stdout: "\n" };
    await d.setNetwork("box", false);
    expect(verbs(d)).not.toContain("network disconnect");
    expect(verbs(d)).not.toContain("version --format");
  });
});
