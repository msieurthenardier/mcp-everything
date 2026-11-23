import crypto from "node:crypto";

export class ContainmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
/** The lock for a project could not be had within the wait: refused, which fails closed. */
export class ContainmentBusyError extends ContainmentError {}
/** The overall deadline of a replacement passed. */
export class ContainmentDeadlineError extends ContainmentError {}
/** The lock file's token is no longer ours: another process took the lock over. */
export class ContainmentLockLostError extends ContainmentError {}
/** The registry could not be read. */
export class ContainmentUnreadableError extends ContainmentError {}
/**
 * A startup step for the project was rejected; its sandbox's execs are refused until a contain or replace succeeds.
 * With `gate: true` it is the startup gate that failed (the listing of the sandboxes did): the hook then judges each
 * sandbox by its fresh facts instead of refusing every one.
 */
export class ContainmentStartupError extends ContainmentError {
  readonly gate: boolean;
  constructor(message: string, opts: { gate?: boolean } = {}) {
    super(message);
    this.gate = opts.gate ?? false;
  }
}

/** How long things take; a field of the options so that a test can move the clock instead of waiting. */
export interface Clock {
  /** Wall-clock milliseconds: what a lock file's age is judged by. */
  now(): number;
  /** Monotonic milliseconds: what the deadline is judged by. */
  mono(): number;
  /** A timer: resolves after `ms` unless cancelled. */
  after(ms: number): { promise: Promise<void>; cancel(): void };
  /** Wait `ms`. */
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  mono: () => performance.now(),
  after(ms) {
    let timer: NodeJS.Timeout | undefined;
    const promise = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    });
    return { promise, cancel: () => clearTimeout(timer) };
  },
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
};

export const LIMITS = {
  /** The whole replacement, measured from the moment the lock is held. */
  deadlineMs: 90_000,
  /** How long a caller waits for the lock (mutex and file together). */
  lockWaitMs: 60_000,
  /** A lock file older than this belongs to a process that died. Longer than the deadline, so a live holder is never stale. */
  staleMs: 120_000,
  pollMs: 100,
  /** The proxy's resolver failures are read at most this often per project. */
  statusEveryMs: 60_000,
  /** How long "a newer proxy was kept" is remembered. */
  newerMemoryMs: 60_000,
  /** Resolver failures that make the proxy's resolvers suspect. */
  resolverFailures: 3,
} as const;

export const sha256 = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");
