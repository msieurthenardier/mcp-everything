import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { outputStep } from "../src/install/recipes.js";
import { MANIFESTS, parseProbeOutput, PROBE_SCRIPT, WALK_SCRIPT, WALK_SEPARATOR, walkArguments } from "../src/sandbox/scripts.js";

// The slow cases of the Docker layer's tests: the walk and the probe script run in the host's own shell, over real scratch
// directories (about 13 s). They run in the `slow` project (`npm run test:slow`), not in `npm test`; see vitest.config.ts.

/** The walk run in the host's own sh over a scratch directory (the integration case runs it in the pinned image). */
describe("the walk script, in a local shell", () => {
  const hasSh = fs.existsSync("/bin/sh");
  const head = `HEAD ${"a".repeat(40)}\n`;
  const exec = (dir: string) => {
    const script = WALK_SCRIPT.replace("cd /workspace/repo", `cd '${dir}'`);
    return execFileSync("/bin/sh", ["-c", script, "walk", ...walkArguments()], { encoding: "utf8", maxBuffer: 64_000_000 });
  };
  const withDir = (fn: (dir: string) => void) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-walk-"));
    try {
      fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  const put = (dir: string, rel: string, content: string | Buffer = "x\n") => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  };
  const walkOf = (raw: string) => parseProbeOutput(head + raw).walk;
  const it2 = (name: string, fn: () => void) => it.skipIf(!hasSh)(name, { timeout: 60_000 }, fn);

  it2("reads the root and nested package.json, prunes node_modules, and does not follow a link", () => {
    withDir((dir) => {
      put(dir, "package.json", '{"r":1}');
      put(dir, "sub/package.json", '{"s":1}');
      put(dir, "node_modules/x/package.json", "{}");
      fs.writeFileSync(path.join(dir, "secret"), "s");
      fs.symlinkSync(path.join(dir, "secret"), path.join(dir, "setup.py"));
      const w = walkOf(exec(dir));
      expect(w.files.map((f) => f.path)).toEqual(["package.json", "sub/package.json"]);
      expect(w.skippedLinks).toEqual(["setup.py"]);
      expect(w.incomplete).toBeUndefined();
    });
  });

  it2("reports a nested link that a find pattern matches, and never reads it", () => {
    withDir((dir) => {
      fs.writeFileSync(path.join(dir, "outside"), "secret");
      put(dir, "sub/x", "x");
      fs.symlinkSync(path.join(dir, "outside"), path.join(dir, "sub/package.json"));
      fs.symlinkSync("sub", path.join(dir, "linkdir"));
      const w = walkOf(exec(dir));
      expect(w.files).toEqual([]);
      expect(w.skippedLinks).toEqual(["sub/package.json"]);
    });
  });

  it2("reads root-only entries only at the root, once, and prints nothing for an empty tree", () => {
    withDir((dir) => {
      put(dir, ".cargo/config.toml", "a");
      put(dir, "nested/.cargo/config.toml", "b");
      put(dir, "nested/setup.py", "c");
      put(dir, "setup.py", "d");
      expect(walkOf(exec(dir)).files.map((f) => f.path).sort()).toEqual([".cargo/config.toml", "setup.py"]);
    });
    withDir((dir) => {
      expect(exec(dir)).toBe("");
    });
  });

  it2("reads a 5 MB pnpm-lock.yaml for presence only: empty, not truncated, no budget used", () => {
    withDir((dir) => {
      put(dir, "pnpm-lock.yaml", Buffer.alloc(5_000_000, 97));
      put(dir, "yarn.lock", "y");
      for (let i = 0; i < 30; i++) put(dir, `d${i}/Makefile`, Buffer.alloc(70_000, 98));
      const raw = exec(dir);
      const w = walkOf(raw);
      expect(w.files.find((f) => f.path === "pnpm-lock.yaml")).toEqual({ path: "pnpm-lock.yaml", content: "" });
      expect(w.files.find((f) => f.path === "yarn.lock")).toEqual({ path: "yarn.lock", content: "" });
      expect(w.files.filter((f) => f.path.endsWith("Makefile"))).toHaveLength(30);
      expect(w.incomplete).toBeUndefined();
      expect(raw.length).toBeLessThan(3_500_000);
    });
  });

  it2("reports a presence-only lockfile that is a link, and reads none that is not a file", () => {
    withDir((dir) => {
      fs.symlinkSync("/etc/hostname", path.join(dir, "yarn.lock"));
      fs.mkdirSync(path.join(dir, "pnpm-lock.yaml"));
      const w = walkOf(exec(dir));
      expect(w.files).toEqual([]);
      expect(w.skippedLinks).toEqual(["yarn.lock"]);
    });
  });

  it2("truncates a file over 64 KB at 64 KB and flags it", () => {
    withDir((dir) => {
      put(dir, "configure", Buffer.alloc(70_000, 99));
      put(dir, "Makefile", Buffer.alloc(65_536, 100));
      const w = walkOf(exec(dir));
      const c = w.files.find((f) => f.path === "configure")!;
      expect(c.truncated).toBe(true);
      expect(c.content).toHaveLength(65_536);
      const m = w.files.find((f) => f.path === "Makefile")!;
      expect(m.truncated).toBeUndefined();
      expect(m.content).toHaveLength(65_536);
    });
  });

  it2("reports a directory name with a newline as INCOMPLETE newline and skips what is inside it", () => {
    withDir((dir) => {
      put(dir, "package.json", "{}");
      put(dir, "a\nb/package.json", "{}");
      put(dir, "a\n./package.json", "{}");
      const raw = exec(dir);
      expect(raw.split("\n")).toContain("INCOMPLETE newline");
      expect(walkOf(raw).files.map((f) => f.path)).toEqual(["package.json"]);
    });
  });

  it2("reports INCOMPLETE depth for a match below the depth limit, and none at the limit", () => {
    withDir((dir) => {
      put(dir, "a/b/c/d/e/f/g/Makefile", "x"); // depth 8: read
      const ok = exec(dir);
      expect(ok).not.toContain("INCOMPLETE");
      expect(walkOf(ok).files).toHaveLength(1);
    });
    withDir((dir) => {
      put(dir, "a/b/c/d/e/f/g/h/Makefile", "x"); // depth 9: not read
      expect(exec(dir).split("\n")).toContain("INCOMPLETE depth");
    });
  });

  it2("does not report INCOMPLETE depth for a deep match that lies under a pruned directory", () => {
    withDir((dir) => {
      put(dir, "a/b/node_modules/c/d/e/f/g/h/i/j/package.json", "{}"); // ten levels deep, under a pruned node_modules at depth 3
      expect(exec(dir).split("\n")).not.toContain("INCOMPLETE depth");
    });
    withDir((dir) => {
      put(dir, "a/b/c/d/e/f/g/h/i/j/package.json", "{}"); // ten levels deep, nothing pruned on the way
      expect(exec(dir).split("\n")).toContain("INCOMPLETE depth");
    });
  });

  it2("caps a pattern at 40 files with INCOMPLETE pattern, and still exits 0 when head closes the pipe early", () => {
    withDir((dir) => {
      for (let i = 0; i < 300; i++) put(dir, `m/f${i}.cmake`, "x");
      const lines = exec(dir).split("\n"); // execFileSync throws on a non-zero exit
      expect(lines).toContain("INCOMPLETE pattern");
      expect(lines.filter((l) => l.startsWith("BUILD "))).toHaveLength(40);
    });
  });

  it2("enforces the file budget, reading the root package.json first", () => {
    withDir((dir) => {
      put(dir, "package.json", '{"root":1}');
      for (const n of ["package.json", "Cargo.toml", "build.rs", "binding.gyp", "CMakeLists.txt", "Rakefile"]) {
        for (let i = 0; i < 40; i++) put(dir, `d${i}/${n}`, "x");
      }
      const raw = exec(dir);
      const w = walkOf(raw);
      expect(w.files).toHaveLength(200);
      expect(raw.split("\n")).toContain("INCOMPLETE files");
      expect(w.files[0]).toEqual({ path: "package.json", content: '{"root":1}' });
    });
  });

  it2("enforces the byte budget", () => {
    withDir((dir) => {
      for (let i = 0; i < 40; i++) put(dir, `d${i}/x.mk`, Buffer.alloc(70_000, 97));
      const raw = exec(dir);
      const w = walkOf(raw);
      expect(w.files).toHaveLength(32); // 32 x 64 KB is exactly 2 MB
      expect(w.files.every((f) => f.truncated === true)).toBe(true);
      expect(raw.split("\n")).toContain("INCOMPLETE bytes");
    });
  });

  it2("keeps the root match of a pattern inside its cap when nested ones are more than 40", () => {
    withDir((dir) => {
      for (let i = 0; i < 60; i++) put(dir, `A${i}/Makefile`, "x");
      put(dir, "Makefile", "root\n");
      const w = walkOf(exec(dir));
      expect(w.files[0]).toEqual({ path: "Makefile", content: "root\n" });
      expect(w.incomplete).toBe("pattern");
    });
  });

  it2("treats file names as data: no expansion, no command substitution", () => {
    withDir((dir) => {
      // A stray file here would make the final check pass vacuously.
      expect(fs.existsSync(path.resolve("pwned"))).toBe(false);
      put(dir, "a.cmake", "x");
      put(dir, "$(touch pwned).cmake", "x");
      put(dir, "x;y.cmake", "x");
      const w = walkOf(exec(dir));
      expect(w.files.map((f) => f.path).sort()).toEqual(["$(touch pwned).cmake", "a.cmake", "x;y.cmake"]);
      expect(fs.existsSync(path.join(dir, "pwned"))).toBe(false);
      expect(fs.existsSync(path.resolve("pwned"))).toBe(false);
    });
  });

  it2("is silent about a tree with no matches", () => {
    withDir((dir) => {
      put(dir, "README", "x");
      expect(exec(dir)).toBe("");
    });
  });
});

