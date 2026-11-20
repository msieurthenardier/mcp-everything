import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { Client, ProtocolError, SdkError, SdkErrorCode, type Transport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { Config } from "../config.js";
import type { Docker, SandboxRef } from "../sandbox/docker.js";
import type { McpServerSpec } from "../types.js";
import { cleanTerminalText } from "../util/text.js";
import { VERSION } from "../version.js";

/**
 * Proxies MCP servers that live inside project sandboxes.
 *
 * An upstream server is started with `docker exec -i` and spoken to over
 * stdio; this process is its MCP client. Sessions are opened lazily, shared by
 * all calls to the same server, and shut down when idle.
 */

/** A tool as advertised by an upstream server. Untrusted. */
export interface UpstreamTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface Launch {
  /** The container's name: what a launch reports, and the key of its session. */
  container: string;
  /** The checked container this launch runs in. Commands name its id, never the name. */
  sandbox: SandboxRef;
  server: McpServerSpec;
  /** Where, inside the sandbox, the server's PID is written. */
  pidFile: string;
}

export interface Connection {
  transport: Transport;
  /** Recent stderr of the server process, for error messages. */
  stderr: () => string;
  /** Called once the handshake has succeeded or failed. */
  cleanup?: () => void;
}

/** Creates the transport to an upstream server. Replaceable for tests. */
export type Connector = (launch: Launch) => Connection;

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,100}$/;

/** Matches a value that cannot be carried by the env file (CR, LF or NUL). */
export const UNUSABLE_ENV_VALUE = /[\r\n\u0000]/;

/** Validate a server environment: names are identifiers, values single-line. */
export function validateEnv(env: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_NAME.test(key)) throw new Error(`Invalid environment variable name "${key}"`);
    if (typeof value !== "string") throw new Error(`Environment variable ${key} must be a string`);
    if (UNUSABLE_ENV_VALUE.test(value)) throw new Error(`Environment variable ${key} must not contain line breaks`);
    out[key] = value;
  }
  return out;
}

// Records the server's PID, then becomes the server. $0 is the pid file.
const LAUNCH_SCRIPT = 'echo $$ > "$0" && exec "$@"';
// Stops the recorded process and its direct children. $1 is the pid file.
const KILL_SCRIPT =
  'p=$(cat "$1" 2>/dev/null) || exit 0; rm -f "$1"; pkill -TERM -P "$p" 2>/dev/null; kill -TERM "$p" 2>/dev/null; exit 0';

/** The one shape of an env file's name; the writer and the sweep both use it. */
const ENV_FILE_NAME = /^env-[0-9a-f]{16}$/;
const newEnvFileName = (): string => `env-${randomBytes(8).toString("hex")}`;

/**
 * Removes env files a crash left in `<dataDir>/tmp`. A live file lasts at most
 * one startup timeout plus about 12 seconds, so a file older than the larger of
 * an hour and twice that timeout cannot be in use. This does not cover a
 * neighbor process started with a much larger timeout, or a clock that jumped
 * forward; in both the cost is one failed launch. Only regular files with the
 * exact name are touched; contents are never read. Returns how many it removed.
 */
export function sweepEnvFiles(cfg: Config, now = Date.now(), log: (line: string) => void = () => {}): number {
  const dir = path.join(cfg.dataDir, "tmp");
  const maxAgeMs = Math.max(3600, 2 * cfg.mcpStartupTimeoutSec) * 1000;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log(`env files: could not list ${dir}: ${describeError(e)}`);
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!ENV_FILE_NAME.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || now - stat.mtimeMs <= maxAgeMs) continue;
      fs.unlinkSync(file);
      removed++;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") log(`env files: could not remove ${name}: ${describeError(e)}`);
    }
  }
  return removed;
}

