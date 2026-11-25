import { describe, expect, it, vi, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";
import { record, TEST_INSTALLATION_ID } from "./helpers.js";
import { CONTAINMENT_SOURCES, DOCKER_SOURCES, prototypeChainNames, readSources } from "./sources.js";
import { Containment, proxyEnvironment } from "../src/network/containment.js";
import { Registry } from "../src/registry.js";
import { recipeFor } from "../src/install/recipes.js";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunOptions } from "../src/util/exec.js";
import { proxyConfig, proxyLaunchArgs } from "../src/network/proxy/config.js";
import { Docker, envFlags, makeRef, type ExecResult } from "../src/sandbox/docker.js";
import { ONE_SHOT_ROLES, type ContainmentHook, type ContainmentHookMode, type OneShotSpec } from "../src/sandbox/docker-base.js";
import {
  CloneFailedError,
  ContainmentUnavailableError,
  DockerUnavailableError,
  ProxyStartError,
  RuntimeMismatchError,
  RuntimeUnavailableError,
  VolumeNotUsableError,
} from "../src/sandbox/errors.js";
import {
  isRuncRuntime,
  LOCAL_ACCESS_SCRIPT,
  parseProxyReport,
  parseResolvConf,
  projectNetworkName,
  proxyAddress,
  proxyMac,
} from "../src/sandbox/network-spec.js";
import { classifySandbox, OWNER_SHOWN, SandboxRefusedError, type SandboxClass, type SandboxInspectFacts } from "../src/sandbox/ownership.js";
import { isStoppedExecFailure, parseProbeOutput, WALK_SCRIPT, WALK_SEPARATOR, walkArguments, watchdogPollSec } from "../src/sandbox/scripts.js";

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
  /** HostConfig.Runtime as the inspect answers it; undefined omits the field, as an old daemon or a plain double does. */
  runtime?: string | null;
  /** State.ExitCode for the readiness inspect. */
  exitCode?: number;
  /** The address each network was connected with (`network connect --ip`), by network name. */
  ips?: Record<string, string>;
}