/** The prelude's output step, rendered over scratch paths and run in the host's own sh. */
describe("the recipe prelude's output step, in a local shell", () => {
  const hasSh = fs.existsSync("/bin/sh");
  const withRoot = (fn: (o: { root: string; output: string; prefix: string; run: () => string }) => void) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-out-"));
    const output = path.join(root, "ws", ".mcpe");
    const prefix = path.join(root, "opt", "mcpe");
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, "stale"), "old");
    const run = () => execFileSync("/bin/sh", ["-ec", outputStep({ output, prefix })], { encoding: "utf8" });
    try {
      fn({ root, output, prefix, run });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  const it2 = (name: string, fn: Parameters<typeof withRoot>[0]) => it.skipIf(!hasSh)(name, { timeout: 60_000 }, () => withRoot(fn));
  const clean = (output: string) => expect(fs.readdirSync(output)).toEqual([]);

  it2("makes the prefix a symlink to the output directory and clears it when there is no prefix", ({ output, prefix, run }) => {
    expect(run()).toBe("");
    expect(fs.readlinkSync(prefix)).toBe(output);
    clean(output);
  });

  it2("replaces a dangling symlink", ({ root, output, prefix, run }) => {
    fs.mkdirSync(path.dirname(prefix), { recursive: true });
    fs.symlinkSync(path.join(root, "nowhere"), prefix);
    run();
    expect(fs.readlinkSync(prefix)).toBe(output);
    clean(output);
  });

  it2("replaces a symlink to another directory, without writing into it", ({ root, output, prefix, run }) => {
    const other = path.join(root, "other");
    fs.mkdirSync(other);
    fs.mkdirSync(path.dirname(prefix), { recursive: true });
    fs.symlinkSync(other, prefix);
    run();
    expect(fs.readlinkSync(prefix)).toBe(output);
    expect(fs.readdirSync(other)).toEqual([]);
    clean(output);
  });

  it2("replaces a regular file", ({ output, prefix, run }) => {
    fs.mkdirSync(path.dirname(prefix), { recursive: true });
    fs.writeFileSync(prefix, "file");
    run();
    expect(fs.readlinkSync(prefix)).toBe(output);
    clean(output);
  });

  it2("leaves a real directory as it is, warns once, and still clears the output directory", ({ output, prefix, run }) => {
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    fs.writeFileSync(path.join(prefix, "bin", "tool"), "t");
    const out = run();
    expect(out.split("\n").filter((l) => l.startsWith("MCPE_WARN "))).toHaveLength(1);
    expect(fs.lstatSync(prefix).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(prefix, "bin", "tool"), "utf8")).toBe("t");
    expect(fs.statSync(output).isDirectory()).toBe(true);
    clean(output);
  });
});

