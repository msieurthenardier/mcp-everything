import { describe, expect, it } from "vitest";
import { detect, parseMakeTargets } from "../src/install/detect.js";
import type { ProbeData } from "../src/sandbox/docker.js";

function probe(files: Record<string, string>, extra: string[] = [], dirs: string[] = []): ProbeData {
  return {
    commit: "0".repeat(40),
    entries: [
      ...Object.keys(files).map((name) => ({ name, dir: false })),
      ...extra.map((name) => ({ name, dir: false })),
      ...dirs.map((name) => ({ name, dir: true })),
    ],
    files,
  };
}

describe("detect", () => {
  it("detects a packaged Python project and its declared license", () => {
    const d = detect(probe({ "pyproject.toml": '[project]\nname = "x"\nlicense = "BSD-3-Clause"\n' }));
    expect(d.primary).toBe("python");
    expect(d.license).toBe("BSD-3-Clause");
  });

  it("prefers Rust over Python packaging metadata (maturin-style repos)", () => {
    const d = detect(
      probe({
        "Cargo.toml": '[package]\nname = "ruff"\nlicense = "MIT"\n',
        "pyproject.toml": '[build-system]\nrequires = ["maturin"]\n',
      }),
    );
    expect(d.primary).toBe("rust");
    expect(d.ecosystems).toEqual(["rust", "python"]);
    expect(d.notes.join(" ")).toMatch(/Multiple ecosystems/);
  });

  it("prefers Python over a tooling-only package.json", () => {
    const d = detect(
      probe({
        "pyproject.toml": '[project]\nname = "x"\n',
        "package.json": JSON.stringify({ private: true, devDependencies: { prettier: "3" }, scripts: { fmt: "prettier ." } }),
      }),
    );
    expect(d.ecosystems).toEqual(["python", "node"]);
    expect(d.npmScripts).toEqual(["fmt"]);
  });

  it("treats a pyproject that only configures tools as weak evidence", () => {
    const d = detect(
      probe({ "pyproject.toml": "[tool.black]\nline-length = 100\n", "package.json": JSON.stringify({ name: "x", bin: "cli.js" }) }),
    );
    expect(d.primary).toBe("node");
  });

  it("detects Go, Ruby and C build systems", () => {
    expect(detect(probe({ "go.mod": "module example.com/x\n" })).primary).toBe("go");
    expect(detect(probe({}, ["Gemfile"])).primary).toBe("ruby");
    expect(detect(probe({}, ["tool.gemspec"])).primary).toBe("ruby");
    expect(detect(probe({}, ["CMakeLists.txt"])).primary).toBe("cmake");
    expect(detect(probe({}, ["configure.ac"])).primary).toBe("autotools");
    expect(detect(probe({ Makefile: "all:\n\tcc x.c\n" })).primary).toBe("make");
  });

  it("falls back to generic with a note, and reports license files", () => {
    const d = detect(probe({}, ["README.md", "COPYING"]));
    expect(d.primary).toBe("generic");
    expect(d.license).toBe("see COPYING");
    expect(d.notes[0]).toMatch(/No recognized build manifest/);
    expect(detect(probe({}, ["README.md"])).license).toBeUndefined();
  });

  it("survives malformed manifests", () => {
    const d = detect(probe({ "package.json": "{not json", "pyproject.toml": "= = =", "Cargo.toml": "[[[" }));
    expect(d.ecosystems).toEqual(["python", "node"]);
  });

  it("only exposes well-formed npm script names", () => {
    const d = detect(probe({ "package.json": JSON.stringify({ main: "i.js", scripts: { build: "x", "test:unit": "y", "bad name; rm -rf": "z" } }) }));
    expect(d.npmScripts).toEqual(["build", "test:unit"]);
  });
});

describe("MCP SDK detection", () => {
  const hint = (files: Record<string, string>) => detect(probe(files)).mcpHint;

  it("recognizes MCP SDK dependencies in each ecosystem", () => {
    expect(hint({ "package.json": JSON.stringify({ dependencies: { "@modelcontextprotocol/sdk": "^1" } }) })).toBe(true);
    expect(hint({ "package.json": JSON.stringify({ peerDependencies: { fastmcp: "*" } }) })).toBe(true);
    expect(hint({ "pyproject.toml": '[project]\nname = "x"\ndependencies = ["httpx", "mcp[cli]>=1.2"]\n' })).toBe(true);
    expect(hint({ "pyproject.toml": '[tool.poetry.dependencies]\nfastmcp = "^2"\n' })).toBe(true);
    expect(hint({ "requirements.txt": "requests\nmcp==1.9.0\n" })).toBe(true);
    expect(hint({ "Cargo.toml": '[package]\nname = "x"\n[dependencies]\nrmcp = "0.1"\n' })).toBe(true);
    expect(hint({ "go.mod": "module x\nrequire github.com/mark3labs/mcp-go v0.30.0\n" })).toBe(true);
  });

  it("does not fire on lookalikes or dev-only tooling", () => {
    expect(hint({ "package.json": JSON.stringify({ devDependencies: { "@modelcontextprotocol/inspector": "1" }, dependencies: { express: "4" } }) })).toBe(false);
    expect(hint({ "pyproject.toml": '[project]\nname = "x"\ndependencies = ["mcpadapt", "pymcp-tools", "mcp-proxy-thing"]\n' })).toBe(false);
    expect(hint({ "requirements.txt": "mcpower==1\n# mcp is great\n" })).toBe(false);
    expect(hint({ "go.mod": "module x\n" })).toBe(false);
    expect(hint({})).toBe(false);
  });
});

describe("parseMakeTargets", () => {
  it("lists explicit targets and skips variables, patterns and special targets", () => {
    const targets = parseMakeTargets(
      ["CC := gcc", "PREFIX ?= /usr", ".PHONY: all clean", "all: build", "build: main.o", "\tcc -o x main.o", "%.o: %.c", "main.o: main.c", "clean:", "install : all", "all: again"].join("\n"),
    );
    expect(targets).toEqual(["all", "build", "clean", "install"]);
  });
});
