import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ContainmentBusyError, ContainmentDeadlineError, ContainmentLockLostError, LIMITS, sha256, type Clock } from "./containment-core.js";

/** A held lock: the mutex and the lock file, with the deadline and the token to check before anything is removed. */
export interface HeldLock {
  /** Throws when the deadline has passed or the lock file's token is no longer ours. Called before others are removed. */
  assertLive(): void;
}

export class ProjectLocks {
  /** The tail of each project's mutex chain. */
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly clock: Clock,
    private readonly dataDir: string,
  ) {}

  // --- locks -----------------------------------------------------------------------------------------------------

  private lockPath(key: string): string {
    return path.join(this.dataDir, `registry.json.proxy-${sha256(key).slice(0, 16)}.lock`);
  }

  /**
   * The one lock path: the in-process mutex and the lock file together, then the function under a 90 s deadline
   * that starts once both are held. The wait for both is bounded by 60 s (`ContainmentBusyError`, which fails
   * closed). The lock file is removed only if its token is still ours. "Locked" functions assume the caller holds it.
   */
  async withProjectLock<T>(key: string, fn: (lock: HeldLock) => Promise<T>): Promise<T> {
    const waitStart = this.clock.mono();
    const releaseMutex = await this.acquireMutex(key);
    let file: { ours(): boolean; release(): void };
    try {
      file = await this.acquireFile(key, waitStart);
    } catch (e) {
      releaseMutex();
      throw e;
    }
    const startedMono = this.clock.mono();
    let aborted = false;
    const lock: HeldLock = {
      assertLive: () => {
        if (aborted || this.clock.mono() - startedMono > LIMITS.deadlineMs) {
          aborted = true;
          throw new ContainmentDeadlineError(`The replacement for ${key} passed its ${LIMITS.deadlineMs / 1000} s deadline.`);
        }
        if (!file.ours()) throw new ContainmentLockLostError(`The lock for ${key} was taken over while it was held; nothing was removed.`);
      },
    };
    // The mutex and the lock file are released only once `fn` has settled, even when the caller was refused at the
    // deadline earlier: a straggling `fn` (which keeps checking `assertLive`) never runs beside the next holder.
    const run = (async (): Promise<T> => {
      try {
        return await fn(lock);
      } finally {
        try {
          file.release();
        } finally {
          releaseMutex();
        }
      }
    })();
    const deadline = this.clock.after(LIMITS.deadlineMs);
    try {
      return await Promise.race([
        run,
        deadline.promise.then((): never => {
          aborted = true;
          throw new ContainmentDeadlineError(`The replacement for ${key} passed its ${LIMITS.deadlineMs / 1000} s deadline.`);
        }),
      ]);
    } finally {
      deadline.cancel();
    }
  }

  private async acquireMutex(key: string): Promise<() => void> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    const timer = this.clock.after(LIMITS.lockWaitMs);
    try {
      const timedOut = await Promise.race([prev.then(() => false), timer.promise.then(() => true)]);
      if (timedOut) {
        // Our place in the chain stays, and is given up as soon as the one before us is done.
        void prev.then(release);
        throw new ContainmentBusyError(`Another replacement for ${key} is in progress and did not finish within ${LIMITS.lockWaitMs / 1000} s; this sandbox is refused rather than left uncontained.`);
      }
    } finally {
      timer.cancel();
    }
    return release;
  }

  /**
   * Remove a lock file judged stale, without ever removing a fresh one another waiter has just created: the file is
   * renamed to a name of our own, judged again there (a rename keeps the mtime), and only then deleted. If it turns
   * out fresh it is put back with an exclusive link.
   */
  private removeIfStale(file: string): void {
    const mine = `${file}.stale-${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
    try {
      fs.renameSync(file, mine);
    } catch {
      return; // already gone
    }
    try {
      if (this.clock.now() - fs.statSync(mine).mtimeMs <= LIMITS.staleMs) {
        try {
          fs.linkSync(mine, file);
        } catch {
          // another lock was created meanwhile: this one is lost, and its holder finds out by its token
        }
      }
    } finally {
      fs.rmSync(mine, { force: true });
    }
  }

  private async acquireFile(key: string, waitStart: number): Promise<{ ours(): boolean; release(): void }> {
    const file = this.lockPath(key);
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const token = `${process.pid}:${crypto.randomBytes(16).toString("hex")}`;
    for (;;) {
      try {
        const fd = fs.openSync(file, "wx", 0o600);
        try {
          fs.writeSync(fd, token);
        } finally {
          fs.closeSync(fd);
        }
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      let age = 0;
      try {
        age = this.clock.now() - fs.statSync(file).mtimeMs;
      } catch {
        continue; // released between our two calls
      }
      if (age > LIMITS.staleMs) {
        this.removeIfStale(file);
        continue;
      }
      if (this.clock.mono() - waitStart >= LIMITS.lockWaitMs) {
        throw new ContainmentBusyError(`Another process is replacing the proxy for ${key} and did not finish within ${LIMITS.lockWaitMs / 1000} s; this sandbox is refused rather than left uncontained.`);
      }
      await this.clock.sleep(LIMITS.pollMs);
    }
    const ours = (): boolean => {
      try {
        return fs.readFileSync(file, "utf8") === token;
      } catch {
        return false;
      }
    };
    return {
      ours,
      release: () => {
        if (ours()) fs.rmSync(file, { force: true });
      },
    };
  }
}
