import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigError, formatFatal } from "../src/errors.js";
import { prepareDataDir } from "../src/server.js";
import { INSTALLATION_ID_PATTERN, loadInstallationId } from "../src/installation.js";
import { Registry } from "../src/registry.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-id-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const FILE = () => path.join(dir, "installation-id");
const noWait = () => {};
const names = () => fs.readdirSync(dir).sort();

describe("loadInstallationId: creating", () => {
  it("creates installation-id with a valid id and a newline, mode 0600, making the directory", () => {
    const sub = path.join(dir, "a", "b");
    const id = loadInstallationId(sub);
    expect(id).toMatch(INSTALLATION_ID_PATTERN);
    const file = path.join(sub, "installation-id");
    expect(fs.readFileSync(file, "utf8")).toBe(`${id}\n`);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(sub)).toEqual(["installation-id"]);
  });

  it("is never looser than 0600 under a permissive umask", () => {
    const old = process.umask(0);
    try {
      loadInstallationId(dir);
    } finally {
      process.umask(old);
    }
    expect(fs.statSync(FILE()).mode & 0o777).toBe(0o600);
  });

  it("returns the same id the second time and leaves the file alone", () => {
    const first = loadInstallationId(dir);
    const before = fs.statSync(FILE());
    expect(loadInstallationId(dir)).toBe(first);
    expect(fs.readFileSync(FILE(), "utf8")).toBe(`${first}\n`);
    expect(fs.statSync(FILE()).ino).toBe(before.ino);
  });

  it("accepts a file without a trailing newline and one with it", () => {
    fs.writeFileSync(FILE(), "0a1b2c3d");
    expect(loadInstallationId(dir)).toBe("0a1b2c3d");
    fs.writeFileSync(FILE(), "0a1b2c3d\n");
    expect(loadInstallationId(dir)).toBe("0a1b2c3d");
  });

  it.each([
    ["a Windows line ending", "0a1b2c3d\r\n"],
    ["a byte-order mark", "\uFEFF0a1b2c3d"],
    ["a byte-order mark and a line feed", "\uFEFF0a1b2c3d\n"],
    ["a byte-order mark and a Windows line ending", "\uFEFF0a1b2c3d\r\n"],
  ])("accepts %s, returning the id and leaving the file untouched", (_n, content) => {
    fs.writeFileSync(FILE(), content);
    expect(loadInstallationId(dir)).toBe("0a1b2c3d");
    expect(fs.readFileSync(FILE(), "utf8")).toBe(content);
    expect(names()).toEqual(["installation-id"]);
  });

  it("returns what the file holds when another load completes between the temporary write and the link", () => {
    let inner = "";
    const id = loadInstallationId(dir, {
      link: (temp, final) => {
        inner = loadInstallationId(dir);
        fs.linkSync(temp, final); // EEXIST: the other load won
      },
    });
    expect(id).toBe(inner);
    expect(names()).toEqual(["installation-id"]);
    expect(fs.readFileSync(FILE(), "utf8")).toBe(`${inner}\n`);
  });

  it("falls back to creating the file when the link fails for another reason, leaving no temporary file", () => {
    const id = loadInstallationId(dir, {
      link: () => {
        throw Object.assign(new Error("no links here"), { code: "EPERM" });
      },
    });
    expect(id).toMatch(INSTALLATION_ID_PATTERN);
    expect(fs.readFileSync(FILE(), "utf8")).toBe(`${id}\n`);
    expect(fs.statSync(FILE()).mode & 0o777).toBe(0o600);
    expect(names()).toEqual(["installation-id"]);
  });

  it("does not use the fallback, and returns the existing id, when the link says the name exists", () => {
    const id = loadInstallationId(dir, {
      link: () => {
        fs.writeFileSync(FILE(), "feedbeef\n");
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      },
    });
    expect(id).toBe("feedbeef");
    expect(fs.readFileSync(FILE(), "utf8")).toBe("feedbeef\n");
    expect(names()).toEqual(["installation-id"]);
  });

  it("lets the fallback lose to another process: the existing file wins", () => {
    const realOpen = fs.openSync;
    const spy = vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      if (String(p) === FILE()) {
        fs.writeFileSync(FILE(), "cafe0000\n");
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      }
      return realOpen(p, flags, mode);
    }) as typeof fs.openSync);
    try {
      const id = loadInstallationId(dir, {
        link: () => {
          throw Object.assign(new Error("no links"), { code: "EPERM" });
        },
      });
      expect(id).toBe("cafe0000");
    } finally {
      spy.mockRestore();
    }
    expect(names()).toEqual(["installation-id"]);
  });
});

