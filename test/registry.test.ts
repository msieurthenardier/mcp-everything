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
});
