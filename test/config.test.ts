import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ConfigError } from "../src/errors.js";

describe("sandboxIdleSec", () => {
  const idle = (v?: string) => loadConfig(v === undefined ? {} : { MCPE_SANDBOX_IDLE_TIMEOUT: v }).sandboxIdleSec;

  it("defaults to 30 minutes", () => expect(idle()).toBe(1800));
  it("accepts an override and 0", () => {
    expect(idle("45")).toBe(45);
    expect(idle("0")).toBe(0);
  });
  it.each(["-5", "abc", ""])("falls back for %j", (v) => expect(idle(v)).toBe(1800));
  it.each([
    ["45abc", 45],
    ["1.5", 1],
  ])("parses leading digits of %j like the other numeric settings", (v, expected) => expect(idle(v)).toBe(expected));
  it("leaves other settings alone", () => {
    expect(loadConfig({ MCPE_PIDS_LIMIT: "0" }).docker.pidsLimit).toBe(1024);
    expect(loadConfig({ MCPE_MCP_IDLE_TIMEOUT: "0" }).mcpIdleSec).toBe(600);
  });
});

describe("namePrefix", () => {
  const prefix = (v?: string) => loadConfig(v === undefined ? {} : { MCPE_NAME_PREFIX: v }).docker.namePrefix;

  it("defaults to mcpe- when unset or empty", () => {
    expect(prefix()).toBe("mcpe-");
    expect(prefix("")).toBe("mcpe-");
  });
  it("keeps a valid prefix", () => {
    expect(prefix("work-")).toBe("work-");
    expect(prefix("a")).toBe("a");
  });
  it.each(["Work-", "-work", "has space", "a".repeat(32), "wörk"])("refuses %j, naming the variable and the allowed form", (v) => {
    expect(() => prefix(v)).toThrow(/MCPE_NAME_PREFIX.*\[a-z0-9_.-\]/);
  });
});

describe("memory and cpus limits", () => {
  const mem = (v?: string) => loadConfig(v === undefined ? {} : { MCPE_MEMORY: v }).docker.memory;
  const cpus = (v?: string) => loadConfig(v === undefined ? {} : { MCPE_CPUS: v }).docker.cpus;

  it("defaults to 4g and 2", () => {
    expect(mem()).toBe("4g");
    expect(cpus()).toBe("2");
  });
  it("keeps other values as given", () => {
    expect(mem("8g")).toBe("8g");
    expect(mem("512m")).toBe("512m");
    expect(cpus("1.5")).toBe("1.5");
  });
  it.each(["0", "0.0", "0g", "0m", "00", "0.0g", "0G", "0 g", "0GiB", "0MiB", "0gb", ".0", "+0", "-0", "0e0", "0_0", "0 GiB", "0tb", "0b"])("treats MCPE_MEMORY=%j (unlimited to Docker) as unset", (v) =>
    expect(mem(v)).toBe("4g"));
  it.each(["0", "0.0", "0.00", ".0", "00", "-0", "+0", "0e0", "0/1", "0/5", "0x0", "0_0"])("treats MCPE_CPUS=%j (unlimited to Docker) as unset", (v) =>
    expect(cpus(v)).toBe("2"));
  it.each(["0.5", "0.5g", "10g", "100m", "1e0", "0Gi", "0/0"])("passes MCPE_MEMORY / MCPE_CPUS=%j through when Docker reads it as non-zero or rejects it", (v) => {
    expect(mem(v)).toBe(v);
    expect(cpus(v)).toBe(v);
  });
  // Matching must stay linear (no ambiguous adjacent quantifiers). A time bound
  // is used, a generous 2000 ms against ~0 ms measured (the old patterns took
  // seconds), so a slow machine cannot flake it.
  it("matches a very long run of zeros in linear time and still decides correctly", () => {
    const zeros = "0".repeat(100_000);
    for (const v of [zeros + "x", zeros + ".0x", zeros + "e"]) {
      const t = Date.now();
      expect(mem(v)).toBe(v);
      expect(cpus(v)).toBe(v);
      expect(Date.now() - t).toBeLessThan(2000);
    }
    expect(mem(zeros)).toBe("4g");
    expect(cpus(zeros)).toBe("2");
  });
});

describe("configuration errors are ConfigError", () => {
  it.each([
    ["MCPE_NAME_PREFIX", { MCPE_NAME_PREFIX: "Bad-" }],
    ["MCPE_EXTRA_HOSTS host", { MCPE_EXTRA_HOSTS: "not a host=github" }],
    ["MCPE_EXTRA_HOSTS forge", { MCPE_EXTRA_HOSTS: "git.example.com=svn" }],
  ])("%s", (_n, env) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });
});

