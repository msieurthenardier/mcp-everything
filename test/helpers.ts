import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Connector, Launch } from "../src/proxy/mcp-proxy.js";
import { Docker, type ExecOptions, type ExecResult } from "../src/sandbox/docker.js";
import type { ProjectRecord } from "../src/types.js";

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

export interface ExecCall {
  container: string;
  argv: string[];
  opts: ExecOptions;
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
  ensureCalls: string[] = [];

  /** Nothing here may reach the real docker binary. */
  protected override docker(args: string[]): never {
    throw new Error(`FakeDocker reached the docker binary: ${args.join(" ")}`);
  }
  override async exec(container: string, argv: string[], opts: ExecOptions): Promise<ExecResult> {
    this.calls.push({ container, argv, opts });
    return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false, ...this.next };
  }
  override async ensureRunning(container: string): Promise<boolean> {
    this.ensureCalls.push(container);
    return this.exists;
  }
  override async state(): Promise<"running" | "stopped" | "missing"> {
    return this.stateResult;
  }
  override async setNetwork(container: string, enabled: boolean): Promise<void> {
    this.network.push([container, enabled]);
  }
  override async destroy(container: string): Promise<void> {
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
      upstream.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          { name: "add", description: "Add two numbers", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] } },
          { name: "whoami", description: "Report which launch this is", inputSchema: { type: "object", properties: {} } },
          { name: "hang", description: "Never answers", inputSchema: { type: "object" } },
          { name: "mixed", description: "Returns many content types", inputSchema: { type: "object" } },
        ],
      }));
      upstream.setRequestHandler(CallToolRequestSchema, async (req) => {
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
