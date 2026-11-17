import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** An installation id: eight lowercase hexadecimal characters. */
export const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}$/;

const ID_FILE = "installation-id";
const ID_LENGTH = 8;
// One definition of the temporary file's name, for the writer and for the sweep.
// It must not match the registry's own temporary names (`registry.json.<digits>.tmp`).
const TEMP_PREFIX = `${ID_FILE}.`;
const TEMP_SUFFIX = ".tmp";
const tempName = (pid: number, random: string) => `${TEMP_PREFIX}${pid}-${random}${TEMP_SUFFIX}`;
const isTempName = (name: string) => name.startsWith(TEMP_PREFIX) && name.endsWith(TEMP_SUFFIX) && name.length > TEMP_PREFIX.length + TEMP_SUFFIX.length;
const TEMP_MAX_AGE_MS = 60 * 60 * 1000;
const MAX_WAIT_MS = 2000;
const WAIT_STEP_MS = 50;

/** Replaceable by tests: the parts of loading that touch timing or the file system's link support. */
export interface InstallationHooks {
  link?: (temp: string, final: string) => void;
  wait?: (ms: number) => void;
}

const defaultWait = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export const isInstallationId = (value: unknown): value is string => typeof value === "string" && INSTALLATION_ID_PATTERN.test(value);

const code = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code;

/** Valid content: the id, with at most one trailing newline removed. */
function parse(content: string): string | undefined {
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  return INSTALLATION_ID_PATTERN.test(body) ? body : undefined;
}

/**
 * Read the installation id of a data directory, creating it on first use.
 * The id names every sandbox this installation makes and is never regenerated:
 * no path overwrites or deletes an existing id file.
 */
export function loadInstallationId(dataDir: string, hooks: InstallationHooks = {}): string {
  const file = path.join(dataDir, ID_FILE);
  const link = hooks.link ?? ((temp: string, final: string) => fs.linkSync(temp, final));
  const wait = hooks.wait ?? defaultWait;
  const fail = (what: string, e: unknown): never => {
    throw new Error(`Cannot ${what} the installation id file ${file}: ${e instanceof Error ? e.message : String(e)}`);
  };
  const invalid = () =>
    new Error(
      `The installation id file ${file} does not hold a valid id (eight lowercase hexadecimal characters). ` +
        `Restore it from a backup or, if no sandbox belongs to this data directory, delete it so a new one is made.`,
    );

  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  } catch (e) {
    return fail("create the directory for", e);
  }
  sweepTemps(dataDir);

  // Returns the id, undefined when the file is absent. Throws when it is invalid.
  const readFinal = (): string | undefined => {
    let waited = 0;
    for (;;) {
      let content: string;
      try {
        content = fs.readFileSync(file, "utf8");
      } catch (e) {
        if (code(e) === "ENOENT") return undefined;
        return fail("read", e);
      }
      const id = parse(content);
      if (id) return id;
      // Fewer than eight characters: perhaps being written by another process.
      if (content.length >= ID_LENGTH || waited >= MAX_WAIT_MS) throw invalid();
      wait(WAIT_STEP_MS);
      waited += WAIT_STEP_MS;
    }
  };

  const existing = readFinal();
  if (existing) return existing;

  const id = crypto.randomBytes(4).toString("hex");
  const content = `${id}\n`;
  const temp = path.join(dataDir, tempName(process.pid, crypto.randomBytes(4).toString("hex")));
  try {
    let fd: number;
    try {
      fd = fs.openSync(temp, "wx", 0o600);
    } catch (e) {
      return fail("create", e);
    }
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } catch (e) {
      return fail("write", e);
    } finally {
      fs.closeSync(fd);
    }
    try {
      link(temp, file);
    } catch (e) {
      if (code(e) !== "EEXIST") createInPlace(file, content, fail);
    }
  } finally {
    fs.rmSync(temp, { force: true });
  }

  const final = readFinal();
  if (!final) return fail("read", new Error("the file vanished after it was created"));
  return final;
}

/** For a file system without hard links: create the final name exclusively. "Exists" means another process won. */
function createInPlace(file: string, content: string, fail: (what: string, e: unknown) => never): void {
  let fd: number;
  try {
    fd = fs.openSync(file, "wx", 0o600);
  } catch (e) {
    if (code(e) === "EEXIST") return;
    return fail("create", e);
  }
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } catch (e) {
    return fail("write", e);
  } finally {
    fs.closeSync(fd);
  }
}

/** Remove temporary files of this module that a process that died left behind. */
function sweepTemps(dir: string, now = Date.now()): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!isTempName(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isFile() && now - stat.mtimeMs > TEMP_MAX_AGE_MS) fs.unlinkSync(file);
    } catch {
      // gone already, or not ours to remove: the next load tries again
    }
  }
}
