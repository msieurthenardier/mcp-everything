import { describe, expect, it } from "vitest";
import { chooseToolchain, nodeMajor, pythonLineSatisfies, toolVersion } from "../src/install/toolchain.js";
import type { ProbeData } from "../src/sandbox/docker.js";

const probe = (files: Record<string, string>): ProbeData => ({ commit: "0".repeat(40), entries: [], files, walk: { files: [] } });
const pkg = (body: object) => JSON.stringify(body);
const REA_RANGE = "^22.23.4 || ^24.22.1 || >=26.12.1";

describe("nodeMajor", () => {
  it("reads the major from the forms .nvmrc files take", () => {
    expect(nodeMajor("24.22.1")).toBe(24);
    expect(nodeMajor("v22")).toBe(22);
    expect(nodeMajor("20.x")).toBe(20);
    expect(nodeMajor("lts/jod")).toBe(22);
    expect(nodeMajor("lts/*")).toBeUndefined();
    expect(nodeMajor("node")).toBeUndefined();
    expect(nodeMajor("stable")).toBeUndefined();
  });
});

describe("toolVersion", () => {
  it("finds a tool in .tool-versions, ignoring comments and other tools", () => {
    const file = "# asdf\nruby 3.3.0\nnodejs 22.11.0 # lts\npython 3.12.4 3.11.9\n";
    expect(toolVersion(file, "nodejs", "node")).toBe("22.11.0");
    expect(toolVersion(file, "python")).toBe("3.12.4");
    expect(toolVersion(file, "golang")).toBeUndefined();
    expect(toolVersion(undefined, "ruby")).toBeUndefined();
  });
});

describe("Node selection", () => {
  const choose = (files: Record<string, string>) => chooseToolchain("node", probe(files), "node:lts", false);

  it("prefers an exact pin over a wider declared range", () => {
    // The shape that motivated this: the range admits Node 26, the pin says 24.
    const choice = choose({ ".nvmrc": "24.22.1\n", "package.json": pkg({ engines: { node: REA_RANGE } }) });
    expect(choice).toEqual({ image: "node:24", fallbacks: [], reason: "Node 24, pinned by .nvmrc (24.22.1)" });
  });

  it("consults pin files in a fixed order", () => {
    expect(choose({ ".node-version": "v20.11.0" }).image).toBe("node:20");
    expect(choose({ ".tool-versions": "nodejs 22.3.0\n" }).image).toBe("node:22");
    expect(choose({ "package.json": pkg({ volta: { node: "18.19.0" } }) }).image).toBe("node:18");
    expect(choose({ ".nvmrc": "22", ".node-version": "20", "package.json": pkg({ volta: { node: "18.0.0" } }) }).image).toBe("node:22");
  });

  it("falls back to the declared range, newest supported line first, keeping the others for a retry", () => {
    const choice = choose({ "package.json": pkg({ engines: { node: REA_RANGE } }) });
    expect(choice.image).toBe("node:26");
    expect(choice.fallbacks).toEqual(["node:24", "node:22"]);
    expect(choice.reason).toContain(REA_RANGE);
  });

  it("respects upper bounds and single-line ranges", () => {
    expect(choose({ "package.json": pkg({ engines: { node: ">=18 <23" } }) })).toMatchObject({ image: "node:22", fallbacks: ["node:20", "node:18"] });
    expect(choose({ "package.json": pkg({ engines: { node: "20.x" } }) })).toMatchObject({ image: "node:20", fallbacks: [] });
  });

  it("uses the default image when nothing usable is declared", () => {
    const cases: Array<Record<string, string>> = [
      {},
      { ".nvmrc": "lts/*" },
      { "package.json": pkg({ engines: { node: "whatever works" } }) },
      { "package.json": "{broken" },
      { "package.json": pkg({ engines: { node: ">=99" } }) },
    ];
    for (const files of cases) {
      expect(choose(files)).toMatchObject({ image: "node:lts", fallbacks: [] });
    }
  });

  it("leaves an operator-configured image alone", () => {
    const choice = chooseToolchain("node", probe({ ".nvmrc": "24" }), "registry.example/node:custom", true);
    expect(choice).toEqual({ image: "registry.example/node:custom", fallbacks: [], reason: "image set by the server's configuration" });
  });
});