describe("loadInstallationId: an invalid file", () => {
  it.each([
    ["nine hexadecimal characters", "0123456789"],
    ["an uppercase character", "0123ABCD"],
    ["a non-hexadecimal character", "0123456g"],
    ["two newlines", "0123abcd\n\n"],
  ])("throws at once for %s, changing nothing", (_n, content) => {
    fs.writeFileSync(FILE(), content);
    const wait = vi.fn();
    let msg = "";
    try {
      loadInstallationId(dir, { wait });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain(FILE());
    expect(msg).toMatch(/restore/i);
    expect(msg).toMatch(/delete/i);
    expect(wait).not.toHaveBeenCalled();
    expect(fs.readFileSync(FILE(), "utf8")).toBe(content);
    expect(names()).toEqual(["installation-id"]);
  });

  it("waits for a short file, for no more than two seconds of requested waiting, then throws the same error", () => {
    fs.writeFileSync(FILE(), "0123");
    const waits: number[] = [];
    expect(() => loadInstallationId(dir, { wait: (ms) => waits.push(ms) })).toThrow(FILE());
    const total = waits.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(2000);
    expect(fs.readFileSync(FILE(), "utf8")).toBe("0123");
    expect(names()).toEqual(["installation-id"]);
  });

  it.each([
    ["a lone carriage return", "0123abcd\r"],
    ["a carriage return and line feed twice", "0123abcd\r\n\r\n"],
    ["a line feed then a carriage return and line feed", "0123abcd\n\r\n"],
    ["a carriage return before the id", "\r0123abcd\n"],
    ["two byte-order marks", "\uFEFF\uFEFF0123abcd\n"],
    ["a byte-order mark after the id", "0123abcd\uFEFF"],
    ["a trailing space", "0123abcd \n"],
    ["an uppercase id with a Windows line ending", "0123ABCD\r\n"],
  ])("throws at once for %s, changing nothing", (_n, content) => {
    fs.writeFileSync(FILE(), content);
    const wait = vi.fn();
    expect(() => loadInstallationId(dir, { wait })).toThrow(/delete/);
    expect(wait).not.toHaveBeenCalled();
    expect(fs.readFileSync(FILE(), "utf8")).toBe(content);
    expect(names()).toEqual(["installation-id"]);
  });

  it("treats an empty file the same way", () => {
    fs.writeFileSync(FILE(), "");
    expect(() => loadInstallationId(dir, { wait: noWait })).toThrow(/delete/);
  });

  it("returns the id when a short file becomes valid while it waits", () => {
    fs.writeFileSync(FILE(), "0123");
    let calls = 0;
    const id = loadInstallationId(dir, {
      wait: () => {
        if (++calls === 3) fs.writeFileSync(FILE(), "0123abcd\n");
      },
    });
    expect(id).toBe("0123abcd");
  });
});

describe("loadInstallationId: temporary files", () => {
  const old = (name: string) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, "x");
    const t = new Date(Date.now() - 2 * 3600_000);
    fs.utimesSync(f, t, t);
  };

  it("removes its own stale temporary file and keeps a young one", () => {
    old("installation-id.1-aa.tmp");
    fs.writeFileSync(path.join(dir, "installation-id.2-bb.tmp"), "x");
    loadInstallationId(dir);
    expect(names()).toEqual(["installation-id", "installation-id.2-bb.tmp"]);
  });

  it("leaves a directory with a stale temporary name alone, without trying to remove it", () => {
    const sub = path.join(dir, "installation-id.3-dd.tmp");
    fs.mkdirSync(sub);
    const t = new Date(Date.now() - 2 * 3600_000);
    fs.utimesSync(sub, t, t);
    const unlink = vi.spyOn(fs, "unlinkSync");
    try {
      loadInstallationId(dir);
      expect(unlink.mock.calls.map((c) => String(c[0]))).not.toContain(sub);
    } finally {
      unlink.mockRestore();
    }
    expect(fs.statSync(sub).isDirectory()).toBe(true);
  });

  it("does not sweep the registry's temporary names, and the registry does not sweep its own", () => {
    old("registry.json.123.tmp");
    loadInstallationId(dir);
    expect(names()).toContain("registry.json.123.tmp");

    old("installation-id.9-cc.tmp");
    expect(new Registry(dir).sweepTemps()).toBe(1); // only registry.json.123.tmp
    expect(names()).toContain("installation-id.9-cc.tmp");
  });
});