/** The real connector: `docker exec -i <container id> <server argv>` over stdio. */
export function dockerConnector(cfg: Config): Connector {
  return ({ sandbox, server, pidFile }) => {
    const args = ["exec", "-i", "-w", server.cwd];
    let envFile: string | undefined;
    const removeEnvFile = () => {
      if (envFile) fs.rmSync(envFile, { force: true });
    };
    try {
      if (Object.keys(server.env).length > 0) {
        // Secrets travel in a private file, not in argv (visible to `ps`) and not
        // set under their own names in the docker CLI's environment (where they
        // could influence the client itself). The client still inherits
        // mcp-everything's whole environment, prefixed variables included (below).
        const dir = path.join(cfg.dataDir, "tmp");
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const lines = Object.entries(validateEnv(server.env)).map(([k, v]) => `${k}=${v}\n`);
        // Named before the write: a write that fails part-way can leave the file.
        envFile = path.join(dir, newEnvFileName());
        fs.writeFileSync(envFile, lines.join(""), { mode: 0o600 });
        args.push("--env-file", envFile);
      }
      args.push(sandbox.id, "sh", "-c", LAUNCH_SCRIPT, pidFile, ...server.argv);

      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
      const transport = new StdioClientTransport({ command: cfg.docker.bin, args, env, stderr: "pipe" });

      let tail = "";
      (transport.stderr as Readable | null)?.on("data", (chunk: Buffer) => {
        tail = (tail + chunk.toString("utf8")).slice(-4000);
      });
      return {
        transport,
        stderr: () => cleanTerminalText(tail).trim(),
        cleanup: removeEnvFile,
      };
    } catch (e) {
      // The caller never sees a cleanup for a connector that threw, so the file
      // (it holds values) goes here. Best effort: never mask the original error.
      try {
        removeEnvFile();
      } catch {
        /* the original error is the one to report */
      }
      throw e;
    }
  };
}

interface Session {
  key: string;
  client: Client;
  launch: Launch;
  stderr: () => string;
  lastUsed: number;
  inFlight: number;
}

/**
 * An error as the proxy writes it into a message. An error a server sent is
 * `MCP error <code>: <message>`, as the v1 SDK's own message was; an error the
 * client raised itself is its own text.
 */
