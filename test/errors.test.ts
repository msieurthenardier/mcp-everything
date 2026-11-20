import { describe, expect, it } from "vitest";
import { ConfigError, formatFatal } from "../src/errors.js";

describe("formatFatal", () => {
  it("prints a ConfigError as one line, as the first line of the stack read before", () => {
    expect(formatFatal(new ConfigError("MCPE_NAME_PREFIX=\"Bad-\" is not valid"))).toBe(
      '[mcp-everything] fatal: Error: MCPE_NAME_PREFIX="Bad-" is not valid\n',
    );
  });
  it("keeps the stack for any other error", () => {
    const out = formatFatal(new Error("boom"));
    expect(out.startsWith("[mcp-everything] fatal: Error: boom\n    at ")).toBe(true);
  });
  it("prints a non-Error thrown value as a string", () => {
    expect(formatFatal("oops")).toBe("[mcp-everything] fatal: oops\n");
  });
});
