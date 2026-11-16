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
