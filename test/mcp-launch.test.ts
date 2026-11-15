import { describe, expect, it } from "vitest";
import { parseHelp } from "../src/toolgen/help-parser.js";
import { helpLaunches, manifestLaunches, type LaunchContext } from "../src/toolgen/mcp-launch.js";

const ctx = (over: Partial<LaunchContext> = {}): LaunchContext => ({
  commands: ["rea"],
  aliasOf: new Map([["rea-agents", "rea"]]),
  packages: ["rea-agents"],
  pythonModules: [],
  ...over,
});

const SERVER_JSON = JSON.stringify({
  name: "io.github.morluto/rea",
  packages: [
    {
      registryType: "npm",
      identifier: "rea-agents",
      version: "6.9.0",
      runtimeHint: "npx",
      transport: { type: "stdio" },
      packageArguments: [{ type: "positional", value: "mcp" }],
    },
  ],
});
const MCP_JSON = JSON.stringify({ mcpServers: { rea: { command: "npx", args: ["-y", "rea-agents@6.9.0", "mcp"] } } });

describe("manifestLaunches", () => {
  it("maps a registry manifest and a client config for the published package onto the local command", () => {
    expect(manifestLaunches({ serverJson: SERVER_JSON, mcpJson: MCP_JSON }, ctx())).toEqual([
      { name: "rea", argv: ["rea", "mcp"], source: "server.json" },
    ]);
    expect(manifestLaunches({ mcpJson: MCP_JSON }, ctx())).toEqual([{ name: "rea", argv: ["rea", "mcp"], source: "mcp.json" }]);
  });

  it("handles named arguments and skips non-stdio transports", () => {
    const manifest = JSON.stringify({
      packages: [
        { identifier: "tool", transport: { type: "streamable-http" }, packageArguments: [{ type: "positional", value: "http" }] },
        {
          identifier: "tool",
          packageArguments: [
            { type: "named", name: "--transport", value: "stdio" },
            { type: "named", name: "--verbose", isRequired: true },
            { type: "named", name: "--optional-thing" },
            { type: "positional", valueHint: "extra" },
          ],
        },
      ],
    });
    expect(manifestLaunches({ serverJson: manifest }, ctx({ commands: ["tool"], aliasOf: new Map(), packages: [] }))).toEqual([
      { name: "tool", argv: ["tool", "--transport", "stdio", "--verbose"], source: "server.json" },
    ]);
  });

  it("understands the common package runners", () => {
    const one = (command: string, args: string[]) =>
      manifestLaunches(
        { mcpJson: JSON.stringify({ mcpServers: { s: { command, args } } }) },
        ctx({ commands: ["mytool", "other"], aliasOf: new Map(), packages: ["@acme/mytool", "mytool"] }),
      )[0]?.argv;
    expect(one("npx", ["-y", "@acme/mytool@latest", "serve", "--stdio"])).toEqual(["mytool", "serve", "--stdio"]);
    expect(one("npx", ["--package", "@acme/mytool", "mytool", "x"])).toEqual(["mytool", "x"]);
    expect(one("uvx", ["--python", "3.12", "mytool==1.2.0"])).toEqual(["mytool"]);
    expect(one("pnpm", ["dlx", "mytool", "mcp"])).toEqual(["mytool", "mcp"]);
    expect(one("pipx", ["run", "mytool"])).toEqual(["mytool"]);
    expect(one("uv", ["tool", "run", "mytool", "a"])).toEqual(["mytool", "a"]);
    expect(one("mytool", ["--mcp"])).toEqual(["mytool", "--mcp"]);
    expect(one("/usr/local/bin/mytool", ["--mcp"])).toBeUndefined();
    expect(one("npx", ["-y", "someone-elses-server"])).toBeUndefined();
    expect(one("docker", ["run", "-i", "image"])).toBeUndefined();
  });

  it("uses the project's only command when the package is ours but named differently", () => {
    const config = JSON.stringify({ mcpServers: { x: { command: "npx", args: ["-y", "@acme/server-thing"] } } });
    const base = { aliasOf: new Map<string, string>(), packages: ["@acme/server-thing"] };
    expect(manifestLaunches({ mcpJson: config }, ctx({ ...base, commands: ["thing-cli"] }))[0]?.argv).toEqual(["thing-cli"]);
    // Two commands: which one the package means is a guess, so make none.
    expect(manifestLaunches({ mcpJson: config }, ctx({ ...base, commands: ["a", "b"] }))).toEqual([]);
    // ...unless we know which command that package installs.
    const owners = new Map([["a", "some-lib"], ["b", "@acme/server-thing"]]);
    expect(manifestLaunches({ mcpJson: config }, ctx({ ...base, commands: ["a", "b"], owners }))[0]?.argv).toEqual(["b"]);
    const both = new Map([["a", "@acme/server-thing"], ["b", "@acme/server-thing"]]);
    expect(manifestLaunches({ mcpJson: config }, ctx({ ...base, commands: ["a", "b"], owners: both }))).toEqual([]);
  });

  it("accepts interpreter launches that point into the checkout", () => {
    const one = (command: string, args: string[]) =>
      manifestLaunches(
        { dotMcpJson: JSON.stringify({ mcpServers: { local: { command, args } } }) },
        ctx({ commands: [], aliasOf: new Map(), packages: [], pythonModules: ["my_server"] }),
      )[0];
    expect(one("node", ["build/index.js"])).toEqual({ name: "local", argv: ["node", "build/index.js"], source: ".mcp.json" });
    expect(one("python3", ["-m", "my_server.main"])?.argv).toEqual(["python", "-m", "my_server.main"]);
    expect(one("python", ["server.py", "--stdio"])?.argv).toEqual(["python", "server.py", "--stdio"]);
    expect(one("python", ["-m", "some_other_module"])).toBeUndefined();
    expect(one("node", ["/etc/passwd"])).toBeUndefined();
    expect(one("node", ["../outside.js"])).toBeUndefined();
    expect(one("node", ["--inspect", "x.js"])).toBeUndefined();
  });

  it("skips entries that still contain placeholders, remote servers and malformed input", () => {
    const servers = {
      a: { command: "rea", args: ["--token", "${API_TOKEN}"] },
      b: { command: "rea", args: ["--dir", "/path/to/project"] },
      c: { command: "rea", args: ["<your-key>"] },
      d: { type: "http", url: "https://example.com/mcp" },
      e: { type: "sse", command: "rea", args: [] },
      f: { command: "rea", args: [1, 2] },
      g: "rea mcp",
    };
    expect(manifestLaunches({ mcpJson: JSON.stringify({ mcpServers: servers }) }, ctx())).toEqual([]);
    expect(manifestLaunches({ serverJson: "not json", mcpJson: "[]", dotMcpJson: undefined }, ctx())).toEqual([]);
    const required = JSON.stringify({ packages: [{ identifier: "rea-agents", packageArguments: [{ type: "positional", isRequired: true }] }] });
    expect(manifestLaunches({ serverJson: required }, ctx())).toEqual([]);
  });

  it("names servers after their config key when it is a usable identifier", () => {
    const config = JSON.stringify({ mcpServers: { "my server!": { command: "rea", args: ["mcp"] }, tidy: { command: "rea", args: ["--mcp"] } } });
    expect(manifestLaunches({ mcpJson: config }, ctx()).map((c) => c.name)).toEqual(["rea", "tidy"]);
  });
});

