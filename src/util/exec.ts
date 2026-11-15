import { spawn } from "node:child_process";

export interface RunOptions {
  stdin?: string;
  /** Hard wall-clock limit enforced on the host side. */
  timeoutMs?: number;
  /** Per-stream capture cap; output beyond it is dropped (and flagged). */
  maxBytes?: number;
  /** Receives output incrementally (stdout and stderr interleaved). */
  onOutput?: (chunk: string) => void;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

/**
 * Run a program with an argv array. Never goes through a shell, so no value
 * passed here can be reinterpreted as shell syntax.
 */
export function run(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const maxBytes = opts.maxBytes ?? 1_000_000;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let truncated = false;
    let timedOut = false;

    const collect = (sink: Buffer[], len: number, chunk: Buffer): number => {
      opts.onOutput?.(chunk.toString("utf8"));
      const room = maxBytes - len;
      if (room <= 0) {
        truncated = true;
        return len;
      }
      if (chunk.length > room) {
        truncated = true;
        sink.push(chunk.subarray(0, room));
        return len + room;
      }
      sink.push(chunk);
      return len + chunk.length;
    };

    child.stdout.on("data", (c: Buffer) => (outLen = collect(out, outLen, c)));
    child.stderr.on("data", (c: Buffer) => (errLen = collect(err, errLen, c)));

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : undefined;

    child.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
        truncated,
      });
    });

    // A program that exits without reading stdin must not crash us with EPIPE.
    child.stdin.on("error", () => {});
    child.stdin.end(opts.stdin ?? "");
  });
}