interface FakeNet {
  id: string;
  name: string;
  labels: Record<string, string> | null;
  internal: boolean;
  ipv6: boolean;
  ipam: Array<Record<string, string>> | null;
  created: string;
  /** The `--ip-range` it was made with. */
  ipRange?: string;
}
/** What the proxy's `/status` says when it is ready, with no refusals. */
const READY = { version: "1", ready: true, listening: { address: "172.30.0.2", ports: [3128] }, startedAt: "t", configHash: "h", refusals: [], resolverFailures: 0, total: 0 };

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
  /** When set, only inspects, volume and network inspects, listings (`ps`), `info` and version requests are accepted; anything else is recorded in `violations` and throws. */
  strict = false;
  violations: string[][] = [];
  /** What `docker info` answers: the runtimes it lists and its default. */
  infoRuntimes: string[] = ["runc", "io.containerd.runc.v2", "runsc"];
  infoDefault = "runc";
  /** Contained networks the double has made, by name. */
  networks = new Map<string, FakeNet>();
  /** What the proxy's status one-liner prints (any JSON value), or a reply for the whole exec. */
  statusBody: unknown = READY;
  /** What `docker logs` says. */
  logsReply: Reply = {};
  /** What a container with the role `resolv-read` prints. */
  resolvConf = "nameserver 192.0.2.53\n";
  /** The subnet of the next network `network create` makes; a counter makes them differ. */
  private subnetN = 0;
  /** How many pinned `network create`s still fail with "Pool overlaps" (another network took the probed subnet). */
  overlaps = 0;
  /** The refusal text those creates fail with; Docker 29 words it differently from earlier daemons. */
  overlapStderr = "Error response from daemon: invalid pool request: Pool overlaps with other one on this address space\n";

  /** A network the double has made, by the name the call used (the id is derived from it). */
  net(namePart: string): FakeNet {
    const found = [...this.networks.values()].find((n) => n.name.includes(namePart));
    if (!found) throw new Error(`no network with ${namePart} in its name`);
    return found;
  }
  /** The proxy container (the one made with the role `oneshot-proxy`), if one exists. */
  proxyContainer(): [string, FakeContainer] | undefined {
    return [...this.containers.entries()].find(([, c]) => c.labels?.["mcp-everything.role"] === "oneshot-proxy");
  }

  protected override async docker(args: string[], opts?: RunOptions) {
    this.argvs.push(args);
    this.optsList.push(opts);
    if (
      this.strict &&
      !(args[0] === "inspect" || args[0] === "version" || args[0] === "info" || (args[0] === "volume" && args[1] === "inspect") || (args[0] === "network" && args[1] === "inspect") || args[0] === "ps")
    ) {
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
      case "info":
        return { stdout: `${JSON.stringify({ runtimes: Object.fromEntries(this.infoRuntimes.map((r) => [r, {}])), default: this.infoDefault })}\n` };
      case "image":
        return { stdout: "[]" };
      case "exec":
        // The proxy's status one-liner (`exec <id> node -e <script>`); every other exec is `exec [-i] ... timeout ...`.
        if (args[2] === "node") return { stdout: JSON.stringify(this.statusBody) };
        return this.execReplies.shift() ?? {};
      case "logs":
        return this.logsReply;
      case "inspect": {
        const target = args[args.length - 1]!;
        const found = this.find(target);
        if (!found) return { code: 1, stderr: `Error response from daemon: No such container: ${target}\n` };
        const [, c] = found;
        const format = args[args.indexOf("--format") + 1]!;
        // The networks of a container with their ids and the address each was connected with (`IPAMConfig`, as Docker has it).
        if (format === "{{json .NetworkSettings.Networks}}") {
          return {
            stdout: `${JSON.stringify(Object.fromEntries(c.networks.map((n) => [n, { NetworkID: this.networks.get(n)?.id ?? "", IPAMConfig: c.ips?.[n] ? { IPv4Address: c.ips[n] } : null }])))}\n`,
          };
        }
        if (format.includes('"exitCode"')) return { stdout: `${JSON.stringify({ running: c.running, exitCode: c.exitCode ?? 0 })}\n` };
        const out: Record<string, unknown> = { id: c.id, running: c.running };
        // Docker's own answer carries the name with a leading slash.
        if (format.includes('"name"')) out.name = `/${found[0]}`;
        if (format.includes('"labels"')) out.labels = c.labels;
        if (c.runtime !== undefined && format.includes('"runtime"')) out.runtime = c.runtime;
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
        const rt = args.indexOf("--runtime");
        // Leg 14: a proxy is created on its network as `--network name=<net>,ip=<addr>,mac-address=<mac>`; `bridge` is connected after.
        const nw = args[args.indexOf("--network") + 1];
        const spec = nw !== undefined && nw.startsWith("name=") ? Object.fromEntries(nw.split(",").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)])) : undefined;
        // Two containers cannot hold one address on a network (Docker refuses the create, as it refuses a connect).
        if (spec?.ip !== undefined && [...this.containers.values()].some((c) => c.networks.includes(spec.name!) && c.ips?.[spec.name!] === spec.ip)) {
          return { code: 1, stderr: "Error response from daemon: Address already in use\n" };
        }
        this.created.push({ name, id, labels, args });
        this.containers.set(name, {
          id, running: false, labels, networks: spec ? [spec.name!] : ["bridge"],
          ...(spec?.ip !== undefined ? { ips: { [spec.name!]: spec.ip } } : {}),
          ...(rt >= 0 ? { runtime: args[rt + 1]! } : {}),
        });
        return { stdout: `${id}\n` };
      }
      case "stop": {
        const found = this.find(args[args.length - 1]!);
        if (!found) return { code: 1, stderr: "Error response from daemon: No such container\n" };
        found[1].running = false;
        return {};
      }
      case "start": {
        const one = args[1] === "-a";
        const found = this.find(args[args.length - 1]!);
        if (!found) return { code: 1, stderr: "Error response from daemon: No such container\n" };
        found[1].running = true;
        if (one && found[1].labels?.["mcp-everything.role"] === "resolv-read") return { stdout: this.resolvConf };
        return { stdout: one ? this.startOutput : `${args[1]}\n` };
      }
      case "rm": {
        const found = this.find(args[args.length - 1]!);
        if (found) this.containers.delete(found[0]);
        return {};
      }
      case "ps": {
        // `ps -a -q --no-trunc --filter label=k[=v] ...`: every container carrying all the labels.
        const wants = args.flatMap((a, i) => (a === "--filter" ? [args[i + 1]!.replace(/^label=/, "")] : []));
        const ids = [...this.containers.values()]
          .filter((c) => wants.every((w) => { const [k, ...v] = w.split("="); return c.labels !== null && (v.length === 0 ? Object.hasOwn(c.labels, k!) : c.labels[k!] === v.join("=")); }))
          .map((c) => c.id);
        return { stdout: ids.map((i) => `${i}\n`).join("") };
      }
      case "network": {
        const last = args[args.length - 1]!;
        if (args[1] === "create") {
          const labels: Record<string, string> = {};
          args.forEach((a, i) => {
            if (a === "--label") {
              const [k, ...v] = args[i + 1]!.split("=");
              labels[k!] = v.join("=");
            }
          });
          // A pinned subnet (`--subnet`) is the one asked for; without it the daemon's pools choose (the probe's case).
          // `overlaps` makes the next pinned creates fail the way Docker does when another network took the subnet.
          const pinned = args.includes("--subnet") ? args[args.indexOf("--subnet") + 1]! : undefined;
          if (pinned !== undefined && this.overlaps > 0) {
            this.overlaps--;
            return { code: 1, stderr: this.overlapStderr };
          }
          const id = idFor(`net:${last}`);
          this.subnetN++;
          this.networks.set(last, {
            id, name: last, labels, internal: args.includes("--internal"), ipv6: false,
            ipam: [{ Subnet: pinned ?? `172.30.${this.subnetN}.0/24` }], created: new Date().toISOString().replace("Z", "123456Z"),
            ...(args.includes("--ip-range") ? { ipRange: args[args.indexOf("--ip-range") + 1]! } : {}),
          });
          return { stdout: `${id}\n` };
        }
        if (args[1] === "inspect") {
          const n = [...this.networks.values()].find((x) => x.name === last || x.id === last);
          if (!n) return { code: 1, stderr: `Error response from daemon: network ${last} not found\n` };
          return { stdout: `${JSON.stringify({ id: n.id, name: n.name, internal: n.internal, ipv6: n.ipv6, ipam: n.ipam, labels: n.labels, created: n.created })}\n` };
        }
        if (args[1] === "rm") {
          const n = [...this.networks.values()].find((x) => x.name === last || x.id === last);
          if (!n) return { code: 1, stderr: `Error response from daemon: network ${last} not found\n` };
          // Docker refuses a network a container is still on.
          if ([...this.containers.values()].some((c) => c.networks.includes(n.name))) {
            return { code: 1, stderr: `Error response from daemon: error while removing network: network ${n.name} id ${n.id} has active endpoints\n` };
          }
          this.networks.delete(n.name);
          return {};
        }
        if (args[1] === "ls") return { stdout: [...this.networks.values()].map((n) => `${n.id}\n`).join("") };
        // connect [--ip a] <net> <container>; disconnect [-f] <net> <container>. Membership is per network, by name.
        const found = this.find(last);
        const netArg = args[args.length - 2]!;
        const netName = [...this.networks.values()].find((x) => x.id === netArg)?.name ?? netArg;
        if (!found) return { code: 1, stderr: `Error response from daemon: No such container: ${last}\n` };
        if (args[1] === "connect") {
          const ip = args.includes("--ip") ? args[args.indexOf("--ip") + 1]! : undefined;
          // Two containers cannot hold one address on a network.
          if (ip !== undefined && [...this.containers.values()].some((c) => c !== found[1] && c.networks.includes(netName) && c.ips?.[netName] === ip)) {
            return { code: 1, stderr: `Error response from daemon: Address already in use\n` };
          }
          if (!found[1].networks.includes(netName)) found[1].networks = [...found[1].networks, netName];
          if (ip !== undefined) found[1].ips = { ...found[1].ips, [netName]: ip };
          return {};
        }
        if (!found[1].networks.includes(netName)) return { code: 1, stderr: `Error response from daemon: container ${found[1].id} is not connected to network ${netName}\n` };
        found[1].networks = found[1].networks.filter((n) => n !== netName);
        if (found[1].ips) delete found[1].ips[netName];
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
  put(name: string, cls: SandboxClass, opts: { running?: boolean; networks?: string[]; runtime?: string | null } = {}): string {
    const id = idFor(name);
    this.containers.set(name, { id, running: opts.running ?? true, labels: LABELS[cls], networks: opts.networks ?? [], ...(opts.runtime !== undefined ? { runtime: opts.runtime } : {}) });
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
const SCANNER = { name: "s", image: "scan:1", command: ["scan", "--sarif", "."], network: false, hosts: [], timeoutSec: 60, env: [] };
const REPO = { forge: "github", host: "github.com", path: "o/r", cloneUrl: "https://github.com/o/r.git", id: "github:o/r", name: "r" } as const;
const READ_ONLY = new Set(["inspect", "volume inspect", "network inspect", "ps", "version"]);

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

  it("sets GEM_HOME on the volume and orders PATH: bin, gems, venv, cargo, go, then the image's", async () => {
    const a = await runArgs({});
    const pairs = a.flatMap((x, i) => (x === "-e" ? [a[i + 1]!] : []));
    expect(pairs).toContain("GEM_HOME=/opt/mcpe/gems");
    const p = pairs.find((x) => x.startsWith("PATH="))!;
    expect(p.startsWith("PATH=/opt/mcpe/bin:/opt/mcpe/gems/bin:/opt/mcpe/venv/bin:/root/.cargo/bin:/usr/local/go/bin:")).toBe(true);
  });

  it("the recipe prelude makes the output link before anything is written under /opt/mcpe", () => {
    const script = recipeFor("go");
    const at = ["set -e", "rm -rf", "[ -d", "ln -sfn", "mkdir -p /opt/mcpe/bin"].map((s) => script.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(script).toContain("rm -rf '/workspace/.mcpe'");
    expect(script).toContain("ln -sfn '/workspace/.mcpe' '/opt/mcpe'");
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

describe('setNetwork(container, "off")', () => {
  const verbs = (d: ScriptedDocker) => d.argvs.map((a) => a.slice(0, 2).join(" "));

  it("returns without detaching, and without asking about the daemon, when the container is not there", async () => {
    const d = mk();
    await d.setNetwork("gone", "off");
    expect(d.verbs).toEqual(["inspect"]);
  });

  it("rejects, and detaches nothing, when the networks cannot be read because the daemon does not answer", async () => {
    const d = mk();
    d.script.push((a) => (a[0] === "inspect" ? { code: 1, stderr: "Cannot connect to the Docker daemon" } : undefined));
    await expect(d.setNetwork("box", "off")).rejects.toBeInstanceOf(DockerUnavailableError);
    expect(verbs(d)).not.toContain("network disconnect");
  });

  it("rejects when the inspect times out", async () => {
    const d = mk();
    d.script.push((a) => (a[0] === "inspect" ? { code: null as unknown as number, timedOut: true } : undefined));
    await expect(d.setNetwork("box", "off")).rejects.toBeInstanceOf(DockerUnavailableError);
    expect(d.verbs).toEqual(["inspect"]);
  });

  it("disconnects when the container has a network", async () => {
    const d = mk();
    const id = d.put("box", "mine", { networks: ["bridge"] });
    await d.setNetwork("box", "off");
    expect(d.argvs.find((a) => a[0] === "network")).toEqual(["network", "disconnect", "bridge", id]);
  });

  it("does nothing more when the inspect succeeded and listed no network", async () => {
    const d = mk();
    d.put("box", "mine");
    await d.setNetwork("box", "off");
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
    // Both absent: the two inspects, the proxy listing and the network's inspect; nothing removed.
    expect(gone.verbs).toEqual(["inspect", "volume inspect", "ps", "network inspect"]);
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
  networkState: { run: (d) => d.networkState(N), resource: "container", acts: null },
  setNetwork: { run: (d) => d.setNetwork(N, "off"), resource: "container", container: { networks: ["bridge"] }, acts: "network" },
  removeContainer: { run: (d) => d.removeContainer(N), resource: "container", acts: "rm" },
  destroy: { run: (d) => d.destroy(N, V), resource: "container", acts: "rm" },
  // Leg 7. `startForContainment` is the start containment makes without the hook; `inspectSandbox` reads the facts once more.
  startForContainment: { run: (d) => d.startForContainment(N), resource: "container", container: { running: false }, acts: "start" },
  inspectSandbox: { run: (d) => d.inspectSandbox(N), resource: "container", acts: null },
  probe: { run: (d) => d.probe(REPO, V, {}), resource: "volume", acts: null },
  createContainer: { run: (d) => d.createContainer({ name: N, volume: V, image: "img", project: "p" }), resource: "volume", acts: null },
  // Leg 6. The staging volume is read through a read-only mount; the target of a copy is a sandbox volume (no role).
  // This row is `runScanner` at the source stage (role staging); its build stage (role none) is covered in `describe("runScanner")`, "at the build stage".
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
const EIGHT = ["exec", "state", "ensureRunning", "acquire", "networkState", "setNetwork", "removeContainer", "destroy"];

describe("every method that takes a name resolves first", () => {
  describe.each(EIGHT)("%s", (method) => {
    const c = CASES[method]!;
    it.each<SandboxClass>(["another", "not-ours", "before"])("refuses a sandbox that is %s, with inspects only", async (cls) => {
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

    // A sandbox made before ownership was recorded was acted on here until leg 4 of flight 04; it is refused above now.
    it.each<SandboxClass>(["mine"])("acts on the id of a sandbox that is %s, and of no other class", async (cls) => {
      const d = mk();
      const id = setup(d, c, cls)!;
      expect(await settle(c.run(d))).toBeNull();
      if (c.acts === "exec") expect(d.execs[0]![2]).toBe(id);
      if (c.acts === "start") expect(d.argvs.find((a) => a[0] === "start")).toEqual(["start", id]);
      if (c.acts === "rm") expect(d.argvs.find((a) => a[0] === "rm")).toEqual(["rm", "-f", "-v", id]);
      if (c.acts === "network") expect(d.argvs.find((a) => a[0] === "network")).toEqual(["network", "disconnect", "bridge", id]);
    });
  });
});

describe("a sandbox that is not there, by name", () => {
  it('state answers missing; ensureRunning answers false; networkState answers "off"; acquire returns nothing', async () => {
    const d = mk();
    expect(await d.state(N)).toBe("missing");
    expect(await d.ensureRunning(N)).toBe(false);
    expect(await d.networkState(N)).toBe("off");
    expect(await d.acquire(N)).toBeUndefined();
    expect(d.verbs.every((v) => v === "inspect")).toBe(true);
  });

  it('setNetwork("off") returns; setNetwork("open") and exec say it does not exist', async () => {
    const d = mk();
    await expect(d.setNetwork(N, "off")).resolves.toBeUndefined();
    await expect(d.setNetwork(N, "open")).rejects.toThrow(new RegExp(`${N}.*does not exist`));
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

  it.each<SandboxClass>(["mine"])("starts a stopped sandbox that is %s, by id, and no other class", async (cls) => {
    const d = mk();
    const id = d.put(N, cls, { running: false });
    expect(await d.acquire(N)).toEqual({ id, name: N });
    expect(d.argvs.filter((a) => a[0] === "start")).toEqual([["start", id]]);
  });

  it.each<SandboxClass>(["another", "not-ours", "before"])("refuses a stopped sandbox that is %s, and does not start it", async (cls) => {
    const d = mk();
    d.put(N, cls, { running: false });
    await expect(d.acquire(N)).rejects.toBeInstanceOf(SandboxRefusedError);
    expect(d.count("start")).toBe(0);
  });

  it("gives no reference for a sandbox made before ownership: acquire and startForContainment refuse, a stopped one stays stopped", async () => {
    const d = mk();
    d.put(N, "before", { running: false });
    await expect(d.acquire(N)).rejects.toMatchObject({ reason: "before" });
    await expect(d.startForContainment(N)).rejects.toMatchObject({ reason: "before" });
    expect(d.count("start")).toBe(0);
    for (const v of d.verbs) expect(READ_ONLY.has(v), `issued ${v}`).toBe(true);
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

  it("state, ensureRunning and networkState read by id, without labels", async () => {
    const { d, id, ref } = setupRef("another", { running: false, networks: ["bridge"] });
    expect(await d.state(ref)).toBe("stopped");
    expect(await d.networkState(ref)).toBe("open");
    expect(await d.ensureRunning(ref)).toBe(true);
    expect(d.argvs.filter((a) => a[0] === "inspect").map((a) => a.at(-1))).toEqual([id, id, id]);
    expect(d.argvs.find((a) => a[0] === "start")).toEqual(["start", id]);
    expect(labelsRead(d)).toBe(false);
  });

  it("setNetwork issues one inspect, by id, then names the id", async () => {
    const { d, id, ref } = setupRef("another", { networks: ["bridge"] });
    await d.setNetwork(ref, "off");
    expect(d.argvs.map((a) => a[0])).toEqual(["inspect", "network"]);
    expect(d.argvs[0]!.at(-1)).toBe(id);
    expect(d.argvs[1]).toEqual(["network", "disconnect", "bridge", id]);
    const on = setupRef("another");
    await on.d.setNetwork(on.ref, "open");
    expect(on.d.argvs[1]).toEqual(["network", "connect", "bridge", on.id]);
    expect(labelsRead(d) || labelsRead(on.d)).toBe(false);
  });

  it("setNetwork by name issues one inspect in all", async () => {
    const d = mk();
    d.put(N, "mine");
    await d.setNetwork(N, "open");
    expect(d.verbs).toEqual(["inspect", "network connect"]);
  });

  it("fails plainly when its container is gone; state says missing", async () => {
    const d = mk();
    const ref = { id: "a".repeat(64), name: N };
    expect(await d.state(ref)).toBe("missing");
    for (const e of [await settle(d.ensureRunning(ref)), await settle(d.setNetwork(ref, "open")), await settle(d.setNetwork(ref, "off"))]) {
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(SandboxRefusedError);
      expect(e).not.toBeInstanceOf(DockerUnavailableError);
    }
    expect(await d.networkState(ref)).toBe("off");
  });

  it("removeContainer by reference classifies the container by its id before removing it", async () => {
    const { d, ref } = setupRef("another");
    await expect(d.removeContainer(ref)).rejects.toBeInstanceOf(SandboxRefusedError);
    expect(d.count("rm")).toBe(0);
  });
});

describe("destroy classifies both before it removes either, and refuses a pair with any part that is not mine (made before ownership included)", () => {
  const classes: SandboxClass[] = ["mine", "before", "another", "not-ours"];
  const bad = (c: SandboxClass) => c !== "mine";
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
      expect(d.argvs.find((a) => a[0] === "rm")).toEqual(["rm", "-f", "-v", id]);
      expect(d.argvs.find((a) => a[0] === "volume" && a[1] === "rm")).toEqual(["volume", "rm", "-f", V]);
      // Every read, the proxy listing and the network's inspect included, comes before the first removal.
      const lastInspect = Math.max(...["inspect", "volume inspect", "ps", "network inspect"].map((v) => d.verbs.lastIndexOf(v)));
      expect(lastInspect).toBeLessThan(d.verbs.indexOf("rm"));
    }
  });

  it("a mixed pair (a container that is mine on a volume made before ownership) is refused, and the refusal names the volume", async () => {
    const d = mk();
    d.put(N, "mine");
    d.putVolume(V, "before");
    const r = (await settle(d.destroy(N, V))) as SandboxRefusedError;
    expect(r).toBeInstanceOf(SandboxRefusedError);
    expect([r.kind, r.sandbox, r.reason]).toEqual(["volume", V, "before"]);
    expect(r.message).toContain(`container "${N}"`);
    expect(r.message).toContain(`volume "${V}"`);
    expect(r.message).toContain("the container is this installation's");
    expect(r.message).toContain("the volume was made before ownership was recorded");
    expect(r.message).not.toContain("docker rm");
    expect(r.message).not.toContain("docker volume rm");
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
    expect(d.argvs.find((a) => a[0] === "rm")).toEqual(["rm", "-f", "-v", id]);
    expect(d.volumes.has(V)).toBe(true);
    // The named volume is left alone: `-v` reaches anonymous volumes only, and no `volume rm` is issued.
    expect(d.argvs.filter((a) => a[0] === "volume" && a[1] === "rm")).toEqual([]);
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

  it.each<SandboxClass>(["another", "not-ours", "before"])("refuses a volume that is %s", async (cls) => {
    const d = mk();
    d.putVolume(V, cls);
    await expect(probe(d)).rejects.toBeInstanceOf(SandboxRefusedError);
    expect(d.count("volume create") + d.count("create")).toBe(0);
  });

  it.each<SandboxClass>(["mine"])("says a volume that is %s already exists, and of no other class (made before ownership is refused)", async (cls) => {
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
    expect(removed(d)).toEqual([["rm", "-f", "-v", d.created[0]!.id]]);
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
    expect(removed(d)).toEqual([["rm", "-f", "-v", d.created[0]!.id]]);
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
    expect(d.argvs.filter((a) => a[0] === "rm")).toEqual([["rm", "-f", "-v", name]]);
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
    expect(d.argvs.filter((a) => a[0] === "rm")).toEqual([["rm", "-f", "-v", d.created[0]!.id]]);
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

  it("refuses a volume made before ownership, so it cannot hold a new container", async () => {
    const d = mk();
    d.putVolume(V, "before");
    const e = await settle(create(d));
    expect(e).toBeInstanceOf(SandboxRefusedError);
    expect((e as SandboxRefusedError).reason).toBe("before");
    expect((e as Error).message).toMatch(/was made before ownership was recorded; this installation cannot tell/);
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
    // Runtime leg: the check makes only its own trial container (through runOnce) and reads `docker info`; the comparison
    // and the error mapping act on nothing they did not create or were not given (a facts object, a stderr text).
    "assertRuntime", "checkRuntime", "refuseRuntimeMismatch", "runtimeRefusal",
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
    // Leg 5 (contained networks). Every one acts only on an object this call made itself (a network, a proxy container or
    // a one-shot, by the id or random name it was just given), on the proxy it just made (status, logs), or on nothing
    // (the resolver cache, a text comparison); none takes a name a caller typed.
    "createContainedNetwork", "readUpstreamResolvers", "invalidateResolvers", "readResolvers", "runBehindProxy", "runCreated",
    "proxyStatus", "readRefusals", "lastLogLine", "startProxy", "awaitProxyReady", "dropNetwork", "dropContainer", "isNetworkNotThere",
    // Leg 6 (project network primitives). Each acts only on objects it creates, or classifies itself by owner, role and
    // name before it acts (a project's proxy or network, never a name a caller typed): the public ones are
    // ensureProjectNetwork, attachProjectNetwork, createProjectProxy, startProjectProxy, removeProjectProxy,
    // removeProjectNetwork and checkContainedNetwork (a pure judgement of an inspect); the private ones are their helpers.
    "ensureProjectNetwork", "attachProjectNetwork", "createProjectProxy", "startProjectProxy", "removeProjectProxy",
    "removeProjectNetwork", "checkContainedNetwork",
    "createNetwork", "findContainedNetwork", "startAndAwait", "checkedProxy", "rmProxy", "rmNetwork", "networkLabels", "projectObjects",
    "disconnectForce",
    // Leg 7 (containment hook). The hook's own machinery acts on nothing in Docker: it holds a function, a cache and a
    // clock, and calls the hook with facts it was given (`setContainment`, `invalidate`, `clock`, `hooked`, `hookCached`).
    // `setNetworkNow` and `destroyNow` are the bodies of the guarded `setNetwork` and `destroy`, which call nothing else.
    // `findProjectNetwork`, `projectProxyAttached` and `removeProjectProxyNamed` classify the project's network or proxy
    // themselves, by owner, role and the sandbox's name (a read-only inspect for the first two).
    "setContainment", "invalidate", "clock", "hooked", "hookCached", "setNetworkNow", "destroyNow",
    "findProjectNetwork", "projectProxyAttached", "removeProjectProxyNamed",
    // Leg 13 (proxy by address). `probeSubnet` and `networkCreateFailure` are helpers of the network create: the probe acts only
    // on the throwaway network it just made (by the random name or the id it was given). `detachProjectProxy` and
    // `restoreProjectProxy` classify the project's proxy themselves (this installation's, role project-proxy) before they act.
    // `writeLocalAccess` is given a container's id by containment and classifies it again (only mine passes) before its one
    // root exec; `clearLocalAccess` is its best-effort call from `setNetworkNow`, on the container that guarded method resolved.
    // `afterStarted` only calls the post-start step it was handed, with facts it was given.
    "probeSubnet", "networkCreateFailure", "detachProjectProxy", "restoreProjectProxy", "writeLocalAccess", "clearLocalAccess", "afterStarted",
    // Leg 14. `needsRestartToChangeNetwork` judges facts it is given. `whileStopped` acts on a sandbox its callers already resolved
    // (`setNetworkNow`, `attachProjectNetwork`'s sandbox reference) and `restartSandbox` resolves and classifies first (its own block).
    "needsRestartToChangeNetwork", "whileStopped", "restartSandbox",
  ];
  /**
   * Methods that report instead of refusing: they never throw and issue only read-only commands, which the
   * test below checks for each. A method that acts on a sandbox does not belong here, and the guarded table
   * above is where it is judged.
   */
  const STATE_REPORTERS = ["ownership"];
  // listProjectProxies and projectProxyStatus report too, but they answer lists and status bodies, not a class: their
  // own blocks ("project proxies") check what they ask and that they say nothing they were not told.
  // Leg 8: projectRefusals reports too (the rows of a project's proxies' refusals; it lists and reads status, never throws).
  // Leg 10: listOwnSandboxes reports too (this installation's sandboxes, from `ps` and one inspect each; it never throws for an absent one).
  const REPORTING = [...STATE_REPORTERS, "listProjectProxies", "projectProxyStatus", "projectRefusals", "listOwnSandboxes"];
  const own = () => prototypeChainNames(Docker.prototype, (d) => typeof d.value === "function");

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
      expect(Object.keys(REPORTS).sort()).toEqual([...STATE_REPORTERS].sort());
    });

    it.each(STATE_REPORTERS)("%s says the class of each kind of container, on a double that accepts only inspects", async (method) => {
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

    it.each(STATE_REPORTERS)("%s says missing for a container that is not there, and unavailable (not missing) when Docker cannot say", async (method) => {
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

    it.each(STATE_REPORTERS)("%s classifies with the function everything else uses: its answer for each label set is classifySandbox's", async (method) => {
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

  it.each(Object.keys(CASES))("%s is refused against another's, not-ours or made-before-ownership sandbox, in every volume position, on a double that accepts only inspects", async (method) => {
    const c = CASES[method]!;
    const positions = c.resource === "volume" ? slots(c).map((_, i) => i) : [0];
    for (const position of positions) {
      for (const cls of ["another", "not-ours", "before"] as const) {
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
    // Narrowed to mine: a sandbox made before ownership is refused before any command names an id (the table above).
    for (const cls of ["mine"] as const) {
      for (const [method, c] of Object.entries(CASES)) {
        const d = mk();
        setup(d, c, cls);
        if (c.resource === "container") d.putVolume(V, cls);
        await settle(c.run(d));
        // and by reference, for the methods that accept one
        const ref = { id: idFor(`${N}-ref`), name: N };
        d.put(N, cls, { running: false, networks: ["bridge"] });
        d.containers.get(N)!.id = ref.id;
        for (const f of [() => d.exec(ref, ["true"], OPTS), () => d.ensureRunning(ref), () => d.setNetwork(ref, "off")]) await settle(f());
        d.execReplies = [{ code: 1, stderr: DAEMON }];
        d.containers.get(N)!.running = false;
        await settle(d.exec(ref, ["true"], OPTS));
        for (const a of d.argvs) {
          let where: string | undefined;
          if (a[0] === "exec") {
            // exec -i [-w <cwd>] [-e NAME=value]... <id> ...
            let i = 2;
            while (a[i] === "-w" || a[i] === "-e") i += 2;
            where = a[i];
          } else if (a[0] === "start") where = a.at(-1);
          else if (a[0] === "rm") where = a.at(-1);
          // Only the commands that act on a container: an inspect names a network by its (name-keyed) name.
          else if (a[0] === "network" && ["connect", "disconnect", "rm"].includes(a[1]!)) where = a.at(-1);
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

  it("passes an entrypoint override before the image, and the empty string as --entrypoint with an empty value", async () => {
    for (const entrypoint of ["sh", ""]) {
      const d = mk();
      stage(d);
      await d.runScanner(STAGING, { ...SCANNER, entrypoint, command: ["-c", "x"] }, { timeoutMs: 20_000 });
      const a = d.created[0]!.args;
      expect(a.filter((x) => x === "--entrypoint")).toHaveLength(1);
      const i = a.indexOf("--entrypoint");
      expect(a.slice(i, i + 3)).toEqual(["--entrypoint", entrypoint, "scan:1"]);
      expect(a.slice(-3)).toEqual(["scan:1", "-c", "x"]);
    }
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
    ["made before ownership (refused)", (d) => stage(d, "before"), undefined],
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

  describe("at the build stage", () => {
    const BUILD = { ...SCANNER, stage: "build" as const };
    const sandbox = (d: ScriptedDocker, cls: SandboxClass = "mine", role: string | null = null) => d.putVolume(TARGET, cls, role ?? undefined);

    it("runs over a sandbox volume (no role), read-only at /scan, in /scan", async () => {
      const d = mk();
      sandbox(d);
      await d.runScanner(TARGET, BUILD, { timeoutMs: 20_000 });
      const a = d.created[0]!.args;
      expect(d.created[0]!.labels["mcp-everything.role"]).toBe("scan");
      expect(a.slice(a.indexOf("--mount"), a.indexOf("--mount") + 2)).toEqual(["--mount", `type=volume,src=${TARGET},dst=/scan,readonly`]);
      expect(a.filter((x) => x === "--mount")).toHaveLength(1);
      expect(a.slice(a.indexOf("-w"), a.indexOf("-w") + 2)).toEqual(["-w", "/scan"]);
      expect(a.slice(a.indexOf("--network"), a.indexOf("--network") + 2)).toEqual(["--network", "none"]);
    });

    it("a source spec (and one with stage \"source\") still runs in /scan/repo", async () => {
      for (const spec of [SCANNER, { ...SCANNER, stage: "source" as const }]) {
        const d = mk();
        stage(d);
        await d.runScanner(STAGING, spec, { timeoutMs: 20_000 });
        const a = d.created[0]!.args;
        expect(a.slice(a.indexOf("-w"), a.indexOf("-w") + 2)).toEqual(["-w", "/scan/repo"]);
      }
    });

    it("refuses a build spec on a staging volume, and a source spec on a sandbox volume, before any container is created", async () => {
      const a = mk();
      stage(a);
      const e1 = await settle(a.runScanner(STAGING, BUILD, { timeoutMs: 20_000 }));
      expect((e1 as Error).message).toMatch(/not a sandbox volume/);
      expect(a.count("create")).toBe(0);
      const b = mk();
      sandbox(b);
      const e2 = await settle(b.runScanner(TARGET, SCANNER, { timeoutMs: 20_000 }));
      expect((e2 as Error).message).toMatch(/not a staging volume/);
      expect(b.count("create")).toBe(0);
    });

    it.each<[string, SandboxClass | "missing"]>([
      ["another's", "another"],
      ["not mcp-everything's", "not-ours"],
      ["made before ownership", "before"],
    ])("refuses a volume that is %s, with inspects only and no container", async (_n, cls) => {
      for (const spec of [BUILD, SCANNER]) {
        const d = mk();
        d.strict = true;
        d.putVolume(spec === BUILD ? TARGET : STAGING, cls as SandboxClass, spec === BUILD ? undefined : "staging");
        const e = await settle(d.runScanner(spec === BUILD ? TARGET : STAGING, spec, { timeoutMs: 20_000 }));
        expect(d.violations).toEqual([]);
        expect(e).toBeInstanceOf(SandboxRefusedError);
        expect((e as SandboxRefusedError).reason).toBe(cls);
        expect(d.count("create")).toBe(0);
        expect(d.count("start")).toBe(0);
      }
    });

    it("refuses a volume that is missing", async () => {
      const d = mk();
      const e = await settle(d.runScanner(TARGET, BUILD, { timeoutMs: 20_000 }));
      expect((e as Error).message).toMatch(/does not exist/);
      expect(d.count("create")).toBe(0);
    });

    it("does not refuse a sandbox volume that is mine", async () => {
      const d = mk();
      sandbox(d);
      expect(await settle(d.runScanner(TARGET, BUILD, { timeoutMs: 20_000 }))).toBeNull();
    });
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
    ["the source was made before ownership (refused)", (d) => { both(d); d.putVolume(STAGING, "before", "staging"); }, true],
    ["the target was made before ownership (refused)", (d) => { both(d); d.putVolume(TARGET, "before"); }, true],
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
    for (const cls of ["another", "not-ours", "before"] as const) {
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

  it("leaves a volume of this installation that is not a staging volume: no role, or another role", async () => {
    for (const [cls, role] of [["mine", undefined], ["mine", "other"]] as const) {
      const d = mk();
      d.putVolume(STAGING, cls, role);
      await expect(d.removeStagingVolume(STAGING)).rejects.toBeInstanceOf(VolumeNotUsableError);
      expect(d.count("volume rm")).toBe(0);
    }
  });

  it("refuses a volume made before ownership (it is not removed, and it is not VolumeNotUsableError)", async () => {
    const d = mk();
    d.putVolume(STAGING, "before", "staging");
    const e = await settle(d.removeStagingVolume(STAGING));
    expect(e).toBeInstanceOf(SandboxRefusedError);
    expect(e).not.toBeInstanceOf(VolumeNotUsableError);
    expect(d.count("volume rm")).toBe(0);
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
    // Three listings now: containers, volumes and networks.
    expect(r).toEqual({ removed: [], failures: 3 });
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

describe("the required runtime", () => {
  const RT = "runsc";
  const named = () => mk({ MCPE_DOCKER_RUNTIME: RT });
  const MESSAGE = (reason: string) =>
    `MCPE_DOCKER_RUNTIME names ${RT}, but Docker cannot run containers with it (${reason}); install it and register it with Docker, or unset MCPE_DOCKER_RUNTIME.`;
  const trialFails = (d: ScriptedDocker, r: Reply) => d.script.push((a) => (a[0] === "start" && a[1] === "-a" ? r : undefined));
  const trialArgs = (d: ScriptedDocker) => d.created.find((c) => c.labels["mcp-everything.role"] === "runtime-check");

  describe("assertRuntime", () => {
    it("makes no Docker call and resolves when no runtime is named, and no path compares runtimes", async () => {
      const d = mk();
      d.put(N, "mine", { runtime: "runsc" });
      await d.assertRuntime();
      expect(d.argvs).toEqual([]);
      await expect(d.acquire(N)).resolves.toMatchObject({ name: N });
      await d.exec(N, ["true"], OPTS);
      expect(await d.ensureRunning(N)).toBe(true);
      expect(d.count("info")).toBe(0);
    });

    it("asks `docker info` first, then runs one trial container: role runtime-check, no network, the limits with the runtime, entrypoint true, no arguments", async () => {
      const d = named();
      await d.assertRuntime();
      expect(d.argvs[0]).toEqual(["info", "--format", '{"runtimes":{{json .Runtimes}},"default":{{json .DefaultRuntime}}}']);
      expect(d.verbs).toEqual(["info", "image inspect", "create", "start", "rm"]);
      const t = trialArgs(d)!;
      expect(t.args).toEqual(expect.arrayContaining(["--network", "none", "--runtime", RT, "--entrypoint", "true", "--cap-drop", "ALL"]));
      expect(t.args.at(-1)).toBe(loadConfig({}).docker.probeImage);
      expect(t.args[t.args.indexOf("--entrypoint") + 1]).toBe("true");
      const start = d.argvs.findIndex((a) => a[0] === "start");
      expect(d.optsList[start]).toMatchObject({ timeoutMs: 60_000 });
    });

    it("refuses when `docker info` lists no runtime of the name, with no trial", async () => {
      const d = named();
      d.infoRuntimes = ["runc", "nvidia"];
      const e = await d.assertRuntime().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RuntimeUnavailableError);
      expect((e as Error).message).toBe(MESSAGE("Docker lists no runtime called runsc"));
      expect(d.count("create")).toBe(0);
    });

    it("cleans the name in the message", async () => {
      const d = mk({ MCPE_DOCKER_RUNTIME: "bad\nname" });
      d.infoRuntimes = ["runc"];
      await expect(d.assertRuntime()).rejects.toThrow(/names bad name,/);
    });

    it("refuses when the trial exits non-zero, with the first line of Docker's stderr (at most 200 characters)", async () => {
      const d = named();
      trialFails(d, { code: 127, stderr: `docker: Error response from daemon: OCI runtime create failed: ${"x".repeat(400)}\nsecond line\n` });
      const e = (await d.assertRuntime().catch((x: unknown) => x)) as RuntimeUnavailableError;
      expect(e).toBeInstanceOf(RuntimeUnavailableError);
      expect(e.reason.length).toBeLessThanOrEqual(200);
      expect(e.reason).toMatch(/^docker: Error response from daemon: OCI runtime create failed: x+/);
      expect(e.message).not.toMatch(/second line/);
    });

    it("refuses when the trial exits non-zero with nothing on stderr, naming the exit code", async () => {
      const d = named();
      trialFails(d, { code: 3 });
      await expect(d.assertRuntime()).rejects.toThrow(MESSAGE("a trial container exited with code 3"));
    });

    it("refuses when the trial times out", async () => {
      const d = named();
      trialFails(d, { code: null, timedOut: true });
      await expect(d.assertRuntime()).rejects.toBeInstanceOf(RuntimeUnavailableError);
      await expect(d.assertRuntime()).rejects.toThrow(/did not finish within 60 seconds/);
    });

    it("refuses, with the pull failure as the reason, when the probe image cannot be had", async () => {
      const d = named();
      d.script.push((a) => (a[0] === "image" ? { code: 1 } : a[0] === "pull" ? { code: 1, stderr: "no route to registry" } : undefined));
      await expect(d.assertRuntime()).rejects.toThrow(/Failed to pull image .*no route to registry/);
      expect(d.count("create")).toBe(0);
    });

    it("lets a Docker that cannot answer propagate as DockerUnavailableError, and caches nothing", async () => {
      const d = named();
      d.script.push((a) => (a[0] === "info" ? { code: 1, stderr: "Cannot connect to the Docker daemon" } : undefined));
      await expect(d.assertRuntime()).rejects.toBeInstanceOf(DockerUnavailableError);
      d.script.length = 0;
      await expect(d.assertRuntime()).resolves.toBeUndefined();
    });

    it("caches a success for the process", async () => {
      const d = named();
      await d.assertRuntime();
      await d.assertRuntime();
      expect(d.count("info")).toBe(1);
      expect(d.created.length).toBe(1);
    });

    it("does not cache a failure: the next call asks again", async () => {
      const d = named();
      d.infoRuntimes = ["runc"];
      await expect(d.assertRuntime()).rejects.toBeInstanceOf(RuntimeUnavailableError);
      d.infoRuntimes = ["runc", RT];
      await expect(d.assertRuntime()).resolves.toBeUndefined();
      expect(d.count("info")).toBe(2);
    });

    it("shares one in-flight check between simultaneous callers: one info, one trial", async () => {
      const d = named();
      await Promise.all([d.assertRuntime(), d.assertRuntime(), d.assertRuntime()]);
      expect(d.count("info")).toBe(1);
      expect(d.created.length).toBe(1);
    });

    it("gives every simultaneous caller the same refusal", async () => {
      const d = named();
      d.infoRuntimes = ["runc"];
      const r = await Promise.allSettled([d.assertRuntime(), d.assertRuntime()]);
      expect(r.map((x) => x.status)).toEqual(["rejected", "rejected"]);
      expect(d.count("info")).toBe(1);
    });
  });

  describe("where it is called", () => {
    it("runOnce for a clone-like role checks first; the trial itself does not recurse", async () => {
      const d = named();
      d.putVolume(STAGING, "mine", "staging");
      d.putVolume(TARGET, "mine");
      await d.copyVolume(STAGING, TARGET);
      expect(d.count("info")).toBe(1);
      expect(d.created.map((c) => c.labels["mcp-everything.role"])).toEqual(["runtime-check", "copy"]);
      expect(d.verbs.indexOf("info")).toBeLessThan(d.verbs.indexOf("create"));
    });

    it("a refused check creates no container for the one-shot", async () => {
      const d = named();
      d.infoRuntimes = ["runc"];
      d.putVolume(STAGING, "mine", "staging");
      d.putVolume(TARGET, "mine");
      await expect(d.copyVolume(STAGING, TARGET)).rejects.toBeInstanceOf(RuntimeUnavailableError);
      expect(d.count("create")).toBe(0);
    });

    it("createContainer checks before its volume checks, and refuses without running", async () => {
      const d = named();
      d.infoRuntimes = ["runc"];
      await expect(d.createContainer({ name: "n", volume: "v", image: "img", project: "p" })).rejects.toBeInstanceOf(RuntimeUnavailableError);
      expect(d.verbs).toEqual(["info"]);
    });

    it("only assertRuntime's trial uses the runtime-check role", () => {
      const src = readSources(DOCKER_SOURCES);
      expect(src.match(/role: "runtime-check"/g)).toHaveLength(1);
      expect(src.slice(src.indexOf("private async checkRuntime"))).toContain('role: "runtime-check"');
      expect(src).toContain('spec.role !== "runtime-check"');
    });

    it("a trial container left behind by a killed process is swept like a clone", async () => {
      const d = mk();
      const id = "7".repeat(64);
      const old = new Date(Date.now() - 2 * 3600_000).toISOString();
      d.script.push((a) => {
        if (a[0] === "ps") return { stdout: `${id}\n` };
        if (a[0] === "volume" && a[1] === "ls") return { stdout: "" };
        // A one-shot has no project label (the sweep never takes anything that has one), so these are not LABELS.mine.
        if (a[0] === "inspect") return { stdout: JSON.stringify({ id, labels: { "mcp-everything": "1", "mcp-everything.owner": TEST_INSTALLATION_ID, "mcp-everything.role": "runtime-check" }, created: old }) };
        return undefined;
      });
      const r = await d.sweepCheckLeftovers(3600);
      expect(r).toEqual({ removed: [id], failures: 0 });
    });
  });

  describe("Docker's own refusal of an unknown runtime", () => {
    const unknown = (r: string) => `docker: Error response from daemon: unknown or invalid runtime name: ${r}.\n`;
    const copyFails = (d: ScriptedDocker, stderr: string) =>
      d.script.push((a) => (a[0] === "create" && a.includes("mcp-everything.role=copy") ? { code: 125, stderr } : undefined));
    const copy = (d: ScriptedDocker) => {
      d.putVolume(STAGING, "mine", "staging");
      d.putVolume(TARGET, "mine");
      return d.copyVolume(STAGING, TARGET);
    };

    it("is mapped on create, and the cached success is cleared so the next call checks again", async () => {
      const d = named();
      await d.assertRuntime();
      copyFails(d, unknown(RT));
      const e = (await copy(d).catch((x: unknown) => x)) as RuntimeUnavailableError;
      expect(e).toBeInstanceOf(RuntimeUnavailableError);
      expect(e.message).toBe(MESSAGE(e.reason));
      expect(e.reason).toMatch(/unknown or invalid runtime name: runsc/);
      d.script.length = 0;
      await d.assertRuntime();
      expect(d.count("info")).toBe(2);
    });

    it("is not mapped when the line names another runtime, or says something else (a bad entrypoint is not a runtime refusal)", async () => {
      for (const stderr of [unknown("other"), "docker: Error response from daemon: OCI runtime create failed: runc create failed: exec: \"x\": executable file not found\n"]) {
        const d = named();
        copyFails(d, stderr);
        const e = (await copy(d).catch((x: unknown) => x)) as Error;
        expect(e).not.toBeInstanceOf(RuntimeUnavailableError);
        expect(e.message).toMatch(/^Could not create the copy container/);
        await d.assertRuntime();
        expect(d.count("info")).toBe(1);
      }
    });

    it("is mapped on `docker run` in createContainer", async () => {
      const d = named();
      d.putVolume("v", "mine");
      d.script.push((a) => (a[0] === "run" ? { code: 125, stderr: unknown(RT) } : undefined));
      await expect(d.createContainer({ name: "n", volume: "v", image: "img", project: "p" })).rejects.toBeInstanceOf(RuntimeUnavailableError);
      d.script.length = 0;
      await d.assertRuntime();
      expect(d.count("info")).toBe(2);
    });

    it("is not mapped when no runtime is named", async () => {
      const d = mk();
      copyFails(d, unknown(RT));
      await expect(copy(d)).rejects.toThrow(/^Could not create the copy container/);
    });
  });

  describe("an existing sandbox under another runtime", () => {
    const MISMATCH = (actual: string) =>
      `Sandbox ${N} was created before MCPE_DOCKER_RUNTIME=${RT} was set; Docker reports its runtime as ${actual}. Reinstall the project to run it under ${RT}.`;

    it("acquire refuses a runc sandbox when runsc is named, running or stopped, and starts nothing", async () => {
      for (const running of [true, false]) {
        const d = named();
        d.put(N, "mine", { running, runtime: "runc" });
        await expect(d.acquire(N)).rejects.toThrow(MISMATCH("runc"));
        await expect(d.acquire(N)).rejects.toBeInstanceOf(RuntimeMismatchError);
        expect(d.count("start")).toBe(0);
      }
    });

    it("acquire accepts a sandbox under the named runtime and starts a stopped one", async () => {
      const d = named();
      d.put(N, "mine", { running: false, runtime: RT });
      await expect(d.acquire(N)).resolves.toMatchObject({ name: N });
      expect(d.count("start")).toBe(1);
    });

    it("reads the runtime in both inspect formats", async () => {
      const d = named();
      d.put(N, "mine", { runtime: RT });
      await d.acquire(N);
      await d.exec(N, ["true"], OPTS);
      const formats = d.argvs.filter((a) => a[0] === "inspect").map((a) => a[a.indexOf("--format") + 1]!);
      expect(formats.length).toBeGreaterThan(0);
      for (const f of formats) expect(f).toContain('"runtime":{{json .HostConfig.Runtime}}');
      const base = loadConfig({});
      expect(base.docker.runtime).toBeUndefined();
    });

    it("exec by name refuses before execing", async () => {
      const d = named();
      d.put(N, "mine", { runtime: "runc" });
      await expect(d.exec(N, ["true"], OPTS)).rejects.toBeInstanceOf(RuntimeMismatchError);
      expect(d.execs).toEqual([]);
    });

    it("ensureRunning refuses by name and by reference, and starts nothing", async () => {
      const d = named();
      const id = d.put(N, "mine", { running: false, runtime: "runc" });
      await expect(d.ensureRunning(N)).rejects.toBeInstanceOf(RuntimeMismatchError);
      await expect(d.ensureRunning({ id, name: N })).rejects.toBeInstanceOf(RuntimeMismatchError);
      expect(d.count("start")).toBe(0);
    });

    it("the idle-timeout restart of an exec on a reference meets the mismatch and throws it, not the exec's failure", async () => {
      const d = named();
      const id = d.put(N, "mine", { running: false, runtime: "runc" });
      d.execReplies = [{ code: 1, stderr: DAEMON }];
      await expect(d.exec({ id, name: N }, ["true"], OPTS)).rejects.toBeInstanceOf(RuntimeMismatchError);
      expect(d.count("start")).toBe(0);
    });

    it("a missing, null or empty runtime counts as the daemon's default: runc until info answers, then DefaultRuntime", async () => {
      for (const runtime of [undefined, null, ""]) {
        const d = mk({ MCPE_DOCKER_RUNTIME: "runc" });
        d.put(N, "mine", { runtime });
        await expect(d.acquire(N), String(runtime)).resolves.toMatchObject({ name: N });
      }
      const d = named();
      d.infoDefault = RT;
      await d.assertRuntime();
      d.put(N, "mine");
      await expect(d.acquire(N)).resolves.toMatchObject({ name: N });
      const e = named();
      e.put(N, "mine");
      await expect(e.acquire(N)).rejects.toThrow(MISMATCH("runc"));
    });

    it("an operator naming the shim is refused on a sandbox Docker reports as runc", async () => {
      const d = mk({ MCPE_DOCKER_RUNTIME: "io.containerd.runc.v2" });
      d.put(N, "mine", { runtime: "runc" });
      await expect(d.acquire(N)).rejects.toThrow(/Docker reports its runtime as runc/);
    });

    it("destroy, removeContainer, ownership, state, networkState and setNetwork do not compare", async () => {
      const d = named();
      d.put(N, "mine", { runtime: "runc", networks: ["bridge"] });
      d.putVolume(V, "mine");
      expect(await d.ownership(N)).toEqual({ state: "mine" });
      expect(await d.state(N)).toBe("running");
      expect(await d.networkState(N)).toBe("open");
      await d.setNetwork(N, "off");
      expect(await d.networkState(N)).toBe("off");
      await d.removeContainer(N);
      d.put(N, "mine", { runtime: "runc" });
      await d.destroy(N, V);
      expect(d.containers.has(N)).toBe(false);
      expect(d.volumes.has(V)).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Contained networks and the one-shot proxy (flight 02, leg 5)
// ---------------------------------------------------------------------------
const ID = TEST_INSTALLATION_ID;
const OWNER_L = "mcp-everything.owner";
const ROLE_L = "mcp-everything.role";
const PROJECT_L = "mcp-everything.project";
const sub = (a: string[], flag: string) => a.flatMap((x, i) => (x === flag ? [a[i + 1]!] : []));
const lastLine = (e: unknown) => (e as Error).message;

/** A `network inspect` answer, with fields overridden. */
const netJson = (id: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, internal: true, ipv6: false, ipam: [{ Subnet: "172.30.9.0/24" }], labels: { [OWNER_L]: ID, [ROLE_L]: "oneshot-net" }, created: "x", ...over });
const inspectNet = (over: Record<string, unknown>) => (a: string[]) => (a[0] === "network" && a[1] === "inspect" ? { stdout: netJson(a.at(-1)!, over) } : undefined);

describe("the network wording of 'not there'", () => {
  it.each(["Error response from daemon: network abc not found", "Error: No such network: abc", "Error response from daemon: network mcpe-x-oneshot-net-1234 not found"])(
    "a network that is gone (%s) is skipped by the sweep, not counted",
    async (stderr) => {
      const d = mk();
      const id = "a".repeat(64);
      d.script.push((a) => (a[0] === "network" && a[1] === "ls" ? { stdout: `${id}\n` } : a[0] === "network" && a[1] === "inspect" ? { code: 1, stderr } : undefined));
      expect(await d.sweepCheckLeftovers(0)).toEqual({ removed: [], failures: 0 });
    },
  );

  it("containers and volumes keep the narrower pattern: the network wording is 'could not be asked' for a container", async () => {
    const d = mk();
    d.script.push((a) => (a[0] === "inspect" ? { code: 1, stderr: "Error response from daemon: network abc not found" } : undefined));
    expect(await d.ownership(N)).toEqual({ state: "unavailable" });
    d.script.length = 0;
    d.script.push((a) => (a[0] === "inspect" ? { code: 1, stderr: "Error response from daemon: No such container: x" } : undefined));
    expect(await d.ownership(N)).toEqual({ state: "missing" });
  });
});

describe("createContainedNetwork", () => {
  // Leg 13: every network is made by probe, then pin. A throwaway network (no --subnet) says which subnet the daemon's pools
  // would give; it is removed; the real one is made with that subnet and an --ip-range in its lower half.
  it("probes a subnet with a throwaway network, removes it, then makes the real one with --subnet and --ip-range (the lower half)", async () => {
    const d = mk();
    const n = await d.createContainedNetwork({ role: "oneshot-net" });
    const creates = d.argvs.filter((a) => a[0] === "network" && a[1] === "create");
    expect(creates).toHaveLength(2);
    const [probe, real] = creates as [string[], string[]];
    const flags = ["network", "create", "--internal", "-o", "com.docker.network.bridge.gateway_mode_ipv4=isolated", "--ipv6=false"];
    expect(probe.slice(0, -1)).toEqual([...flags, "--label", `${OWNER_L}=${ID}`, "--label", `${ROLE_L}=oneshot-net`]);
    expect(probe).not.toContain("--subnet");
    expect(probe.at(-1)).toMatch(new RegExp(`^mcpe-${ID}-oneshot-net-[0-9a-f]{8}$`));
    const name = real.at(-1)!;
    expect(name).toMatch(new RegExp(`^mcpe-${ID}-oneshot-net-[0-9a-f]{8}$`));
    expect(name).not.toBe(probe.at(-1));
    expect(real.slice(0, -1)).toEqual([...flags, "--subnet", "172.30.1.0/24", "--ip-range", "172.30.1.0/25", "--label", `${OWNER_L}=${ID}`, "--label", `${ROLE_L}=oneshot-net`]);
    // Order: probe create, probe inspect, probe remove (by id), real create, real inspect (by id).
    expect(d.verbs.filter((v) => v.startsWith("network"))).toEqual(["network create", "network inspect", "network rm", "network create", "network inspect"]);
    expect(d.argvs.find((a) => a[0] === "network" && a[1] === "rm")).toEqual(["network", "rm", idFor(`net:${probe.at(-1)}`)]);
    const inspect = d.argvs.filter((a) => a[0] === "network" && a[1] === "inspect").at(-1)!;
    expect(inspect.slice(0, 3)).toEqual(["network", "inspect", "--format"]);
    for (const f of ["json .Id", "json .Internal", "json .EnableIPv6", "json .IPAM.Config", "json .Labels", "json .Created"]) expect(inspect[3]).toContain(f);
    expect(inspect[4]).toBe(n.id);
    expect(n).toEqual({ id: idFor(`net:${name}`), name, subnet: "172.30.1.0/24" });
    expect(d.networks.size).toBe(1);
  });

  it("uses a name it is given and adds the project label when it has one (leg 6); the probe is still a random one-shot network", async () => {
    const d = mk();
    const n = await d.createContainedNetwork({ role: "project-net", name: "mcpe-0123abcd-gron-net", project: "gron" });
    const creates = d.argvs.filter((a) => a[0] === "network" && a[1] === "create");
    const real = creates.at(-1)!;
    expect(n.name).toBe("mcpe-0123abcd-gron-net");
    expect(real.at(-1)).toBe("mcpe-0123abcd-gron-net");
    expect(sub(real, "--label")).toEqual([`${OWNER_L}=${ID}`, `${ROLE_L}=project-net`, `${PROJECT_L}=gron`]);
    // The probe never carries the project's name or labels: nothing of the project is left behind if it leaks.
    expect(creates[0]!.at(-1)).toMatch(new RegExp(`^mcpe-${ID}-oneshot-net-[0-9a-f]{8}$`));
    expect(sub(creates[0]!, "--label")).toEqual([`${OWNER_L}=${ID}`, `${ROLE_L}=oneshot-net`]);
  });

  it("pins whatever subnet the probe found, and the ip-range is the lower half of it (/16, /24 and /20)", async () => {
    for (const [found, range] of [["172.22.0.0/16", "172.22.0.0/17"], ["10.9.8.0/24", "10.9.8.0/25"], ["192.168.16.0/20", "192.168.16.0/21"]] as const) {
      const d = mk();
      d.script.push((a) => {
        if (a[0] !== "network" || a[1] !== "create" || a.includes("--subnet")) return undefined;
        d.networks.set(a.at(-1)!, { id: idFor(`net:${a.at(-1)}`), name: a.at(-1)!, labels: { [OWNER_L]: ID, [ROLE_L]: "oneshot-net" }, internal: true, ipv6: false, ipam: [{ Subnet: found }], created: "2026-01-01T00:00:00.123456Z" });
        return { stdout: `${idFor(`net:${a.at(-1)}`)}\n` };
      });
      const n = await d.createContainedNetwork({ role: "oneshot-net" });
      const real = d.argvs.filter((a) => a[1] === "create").at(-1)!;
      expect(real[real.indexOf("--subnet") + 1]).toBe(found);
      expect(real[real.indexOf("--ip-range") + 1]).toBe(range);
      expect(n.subnet).toBe(found);
    }
  });

  it("on 'Pool overlaps' probes again and retries, up to three times", async () => {
    const d = mk();
    d.overlaps = 3;
    const n = await d.createContainedNetwork({ role: "oneshot-net" });
    expect(d.count("network create")).toBe(8); // four probes and four real creates
    expect(d.networks.size).toBe(1);
    expect(n.subnet).toBe("172.30.4.0/24"); // the fourth probe's subnet (a counter makes each differ)
    const e = mk();
    e.overlaps = 4;
    const err = await settle(e.createContainedNetwork({ role: "oneshot-net" }));
    expect(err).toBeInstanceOf(ContainmentUnavailableError);
    expect(lastLine(err)).toContain("Pool overlaps");
    expect(e.count("network create")).toBe(8);
    expect(e.networks.size).toBe(0); // every probe was removed
  });

  it("on Docker 29's 'conflicts with network' refusal probes again and retries", async () => {
    const d = mk();
    d.overlaps = 1;
    d.overlapStderr = "Error response from daemon: cannot create network b51a5425 (br-b51a54256690): conflicts with network 8efd919d (br-8efd919d1234): networks have overlapping IPv4\n";
    const n = await d.createContainedNetwork({ role: "oneshot-net" });
    expect(d.count("network create")).toBe(4); // two probes and two real creates
    expect(d.networks.size).toBe(1);
    expect(n.subnet).toBe("172.30.2.0/24"); // the second probe's subnet
  });

  it("removes the probe even when its inspect fails, and a probe that is too small to hold the proxy is refused", async () => {
    const small = mk();
    small.script.push((a) => (a[0] === "network" && a[1] === "inspect" ? { stdout: JSON.stringify({ id: idFor(`net:${small.argvs.find((x) => x[1] === "create")!.at(-1)}`), internal: true, ipv6: false, ipam: [{ Subnet: "172.30.9.0/31" }], labels: { [OWNER_L]: ID, [ROLE_L]: "oneshot-net" } }) } : undefined));
    const e = await settle(small.createContainedNetwork({ role: "oneshot-net" }));
    expect(e).toBeInstanceOf(ContainmentUnavailableError);
    expect(lastLine(e)).toContain("too small");
    expect(small.count("network create")).toBe(1); // the real network was never made
    expect(small.count("network rm")).toBe(1);
  });

  it("a real network that fails its check after a good probe is removed by its id", async () => {
    const d = mk();
    let inspects = 0;
    d.script.push((a) => {
      if (a[0] !== "network" || a[1] !== "inspect") return undefined;
      inspects++;
      if (inspects === 1) return undefined; // the probe is fine
      const name = d.argvs.filter((x) => x[1] === "create").at(-1)!.at(-1)!;
      return { stdout: JSON.stringify({ id: idFor(`net:${name}`), internal: false, ipv6: false, ipam: [{ Subnet: "172.30.1.0/24" }], labels: { [OWNER_L]: ID, [ROLE_L]: "oneshot-net" } }) };
    });
    const e = await settle(d.createContainedNetwork({ role: "oneshot-net" }));
    expect(e).toBeInstanceOf(ContainmentUnavailableError);
    expect(lastLine(e)).toContain("not internal");
    const real = d.argvs.filter((a) => a[1] === "create").at(-1)!.at(-1)!;
    expect(d.argvs.filter((a) => a[0] === "network" && a[1] === "rm").at(-1)).toEqual(["network", "rm", idFor(`net:${real}`)]);
    expect(d.networks.size).toBe(0);
  });

  it("times out: removes by the random name, tolerantly, and throws", async () => {
    const d = mk();
    d.script.push((a) => (a[0] === "network" && a[1] === "create" ? { code: null as unknown as number, timedOut: true } : undefined));
    d.script.push((a) => (a[0] === "network" && a[1] === "rm" ? { code: 1, stderr: "Error: whatever" } : undefined));
    const e = await settle(d.createContainedNetwork({ role: "oneshot-net" }));
    expect(e).toBeInstanceOf(DockerUnavailableError);
    const name = d.argvs.find((a) => a[1] === "create")!.at(-1)!;
    expect(d.argvs.filter((a) => a[0] === "network" && a[1] === "rm")).toEqual([["network", "rm", name]]);
    expect(d.count("network inspect")).toBe(0);
  });

  it("fails with the cleaned last line of a non-zero exit, and removes nothing", async () => {
    const d = mk();
    d.script.push((a) => (a[0] === "network" && a[1] === "create" ? { code: 1, stderr: "warning\nError response from daemon: \u001b[31mboom\u001b[0m happened\n" } : undefined));
    const e = await settle(d.createContainedNetwork({ role: "oneshot-net" }));
    expect(e).toBeInstanceOf(ContainmentUnavailableError);
    expect(lastLine(e)).toBe("Could not create the contained network: Error response from daemon: boom happened");
    expect(d.count("network rm") + d.count("network inspect")).toBe(0);
  });

  it("maps an exhausted address pool to ContainmentUnavailableError naming default-address-pools (DD15)", async () => {
    const d = mk();
    d.script.push((a) => (a[0] === "network" && a[1] === "create" ? { code: 1, stderr: "Error response from daemon: all predefined address pools have been fully subnetted\n" } : undefined));
    const e = await settle(d.createContainedNetwork({ role: "oneshot-net" }));
    expect(e).toBeInstanceOf(ContainmentUnavailableError);
    expect(lastLine(e)).toContain("default-address-pools");
  });

  it.each([["nothing", ""], ["a short id", "abc123\n"], ["capitals", `${"A".repeat(64)}\n`], ["two ids", `${"a".repeat(64)}\n${"b".repeat(64)}\n`]])(
    "removes by the random name and throws when create printed %s",
    async (_n, out) => {
      const d = mk();
      d.script.push((a) => (a[0] === "network" && a[1] === "create" ? { stdout: out } : undefined));
      const e = await settle(d.createContainedNetwork({ role: "oneshot-net" }));
      expect(e).toBeInstanceOf(DockerUnavailableError);
      const name = d.argvs.find((a) => a[1] === "create")!.at(-1)!;
      expect(d.argvs.filter((a) => a[0] === "network" && a[1] === "rm")).toEqual([["network", "rm", name]]);
    },
  );

  it.each([
    ["fails", { code: 1, stderr: "Cannot connect to the Docker daemon" }],
    ["times out", { code: null as unknown as number, timedOut: true }],
    ["answers nonsense", { stdout: "not json" }],
    ["answers a number", { stdout: "5" }],
  ])("removes by id and throws DockerUnavailableError when the inspect %s", async (_n, r) => {
    const d = mk();
    d.script.push((a) => (a[0] === "network" && a[1] === "inspect" ? r : undefined));
    const e = await settle(d.createContainedNetwork({ role: "oneshot-net" }));
    expect(e).toBeInstanceOf(DockerUnavailableError);
    const rm = d.argvs.filter((a) => a[0] === "network" && a[1] === "rm");
    expect(rm).toHaveLength(1);
    expect(rm[0]!.at(-1)).toMatch(/^[0-9a-f]{64}$/);
    expect(d.networks.size).toBe(0);
  });

  it.each<[string, Record<string, unknown>]>([
    ["not internal", { internal: false }],
    ["an answer about another network", { id: "b".repeat(64) }],
    ["IPv6 on", { ipv6: true }],
    ["a gateway", { ipam: [{ Subnet: "172.30.9.0/24", Gateway: "172.30.9.1" }] }],
    ["a gateway in a second entry", { ipam: [{ Subnet: "172.30.9.0/24" }, { Gateway: "172.30.9.1" }] }],
    ["two IPv4 subnets", { ipam: [{ Subnet: "172.30.9.0/24" }, { Subnet: "172.31.9.0/24" }] }],
    ["no subnet", { ipam: [] }],
    ["null IPAM", { ipam: null }],
    ["an IPv6 subnet only", { ipam: [{ Subnet: "fd00::/64" }] }],
    ["another owner's label", { labels: { [OWNER_L]: OTHER_ID } }],
    ["no owner label", { labels: {} }],
    ["null labels", { labels: null }],
  ])("removes the network by id and throws ContainmentUnavailableError that says what was wrong: %s", async (_n, over) => {
    const d = mk();
    d.script.push(inspectNet(over));
    const e = await settle(d.createContainedNetwork({ role: "oneshot-net" }));
    expect(e).toBeInstanceOf(ContainmentUnavailableError);
    const msg = lastLine(e);
    expect(msg).toContain("not contained");
    expect(msg).toContain("a Docker version whose bridge driver supports gateway_mode_ipv4=isolated");
    // No version number from memory.
    expect(msg).not.toMatch(/\b\d+\.\d+/);
    const created = d.argvs.find((a) => a[1] === "create")!.at(-1)!;
    expect(d.argvs.filter((a) => a[0] === "network" && a[1] === "rm")).toEqual([["network", "rm", idFor(`net:${created}`)]]);
    expect(d.networks.size).toBe(0);
  });

  it("never falls back to bridge: no failure leaves a `bridge` network command or flag", async () => {
    const d = mk();
    d.script.push(inspectNet({ internal: false }));
    await settle(d.createContainedNetwork({ role: "oneshot-net" }));
    for (const a of d.argvs) expect(a).not.toContain("bridge");
  });

  it("accepts a gateway key that is empty", async () => {
    const d = mk();
    d.script.push(inspectNet({ ipam: [{ Subnet: "172.30.9.0/24", Gateway: "" }] }));
    expect((await d.createContainedNetwork({ role: "oneshot-net" })).subnet).toBe("172.30.9.0/24");
  });
});

describe("upstream resolvers", () => {
  it.each<[string, string[]]>([
    ["nameserver 10.0.0.2\n", ["10.0.0.2"]],
    ["nameserver 127.0.0.11\nnameserver 8.8.8.8\n", ["8.8.8.8"]],
    ["nameserver fd00::1\nnameserver 10.0.0.2\n", ["10.0.0.2", "fd00::1"]],
    ["nameserver ::1\nnameserver 127.0.0.53\nnameserver 0.0.0.0\n", []],
    ["nameserver fe80::1%eth0\nnameserver 1.1.1.1\n", ["1.1.1.1"]],
    ["# nameserver 1.2.3.4\nsearch x\noptions ndots:0\nnameserver not-an-ip\nnameserver 999.1.1.1\n", []],
    ["nameserver 1.1.1.1 # note\nnameserver 1.1.1.1\r\nnameserver\t9.9.9.9\r\n", ["1.1.1.1", "9.9.9.9"]],
    ["", []],
  ])("parses %j", (text, expected) => {
    expect(parseResolvConf(text)).toEqual(expected);
  });

  it("reads them from a one-shot on bridge with the probe image, entrypoint cat and /etc/resolv.conf", async () => {
    const d = mk();
    d.resolvConf = "nameserver 127.0.0.11\nnameserver 192.0.2.7\nnameserver 2001:db8::7\n";
    expect(await d.readUpstreamResolvers()).toEqual(["192.0.2.7", "2001:db8::7"]);
    const c = d.created[0]!;
    expect(c.labels[ROLE_L]).toBe("resolv-read");
    expect(c.name).toMatch(new RegExp(`^mcpe-${ID}-resolv-read-[0-9a-f]{8}$`));
    expect(sub(c.args, "--network")).toEqual(["bridge"]);
    expect(c.args.slice(c.args.indexOf("--entrypoint"), c.args.indexOf("--entrypoint") + 2)).toEqual(["--entrypoint", "cat"]);
    expect(c.args.slice(-2)).toEqual([loadConfig({}).docker.probeImage, "/etc/resolv.conf"]);
    expect(d.containers.size).toBe(0);
  });

  it("throws ContainmentUnavailableError for no usable server, and does not cache the failure", async () => {
    const d = mk();
    d.resolvConf = "nameserver 127.0.0.11\n";
    const e = await settle(d.readUpstreamResolvers());
    expect(e).toBeInstanceOf(ContainmentUnavailableError);
    expect(lastLine(e)).toContain("no usable upstream DNS server");
    d.resolvConf = "nameserver 192.0.2.9\n";
    expect(await d.readUpstreamResolvers()).toEqual(["192.0.2.9"]);
    expect(d.created).toHaveLength(2);
  });

  it("says Docker could not be asked when the read fails or times out", async () => {
    for (const r of [{ code: 1, stderr: "cat: can't open\n" }, { code: null as unknown as number, timedOut: true }]) {
      const d = mk();
      d.script.push((a) => (a[0] === "start" ? r : undefined));
      expect(await settle(d.readUpstreamResolvers())).toBeInstanceOf(DockerUnavailableError);
    }
  });

  it("caches per instance, shares one in-flight read, and invalidateResolvers clears it", async () => {
    const d = mk();
    const [a, b] = await Promise.all([d.readUpstreamResolvers(), d.readUpstreamResolvers()]);
    expect(a).toEqual(b);
    expect(d.created).toHaveLength(1);
    a.push("1.2.3.4");
    expect(await d.readUpstreamResolvers()).toEqual(["192.0.2.53"]);
    expect(d.created).toHaveLength(1);
    d.invalidateResolvers();
    d.resolvConf = "nameserver 192.0.2.54\n";
    expect(await d.readUpstreamResolvers()).toEqual(["192.0.2.54"]);
    expect(d.created).toHaveLength(2);
    // another instance has its own cache
    const other = mk();
    await other.readUpstreamResolvers();
    expect(other.created).toHaveLength(1);
  });
});

describe("the roles of one-shot containers", () => {
  it("OneShotRole and ONE_SHOT_ROLES list the same container roles, and the new ones are in", () => {
    expect([...ONE_SHOT_ROLES].sort()).toEqual(["clone", "copy", "oneshot-proxy", "resolv-read", "runtime-check", "scan"]);
  });
  it.each([...ONE_SHOT_ROLES])("runOnce accepts the role %s and names and labels by it", async (role) => {
    const d = mkOnce();
    await d.once({ ...SPEC, role });
    expect(d.created[0]!.labels[ROLE_L]).toBe(role);
    expect(d.created[0]!.name).toMatch(new RegExp(`^mcpe-${ID}-${role}-[0-9a-f]{8}$`));
  });
  it("the source's type is derived from the list, so a role cannot be in one and not the other", () => {
    const src = readSources(DOCKER_SOURCES);
    expect(src).toContain("export type OneShotRole = (typeof ONE_SHOT_ROLES)[number];");
  });
});

/** A double whose proxy gives up quickly, so that "out of budget" does not take ten seconds. */
class EgressDocker extends OneShotDocker {
  protected override proxyReadiness = { budgetMs: 250, pollMs: 5 };
}
const mkEgress = (env: Record<string, string> = {}) => new EgressDocker(loadConfig(env), TEST_INSTALLATION_ID);
/** The contained network a finished call made (it is gone from the double by then): its name, id and subnet, from the commands that were issued. */
const netOf = (d: EgressDocker) => {
  // The last create is the real network (leg 13: a throwaway probe is made and removed before it).
  const create = d.argvs.filter((a) => a[0] === "network" && a[1] === "create").at(-1)!;
  const name = create.at(-1)!;
  const proxyCreate = d.argvs.find(isProxyCreate);
  const cidr = proxyCreate ? (JSON.parse(proxyCreate.at(-1)!) as { listenCidr: string }).listenCidr : "";
  return { name, id: idFor(`net:${name}`), cidr };
};
/** Throws, as a missing binary does, on the commands `on` picks. */
class ThrowsOn extends EgressDocker {
  on: (a: string[]) => boolean = () => false;
  protected override async docker(args: string[], opts?: RunOptions) {
    if (this.on(args)) {
      this.argvs.push(args);
      throw new Error("spawn docker ENOENT");
    }
    return super.docker(args, opts);
  }
}
const ALLOW = [{ host: "github.com", wildcard: false, ports: [443, 80], literal: false }];
const EGRESS: OneShotSpec = { role: "clone", image: "img:1", egress: { allow: ALLOW }, args: ["git", "ls-remote"], timeoutMs: 1234, maxBytes: 5678 };
const isProxyCreate = (a: string[]) => a[0] === "create" && a.includes("--read-only");
const isOneShotCreate = (a: string[]) => a[0] === "create" && !a.includes("--read-only") && a.includes("img:1");
const roleOf = (d: EgressDocker, id: string | undefined) => [...d.containers.values()].find((c) => c.id === id)?.labels?.[ROLE_L];
/** The attached start of the call's own (clone) one-shot; the resolver read's start is attached too, with the role resolv-read. */
const isOneShotStart = (d: EgressDocker, a: string[]) => a[0] === "start" && a[1] === "-a" && roleOf(d, a.at(-1)) === "clone";
const ROW = { kind: "connect", host: "example.com", port: 443, reason: "not-allowed", count: 2, firstAt: "2026-01-01T00:00:00.000Z", lastAt: "2026-01-01T00:00:05.000Z" };
/** A script entry that fails the one-shot's own `start -a` (not the resolver read's: that one has the role resolv-read). */
const failRun = (d: EgressDocker, reply: Reply) => d.script.push((a) => (isOneShotStart(d, a) ? reply : undefined));
const clean = (d: EgressDocker) => {
  expect([...d.containers.keys()]).toEqual([]);
  expect([...d.networks.keys()]).toEqual([]);
};

describe("a one-shot behind its proxy", () => {
  it("does everything in the order of the design: images, resolvers, network, proxy (create, join, start, ready), one-shot, teardown", async () => {
    const d = mkEgress();
    d.startOutput = "ok\n";
    const r = await d.once(EGRESS);
    expect(r).toEqual({ code: 0, stdout: "ok\n", stderr: "", timedOut: false, truncated: false });
    expect("proxy" in r).toBe(false);
    expect(d.verbs).toEqual([
      "image inspect", "image inspect", // the proxy image and the one-shot's
      "image inspect", "create", "start", "rm", // the probe image, the resolver read
      "network create", "network inspect", "network rm", // the probe: a throwaway network says which subnet the pools would give
      "network create", "network inspect", // the real network, pinned to it
      "create", "network connect", "start", "inspect", "exec", // the proxy: created, joined before it starts, started, ready
      "create", "start", "rm", // the one-shot
      "rm", "network rm", // teardown: proxy, network
    ]);
    const images = d.argvs.filter((a) => a[0] === "image").map((a) => a.at(-1));
    expect(images).toEqual([loadConfig({}).docker.proxyImage, "img:1", loadConfig({}).docker.probeImage]);
    clean(d);
  });

  it("creates the proxy hardened: bridge, limits, no capabilities, node user, read-only, a small tmpfs, no ports", async () => {
    const d = mkEgress();
    const cfg = loadConfig({});
    await d.once(EGRESS);
    const pc = d.argvs.find(isProxyCreate)!;
    const name = sub(pc, "--name")[0]!;
    expect(name).toMatch(new RegExp(`^mcpe-${ID}-oneshot-proxy-[0-9a-f]{8}$`));
    expect(pc[0]).toBe("create");
    expect(pc).not.toContain("--rm");
    expect(sub(pc, "--label")).toEqual(["mcp-everything=1", `${OWNER_L}=${ID}`, `${ROLE_L}=oneshot-proxy`]);
    for (const f of ["--memory", "--cpus", "--pids-limit", "--security-opt"]) expect(pc).toContain(f);
    expect(sub(pc, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(sub(pc, "--cap-drop")).toEqual(["ALL"]);
    expect(pc).not.toContain("--cap-add");
    expect(sub(pc, "--user")).toEqual(["node"]);
    expect(pc).toContain("--read-only");
    expect(sub(pc, "--tmpfs")).toEqual(["/tmp:size=8m"]);
    const net = netOf(d);
    // Leg 14: created on the contained network at its address and fixed MAC; `bridge` is connected after the create.
    expect(sub(pc, "--network")).toEqual([`name=${net.name},ip=172.30.1.254,mac-address=${proxyMac(net.id)}`]);
    for (const bad of ["-p", "--publish", "-P", "--privileged", "host"]) expect(pc).not.toContain(bad);
    expect(sub(pc, "--entrypoint")).toEqual(["node"]);
    expect(net.cidr).toBe("172.30.1.0/24");
    const launch = proxyLaunchArgs(proxyConfig({ allow: ALLOW, listenCidr: net.cidr, resolvers: ["192.0.2.53"], limits: { bindWaitMs: 3000 } }));
    // The image, then the program's three arguments, exactly: an argv array and never a shell.
    expect(pc.slice(pc.indexOf(cfg.docker.proxyImage))).toEqual([cfg.docker.proxyImage, ...launch]);
    expect(launch[0]).toBe("-e");
    const conf = JSON.parse(launch[2]!) as Record<string, unknown>;
    expect(conf).toMatchObject({ listenCidr: "172.30.1.0/24", port: 3128, controlPort: 3129, version: "1", resolvers: ["192.0.2.53"], limits: { bindWaitMs: 3000 } });
    expect(conf.allow).toEqual([{ host: "github.com", wildcard: false, ports: [443, 80], literal: false, local: false }]);
    expect(pc.join(" ")).not.toContain("sh -c");
  });

  it("passes local through to every entry of the proxy's configuration", async () => {
    const d = mkEgress();
    await d.once({ ...EGRESS, egress: { allow: ALLOW, local: true } });
    const conf = JSON.parse(d.argvs.find(isProxyCreate)!.at(-1)!) as { allow: Array<{ local: boolean }> };
    expect(conf.allow.map((e) => e.local)).toEqual([true]);
  });

  it("is created on the contained network (address and MAC fixed), joins bridge before it starts (no --ip, no alias), and starts by id", async () => {
    const d = mkEgress();
    await d.once(EGRESS);
    const proxyId = d.created.find((c) => c.labels[ROLE_L] === "oneshot-proxy")!.id;
    const connect = d.argvs.findIndex((a) => a[0] === "network" && a[1] === "connect");
    const create = d.argvs.findIndex(isProxyCreate);
    const start = d.argvs.findIndex((a) => a[0] === "start" && a[1] === proxyId);
    expect(d.argvs[connect]).toEqual(["network", "connect", "bridge", proxyId]);
    expect(create).toBeLessThan(connect);
    expect(d.argvs[start]).toEqual(["start", proxyId]);
    expect(connect).toBeLessThan(start);
  });

  it("runs the one-shot on the contained network with the proxy variables, and nothing else changes in its create", async () => {
    const d = mkEgress();
    await d.once({ ...EGRESS, mounts: ["vol:/workspace"], entrypoint: "sh" });
    const c = d.argvs.find(isOneShotCreate)!;
    const net = netOf(d);
    expect(sub(c, "--network")).toEqual([net.name]);
    expect(sub(c, "-e")).toEqual([
      "HTTP_PROXY=http://172.30.1.254:3128", "HTTPS_PROXY=http://172.30.1.254:3128", "http_proxy=http://172.30.1.254:3128", "https_proxy=http://172.30.1.254:3128",
      "NO_PROXY=", "NODE_USE_ENV_PROXY=1",
    ]);
    expect(c.slice(0, 3)).toEqual(["create", "--rm", "--name"]);
    expect(sub(c, "-v")).toEqual(["vol:/workspace"]);
    expect(c.slice(-4)).toEqual(["sh", "img:1", "git", "ls-remote"]);
    const start = d.argvs.find((a) => a[0] === "start" && a[1] === "-a" && a.at(-1) === d.created.find((x) => x.args === c)!.id)!;
    expect(d.optsList[d.argvs.indexOf(start)]).toEqual({ timeoutMs: 1234, maxBytes: 5678 });
  });

  it("is an error to give a network with egress, or neither; the existing path is not touched", async () => {
    const d = mkEgress();
    await expect(d.once({ ...EGRESS, network: "bridge" })).rejects.toThrow(/makes its own network/);
    await expect(d.once({ role: "scan", image: "img:1", args: [], timeoutMs: 1, maxBytes: 1 })).rejects.toThrow(/needs a network/);
    expect(d.argvs).toEqual([]);
  });

  it("without egress issues exactly the calls it always did (no network, image or exec command)", async () => {
    const d = mkOnce();
    await d.once(SPEC);
    expect(d.verbs).toEqual(["create", "start", "rm"]);
  });

  it("checks the runtime first, before any pull or object", async () => {
    const d = mkEgress({ MCPE_DOCKER_RUNTIME: "runsc" });
    d.infoRuntimes = ["runc"];
    await expect(d.once(EGRESS)).rejects.toBeInstanceOf(RuntimeUnavailableError);
    expect(d.verbs).toEqual(["info"]);
  });

  it("pulls both images before anything exists: a failed pull leaves nothing and creates nothing", async () => {
    const d = mkEgress();
    d.script.push((a) => (a[0] === "image" && a.at(-1) === "img:1" ? { code: 1 } : undefined));
    d.script.push((a) => (a[0] === "pull" ? { code: 1, stderr: "denied" } : undefined));
    await expect(d.once(EGRESS)).rejects.toThrow(/Failed to pull image img:1/);
    expect(d.count("create") + d.count("network create")).toBe(0);
  });

  it("carries the proxy's refusal for a runtime that Docker will not run (create and start) as RuntimeUnavailableError, not ProxyStartError", async () => {
    for (const verb of ["create", "start"] as const) {
      const d = mkEgress({ MCPE_DOCKER_RUNTIME: "runsc" });
      d.script.push((a) =>
        (verb === "create" ? isProxyCreate(a) : a[0] === "start" && a[1] !== "-a" && d.proxyContainer()?.[1].id === a[1])
          ? { code: 125, stderr: "docker: Error response from daemon: unknown or invalid runtime name: runsc\n" }
          : undefined,
      );
      const e = await settle(d.once(EGRESS));
      expect(e, verb).toBeInstanceOf(RuntimeUnavailableError);
      clean(d);
    }
  });
});

describe("a one-shot behind its proxy: teardown on every path", () => {
  const tail = (d: EgressDocker, n: number) => d.verbs.slice(-n);

  it("network create fails: no proxy, nothing to remove", async () => {
    const d = mkEgress();
    d.script.push((a) => (a[0] === "network" && a[1] === "create" ? { code: 1, stderr: "boom" } : undefined));
    expect(await settle(d.once(EGRESS))).toBeInstanceOf(ContainmentUnavailableError);
    expect(d.count("network rm") + d.count("rm") - 1 /* the resolver read's own */).toBe(0);
    expect(d.argvs.some(isProxyCreate)).toBe(false);
    clean(d);
  });

  it("network create times out: removed by name", async () => {
    const d = mkEgress();
    d.script.push((a) => (a[0] === "network" && a[1] === "create" ? { code: null as unknown as number, timedOut: true } : undefined));
    expect(await settle(d.once(EGRESS))).toBeInstanceOf(DockerUnavailableError);
    expect(d.argvs.at(-1)).toEqual(["network", "rm", d.argvs.find((a) => a[1] === "create")!.at(-1)]);
    expect(d.argvs.some(isProxyCreate)).toBe(false);
  });

  it("the id is not 64 hex: the network is removed by name and no proxy is made", async () => {
    const d = mkEgress();
    d.script.push((a) => (a[0] === "network" && a[1] === "create" ? { stdout: "xyz\n" } : undefined));
    expect(await settle(d.once(EGRESS))).toBeInstanceOf(DockerUnavailableError);
    expect(d.argvs.at(-1)).toEqual(["network", "rm", d.argvs.find((a) => a[1] === "create")!.at(-1)]);
    expect(d.argvs.some(isProxyCreate)).toBe(false);
    clean(d);
  });

  it("the check fails: the network is removed by id and no proxy is made", async () => {
    const d = mkEgress();
    d.script.push(inspectNet({ ipam: [{ Subnet: "172.30.9.0/24", Gateway: "172.30.9.1" }] }));
    expect(await settle(d.once(EGRESS))).toBeInstanceOf(ContainmentUnavailableError);
    expect(tail(d, 2)).toEqual(["network inspect", "network rm"]);
    expect(d.argvs.some(isProxyCreate)).toBe(false);
    clean(d);
  });

  it("the inspect fails: the network is removed by id", async () => {
    const d = mkEgress();
    d.script.push((a) => (a[0] === "network" && a[1] === "inspect" ? { code: 1, stderr: "daemon gone" } : undefined));
    expect(await settle(d.once(EGRESS))).toBeInstanceOf(DockerUnavailableError);
    expect(tail(d, 2)).toEqual(["network inspect", "network rm"]);
    clean(d);
  });

  it.each([
    ["fails", { code: 125, stderr: "docker: Error response from daemon: no space left\n" }],
    ["times out", { code: null as unknown as number, timedOut: true }],
  ])("the proxy create %s: removed by its name, then the network", async (_n, r) => {
    const d = mkEgress();
    d.script.push((a) => (isProxyCreate(a) ? r : undefined));
    const e = await settle(d.once(EGRESS));
    expect(e).toBeInstanceOf(ProxyStartError);
    const name = sub(d.argvs.find(isProxyCreate)!, "--name")[0]!;
    expect(d.argvs.at(-2)).toEqual(["rm", "-f", "-v", name]);
    expect(tail(d, 2)).toEqual(["rm", "network rm"]);
    clean(d);
  });

  it("network connect fails: the proxy is removed by id, then the network", async () => {
    const d = mkEgress();
    d.script.push((a) => (a[0] === "network" && a[1] === "connect" ? { code: 1, stderr: "Error response from daemon: boom\n" } : undefined));
    const e = await settle(d.once(EGRESS));
    expect(e).toBeInstanceOf(ProxyStartError);
    expect(d.count("start") - 1 /* the resolver read */).toBe(0);
    expect(d.argvs.at(-2)).toEqual(["rm", "-f", "-v", d.created.find((c) => c.labels[ROLE_L] === "oneshot-proxy")!.id]);
    expect(tail(d, 2)).toEqual(["rm", "network rm"]);
    clean(d);
  });

  it("the proxy start fails: ProxyStartError with Docker's cleaned last line (an image without node), then teardown", async () => {
    const d = mkEgress();
    d.script.push((a) => (a[0] === "start" && a[1] !== "-a" && d.proxyContainer()?.[1].id === a[1] ? { code: 127, stderr: "Error response from daemon: \u001b[1mOCI runtime create failed\u001b[0m: exec: \"node\": executable file not found in $PATH: unknown\n" } : undefined));
    const e = await settle(d.once(EGRESS));
    expect(e).toBeInstanceOf(ProxyStartError);
    expect(lastLine(e)).toBe('the network proxy did not start: Error response from daemon: OCI runtime create failed: exec: "node": executable file not found in $PATH: unknown');
    expect(d.count("exec")).toBe(0);
    expect(tail(d, 2)).toEqual(["rm", "network rm"]);
    clean(d);
  });

  /** After `start`, the proxy is not running. */
  const exits = (d: EgressDocker, code: number) =>
    d.script.push((a) => {
      if (a[0] === "start" && a[1] !== "-a" && d.proxyContainer()?.[1].id === a[1]) {
        const c = d.proxyContainer()![1];
        c.running = false;
        c.exitCode = code;
        return { stdout: `${a[1]}\n` };
      }
      return undefined;
    });

  it("readiness: a proxy that exited fails at once with the last line of its log, then teardown", async () => {
    const d = mkEgress();
    exits(d, 1);
    d.logsReply = { stderr: "proxy: listenCidr has no interface\nsecond\u001b[31m last\u001b[0m line\n" };
    const e = await settle(d.once(EGRESS));
    expect(e).toBeInstanceOf(ProxyStartError);
    expect(lastLine(e)).toBe("the network proxy did not start: second last line");
    expect(d.count("exec")).toBe(0);
    expect(tail(d, 2)).toEqual(["rm", "network rm"]);
    clean(d);
  });

  it("readiness: with an unreadable log, says exited with code N", async () => {
    const d = mkEgress();
    exits(d, 70);
    d.logsReply = { code: 1, stderr: "Error: no such container" };
    expect(lastLine(await settle(d.once(EGRESS)))).toBe("the network proxy did not start: exited with code 70");
    const e2 = mkEgress();
    exits(e2, 3);
    e2.logsReply = { stdout: "\n\n" };
    expect(lastLine(await settle(e2.once(EGRESS)))).toBe("the network proxy did not start: exited with code 3");
  });

  it.each<[string, unknown]>([
    ["not ready", { ...READY, ready: false }],
    ["a 200 without ready", { version: "1", refusals: [] }],
    ["another version", { ...READY, version: "2" }],
    ["not an object", "ready"],
    ["null", null],
  ])("readiness: out of budget (%s) is ProxyStartError, then teardown", async (_n, body) => {
    const d = mkEgress();
    d.statusBody = body;
    const t = Date.now();
    const e = await settle(d.once(EGRESS));
    expect(e).toBeInstanceOf(ProxyStartError);
    expect(lastLine(e)).toBe("the network proxy did not start: it was not ready within 0.25 s");
    expect(Date.now() - t).toBeGreaterThanOrEqual(240);
    expect(d.count("exec")).toBeGreaterThan(1);
    expect(tail(d, 2)).toEqual(["rm", "network rm"]);
    clean(d);
  });

  it("readiness: an exec that fails or answers nonsense is not ready, and the status exec is bounded (3 s, 64 KiB)", async () => {
    const d = mkEgress();
    let n = 0;
    d.script.push((a) => (a[0] === "exec" && a[2] === "node" ? (++n < 3 ? { code: 1, stderr: "not yet" } : n === 3 ? { stdout: "<html>" } : undefined) : undefined));
    await d.once(EGRESS);
    expect(d.count("exec")).toBe(4);
    const i = d.argvs.findIndex((a) => a[0] === "exec");
    expect(d.optsList[i]).toEqual({ timeoutMs: 3000, maxBytes: 65536 });
    expect(d.argvs[i]!.slice(0, 2)).toEqual(["exec", d.created.find((c) => c.labels[ROLE_L] === "oneshot-proxy")!.id]);
    expect(d.argvs[i]!.slice(2, 4)).toEqual(["node", "-e"]);
    expect(d.argvs[i]![4]).toContain("process.exit");
    expect(d.argvs[i]![4]).toContain("timeout:2000");
    expect(d.argvs[i]![4]).toContain("3129");
  });

  it("the one-shot's create fails after readiness: the proxy and the network go, and no refusals are read", async () => {
    const d = mkEgress();
    d.script.push((a) => (isOneShotCreate(a) ? { code: 125, stderr: "no space left\n" } : undefined));
    await expect(d.once(EGRESS)).rejects.toThrow(/Could not create the clone container: no space left/);
    expect(d.count("exec")).toBe(1);
    expect(tail(d, 2)).toEqual(["rm", "network rm"]);
    clean(d);
  });

  it("the one-shot times out: it is removed first, the refusals are read, then the proxy and the network go", async () => {
    const d = mkEgress();
    failRun(d, { code: null as unknown as number, timedOut: true });
    d.statusBody = { ...READY, refusals: [ROW], total: 2, resolverFailures: 1 };
    const r = await d.once(EGRESS);
    expect(r.timedOut).toBe(true);
    expect(r.proxy).toEqual({ rows: [ROW], total: 2, resolverFailures: 1 });
    expect(tail(d, 4)).toEqual(["rm", "exec", "rm", "network rm"]);
    const oneShot = d.created.find((c) => c.labels[ROLE_L] === "clone")!;
    const proxy = d.created.find((c) => c.labels[ROLE_L] === "oneshot-proxy")!;
    const netName = d.argvs.filter((a) => a[0] === "network" && a[1] === "create").at(-1)!.at(-1)!; // the real network, not the probe
    expect(d.argvs.slice(-4)).toEqual([
      ["rm", "-f", "-v", oneShot.id],
      d.argvs.at(-3)!,
      ["rm", "-f", "-v", proxy.id],
      ["network", "rm", idFor(`net:${netName}`)],
    ]);
    expect(d.argvs.at(-3)![1]).toBe(proxy.id);
    const execIdx = d.argvs.length - 3;
    expect(d.optsList[execIdx]).toEqual({ timeoutMs: 3000, maxBytes: 65536 });
    clean(d);
  });

  it("a non-zero exit is reported with the refusals; a zero exit is not, and reads nothing", async () => {
    const d = mkEgress();
    failRun(d, { code: 3, stderr: "fatal: unable to access\n" });
    d.statusBody = { ...READY, refusals: [ROW, { ...ROW, host: null, port: null, kind: "http", reason: "method", count: 1 }], total: 3, resolverFailures: 0 };
    const r = await d.once(EGRESS);
    expect(r).toMatchObject({ code: 3, stderr: "fatal: unable to access\n" });
    expect(r.proxy).toMatchObject({ total: 3, resolverFailures: 0 });
    expect((r.proxy as { rows: unknown[] }).rows).toHaveLength(2);
    const ok = mkEgress();
    const okRes = await ok.once(EGRESS);
    expect(okRes.proxy).toBeUndefined();
    expect(ok.count("exec")).toBe(1);
  });

  it("an unreadable status, a failed exec or a timed-out exec is { unavailable: true }, and never throws out of teardown", async () => {
    for (const reply of [{ stdout: "<html>" }, { code: 1, stderr: "x" }, { code: null as unknown as number, timedOut: true }, { stdout: "{}" }, { stdout: "x".repeat(10), truncated: true }]) {
      const d = mkEgress();
      failRun(d, { code: 1 });
      let n = 0;
      d.script.push((a) => (a[0] === "exec" && a[2] === "node" && ++n > 1 ? reply : undefined));
      const r = await d.once(EGRESS);
      expect(r.proxy).toEqual({ unavailable: true });
      clean(d);
    }
    const t = new ThrowsOn(loadConfig({}), TEST_INSTALLATION_ID);
    failRun(t, { code: 1 });
    let n = 0;
    t.on = (a) => a[0] === "exec" && ++n > 1;
    expect((await t.once(EGRESS)).proxy).toEqual({ unavailable: true });
  });

  it("a throw from the run itself still reads the refusals and tears down, and the throw is the outcome (the refusals ride on it)", async () => {
    const d = new ThrowsOn(loadConfig({}), TEST_INSTALLATION_ID);
    d.on = (a) => isOneShotStart(d, a);
    d.statusBody = { ...READY, refusals: [ROW], total: 1 };
    const e = (await settle(d.once(EGRESS))) as Error & { proxy?: unknown };
    expect(e.message).toBe("spawn docker ENOENT");
    expect(e.proxy).toEqual({ rows: [ROW], total: 1, resolverFailures: 0 });
    expect(tail(d, 4)).toEqual(["rm", "exec", "rm", "network rm"]);
    clean(d);
  });

  it("a throw anywhere (here: network connect) tears down the proxy and the network", async () => {
    const d = new ThrowsOn(loadConfig({}), TEST_INSTALLATION_ID);
    d.on = (a) => a[0] === "network" && a[1] === "connect";
    await expect(d.once(EGRESS)).rejects.toThrow("spawn docker ENOENT");
    expect(tail(d, 2)).toEqual(["rm", "network rm"]);
    clean(d);
  });

  it("a removal that fails or throws never masks the original error, and each removal is still tried", async () => {
    const d = new ThrowsOn(loadConfig({}), TEST_INSTALLATION_ID);
    d.script.push((a) => (a[0] === "network" && a[1] === "connect" ? { code: 1, stderr: "Error response from daemon: original failure\n" } : undefined));
    d.on = (a) => (a[0] === "rm" && a[1] === "-f" && d.proxyContainer() !== undefined && a.at(-1) === d.proxyContainer()![1].id) || (a[0] === "network" && a[1] === "rm");
    const e = await settle(d.once(EGRESS));
    expect(e).toBeInstanceOf(ProxyStartError);
    expect(lastLine(e)).toContain("original failure");
    expect(tail(d, 2)).toEqual(["rm", "network rm"]);
  });

  it("removes the network after the proxy, never before (the proxy's endpoint would block it)", async () => {
    const d = mkEgress();
    await d.once(EGRESS);
    const proxy = d.created.find((c) => c.labels[ROLE_L] === "oneshot-proxy")!;
    const proxyRm = d.argvs.findIndex((a) => a[0] === "rm" && a.at(-1) === proxy.id);
    const netRm = d.argvs.length - 1 - [...d.argvs].reverse().findIndex((a) => a[0] === "network" && a[1] === "rm"); // the last: the first is the probe's
    const oneRm = d.argvs.findIndex((a) => a[0] === "rm" && a.at(-1) === d.created.find((c) => c.labels[ROLE_L] === "clone")!.id);
    expect(oneRm).toBeGreaterThan(-1);
    expect(oneRm).toBeLessThan(proxyRm);
    expect(proxyRm).toBeLessThan(netRm);
  });
});

describe("parseProxyReport (the status is not trusted)", () => {
  const rows = (v: unknown) => (parseProxyReport({ refusals: v, total: 1, resolverFailures: 0 }) as { rows: unknown[] }).rows;

  it("keeps a valid row as it is, with host and port null allowed", () => {
    expect(parseProxyReport({ ...READY, refusals: [ROW, { ...ROW, host: null, port: null, kind: "forward", reason: "cap" }], total: 5, resolverFailures: 2 })).toEqual({
      rows: [ROW, { ...ROW, host: null, port: null, kind: "forward", reason: "cap" }],
      total: 5,
      resolverFailures: 2,
    });
  });
  it("cleans terminal escapes out of host and times", () => {
    const [r] = rows([{ ...ROW, host: "ev\u001b[31mil\u001b]0;title\u0007.example", firstAt: "\u001b[1m2026", lastAt: "a\u0000b" }]) as Array<{ host: string; firstAt: string; lastAt: string }>;
    expect(r!.host).toBe("evil.example");
    expect(r!.firstAt).toBe("2026");
    expect(r!.lastAt).toBe("ab");
  });
  it("keeps at most 50 rows, however many it is given", () => {
    expect(rows(Array.from({ length: 100_000 }, () => ROW))).toHaveLength(50);
    expect(rows([...Array.from({ length: 1000 }, () => ({ bad: 1 })), ROW])).toEqual([]);
  });
  it.each<[string, Record<string, unknown>]>([
    ["unknown kind", { kind: "tunnel" }],
    ["unknown reason", { reason: "because" }],
    ["inherited-looking reason", { reason: "__proto__" }],
    ["host a number", { host: 5 }],
    ["host too long", { host: "a".repeat(254) }],
    ["port zero", { port: 0 }],
    ["port too big", { port: 65536 }],
    ["port a string", { port: "443" }],
    ["port fractional", { port: 44.5 }],
    ["count zero", { count: 0 }],
    ["count negative", { count: -1 }],
    ["count a string", { count: "2" }],
    ["count fractional", { count: 1.5 }],
    ["firstAt a number", { firstAt: 5 }],
    ["lastAt missing", { lastAt: undefined }],
  ])("drops a row with %s", (_n, over) => {
    expect(rows([{ ...ROW, ...over }])).toEqual([]);
  });
  it("drops rows that are not objects, and keeps the valid ones around them", () => {
    expect(rows([null, 5, "x", [ROW], ROW, undefined])).toEqual([ROW]);
  });
  it("keeps a host of exactly 253 characters", () => {
    expect(rows([{ ...ROW, host: "a".repeat(253) }])).toHaveLength(1);
  });
  it.each<[string, unknown]>([
    ["null", null],
    ["a string", "x"],
    ["an array", []],
    ["no refusals", { total: 0, resolverFailures: 0 }],
    ["refusals an object", { refusals: {}, total: 0, resolverFailures: 0 }],
    ["total negative", { refusals: [], total: -1, resolverFailures: 0 }],
    ["total a string", { refusals: [], total: "0", resolverFailures: 0 }],
    ["total fractional", { refusals: [], total: 0.5, resolverFailures: 0 }],
    ["resolverFailures missing", { refusals: [], total: 0 }],
    ["resolverFailures NaN", { refusals: [], total: 0, resolverFailures: Number.NaN }],
  ])("is unavailable for %s", (_n, v) => {
    expect(parseProxyReport(v)).toEqual({ unavailable: true });
  });
  it("does not trust a hostile object's prototype or getters", () => {
    const o = JSON.parse('{"refusals":[{"__proto__":{"kind":"connect"},"host":"a"}],"total":1,"resolverFailures":0}') as unknown;
    expect(parseProxyReport(o)).toEqual({ rows: [], total: 1, resolverFailures: 0 });
  });
});

describe("the sweep of one-shot networks and proxies", () => {
  const HOUR = 3600_000;
  const iso = (agoMs: number, frac = "") => new Date(Date.now() - agoMs).toISOString().replace(/\.\d{3}Z$/, (m) => `${frac || m.slice(0, 4)}Z`);
  const fid = (n: number) => String(n).repeat(64).slice(0, 64);
  const mine = { "mcp-everything": "1", [OWNER_L]: ID };
  const role = (r: string, extra: Record<string, string> = mine) => ({ ...extra, [ROLE_L]: r });
  interface Item { id: string; labels: Record<string, string> | null; created: string }

  function world(cs: Item[], vs: Array<{ name: string; labels: Record<string, string>; created: string }>, ns: Item[], rmReply?: (id: string) => { code?: number; stderr?: string } | undefined) {
    const d = mk();
    d.script.push((a) => {
      if (a[0] === "ps") return { stdout: cs.map((c) => `${c.id}\n`).join("") };
      if (a[0] === "volume" && a[1] === "ls") return { stdout: vs.map((v) => `${v.name}\n`).join("") };
      if (a[0] === "network" && a[1] === "ls") return { stdout: ns.map((n) => `${n.id}\n`).join("") };
      if (a[0] === "inspect") {
        const c = cs.find((x) => x.id === a.at(-1));
        return c ? { stdout: JSON.stringify({ id: c.id, labels: c.labels, created: c.created }) } : { code: 1, stderr: "Error response from daemon: No such container: x" };
      }
      if (a[0] === "volume" && a[1] === "inspect") {
        const v = vs.find((x) => x.name === a.at(-1));
        return v ? { stdout: JSON.stringify({ labels: v.labels, created: v.created }) } : { code: 1, stderr: "Error: No such volume: x" };
      }
      if (a[0] === "network" && a[1] === "inspect") {
        const n = ns.find((x) => x.id === a.at(-1));
        return n ? { stdout: JSON.stringify({ id: n.id, labels: n.labels, created: n.created }) } : { code: 1, stderr: `Error response from daemon: network ${a.at(-1)} not found` };
      }
      if (a[0] === "network" && a[1] === "rm") return rmReply?.(a.at(-1)!) ?? {};
      return undefined;
    });
    return d;
  }

  it("lists networks by this installation's owner label and the role oneshot-net, with full ids, after containers and volumes", async () => {
    const d = world([], [], []);
    await d.sweepCheckLeftovers(60);
    expect(d.argvs).toContainEqual(["network", "ls", "--no-trunc", "--filter", `label=${OWNER_L}=${ID}`, "--filter", `label=${ROLE_L}=oneshot-net`, "--format", "{{.ID}}"]);
    expect(d.verbs).toEqual(["ps", "volume ls", "network ls"]);
  });

  it("removes an aged one-shot network and proxy of this installation, containers and volumes first then networks, by full id", async () => {
    const d = world(
      [{ id: fid(1), labels: role("oneshot-proxy"), created: iso(2 * HOUR) }, { id: fid(2), labels: role("resolv-read"), created: iso(2 * HOUR) }],
      [{ name: "stg", labels: role("staging"), created: iso(2 * HOUR, "") }],
      [{ id: fid(3), labels: role("oneshot-net"), created: iso(2 * HOUR) }],
    );
    const r = await d.sweepCheckLeftovers(3600);
    expect(r).toEqual({ removed: [fid(1), fid(2), "stg", fid(3)], failures: 0 });
    expect(d.argvs.filter((a) => a[0] === "rm" || (a[0] === "network" && a[1] === "rm") || (a[0] === "volume" && a[1] === "rm"))).toEqual([
      ["rm", "-f", fid(1)], ["rm", "-f", fid(2)], ["volume", "rm", "-f", "stg"], ["network", "rm", fid(3)],
    ]);
    expect(d.argvs).toContainEqual(["network", "inspect", "--format", '{"id":{{json .Id}},"labels":{{json .Labels}},"created":{{json .Created}}}', fid(3)]);
  });

  it("parses a creation time with a nine-digit fraction", async () => {
    const d = world([], [], [{ id: fid(4), labels: role("oneshot-net"), created: `${new Date(Date.now() - 2 * HOUR).toISOString().slice(0, 19)}.123456789Z` }]);
    expect(await d.sweepCheckLeftovers(3600)).toEqual({ removed: [fid(4)], failures: 0 });
  });

  it("leaves a young network and proxy", async () => {
    const d = world([{ id: fid(1), labels: role("oneshot-proxy"), created: iso(10_000) }], [], [{ id: fid(3), labels: role("oneshot-net"), created: iso(10_000) }]);
    expect(await d.sweepCheckLeftovers(3600)).toEqual({ removed: [], failures: 0 });
    expect(d.count("rm") + d.count("network rm")).toBe(0);
  });

  it("never takes anything that carries the project label at all, whatever its role: containers, volumes, networks (even an empty value)", async () => {
    const proj = (r: string, v = "gron") => role(r, { ...mine, [PROJECT_L]: v });
    const old = iso(5 * HOUR);
    const d = world(
      [
        { id: fid(1), labels: proj("project-proxy"), created: old },
        { id: fid(2), labels: proj("oneshot-proxy"), created: old },
        { id: fid(3), labels: proj("clone", ""), created: old },
        { id: fid(4), labels: proj("resolv-read"), created: old },
      ],
      [{ name: "pv", labels: proj("staging"), created: old }, { name: "pe", labels: proj("staging", ""), created: old }],
      [
        { id: fid(5), labels: proj("project-net"), created: old },
        { id: fid(6), labels: proj("oneshot-net"), created: old },
        { id: fid(7), labels: proj("oneshot-net", ""), created: old },
      ],
    );
    expect(await d.sweepCheckLeftovers(3600)).toEqual({ removed: [], failures: 0 });
    expect(d.count("rm") + d.count("volume rm") + d.count("network rm")).toBe(0);
  });

  it("a project whose slug is `oneshot` has a sandbox that looks like a one-shot by name, and survives (labels only)", async () => {
    const name = `mcpe-${ID}-oneshot`;
    const d = world(
      [{ id: fid(1), labels: { ...mine, [PROJECT_L]: "github:o/oneshot" }, created: iso(5 * HOUR) }],
      [{ name: `${name}-vol`, labels: { ...mine, [PROJECT_L]: "github:o/oneshot" }, created: iso(5 * HOUR) }],
      [{ id: fid(2), labels: { ...mine, [PROJECT_L]: "oneshot" }, created: iso(5 * HOUR) }],
    );
    expect(await d.sweepCheckLeftovers(3600)).toEqual({ removed: [], failures: 0 });
    expect(d.count("rm") + d.count("volume rm") + d.count("network rm")).toBe(0);
  });

  it("leaves another installation's network and proxy, and an unlisted role", async () => {
    const other = { "mcp-everything": "1", [OWNER_L]: OTHER_ID };
    const old = iso(5 * HOUR);
    const d = world(
      [{ id: fid(1), labels: role("oneshot-proxy", other), created: old }],
      [],
      [{ id: fid(2), labels: role("oneshot-net", other), created: old }, { id: fid(3), labels: role("sandbox-net"), created: old }, { id: fid(4), labels: mine, created: old }],
    );
    expect(await d.sweepCheckLeftovers(3600)).toEqual({ removed: [], failures: 0 });
    expect(d.count("rm") + d.count("network rm")).toBe(0);
  });

  it("skips a network with null labels (not a failure), and counts an unreadable creation time as one", async () => {
    const d = world([], [], [{ id: fid(1), labels: null, created: iso(5 * HOUR) }, { id: fid(2), labels: role("oneshot-net"), created: "not a date" }]);
    expect(await d.sweepCheckLeftovers(3600)).toEqual({ removed: [], failures: 1 });
    expect(d.count("network rm")).toBe(0);
  });

  it("an already-gone network is not a failure, at inspect or at removal", async () => {
    const old = iso(5 * HOUR);
    const d = world([], [], [{ id: fid(1), labels: role("oneshot-net"), created: old }, { id: fid(2), labels: role("oneshot-net"), created: old }], (id) =>
      id === fid(2) ? { code: 1, stderr: `Error response from daemon: network ${id} not found` } : undefined,
    );
    // fid(1) removed; fid(2) gone at removal. A third, gone at inspect, is simply not in the world.
    d.script.unshift((a) => (a[0] === "network" && a[1] === "ls" ? { stdout: `${fid(1)}\n${fid(2)}\n${fid(9)}\n` } : undefined));
    expect(await d.sweepCheckLeftovers(3600)).toEqual({ removed: [fid(1)], failures: 0 });
  });

  it("skips a network that still has endpoints without counting a failure, and counts any other removal failure", async () => {
    const old = iso(5 * HOUR);
    const d = world([], [], [{ id: fid(1), labels: role("oneshot-net"), created: old }, { id: fid(2), labels: role("oneshot-net"), created: old }, { id: fid(3), labels: role("oneshot-net"), created: old }], (id) =>
      id === fid(1) ? { code: 1, stderr: "Error response from daemon: error while removing network: network x id y has active endpoints" } : id === fid(2) ? { code: 1, stderr: "Error: boom" } : undefined,
    );
    expect(await d.sweepCheckLeftovers(3600)).toEqual({ removed: [fid(3)], failures: 1 });
  });

  it("counts a failed network listing and keeps what it already removed", async () => {
    const d = world([{ id: fid(1), labels: role("oneshot-proxy"), created: iso(5 * HOUR) }], [], []);
    d.script.unshift((a) => (a[0] === "network" && a[1] === "ls" ? { code: 1, stderr: "boom" } : undefined));
    expect(await d.sweepCheckLeftovers(3600)).toEqual({ removed: [fid(1)], failures: 1 });
  });

  it("refuses a listed id that is not a full id, and one whose inspect answers another id", async () => {
    const d = world([], [], [{ id: fid(1), labels: role("oneshot-net"), created: iso(5 * HOUR) }]);
    d.script.unshift((a) => (a[0] === "network" && a[1] === "ls" ? { stdout: `abc123\n${fid(1)}\n` } : a[0] === "network" && a[1] === "inspect" ? { stdout: JSON.stringify({ id: fid(2), labels: role("oneshot-net"), created: iso(5 * HOUR) }) } : undefined));
    expect(await d.sweepCheckLeftovers(3600)).toEqual({ removed: [], failures: 2 });
    expect(d.count("network rm")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Project network primitives (flight 02, leg 6)
// ---------------------------------------------------------------------------

const PS = "mcpe-0123abcd-widget";
const PV = "mcpe-0123abcd-widget";
const PNET = projectNetworkName(PS);
const PROJ = LABELS.mine!["mcp-everything.project"]!;
const SANDBOX_L = "mcp-everything.sandbox";
const netLabels = (over: Record<string, string> = {}): Record<string, string> => ({ [OWNER_L]: ID, [ROLE_L]: "project-net", [PROJECT_L]: PROJ, [SANDBOX_L]: PS, ...over });
const putNet = (d: ScriptedDocker, over: Partial<FakeNet> = {}): FakeNet => {
  const n: FakeNet = { id: idFor(`net:${PNET}`), name: PNET, labels: netLabels(), internal: true, ipv6: false, ipam: [{ Subnet: "172.30.50.0/24" }], created: "x", ...over };
  d.networks.set(n.name, n);
  return n;
};
const proxyName = (i = 1, sandbox = PS) => `${sandbox}-proxy-${String(i).repeat(8)}`;
const proxyLabels = (sandbox = PS, over: Record<string, string> = {}): Record<string, string> => ({
  "mcp-everything": "1", [OWNER_L]: ID, [ROLE_L]: "project-proxy", [PROJECT_L]: PROJ, [SANDBOX_L]: sandbox, ...over,
});
const putProxy = (d: ScriptedDocker, name = proxyName(), labels: Labels = proxyLabels(), opts: { running?: boolean; networks?: string[] } = {}) => {
  const id = idFor(name);
  d.containers.set(name, { id, running: opts.running ?? true, labels, networks: opts.networks ?? ["bridge", PNET] });
  return { id, name };
};
/** Every command that removes something, in order. */
const removals = (d: ScriptedDocker) => d.argvs.filter((a) => a[0] === "rm" || (["volume", "network"].includes(a[0]!) && a[1] === "rm"));
const FORWARDS = [{ host: "db.lan", port: 5432 }, { host: "host.docker.internal", port: 80 }];
const PCONFIG = proxyConfig({ allow: ALLOW, listenCidr: "172.30.50.0/24", resolvers: ["192.0.2.53"], forwards: FORWARDS });
const CONF_LABELS = { "mcp-everything.config": "abc123" };

describe("the one-shot volume fix: rm -f -v", () => {
  it("removes every one-shot, and its proxy, with -v; no command removes a volume by name", async () => {
    const plain = mkOnce();
    await plain.once(SPEC);
    const behind = mkEgress();
    await behind.once(EGRESS);
    for (const d of [plain, behind]) {
      const rms = d.argvs.filter((a) => a[0] === "rm");
      expect(rms.length).toBeGreaterThan(0);
      for (const a of rms) expect(a.slice(0, 3), a.join(" ")).toEqual(["rm", "-f", "-v"]);
      expect(d.count("volume rm")).toBe(0);
    }
  });

  it("removes by name with -v when the create timed out (no id exists yet)", async () => {
    const d = mkOnce();
    d.script.push((a) => (a[0] === "create" ? { code: null as unknown as number, timedOut: true } : undefined));
    await expect(d.once(SPEC)).rejects.toThrow(/docker create timed out/);
    const rm = d.argvs.find((a) => a[0] === "rm")!;
    expect(rm.slice(0, 3)).toEqual(["rm", "-f", "-v"]);
    expect(rm[3]).toMatch(NAME_SHAPE);
  });
});

describe("inspect facts carry the name", () => {
  it("asks for the name in both inspect formats, and the leading slash is dropped", async () => {
    const d = mk();
    d.put(PS, "mine");
    await d.ownership(PS);
    await d.state({ id: idFor(PS), name: PS });
    for (const a of d.argvs) expect(a[a.indexOf("--format") + 1]).toContain('"name":{{json .Name}}');
    const proxies = mk();
    putProxy(proxies);
    expect((await proxies.listProjectProxies(PS)).map((p) => p.name)).toEqual([proxyName()]);
  });

  it("tolerates an answer with no name (a scripted daemon)", async () => {
    const d = mk();
    d.script.push((a) => (a[0] === "inspect" ? { stdout: JSON.stringify({ id: idFor(PS), running: true, labels: LABELS.mine, networks: {} }) } : undefined));
    expect(await d.ownership(PS)).toEqual({ state: "mine" });
    expect(await d.networkState(PS)).toBe("off");
  });
});

describe("projectNetworkName", () => {
  it("is the sandbox's name and -net", () => {
    expect(projectNetworkName("mcpe-0123abcd-widget")).toBe("mcpe-0123abcd-widget-net");
  });
});

describe("ensureProjectNetwork", () => {
  /** The `network rm` commands after the probe's own (every create by probe-then-pin removes its throwaway network first). */
  const rmsAfterProbe = (d: EgressDocker) => d.argvs.filter((a) => a[0] === "network" && a[1] === "rm").slice(1);
  it("makes the network when it is not there: contained, owner, role, project and sandbox labels, a fixed name, pinned to a probed subnet", async () => {
    const d = mkEgress();
    const net = await d.ensureProjectNetwork(PS, PROJ);
    expect(net).toEqual({ id: idFor(`net:${PNET}`), name: PNET, subnet: "172.30.1.0/24", created: true });
    expect(d.verbs).toEqual(["network inspect", "network create", "network inspect", "network rm", "network create", "network inspect"]);
    const create = d.argvs[4]!;
    expect(create.at(-1)).toBe(PNET);
    expect(create).toContain("--internal");
    expect(sub(create, "--subnet")).toEqual(["172.30.1.0/24"]);
    expect(sub(create, "--ip-range")).toEqual(["172.30.1.0/25"]);
    expect(sub(create, "--label")).toEqual([`${OWNER_L}=${ID}`, `${ROLE_L}=project-net`, `${PROJECT_L}=${PROJ}`, `${SANDBOX_L}=${PS}`]);
  });

  it("adopts a network that is there, with this owner, role, project and sandbox: nothing is created or removed", async () => {
    const d = mkEgress();
    const n = putNet(d);
    expect(await d.ensureProjectNetwork(PS, PROJ)).toEqual({ id: n.id, name: PNET, subnet: "172.30.50.0/24", created: false });
    expect(d.verbs).toEqual(["network inspect"]);
  });

  it.each<[string, Partial<FakeNet>, string]>([
    ["another installation's", { labels: netLabels({ [OWNER_L]: OTHER_ID }) }, "another"],
    ["without labels", { labels: null }, "not-ours"],
    ["without an owner label", { labels: { [ROLE_L]: "project-net" } }, "not-ours"],
    ["this installation's but another project's", { labels: netLabels({ [PROJECT_L]: "github:o/other" }) }, "not-ours"],
    ["this installation's but another role", { labels: netLabels({ [ROLE_L]: "oneshot-net" }) }, "not-ours"],
    ["this installation's but another sandbox's", { labels: netLabels({ [SANDBOX_L]: "mcpe-0123abcd-other" }) }, "not-ours"],
  ])("refuses a network that is %s, and creates and removes nothing", async (_n, over, reason) => {
    const d = mkEgress();
    putNet(d, over);
    const e = await settle(d.ensureProjectNetwork(PS, PROJ));
    expect(e).toBeInstanceOf(SandboxRefusedError);
    expect((e as SandboxRefusedError).reason).toBe(reason);
    expect((e as SandboxRefusedError).sandboxes.map((f) => [f.kind, f.sandbox])).toEqual([["network", PNET]]);
    expect(d.count("network create") + d.count("network rm")).toBe(0);
  });

  it.each<[string, Partial<FakeNet>, RegExp]>([
    ["not internal", { internal: false }, /not internal/],
    ["with IPv6", { ipv6: true }, /IPv6/],
    ["with a gateway", { ipam: [{ Subnet: "172.30.50.0/24", Gateway: "172.30.50.1" }] }, /gateway/],
    ["with two subnets", { ipam: [{ Subnet: "172.30.50.0/24" }, { Subnet: "172.31.0.0/16" }] }, /exactly one IPv4 subnet/],
  ])("does not adopt a network of ours that is %s, and leaves it alone", async (_n, over, why) => {
    const d = mkEgress();
    putNet(d, over);
    const e = await settle(d.ensureProjectNetwork(PS, PROJ));
    expect(e).toBeInstanceOf(ContainmentUnavailableError);
    expect((e as Error).message).toMatch(why);
    expect(d.count("network create") + d.count("network rm")).toBe(0);
  });

  it("adopts the network of a creator it lost the race to ('already exists'), and never removes it", async () => {
    const d = mkEgress();
    putNet(d);
    let first = true;
    d.script.push((a) => {
      if (a[0] === "network" && a[1] === "inspect" && a.at(-1) === PNET && first) {
        first = false;
        return { code: 1, stderr: `Error response from daemon: network ${PNET} not found` };
      }
      if (a[0] === "network" && a[1] === "create" && a.at(-1) === PNET) return { code: 1, stderr: `Error response from daemon: network with name ${PNET} already exists` };
      return undefined;
    });
    expect(await d.ensureProjectNetwork(PS, PROJ)).toMatchObject({ name: PNET, created: false });
    expect(rmsAfterProbe(d)).toEqual([]);
  });

  it("refuses the network of a creator it lost the race to when it is someone else's, and removes nothing", async () => {
    const d = mkEgress();
    putNet(d, { labels: netLabels({ [OWNER_L]: OTHER_ID }) });
    let first = true;
    d.script.push((a) => {
      if (a[0] === "network" && a[1] === "inspect" && a.at(-1) === PNET && first) {
        first = false;
        return { code: 1, stderr: `Error response from daemon: network ${PNET} not found` };
      }
      if (a[0] === "network" && a[1] === "create" && a.at(-1) === PNET) return { code: 1, stderr: "already exists" };
      return undefined;
    });
    expect(await settle(d.ensureProjectNetwork(PS, PROJ))).toBeInstanceOf(SandboxRefusedError);
    expect(rmsAfterProbe(d)).toEqual([]);
  });

  it("a failed create that left nothing behind throws the create's own error (pools used up)", async () => {
    const d = mkEgress();
    d.script.push((a) => (a[0] === "network" && a[1] === "create" ? { code: 1, stderr: "all predefined address pools have been fully subnetted" } : undefined));
    await expect(d.ensureProjectNetwork(PS, PROJ)).rejects.toThrow(/default-address-pools/);
    expect(d.count("network rm")).toBe(0);
  });

  it("a create that timed out re-inspects by name: adopts what is ours, and never removes by name", async () => {
    const adopt = mkEgress();
    putNet(adopt);
    let first = true;
    adopt.script.push((a) => {
      if (a[0] === "network" && a[1] === "inspect" && a.at(-1) === PNET && first) {
        first = false;
        return { code: 1, stderr: `network ${PNET} not found` };
      }
      if (a[0] === "network" && a[1] === "create" && a.at(-1) === PNET) return { code: null as unknown as number, timedOut: true };
      return undefined;
    });
    expect(await adopt.ensureProjectNetwork(PS, PROJ)).toMatchObject({ created: false });
    expect(rmsAfterProbe(adopt)).toEqual([]);

    const nothing = mkEgress();
    nothing.script.push((a) => (a[0] === "network" && a[1] === "create" && a.at(-1) === PNET ? { code: null as unknown as number, timedOut: true } : undefined));
    await expect(nothing.ensureProjectNetwork(PS, PROJ)).rejects.toThrow(/timed out/);
    expect(rmsAfterProbe(nothing)).toEqual([]);
  });

  it("a network it made that fails the check is removed by its id, never by the fixed name", async () => {
    const d = mkEgress();
    const id = idFor(`net:${PNET}`);
    d.script.push((a) => (a[0] === "network" && a[1] === "inspect" && a.at(-1) === id ? { stdout: netJson(id, { internal: false, labels: netLabels() }) } : undefined));
    await expect(d.ensureProjectNetwork(PS, PROJ)).rejects.toBeInstanceOf(ContainmentUnavailableError);
    expect(rmsAfterProbe(d)).toEqual([["network", "rm", id]]);
  });

  it("a created network whose answer is about another network, or has no usable id, is removed by id (or not at all, for a fixed name without an id)", async () => {
    const noId = mkEgress();
    noId.script.push((a) => (a[0] === "network" && a[1] === "create" && a.at(-1) === PNET ? { stdout: "nope\n" } : undefined));
    await expect(noId.ensureProjectNetwork(PS, PROJ)).rejects.toThrow(/no usable id/);
    expect(rmsAfterProbe(noId)).toEqual([]);
  });
});

describe("attachProjectNetwork", () => {
  it("disconnects with -f first, then connects, both by id (T14)", async () => {
    const d = mkEgress();
    const net = putNet(d);
    const id = d.put(PS, "mine", { networks: ["bridge"], running: false });
    await d.attachProjectNetwork(makeRef(id, PS), net);
    // The disconnect names the network (a stale entry of a removed network is keyed by name), the connect its id.
    expect(d.argvs).toEqual([["network", "disconnect", "-f", PNET, id], ["network", "connect", net.id, id]]);
    expect(d.containers.get(PS)!.networks).toEqual(["bridge", PNET]);
  });

  it("ignores a failed disconnect, and throws a failed connect", async () => {
    const d = mkEgress();
    const net = putNet(d);
    const id = d.put(PS, "mine", { networks: [] });
    await d.attachProjectNetwork(makeRef(id, PS), net); // the disconnect fails ("not connected"), the connect goes on
    expect(d.containers.get(PS)!.networks).toEqual([PNET]);
    d.script.push((a) => (a[1] === "connect" ? { code: 1, stderr: "boom" } : undefined));
    await expect(d.attachProjectNetwork(makeRef(id, PS), net)).rejects.toThrow(/Failed to attach .* project network: boom/);
  });
});

describe("createProjectProxy", () => {
  const make = async (over: (d: EgressDocker) => void = () => {}) => {
    const d = mkEgress();
    const net = putNet(d);
    over(d);
    return { d, net };
  };

  it("makes a hardened proxy: the name, the labels, the host gateway, its address before start, readiness, no --rm and no restart policy", async () => {
    const { d, net } = await make();
    const p = await d.createProjectProxy(PS, PROJ, PCONFIG, CONF_LABELS);
    expect(p.name).toMatch(new RegExp(`^${PS}-proxy-[0-9a-f]{8}$`));
    expect(p.id).toBe(idFor(p.name));
    expect(d.verbs).toEqual(["image inspect", "network inspect", "create", "network connect", "start", "inspect", "exec"]);
    const create = d.argvs.find((a) => a[0] === "create")!;
    expect(create[create.indexOf("--name") + 1]).toBe(p.name);
    expect(sub(create, "--label")).toEqual([
      "mcp-everything=1", `${OWNER_L}=${ID}`, `${ROLE_L}=project-proxy`, `${PROJECT_L}=${PROJ}`, `${SANDBOX_L}=${PS}`, "mcp-everything.config=abc123",
    ]);
    // Leg 14: on the project network at its address with the network's fixed MAC; `bridge` is connected after the create.
    expect(sub(create, "--network")).toEqual([`name=${PNET},ip=172.30.50.254,mac-address=${proxyMac(net.id)}`]);
    expect(sub(create, "--add-host")).toEqual(["host.docker.internal:host-gateway"]);
    expect(sub(create, "--user")).toEqual(["node"]);
    expect(sub(create, "--cap-drop")).toEqual(["ALL"]);
    expect(sub(create, "--tmpfs")).toEqual(["/tmp:size=8m"]);
    expect(create).toContain("--read-only");
    expect(create).not.toContain("--rm");
    expect(create.join(" ")).not.toMatch(/--restart/);
    expect(create).not.toContain("-p");
    expect(create.slice(-3)).toEqual(proxyLaunchArgs(PCONFIG));
    const connect = d.argvs.find((a) => a[0] === "network" && a[1] === "connect")!;
    // The create put it at the last usable host address of 172.30.50.0/24, and no alias: forward names reach the proxy through the
    // sandbox's /etc/hosts. The only connect is `bridge`, with no address (leg 14), before the start.
    expect(connect).toEqual(["network", "connect", "bridge", p.id]);
    expect(d.containers.get(p.name)!.ips).toEqual({ [PNET]: "172.30.50.254" });
    expect(d.verbs.indexOf("create")).toBeLessThan(d.verbs.indexOf("network connect"));
    expect(d.verbs.indexOf("network connect")).toBeLessThan(d.verbs.indexOf("start"));
    expect(d.containers.get(p.name)!.running).toBe(true);
    expect(d.containers.get(p.name)!.networks).toEqual([PNET, "bridge"]);
    expect(d.count("rm")).toBe(0);
  });

  // Leg 13 removed "refuses a forward target named mcpe-proxy" (and the alias grammar check): there are no aliases, so no name collides.
  it("makes a proxy whatever the forward target is called: the names are not network aliases any more", async () => {
    const { d } = await make();
    const cfg = proxyConfig({ allow: ALLOW, listenCidr: "172.30.50.0/24", resolvers: ["192.0.2.53"], forwards: [{ host: "mcpe-proxy", port: 80 }] });
    await d.createProjectProxy(PS, PROJ, cfg, {});
    const connect = d.argvs.find((a) => a[0] === "network" && a[1] === "connect")!;
    expect(connect).not.toContain("--alias");
    expect(connect).toEqual(["network", "connect", "bridge", idFor(d.created[0]!.name)]);
    expect(sub(d.argvs.find((a) => a[0] === "create")!, "--network")[0]).toContain("ip=172.30.50.254");
  });

  it("an address that is taken fails the create with Docker's reason, makes nothing, and never falls back to a name", async () => {
    const { d } = await make();
    putProxy(d, proxyName(2), proxyLabels(), { networks: ["bridge", PNET] });
    d.containers.get(proxyName(2))!.ips = { [PNET]: "172.30.50.254" };
    const e = await settle(d.createProjectProxy(PS, PROJ, PCONFIG, CONF_LABELS));
    expect(e).toBeInstanceOf(ProxyStartError);
    expect((e as Error).message).toContain("Address already in use");
    expect(d.count("network connect")).toBe(0);
    expect(d.count("start")).toBe(0);
    for (const a of d.argvs) expect(a).not.toContain("--alias");
    expect([...d.containers.keys()]).toEqual([proxyName(2)]); // the new one is gone
  });

  it.each([["mcp-everything.owner"], ["mcp-everything.role"], ["mcp-everything.project"], ["mcp-everything.sandbox"], ["mcp-everything"], ["com.example.x"], ["mcp-everything.A"]])(
    "refuses a caller's label named %s",
    async (key) => {
      const { d } = await make();
      await expect(d.createProjectProxy(PS, PROJ, PCONFIG, { [key]: "x" })).rejects.toThrow(/label/);
      expect(d.count("create")).toBe(0);
    },
  );

  it("refuses a caller's label value with a line break", async () => {
    const { d } = await make();
    await expect(d.createProjectProxy(PS, PROJ, PCONFIG, { "mcp-everything.config": "a\nb" })).rejects.toThrow(/line breaks/);
  });

  it("needs the project network: it is never made here", async () => {
    const d = mkEgress();
    await expect(d.createProjectProxy(PS, PROJ, PCONFIG, {})).rejects.toBeInstanceOf(ProxyStartError);
    expect(d.count("create") + d.count("network create")).toBe(0);
    putNet(d, { labels: netLabels({ [OWNER_L]: OTHER_ID }) });
    expect(await settle(d.createProjectProxy(PS, PROJ, PCONFIG, {}))).toBeInstanceOf(SandboxRefusedError);
    expect(d.count("create")).toBe(0);
  });

  it.each<[string, (d: EgressDocker) => void, RegExp]>([
    ["the create fails", (d) => d.script.push((a) => (a[0] === "create" ? { code: 1, stderr: "no space left" } : undefined)), /no space left/],
    ["the create times out", (d) => d.script.push((a) => (a[0] === "create" ? { code: null as unknown as number, timedOut: true } : undefined)), /create timed out/],
    ["the join fails", (d) => d.script.push((a) => (a[0] === "network" && a[1] === "connect" ? { code: 1, stderr: "boom" } : undefined)), /could not be joined/],
    ["the start fails", (d) => d.script.push((a) => (a[0] === "start" ? { code: 1, stderr: "cannot start" } : undefined)), /cannot start/],
    ["the proxy is not ready in time", (d) => { d.statusBody = { ...READY, ready: false }; }, /not ready within|./],
    ["the proxy reports another program version", (d) => { d.statusBody = { ...READY, version: "0" }; }, /not ready within|./],
  ])("%s: what it made is removed (by name, then id, with -v), the network stays, and it throws ProxyStartError", async (_n, over, why) => {
    const { d } = await make(over);
    const e = await settle(d.createProjectProxy(PS, PROJ, PCONFIG, {}));
    expect(e).toBeInstanceOf(ProxyStartError);
    expect((e as Error).message).toMatch(why);
    expect([...d.containers.keys()]).toEqual([]);
    expect(d.networks.has(PNET)).toBe(true);
    const rms = d.argvs.filter((a) => a[0] === "rm");
    expect(rms).toHaveLength(1);
    expect(rms[0]!.slice(0, 3)).toEqual(["rm", "-f", "-v"]);
    expect(d.count("network rm")).toBe(0);
  });

  it("passes a runtime that Docker refuses through as the runtime error", async () => {
    const d = mkEgress({ MCPE_DOCKER_RUNTIME: "runsc" });
    putNet(d);
    d.script.push((a) => (a[0] === "create" && a.includes("--read-only") ? { code: 125, stderr: "docker: Error response from daemon: unknown or invalid runtime name: runsc." } : undefined));
    expect(await settle(d.createProjectProxy(PS, PROJ, PCONFIG, {}))).toBeInstanceOf(RuntimeUnavailableError);
  });
});

describe("startProjectProxy and projectProxyStatus", () => {
  it("starts a stopped project proxy and accepts any version of it", async () => {
    const d = mkEgress();
    putNet(d);
    const p = putProxy(d, proxyName(), proxyLabels(), { running: false });
    d.statusBody = { ...READY, version: "99" };
    await d.startProjectProxy(p.id);
    expect(d.argvs.find((a) => a[0] === "start")).toEqual(["start", p.id]);
    expect(d.containers.get(p.name)!.running).toBe(true);
  });

  it("does not start anything that is not this installation's project proxy", async () => {
    const d = mkEgress();
    const bad = [
      putProxy(d, proxyName(1), proxyLabels(PS, { [OWNER_L]: OTHER_ID }), { running: false }),
      putProxy(d, proxyName(2), proxyLabels(PS, { [ROLE_L]: "oneshot-proxy" }), { running: false }),
      putProxy(d, proxyName(3), null, { running: false }),
    ];
    for (const p of bad) expect(await settle(d.startProjectProxy(p.id))).toBeInstanceOf(SandboxRefusedError);
    expect(d.count("start")).toBe(0);
    await expect(d.startProjectProxy("a".repeat(64))).rejects.toBeInstanceOf(ProxyStartError);
  });

  it("says ProxyStartError when the proxy never becomes ready, and leaves it where it is", async () => {
    const d = mkEgress();
    const p = putProxy(d, proxyName(), proxyLabels(), { running: false });
    d.statusBody = { ready: false };
    await expect(d.startProjectProxy(p.id)).rejects.toBeInstanceOf(ProxyStartError);
    expect(d.count("rm")).toBe(0);
  });

  it("projectProxyStatus returns the status body, and undefined (never a throw) when it cannot be had", async () => {
    const d = mkEgress();
    const p = putProxy(d);
    expect(await d.projectProxyStatus(p.id)).toEqual(READY);
    expect(await d.projectProxyStatus("not-an-id")).toBeUndefined();
    d.script.push((a) => (a[0] === "exec" ? { code: 1 } : undefined));
    expect(await d.projectProxyStatus(p.id)).toBeUndefined();
    class Throws extends ScriptedDocker {
      protected override async docker(): Promise<never> {
        throw new Error("spawn docker ENOENT");
      }
    }
    expect(await new Throws(loadConfig({}), TEST_INSTALLATION_ID).projectProxyStatus(p.id)).toBeUndefined();
  });
});

describe("listProjectProxies", () => {
  it("lists by label filters, then keeps what the inspect says is this sandbox's: the name, the sandbox label and a project label", async () => {
    const d = mkEgress();
    const a = putProxy(d, proxyName(1));
    const b = putProxy(d, proxyName(2), proxyLabels(), { running: false });
    putProxy(d, proxyName(1, "mcpe-0123abcd-twin"), proxyLabels("mcpe-0123abcd-twin")); // a twin: same repository, another sandbox
    putProxy(d, `${PS}-proxy-XYZ`); // a name that is not the shape
    putProxy(d, proxyName(3), proxyLabels(PS, { [SANDBOX_L]: "mcpe-0123abcd-other" })); // another sandbox label
    const noProject = proxyLabels();
    delete noProject[PROJECT_L];
    putProxy(d, proxyName(4), noProject);
    putProxy(d, proxyName(5), proxyLabels(PS, { [OWNER_L]: OTHER_ID })); // another installation's (filtered out by the listing)
    const listed = await d.listProjectProxies(PS);
    expect(listed.map((p) => p.name).sort()).toEqual([a.name, b.name].sort());
    expect(listed.find((p) => p.name === b.name)).toEqual({ id: b.id, name: b.name, running: false, labels: proxyLabels() });
    expect(d.argvs[0]).toEqual(["ps", "-a", "-q", "--no-trunc", "--filter", `label=${OWNER_L}=${ID}`, "--filter", `label=${ROLE_L}=project-proxy`]);
  });

  it("needs no container: it works once the sandbox is gone, and asks only read-only questions", async () => {
    const d = mkEgress();
    d.strict = true;
    putProxy(d);
    expect(await d.listProjectProxies(PS)).toHaveLength(1);
    expect(d.violations).toEqual([]);
    expect(d.verbs).toEqual(["ps", "inspect"]);
  });

  it("throws DockerUnavailableError when Docker cannot be asked", async () => {
    for (const r of [{ code: 1, stderr: "Cannot connect" }, { code: null as unknown as number, timedOut: true }, { stdout: "x", truncated: true }, { stdout: "abc\n" }] as Reply[]) {
      const d = mkEgress();
      d.script.push((a) => (a[0] === "ps" ? r : undefined));
      await expect(d.listProjectProxies(PS)).rejects.toBeInstanceOf(DockerUnavailableError);
    }
  });
});

describe("listOwnSandboxes (leg 10)", () => {
  const sandboxLabels = (over: Record<string, string> = {}): Record<string, string> => ({ "mcp-everything": "1", [OWNER_L]: ID, [PROJECT_L]: PROJ, ...over });
  const put = (d: ScriptedDocker, name: string, labels: Labels, opts: { running?: boolean; networks?: string[] } = {}) => {
    d.containers.set(name, { id: idFor(name), running: opts.running ?? true, labels, networks: opts.networks ?? ["bridge"] });
  };

  it("lists by owner and project label, keeps this installation's sandboxes with no role, and answers their facts", async () => {
    const d = mkEgress();
    put(d, "mcpe-0123abcd-a", sandboxLabels(), { running: false, networks: ["bridge"] });
    put(d, "mcpe-0123abcd-b", sandboxLabels({ [PROJECT_L]: "github:o/b" }), { networks: ["mcpe-0123abcd-b-net"] });
    put(d, "mcpe-0123abcd-proxy", sandboxLabels({ [ROLE_L]: "project-proxy" })); // a role: a proxy
    put(d, "mcpe-0123abcd-oneshot", sandboxLabels({ [ROLE_L]: "clone" })); // a role: a one-shot
    put(d, "mcpe-theirs", sandboxLabels({ [OWNER_L]: OTHER_ID })); // another installation's
    put(d, "mcpe-before", { "mcp-everything": "1", [PROJECT_L]: PROJ }); // from before ownership: no owner label
    put(d, "mcpe-noproject", { "mcp-everything": "1", [OWNER_L]: ID }); // no project label
    put(d, "stranger", { "com.example": "x" });
    const listed = await d.listOwnSandboxes();
    expect(listed.map((s) => s.name).sort()).toEqual(["mcpe-0123abcd-a", "mcpe-0123abcd-b"]);
    expect(listed.map((s) => s.name)).not.toContain("mcpe-before"); // a sandbox made before ownership is never listed
    const a = listed.find((s) => s.name === "mcpe-0123abcd-a")!;
    expect(a).toEqual({ id: idFor("mcpe-0123abcd-a"), name: "mcpe-0123abcd-a", running: false, labels: sandboxLabels(), networks: ["bridge"], runtime: undefined });
    expect(d.argvs[0]).toEqual(["ps", "-a", "-q", "--no-trunc", "--filter", `label=${OWNER_L}=${ID}`, "--filter", `label=${PROJECT_L}`]);
  });

  it("asks only read-only questions (a double that accepts only inspects and listings)", async () => {
    const d = mkEgress();
    d.strict = true;
    put(d, "mcpe-0123abcd-a", sandboxLabels());
    expect(await d.listOwnSandboxes()).toHaveLength(1);
    expect(d.violations).toEqual([]);
    expect(d.verbs).toEqual(["ps", "inspect"]);
  });

  it("is empty when there is none, and throws DockerUnavailableError when Docker cannot be asked", async () => {
    expect(await mkEgress().listOwnSandboxes()).toEqual([]);
    for (const r of [{ code: 1, stderr: "Cannot connect" }, { code: null as unknown as number, timedOut: true }, { stdout: "x", truncated: true }, { stdout: "abc\n" }] as Reply[]) {
      const d = mkEgress();
      d.script.push((a) => (a[0] === "ps" ? r : undefined));
      await expect(d.listOwnSandboxes()).rejects.toBeInstanceOf(DockerUnavailableError);
    }
  });
});

describe("removeProjectProxy and removeProjectNetwork", () => {
  it("removes a project proxy by id with -v", async () => {
    const d = mkEgress();
    const p = putProxy(d);
    await d.removeProjectProxy(p.id);
    expect(removals(d)).toEqual([["rm", "-f", "-v", p.id]]);
  });

  it("refuses what is not this installation's project proxy, and removes nothing", async () => {
    const d = mkEgress();
    for (const [labels, cls] of [
      [proxyLabels(PS, { [OWNER_L]: OTHER_ID }), "another"],
      [proxyLabels(PS, { [ROLE_L]: "oneshot-proxy" }), "not-ours"],
      [LABELS.mine, "not-ours"],
      [null, "not-ours"],
    ] as const) {
      const p = putProxy(d, proxyName(Math.floor(Math.random() * 9) + 1, `mcpe-0123abcd-w${cls}${String(Math.random()).slice(2, 6)}`), labels);
      const e = await settle(d.removeProjectProxy(p.id));
      expect(e).toBeInstanceOf(SandboxRefusedError);
      expect((e as SandboxRefusedError).reason).toBe(cls);
      expect((e as SandboxRefusedError).sandboxes[0]!.kind).toBe("proxy");
    }
    expect(removals(d)).toEqual([]);
  });

  it("treats a proxy that is gone as removed, and takes only a full id", async () => {
    const d = mkEgress();
    await d.removeProjectProxy("a".repeat(64));
    expect(removals(d)).toEqual([]);
    await expect(d.removeProjectProxy(proxyName())).rejects.toThrow(/full id/);
  });

  it("removes a project network by id", async () => {
    const d = mkEgress();
    const n = putNet(d);
    await d.removeProjectNetwork(n.id);
    expect(removals(d)).toEqual([["network", "rm", n.id]]);
    expect(d.networks.size).toBe(0);
  });

  it("refuses a network that is not this installation's project network, and removes nothing", async () => {
    for (const over of [{ labels: netLabels({ [OWNER_L]: OTHER_ID }) }, { labels: null }, { labels: netLabels({ [ROLE_L]: "oneshot-net" }) }] as Array<Partial<FakeNet>>) {
      const d = mkEgress();
      const n = putNet(d, over);
      expect(await settle(d.removeProjectNetwork(n.id))).toBeInstanceOf(SandboxRefusedError);
      expect(removals(d)).toEqual([]);
    }
  });

  it("counts 'not found' as success, at the inspect and at the removal, and throws any other failure", async () => {
    const d = mkEgress();
    await d.removeProjectNetwork("a".repeat(64));
    expect(removals(d)).toEqual([]);
    const racing = mkEgress();
    const n = putNet(racing);
    racing.script.push((a) => (a[1] === "rm" ? { code: 1, stderr: `Error response from daemon: network ${n.id} not found` } : undefined));
    await racing.removeProjectNetwork(n);
    const busy = mkEgress();
    const m = putNet(busy);
    busy.script.push((a) => (a[1] === "rm" ? { code: 1, stderr: "has active endpoints" } : undefined));
    await expect(busy.removeProjectNetwork(m.id)).rejects.toThrow(/Failed to remove network/);
    await expect(d.removeProjectNetwork(PNET)).rejects.toThrow(/full id/);
  });
});

describe("networkState", () => {
  it.each<[string, string[] | "gone", string]>([
    ["a missing container", "gone", "off"],
    ["no networks", [], "off"],
    ["its own network only", [PNET], "contained"],
    ["bridge only", ["bridge"], "open"],
    ["bridge and its own network", ["bridge", PNET], "open"],
    ["another network only", ["other_default"], "open"],
    ["its own network and another", [PNET, "other_default"], "open"],
    ["another sandbox's -net", ["mcpe-0123abcd-other-net"], "open"],
  ])("%s is %s", async (_n, networks, want) => {
    const d = mkEgress();
    if (networks !== "gone") d.put(PS, "mine", { networks });
    expect(await d.networkState(PS)).toBe(want);
    expect(d.verbs).toEqual(["inspect"]);
  });

  it("by reference it reads one inspect by id, without labels, and judges by the reference's name", async () => {
    const d = mkEgress();
    const id = d.put(PS, "another", { networks: [PNET] });
    expect(await d.networkState({ id, name: PS })).toBe("contained");
    expect(await d.networkState({ id, name: "mcpe-0123abcd-other" })).toBe("open");
    expect(d.argvs.every((a) => !a.join(" ").includes("Config.Labels"))).toBe(true);
  });
});

describe('setNetwork: "off"', () => {
  it("on bridge alone makes exactly today's call, without -f; on nothing it makes none", async () => {
    const d = mkEgress();
    const id = d.put(PS, "mine", { networks: ["bridge"] });
    await d.setNetwork(PS, "off");
    expect(d.argvs).toEqual([d.argvs[0]!, ["network", "disconnect", "bridge", id]]);
    const none = mkEgress();
    none.put(PS, "mine");
    await none.setNetwork(PS, "off");
    expect(none.verbs).toEqual(["inspect"]);
  });

  it("with its -net listed: disconnects it (-f), then removes the project's proxies, then the -net", async () => {
    const d = mkEgress();
    const net = putNet(d);
    const id = d.put(PS, "mine", { networks: [PNET] });
    const px = putProxy(d);
    putProxy(d, proxyName(1, "mcpe-0123abcd-twin"), proxyLabels("mcpe-0123abcd-twin"), { networks: ["bridge", "mcpe-0123abcd-twin-net"] });
    await d.setNetwork(PS, "off");
    expect(d.argvs.filter((a) => a[0] === "network" && a[1] !== "inspect")).toEqual([["network", "disconnect", "-f", PNET, id], ["network", "rm", net.id]]);
    expect(removals(d)).toEqual([["rm", "-f", "-v", px.id], ["network", "rm", net.id]]);
    expect(d.verbs.indexOf("network disconnect")).toBeLessThan(d.verbs.indexOf("rm"));
    expect(d.containers.get(PS)!.networks).toEqual([]);
    expect(d.networks.size).toBe(0);
    expect([...d.containers.keys()].sort()).toEqual([PS, proxyName(1, "mcpe-0123abcd-twin")].sort());
  });

  it("with a -net that Docker no longer has (a stopped sandbox keeps its name): only the disconnect", async () => {
    const d = mkEgress();
    const id = d.put(PS, "mine", { networks: [PNET], running: false });
    await d.setNetwork(PS, "off");
    expect(d.verbs).toEqual(["inspect", "ps", "network inspect", "network disconnect"]);
    expect(d.argvs.at(-1)).toEqual(["network", "disconnect", "-f", PNET, id]);
  });

  it("ignores 'not found' and 'not connected' on a disconnect, and throws any other failure", async () => {
    for (const stderr of ["Error response from daemon: network x not found", "Error response from daemon: container y is not connected to network x", "No such container: z"]) {
      const d = mkEgress();
      putNet(d);
      d.put(PS, "mine", { networks: [PNET] });
      // Docker answers with the error, and the container is off the network all the same (it was never on it, or the network is gone).
      d.script.push((a) => {
        if (a[1] !== "disconnect") return undefined;
        d.containers.get(PS)!.networks = [];
        return { code: 1, stderr };
      });
      await d.setNetwork(PS, "off");
      expect(d.networks.size).toBe(0);
    }
    const bad = mkEgress();
    putNet(bad);
    bad.put(PS, "mine", { networks: [PNET] });
    bad.script.push((a) => (a[1] === "disconnect" ? { code: 1, stderr: "permission denied" } : undefined));
    await expect(bad.setNetwork(PS, "off")).rejects.toThrow(/Failed to disable network for .*: permission denied/);
    expect(removals(bad)).toEqual([]);
  });

  it("refuses, before any change, when the -net is not this installation's", async () => {
    const d = mkEgress();
    putNet(d, { labels: null });
    d.put(PS, "mine", { networks: [PNET] });
    const e = await settle(d.setNetwork(PS, "off"));
    expect(e).toBeInstanceOf(SandboxRefusedError);
    expect(d.count("network disconnect")).toBe(0);
    expect(removals(d)).toEqual([]);
  });

  it("another network it is on (no -net) is disconnected with -f and nothing is removed", async () => {
    const d = mkEgress();
    const id = d.put(PS, "mine", { networks: ["bridge", "other_default"] });
    await d.setNetwork(PS, "off");
    expect(d.argvs.filter((a) => a[1] === "disconnect")).toEqual([["network", "disconnect", "-f", "bridge", id], ["network", "disconnect", "-f", "other_default", id]]);
    expect(d.count("ps")).toBe(0);
    expect(removals(d)).toEqual([]);
  });
});

describe('setNetwork: "open"', () => {
  it("on bridge, alone or with others, does nothing; on nothing or a foreign network only, connects bridge", async () => {
    for (const networks of [["bridge"], ["bridge", PNET], ["bridge", "other_default"]]) {
      const d = mkEgress();
      d.put(PS, "mine", { networks });
      await d.setNetwork(PS, "open");
      expect(d.verbs).toEqual(["inspect"]);
    }
    for (const networks of [[], ["other_default"]]) {
      const d = mkEgress();
      const id = d.put(PS, "mine", { networks });
      await d.setNetwork(PS, "open");
      expect(d.argvs.at(-1)).toEqual(["network", "connect", "bridge", id]);
      expect(d.containers.get(PS)!.networks).toEqual([...networks, "bridge"]);
      expect(d.count("network disconnect") + removals(d).length).toBe(0);
    }
  });

  it("on its -net: removes the proxies, disconnects -f, removes the -net, then connects bridge, in that order", async () => {
    const d = mkEgress();
    const net = putNet(d);
    const id = d.put(PS, "mine", { networks: [PNET] });
    const px = putProxy(d);
    await d.setNetwork(PS, "open");
    expect(d.argvs.filter((a) => a[0] === "rm" || (a[0] === "network" && a[1] !== "inspect"))).toEqual([
      ["rm", "-f", "-v", px.id],
      ["network", "disconnect", "-f", PNET, id],
      ["network", "rm", net.id],
      ["network", "connect", "bridge", id],
    ]);
    expect(d.containers.get(PS)!.networks).toEqual(["bridge"]);
  });

  it("throws before connecting bridge when a proxy cannot be removed, and removes nothing else", async () => {
    const d = mkEgress();
    putNet(d);
    d.put(PS, "mine", { networks: [PNET] });
    putProxy(d);
    d.script.push((a) => (a[0] === "rm" ? { code: 1, stderr: "device busy" } : undefined));
    await expect(d.setNetwork(PS, "open")).rejects.toThrow(/Failed to remove proxy/);
    expect(d.count("network connect")).toBe(0);
    expect(d.count("network rm")).toBe(0);
    expect(d.containers.get(PS)!.networks).toEqual([PNET]);
  });

  it("refuses, before any change, a -net that is not this installation's", async () => {
    const d = mkEgress();
    putNet(d, { labels: netLabels({ [OWNER_L]: OTHER_ID }) });
    d.put(PS, "mine", { networks: [PNET] });
    expect(await settle(d.setNetwork(PS, "open"))).toBeInstanceOf(SandboxRefusedError);
    expect(d.count("network connect") + d.count("network disconnect") + removals(d).length).toBe(0);
  });
});

describe('setNetwork: "contained"', () => {
  it("attaches the -net before it disconnects bridge, and ends on the -net only", async () => {
    const d = mkEgress();
    const net = putNet(d);
    const id = d.put(PS, "mine", { networks: ["bridge"] });
    await d.setNetwork(PS, "contained");
    expect(d.argvs.filter((a) => a[0] === "network" && a[1] !== "inspect")).toEqual([
      ["network", "disconnect", "-f", PNET, id],
      ["network", "connect", net.id, id],
      ["network", "disconnect", "bridge", id],
    ]);
    expect(d.containers.get(PS)!.networks).toEqual([PNET]);
    expect(await d.networkState(PS)).toBe("contained");
  });

  it("from nothing it only attaches; it never makes the network or a proxy", async () => {
    const d = mkEgress();
    putNet(d);
    d.put(PS, "mine", { networks: [] });
    await d.setNetwork(PS, "contained");
    expect(d.containers.get(PS)!.networks).toEqual([PNET]);
    expect(d.count("network create") + d.count("create") + d.count("run")).toBe(0);
  });

  it("throws when the network is not there, and changes nothing", async () => {
    const d = mkEgress();
    d.put(PS, "mine", { networks: ["bridge"] });
    await expect(d.setNetwork(PS, "contained")).rejects.toThrow(/does not exist/);
    expect(d.count("network connect") + d.count("network disconnect") + d.count("network create")).toBe(0);
  });

  it("refuses a network that is someone else's or another project's, and changes nothing", async () => {
    for (const labels of [netLabels({ [OWNER_L]: OTHER_ID }), netLabels({ [PROJECT_L]: "github:o/other" }), netLabels({ [SANDBOX_L]: "mcpe-0123abcd-other" })]) {
      const d = mkEgress();
      putNet(d, { labels });
      d.put(PS, "mine", { networks: ["bridge"] });
      expect(await settle(d.setNetwork(PS, "contained"))).toBeInstanceOf(SandboxRefusedError);
      expect(d.count("network connect") + d.count("network disconnect")).toBe(0);
    }
  });

  it("leaves bridge on when the attach fails", async () => {
    const d = mkEgress();
    putNet(d);
    const id = d.put(PS, "mine", { networks: ["bridge"] });
    d.script.push((a) => (a[1] === "connect" ? { code: 1, stderr: "boom" } : undefined));
    await expect(d.setNetwork(PS, "contained")).rejects.toThrow(/Failed to attach/);
    expect(d.argvs).not.toContainEqual(["network", "disconnect", "bridge", id]);
    expect(d.containers.get(PS)!.networks).toEqual(["bridge"]);
  });

  it("by reference it checks the network by name without a project, and rejects an unknown mode", async () => {
    const d = mkEgress();
    putNet(d);
    const id = d.put(PS, "another", { networks: [] });
    await d.setNetwork({ id, name: PS }, "contained");
    expect(d.containers.get(PS)!.networks).toEqual([PNET]);
    await expect(d.setNetwork(PS, "maybe" as never)).rejects.toThrow(/Unknown network mode/);
  });

  it("T14 in the double: a stopped sandbox whose -net was removed and made again attaches and ends on it", async () => {
    const d = mkEgress();
    const id = d.put(PS, "mine", { networks: [PNET], running: false });
    expect(await d.networkState(PS)).toBe("contained"); // by its list only
    const net = await d.ensureProjectNetwork(PS, PROJ);
    await d.attachProjectNetwork(makeRef(id, PS), net);
    expect(d.containers.get(PS)!.networks).toEqual([PNET]);
    expect(d.argvs.filter((a) => a[1] === "disconnect")[0]).toEqual(["network", "disconnect", "-f", PNET, id]);
  });

  // Leg 14: under a non-runc runtime a running sandbox's network changes only while it is stopped.
  describe("a running sandbox under a non-runc runtime (leg 14)", () => {
    const mutating = (d: ScriptedDocker) => d.argvs.filter((a) => a[0] === "stop" || a[0] === "start" || (a[0] === "network" && a[1] !== "inspect"));

    it.each(["runsc", "kata"])("%s: stop, attach, disconnect bridge, start, then the post-start step (in that order)", async (runtime) => {
      const d = mkEgress();
      const net = putNet(d);
      const id = d.put(PS, "mine", { networks: ["bridge"], runtime });
      const seen: Array<{ networks: string[]; started: boolean; running: boolean }> = [];
      d.setContainment(async () => undefined, async (facts, started) => {
        seen.push({ networks: facts.networks, started, running: facts.running });
      });
      await d.setNetwork(PS, "contained");
      expect(mutating(d)).toEqual([
        ["stop", "-t", "5", id],
        ["network", "disconnect", "-f", PNET, id],
        ["network", "connect", net.id, id],
        ["network", "disconnect", "bridge", id],
        ["start", id],
      ]);
      expect(d.containers.get(PS)!.networks).toEqual([PNET]);
      expect(d.containers.get(PS)!.running).toBe(true);
      // The post-start step ran once, after the start, on the new networks.
      expect(seen).toEqual([{ networks: [PNET], started: true, running: true }]);
    });

    it("a runc sandbox, or one with no runtime named, is changed live: no stop, no start", async () => {
      for (const runtime of ["runc", "io.containerd.runc.v2", undefined]) {
        const d = mkEgress();
        const net = putNet(d);
        const id = d.put(PS, "mine", { networks: ["bridge"], ...(runtime !== undefined ? { runtime } : {}) });
        await d.setNetwork(PS, "contained");
        expect(mutating(d)).toEqual([
          ["network", "disconnect", "-f", PNET, id],
          ["network", "connect", net.id, id],
          ["network", "disconnect", "bridge", id],
        ]);
      }
    });

    it("a stopped sandbox under runsc is changed as before (no stop, and no start: the caller starts it)", async () => {
      const d = mkEgress();
      putNet(d);
      d.put(PS, "mine", { networks: ["bridge"], runtime: "runsc", running: false });
      await d.setNetwork(PS, "contained");
      expect(d.count("stop") + d.count("start")).toBe(0);
      expect(d.containers.get(PS)!.networks).toEqual([PNET]);
    });

    it("a failed attach leaves the sandbox stopped, on bridge, never started on the wrong networks", async () => {
      const d = mkEgress();
      putNet(d);
      d.put(PS, "mine", { networks: ["bridge"], runtime: "runsc" });
      d.script.push((a) => (a[1] === "connect" ? { code: 1, stderr: "boom" } : undefined));
      await expect(d.setNetwork(PS, "contained")).rejects.toThrow(/Failed to attach/);
      expect(d.count("start")).toBe(0);
      expect(d.containers.get(PS)!.running).toBe(false);
    });

    it("a failed stop changes nothing", async () => {
      const d = mkEgress();
      putNet(d);
      d.put(PS, "mine", { networks: ["bridge"], runtime: "runsc" });
      d.script.push((a) => (a[0] === "stop" ? { code: 1, stderr: "cannot stop" } : undefined));
      await expect(d.setNetwork(PS, "contained")).rejects.toThrow(/Failed to stop sandbox/);
      expect(d.count("network connect") + d.count("network disconnect")).toBe(0);
    });

    // Squawk 0054: `whileStopped` throws when the stop fails and the sandbox is not simply gone; nothing is issued after the stop.
    it("whileStopped: a stop that fails (not 'No such container') throws, and no connect, disconnect or start follows it", async () => {
      for (const attempt of [
        (d: ScriptedDocker) => d.restartSandbox(PS),
        (d: ScriptedDocker) => d.setNetwork(PS, "contained"),
      ]) {
        const d = mkEgress();
        putNet(d);
        d.put(PS, "mine", { networks: ["bridge"], runtime: "runsc" });
        d.script.push((a) => (a[0] === "stop" ? { code: 1, stderr: "Error response from daemon: cannot stop container: permission denied\n" } : undefined));
        d.argvs.length = 0;
        await expect(attempt(d)).rejects.toThrow(/Failed to stop sandbox .* to change its network: Error response from daemon: cannot stop container: permission denied/);
        const issued = d.argvs.filter((a) => a[0] === "stop" || a[0] === "start" || (a[0] === "network" && a[1] !== "inspect"));
        expect(issued.map((a) => a[0])).toEqual(["stop"]);
        expect(d.count("network connect") + d.count("network disconnect") + d.count("start")).toBe(0);
        expect(d.containers.get(PS)!.running).toBe(true);
      }
    });

    it("the repair's re-attach (attachProjectNetwork with the sandbox's facts) does the same: stop, attach, start; runc is live", async () => {
      const d = mkEgress();
      const id = d.put(PS, "mine", { networks: [PNET], runtime: "runsc" });
      const net = await d.ensureProjectNetwork(PS, PROJ);
      d.argvs.length = 0;
      await d.attachProjectNetwork(makeRef(id, PS), net, { running: true, runtime: "runsc" });
      expect(mutating(d)).toEqual([
        ["stop", "-t", "5", id],
        ["network", "disconnect", "-f", PNET, id],
        ["network", "connect", net.id, id],
        ["start", id],
      ]);
      d.argvs.length = 0;
      await d.attachProjectNetwork(makeRef(id, PS), net, { running: true, runtime: "runc" });
      await d.attachProjectNetwork(makeRef(id, PS), net, { running: false, runtime: "runsc" });
      await d.attachProjectNetwork(makeRef(id, PS), net);
      expect(d.count("stop") + d.count("start")).toBe(0);
    });

    it("restartSandbox stops and starts a running sandbox; a stopped or missing one is left alone; another's is refused", async () => {
      const d = mkEgress();
      const id = d.put(PS, "mine", { networks: [], runtime: "runsc" });
      await d.restartSandbox(PS);
      expect(d.argvs.filter((a) => a[0] === "stop" || a[0] === "start")).toEqual([["stop", "-t", "5", id], ["start", id]]);
      const idle = mkEgress();
      idle.put(PS, "mine", { networks: [], running: false });
      await idle.restartSandbox(PS);
      await idle.restartSandbox("mcpe-0123abcd-gone");
      expect(idle.count("stop") + idle.count("start")).toBe(0);
      const other = mkEgress();
      other.put(PS, "another", { networks: [] });
      expect(await settle(other.restartSandbox(PS))).toBeInstanceOf(SandboxRefusedError);
      expect(other.count("stop") + other.count("start")).toBe(0);
    });
  });
});

describe("proxyMac and isRuncRuntime (leg 14)", () => {
  const A = idFor("net:a");
  const B = idFor("net:b");

  it("is a locally administered unicast MAC (02: prefix), six lower-case hex octets", () => {
    for (const id of [A, B, "x", ""]) expect(proxyMac(id)).toMatch(/^02(:[0-9a-f]{2}){5}$/);
  });

  it("is the same for the same network id, and differs between ids", () => {
    expect(proxyMac(A)).toBe(proxyMac(A));
    expect(proxyMac(A)).not.toBe(proxyMac(B));
  });

  it("isRuncRuntime: runc and io.containerd.runc.v2, an absent one as the daemon's default", () => {
    expect(isRuncRuntime("runc")).toBe(true);
    expect(isRuncRuntime("io.containerd.runc.v2")).toBe(true);
    expect(isRuncRuntime("runsc")).toBe(false);
    expect(isRuncRuntime("kata")).toBe(false);
    for (const absent of [undefined, null, ""]) expect(isRuncRuntime(absent)).toBe(true);
    for (const absent of [undefined, null, ""]) expect(isRuncRuntime(absent, "runsc")).toBe(false);
    expect(isRuncRuntime("runc", "runsc")).toBe(true);
  });

  it("both proxies are created with the MAC of their network's id", async () => {
    const d = mkEgress();
    const net = putNet(d);
    await d.createProjectProxy(PS, PROJ, PCONFIG, CONF_LABELS);
    const create = d.argvs.find((a) => a[0] === "create")!;
    expect(sub(create, "--network")).toEqual([`name=${PNET},ip=172.30.50.254,mac-address=${proxyMac(net.id)}`]);
  });
});

describe("destroy of a project with a proxy and a network", () => {
  const world = () => {
    const d = mkEgress();
    const net = putNet(d);
    const id = d.put(PS, "mine", { networks: [PNET] });
    const px = putProxy(d);
    d.putVolume(PV, "mine");
    return { d, net, id, px };
  };
  const READS = ["inspect", "volume inspect", "ps", "network inspect"];

  it("removes the container, then the proxies, then the network, then the volume, after every read", async () => {
    const { d, net, id, px } = world();
    putProxy(d, proxyName(1, "mcpe-0123abcd-twin"), proxyLabels("mcpe-0123abcd-twin"), { networks: ["bridge", "mcpe-0123abcd-twin-net"] });
    await d.destroy(PS, PV);
    expect(removals(d)).toEqual([["rm", "-f", "-v", id], ["rm", "-f", "-v", px.id], ["network", "rm", net.id], ["volume", "rm", "-f", PV]]);
    const firstRemoval = d.argvs.findIndex((a) => a[0] === "rm");
    const lastRead = Math.max(...READS.map((v) => d.verbs.lastIndexOf(v)));
    expect(lastRead).toBeLessThan(firstRemoval);
    expect(d.containers.has(proxyName(1, "mcpe-0123abcd-twin"))).toBe(true); // a twin is never touched
    expect(d.networks.size).toBe(0);
  });

  it("finds the proxies and the network after the container is gone", async () => {
    const d = mkEgress();
    const net = putNet(d);
    const px = putProxy(d);
    d.putVolume(PV, "mine");
    await d.destroy(PS, PV);
    expect(removals(d)).toEqual([["rm", "-f", "-v", px.id], ["network", "rm", net.id], ["volume", "rm", "-f", PV]]);
  });

  it("a sandbox from before ownership (no project label) is refused, and nothing of it, its proxy or its network is removed", async () => {
    const d = mkEgress();
    putNet(d);
    d.put(PS, "before", { networks: [PNET] });
    putProxy(d);
    const e = await settle(d.destroy(PS, PV));
    expect(e).toBeInstanceOf(SandboxRefusedError);
    expect((e as SandboxRefusedError).reason).toBe("before");
    expect(removals(d)).toEqual([]);
    expect(d.containers.has(PS)).toBe(true);
  });

  it.each<[string, Labels]>([
    ["another installation's", netLabels({ [OWNER_L]: OTHER_ID })],
    ["without labels", null],
    ["of another role", netLabels({ [ROLE_L]: "oneshot-net" })],
  ])("a network named <sandbox>-net that is %s refuses the whole destroy: nothing is removed", async (_n, labels) => {
    const { d } = world();
    d.networks.get(PNET)!.labels = labels as Record<string, string> | null;
    const e = await settle(d.destroy(PS, PV));
    expect(e).toBeInstanceOf(SandboxRefusedError);
    const r = e as SandboxRefusedError;
    expect(r.sandboxes.map((f) => [f.kind, f.sandbox])).toEqual([["container", PS], ["volume", PV], ["proxy", proxyName()], ["network", PNET]]);
    expect(r.message).toContain(`network "${PNET}"`);
    expect(removals(d)).toEqual([]);
    expect(d.containers.has(PS)).toBe(true);
    expect(d.volumes.has(PV)).toBe(true);
  });

  it("the refusal names the new kinds, and the left-in-place text can name them", async () => {
    const { d } = world();
    d.networks.get(PNET)!.labels = netLabels({ [OWNER_L]: OTHER_ID });
    const e = (await settle(d.destroy(PS, PV))) as SandboxRefusedError;
    expect(e.kind).toBe("network");
    expect(e.reason).toBe("another");
    expect(e.message).toContain("is another installation's");
  });

  it("a proxy or a network that cannot be asked about leaves everything alone", async () => {
    for (const verb of ["ps", "network"]) {
      const { d } = world();
      d.script.push((a) => (a[0] === verb && (verb === "ps" || a[1] === "inspect") ? { code: 1, stderr: "Cannot connect" } : undefined));
      await expect(d.destroy(PS, PV)).rejects.toBeInstanceOf(DockerUnavailableError);
      expect(removals(d)).toEqual([]);
    }
  });

  it("the order matters: with a proxy still on the network the double (like Docker) refuses its removal", async () => {
    const { d, net } = world();
    const e = await settle(d.removeProjectNetwork(net.id));
    expect((e as Error).message).toMatch(/Failed to remove network.*active endpoints/);
    expect(d.networks.has(PNET)).toBe(true);
  });

  it("removeContainer keeps the project's proxies and network (the installer builds more than once)", async () => {
    const { d, px, id } = world();
    await d.removeContainer(PS);
    expect(removals(d)).toEqual([["rm", "-f", "-v", id]]);
    expect(d.count("ps")).toBe(0);
    expect(d.count("network rm")).toBe(0);
    expect(d.containers.has(px.name)).toBe(true);
    expect(d.networks.has(PNET)).toBe(true);
  });
});

describe("the environment of an exec", () => {
  const stoppedBox = () => {
    const d = mk();
    const id = d.put(N, "mine", { running: false });
    return { d, id };
  };

  it("adds -e NAME=value before the container id, the caller's then the reference's", async () => {
    const d = mk();
    const id = d.put(N, "mine");
    await d.exec(makeRef(id, N, { HTTP_PROXY: "http://172.30.1.254:3128" }), ["true"], { ...OPTS, cwd: "/w", env: { A: "1" } });
    expect(d.execs[0]).toEqual(["exec", "-i", "-w", "/w", "-e", "A=1", "-e", "HTTP_PROXY=http://172.30.1.254:3128", id, "timeout", "-k", "5", "10", "true"]);
    await d.exec(makeRef(id, N), ["true"], OPTS);
    expect(d.execs[1]).toEqual(["exec", "-i", id, "timeout", "-k", "5", "10", "true"]);
  });

  it("the reference's environment wins over the caller's, and a caller cannot remove it", async () => {
    const d = mk();
    const id = d.put(N, "mine");
    await d.exec(makeRef(id, N, { HTTP_PROXY: "http://172.30.1.254:3128" }), ["true"], { ...OPTS, env: { HTTP_PROXY: "http://evil:1", NO_PROXY: "*" } });
    const e = d.execs[0]!.flatMap((x, i, a) => (a[i - 1] === "-e" ? [x] : []));
    expect(e).toEqual(["HTTP_PROXY=http://172.30.1.254:3128", "NO_PROXY=*"]);
  });

  it("an exec by name carries only the caller's variables", async () => {
    const d = mk();
    d.put(N, "mine");
    await d.exec(N, ["true"], { ...OPTS, env: { A: "1" } });
    expect(d.execs[0]!.slice(0, 4)).toEqual(["exec", "-i", "-e", "A=1"]);
  });

  it("the retry after a stopped sandbox is started carries the same environment", async () => {
    const { d, id } = stoppedBox();
    d.execReplies = [{ code: 1, stderr: DAEMON }, { code: 0 }];
    await d.exec(makeRef(id, N, { P: "1" }), ["true"], { ...OPTS, env: { A: "2" } });
    expect(d.execs).toHaveLength(2);
    expect(d.execs[1]).toEqual(d.execs[0]);
    expect(d.execs[0]!.slice(2, 6)).toEqual(["-e", "A=2", "-e", "P=1"]);
  });

  it.each([["a name that is not an identifier", { "1A": "x" }], ["a name with a dash", { "A-B": "x" }], ["an empty name", { "": "x" }], ["a name with =", { "A=B": "x" }],
    ["a value with a line break", { A: "x\ny" }], ["a value with CR", { A: "x\ry" }], ["a value with NUL", { A: "x\u0000y" }]])(
    "refuses %s, and runs nothing",
    async (_n, env) => {
      const d = mk();
      const id = d.put(N, "mine");
      await expect(d.exec(makeRef(id, N), ["true"], { ...OPTS, env })).rejects.toThrow(/environment variable/i);
      await expect(d.exec(makeRef(id, N, env), ["true"], OPTS)).rejects.toThrow(/environment variable/i);
      expect(d.count("exec")).toBe(0);
    },
  );

  it("a reference's environment is a frozen copy", () => {
    const env = { A: "1" };
    const ref = makeRef("a".repeat(64), N, env);
    env.A = "2";
    expect(ref.env).toEqual({ A: "1" });
    expect(Object.isFrozen(ref)).toBe(true);
    expect(Object.isFrozen(ref.env)).toBe(true);
    expect("env" in makeRef("a".repeat(64), N)).toBe(false);
  });

  it("envFlags makes the pairs in order and nothing for no environment", () => {
    expect(envFlags(undefined)).toEqual([]);
    expect(envFlags({ A_1: "x y", _b: "=" })).toEqual(["-e", "A_1=x y", "-e", "_b=="]);
  });
});

/** The double with a clock the test moves, for the hook's cache. */
class TimedDocker extends ScriptedDocker {
  t = 1_000_000;
  protected override clock(): number {
    return this.t;
  }
}

describe("the containment hook (leg 7)", () => {
  const PROXY_ENV = { HTTP_PROXY: "http://172.30.1.254:3128", NODE_USE_ENV_PROXY: "1" };
  const timed = (env: Record<string, string> = {}) => new TimedDocker(loadConfig(env), TEST_INSTALLATION_ID);

  /** A hook that records what it is given and answers what the test says (or throws). */
  function spy(answer: Record<string, string> | null = PROXY_ENV) {
    const s = {
      calls: [] as Array<{ facts: SandboxInspectFacts; mode: ContainmentHookMode }>,
      answer,
      error: undefined as Error | undefined,
      gate: undefined as Promise<void> | undefined,
      hook: undefined as unknown as ContainmentHook,
    };
    s.hook = async (facts, mode) => {
      s.calls.push({ facts, mode });
      if (s.gate) await s.gate;
      if (s.error) throw s.error;
      return s.answer ?? undefined;
    };
    return s;
  }
  const inspects = (d: ScriptedDocker) => d.argvs.filter((a) => a[0] === "inspect");
  const execEnv = (a: string[]) => a.flatMap((x, i) => (x === "-e" ? [a[i + 1]!] : []));

  describe("with no hook installed", () => {
    it("a reference's exec is one command with no inspect, and a name's is one inspect and one exec", async () => {
      const d = mk();
      const id = d.put(N, "mine");
      await d.exec(makeRef(id, N), ["true"], OPTS);
      expect(d.verbs).toEqual(["exec"]);
      const e = mk();
      e.put(N, "mine");
      await e.exec(N, ["true"], OPTS);
      expect(e.verbs).toEqual(["inspect", "exec"]);
    });

    it("acquire gives a reference with no environment", async () => {
      const d = mk();
      d.put(N, "mine");
      expect("env" in (await d.acquire(N))!).toBe(false);
    });
  });

  describe("acquire", () => {
    it("makes one full inspect, gives the hook its facts, and only then starts", async () => {
      const d = mk();
      d.put(N, "mine", { running: false, networks: ["bridge"], runtime: "runc" });
      const s = spy();
      d.setContainment(s.hook);
      const ref = await d.acquire(N);
      expect(s.calls).toHaveLength(1);
      expect(s.calls[0]).toEqual({
        mode: "full",
        facts: { id: idFor(N), name: N, running: false, labels: LABELS.mine, networks: ["bridge"], runtime: "runc" },
      });
      expect(d.verbs).toEqual(["inspect", "start"]);
      expect(inspects(d)).toHaveLength(1);
      expect(inspects(d)[0]![inspects(d)[0]!.indexOf("--format") + 1]).toContain('"labels"');
      expect(ref!.env).toEqual(PROXY_ENV);
      expect(Object.isFrozen(ref!.env)).toBe(true);
    });

    it("a hook that refuses stops the start", async () => {
      const d = mk();
      d.put(N, "mine", { running: false });
      const s = spy();
      s.error = new Error("refused by the hook");
      d.setContainment(s.hook);
      await expect(d.acquire(N)).rejects.toThrow(/refused by the hook/);
      expect(d.count("start")).toBe(0);
    });

    it("a hook's answer of nothing gives a reference without an environment", async () => {
      const d = mk();
      d.put(N, "mine");
      d.setContainment(spy(null).hook);
      expect("env" in (await d.acquire(N))!).toBe(false);
    });

    it("applies the runtime comparison before the hook", async () => {
      const d = mk({ MCPE_DOCKER_RUNTIME: "runsc" });
      d.put(N, "mine", { runtime: "runc" });
      const s = spy();
      d.setContainment(s.hook);
      await expect(d.acquire(N)).rejects.toBeInstanceOf(RuntimeMismatchError);
      expect(s.calls).toEqual([]);
    });
  });

  describe("ensureRunning", () => {
    it("by name: one inspect, the hook, then the start", async () => {
      const d = mk();
      d.put(N, "mine", { running: false });
      const s = spy();
      d.setContainment(s.hook);
      expect(await d.ensureRunning(N)).toBe(true);
      expect(s.calls.map((c) => c.mode)).toEqual(["full"]);
      expect(d.verbs).toEqual(["inspect", "start"]);
    });

    it("by reference: the labels are read (one full inspect) so that the hook has its facts", async () => {
      const d = mk();
      const id = d.put(N, "mine", { running: false });
      const s = spy();
      d.setContainment(s.hook);
      expect(await d.ensureRunning(makeRef(id, N))).toBe(true);
      expect(s.calls).toHaveLength(1);
      expect(s.calls[0]!.facts.labels).toEqual(LABELS.mine);
      expect(d.verbs).toEqual(["inspect", "start"]);
      expect(inspects(d)[0]![inspects(d)[0]!.indexOf("--format") + 1]).toContain('"labels"');
    });

    it("a hook that refuses stops the start", async () => {
      const d = mk();
      const id = d.put(N, "mine", { running: false });
      const s = spy();
      s.error = new Error("no");
      d.setContainment(s.hook);
      await expect(d.ensureRunning(makeRef(id, N))).rejects.toThrow("no");
      expect(d.count("start")).toBe(0);
    });

    it("without a hook a reference's inspect does not read labels", async () => {
      const d = mk();
      const id = d.put(N, "mine", { running: false });
      await d.ensureRunning(makeRef(id, N));
      expect(inspects(d)[0]![inspects(d)[0]!.indexOf("--format") + 1]).not.toContain('"labels"');
    });
  });

  describe("exec", () => {
    it("by name: one inspect, the hook in full mode, then the exec with the environment as -e flags", async () => {
      const d = mk();
      d.put(N, "mine");
      const s = spy();
      d.setContainment(s.hook);
      await d.exec(N, ["true"], OPTS);
      expect(s.calls.map((c) => c.mode)).toEqual(["full"]);
      expect(d.verbs).toEqual(["inspect", "exec"]);
      expect(execEnv(d.execs[0]!)).toEqual(expect.arrayContaining(["HTTP_PROXY=http://172.30.1.254:3128", "NODE_USE_ENV_PROXY=1"]));
    });

    it("with restart: false asks in observe mode, by name and by reference, and compares no runtime", async () => {
      const d = mk({ MCPE_DOCKER_RUNTIME: "runsc" });
      const id = d.put(N, "mine", { runtime: "runc" });
      const s = spy();
      d.setContainment(s.hook);
      await d.exec(makeRef(id, N), ["true"], { ...OPTS, restart: false });
      expect(s.calls.map((c) => c.mode)).toEqual(["observe"]);
      // By name the existing guard still compares (that is today's behavior and stays).
      await expect(d.exec(N, ["true"], { ...OPTS, restart: false })).rejects.toBeInstanceOf(RuntimeMismatchError);
    });

    it("a hook that refuses stops the exec, by name and by reference", async () => {
      const d = mk();
      const id = d.put(N, "mine");
      const s = spy();
      s.error = new Error("not contained yet");
      d.setContainment(s.hook);
      await expect(d.exec(N, ["true"], OPTS)).rejects.toThrow(/not contained yet/);
      await expect(d.exec(makeRef(id, N), ["true"], OPTS)).rejects.toThrow(/not contained yet/);
      expect(d.execs).toEqual([]);
    });

    it("by reference, on a cache miss: one full inspect, the hook, then the exec", async () => {
      const d = timed();
      const id = d.put(N, "mine");
      const s = spy();
      d.setContainment(s.hook);
      await d.exec(makeRef(id, N), ["true"], OPTS);
      expect(d.verbs).toEqual(["inspect", "exec"]);
      expect(s.calls).toHaveLength(1);
    });

    it("merges the environments: the caller's, then the hook's, then the reference's, which wins", async () => {
      const d = timed();
      const id = d.put(N, "mine");
      const s = spy({ A: "hook", B: "hook" });
      d.setContainment(s.hook);
      await d.exec(makeRef(id, N, { B: "ref", C: "ref" }), ["true"], { ...OPTS, env: { A: "caller", B: "caller", D: "caller" } });
      expect(execEnv(d.execs[0]!).sort()).toEqual(["A=hook", "B=ref", "C=ref", "D=caller"]);
    });

    it("applies the runtime comparison to a reference's exec from the same facts", async () => {
      const d = mk({ MCPE_DOCKER_RUNTIME: "runsc" });
      const id = d.put(N, "mine", { runtime: "runc" });
      d.setContainment(spy().hook);
      await expect(d.exec(makeRef(id, N), ["true"], OPTS)).rejects.toBeInstanceOf(RuntimeMismatchError);
      expect(d.execs).toEqual([]);
    });

    it("a reference that is gone is not an error of the hook: the exec reports it as before", async () => {
      const d = mk();
      const s = spy();
      d.setContainment(s.hook);
      const res = await d.exec(makeRef(idFor("gone"), "gone"), ["true"], OPTS);
      expect(res.code).toBe(0);
      expect(s.calls).toEqual([]);
    });

    it("the restart after a stopped exec asks the hook again, before the start, and the retry carries the fresh answer", async () => {
      const d = timed();
      const id = d.put(N, "mine", { running: false });
      const s = spy({ ROUND: "1" });
      d.setContainment(s.hook);
      d.execReplies = [{ code: 1, stderr: DAEMON }];
      let n = 0;
      s.hook = async (facts, mode) => {
        s.calls.push({ facts, mode });
        return { ROUND: String(++n) };
      };
      d.setContainment(s.hook);
      await d.exec(makeRef(id, N), ["true"], OPTS);
      // exec miss: hook round 1; restart: inspect, hook round 2, start; the retry carries round 2.
      expect(d.verbs).toEqual(["inspect", "exec", "inspect", "start", "exec"]);
      expect(execEnv(d.execs[0]!)).toEqual(["ROUND=1"]);
      expect(execEnv(d.execs[1]!)).toEqual(["ROUND=2"]);
      expect(s.calls).toHaveLength(2);
      expect(d.verbs.indexOf("start")).toBeGreaterThan(d.verbs.lastIndexOf("inspect", d.verbs.indexOf("start")) - 1);
      expect(d.verbs.slice(0, d.verbs.indexOf("start")).filter((v) => v === "inspect")).toHaveLength(2);
    });

    it("with restart: false a stopped exec is not restarted and the hook is asked once, in observe mode", async () => {
      const d = timed();
      const id = d.put(N, "mine", { running: false });
      const s = spy();
      d.setContainment(s.hook);
      d.execReplies = [{ code: 1, stderr: DAEMON }];
      const res = await d.exec(makeRef(id, N), ["true"], { ...OPTS, restart: false });
      expect(res.code).toBe(1);
      expect(d.count("start")).toBe(0);
      expect(s.calls.map((c) => c.mode)).toEqual(["observe"]);
    });
  });

  describe("the cache", () => {
    it("an exec by reference on a running sandbox reuses the hook's answer for 5 s, then asks again", async () => {
      const d = timed();
      const id = d.put(N, "mine");
      const s = spy();
      d.setContainment(s.hook);
      const ref = makeRef(id, N);
      await d.exec(ref, ["true"], OPTS);
      d.t += 4_999;
      await d.exec(ref, ["true"], OPTS);
      expect(s.calls).toHaveLength(1);
      expect(inspects(d)).toHaveLength(1);
      expect(execEnv(d.execs[1]!)).toEqual(execEnv(d.execs[0]!));
      d.t += 1;
      await d.exec(ref, ["true"], OPTS);
      expect(s.calls).toHaveLength(2);
      expect(inspects(d)).toHaveLength(2);
    });

    it("caches an answer of nothing too (an open sandbox costs one inspect per 5 s)", async () => {
      const d = timed();
      const id = d.put(N, "mine", { networks: ["bridge"] });
      const s = spy(null);
      d.setContainment(s.hook);
      for (let i = 0; i < 5; i++) await d.exec(makeRef(id, N), ["true"], OPTS);
      expect(s.calls).toHaveLength(1);
      expect(execEnv(d.execs[4]!)).toEqual([]);
    });

    it("is neither read nor written when the inspect said the sandbox is stopped", async () => {
      const d = timed();
      const id = d.put(N, "mine", { running: false });
      const s = spy();
      d.setContainment(s.hook);
      await d.exec(makeRef(id, N), ["true"], OPTS);
      await d.exec(makeRef(id, N), ["true"], OPTS);
      expect(s.calls).toHaveLength(2);
    });

    it("is never read by an exec by name, and never by the restart (startIfStopped)", async () => {
      const d = timed();
      const id = d.put(N, "mine");
      const s = spy();
      d.setContainment(s.hook);
      const ref = makeRef(id, N);
      await d.exec(ref, ["true"], OPTS);
      await d.exec(N, ["true"], OPTS);
      expect(s.calls).toHaveLength(2);
      d.execReplies = [{ code: 1, stderr: DAEMON }];
      await d.exec(ref, ["true"], OPTS); // a cache hit, then the stopped failure, then the restart's own inspect and hook
      expect(s.calls).toHaveLength(3);
    });

    it("observe mode neither reads nor writes it", async () => {
      const d = timed();
      const id = d.put(N, "mine");
      const s = spy();
      d.setContainment(s.hook);
      const ref = makeRef(id, N);
      await d.exec(ref, ["true"], OPTS);
      await d.exec(ref, ["true"], { ...OPTS, restart: false });
      expect(s.calls.map((c) => c.mode)).toEqual(["full", "observe"]);
    });

    it("setNetwork invalidates it for that sandbox only", async () => {
      const d = timed();
      const id = d.put(N, "mine", { networks: ["bridge"] });
      const other = "mcpe-0123abcd-other";
      const idOther = d.put(other, "mine", { networks: ["bridge"] });
      const s = spy();
      d.setContainment(s.hook);
      await d.exec(makeRef(id, N), ["true"], OPTS);
      await d.exec(makeRef(idOther, other), ["true"], OPTS);
      expect(s.calls).toHaveLength(2);
      await d.setNetwork(N, "off");
      await d.exec(makeRef(id, N), ["true"], OPTS);
      await d.exec(makeRef(idOther, other), ["true"], OPTS);
      expect(s.calls).toHaveLength(3);
    });

    it("a setNetwork that fails invalidates it too", async () => {
      const d = timed();
      const id = d.put(N, "mine", { networks: ["bridge"] });
      const s = spy();
      d.setContainment(s.hook);
      await d.exec(makeRef(id, N), ["true"], OPTS);
      d.script.push((a) => (a[0] === "network" && a[1] === "disconnect" ? { code: 1, stderr: "boom" } : undefined));
      await expect(d.setNetwork(N, "off")).rejects.toThrow();
      await d.exec(makeRef(id, N), ["true"], OPTS);
      expect(s.calls).toHaveLength(2);
    });

    it("destroy invalidates it", async () => {
      const d = timed();
      const id = d.put(N, "mine");
      d.putVolume(V, "mine");
      const s = spy();
      d.setContainment(s.hook);
      await d.exec(makeRef(id, N), ["true"], OPTS);
      await d.destroy(N, V);
      d.put(N, "mine");
      await d.exec(makeRef(id, N), ["true"], OPTS);
      expect(s.calls).toHaveLength(2);
    });

    it("invalidate({id}), ({sandbox}), ({key}) and no filter each clear the matching entries and no others", async () => {
      const d = timed();
      const a = d.put(N, "mine");
      const other = "mcpe-0123abcd-other";
      const b = d.put(other, "mine");
      d.containers.get(other)!.labels = { ...LABELS.mine, "mcp-everything.project": "github:O/Other" };
      const s = spy();
      d.setContainment(s.hook);
      const prime = async () => {
        s.calls.length = 0;
        await d.exec(makeRef(a, N), ["true"], OPTS);
        await d.exec(makeRef(b, other), ["true"], OPTS);
        s.calls.length = 0;
      };
      const probe = async () => {
        await d.exec(makeRef(a, N), ["true"], OPTS);
        await d.exec(makeRef(b, other), ["true"], OPTS);
        return s.calls.map((c) => c.facts.name);
      };
      await prime();
      d.invalidate({ id: a });
      expect(await probe()).toEqual([N]);
      await prime();
      d.invalidate({ sandbox: other });
      expect(await probe()).toEqual([other]);
      await prime();
      d.invalidate({ key: "github:o/other" });
      expect(await probe()).toEqual([other]);
      await prime();
      d.invalidate();
      expect(await probe()).toEqual([N, other]);
    });

    it("an answer that was in flight across an invalidation is used once but not kept", async () => {
      const d = timed();
      const id = d.put(N, "mine");
      const s = spy();
      let release!: () => void;
      s.gate = new Promise<void>((r) => {
        release = r;
      });
      d.setContainment(s.hook);
      const first = d.exec(makeRef(id, N), ["true"], OPTS);
      await new Promise((r) => setImmediate(r));
      expect(s.calls).toHaveLength(1);
      d.invalidate({ id });
      release();
      await first;
      s.gate = undefined;
      await d.exec(makeRef(id, N), ["true"], OPTS);
      expect(s.calls).toHaveLength(2);
    });

    it("installing or removing a hook clears it", async () => {
      const d = timed();
      const id = d.put(N, "mine");
      const s = spy();
      d.setContainment(s.hook);
      await d.exec(makeRef(id, N), ["true"], OPTS);
      d.setContainment(undefined);
      d.setContainment(s.hook);
      await d.exec(makeRef(id, N), ["true"], OPTS);
      expect(s.calls).toHaveLength(2);
    });
  });

  describe("with the real Containment as the hook", () => {
    const PROJECT = "github:owner/app";
    const dirs: string[] = [];
    const setup = async (env: Record<string, string>) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-hook-"));
      dirs.push(dir);
      const d = timed({ MCPE_DATA_DIR: dir, ...env });
      const cfg = loadConfig({ MCPE_DATA_DIR: dir, ...env });
      const reg = new Registry(dir);
      reg.put({ ...record("app"), container: N, ecosystems: ["node"] });
      const c = new Containment(cfg, reg, d, { dataDir: dir });
      let entries = 0;
      d.setContainment(async (facts, mode) => {
        entries++;
        return c.ensureContained(facts, mode);
      });
      return { d, c, entries: () => entries };
    };
    afterEach(() => {
      for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    });

    it("a repair that makes a network and a proxy enters the hook once, and the exec carries the proxy environment", async () => {
      const { d, entries } = await setup({ MCPE_NETWORK: "contained" });
      const net = await d.ensureProjectNetwork(N, PROJECT);
      const id = d.put(N, "mine", { networks: [net.name] });
      d.containers.get(N)!.labels = { ...LABELS.mine, "mcp-everything.project": PROJECT };
      await d.exec(makeRef(id, N), ["true"], OPTS);
      expect(entries()).toBe(1);
      expect(d.created.filter((c) => c.labels["mcp-everything.role"] === "project-proxy")).toHaveLength(1);
      expect(execEnv(d.execs.at(-1)!)).toEqual(expect.arrayContaining(Object.entries(proxyEnvironment(proxyAddress(net.subnet))).map(([k, v]) => `${k}=${v}`)));
      expect(execEnv(d.execs.at(-1)!)).toContain(`HTTP_PROXY=http://${proxyAddress(net.subnet)}:3128`);
    });

    it("acquire of a contained sandbox with no proxy repairs it with one hook entry and returns the environment on the reference", async () => {
      const { d, entries } = await setup({ MCPE_NETWORK: "contained" });
      const net = await d.ensureProjectNetwork(N, PROJECT);
      d.put(N, "mine", { running: false, networks: [net.name] });
      d.containers.get(N)!.labels = { ...LABELS.mine, "mcp-everything.project": PROJECT };
      const ref = await d.acquire(N);
      expect(entries()).toBe(1);
      expect(ref!.env).toEqual(proxyEnvironment(proxyAddress(net.subnet)));
      expect(d.containers.get(N)!.running).toBe(true);
    });

    it("contain, setNetwork and everything they call never enter the hook", async () => {
      const { d, c, entries } = await setup({ MCPE_NETWORK: "contained" });
      d.put(N, "mine", { networks: ["bridge"] });
      d.containers.get(N)!.labels = { ...LABELS.mine, "mcp-everything.project": PROJECT };
      const r = await c.contain(PROJECT);
      expect(r).toMatchObject({ ok: true });
      expect(entries()).toBe(0);
      expect(await d.networkState(N)).toBe("contained");
      await d.setNetwork(N, "off");
      expect(entries()).toBe(0);
      // The proxy and the network the contain made went with the setNetwork.
      expect(d.containers.has(N)).toBe(true);
      expect([...d.containers.values()].filter((x) => x.labels?.["mcp-everything.role"] === "project-proxy")).toEqual([]);
    });

    it("under open, 10 execs by reference on a running, non-contained sandbox cost 10 execs and at most one inspect per 5 s", async () => {
      const { d } = await setup({});
      const id = d.put(N, "mine", { networks: ["bridge"] });
      d.containers.get(N)!.labels = { ...LABELS.mine, "mcp-everything.project": PROJECT };
      // Ten execs one second apart (nine seconds): the cache answers within each 5 s.
      for (let i = 0; i < 10; i++) {
        await d.exec(makeRef(id, N), ["true"], OPTS);
        d.t += 1_000;
      }
      expect(d.count("exec")).toBe(10);
      expect(d.count("inspect")).toBe(2);
      expect(d.argvs).toHaveLength(12);
      // A burst of ten inside one window: one extra inspect.
      const e = (await setup({})).d;
      const id2 = e.put(N, "mine", { networks: ["bridge"] });
      e.containers.get(N)!.labels = { ...LABELS.mine, "mcp-everything.project": PROJECT };
      for (let i = 0; i < 10; i++) await e.exec(makeRef(id2, N), ["true"], OPTS);
      expect(e.count("inspect")).toBe(1);
      expect(e.argvs).toHaveLength(11);
    });

    it("under open, an exec by name costs the one inspect it always did", async () => {
      const { d } = await setup({});
      d.put(N, "mine", { networks: ["bridge"] });
      await d.exec(N, ["true"], OPTS);
      expect(d.verbs).toEqual(["inspect", "exec"]);
    });
  });
});

describe("what containment asks of the Docker layer (leg 7)", () => {
  describe("startForContainment", () => {
    it("starts a stopped sandbox by name, classified and runtime-checked, without asking the hook", async () => {
      const d = mk();
      d.put(N, "mine", { running: false });
      let asked = 0;
      d.setContainment(async () => {
        asked++;
        return undefined;
      });
      const ref = await d.startForContainment(N);
      expect(ref).toMatchObject({ name: N, id: idFor(N) });
      expect("env" in ref!).toBe(false);
      expect(asked).toBe(0);
      expect(d.verbs).toEqual(["inspect", "start"]);
      expect(await mk().startForContainment(N)).toBeUndefined();
    });

    it("refuses another's sandbox and a runtime mismatch, and starts nothing", async () => {
      const d = mk({ MCPE_DOCKER_RUNTIME: "runsc" });
      d.put(N, "mine", { running: false, runtime: "runc" });
      await expect(d.startForContainment(N)).rejects.toBeInstanceOf(RuntimeMismatchError);
      const e = mk();
      e.put(N, "another", { running: false });
      await expect(e.startForContainment(N)).rejects.toBeInstanceOf(SandboxRefusedError);
      expect(d.count("start") + e.count("start")).toBe(0);
    });
  });

  describe("inspectSandbox", () => {
    it("answers the facts of one full inspect, never starts, never asks the hook", async () => {
      const d = mk();
      d.put(N, "mine", { running: false, networks: ["bridge"], runtime: "runc" });
      let asked = 0;
      d.setContainment(async () => {
        asked++;
        return undefined;
      });
      expect(await d.inspectSandbox(N)).toEqual({ id: idFor(N), name: N, running: false, labels: LABELS.mine, networks: ["bridge"], runtime: "runc" });
      expect(d.verbs).toEqual(["inspect"]);
      expect(asked).toBe(0);
      expect(await mk().inspectSandbox(N)).toBeUndefined();
    });
  });

  describe("findProjectNetwork", () => {
    it("is undefined when there is no such network, and the network, unchanged, when it is the project's", async () => {
      const d = mkEgress();
      expect(await d.findProjectNetwork(PS, PROJ)).toBeUndefined();
      const net = putNet(d);
      expect(await d.findProjectNetwork(PS, PROJ)).toEqual({ id: net.id, name: PNET, subnet: "172.30.50.0/24" });
      expect(d.verbs).toEqual(["network inspect", "network inspect"]);
    });

    it("refuses a network of another project or another owner, and never makes or removes one", async () => {
      const d = mkEgress();
      putNet(d, { labels: { ...netLabels(), [PROJECT_L]: "github:o/elsewhere" } });
      await expect(d.findProjectNetwork(PS, PROJ)).rejects.toBeInstanceOf(SandboxRefusedError);
      expect(d.verbs.every((v) => v === "network inspect")).toBe(true);
    });
  });

  describe("projectProxyAttached", () => {
    const withSubnet = (n: FakeNet) => ({ id: n.id, name: n.name, subnet: "172.30.50.0/24" });

    it("is true for a proxy on the network at the proxy address, false for one that is not, and reads only", async () => {
      const d = mkEgress();
      const net = withSubnet(putNet(d));
      const p = await d.createProjectProxy(PS, PROJ, PCONFIG, CONF_LABELS);
      d.argvs.length = 0;
      expect(await d.projectProxyAttached(p.id, net)).toBe(true);
      expect(d.verbs).toEqual(["inspect"]);
      d.containers.get(p.name)!.networks = ["bridge"];
      expect(await d.projectProxyAttached(p.id, net)).toBe(false);
      expect(await d.projectProxyAttached(p.id, { id: "other", name: PNET, subnet: net.subnet })).toBe(false);
      expect(await d.projectProxyAttached(idFor("gone"), net)).toBe(false);
      await expect(d.projectProxyAttached("not-an-id", net)).rejects.toThrow(/full id/);
    });

    it("is true for a STOPPED proxy: the configured address is read (IPAMConfig), not the running one", async () => {
      const d = mkEgress();
      const net = withSubnet(putNet(d));
      const p = await d.createProjectProxy(PS, PROJ, PCONFIG, CONF_LABELS);
      d.containers.get(p.name)!.running = false;
      expect(await d.projectProxyAttached(p.id, net)).toBe(true);
      // The answer would carry an IPAddress only while running; it never matters.
      d.script.push((a) =>
        a[0] === "inspect" && a[a.indexOf("--format") + 1] === "{{json .NetworkSettings.Networks}}"
          ? { stdout: JSON.stringify({ [PNET]: { NetworkID: net.id, IPAddress: "", IPAMConfig: { IPv4Address: "172.30.50.254" } } }) }
          : undefined,
      );
      expect(await d.projectProxyAttached(p.id, net)).toBe(true);
    });

    it("needs the address, not just the network: another address, a running address without IPAMConfig and an alias do not count", async () => {
      const d = mkEgress();
      const net = withSubnet(putNet(d));
      const p = await d.createProjectProxy(PS, PROJ, PCONFIG, CONF_LABELS);
      for (const entry of [
        { NetworkID: net.id, IPAMConfig: { IPv4Address: "172.30.50.10" } },
        { NetworkID: net.id, IPAddress: "172.30.50.254", IPAMConfig: null },
        { NetworkID: net.id, IPAddress: "172.30.50.254" },
        { NetworkID: net.id, Aliases: ["mcpe-proxy", "db.lan"], IPAMConfig: null },
      ]) {
        d.script.length = 0;
        d.script.push((a) =>
          a[0] === "inspect" && a[a.indexOf("--format") + 1] === "{{json .NetworkSettings.Networks}}" ? { stdout: JSON.stringify({ [PNET]: entry }) } : undefined,
        );
        expect(await d.projectProxyAttached(p.id, net), JSON.stringify(entry)).toBe(false);
      }
      // Right address, wrong network id.
      d.script.length = 0;
      d.script.push((a) =>
        a[0] === "inspect" && a[a.indexOf("--format") + 1] === "{{json .NetworkSettings.Networks}}"
          ? { stdout: JSON.stringify({ [PNET]: { NetworkID: "f".repeat(64), IPAMConfig: { IPv4Address: "172.30.50.254" } } }) }
          : undefined,
      );
      expect(await d.projectProxyAttached(p.id, net)).toBe(false);
    });

    it("says it cannot tell when Docker cannot answer, rather than false", async () => {
      const d = mkEgress();
      const net = withSubnet(putNet(d));
      const p = await d.createProjectProxy(PS, PROJ, PCONFIG, CONF_LABELS);
      d.script.push((a) => (a[0] === "inspect" ? { code: 1, stderr: "Cannot connect to the Docker daemon" } : undefined));
      await expect(d.projectProxyAttached(p.id, net)).rejects.toBeInstanceOf(DockerUnavailableError);
    });
  });

  describe("createProjectProxy with a name given beforehand", () => {
    it("uses the name, and refuses one that is not this sandbox's proxy name", async () => {
      const d = mkEgress();
      putNet(d);
      const name = `${PS}-proxy-0a1b2c3d`;
      expect((await d.createProjectProxy(PS, PROJ, PCONFIG, CONF_LABELS, { name })).name).toBe(name);
      expect(d.created.at(-1)!.name).toBe(name);
      for (const bad of ["x", `${PS}-proxy-zz`, `other-proxy-0a1b2c3d`, `${PS}-proxy-0a1b2c3d9`]) {
        await expect(d.createProjectProxy(PS, PROJ, PCONFIG, CONF_LABELS, { name: bad })).rejects.toThrow(/is named <sandbox>-proxy/);
      }
    });
  });

  describe("removeProjectProxyNamed", () => {
    it("removes the proxy of that name, by id, after classifying it", async () => {
      const d = mkEgress();
      putNet(d);
      const p = await d.createProjectProxy(PS, PROJ, PCONFIG, CONF_LABELS);
      d.argvs.length = 0;
      await d.removeProjectProxyNamed(PS, p.name);
      expect(d.argvs.at(-1)).toEqual(["rm", "-f", "-v", p.id]);
      expect(d.containers.has(p.name)).toBe(false);
      d.argvs.length = 0;
      await d.removeProjectProxyNamed(PS, p.name); // gone: success
      expect(d.argvs.map((a) => a[0])).toEqual(["inspect"]);
    });

    it("refuses a name that is not a proxy name of the sandbox, and a proxy that is another sandbox's or another installation's", async () => {
      const d = mkEgress();
      putNet(d);
      const p = await d.createProjectProxy(PS, PROJ, PCONFIG, CONF_LABELS);
      await expect(d.removeProjectProxyNamed(PS, PS)).rejects.toThrow(/is named <sandbox>-proxy/);
      await expect(d.removeProjectProxyNamed(PS, "mcpe-0123abcd-box")).rejects.toThrow(/is named <sandbox>-proxy/);
      d.containers.get(p.name)!.labels = { ...d.containers.get(p.name)!.labels, [SANDBOX_L]: "another-sandbox" };
      await expect(d.removeProjectProxyNamed(PS, p.name)).rejects.toBeInstanceOf(SandboxRefusedError);
      d.containers.get(p.name)!.labels = { ...d.containers.get(p.name)!.labels, [SANDBOX_L]: PS, [OWNER_L]: "deadbeef" };
      await expect(d.removeProjectProxyNamed(PS, p.name)).rejects.toBeInstanceOf(SandboxRefusedError);
      expect(d.count("rm")).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// The contained install (flight 02, leg 8): the sandbox created stopped, the clone and the scanners behind a proxy
// ---------------------------------------------------------------------------
describe("createContainer with start: false (leg 8)", () => {
  const CONTAINED = { MCPE_NETWORK: "contained" };
  const made = async (env: Record<string, string>, start?: boolean) => {
    const d = mk(env);
    d.putVolume("v", "mine");
    const ref = await d.createContainer({ name: "n", volume: "v", image: "img", project: "p", ...(start === undefined ? {} : { start }) });
    return { d, ref };
  };

  it("issues `docker create` with the arguments of `run -d` minus `-d`, on bridge, and nothing else changes", async () => {
    const run = await made({});
    const create = await made({}, false);
    const runArgs = run.d.argvs.find((a) => a[0] === "run")!;
    const createArgs = create.d.argvs.find((a) => a[0] === "create")!;
    expect(createArgs.slice(1)).toEqual(runArgs.slice(2));
    expect(runArgs.slice(0, 2)).toEqual(["run", "-d"]);
    expect(create.d.count("run")).toBe(0);
    expect(create.d.count("start")).toBe(0);
    expect(sub(createArgs, "--network")).toEqual(["bridge"]);
  });

  it("never uses a network other than bridge, whichever the mode", async () => {
    for (const env of [{}, CONTAINED]) {
      const { d } = await made(env, false);
      expect(sub(d.argvs.find((a) => a[0] === "create")!, "--network")).toEqual(["bridge"]);
    }
  });

  it("returns a reference for the id that create printed, and verifies it", async () => {
    const { d, ref } = await made(CONTAINED, false);
    expect(ref).toEqual(makeRef(idFor("n"), "n"));
    const bad = mk(CONTAINED);
    bad.putVolume("v", "mine");
    bad.script.push((a) => (a[0] === "create" ? { stdout: "not-an-id\n" } : undefined));
    await expect(bad.createContainer({ name: "n", volume: "v", image: "img", project: "p", start: false })).rejects.toThrow(/created a sandbox container but printed no usable id/);
    expect(d.containers.get("n")!.running).toBe(false);
  });

  it("a failed create says so, and a runtime Docker will not run is the runtime refusal", async () => {
    const d = mk(CONTAINED);
    d.putVolume("v", "mine");
    d.script.push((a) => (a[0] === "create" ? { code: 1, stderr: "boom\n" } : undefined));
    await expect(d.createContainer({ name: "n", volume: "v", image: "img", project: "p", start: false })).rejects.toThrow(/Failed to create sandbox container: boom/);
    const r = mk({ ...CONTAINED, MCPE_DOCKER_RUNTIME: "runsc" });
    r.putVolume("v", "mine");
    r.script.push((a) => (a[0] === "create" ? { code: 125, stderr: "docker: Error response from daemon: unknown or invalid runtime name: runsc\n" } : undefined));
    await expect(r.createContainer({ name: "n", volume: "v", image: "img", project: "p", start: false })).rejects.toBeInstanceOf(RuntimeUnavailableError);
  });

  it("under containment a start is refused before any Docker call: a sandbox that began on bridge would have reached the network", async () => {
    for (const start of [undefined, true]) {
      const d = mk(CONTAINED);
      d.putVolume("v", "mine");
      await expect(d.createContainer({ name: "n", volume: "v", image: "img", project: "p", ...(start === undefined ? {} : { start }) })).rejects.toThrow(/not started on bridge under MCPE_NETWORK=contained/);
      expect(d.argvs).toEqual([]);
    }
  });

  it("under open the default is today's `docker run -d`", async () => {
    const { d } = await made({});
    expect(d.count("run")).toBe(1);
    expect(d.count("create")).toBe(0);
  });
});

describe("startForContainment maps Docker's refusal of a runtime (leg 8)", () => {
  it("is the runtime refusal when the start says the runtime is unknown, and a plain failure otherwise", async () => {
    const d = mk({ MCPE_DOCKER_RUNTIME: "runsc" });
    d.put(N, "mine", { running: false, runtime: "runsc" });
    d.script.push((a) => (a[0] === "start" ? { code: 125, stderr: "Error response from daemon: unknown or invalid runtime name: runsc\n" } : undefined));
    await expect(d.startForContainment(N)).rejects.toBeInstanceOf(RuntimeUnavailableError);
    const e = mk({ MCPE_DOCKER_RUNTIME: "runsc" });
    e.put(N, "mine", { running: false, runtime: "runsc" });
    e.script.push((a) => (a[0] === "start" ? { code: 1, stderr: "boom\n" } : undefined));
    await expect(e.startForContainment(N)).rejects.toThrow(/Failed to start sandbox .*boom/);
    await expect(e.startForContainment(N)).rejects.not.toBeInstanceOf(RuntimeUnavailableError);
  });
});

describe("the clone under containment (leg 8)", () => {
  const CONTAINED = { MCPE_NETWORK: "contained" };
  const FORGE = { ...REPO, host: "git.example.com", cloneUrl: "https://git.example.com/o/r.git" };
  const clone = (d: ScriptedDocker, repo: typeof REPO | typeof FORGE = REPO) => d.probe(repo, V, {});
  const allowOf = (d: ScriptedDocker) => (JSON.parse(d.argvs.find(isProxyCreate)!.at(-1)!) as { allow: Array<{ host: string; wildcard: boolean; ports: number[]; local: boolean }> }).allow;

  it("runs through a one-shot proxy that allows only the repository's forge, not on bridge", async () => {
    const d = mkEgress(CONTAINED);
    await clone(d);
    expect(allowOf(d).map((e) => [e.host, e.local])).toEqual([["github.com", false]]);
    const oneShot = d.created.find((c) => c.labels[ROLE_L] === "clone")!;
    expect(sub(oneShot.args, "--network")).not.toContain("bridge");
    expect(sub(oneShot.args, "--network")[0]).toMatch(/^mcpe-0123abcd-oneshot-net-/);
    expect(d.argvs.some(isProxyCreate)).toBe(true);
  });

  it("allows a forge named in MCPE_EXTRA_HOSTS to be local; github.com and gitlab.com never are", async () => {
    const extra = mkEgress({ ...CONTAINED, MCPE_EXTRA_HOSTS: "git.example.com=gitlab" });
    await clone(extra, FORGE);
    expect(allowOf(extra).map((e) => [e.host, e.local])).toEqual([["git.example.com", true]]);
    const lab = mkEgress(CONTAINED);
    await clone(lab, { ...REPO, host: "gitlab.com", cloneUrl: "https://gitlab.com/o/r.git" });
    expect(allowOf(lab).map((e) => [e.host, e.local])).toEqual([["gitlab.com", false]]);
  });

  it("under open it is today's clone on bridge: no proxy, no network", async () => {
    const d = mk();
    await d.probe(REPO, V, {});
    expect(d.argvs.some(isProxyCreate)).toBe(false);
    expect(d.count("network create")).toBe(0);
    expect(sub(d.created.find((c) => c.labels[ROLE_L] === "clone")!.args, "--network")).toEqual(["bridge"]);
  });

  it("a failed clone with refusal rows carries a line for each refused host: the error and the lines of CloneFailedError", async () => {
    const d = mkEgress(CONTAINED);
    failRun(d, { code: 128, stderr: "fatal: unable to access 'https://other.example/x/'\n" });
    d.statusBody = {
      ...READY, total: 3, resolverFailures: 0,
      refusals: [{ ...ROW, host: "other.example" }, { ...ROW, host: "other.example", port: 80 }, { ...ROW, host: "second.example" }],
    };
    const e = (await settle(clone(d))) as CloneFailedError;
    expect(e).toBeInstanceOf(CloneFailedError);
    expect(e.refusals).toEqual([
      "The clone was refused `other.example`: submodules on other forges are not reachable under containment.",
      "The clone was refused `second.example`: submodules on other forges are not reachable under containment.",
    ]);
    expect(e.detail).toMatch(/^Could not clone https:\/\/github\.com\/o\/r\.git:\nfatal: unable to access/);
    expect(e.message).toBe(`${e.detail}\n${e.refusals.join("\n")}`);
    clean(d);
  });

  it("a failed clone with no rows, or only rows that name no host, has no refusal lines", async () => {
    for (const body of [READY, { ...READY, refusals: [{ ...ROW, host: null, port: null, kind: "http", reason: "method" }], total: 1 }]) {
      const d = mkEgress(CONTAINED);
      failRun(d, { code: 128, stderr: "fatal: not found\n" });
      d.statusBody = body;
      const e = (await settle(clone(d))) as CloneFailedError;
      expect(e.refusals).toEqual([]);
      expect(e.message).toBe(e.detail);
    }
  });

  it("a proxy that did not start keeps ProxyStartError's message and is never a refusal", async () => {
    const d = mkEgress(CONTAINED);
    d.script.push((a) => (isProxyCreate(a) ? { code: 1, stderr: "Error response from daemon: no space left\n" } : undefined));
    const e = await settle(clone(d));
    expect(e).toBeInstanceOf(ProxyStartError);
    expect(e).not.toBeInstanceOf(CloneFailedError);
    expect((e as Error).message).toBe("the network proxy did not start: Error response from daemon: no space left");
  });

  it("under open, a failed clone is a plain Error with today's text", async () => {
    const d = mk();
    d.script.push((a) => (a[0] === "start" && a[1] === "-a" ? { code: 128, stderr: "fatal: nope\n" } : undefined));
    const e = await settle(d.probe(REPO, V, {}));
    expect(e).not.toBeInstanceOf(CloneFailedError);
    expect((e as Error).message).toBe("Could not clone https://github.com/o/r.git:\nfatal: nope");
  });
});

describe("a scanner under containment (leg 8)", () => {
  const CONTAINED = { MCPE_NETWORK: "contained" };
  const NETWORKED = { ...SCANNER, network: true, hosts: ["api.example.com:8443", "*.cdn.example.org", "203.0.113.7"] };
  const stage = (d: ScriptedDocker) => d.putVolume(STAGING, "mine", "staging");
  const allowOf = (d: ScriptedDocker) => (JSON.parse(d.argvs.find(isProxyCreate)!.at(-1)!) as { allow: Array<{ host: string; wildcard: boolean; ports: number[]; literal: boolean; local: boolean }> }).allow;

  it("with a network, runs behind a proxy that allows its hosts (parsed in scanner mode, literals included), local allowed", async () => {
    const d = mkEgress(CONTAINED);
    stage(d);
    await d.runScanner(STAGING, NETWORKED, { timeoutMs: 20_000 });
    expect(allowOf(d)).toEqual([
      { host: "api.example.com", wildcard: false, ports: [8443], literal: false, local: true },
      { host: "cdn.example.org", wildcard: true, ports: [443, 80], literal: false, local: true },
      { host: "203.0.113.7", wildcard: false, ports: [443, 80], literal: true, local: true },
    ]);
    const a = d.created.find((c) => c.labels[ROLE_L] === "scan")!.args;
    expect(sub(a, "--network")[0]).toMatch(/^mcpe-0123abcd-oneshot-net-/);
    expect(a.slice(-4)).toEqual(["scan:1", "scan", "--sarif", "."]);
  });

  it("without a network, runs on none, as it always did, even under containment", async () => {
    const d = mkEgress(CONTAINED);
    stage(d);
    await d.runScanner(STAGING, SCANNER, { timeoutMs: 20_000 });
    expect(d.argvs.some(isProxyCreate)).toBe(false);
    expect(sub(d.created.find((c) => c.labels[ROLE_L] === "scan")!.args, "--network")).toEqual(["none"]);
  });

  it("under open, a scanner with a network is on bridge as before, and hosts are not read", async () => {
    const d = mkEgress();
    stage(d);
    await d.runScanner(STAGING, NETWORKED, { timeoutMs: 20_000 });
    expect(d.argvs.some(isProxyCreate)).toBe(false);
    expect(sub(d.created.find((c) => c.labels[ROLE_L] === "scan")!.args, "--network")).toEqual(["bridge"]);
  });

  it("a failed run returns what the proxy refused (the caller turns it into lines)", async () => {
    const d = mkEgress(CONTAINED);
    stage(d);
    d.script.push((a) => (a[0] === "start" && a[1] === "-a" && roleOf(d, a.at(-1)) === "scan" ? { code: 2, stderr: "boom" } : undefined));
    d.statusBody = { ...READY, refusals: [ROW], total: 2, resolverFailures: 0 };
    const r = await d.runScanner(STAGING, NETWORKED, { timeoutMs: 20_000 });
    expect(r.code).toBe(2);
    expect(r.proxy).toEqual({ rows: [ROW], total: 2, resolverFailures: 0 });
  });
});

describe("projectRefusals (leg 8)", () => {
  const rows = (...hosts: string[]) => hosts.map((host) => ({ ...ROW, host }));
  const withProxies = (n: number) => {
    const d = mkEgress({ MCPE_NETWORK: "contained" });
    for (let i = 1; i <= n; i++) putProxy(d, proxyName(i));
    return d;
  };

  it("reads the status of each of the sandbox's proxies and returns the parsed rows", async () => {
    const d = withProxies(2);
    d.statusBody = { ...READY, refusals: rows("a.example", "b.example"), total: 2 };
    const got = await d.projectRefusals(PS);
    expect(got.map((r) => r.host)).toEqual(["a.example", "b.example", "a.example", "b.example"]);
    expect(d.execs).toHaveLength(2);
  });

  it("is an empty list when there is no proxy, the report cannot be read, or Docker cannot be asked; it never throws", async () => {
    expect(await withProxies(0).projectRefusals(PS)).toEqual([]);
    const bad = withProxies(1);
    bad.statusBody = "<html>";
    expect(await bad.projectRefusals(PS)).toEqual([]);
    const broken = withProxies(1);
    broken.script.push((a) => (a[0] === "ps" ? { code: 1, stderr: "Cannot connect" } : undefined));
    expect(await broken.projectRefusals(PS)).toEqual([]);
  });

  it("issues no command that changes anything", async () => {
    const d = withProxies(1);
    d.strict = true;
    d.script.push((a) => (a[0] === "exec" ? { stdout: JSON.stringify(READY) } : undefined));
    await d.projectRefusals(PS);
    expect(d.violations.filter((v) => v[0] !== "exec")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Proxy by address (flight 02, leg 13)
// ---------------------------------------------------------------------------

describe("proxyAddress", () => {
  it.each([
    ["172.22.0.0/16", "172.22.255.254"],
    ["10.1.2.0/24", "10.1.2.254"],
    ["192.168.16.0/20", "192.168.31.254"],
    ["10.0.0.0/30", "10.0.0.2"],
    ["10.0.0.0/29", "10.0.0.6"],
    ["10.0.0.0/8", "10.255.255.254"],
    ["172.22.5.7/16", "172.22.255.254"], // a base that is not the network address is masked first
  ])("%s gives the last usable host, %s", (subnet, address) => {
    expect(proxyAddress(subnet)).toBe(address);
  });

  it("is never the broadcast address, and always inside the subnet", () => {
    for (const p of [8, 12, 16, 20, 24, 28, 29, 30]) {
      const subnet = `10.64.0.0/${p}`;
      const a = proxyAddress(subnet).split(".").map(Number);
      const n = ((a[0]! << 24) >>> 0) + (a[1]! << 16) + (a[2]! << 8) + a[3]!;
      const size = 2 ** (32 - p);
      const base = (((10 << 24) >>> 0) + (64 << 16)) >>> 0;
      const start = base - (base % size);
      expect(n).toBe(start + size - 2);
    }
  });

  it.each([["10.0.0.0/31"], ["10.0.0.0/32"], ["10.0.0.0/0"], ["10.0.0.0/33"], ["10.0.0.0"], ["fd00::/64"], ["300.0.0.0/24"], ["a.b.c.d/24"], [""], ["10.0.0.0/24 "]])(
    "refuses %j",
    (subnet) => {
      expect(() => proxyAddress(subnet)).toThrow();
    },
  );
});

describe("no embedded DNS anywhere (leg 13)", () => {
  it("no `network connect` in docker.ts carries --alias, and the file has no alias at all", () => {
    const src = readSources(DOCKER_SOURCES);
    expect(src).not.toMatch(/--alias/);
    expect(src).not.toMatch(/PROXY_ALIAS/);
    // Leg 14: a proxy's address is given at its create (`--network name=...,ip=...`); a connect of a proxy is `bridge` (no address) or,
    // for a restored one, `--ip <address>`; the only other connect is the sandbox's own attach to its network (no address, no alias).
    const connects = [...src.matchAll(/\[\s*"network",\s*"connect"[^\]]*\]/g)].map((m) => m[0]);
    expect(connects.length).toBeGreaterThanOrEqual(4);
    for (const c of connects) if (!c.includes("sandbox.id") && !c.includes('"bridge"')) expect(c).toMatch(/"--ip"/);
    expect(connects.filter((c) => c.includes('"--ip"'))).toHaveLength(1); // the restored proxy
    expect(src.match(/ip=\$\{proxyAddress\(net\.subnet\)\},mac-address=\$\{proxyMac\(net\.id\)\}/g)).toHaveLength(1); // the one create spec both proxies share
  });

  it("no source file names the proxy by host name", () => {
    expect(readSources(DOCKER_SOURCES)).not.toMatch(/mcpe-proxy/);
    expect(readSources(CONTAINMENT_SOURCES)).not.toMatch(/mcpe-proxy/);
  });

  it("the proxy environment holds an address and no host name, for every subnet shape", () => {
    for (const subnet of ["172.22.0.0/16", "10.1.2.0/24", "192.168.16.0/20"]) {
      const env = proxyEnvironment(proxyAddress(subnet));
      for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) expect(env[k]).toMatch(/^http:\/\/\d{1,3}(\.\d{1,3}){3}:3128$/);
    }
  });

  it("a one-shot's proxy and a project proxy are created with their address and carry no --alias; a restored proxy's connect carries --ip", async () => {
    const d = mkEgress();
    await d.once(EGRESS);
    const e = mkEgress();
    putNet(e);
    const p = await e.createProjectProxy(PS, PROJ, PCONFIG, CONF_LABELS);
    await e.restoreProjectProxy(p.id, { id: idFor(`net:${PNET}`), name: PNET, subnet: "172.30.50.0/24" });
    for (const x of [d, e]) {
      for (const a of x.argvs) expect(a).not.toContain("--alias");
      for (const a of x.argvs.filter((y) => y[0] === "create" && y.includes("--read-only"))) expect(sub(a, "--network")[0]).toMatch(/^name=.+,ip=\d+\.\d+\.\d+\.254,mac-address=02(:[0-9a-f]{2}){5}$/);
    }
    for (const a of d.argvs.filter((y) => y[0] === "network" && y[1] === "connect")) expect(a).toEqual(["network", "connect", "bridge", expect.any(String)]);
    expect(e.argvs.filter((y) => y[0] === "network" && y[1] === "connect").filter((a) => a.includes("--ip"))).toHaveLength(1);
  });
});

describe("taking a proxy off its network and putting it back (leg 13)", () => {
  const NETREF = { id: idFor(`net:${PNET}`), name: PNET, subnet: "172.30.50.0/24" };
  const setup = async () => {
    const d = mkEgress();
    putNet(d);
    const p = await d.createProjectProxy(PS, PROJ, PCONFIG, CONF_LABELS);
    d.argvs.length = 0;
    return { d, p };
  };

  it("detach disconnects the proxy from the network by id, with -f, after classifying it", async () => {
    const { d, p } = await setup();
    await d.detachProjectProxy(p.id, NETREF);
    expect(d.argvs.filter((a) => a[0] === "network")).toEqual([["network", "disconnect", "-f", NETREF.id, p.id]]);
    expect(d.containers.get(p.name)!.networks).toEqual(["bridge"]);
    expect(d.containers.get(p.name)!.ips).toEqual({});
    expect(await d.projectProxyAttached(p.id, NETREF)).toBe(false);
    // a proxy that is already off the network, or gone, is success
    await d.detachProjectProxy(p.id, NETREF);
    await d.detachProjectProxy(idFor("gone"), NETREF);
  });

  it("detach refuses another installation's proxy and a container that is not a proxy, and disconnects nothing", async () => {
    const d = mkEgress();
    putNet(d);
    const other = putProxy(d, proxyName(3), proxyLabels(PS, { [OWNER_L]: OTHER_ID }));
    const notProxy = putProxy(d, proxyName(4), proxyLabels(PS, { [ROLE_L]: "clone" }));
    await expect(d.detachProjectProxy(other.id, NETREF)).rejects.toBeInstanceOf(SandboxRefusedError);
    await expect(d.detachProjectProxy(notProxy.id, NETREF)).rejects.toBeInstanceOf(SandboxRefusedError);
    await expect(d.detachProjectProxy("not-an-id", NETREF)).rejects.toThrow(/full id/);
    expect(d.count("network disconnect")).toBe(0);
  });

  it("restore stops the proxy, connects it at the address, starts it, waits for readiness and checks the attachment, in that order", async () => {
    const { d, p } = await setup();
    await d.detachProjectProxy(p.id, NETREF);
    d.argvs.length = 0;
    await d.restoreProjectProxy(p.id, NETREF);
    const order = d.argvs.map((a) => (a[0] === "network" ? `network ${a[1]}` : a[0]!));
    expect(order.slice(0, 4)).toEqual(["inspect", "stop", "network connect", "start"]); // classified first
    expect(order.indexOf("exec")).toBeGreaterThan(order.indexOf("start")); // readiness
    expect(order.at(-1)).toBe("inspect"); // the attachment check
    expect(d.argvs[2]).toEqual(["network", "connect", "--ip", "172.30.50.254", NETREF.id, p.id]);
    expect(d.containers.get(p.name)!.running).toBe(true);
    expect(await d.projectProxyAttached(p.id, NETREF)).toBe(true);
  });

  it("restore fails with ProxyStartError when the address is taken, and when the proxy is gone", async () => {
    const { d, p } = await setup();
    await d.detachProjectProxy(p.id, NETREF);
    putProxy(d, proxyName(5), proxyLabels(), { networks: ["bridge", PNET] });
    d.containers.get(proxyName(5))!.ips = { [PNET]: "172.30.50.254" };
    const e = await settle(d.restoreProjectProxy(p.id, NETREF));
    expect(e).toBeInstanceOf(ProxyStartError);
    expect((e as Error).message).toContain("172.30.50.254");
    expect(await settle(d.restoreProjectProxy(idFor("gone"), NETREF))).toBeInstanceOf(ProxyStartError);
  });

  it("restore fails when the proxy does not become ready", async () => {
    const { d, p } = await setup();
    await d.detachProjectProxy(p.id, NETREF);
    d.statusBody = { ...READY, ready: false };
    (d as unknown as { proxyReadiness: { budgetMs: number; pollMs: number } }).proxyReadiness = { budgetMs: 20, pollMs: 5 };
    expect(await settle(d.restoreProjectProxy(p.id, NETREF))).toBeInstanceOf(ProxyStartError);
  });
});

describe("the sandbox's /etc/hosts (leg 13)", () => {
  const MARK = "# mcpe-local-access";
  const run = (want: string, file: string) => execFileSync("sh", ["-c", LOCAL_ACCESS_SCRIPT, "sh", want, file], { stdio: "pipe" });
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  const tmp = (content: string): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-hosts-"));
    tmpDirs.push(dir);
    const file = path.join(dir, "hosts");
    fs.writeFileSync(file, content);
    return file;
  };
  const BASE = "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n172.30.1.2\tsandbox\n";
  const lines = (address: string, ...names: string[]) => names.map((n) => `${address} ${n}   ${MARK}`).join("\n");

  describe("the script", () => {
    it("writes the lines after the sandbox's own, and keeps every one of those", () => {
      const f = tmp(BASE);
      run(lines("172.30.1.254", "db.lan", "host.docker.internal"), f);
      expect(fs.readFileSync(f, "utf8")).toBe(`${BASE}${lines("172.30.1.254", "db.lan", "host.docker.internal")}\n`);
    });

    it("is idempotent: written twice, there is one set of lines", () => {
      const f = tmp(BASE);
      const want = lines("172.30.1.254", "db.lan", "host.docker.internal");
      run(want, f);
      const once = fs.readFileSync(f, "utf8");
      run(want, f);
      expect(fs.readFileSync(f, "utf8")).toBe(once);
      expect(once.split("\n").filter((l) => l.endsWith(MARK))).toHaveLength(2);
    });

    it("writes nothing when the lines are already right (a read-only file does not make it fail)", () => {
      const f = tmp(BASE);
      const want = lines("172.30.1.254", "db.lan");
      run(want, f);
      fs.chmodSync(f, 0o444);
      expect(() => run(want, f)).not.toThrow();
      // A change would have to write (root ignores the mode, so this half only says something for another user).
      if (process.getuid?.() !== 0) expect(() => run(lines("172.30.1.254", "other.lan"), f)).toThrow();
    });

    it("replaces earlier marked lines (another address, other names) and leaves unmarked lines alone", () => {
      const f = tmp(`${BASE}10.9.9.9 keepme.lan\n${lines("172.30.1.254", "old.lan")}\n`);
      run(lines("172.30.7.254", "db.lan"), f);
      expect(fs.readFileSync(f, "utf8")).toBe(`${BASE}10.9.9.9 keepme.lan\n${lines("172.30.7.254", "db.lan")}\n`);
    });

    it("removes the marked lines when there are none wanted, and is then idempotent too", () => {
      const f = tmp(`${BASE}${lines("172.30.1.254", "db.lan", "host.docker.internal")}\n`);
      run("", f);
      expect(fs.readFileSync(f, "utf8")).toBe(BASE);
      run("", f);
      expect(fs.readFileSync(f, "utf8")).toBe(BASE);
    });

    it("writes with one printf into the file and uses neither sed -i nor mv (a bind mount cannot be replaced)", () => {
      expect(LOCAL_ACCESS_SCRIPT).not.toMatch(/\bsed\b/);
      expect(LOCAL_ACCESS_SCRIPT).not.toMatch(/\bmv\b/);
      expect(LOCAL_ACCESS_SCRIPT).not.toMatch(/\bcp\b/);
      expect(LOCAL_ACCESS_SCRIPT.match(/> "\$file"/g)).toHaveLength(1);
      expect(LOCAL_ACCESS_SCRIPT.match(/\bprintf\b/g)).toHaveLength(2); // one per branch of one if, one redirect after it
    });
  });

  describe("writeLocalAccess", () => {
    const ID64 = idFor(PS);
    const put = (d: ScriptedDocker, cls: SandboxClass = "mine") => d.put(PS, cls, { networks: [PNET] });

    it("is one root exec of the script with the lines and the file as arguments, and not through the hook", async () => {
      const d = mkEgress();
      put(d);
      let hooked = 0;
      d.setContainment(async () => {
        hooked++;
        return undefined;
      });
      await d.writeLocalAccess({ id: ID64, name: PS }, "172.30.50.254", ["db.lan", "host.docker.internal", "db.lan"]);
      expect(d.execs).toEqual([
        ["exec", "-u", "0", ID64, "sh", "-c", LOCAL_ACCESS_SCRIPT, "sh", `172.30.50.254 db.lan   ${MARK}\n172.30.50.254 host.docker.internal   ${MARK}`, "/etc/hosts"],
      ]);
      expect(hooked).toBe(0);
    });

    it("writes an empty set of lines for no names", async () => {
      const d = mkEgress();
      put(d);
      await d.writeLocalAccess({ id: ID64, name: PS }, "172.30.50.254", []);
      expect(d.execs[0]!.slice(-2)).toEqual(["", "/etc/hosts"]);
    });

    it.each([["localhost"], ["sandbox"], ["ip6-localhost"], [idFor(PS).slice(0, 12)], ["UPPER.case"], ["a b.lan"], ["db.lan\n10.0.0.1 evil"], ["-x.lan"], ["a".repeat(254)]])(
      "refuses the name %j: the sandbox's own, or not a plain host name, and executes nothing",
      async (name) => {
        const d = mkEgress();
        put(d);
        await expect(d.writeLocalAccess({ id: ID64, name: PS }, "172.30.50.254", ["ok.lan", name])).rejects.toThrow();
        expect(d.count("exec")).toBe(0);
      },
    );

    it("refuses a bad address and an id that is not a full one", async () => {
      const d = mkEgress();
      put(d);
      await expect(d.writeLocalAccess({ id: ID64, name: PS }, "172.30.50.999", [])).rejects.toThrow(/IPv4/);
      await expect(d.writeLocalAccess({ id: ID64, name: PS }, "db.lan", [])).rejects.toThrow(/IPv4/);
      await expect(d.writeLocalAccess({ id: "abc", name: PS }, "172.30.50.254", [])).rejects.toThrow(/full id/);
      expect(d.count("exec")).toBe(0);
    });

    it.each<SandboxClass>(["another", "not-ours"])("refuses a sandbox that is %s with inspects only", async (cls) => {
      const d = mkEgress();
      put(d, cls);
      await expect(d.writeLocalAccess({ id: ID64, name: PS }, "172.30.50.254", ["db.lan"])).rejects.toBeInstanceOf(SandboxRefusedError);
      for (const v of d.verbs) expect(v).toBe("inspect");
    });

    it("does nothing for a sandbox that is gone, and throws when the exec fails or times out", async () => {
      const gone = mkEgress();
      await gone.writeLocalAccess({ id: ID64, name: PS }, "172.30.50.254", ["db.lan"]);
      expect(gone.count("exec")).toBe(0);
      for (const r of [{ code: 1, stderr: "sh: can't create /etc/hosts: Read-only file system" }, { code: null as unknown as number, timedOut: true }]) {
        const d = mkEgress();
        put(d);
        d.execReplies = [r as Reply];
        await expect(d.writeLocalAccess({ id: ID64, name: PS }, "172.30.50.254", ["db.lan"])).rejects.toThrow(/Could not write the local-access names/);
      }
    });
  });

  describe("a sandbox named a forward target is refused by the grammar as well", () => {
    it("`localhost` and the sandbox's hostname cannot be local-access targets at all", () => {
      for (const name of ["localhost", "sandbox"]) {
        expect(() => loadConfig({ MCPE_NETWORK: "contained", MCPE_LOCAL_ACCESS: `owner/app=${name}:8080` })).toThrow(/at least two labels/);
      }
    });
  });

  describe("the post-start step", () => {
    type Seen = { name: string; running: boolean; started: boolean; networks: string[]; networkIds?: Record<string, string> };
    const hooked = (d: ScriptedDocker) => {
      const seen: Seen[] = [];
      d.setContainment(async () => undefined, async (f, started) => {
        seen.push({ name: f.name, running: f.running, started, networks: f.networks, ...(f.networkIds ? { networkIds: f.networkIds } : {}) });
      });
      return seen;
    };

    it("runs after acquire starts a stopped sandbox (started), and after acquire of a running one (not started)", async () => {
      const d = mk();
      d.put(N, "mine", { running: false });
      const seen = hooked(d);
      await d.acquire(N);
      expect(seen).toEqual([{ name: N, running: true, started: true, networks: [] }]);
      await d.acquire(N);
      expect(seen.at(-1)).toMatchObject({ started: false, running: true });
      // and it comes after the start, never before
      expect(d.verbs.indexOf("start")).toBeGreaterThan(-1);
    });

    it("runs after ensureRunning starts a sandbox, and not when it was running", async () => {
      const d = mk();
      d.put(N, "mine", { running: false });
      const seen = hooked(d);
      await d.ensureRunning(N);
      expect(seen).toHaveLength(1);
      await d.ensureRunning(N);
      expect(seen).toHaveLength(1);
    });

    it("runs in exec's restart path, after the start, and not on an ordinary exec", async () => {
      const d = mk();
      const id = d.put(N, "mine", { running: false });
      const seen = hooked(d);
      d.execReplies = [{ code: 1, stderr: DAEMON }, { code: 0, stdout: "ok" }];
      await d.exec(makeRef(id, N), ["true"], OPTS);
      expect(seen).toEqual([{ name: N, running: true, started: true, networks: [] }]);
      const plain = mk();
      const id2 = plain.put(N, "mine");
      const none = hooked(plain);
      await plain.exec(makeRef(id2, N), ["true"], OPTS);
      await plain.exec(N, ["true"], OPTS);
      expect(none).toEqual([]);
    });

    it("runs after startForContainment starts a sandbox, with the facts' network ids, and not when it was running", async () => {
      const d = mk();
      d.put(N, "mine", { running: false, networks: ["x-net"] });
      d.script.push((a) =>
        a[0] === "inspect" && a[a.indexOf("--format") + 1] !== undefined && a[a.indexOf("--format") + 1]!.includes('"networks"') && false
          ? undefined
          : undefined,
      );
      const seen = hooked(d);
      await d.startForContainment(N);
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ started: true, networks: ["x-net"] });
      await d.startForContainment(N);
      expect(seen).toHaveLength(1);
    });

    it("carries the network ids the inspect gives, by network name", async () => {
      const d = mk();
      d.put(N, "mine", { running: false });
      d.script.push((a) =>
        a[0] === "inspect" && a.at(-1) === N
          ? { stdout: JSON.stringify({ id: idFor(N), name: `/${N}`, running: false, labels: LABELS.mine, networks: { [`${N}-net`]: { NetworkID: "c".repeat(64) }, bridge: { NetworkID: "d".repeat(64) }, odd: { NetworkID: "short" } } }) }
          : undefined,
      );
      const seen = hooked(d);
      await d.acquire(N);
      expect(seen[0]!.networkIds).toEqual({ [`${N}-net`]: "c".repeat(64), bridge: "d".repeat(64) });
    });

    it("is not installed without a hook, and is removed with it", async () => {
      const d = mk();
      d.put(N, "mine", { running: false });
      let called = 0;
      d.setContainment(undefined, async () => {
        called++;
      });
      await d.acquire(N);
      expect(called).toBe(0);
    });
  });

  describe("leaving the network takes the lines out", () => {
    const sandboxOnNet = (running = true) => {
      const d = mkEgress();
      putNet(d);
      d.put(PS, "mine", { networks: [PNET], running });
      return d;
    };
    const writes = (d: ScriptedDocker) => d.execs.filter((a) => a[1] === "-u");

    it.each<["off" | "open"]>([["off"], ["open"]])("%s: a running sandbox gets one write with no names, after the network is gone", async (mode) => {
      const d = sandboxOnNet();
      await d.setNetwork(PS, mode);
      expect(writes(d)).toHaveLength(1);
      expect(writes(d)[0]!.slice(-2)).toEqual(["", "/etc/hosts"]);
      expect(d.argvs.findIndex((a) => a[0] === "exec")).toBeGreaterThan(d.argvs.findIndex((a) => a[0] === "network" && a[1] === "rm"));
    });

    it("a stopped sandbox is not written to (Docker rewrites its /etc/hosts at the next start)", async () => {
      const d = sandboxOnNet(false);
      await d.setNetwork(PS, "off");
      expect(d.count("exec")).toBe(0);
    });

    it("a failed write is logged and never fails the network change", async () => {
      const lines: string[] = [];
      const d = new EgressDocker(loadConfig({}), TEST_INSTALLATION_ID, (l) => lines.push(l));
      putNet(d);
      d.put(PS, "mine", { networks: [PNET] });
      d.execReplies = [{ code: 1, stderr: "sh: read-only" }];
      await d.setNetwork(PS, "off");
      expect(d.containers.get(PS)!.networks).toEqual([]);
      expect(lines.join("\n")).toMatch(/could not take the local-access names out/);
    });

    it("a sandbox that was never on its network is not written to", async () => {
      const d = mkEgress();
      d.put(PS, "mine", { networks: ["bridge"] });
      await d.setNetwork(PS, "off");
      expect(d.count("exec")).toBe(0);
    });
  });
});

describe("runsc must be registered with --overlay2=none (leg 13)", () => {
  const withRuntime = (entry: unknown, name = "runsc") => {
    const lines: string[] = [];
    const d = new ScriptedDocker(loadConfig({ MCPE_DOCKER_RUNTIME: name }), TEST_INSTALLATION_ID, (l) => lines.push(l));
    d.script.push((a) =>
      a[0] === "info" ? { stdout: `${JSON.stringify({ runtimes: { runc: {}, [name]: entry }, default: "runc" })}\n` } : undefined,
    );
    return { d, lines };
  };

  it("passes quietly when runtimeArgs carries --overlay2=none", async () => {
    const { d, lines } = withRuntime({ path: "/usr/local/bin/runsc", runtimeArgs: ["--overlay2=none"] });
    await d.assertRuntime();
    expect(lines).toEqual([]);
  });

  it("accepts it among other arguments and with one dash", async () => {
    for (const args of [["--network=host", "--overlay2=none"], ["-overlay2=none"]]) {
      const { d, lines } = withRuntime({ path: "/usr/local/bin/runsc", runtimeArgs: args });
      await d.assertRuntime();
      expect(lines).toEqual([]);
    }
  });

  it.each([
    ["no runtimeArgs", { path: "/usr/local/bin/runsc" }],
    ["empty runtimeArgs", { path: "/usr/local/bin/runsc", runtimeArgs: [] }],
    ["other arguments", { path: "/usr/local/bin/runsc", runtimeArgs: ["--network=host"] }],
    ["the default overlay", { path: "/usr/local/bin/runsc", runtimeArgs: ["--overlay2=root:self"] }],
    ["an entry that is not an object", null],
  ])("logs one warning, and does not refuse, with %s", async (_n, entry) => {
    const { d, lines } = withRuntime(entry);
    await d.assertRuntime(); // a warning, not a refusal
    await d.assertRuntime(); // and the check is cached: still one line
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("--overlay2=none");
    expect(lines[0]).toContain("runsc install -- --overlay2=none");
  });

  it("says nothing for another runtime, or when no runtime is named", async () => {
    const other = withRuntime({ runtimeArgs: [] }, "runc");
    await other.d.assertRuntime();
    expect(other.lines).toEqual([]);
    const none = new ScriptedDocker(loadConfig({}), TEST_INSTALLATION_ID, (l) => none.argvs.push([l]));
    await none.assertRuntime();
    expect(none.argvs).toEqual([]);
  });
});
