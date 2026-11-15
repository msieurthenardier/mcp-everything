import fs from "node:fs";
import path from "node:path";
import type { ProjectRecord } from "./types.js";

interface RegistryFile {
  version: 1;
  projects: Record<string, ProjectRecord>;
}

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
    this.file = path.join(dir, "registry.json");
  }

  /** Reload from disk if another process changed the file. Returns true if it did. */
  refresh(): boolean {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.file);
    } catch {
      if (this.mtimeMs === -1 && this.projects.size === 0) return false;
      this.projects = new Map();
      this.mtimeMs = -1;
      return true;
    }
    if (stat.mtimeMs === this.mtimeMs) return false;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as RegistryFile;
      this.projects = new Map(Object.entries(parsed.projects ?? {}));
    } catch (e) {
      throw new Error(`Registry file ${this.file} is unreadable: ${(e as Error).message}`);
    }
    this.mtimeMs = stat.mtimeMs;
    return true;
  }

  /** Cross-process mutex: an exclusively created lock file, stolen if stale. */
  private lock(): () => void {
    const lockFile = `${this.file}.lock`;
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        fs.closeSync(fs.openSync(lockFile, "wx", 0o600));
        return () => fs.rmSync(lockFile, { force: true });
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
      const body: RegistryFile = { version: 1, projects: Object.fromEntries(this.projects) };
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
      this.mtimeMs = fs.statSync(this.file).mtimeMs;
    } finally {
      unlock();
    }
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
}
