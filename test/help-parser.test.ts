import { describe, expect, it } from "vitest";
import { looksLikeHelp, parseHelp, parseOptionLine } from "../src/toolgen/help-parser.js";

const byFlag = (help: ReturnType<typeof parseHelp>, flag: string) => help.options.find((o) => o.flag === flag);

describe("parseOptionLine", () => {
  it("parses short + long with a value placeholder", () => {
    expect(parseOptionLine("  -o, --output <FILE>   Write output to FILE")).toMatchObject({
      flag: "--output",
      short: "-o",
      takesValue: true,
      valueName: "<FILE>",
      description: "Write output to FILE",
    });
  });

  it("parses boolean flags", () => {
    expect(parseOptionLine("  -v, --verbose  Be loud")).toMatchObject({ flag: "--verbose", short: "-v", takesValue: false });
  });

  it("parses --flag=VALUE and optional --flag[=VALUE]", () => {
    expect(parseOptionLine("      --color=WHEN   colorize")).toMatchObject({ flag: "--color", takesValue: true, optionalValue: false });
    expect(parseOptionLine("      --color[=WHEN]   colorize")).toMatchObject({ flag: "--color", takesValue: true, optionalValue: true });
  });

  it("parses argparse style where both forms repeat the metavar", () => {
    expect(parseOptionLine("  -n NUM, --number NUM  how many")).toMatchObject({ flag: "--number", short: "-n", takesValue: true });
  });

  it("parses Go flag-package style single-dash long options", () => {
    expect(parseOptionLine("  -addr string")).toMatchObject({ flag: "-addr", takesValue: true, valueName: "string" });
  });

  it("keeps a | inside a value placeholder from splitting the spec", () => {
    expect(parseOptionLine("  --color <auto|always|never>  When to color")).toMatchObject({
      flag: "--color",
      valueName: "<auto|always|never>",
    });
  });

  it("recognizes negatable flags", () => {
    expect(parseOptionLine("  --[no-]cache   use the cache")).toMatchObject({ flag: "--cache", negatable: true, takesValue: false });
  });

  it("rejects prose, bullets and separators", () => {
    expect(parseOptionLine("- a bullet point about something")).toBeNull();
    expect(parseOptionLine("-----------")).toBeNull();
    expect(parseOptionLine("  --foo this is a sentence with single spaces")).toBeNull();
    expect(parseOptionLine("  --foo This is a sentence with single spaces")).toBeNull();
    expect(parseOptionLine("  not an option")).toBeNull();
  });
});

