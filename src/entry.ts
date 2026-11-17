import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { Server, Transport } from "@modelcontextprotocol/server";
import { SHUTDOWN_DEADLINE_MS, boundedShutdown } from "./shutdown.js";

/** What serving hands back: the one thing the entry does with it is close it. */
export interface Serving {
  close(): Promise<void>;
}

export interface EntryWiring {
  /** The stream whose `end` means the client hung up (stdin). */
  input: { on(event: "end", listener: () => void): unknown };
  /** Where SIGINT and SIGTERM arrive (the process). */
  signals: { on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown };
  exit: (code: number) => void;
  /** The part of `App` the wiring uses. */
  app: { shutdown(): Promise<void> };
  /** Starts serving and resolves once it does. */
  serve: () => Promise<Serving>;
  deadlineMs?: number;
  log: (line: string) => void;
  /** The console `guardStdout` redirects; the real one by default. */
  console?: Pick<Console, "debug" | "log" | "info" | "error">;
}

/**
 * Guards stdout first (nothing may reach it but protocol), starts serving, then registers the shutdown on the input's end and on the two
 * signals. A trigger shuts the app down, then closes the serving handle (also
 * when the shutdown failed), then exits, within the deadline. Registering only
 * after serving has started keeps this listener behind the transport's own.
 */
export async function runEntry(w: EntryWiring): Promise<void> {
  guardStdout(w.console ?? console, w.console ?? console);
  const serving = await w.serve();
  const shutdown = boundedShutdown({
    close: async () => {
      try {
        await w.app.shutdown();
      } finally {
        await serving.close();
      }
    },
    exit: w.exit,
    deadlineMs: w.deadlineMs ?? SHUTDOWN_DEADLINE_MS,
    log: w.log,
  });
  // The client hanging up (stdin closing) must also stop proxied servers.
  w.input.on("end", shutdown);
  w.signals.on("SIGINT", shutdown);
  w.signals.on("SIGTERM", shutdown);
}

/**
 * Serves an `App` through the SDK's `serveStdio`: each connection gets its own server instance from the factory, in
 * the revision the client's first message asks for. The process passes no transport (stdio); tests pass one half of
 * an in-memory pair. `legacy` and `onerror` are left at the SDK's defaults.
 */
export function serveApp(app: { createServer(): Server }, transport?: Transport): Serving {
  return serveStdio(() => app.createServer(), transport ? { transport } : undefined);
}

/**
 * stdout carries this process's MCP protocol, so nothing else may write to it. Node's `console.debug`, `console.log`
 * and `console.info` write to stdout; a dependency calling one would put a non-protocol line in the stream. Called
 * first thing at the entry: sends the three to stderr (`console.warn` and `console.error` already go there).
 */
export function guardStdout(c: Pick<Console, "debug" | "log" | "info"> = console, stderr: Pick<Console, "error"> = console): void {
  const toStderr = (...args: unknown[]) => stderr.error(...args);
  c.debug = toStderr;
  c.log = toStderr;
  c.info = toStderr;
}
