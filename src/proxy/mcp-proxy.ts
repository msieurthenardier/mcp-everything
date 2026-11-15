import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import type { Docker } from "../sandbox/docker.js";
import type { McpServerSpec } from "../types.js";
import { cleanTerminalText } from "../util/text.js";

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
  container: string;
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

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,100}$/;

/** Validate a server environment: names are identifiers, values single-line. */
export function validateEnv(env: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_NAME.test(key)) throw new Error(`Invalid environment variable name "${key}"`);
    if (typeof value !== "string") throw new Error(`Environment variable ${key} must be a string`);
    if (/[\r\n\u0000]/.test(value)) throw new Error(`Environment variable ${key} must not contain line breaks`);
    out[key] = value;
  }
  return out;
}

// Records the server's PID, then becomes the server. $0 is the pid file.
const LAUNCH_SCRIPT = 'echo $$ > "$0" && exec "$@"';
// Stops the recorded process and its direct children. $1 is the pid file.
const KILL_SCRIPT =
  'p=$(cat "$1" 2>/dev/null) || exit 0; rm -f "$1"; pkill -TERM -P "$p" 2>/dev/null; kill -TERM "$p" 2>/dev/null; exit 0';

/** The real connector: `docker exec -i <container> <server argv>` over stdio. */
export function dockerConnector(cfg: Config): Connector {
  return ({ container, server, pidFile }) => {
    const args = ["exec", "-i", "-w", server.cwd];
    let envFile: string | undefined;
    if (Object.keys(server.env).length > 0) {
      // Secrets travel in a private file, not in argv (visible to `ps`) and not
      // in the docker CLI's own environment (which they could then influence).
      const dir = path.join(cfg.dataDir, "tmp");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      envFile = path.join(dir, `env-${randomBytes(8).toString("hex")}`);
      const lines = Object.entries(validateEnv(server.env)).map(([k, v]) => `${k}=${v}\n`);
      fs.writeFileSync(envFile, lines.join(""), { mode: 0o600 });
      args.push("--env-file", envFile);
    }
    args.push(container, "sh", "-c", LAUNCH_SCRIPT, pidFile, ...server.argv);

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
      cleanup: () => {
        if (envFile) fs.rmSync(envFile, { force: true });
      },
    };
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

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

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
    await this.docker
      .exec(launch.container, ["sh", "-c", KILL_SCRIPT, "sh", launch.pidFile], { timeoutSec: 10, restart: false })
      .catch(() => undefined);
  }

  /** One launch and handshake. On failure the client is closed and the server killed. */
  private async attempt(
    container: string,
    server: McpServerSpec,
    startupSec: number,
  ): Promise<{ ok: true; client: Client; launch: Launch; conn: Connection } | { ok: false; message: string }> {
    const launch: Launch = { container, server, pidFile: `/tmp/mcpe-mcp-${randomBytes(6).toString("hex")}.pid` };
    const conn = this.connector(launch);
    const client = new Client({ name: "mcp-everything", version: "0.1.0" }, { capabilities: {} });
    try {
      await client.connect(conn.transport, { timeout: startupSec * 1000 });
      return { ok: true, client, launch, conn };
    } catch (e) {
      await client.close().catch(() => undefined);
      await this.kill(launch);
      const stderr = conn.stderr();
      const reason =
        e instanceof McpError && e.code === ErrorCode.RequestTimeout
          ? `no MCP handshake within ${startupSec}s`
          : describeError(e);
      return {
        ok: false,
        message:
          `MCP server "${server.name}" (${server.argv.join(" ")}) did not start: ${reason}` +
          (stderr ? `\n--- server stderr ---\n${stderr.slice(-1500)}` : ""),
      };
    } finally {
      conn.cleanup?.();
    }
  }

  private async open(key: string, container: string, server: McpServerSpec, startupSec: number): Promise<Session> {
    if (!(await this.docker.ensureRunning(container))) {
      throw new Error(`The sandbox ${container} no longer exists; reinstall the project.`);
    }
    let attempt = await this.attempt(container, server, startupSec);
    if (!attempt.ok) {
      // A sandbox that idled out between the check above and the launch fails
      // the handshake at once; start it and launch once more.
      let restartNote = "";
      let restarted = false;
      const stopped = await this.docker.state(container).then((st) => st === "stopped", () => false);
      if (stopped) {
        try {
          restarted = await this.docker.ensureRunning(container);
          if (!restarted) restartNote = `\n(restarting the sandbox failed: ${container} no longer exists)`;
        } catch (e) {
          restartNote = `\n(restarting the sandbox failed: ${describeError(e)})`;
        }
      }
      if (restarted) {
        const second = await this.attempt(container, server, startupSec);
        if (second.ok) attempt = second;
        else throw new Error(second.message.replace("did not start:", "did not start (after restarting the sandbox):"));
      } else {
        throw new Error(attempt.message + restartNote);
      }
    }
    const { client, launch, conn } = attempt;
    const session: Session = { key, client, launch, stderr: conn.stderr, lastUsed: Date.now(), inFlight: 0 };
    // The server exiting on its own retires the session; the next call restarts it.
    client.onclose = () => {
      void this.sessions.get(key)?.then(
        (current) => {
          if (current === session) this.sessions.delete(key);
        },
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
      for (let page = 0; page < 10; page++) {
        const res = await session.client.listTools(cursor ? { cursor } : undefined, { timeout: 30_000 });
        for (const t of res.tools) {
          tools.push({
            name: t.name,
            description: typeof t.description === "string" ? t.description : "",
            inputSchema: t.inputSchema as Record<string, unknown>,
          });
        }
        cursor = res.nextCursor;
        if (!cursor || tools.length >= 500) break;
      }
      return tools;
    } catch (e) {
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
      return await session.client.callTool({ name: tool, arguments: args }, undefined, { timeout: timeoutSec * 1000 });
    } catch (e) {
      const code = e instanceof McpError ? e.code : undefined;
      if (code === ErrorCode.RequestTimeout) {
        // A server that stopped answering is restarted on the next call.
        await this.closeSession(session.key);
        throw new Error(`MCP tool "${tool}" timed out after ${timeoutSec}s; the server was stopped and will restart on the next call.`);
      }
      if (code === ErrorCode.ConnectionClosed || !(e instanceof McpError)) {
        const stderr = session.stderr();
        await this.closeSession(session.key);
        throw new Error(
          `MCP server "${server.name}" stopped while running "${tool}": ${describeError(e)}` +
            (stderr ? `\n--- server stderr ---\n${stderr.slice(-1500)}` : ""),
        );
      }
      throw new Error(`MCP server "${server.name}" rejected the call to "${tool}": ${e.message}`);
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
      const session = await pending.catch(() => null);
      if (session && session.inFlight === 0 && now - session.lastUsed > this.cfg.mcpIdleSec * 1000) {
        await this.closeSession(key);
      }
    }
  }

  private startReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => void this.reapIdle().catch(() => undefined), 60_000);
    this.reaper.unref();
  }

  /** Number of live upstream sessions (for diagnostics and tests). */
  get size(): number {
    return this.sessions.size;
  }
}
