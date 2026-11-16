import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ProjectRecord } from "./types.js";

// A write takes milliseconds, so a temp file this old was left by a writer that
// died between its write and its rename. The sweep does not take the registry
// lock: the lock can be taken from a live writer anyway, and waiting for it
// blocks the event loop. Not covered: a writer stopped for more than an hour
// between its write and its rename, whose rename then fails.
const TEMP_MAX_AGE_MS = 60 * 60 * 1000;
const REGISTRY_FILE = "registry.json";
const TEMP_PREFIX = `${REGISTRY_FILE}.`;
const TEMP_SUFFIX = ".tmp";
// One definition of the temp file's name, for the writer and for the sweep.
const tempName = (pid: number) => `${TEMP_PREFIX}${pid}${TEMP_SUFFIX}`;
const isTempName = (name: string) =>
  name.startsWith(TEMP_PREFIX) && name.endsWith(TEMP_SUFFIX) && /^\d+$/.test(name.slice(TEMP_PREFIX.length, name.length - TEMP_SUFFIX.length));

const REGISTRY_VERSION = 1;

interface RegistryFile {
  version: typeof REGISTRY_VERSION;
  projects: Record<string, ProjectRecord>;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * JSON-file registry of installed projects. Several server processes (one per
 * client session) may share it, so reads re-check the file's mtime and every
 * write re-reads, applies one change and renames atomically.
 */
export class Registry {
  private readonly file: string;
  private projects = new Map<string, ProjectRecord>();
  private mtimeMs = -1;

  constructor(private readonly dir: string) {
    this.file = path.join(dir, REGISTRY_FILE);
  }