function describeError(e: unknown): string {
  if (e instanceof ProtocolError) return `MCP error ${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}

/** A locally raised failure that means the server's end of the connection is gone. */
const GONE_CODES: ReadonlySet<string> = new Set([SdkErrorCode.ConnectionClosed, SdkErrorCode.SendFailed, SdkErrorCode.NotConnected]);

/** A tool list is read for at most this many pages, and no further once this many tools are in hand (checked per page). */
const MAX_LIST_PAGES = 10;
const MAX_LIST_TOOLS = 500;

export class McpProxy {
  private readonly sessions = new Map<string, Promise<Session>>();
  private reaper?: NodeJS.Timeout;

  constructor(
    private readonly cfg: Config,
    private readonly docker: Docker,
    private readonly connector: Connector = dockerConnector(cfg),
  ) {}

  /** Sessions are keyed by the full launch spec, so a changed spec never reuses an old process. */
  private key(container: string, server: McpServerSpec): string {
    const spec = JSON.stringify([server.argv, server.cwd, Object.entries(server.env).sort()]);
    return `${container}\n${server.name}\n${createHash("sha256").update(spec).digest("hex").slice(0, 16)}`;
  }

  private async kill(launch: Launch): Promise<void> {
    // Swallows every error on purpose, "could not be asked" included: the kill runs on the reference checked at
    // launch, so it cannot meet a refusal, and a throw here could stop an uninstall before it deletes the record.
    await this.docker
      .exec(launch.sandbox, ["sh", "-c", KILL_SCRIPT, "sh", launch.pidFile], { timeoutSec: 10, restart: false })
      .catch(() => undefined);
  }

  /** One launch and handshake. On failure the client is closed and the server killed. */
  private async attempt(
    sandbox: SandboxRef,
    server: McpServerSpec,
    startupSec: number,
  ): Promise<{ ok: true; client: Client; launch: Launch; conn: Connection } | { ok: false; message: (afterRestart?: boolean) => string }> {
    const launch: Launch = { container: sandbox.name, sandbox, server, pidFile: `/tmp/mcpe-mcp-${randomBytes(6).toString("hex")}.pid` };
    const conn = this.connector(launch);
    const client = new Client({ name: "mcp-everything", version: VERSION }, { capabilities: {} });
    try {
      await client.connect(conn.transport, { timeout: startupSec * 1000 });
      return { ok: true, client, launch, conn };
    } catch (e) {
      // The close swallows its own failure: this branch is reporting the handshake's failure, which `reason` keeps.
      await client.close().catch(() => undefined);
      await this.kill(launch);
      const stderr = conn.stderr();
      const reason =
        e instanceof SdkError && e.code === SdkErrorCode.RequestTimeout
          ? `no MCP handshake within ${startupSec}s`
          : describeError(e);
      return {
        ok: false,
        message: (afterRestart = false) =>
          `MCP server "${server.name}" (${server.argv.join(" ")}) did not start` +
          (afterRestart ? " (after restarting the sandbox)" : "") +
          `: ${reason}` +
          (stderr ? `\n--- server stderr ---\n${stderr.slice(-1500)}` : ""),
      };
    } finally {
      conn.cleanup?.();
    }
  }

  private async open(key: string, container: string, server: McpServerSpec, startupSec: number): Promise<Session> {
    // The one check of this session: a refusal or "could not be asked" rejects the open, and
    // everything after it (the launch, the restart, the second attempt) uses this reference.
    const sandbox = await this.docker.acquire(container);
    if (!sandbox) {
      throw new Error(`The sandbox ${container} no longer exists; reinstall the project.`);
    }
    let first = await this.attempt(sandbox, server, startupSec);
    if (!first.ok) {
      // A sandbox that idled out between the check above and the launch fails
      // the handshake at once; start it and launch once more.
      let restartNote = "";
      let restarted = false;
      // The failure being reported is the handshake's: a typed error from this question (on a held reference, only
      // "could not be asked") reads as "not stopped", and the thrown message below is the handshake's own text.
      const stopped = await this.docker.state(sandbox).then((st) => st === "stopped", () => false);
      if (stopped) {
        try {
          restarted = await this.docker.ensureRunning(sandbox);
          if (!restarted) restartNote = `\n(restarting the sandbox failed: ${container} no longer exists)`;
        } catch (e) {
          // Keeps the original failure and adds this one as a note; a typed error here is reworded into the note.
          restartNote = `\n(restarting the sandbox failed: ${describeError(e)})`;
        }
      }
      if (restarted) {
        const second = await this.attempt(sandbox, server, startupSec);
        if (second.ok) first = second;
        else throw new Error(second.message(true));
      } else {
        throw new Error(first.message() + restartNote);
      }
    }
    const { client, launch, conn } = first;
    const session: Session = { key, client, launch, stderr: conn.stderr, lastUsed: Date.now(), inFlight: 0 };
    // The server exiting on its own retires the session; the next call restarts it.
    client.onclose = () => {
      void this.sessions.get(key)?.then(
        (current) => {
          if (current === session) this.sessions.delete(key);
        },
        // The session's own opening failed: nothing was registered under this key to retire.
        () => undefined,
      );
    };
    this.startReaper();
    return session;
  }

  private session(container: string, server: McpServerSpec, startupSec?: number): Promise<Session> {
    const key = this.key(container, server);
    let pending = this.sessions.get(key);
    if (!pending) {
      pending = this.open(key, container, server, startupSec ?? this.cfg.mcpStartupTimeoutSec);
      this.sessions.set(key, pending);
      // A rejected opening, a refusal or "could not be asked" included, is the caller's to see (it awaits `pending`);
      // this handler only makes sure the failed attempt does not stay in the table, so the next call asks again.
      pending.catch(() => {
        if (this.sessions.get(key) === pending) this.sessions.delete(key);
      });
    }
    return pending;
  }

  private async closeSession(key: string): Promise<void> {
    const pending = this.sessions.get(key);
    if (!pending) return;
    this.sessions.delete(key);
    // Closing a session that never opened is nothing to do; the opening's caller got the error.
    const session = await pending.catch(() => null);
    if (!session) return;
    await session.client.close().catch(() => undefined);
    await this.kill(session.launch);
  }

  /** Ask an upstream server for its tools (starting it if needed). */
  async listTools(container: string, server: McpServerSpec, startupSec?: number): Promise<UpstreamTool[]> {
    const session = await this.session(container, server, startupSec);
    session.inFlight++;
    try {
      const tools: UpstreamTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        // `request`, not `listTools`: the library's `listTools` answers an empty list, without asking, for a
        // server that does not advertise the `tools` capability. `request` validates the result like it does, and
        // answers one page per call, so this loop (not the library's 64-page one) is what bounds the listing.
        const res = await session.client.request(
          { method: "tools/list", params: cursor ? { cursor } : undefined },
          { timeout: 30_000 },
        );
        for (const t of res.tools) {
          tools.push({
            name: t.name,
            description: typeof t.description === "string" ? t.description : "",
            inputSchema: t.inputSchema as Record<string, unknown>,
          });
        }
        cursor = res.nextCursor;
        if (!cursor || tools.length >= MAX_LIST_TOOLS) break;
      }
      return tools;
    } catch (e) {
      // Errors from here on come from an open session, so they are plain errors: the typed ones were
      // thrown by `session()` above, outside this try, and rise unchanged.
      await this.closeSession(session.key);
      throw new Error(`MCP server "${server.name}" failed to list its tools: ${describeError(e)}`);
    } finally {
      session.inFlight--;
      session.lastUsed = Date.now();
    }
  }

  /** Forward a tool call. The raw upstream result is returned; callers must treat it as untrusted. */
  async callTool(
    container: string,
    server: McpServerSpec,
    tool: string,
    args: Record<string, unknown>,
    timeoutSec: number,
  ): Promise<unknown> {
    const session = await this.session(container, server);
    session.inFlight++;
    try {
      return await session.client.callTool({ name: tool, arguments: args }, { timeout: timeoutSec * 1000 });
    } catch (e) {
      // Rewords what happened, in three questions: did the call time out, is the server gone, or did it
      // answer with an error. The typed errors were thrown by `session()` above, outside this try, and rise unchanged.
      if (e instanceof SdkError && e.code === SdkErrorCode.RequestTimeout) {
        // A server that stopped answering is restarted on the next call.
        await this.closeSession(session.key);
        throw new Error(`MCP tool "${tool}" timed out after ${timeoutSec}s; the server was stopped and will restart on the next call.`);
      }
      const neither = !(e instanceof SdkError) && !(e instanceof ProtocolError);
      if (neither || (e instanceof SdkError && GONE_CODES.has(e.code))) {
        const stderr = session.stderr();
        await this.closeSession(session.key);
        throw new Error(
          `MCP server "${server.name}" stopped while running "${tool}": ${describeError(e)}` +
            (stderr ? `\n--- server stderr ---\n${stderr.slice(-1500)}` : ""),
        );
      }
      throw new Error(`MCP server "${server.name}" rejected the call to "${tool}": ${describeError(e)}`);
    } finally {
      session.inFlight--;
      session.lastUsed = Date.now();
    }
  }

  /** Stop every upstream server of one sandbox. */
  async closeProject(container: string): Promise<void> {
    const keys = [...this.sessions.keys()].filter((k) => k.startsWith(`${container}\n`));
    await Promise.all(keys.map((k) => this.closeSession(k)));
  }

  async closeAll(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = undefined;
    await Promise.all([...this.sessions.keys()].map((k) => this.closeSession(k)));
  }

  /** Close sessions that have been idle for longer than the configured limit. */
  async reapIdle(now = Date.now()): Promise<void> {
    for (const [key, pending] of [...this.sessions]) {
      // A session that failed to open is not idle; its caller got the error.
      const session = await pending.catch(() => null);
      if (session && session.inFlight === 0 && now - session.lastUsed > this.cfg.mcpIdleSec * 1000) {
        await this.closeSession(key);
      }
    }
  }

  private startReaper(): void {
    if (this.reaper) return;
    // Idle reaping acts on sessions already open; a failure to reap is retried a minute later.
    this.reaper = setInterval(() => void this.reapIdle().catch(() => undefined), 60_000);
    this.reaper.unref();
  }

  /** Number of live upstream sessions (for diagnostics and tests). */
  get size(): number {
    return this.sessions.size;
  }
}