describe("pythonLineSatisfies", () => {
  it.each([
    ["3.12", ">=3.9", true],
    ["3.8", ">=3.9", false],
    ["3.13", ">=3.9,<3.13", false],
    ["3.12", ">=3.9,<3.13", true],
    ["3.13", "<3.13.5", true],
    ["3.13", "<=3.13", true],
    ["3.9", ">3.9", true],
    ["3.11", "~=3.11", true],
    ["3.12", "~=3.11", true],
    ["3.12", "~=3.11.2", false],
    ["3.11", "==3.11.*", true],
    ["3.12", "==3.11.*", false],
    ["3.12", "!=3.12", false],
    ["3.12", "!=3.12.1", true],
    ["3.12", "^3.9", true],
    ["3.12", "~3.11", false],
    ["3.11", ">= 3.10, < 3.12", true],
    ["3.12", ">=3", true],
    ["3.12", "nonsense", false],
  ])("%s against %s is %s", (line, spec, expected) => {
    expect(pythonLineSatisfies(line, spec)).toBe(expected);
  });
});

describe("Python selection", () => {
  const choose = (files: Record<string, string>) => chooseToolchain("python", probe(files), "python:3.13", false);

  it("uses a pin when there is one", () => {
    expect(choose({ ".python-version": "3.11.9\n", "pyproject.toml": '[project]\nrequires-python = ">=3.8"\n' })).toEqual({
      image: "python:3.11",
      fallbacks: [],
      reason: "Python 3.11, pinned by .python-version (3.11.9)",
    });
    expect(choose({ ".tool-versions": "python 3.12.4\n" }).image).toBe("python:3.12");
    // Not a CPython release line: no pin to honor.
    expect(choose({ ".python-version": "pypy3.10" }).image).toBe("python:3.13");
  });

  it("keeps the default line when the declared range allows it", () => {
    const choice = choose({ "pyproject.toml": '[project]\nrequires-python = ">=3.9"\n' });
    expect(choice.image).toBe("python:3.13");
    expect(choice.fallbacks.slice(0, 2)).toEqual(["python:3.14", "python:3.12"]);
  });

  it("moves off the default when the range excludes it", () => {
    expect(choose({ "pyproject.toml": '[project]\nrequires-python = ">=3.8,<3.12"\n' })).toMatchObject({ image: "python:3.11", fallbacks: ["python:3.10", "python:3.9", "python:3.8"] });
    expect(choose({ "pyproject.toml": '[project]\nrequires-python = ">=3.14"\n' }).image).toBe("python:3.14");
  });

  it("reads the range from Poetry, setup.cfg and setup.py too", () => {
    expect(choose({ "pyproject.toml": '[tool.poetry.dependencies]\npython = "~3.10"\n' }).image).toBe("python:3.10");
    expect(choose({ "setup.cfg": "[options]\npython_requires = >=3.7,<3.10\n" }).image).toBe("python:3.9");
    expect(choose({ "setup.py": 'setup(name="x", python_requires="<3.12")' }).image).toBe("python:3.11");
  });

  it("falls back to the default without usable evidence", () => {
    expect(choose({})).toMatchObject({ image: "python:3.13", fallbacks: [] });
    expect(choose({ "pyproject.toml": '[project]\nrequires-python = ">=4"\n' })).toMatchObject({ image: "python:3.13", fallbacks: [] });
  });
});

describe("other ecosystems", () => {
  it("pins Ruby from .ruby-version, .tool-versions or the Gemfile", () => {
    const choose = (files: Record<string, string>) => chooseToolchain("ruby", probe(files), "ruby:3", false).image;
    expect(choose({ ".ruby-version": "ruby-3.2.2\n" })).toBe("ruby:3.2");
    expect(choose({ ".tool-versions": "ruby 3.3.0\n" })).toBe("ruby:3.3");
    expect(choose({ Gemfile: 'source "https://rubygems.org"\nruby "~> 3.1.4"\ngem "rake"\n' })).toBe("ruby:3.1");
    expect(choose({ Gemfile: 'gem "ruby-progressbar"\n' })).toBe("ruby:3");
  });

  it("keeps the default image for Rust and Go and says how their own tooling resolves versions", () => {
    expect(chooseToolchain("rust", probe({ "rust-toolchain.toml": '[toolchain]\nchannel = "1.75"\n' }), "rust:1", false)).toMatchObject({
      image: "rust:1",
      reason: expect.stringContaining("rustup installs the toolchain pinned by rust-toolchain"),
    });
    expect(chooseToolchain("go", probe({ "go.mod": "module x\n\ngo 1.22\n\ntoolchain go1.23.4\n" }), "golang:1", false)).toMatchObject({
      image: "golang:1",
      reason: expect.stringContaining("toolchain go1.23.4"),
    });
    expect(chooseToolchain("make", probe({}), "buildpack-deps:stable", false).image).toBe("buildpack-deps:stable");
  });
});