describe("helpLaunches", () => {
  it("prefers an explicit --mcp flag and distrusts an `mcp` subcommand that manages registrations", () => {
    const help = parseHelp(`rea — Reverse engineer anything.

Usage: rea <command>

Commands:
  analyze      Get an overview of an app
  mcp          Register as MCP server (add, doctor)

Options:
  --mcp        Start as MCP stdio server
  --format <f> Output format
`);
    expect(helpLaunches("rea", help)).toEqual([["rea", "--mcp"], ["rea", "mcp"]]);
  });

  it("offers the modes a help text advertises, most explicit first", () => {
    const help = parseHelp(`Usage: tool [command]

Commands:
  mcp          Start the MCP server
  mcp-server   Same, legacy name
  stdio        Speak over stdio
  serve        Start the HTTP server

Options:
  --stdio      Use stdio transport
`);
    expect(helpLaunches("tool", help)).toEqual([["tool", "mcp"], ["tool", "mcp-server"], ["tool", "--stdio"], ["tool", "stdio"]]);
  });

  it("offers nothing for ordinary CLIs or commands without help", () => {
    expect(helpLaunches("x", parseHelp("Usage: x [--verbose] <file>\n\nOptions:\n  --verbose  be loud\n"))).toEqual([]);
    expect(helpLaunches("x", null)).toEqual([]);
  });
});
