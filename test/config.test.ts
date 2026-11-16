import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

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