describe("loadInstallationId: a failed removal of the temporary file", () => {
  const failTempRemoval = () => {
    const real = fs.rmSync;
    return vi.spyOn(fs, "rmSync").mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
      if (/installation-id\..*\.tmp$/.test(String(p))) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return real(p, o);
    }) as typeof fs.rmSync);
  };

  it("does not fail a creation that succeeded; the id is persisted and a later load returns it", () => {
    const spy = failTempRemoval();
    let id: string;
    try {
      id = loadInstallationId(dir);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(id).toMatch(INSTALLATION_ID_PATTERN);
    expect(fs.readFileSync(FILE(), "utf8")).toBe(`${id}\n`);
    expect(loadInstallationId(dir)).toBe(id);
  });

  it("still reports the original error when the creation failed before the id file existed", () => {
    const realOpen = fs.openSync;
    const open = vi.spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, f: fs.OpenMode, m?: fs.Mode) => {
      if (String(p).endsWith(".tmp")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return realOpen(p, f, m);
    }) as typeof fs.openSync);
    const rm = failTempRemoval();
    try {
      expect(() => loadInstallationId(dir)).toThrow(/Cannot create the installation id file .*denied/);
    } finally {
      open.mockRestore();
      rm.mockRestore();
    }
  });
});

describe("loadInstallationId: failures", () => {
  it("throws, naming the file, when a directory stands in its place", () => {
    fs.mkdirSync(FILE());
    expect(() => loadInstallationId(dir, { wait: noWait })).toThrow(FILE());
    expect(fs.statSync(FILE()).isDirectory()).toBe(true);
  });

  it("throws, naming the file, when the data directory's path runs through a regular file", () => {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "x");
    const sub = path.join(blocker, "data");
    expect(() => loadInstallationId(sub)).toThrow(path.join(sub, "installation-id"));
  });

  it("throws when the temporary file cannot be created and returns no id", () => {
    const spy = vi.spyOn(fs, "openSync").mockImplementation(() => {
      throw Object.assign(new Error("read-only"), { code: "EROFS" });
    });
    try {
      expect(() => loadInstallationId(dir)).toThrow(FILE());
    } finally {
      spy.mockRestore();
    }
    expect(names()).toEqual([]);
  });

  it("treats only ENOENT as absent: another read failure throws", () => {
    const real = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, o?: unknown) => {
      if (String(p) === FILE()) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return real(p, o as BufferEncoding);
    }) as typeof fs.readFileSync);
    try {
      expect(() => loadInstallationId(dir)).toThrow(/denied/);
    } finally {
      spy.mockRestore();
    }
    expect(names()).toEqual([]); // nothing was created
  });
});

describe("prepareDataDir: a data directory that cannot be made is a ConfigError", () => {
  it("names the directory and the cause, with no stack in the fatal line", () => {
    fs.writeFileSync(path.join(dir, "file"), "x");
    const target = path.join(dir, "file", "sub");
    let err: unknown;
    try {
      prepareDataDir(target);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain(target);
    const line = formatFatal(err);
    expect(line).toContain("Cannot make the data directory");
    expect(line).not.toContain("\n    at ");
  });
});

describe("loadInstallationId: errors are ConfigError", () => {
  it("for an invalid id file", () => {
    fs.writeFileSync(FILE(), "0123ABCD");
    expect(() => loadInstallationId(dir, { wait: noWait })).toThrow(ConfigError);
  });
  it("for a data directory that cannot be made", () => {
    fs.writeFileSync(path.join(dir, "file"), "x");
    expect(() => loadInstallationId(path.join(dir, "file", "sub"))).toThrow(ConfigError);
  });
});