describe("parseHelp", () => {
  it("handles clap output", () => {
    const help = parseHelp(`An extremely fast Python linter.

Usage: ruff [OPTIONS] <COMMAND>

Commands:
  check    Run Ruff on the given files or directories
  format   Run the Ruff formatter on the given files or directories
  rule     Explain a rule (or all rules)
  help     Print this message or the help of the given subcommand(s)

Options:
  -h, --help     Print help
  -V, --version  Print version

Log levels:
  -v, --verbose  Enable verbose logging
  -q, --quiet    Print diagnostics, but nothing else

Global options:
      --config <CONFIG_OPTION>  Either a path to a TOML configuration file, or a TOML
                                override
      --output-format <FMT>     Output format [possible values: concise, full, json]
      --isolated                Ignore all configuration files
`);
    expect(help.summary).toBe("An extremely fast Python linter.");
    expect(help.usage).toBe("ruff [OPTIONS] <COMMAND>");
    expect(help.subcommands.map((s) => s.name)).toEqual(["check", "format", "rule"]);
    expect(help.subcommands[0]!.description).toBe("Run Ruff on the given files or directories");
    expect(help.options.map((o) => o.flag)).toEqual(["--verbose", "--quiet", "--config", "--output-format", "--isolated"]);
    expect(byFlag(help, "--config")).toMatchObject({ takesValue: true, prop: "config" });
    expect(byFlag(help, "--config")!.description).toContain("override");
    expect(byFlag(help, "--output-format")).toMatchObject({ prop: "output_format", choices: ["concise", "full", "json"] });
    expect(byFlag(help, "--isolated")).toMatchObject({ takesValue: false });
  });

  it("handles argparse output with subparsers", () => {
    const help = parseHelp(`usage: tool [-h] [--verbose] [--level {debug,info,warn}] {init,run} ...

Does useful things.

positional arguments:
  {init,run}            sub-command help
    init                create a project
    run                 run the project

options:
  -h, --help            show this help message and exit
  --verbose             say more
  --level {debug,info,warn}
                        log level
  -n NUM, --number NUM  how many
`);
    expect(help.summary).toBe("Does useful things.");
    expect(help.usage).toContain("tool [-h]");
    expect(help.subcommands).toEqual([
      { name: "init", description: "create a project" },
      { name: "run", description: "run the project" },
    ]);
    expect(byFlag(help, "--level")).toMatchObject({ takesValue: true, choices: ["debug", "info", "warn"], description: "log level" });
    expect(byFlag(help, "--number")).toMatchObject({ short: "-n", takesValue: true });
    expect(byFlag(help, "--help")).toBeUndefined();
  });

  it("handles click output", () => {
    const help = parseHelp(`Usage: flask [OPTIONS] COMMAND [ARGS]...

  A general utility script for Flask applications.

Options:
  -e, --env-file FILE   Load environment variables from this file.
  -A, --app IMPORT      The Flask application or factory function to load.
  --debug / --no-debug  Set debug mode.
  --version             Show the Flask version.
  --help                Show this message and exit.

Commands:
  routes  Show the routes for the app.
  run     Run a development server.
  shell   Run a shell in the app context.
`);
    expect(help.summary).toBe("A general utility script for Flask applications.");
    expect(help.subcommands.map((s) => s.name)).toEqual(["routes", "run", "shell"]);
    expect(byFlag(help, "--env-file")).toMatchObject({ short: "-e", takesValue: true, prop: "env_file" });
    expect(byFlag(help, "--debug")).toMatchObject({ takesValue: false });
    expect(byFlag(help, "--version")).toBeUndefined();
  });

  it("handles cobra output", () => {
    const help = parseHelp(`gron transforms JSON into discrete assignments.

Usage:
  hugo [flags]
  hugo [command]

Available Commands:
  completion  Generate the autocompletion script for the specified shell
  help        Help about any command
  server      A high performance webserver
  version     Print the version number

Flags:
  -b, --baseURL string         hostname (and path) to the root
      --buildDrafts            include content marked as draft
  -h, --help                   help for hugo

Use "hugo [command] --help" for more information about a command.
`);
    expect(help.summary).toBe("gron transforms JSON into discrete assignments.");
    expect(help.usage).toBe("hugo [flags] hugo [command]");
    expect(help.subcommands.map((s) => s.name)).toEqual(["completion", "server", "version"]);
    expect(byFlag(help, "--baseURL")).toMatchObject({ short: "-b", takesValue: true, valueName: "string", prop: "baseURL" });
    expect(byFlag(help, "--buildDrafts")).toMatchObject({ takesValue: false });
  });

  it("handles commander output with argument placeholders after command names", () => {
    const help = parseHelp(`Usage: cli [options] [command]

Options:
  -V, --version           output the version number
  -d, --debug             output extra debugging
  -h, --help              display help for command

Commands:
  serve [options] <dir>   serve a directory
  build|b <entry>         build the thing
  help [command]          display help for command
`);
    expect(help.subcommands.map((s) => s.name)).toEqual(["serve", "build"]);
    expect(help.subcommands[0]!.description).toBe("serve a directory");
    expect(help.options.map((o) => o.flag)).toEqual(["--debug"]);
  });

  it("handles Go flag package output with descriptions on the next line", () => {
    const help = parseHelp(`Usage of server:
  -addr string
    \tlisten address (default ":8080")
  -v\tverbose output
`);
    expect(byFlag(help, "-addr")).toMatchObject({ takesValue: true, prop: "addr" });
    expect(byFlag(help, "-addr")!.description).toContain("listen address");
    expect(byFlag(help, "-v")).toMatchObject({ takesValue: false, description: "verbose output" });
  });

  it("splits comma separated command lists", () => {
    const help = parseHelp(`Usage: npm <command>

All commands:

    access, adduser, audit, bugs, cache, ci,
    config, dedupe, version, view
`);
    expect(help.subcommands.map((s) => s.name)).toEqual([
      "access", "adduser", "audit", "bugs", "cache", "ci", "config", "dedupe", "version", "view",
    ]);
  });

  it("ignores examples sections and strips ANSI colors", () => {
    const help = parseHelp(`\u001b[1mUsage:\u001b[0m tool [OPTIONS]

\u001b[1mOptions:\u001b[0m
  \u001b[32m--fast\u001b[0m   go fast

Examples:
  --slow   this is not an option
  tool --fast file.txt
`);
    expect(help.options.map((o) => o.flag)).toEqual(["--fast"]);
  });

  it("renames options that collide with reserved or duplicate property names", () => {
    const help = parseHelp(`Options:
  --args <A>     arguments
  --cwd <DIR>    directory
  --foo-bar      one
  --foo_bar      two
`);
    expect(help.options.map((o) => o.prop)).toEqual(["opt_args", "opt_cwd", "foo_bar", "foo_bar_2"]);
  });

  it("accepts single-space descriptions only when aligned with a known option", () => {
    const help = parseHelp(`Options:
  -u, --ungron     Reverse the operation
  -m, --monochrome Monochrome (don't colorize output)
      --output FILE
  -s, --stream     Treat each line as JSON. Conflicts with
                   --ungron Which is not an option here
`);
    expect(help.options.map((o) => o.flag)).toEqual(["--ungron", "--monochrome", "--output", "--stream"]);
    expect(byFlag(help, "--monochrome")).toMatchObject({ short: "-m", takesValue: false });
    expect(byFlag(help, "--monochrome")!.description).toContain("Monochrome");
    expect(byFlag(help, "--output")).toMatchObject({ takesValue: true });
  });

  it("returns empty structure for text that is not help", () => {
    const help = parseHelp("error: something went wrong\n");
    expect(help.options).toEqual([]);
    expect(help.subcommands).toEqual([]);
  });
});

describe("looksLikeHelp", () => {
  it("accepts usage text and rejects errors and silence", () => {
    expect(looksLikeHelp("Usage: foo [options] <file>\n")).toBe(true);
    expect(looksLikeHelp("")).toBe(false);
    expect(looksLikeHelp("bash: foo: command not found")).toBe(false);
    expect(looksLikeHelp("  -a   do a thing\n  -b   do another thing\n")).toBe(true);
  });
});
