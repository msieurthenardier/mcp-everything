import { describe, expect, it } from "vitest";
import { buildInvocation, resolveCwd, ToolInputError } from "../src/toolgen/invoke.js";
import type { OptionSpec, ToolDef } from "../src/types.js";

const opt = (o: Partial<OptionSpec> & { prop: string; flag: string }): OptionSpec => ({ takesValue: false, description: "", ...o });

const tool: ToolDef = {
  name: "p__tool_sub",
  description: "",
  inputSchema: {},
  kind: "cli",
  argv: ["tool", "sub"],
  cwd: "/workspace/work",
  options: [
    opt({ prop: "verbose", flag: "--verbose" }),
    opt({ prop: "output", flag: "--output", takesValue: true }),
    opt({ prop: "color", flag: "--color", takesValue: true, optionalValue: true, choices: ["auto", "never"] }),
    opt({ prop: "n", flag: "-n", takesValue: true }),
  ],
};

describe("buildInvocation", () => {
  it("emits flags, values, then positional args, in argv slots", () => {
    const inv = buildInvocation(tool, { verbose: true, output: "out file.txt", n: 3, args: ["a", "--raw", "b; rm -rf /"] });
    expect(inv.argv).toEqual(["tool", "sub", "--verbose", "--output", "out file.txt", "-n", "3", "a", "--raw", "b; rm -rf /"]);
    expect(inv.cwd).toBe("/workspace/work");
  });

  it("skips false/null/undefined options", () => {
    expect(buildInvocation(tool, { verbose: false, output: null }).argv).toEqual(["tool", "sub"]);
  });

  it("uses --flag=value for optional-value options and validates choices", () => {
    expect(buildInvocation(tool, { color: "never" }).argv).toEqual(["tool", "sub", "--color=never"]);
    expect(buildInvocation(tool, { color: true }).argv).toEqual(["tool", "sub", "--color"]);
    expect(() => buildInvocation(tool, { color: "purple" })).toThrow(/one of: auto, never/);
  });

  it("repeats a flag for array values", () => {
    expect(buildInvocation(tool, { output: ["a", "b"] }).argv).toEqual(["tool", "sub", "--output", "a", "--output", "b"]);
  });

  it("rejects unknown arguments and wrong types with a helpful message", () => {
    expect(() => buildInvocation(tool, { nope: 1 })).toThrow(/Unknown argument\(s\): nope\. Valid arguments: .*verbose/);
    expect(() => buildInvocation(tool, { verbose: "yes" })).toThrow(ToolInputError);
    expect(() => buildInvocation(tool, { output: { a: 1 } })).toThrow(ToolInputError);
    expect(() => buildInvocation(tool, { args: "ok" })).not.toThrow();
    expect(() => buildInvocation(tool, { args: [{}] })).toThrow(ToolInputError);
    expect(() => buildInvocation(tool, { stdin: 5 })).toThrow(ToolInputError);
    expect(() => buildInvocation(tool, { timeout_seconds: -1 })).toThrow(ToolInputError);
  });

  it("passes stdin and caps timeouts", () => {
    const inv = buildInvocation(tool, { stdin: "data", timeout_seconds: 999999 });
    expect(inv.stdin).toBe("data");
    expect(inv.timeoutSec).toBe(3600);
  });

  it("appends the code or script value before args", () => {
    const code: ToolDef = { ...tool, kind: "code", argv: ["python", "-c"], options: [], valueProp: "code" };
    expect(buildInvocation(code, { code: "print(1)", args: ["x"] }).argv).toEqual(["python", "-c", "print(1)", "x"]);
    expect(() => buildInvocation(code, {})).toThrow(/code is required/);

    const script: ToolDef = {
      ...tool,
      kind: "script",
      argv: ["npm", "run"],
      options: [],
      valueProp: "script",
      inputSchema: { properties: { script: { enum: ["build", "test"] } } },
    };
    expect(buildInvocation(script, { script: "test", args: ["--", "-t", "x"] }).argv).toEqual(["npm", "run", "test", "--", "-t", "x"]);
    expect(() => buildInvocation(script, { script: "postinstall" })).toThrow(/one of: build, test/);
  });
});

describe("resolveCwd", () => {
  it("resolves relative paths against the scratch dir and confines to /workspace", () => {
    expect(resolveCwd(undefined, "/workspace/repo")).toBe("/workspace/repo");
    expect(resolveCwd("sub/dir", "/x")).toBe("/workspace/work/sub/dir");
    expect(resolveCwd("/workspace/repo/src", "/x")).toBe("/workspace/repo/src");
    expect(resolveCwd("..", "/x")).toBe("/workspace");
    expect(() => resolveCwd("../..", "/x")).toThrow(/inside \/workspace/);
    expect(() => resolveCwd("/etc", "/x")).toThrow(/inside \/workspace/);
    expect(() => resolveCwd("/workspacefoo", "/x")).toThrow(/inside \/workspace/);
    expect(() => resolveCwd(5, "/x")).toThrow(ToolInputError);
  });
});
