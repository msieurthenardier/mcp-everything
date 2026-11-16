import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Registry } from "../src/registry.js";
import { record } from "./helpers.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-reg-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// The message of what fn throws, so assertions can anchor on the whole string.
const thrown = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected the call to throw");
};
// \S+ cannot span a space, so a message rewrapped as "... is unreadable: Registry file ..." does not match.
const NEWER_VERSION = /^Registry file \S+registry\.json was written by a newer version of mcp-everything \(format 2; this build reads format 1\)\. /;

describe("Registry", () => {
  it("starts empty and persists records with private permissions", () => {
    const reg = new Registry(path.join(dir, "nested"));
    expect(reg.refresh()).toBe(false);
    expect(reg.list()).toEqual([]);
    reg.put(record("alpha"));
    const file = path.join(dir, "nested", "registry.json");
    expect(JSON.parse(fs.readFileSync(file, "utf8")).projects.alpha.slug).toBe("alpha");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it("resolves by slug, repo id and repo path, case-insensitively", () => {
    const reg = new Registry(dir);
    reg.put(record("ripgrep", "BurntSushi/ripgrep"));
    expect(reg.resolve("ripgrep")?.slug).toBe("ripgrep");
    expect(reg.resolve("github:burntsushi/RIPGREP")?.slug).toBe("ripgrep");
    expect(reg.resolve("BurntSushi/ripgrep")?.slug).toBe("ripgrep");
    expect(reg.findByRepo("GitHub:BurntSushi/ripgrep")?.slug).toBe("ripgrep");
    expect(reg.resolve("nope")).toBeUndefined();
  });

  it("merges writes from two instances instead of clobbering", () => {
    const a = new Registry(dir);
    const b = new Registry(dir);
    a.put(record("one"));
    b.put(record("two")); // b never read "one" explicitly
    a.put(record("three"));
    const fresh = new Registry(dir);
    fresh.refresh();
    expect(fresh.list().map((p) => p.slug).sort()).toEqual(["one", "three", "two"]);
    expect(b.refresh()).toBe(true);
    expect(b.get("three")).toBeDefined();
  });

  it("deletes records and notices when the file disappears", () => {
    const reg = new Registry(dir);
    reg.put(record("x"));
    reg.delete("x");
    expect(reg.list()).toEqual([]);
    reg.put(record("y"));
    fs.rmSync(path.join(dir, "registry.json"));
    expect(reg.refresh()).toBe(true);
    expect(reg.list()).toEqual([]);
  });

  it("throws on a stat error other than ENOENT and keeps the records it has", () => {
    const reg = new Registry(dir);
    reg.put(record("keep"));
    const file = path.join(dir, "registry.json");
    const real = fs.statSync;
    const spy = vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (String(p) === file) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return (real as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.statSync);
    try {
      expect(() => reg.refresh()).toThrow(/registry\.json.*permission denied/);
      expect(reg.list().map((p) => p.slug)).toEqual(["keep"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("steals a stale lock left by a dead process", () => {
    const reg = new Registry(dir);
    const lock = path.join(dir, "registry.json.lock");
    fs.writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    reg.put(record("z"));
    expect(reg.get("z")).toBeDefined();
  });

  it("reports a corrupt registry file instead of silently discarding it", () => {
    fs.writeFileSync(path.join(dir, "registry.json"), "{ nope");
    expect(() => new Registry(dir).refresh()).toThrow(/unreadable/);
  });

  describe("a registry file with a version", () => {
    const file = () => path.join(dir, "registry.json");
    const NEWER = '{"version":2,"projects":{"x":{"slug":"x"}},"future":true}';
    const leftovers = () => fs.readdirSync(dir).filter((n) => n.endsWith(".tmp") || n.endsWith(".lock"));

    it("newer than this build is refused with a message that says what to do", () => {
      fs.writeFileSync(file(), NEWER);
      const reg = new Registry(dir);
      const message = thrown(() => reg.refresh());
      expect(message).toMatch(NEWER_VERSION);
      expect(message).not.toMatch(/unreadable/);
      expect(() => reg.refresh()).toThrow(/left untouched.*[Uu]pgrade mcp-everything.*[Mm]oving the file aside.*empty registry.*sandboxes.*stay in Docker/s);
      expect(reg.list()).toEqual([]);
    });

    it("newer than this build is never rewritten by put, delete or update", () => {
      fs.writeFileSync(file(), NEWER);
      const before = fs.readFileSync(file());
      const reg = new Registry(dir);
      const attempts = [() => reg.put(record("y")), () => reg.delete("x"), () => reg.update("x", (c) => c)];
      for (const attempt of attempts) {
        const message = thrown(attempt);
        expect(message).toMatch(NEWER_VERSION);
        expect(message).not.toMatch(/unreadable/);
        expect(fs.readFileSync(file()).equals(before)).toBe(true);
        expect(leftovers()).toEqual([]);
      }
      expect(fs.readdirSync(dir)).toEqual(["registry.json"]);
    });

    it("is refused again on an unchanged file, and loaded once replaced by one this build reads", () => {
      fs.writeFileSync(file(), NEWER);
      const reg = new Registry(dir);
      expect(thrown(() => reg.refresh())).toMatch(NEWER_VERSION);
      expect(thrown(() => reg.refresh())).toMatch(NEWER_VERSION);
      fs.writeFileSync(file(), JSON.stringify({ version: 1, projects: { x: record("x") } }));
      fs.utimesSync(file(), 1, 1);
      expect(reg.refresh()).toBe(true);
      expect(reg.get("x")).toBeDefined();
    });

    it("newer keeps the records a running instance already holds", () => {
      const reg = new Registry(dir);
      reg.put(record("held"));
      const before = reg.list();
      fs.writeFileSync(file(), NEWER);
      fs.utimesSync(file(), 1, 1);
      expect(thrown(() => reg.refresh())).toMatch(NEWER_VERSION);
      expect(reg.list()).toEqual(before);
      expect(thrown(() => reg.refresh())).toMatch(NEWER_VERSION);
      expect(reg.list()).toEqual(before);
    });

    it("missing loads as before", () => {
      fs.writeFileSync(file(), JSON.stringify({ projects: { x: record("x") } }));
      const reg = new Registry(dir);
      expect(reg.refresh()).toBe(true);
      expect(reg.get("x")).toBeDefined();
    });

    it("1 loads as before, including written as 1.0", () => {
      fs.writeFileSync(file(), `{"version":1.0,"projects":${JSON.stringify({ x: record("x") })}}`);
      const reg = new Registry(dir);
      expect(reg.refresh()).toBe(true);
      expect(reg.get("x")).toBeDefined();
    });

    it.each([
      ["0", "0"],
      ["-1", "-1"],
      ["1.5", "1.5"],
      ["2.5", "2.5"],
      ['"1"', '"1"'],
      ['"2"', '"2"'],
      ["null", "null"],
      ["true", "true"],
      ['{"a":1}', '{"a":1}'],
      ["[]", "[]"],
      ["1e999", "Infinity"],
    ])(
      "%s is refused as unsupported and left untouched",
      (value, shown) => {
        const text = `{"version":${value},"projects":{}}`;
        fs.writeFileSync(file(), text);
        const reg = new Registry(dir);
        expect(thrown(() => reg.refresh())).toBe(`Registry file ${file()} is unreadable: unsupported version ${shown}`);
        expect(() => reg.put(record("y"))).toThrow(/unsupported version/);
        expect(fs.readFileSync(file(), "utf8")).toBe(text);
        expect(leftovers()).toEqual([]);
        expect(reg.list()).toEqual([]);
      },
    );
  });

  describe("update", () => {
    const mtime = () => fs.statSync(path.join(dir, "registry.json")).mtimeMs;

    it("stores the record the updater returns, in the file and in memory", () => {
      const reg = new Registry(dir);
      reg.put(record("x"));
      expect(reg.update("x", (cur) => ({ ...cur!, network: true }))).toBe(true);
      expect(reg.get("x")?.network).toBe(true);
      const fresh = new Registry(dir);
      fresh.refresh();
      expect(fresh.get("x")?.network).toBe(true);
    });

    it("hands the updater what the file holds now, not what this instance last read", () => {
      const a = new Registry(dir);
      const b = new Registry(dir);
      a.put(record("x"));
      b.put({ ...record("x"), network: true });
      let seen: boolean | undefined;
      a.update("x", (cur) => {
        seen = cur?.network;
        return undefined;
      });
      expect(seen).toBe(true);
    });

    it("does not rewrite the file when the updater returns undefined, and keeps the fresh state", () => {
      const a = new Registry(dir);
      const b = new Registry(dir);
      a.put(record("x"));
      b.put({ ...record("x"), network: true });
      const before = mtime();
      expect(a.update("x", () => undefined)).toBe(false);
      expect(mtime()).toBe(before);
      expect(a.get("x")).toEqual(b.get("x"));
      expect(fs.existsSync(path.join(dir, "registry.json.lock"))).toBe(false);
    });

    it("passes undefined for a slug that is not there and can add it", () => {
      const reg = new Registry(dir);
      let seen: unknown = "unset";
      expect(reg.update("x", (cur) => ((seen = cur), undefined))).toBe(false);
      expect(seen).toBeUndefined();
      expect(reg.update("x", () => record("x"))).toBe(true);
      expect(reg.get("x")).toBeDefined();
    });

    it("leaves delete of a missing slug as it was: a write, no error", () => {
      const reg = new Registry(dir);
      reg.put(record("x"));
      reg.delete("nope");
      const fresh = new Registry(dir);
      fresh.refresh();
      expect(fresh.list().map((p) => p.slug)).toEqual(["x"]);
    });
  });
});

describe("Registry.sweepTemps", () => {
  const NOW = 1_800_000_000_000;
  const HOUR = 3600;
  /** Writes a file in the data directory whose modification time is `ageSec` before NOW. */
  const put = (name: string, ageSec: number, body = "{}") => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body);
    const t = NOW / 1000 - ageSec;
    fs.utimesSync(file, t, t);
    return file;
  };
  afterEach(() => vi.restoreAllMocks());

  it("removes a matching temp file more than an hour old and counts it", () => {
    const old = put("registry.json.4242.tmp", HOUR + 1);
    const log: string[] = [];
    expect(new Registry(dir).sweepTemps(NOW, (l) => log.push(l))).toBe(1);
    expect(fs.existsSync(old)).toBe(false);
    expect(log).toEqual([]);
  });

  it("leaves a matching file at or under the bound, and every other name", () => {
    const keep = [
      put("registry.json.4242.tmp", HOUR),
      put("registry.json.77.tmp", 5),
      put("registry.json", 10 * HOUR),
      put("registry.json.lock", 10 * HOUR),
      put("registry.json.tmp", 10 * HOUR),
      put("registry.json..tmp", 10 * HOUR),
      put("registry.json.12a.tmp", 10 * HOUR),
      put("registry.json.12.tmp.bak", 10 * HOUR),
      put("x.registry.json.12.tmp", 10 * HOUR),
    ];
    expect(new Registry(dir).sweepTemps(NOW)).toBe(0);
    for (const f of keep) expect(fs.existsSync(f)).toBe(true);
  });

  it("leaves a directory and a symbolic link with a matching name, and the link's target", () => {
    const old = NOW / 1000 - 10 * HOUR;
    const sub = path.join(dir, "registry.json.1.tmp");
    fs.mkdirSync(sub);
    fs.utimesSync(sub, old, old);
    const target = put("elsewhere", 10 * HOUR, "keep");
    const link = path.join(dir, "registry.json.2.tmp");
    fs.symlinkSync(target, link);
    expect(new Registry(dir).sweepTemps(NOW)).toBe(0);
    expect(fs.statSync(sub).isDirectory()).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe("keep");
  });

  it.each([["missing", undefined], ["corrupt", "{ nope"]])(
    "does not read or write registry.json, which is %s",
    (_state, content) => {
      const file = path.join(dir, "registry.json");
      if (content !== undefined) {
        fs.writeFileSync(file, content);
        fs.utimesSync(file, NOW / 1000 - 5 * HOUR, NOW / 1000 - 5 * HOUR);
      }
      const before = content === undefined ? undefined : { bytes: fs.readFileSync(file, "utf8"), mtimeMs: fs.statSync(file).mtimeMs };
      put("registry.json.9.tmp", 2 * HOUR);
      const reads = vi.spyOn(fs, "readFileSync");
      expect(new Registry(dir).sweepTemps(NOW)).toBe(1);
      expect(reads).not.toHaveBeenCalled();
      if (before) expect({ bytes: fs.readFileSync(file, "utf8"), mtimeMs: fs.statSync(file).mtimeMs }).toEqual(before);
      else expect(fs.existsSync(file)).toBe(false);
    },
  );

  it("returns at once and leaves the lock file alone while another instance holds it", () => {
    const lockFile = path.join(dir, "registry.json.lock");
    fs.writeFileSync(lockFile, "");
    const before = fs.statSync(lockFile).mtimeMs;
    const old = put("registry.json.4242.tmp", 2 * HOUR);
    const wait = vi.spyOn(Atomics, "wait");
    expect(new Registry(dir).sweepTemps(NOW)).toBe(1);
    expect(wait).not.toHaveBeenCalled();
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.statSync(lockFile).mtimeMs).toBe(before);
  });

  it("does not create the data directory when it is missing, and does not throw", () => {
    const missing = path.join(dir, "nested");
    expect(new Registry(missing).sweepTemps(NOW)).toBe(0);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("logs the directory and returns 0 when it cannot be listed", () => {
    const asFile = path.join(dir, "a-file");
    fs.writeFileSync(asFile, "x");
    const log: string[] = [];
    expect(new Registry(asFile).sweepTemps(NOW, (l) => log.push(l))).toBe(0);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain(asFile);
  });

  it("logs a failure by file name, still examines the rest, and ignores a file that has gone", () => {
    const first = put("registry.json.1.tmp", 2 * HOUR);
    const gone = put("registry.json.2.tmp", 2 * HOUR);
    const last = put("registry.json.3.tmp", 2 * HOUR);
    const real = fs.unlinkSync;
    vi.spyOn(fs, "unlinkSync").mockImplementation((p) => {
      if (p === first) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      if (p === gone) {
        real(p);
        throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
      }
      return real(p);
    });
    const log: string[] = [];
    expect(new Registry(dir).sweepTemps(NOW, (l) => log.push(l))).toBe(1);
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(last)).toBe(false);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("registry.json.1.tmp");
  });

  it("leaves put, delete and update as they were", () => {
    const reg = new Registry(dir);
    reg.put(record("a"));
    put("registry.json.5.tmp", 2 * HOUR);
    reg.sweepTemps(NOW);
    reg.put(record("b"));
    expect(reg.update("a", (cur) => ({ ...cur!, network: true }))).toBe(true);
    reg.delete("b");
    const fresh = new Registry(dir);
    fresh.refresh();
    expect(fresh.list().map((p) => [p.slug, p.network])).toEqual([["a", true]]);
  });
});
