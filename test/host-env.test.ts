import { describe, expect, it } from "vitest";
import { hostVariableNames, launchVariables, ownedVariables } from "../src/proxy/host-env.js";

describe("host variables: matching", () => {
  it("returns the project's variables, unprefixed", () => {
    expect(launchVariables("mcp_booking", ["mcp_booking"], { mcp_booking__API_KEY: "x" })).toEqual({ API_KEY: "x" });
  });

  it.each([
    ["upper-cased slug", { MCP_BOOKING__API_KEY: "x" }],
    ["one underscore", { mcp_booking_API_KEY: "x" }],
    ["something before the slug", { xmcp_booking__API_KEY: "x" }],
    ["no separator at all", { mcp_bookingAPI_KEY: "x" }],
    ["unrelated names with __", { npm_config__x: "x" }],
  ])("matches exactly and case-sensitively: %s", (_label, env) => {
    expect(launchVariables("mcp_booking", ["mcp_booking"], env)).toEqual({});
    expect(hostVariableNames("mcp_booking", ["mcp_booking"], env)).toEqual([]);
  });

  it.each([
    [["a", "a__b"]],
    [["a__b", "a"]],
  ])("gives a variable to the project with the longest matching slug, whatever the order: %j", (slugs) => {
    const env = { a__b__KEY: "v" };
    expect(launchVariables("a__b", slugs, env)).toEqual({ KEY: "v" });
    expect(launchVariables("a", slugs, env)).toEqual({});
    expect(hostVariableNames("a", slugs, env)).toEqual([]);
  });

  it("gives a__b__KEY to a as b__KEY when only a is known", () => {
    expect(launchVariables("a", ["a"], { a__b__KEY: "v" })).toEqual({ b__KEY: "v" });
  });

  it("always counts the project's own slug, even when the list lacks it", () => {
    expect(launchVariables("a", [], { a__KEY: "v" })).toEqual({ KEY: "v" });
    expect(launchVariables("a__b", ["a"], { a__b__KEY: "v" })).toEqual({ KEY: "v" });
  });

  it.each([
    ["empty remainder", "a__b__"],
    ["remainder starting with a digit", "a__b__1X"],
    ["remainder with a dash", "a__b__X-Y"],
    ["remainder longer than the name pattern allows", `a__b__${"X".repeat(102)}`],
  ])("returns a variable with an invalid name for nobody, and does not throw: %s", (_label, key) => {
    const env = { [key]: "line\nbreak" };
    for (const slugs of [["a", "a__b"], ["a__b", "a"]]) {
      for (const slug of ["a", "a__b"]) {
        expect(() => launchVariables(slug, slugs, env)).not.toThrow();
        expect(launchVariables(slug, slugs, env)).toEqual({});
        expect(hostVariableNames(slug, slugs, env)).toEqual([]);
      }
    }
  });

  it("returns an empty value as an empty string and ignores undefined", () => {
    expect(launchVariables("a", ["a"], { a__EMPTY: "", a__GONE: undefined })).toEqual({ EMPTY: "" });
    expect(hostVariableNames("a", ["a"], { a__EMPTY: "", a__GONE: undefined })).toEqual(["EMPTY"]);
  });

  it("passes a name such as PATH or __proto__ like any other", () => {
    const out = launchVariables("a", ["a"], { a__PATH: "/x", a____proto__: "p" });
    expect(out.PATH).toBe("/x");
    expect(Object.keys(out)).toEqual(["PATH", "__proto__"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  it("reads nothing but its arguments", () => {
    // An empty object means no variables: the ambient process environment is not consulted.
    expect(ownedVariables("a", ["a"], {})).toEqual([]);
    expect(launchVariables("a", ["a"], {})).toEqual({});
  });
});

describe("host variables: unusable values", () => {
  it.each([
    ["line feed", "abc\ndef-SECRET-1"],
    ["carriage return", "abc\rdef-SECRET-1"],
    ["NUL", "abc\u0000def-SECRET-1"],
  ])("a value with a %s in an owned variable throws an Error that names the variable and not the value", (_label, value) => {
    let caught: unknown;
    try {
      launchVariables("mcp_x", ["mcp_x"], { mcp_x__TOKEN: value });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(caught)).toBe(Error.prototype);
    const message = (caught as Error).message;
    expect(message).toContain("mcp_x__TOKEN");
    expect(message).not.toContain("abc");
    expect(message).not.toContain("SECRET-1");
  });

  it("does not judge the value of a variable that belongs to another project", () => {
    expect(launchVariables("a", ["a", "b"], { a__OK: "1", b__BAD: "x\ny" })).toEqual({ OK: "1" });
  });

  it("still lists the name of a variable whose value is unusable", () => {
    expect(hostVariableNames("a", ["a"], { a__TOKEN: "x\ny" })).toEqual(["TOKEN"]);
  });
});
