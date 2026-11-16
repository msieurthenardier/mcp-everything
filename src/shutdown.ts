// Measured against the proxy's kill step, a `docker exec` limited to 10 s
// (mcp-proxy.ts): the deadline leaves it room to finish and still ends the
// process promptly when closing a proxied server hangs.
export const SHUTDOWN_DEADLINE_MS = 15_000;

export interface BoundedShutdownOptions {
  close: () => Promise<unknown>;
  exit: (code: number) => void;
  deadlineMs: number;
  log?: (line: string) => void;
}

/**
 * Returns a handler that runs `close` once and then exits 0 (also when it
 * rejects), or exits 1 if it has not settled within the deadline. Calling the
 * handler again does nothing.
 */
export function boundedShutdown(opts: BoundedShutdownOptions): () => void {
  let started = false;
  let exited = false;
  const exitOnce = (code: number): void => {
    if (exited) return;
    exited = true;
    opts.exit(code);
  };
  return () => {
    if (started) return;
    started = true;
    // Not unref'd: it must fire even when nothing else keeps the loop alive.
    const timer = setTimeout(() => {
      opts.log?.(`shutdown did not finish within ${opts.deadlineMs / 1000} s; exiting`);
      exitOnce(1);
    }, opts.deadlineMs);
    const settled = (): void => {
      clearTimeout(timer);
      exitOnce(0);
    };
    let pending: Promise<unknown>;
    try {
      pending = opts.close();
    } catch (e) {
      pending = Promise.reject(e);
    }
    pending.then(settled, settled);
  };
}