describe("scan settings", () => {
  const scan = (env: Record<string, string>, text = '{"scanners":[]}') => loadConfig(env, () => text).scan;

  it("defaults to off, error, 900 and no scanners", () => {
    expect(scan({})).toEqual({ mode: "off", blockAt: "error", timeoutSec: 900, scanners: [] });
    expect(scan({ MCPE_SCAN: "", MCPE_SCAN_BLOCK_AT: "", MCPE_SCAN_TIMEOUT: "", MCPE_SCANNERS: "" }).mode).toBe("off");
  });
  it.each([
    ["off", "off"],
    ["on", "warn"],
    ["warn", "warn"],
    ["block", "block"],
    [" ON ", "warn"],
    ["Block", "block"],
  ])("MCPE_SCAN=%j gives %s", (v, mode) => expect(scan({ MCPE_SCAN: v }).mode).toBe(mode));
  it.each(["yes", "1", "true", "blok"])("refuses MCPE_SCAN=%j naming the variable and the values", (v) => {
    expect(() => scan({ MCPE_SCAN: v })).toThrow(/MCPE_SCAN=.*off, on, warn or block/);
    expect(() => scan({ MCPE_SCAN: v })).toThrow(ConfigError);
  });

  it("accepts MCPE_SCAN_BLOCK_AT with block, trimmed and case-insensitive", () => {
    expect(scan({ MCPE_SCAN: "block", MCPE_SCAN_BLOCK_AT: " Warning " }).blockAt).toBe("warning");
    expect(scan({ MCPE_SCAN: "block", MCPE_SCAN_BLOCK_AT: "NOTE" }).blockAt).toBe("note");
    expect(scan({ MCPE_SCAN: "block" }).blockAt).toBe("error");
    expect(scan({ MCPE_SCAN: "warn", MCPE_SCAN_BLOCK_AT: "" }).blockAt).toBe("error");
  });
  it.each(["off", "warn", "on", ""])("refuses MCPE_SCAN_BLOCK_AT set under MCPE_SCAN=%j", (mode) => {
    expect(() => scan({ MCPE_SCAN: mode, MCPE_SCAN_BLOCK_AT: "warning" })).toThrow(/only with MCPE_SCAN=block/);
  });
  it("refuses an invalid MCPE_SCAN_BLOCK_AT", () => {
    expect(() => scan({ MCPE_SCAN: "block", MCPE_SCAN_BLOCK_AT: "critical" })).toThrow(/MCPE_SCAN_BLOCK_AT.*error, warning or note/);
  });

  it("accepts MCPE_SCAN_TIMEOUT from 60 to 3600", () => {
    expect(scan({ MCPE_SCAN_TIMEOUT: "60" }).timeoutSec).toBe(60);
    expect(scan({ MCPE_SCAN_TIMEOUT: "3600" }).timeoutSec).toBe(3600);
  });
  it.each(["0", "abc", "1.5", "45abc", "59", "3601", "-60", " 60", "60 ", "1e3"])("refuses MCPE_SCAN_TIMEOUT=%j", (v) => {
    expect(() => scan({ MCPE_SCAN_TIMEOUT: v })).toThrow(/MCPE_SCAN_TIMEOUT/);
  });

  it("reads and validates the scanners file, allowed with MCPE_SCAN=off", () => {
    const text = JSON.stringify({ scanners: [{ name: "trivy", image: "aquasec/trivy:0.50", command: ["trivy", "fs", "/workspace/repo"] }] });
    let asked = "";
    const cfg = loadConfig({ MCPE_SCANNERS: "/etc/scanners.json" }, (p) => ((asked = p), text)).scan;
    expect(asked).toBe("/etc/scanners.json");
    expect(cfg.mode).toBe("off");
    expect(cfg.scannersFile).toBe("/etc/scanners.json");
    expect(cfg.scanners).toEqual([
      { name: "trivy", image: "aquasec/trivy:0.50", command: ["trivy", "fs", "/workspace/repo"], network: false, timeoutSec: 300, env: [] },
    ]);
  });
  it("names the file for an invalid scanners file, an unreadable one and an oversized one", () => {
    expect(() => scan({ MCPE_SCANNERS: "/x/s.json" }, "nope")).toThrow(/\/x\/s\.json.*not valid JSON/);
    expect(() => scan({ MCPE_SCANNERS: "/x/s.json" }, '{"scanners":[{}]}')).toThrow(/\/x\/s\.json.*scanners\[0\]/);
    expect(() =>
      loadConfig({ MCPE_SCANNERS: "/x/s.json" }, () => {
        throw Object.assign(new Error("boom"), { code: "ENOENT" });
      }),
    ).toThrow(/\/x\/s\.json.*ENOENT/);
    expect(() => scan({ MCPE_SCANNERS: "/x/s.json" }, " ".repeat(1_000_001))).toThrow(/\/x\/s\.json.*larger/);
  });
  it("refuses a directory, a FIFO and a missing path before reading, with the default reader", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-scan-"));
    try {
      expect(() => loadConfig({ MCPE_SCANNERS: dir })).toThrow(/not a regular file/);
      expect(() => loadConfig({ MCPE_SCANNERS: path.join(dir, "missing.json") })).toThrow(/cannot be read.*ENOENT/);
      const big = path.join(dir, "big.json");
      fs.writeFileSync(big, " ".repeat(1_000_001));
      expect(() => loadConfig({ MCPE_SCANNERS: big })).toThrow(/at most 1000000/);
      const ok = path.join(dir, "ok.json");
      fs.writeFileSync(ok, '{"scanners":[]}');
      expect(loadConfig({ MCPE_SCANNERS: ok }).scan.scanners).toEqual([]);
      expect(() => loadConfig({ MCPE_SCANNERS: "/dev/zero" })).toThrow(/not a regular file/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