/** The whole clone-and-walk script against a local git repository, with /workspace redirected to a scratch directory. */
describe("the whole probe script, in a local shell", () => {
  const hasTools = fs.existsSync("/bin/sh") && (() => { try { execFileSync("git", ["--version"]); return true; } catch { return false; } })();
  it.skipIf(!hasTools)("prints each manifest once, none outside MANIFESTS, and the walk's files after the separator split", { timeout: 60_000 }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-probe-"));
    try {
      const src = path.join(root, "src");
      fs.mkdirSync(src);
      fs.writeFileSync(path.join(src, "package.json"), '{"a":1}');
      fs.writeFileSync(path.join(src, "Makefile"), "all:\n");
      fs.writeFileSync(path.join(src, "go.mod"), "module x\n");
      fs.mkdirSync(path.join(src, "sub"));
      fs.writeFileSync(path.join(src, "sub", "Makefile"), "all:\n");
      const git = (...a: string[]) => execFileSync("git", ["-C", src, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "pipe" });
      git("init", "--quiet");
      git("add", ".");
      git("commit", "--quiet", "-m", "x");
      const ws = path.join(root, "ws");
      fs.mkdirSync(ws);
      const probeScript = PROBE_SCRIPT.split("/workspace").join(ws);
      const out = execFileSync("/bin/sh", ["-c", probeScript, "probe", src, "", "0", ...MANIFESTS, WALK_SEPARATOR, ...walkArguments()], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const names = out.split("\n").filter((l) => l.startsWith("FILE ")).map((l) => l.split(" ")[1]!);
      expect(names.sort()).toEqual(["Makefile", "go.mod", "package.json"]);
      for (const n of names) expect(MANIFESTS).toContain(n);
      const data = parseProbeOutput(out);
      expect(data.walk.files.map((f) => f.path).sort()).toEqual(["Makefile", "package.json", "sub/Makefile"]);
      expect(data.walk.incomplete).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