  /** Reload from disk if another process changed the file. Returns true if it did. */
  refresh(): boolean {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Registry file ${this.file} could not be examined: ${(e as Error).message}`);
      }
      if (this.mtimeMs === -1 && this.projects.size === 0) return false;
      this.projects = new Map();
      this.mtimeMs = -1;
      return true;
    }
    if (stat.mtimeMs === this.mtimeMs) return false;
    let parsed: RegistryFile;
    let version: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as RegistryFile;
    } catch (e) {
      throw new Error(`Registry file ${this.file} is unreadable: ${(e as Error).message}`);
    }
    // Valid JSON of the wrong shape would otherwise load as an empty registry and be overwritten by the next write.
    if (!isPlainObject(parsed)) {
      throw new Error(`Registry file ${this.file} is unreadable: not a registry: expected an object`);
    }
    if (parsed.projects !== undefined && !isPlainObject(parsed.projects)) {
      throw new Error(`Registry file ${this.file} is unreadable: not a registry: expected "projects" to be an object`);
    }
    version = (parsed as { version?: unknown }).version;
    // Checked before anything is assigned, and every write refreshes first, so a
    // file from a newer build is neither loaded nor rewritten by this one.
    if (version !== undefined && version !== REGISTRY_VERSION) {
      if (typeof version === "number" && Number.isInteger(version) && version > REGISTRY_VERSION) {
        throw new Error(
          `Registry file ${this.file} was written by a newer version of mcp-everything (format ${version}; this build reads format ${REGISTRY_VERSION}). ` +
            `The file is left untouched. Upgrade mcp-everything. Moving the file aside starts this build with an empty registry, ` +
            `but the sandboxes of the projects in it stay in Docker and are no longer listed.`,
        );
      }
      // JSON.stringify(Infinity) is "null", which would misreport what the file held.
      const shown = typeof version === "number" && !Number.isFinite(version) ? String(version) : JSON.stringify(version);
      throw new Error(`Registry file ${this.file} is unreadable: unsupported version ${shown}`);
    }
    this.projects = new Map(Object.entries(parsed.projects ?? {}));
    this.mtimeMs = stat.mtimeMs;
    return true;
  }

  /**
   * Cross-process mutex: an exclusively created lock file, stolen if stale. The
   * file holds a token and the release removes it only if the token is still
   * there. Limits, not fixed here: a lock can be taken from a live writer after
   * 5 seconds, so holding it is not proof of exclusion; and between the
   * release's read and its removal another holder could appear.
   */
  private lock(): () => void {
    const lockFile = `${this.file}.lock`;
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        const fd = fs.openSync(lockFile, "wx", 0o600);
        const token = `${process.pid}:${crypto.randomBytes(16).toString("hex")}`;
        try {
          fs.writeSync(fd, token);
        } finally {
          fs.closeSync(fd);
        }
        return () => {
          try {
            if (fs.readFileSync(lockFile, "utf8") === token) fs.rmSync(lockFile, { force: true });
          } catch {
            // gone already: nothing of ours to remove
          }
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lockFile).mtimeMs;
      } catch {
        continue; // released between our two calls
      }
      // Writes take milliseconds; an old lock belongs to a process that died.
      if (age > 10_000 || Date.now() > deadline) fs.rmSync(lockFile, { force: true });
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }

  private mutate(change: (projects: Map<string, ProjectRecord>) => void): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const unlock = this.lock();
    try {
      this.mtimeMs = -2; // force a re-read: we must build on the latest state
      this.refresh();
      change(this.projects);
      this.persist();
    } finally {
      unlock();
    }
  }

  /**
   * Removes temp files a crashed writer left beside the registry. Touches no
   * lock and neither reads nor writes registry.json. Returns how many it removed.
   */
  sweepTemps(now = Date.now(), log: (line: string) => void = () => {}): number {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") log(`registry temp files: could not list ${this.dir}: ${(e as Error).message}`);
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      if (!isTempName(name)) continue;
      const file = path.join(this.dir, name);
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || now - stat.mtimeMs <= TEMP_MAX_AGE_MS) continue;
        fs.unlinkSync(file);
        removed++;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") log(`registry temp files: could not remove ${name}: ${(e as Error).message}`);
      }
    }
    return removed;
  }

  private persist(): void {
    const body: RegistryFile = { version: REGISTRY_VERSION, projects: Object.fromEntries(this.projects) };
    const tmp = path.join(this.dir, tempName(process.pid));
    fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.mtimeMs = fs.statSync(this.file).mtimeMs;
  }

  list(): ProjectRecord[] {
    return [...this.projects.values()];
  }

  get(slug: string): ProjectRecord | undefined {
    return this.projects.get(slug);
  }

  findByRepo(repoId: string): ProjectRecord | undefined {
    const wanted = repoId.toLowerCase();
    return this.list().find((p) => p.repo.id.toLowerCase() === wanted);
  }

  /** Look a project up by slug, repo id ("github:o/n") or bare path ("o/n"). */
  resolve(key: string): ProjectRecord | undefined {
    const k = key.trim().toLowerCase();
    return (
      this.projects.get(k) ??
      this.list().find((p) => p.repo.id.toLowerCase() === k || p.repo.path.toLowerCase() === k)
    );
  }

  put(record: ProjectRecord): void {
    this.mutate((projects) => projects.set(record.slug, record));
  }

  delete(slug: string): void {
    this.mutate((projects) => projects.delete(slug));
  }

  /**
   * Change one record from what the file holds under the lock. `fn` gets the
   * current record (a registry-owned object: copy it, do not mutate it) and
   * returns the record to store, or undefined to change nothing, in which
   * case the file is not rewritten. Returns whether it wrote.
   */
  update(slug: string, fn: (current: ProjectRecord | undefined) => ProjectRecord | undefined): boolean {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const unlock = this.lock();
    try {
      this.mtimeMs = -2; // force a re-read: the decision must rest on the latest state
      this.refresh();
      const next = fn(this.projects.get(slug));
      if (next === undefined) return false;
      this.projects.set(slug, next);
      this.persist();
      return true;
    } finally {
      unlock();
    }
  }
}
