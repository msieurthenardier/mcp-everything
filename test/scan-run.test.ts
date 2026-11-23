import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENV_FILE_NAME } from "../src/proxy/mcp-proxy.js";
import type { OneShotResult } from "../src/sandbox/docker-base.js";
import { VolumeNotUsableError } from "../src/sandbox/errors.js";
import { SandboxRefusedError } from "../src/sandbox/ownership.js";
import { runScanners, type ScanDocker } from "../src/scan/run.js";
import type { ScannerSpec } from "../src/scan/types.js";
import type { RunResult } from "../src/util/exec.js";

const sarif = (results: unknown[]) => JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "x" } }, results }] });
const ok = (stdout: string, extra: Partial<RunResult> = {}): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false, truncated: false, ...extra });
const spec = (over: Partial<ScannerSpec> = {}): ScannerSpec => ({ name: "sc", image: "img:1", command: ["go"], network: false, hosts: [], timeoutSec: 60, env: [], ...over });

class Fake implements ScanDocker {
  clock = 0;
  pulls: Array<{ image: string; timeoutMs: number | undefined }> = [];
  runs: Array<{ volume: string; spec: ScannerSpec; timeoutMs: number; envFile?: string; fileText?: string; mode?: number }> = [];
  pullCost = 0;
  pull: (image: string) => Promise<void> = async () => undefined;
  run: (s: ScannerSpec, n: number) => Promise<OneShotResult> | OneShotResult = () => ok(sarif([]));
  async ensureImage(image: string, _o?: unknown, t?: number): Promise<void> {
    this.pulls.push({ image, timeoutMs: t });
    this.clock += this.pullCost;
    await this.pull(image);
  }
  async runScanner(volume: string, s: ScannerSpec, o: { timeoutMs: number; envFile?: string }): Promise<OneShotResult> {
    const rec: Fake["runs"][number] = { volume, spec: s, ...o };
    if (o.envFile) {
      rec.fileText = fs.readFileSync(o.envFile, "utf8");
      rec.mode = fs.statSync(o.envFile).mode & 0o777;
    }
    this.runs.push(rec);
    return this.run(s, this.runs.length);
  }
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-run-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const go = (d: Fake, specs: ScannerSpec[], over: Partial<Parameters<typeof runScanners>[3]> = {}) =>
  runScanners(d, "vol", specs, { totalTimeoutSec: 600, dataDir: dir, now: () => d.clock, env: {}, ...over });
const tmpFiles = () => (fs.existsSync(path.join(dir, "tmp")) ? fs.readdirSync(path.join(dir, "tmp")) : []);

describe("runScanners", () => {
  it("returns [] and starts nothing for no scanners", async () => {
    const d = new Fake();
    expect(await go(d, [])).toEqual([]);
    expect(d.pulls).toEqual([]);
  });

  it("runs one at a time, in order, and turns a SARIF run into counts and findings; the exit code is ignored", async () => {
    const d = new Fake();
    let busy = 0;
    d.run = async (s) => {
      expect(++busy).toBe(1);
      await new Promise((r) => setTimeout(r, 5));
      busy--;
      return ok(sarif([{ level: "error", ruleId: "r1", message: { text: `found by ${s.name}` } }, { level: "note", message: { text: "n" } }]), { code: 3 });
    };
    const out = await go(d, [spec({ name: "a" }), spec({ name: "b" })]);
    expect(out.map((o) => [o.name, o.kind, o.status])).toEqual([["a", "scanner", "ran"], ["b", "scanner", "ran"]]);
    expect(out[0]!.counts).toEqual({ error: 1, warning: 0, note: 1 });
    expect(out[0]!.findings[0]).toMatchObject({ check: "a", ruleId: "r1", message: "found by a" });
    expect(d.runs.map((r) => r.spec.name)).toEqual(["a", "b"]);
    expect(d.runs[0]!.volume).toBe("vol");
  });

  it("fails a run that timed out, was cut off, or printed something that is not SARIF, with the stderr tail", async () => {
    const d = new Fake();
    const replies = [
      ok("", { timedOut: true, code: null as unknown as number }),
      ok("x".repeat(10), { truncated: true, stderr: "partial" }),
      ok("garbage", { stderr: "line one\n  line two\u001b[31m" }),
      ok(JSON.stringify({ version: "1.0" })),
    ];
    d.run = (_s, n) => replies[n - 1]!;
    const out = await go(d, [spec({ timeoutSec: 30 }), spec(), spec(), spec()]);
    expect(out.map((o) => o.status)).toEqual(["failed", "failed", "failed", "failed"]);
    expect(out[0]!.error).toBe("timed out after 30 s");
    expect(out[1]!.error).toBe("output over 8 MB: partial");
    expect(out[2]!.error).toBe("output is not valid JSON: line one line two");
    expect(out[3]!.error).toBe("output is not SARIF version 2.1.0");
    for (const o of out) expect(o).toMatchObject({ counts: { error: 0, warning: 0, note: 0 }, findings: [], omitted: 0 });
  });

  it("bounds the stderr tail to its last 300 characters", async () => {
    const d = new Fake();
    d.run = () => ok("nope", { stderr: `${"a".repeat(1000)}END` });
    const [o] = await go(d, [spec()]);
    expect(o!.error).toBe(`output is not valid JSON: ${"a".repeat(297)}END`);
  });

  it("fails a scanner whose image cannot be pulled with fixed text, and goes on", async () => {
    const d = new Fake();
    d.pull = async (image) => {
      if (image === "bad:1") throw new Error("Failed to pull image: unauthorized: token abc123 ...");
    };
    const out = await go(d, [spec({ image: "bad:1" }), spec({ name: "next" })]);
    expect(out[0]).toMatchObject({ status: "failed", error: "image could not be pulled" });
    expect(out[1]!.status).toBe("ran");
    expect(d.runs.map((r) => r.spec.name)).toEqual(["next"]);
  });

  it("fails only the scanner Docker did not answer for; a refusal or an unusable volume aborts the whole run", async () => {
    const d = new Fake();
    d.run = (s) => {
      if (s.name === "a") throw new Error("Could not create the scan container: boom with a secret-ish detail");
      return ok(sarif([]));
    };
    const out = await go(d, [spec({ name: "a" }), spec({ name: "b" })]);
    expect(out[0]).toMatchObject({ status: "failed", error: "Docker did not answer" });
    expect(out[1]!.status).toBe("ran");

    for (const e of [
      new SandboxRefusedError([{ kind: "volume", sandbox: "vol", cls: "another", owner: "deadbeef" }], "0123abcd"),
      new VolumeNotUsableError("Volume vol is not a staging volume"),
    ]) {
      const r = new Fake();
      r.run = () => {
        throw e;
      };
      await expect(go(r, [spec({ name: "a" }), spec({ name: "b" })])).rejects.toBe(e);
      expect(r.runs).toHaveLength(1);
    }
  });

  describe("time", () => {
    it("gives the pull what is left of the budget and the scanner the smaller of its timeout and what is then left", async () => {
      const d = new Fake();
      d.pullCost = 100_000;
      const out = await go(d, [spec({ name: "a", timeoutSec: 500 }), spec({ name: "b", timeoutSec: 60 })], { totalTimeoutSec: 300 });
      expect(d.pulls.map((p) => p.timeoutMs)).toEqual([300_000, 200_000]);
      // a: after its pull 200 s are left (< its 500 s); b: 100 s left after its pull (more than its 60 s).
      expect(d.runs.map((r) => r.timeoutMs)).toEqual([200_000, 60_000]);
      expect(out.map((o) => o.status)).toEqual(["ran", "ran"]);
    });

    it("does not start one that would get under 10 s, and reports it and every later one not-run", async () => {
      const d = new Fake();
      d.pullCost = 95_000;
      const out = await go(d, [spec({ name: "a" }), spec({ name: "b" }), spec({ name: "c" })], { totalTimeoutSec: 100 });
      // a: 5 s left after its pull: not started. b and c: not even pulled.
      expect(out.map((o) => o.status)).toEqual(["not-run", "not-run", "not-run"]);
      for (const o of out) expect(o.error).toBe("no time left in the scan budget");
      expect(d.runs).toEqual([]);
      expect(d.pulls).toHaveLength(1);
    });

    it("a budget spent by an earlier run leaves the later ones not-run", async () => {
      const d = new Fake();
      d.run = (s) => {
        d.clock += 95_000;
        return ok(sarif([]));
      };
      const out = await go(d, [spec({ name: "a" }), spec({ name: "b" })], { totalTimeoutSec: 100 });
      expect(out.map((o) => o.status)).toEqual(["ran", "not-run"]);
      expect(d.pulls).toHaveLength(1);
    });
  });

  describe("credentials", () => {
    it("reads the named variables from the given environment, writes a 0600 file with the proxy's name shape, and removes it afterwards", async () => {
      const d = new Fake();
      const out = await go(d, [spec({ env: ["A_TOKEN", "EMPTY"] })], { env: { A_TOKEN: "tok-value", EMPTY: "", OTHER: "x" } });
      expect(out[0]!.status).toBe("ran");
      const r = d.runs[0]!;
      expect(path.basename(r.envFile!)).toMatch(ENV_FILE_NAME);
      expect(path.dirname(r.envFile!)).toBe(path.join(dir, "tmp"));
      expect(r.fileText).toBe("A_TOKEN=tok-value\nEMPTY=\n");
      expect(r.mode).toBe(0o600);
      expect(fs.statSync(path.join(dir, "tmp")).mode & 0o777).toBe(0o700);
      expect(tmpFiles()).toEqual([]);
    });

    it("passes no file when the scanner names no variables", async () => {
      const d = new Fake();
      await go(d, [spec()]);
      expect(d.runs[0]!.envFile).toBeUndefined();
      expect(tmpFiles()).toEqual([]);
    });

    it("removes the file when the run fails, throws, or the scanner is refused", async () => {
      for (const behave of [() => ok("garbage"), () => { throw new Error("x"); }, () => { throw new VolumeNotUsableError("v"); }]) {
        const d = new Fake();
        d.run = behave;
        await go(d, [spec({ env: ["T"] })], { env: { T: "abcd1234" } }).catch(() => undefined);
        expect(tmpFiles()).toEqual([]);
      }
    });

    it("fails, naming the variable and never a value, for one that is unset or that validateEnv rejects, and still runs the next", async () => {
      const d = new Fake();
      const out = await go(d, [spec({ name: "a", env: ["NOPE"] }), spec({ name: "b", env: ["MULTI"] }), spec({ name: "c" })], { env: { MULTI: "line1\nsecret-line2" } });
      expect(out[0]).toMatchObject({ status: "failed", error: "environment variable NOPE is not set" });
      expect(out[1]).toMatchObject({ status: "failed", error: "environment variable MULTI cannot be passed to a scanner" });
      expect(JSON.stringify(out)).not.toContain("secret-line2");
      expect(out[2]!.status).toBe("ran");
      expect(d.runs.map((r) => r.spec.name)).toEqual(["c"]);
      expect(d.pulls).toHaveLength(1);
    });

    it("fails with fixed text when the file cannot be written (the data directory is a file), and runs nothing", async () => {
      const d = new Fake();
      fs.writeFileSync(path.join(dir, "tmp"), "in the way");
      const out = await go(d, [spec({ env: ["T"] })], { env: { T: "abcd1234" } });
      expect(out[0]).toMatchObject({ status: "failed", error: "the credentials file for the scanner could not be written" });
      expect(d.runs).toEqual([]);
    });

    it("redacts every value given to the scanner from the error, the findings and the notes", async () => {
      const d = new Fake();
      const secret = "s3cr3t-value";
      d.run = (_s, n) =>
        n === 1
          ? ok("not sarif", { stderr: `auth failed for ${secret}\nretry with ${secret}` })
          : ok(
              sarif([
                { level: "error", ruleId: `rule-${secret}`, message: { text: `leaked ${secret} here` }, locations: [{ physicalLocation: { artifactLocation: { uri: `f/${secret}.txt` }, region: { startLine: 3 } } }] },
                { level: "warning", suppressions: [{ status: "accepted" }], message: { text: "x" } },
              ]),
              { stderr: secret },
            );
      const out = await go(d, [spec({ name: "a", env: ["TOKEN"] }), spec({ name: "b", env: ["TOKEN"] })], { env: { TOKEN: secret } });
      expect(JSON.stringify(out)).not.toContain(secret);
      expect(out[0]!.error).toBe("output is not valid JSON: auth failed for [redacted] retry with [redacted]");
      expect(out[1]!.findings[0]).toMatchObject({ message: "leaked [redacted] here", location: "f/[redacted].txt:3", ruleId: "rule-[redacted]" });
    });

    it("redacts a value split by the tail's cut, and does not redact values shorter than 4 characters", async () => {
      const d = new Fake();
      const secret = "0123456789abcdef";
      d.run = () => ok("x", { stderr: `${"p".repeat(290)}${secret}` });
      const [o] = await go(d, [spec({ env: ["T", "SHORT"] })], { env: { T: secret, SHORT: "abc" } });
      expect(o!.error).not.toContain("0123");
      expect(o!.error).toContain("[redacted]");
      const d2 = new Fake();
      d2.run = () => ok("x", { stderr: "abc abc" });
      const [o2] = await go(d2, [spec({ env: ["SHORT"] })], { env: { SHORT: "abc" } });
      expect(o2!.error).toBe("output is not valid JSON: abc abc");
    });
  });

  // Leg 8: a scanner behind containment's proxy; what the proxy refused is added to a FAILED outcome only.
  describe("what the scanner's proxy refused", () => {
    const row = (host: string | null, port: number | null = 443, reason = "not-allowed") => ({
      kind: "connect" as const, host, port, reason: reason as "not-allowed", count: 1, firstAt: "t", lastAt: "t",
    });
    const report = (...rows: ReturnType<typeof row>[]) => ({ rows, total: rows.length, resolverFailures: 0 });
    const withProxy = (r: RunResult, ...rows: ReturnType<typeof row>[]): OneShotResult => ({ ...r, proxy: report(...rows) });

    it("adds a line per refused host to a failed run's error, after the stderr tail", async () => {
      const d = new Fake();
      d.run = () => withProxy(ok("garbage", { stderr: "dial tcp: refused" }), row("api.example.com", 8443), row("other.example"));
      const [o] = await go(d, [spec({ network: true, hosts: ["x.example"] })]);
      expect(o!.status).toBe("failed");
      expect(o!.error).toContain("output is not valid JSON: dial tcp: refused");
      expect(o!.error).toContain("The scanner was refused `api.example.com:8443`. Only the operator can allow a host for a scanner, in its \"hosts\" in the scanners file.");
      expect(o!.error).toContain("`other.example:443`");
      expect(o!.error!.indexOf("dial tcp")).toBeLessThan(o!.error!.indexOf("api.example.com"));
    });

    it("also on a timeout and on an output over 8 MB", async () => {
      const d = new Fake();
      const replies = [ok("", { timedOut: true, code: null as unknown as number }), ok("x", { truncated: true })];
      d.run = (_s, n) => withProxy(replies[n - 1]!, row("h.example"));
      const out = await go(d, [spec({ name: "a" }), spec({ name: "b" })]);
      expect(out.map((o) => o.status)).toEqual(["failed", "failed"]);
      expect(out[0]!.error).toMatch(/^timed out after 60 s .*`h\.example:443`/);
      expect(out[1]!.error).toMatch(/^output over 8 MB .*`h\.example:443`/);
    });

    it("never adds them to a run that produced valid output", async () => {
      const d = new Fake();
      d.run = () => withProxy(ok(sarif([{ level: "note", message: { text: "n" } }])), row("h.example"));
      const [o] = await go(d, [spec()]);
      expect(o).toMatchObject({ status: "ran" });
      expect(o!.error).toBeUndefined();
      expect(JSON.stringify(o)).not.toContain("h.example");
    });

    it("a failed run with no report, an unavailable one or no rows keeps today's exact text", async () => {
      const d = new Fake();
      const replies: OneShotResult[] = [ok("garbage"), { ...ok("garbage"), proxy: { unavailable: true } }, withProxy(ok("garbage"))];
      d.run = (_s, n) => replies[n - 1]!;
      const out = await go(d, [spec({ name: "a" }), spec({ name: "b" }), spec({ name: "c" })]);
      expect(new Set(out.map((o) => o.error)).size).toBe(1);
      expect(out[0]!.error).toBe("output is not valid JSON");
    });

    it("keeps the error bounded however many hosts were refused, and redacts the scanner's values from it", async () => {
      const d = new Fake();
      const secret = "0123456789abcdef";
      d.run = () => withProxy(ok("x", { stderr: `token ${secret}` }), ...Array.from({ length: 30 }, (_, n) => row(`h${n}.example.com`)));
      const [o] = await go(d, [spec({ env: ["T"] })], { env: { T: secret } });
      expect(o!.error!.length).toBeLessThanOrEqual(2_000);
      expect(o!.error).not.toContain(secret);
      expect(o!.error).toContain("and 21 more.");
    });
  });
});
