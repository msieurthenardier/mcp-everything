import { createHash } from "node:crypto";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { Server, type Tool } from "@modelcontextprotocol/server";
import type { Connector, Launch } from "../src/proxy/mcp-proxy.js";
import type { Config } from "../src/config.js";
import { Docker, type ExecOptions, type ExecResult, type OwnershipReport, type SandboxRef } from "../src/sandbox/docker.js";
import type { ProjectRecord } from "../src/types.js";

/** The installation id every test double carries unless a test passes another. */
export const TEST_INSTALLATION_ID = "0123abcd";

/** A minimal ready project record for tests. */
export function record(slug: string, repoPath = `owner/${slug}`): ProjectRecord {
  return {
    slug,
    repo: { forge: "github", host: "github.com", path: repoPath, cloneUrl: `https://github.com/${repoPath}.git`, id: `github:${repoPath}`, name: slug },
    image: "img",
    container: `mcpe-${slug}`,
    volume: `mcpe-${slug}`,
    ecosystems: ["generic"],
    primary: "generic",
    network: false,
    status: "ready",
    warnings: [],
    commands: [],
    tools: [],
    meta: { npmScripts: [], makeTargets: [], pythonModules: [], nodePackages: [], hasPythonEnv: false, hasNode: false },
    installedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** What the Docker layer takes where a sandbox goes: a name, or a checked reference. */
export type SandboxTarget = string | SandboxRef;

/** The name of a sandbox, whichever way it was given. */
export const targetName = (target: SandboxTarget): string => (typeof target === "string" ? target : target.name);

/** The id a double gives a sandbox: 64 hex characters derived from its name, so the same name always has the same id. */
export const fakeSandboxId = (name: string): string => createHash("sha256").update(name).digest("hex");

export interface ExecCall {
  /** The sandbox's name, whether the call gave a name or a reference. */
  container: string;
  argv: string[];
  opts: ExecOptions;
  /** The reference the call was given; undefined when it was given a name. */
  sandbox?: SandboxRef;
}

/** Docker double: records what would run and replays canned results. */
export class FakeDocker extends Docker {
  calls: ExecCall[] = [];
  next: Partial<ExecResult> = {};
  exists = true;
  network: Array<[string, boolean]> = [];
  destroyed: string[] = [];
  /** What `state` reports; a failed handshake consults it. */
  stateResult: "running" | "stopped" | "missing" = "running";
  /** The name of every `acquire` and `ensureRunning`, in order. */
  ensureCalls: string[] = [];
  /** The references `acquire` handed out, in order. */
  acquired: SandboxRef[] = [];
  /** The reference of each `network` entry, in step with it; undefined where a name was given. */
  networkRefs: Array<SandboxRef | undefined> = [];
  /** When set, `acquire` throws it (a `SandboxRefusedError` or a `DockerUnavailableError`). */
  acquireError?: Error;
  /** When set, `destroy` throws it. */
  destroyError?: Error;
  /** What `ownership` reports. */
  ownershipResult: OwnershipReport = { state: "mine" };
  /** When set, `ownership` throws it (the real method never does; a test of the server's own guard uses this). */
  ownershipError?: Error;
  /** The name of every `ownership` question, in order. */
  ownershipCalls: string[] = [];

  constructor(cfg: Config, installationId: string = TEST_INSTALLATION_ID) {
    super(cfg, installationId);
  }

  /** Nothing here may reach the real docker binary. */
  protected override docker(args: string[]): never {
    throw new Error(`FakeDocker reached the docker binary: ${args.join(" ")}`);
  }
  override async acquire(name: string): Promise<SandboxRef | undefined> {
    this.ensureCalls.push(name);
    if (this.acquireError) throw this.acquireError;
    if (!this.exists) return undefined;
    const ref = Object.freeze({ id: fakeSandboxId(name), name });
    this.acquired.push(ref);
    return ref;
  }
  override async ownership(name: string): Promise<OwnershipReport> {
    this.ownershipCalls.push(name);
    if (this.ownershipError) throw this.ownershipError;
    return this.ownershipResult;
  }
  override async exec(target: SandboxTarget, argv: string[], opts: ExecOptions): Promise<ExecResult> {
    this.calls.push({ container: targetName(target), argv, opts, sandbox: typeof target === "string" ? undefined : target });
    return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false, ...this.next };
  }
  override async ensureRunning(target: SandboxTarget): Promise<boolean> {
    this.ensureCalls.push(targetName(target));
    return this.exists;
  }
  override async state(): Promise<"running" | "stopped" | "missing"> {
    return this.stateResult;
  }
  override async setNetwork(target: SandboxTarget, enabled: boolean): Promise<void> {
    this.network.push([targetName(target), enabled]);
    this.networkRefs.push(typeof target === "string" ? undefined : target);
  }
  override async destroy(container: string): Promise<void> {
    if (this.destroyError) throw this.destroyError;
    this.destroyed.push(container);
  }
  override async removeContainer(container: string): Promise<void> {
    this.destroyed.push(`container:${container}`);
  }
}

export interface FakeUpstream {
  connector: Connector;
  /** Every launch the proxy asked for, in order. */
  launches: Launch[];
  /** Arguments of every tools/call the upstream received. */
  received: Array<{ name: string; arguments: unknown }>;
  /** When false, launched servers never answer the handshake. */
  answer: boolean;
  /** Optional finer control: only launches this accepts are answered. */
  answerIf?: (launch: Launch) => boolean;
  /** Live upstream server objects, to simulate a crash with .close(). */
  servers: Server[];
}

/**
 * An in-memory stand-in for MCP servers inside a sandbox. Each launch gets a
 * fresh upstream server with a few tools that exercise the proxy's paths.
 */
export function fakeUpstream(): FakeUpstream {
  const state: FakeUpstream = { launches: [], received: [], answer: true, servers: [], connector: () => { throw new Error("unset"); } };
  state.connector = (launch) => {
    state.launches.push(launch);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    if (state.answer && (state.answerIf?.(launch) ?? true)) {
      const upstream = new Server({ name: "upstream", version: "1" }, { capabilities: { tools: {} } });
      upstream.setRequestHandler("tools/list", async () => ({
        tools: <Tool[]>[
          { name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
          { name: "whoami", description: "Report which launch this is", inputSchema: { type: "object", properties: {} } },
          { name: "hang", description: "Never answers", inputSchema: { type: "object" } },
          { name: "mixed", description: "Returns many content types", inputSchema: { type: "object" } },
        ],
      }));
      upstream.setRequestHandler("tools/call", async (req) => {
        const args = (req.params.arguments ?? {}) as Record<string, unknown>;
        state.received.push({ name: req.params.name, arguments: args });
        switch (req.params.name) {
          case "add":
            return { content: [{ type: "text", text: String(Number(args.a) + Number(args.b)) }] };
          case "whoami":
            return { content: [{ type: "text", text: `${launch.server.name} env=${Object.keys(launch.server.env).join(",")}` }] };
          case "hang":
            return new Promise(() => {});
          case "mixed":
            return {
              isError: true,
              _meta: { injected: true },
              structuredContent: { ignored: true },
              content: [
                { type: "text", text: "x".repeat(300), annotations: { audience: ["user"] } },
                { type: "image", data: "aGk=", mimeType: "image/png" },
                { type: "image", data: "aGk=", mimeType: "text/html; <script>" },
                { type: "resource", resource: { uri: "file:///a.txt", text: "embedded" } },
                { type: "resource_link", uri: "file:///b.txt", name: "b" },
              ],
            };
          default:
            throw new Error(`no such tool ${req.params.name}`);
        }
      });
      state.servers.push(upstream);
      void upstream.connect(serverSide);
    }
    return { transport: clientSide, stderr: () => "upstream stderr tail" };
  };
  return state;
}

/** A distinctive host-environment value; tests that assert it never leaks search for exactly this string. */
export const SECRET_VALUE = "hv-7Qz3kLx9Vb2NmR8tYw4Pa6Ud1Fs0Jc5";
