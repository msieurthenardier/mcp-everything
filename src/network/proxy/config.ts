import fs from "node:fs";
import type { HostEntry } from "../hosts.js";
import { PROXY_PORT } from "../hosts.js";
import type { LocalTarget } from "../local-access.js";

/**
 * The egress proxy's configuration and delivery. The program itself is `proxy.cjs`, one self-contained
 * CommonJS file that mcp-everything runs with `node -e` in a container; it cannot import this TypeScript,
 * so it receives these values as one JSON argument and re-validates them. Nothing calls this module yet
 * (leg 4 runs the program, leg 5 builds project proxies).
 */

/** Must equal the program's own `PROGRAM_VERSION` (a test checks it). Bump both when the program changes. */
export const PROXY_PROGRAM_VERSION = "1";

/** Where the control endpoint (`GET /status`, loopback inside the proxy) listens. */
export const PROXY_CONTROL_PORT = 3129;

/** The proxy's limits; the program has a default for each, and these are the same fields. */
export interface ProxyLimits {
  connections: number;
  handshakeMs: number;
  attemptMs: number;
  tunnelIdleMs: number;
  upstreamIdleMs: number;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  bindWaitMs: number;
}

export interface ProxyAllowEntry {
  host: string;
  literal: boolean;
  local: boolean;
  ports: number[];
  wildcard: boolean;
}

export interface ProxyConfig {
  allow: ProxyAllowEntry[];
  controlPort: number;
  forwards: LocalTarget[];
  limits: Partial<ProxyLimits>;
  listenCidr: string;
  port: number;
  resolvers: string[];
  version: string;
}

export interface ProxyConfigOptions {
  allow: HostEntry[];
  /** True only for a scanner's hosts (DD12): its entries may reach local addresses. Applies to every entry. */
  local?: boolean;
  forwards?: LocalTarget[];
  listenCidr: string;
  resolvers: string[];
  controlPort?: number;
  limits?: Partial<ProxyLimits>;
}

/** Leg 1 stores an IPv6 literal bracketed; the program wants it bare and canonical (`new URL`'s form). */
function literalHost(host: string): string {
  if (!host.startsWith("[")) return host;
  return new URL(`http://${host}`).hostname.slice(1, -1);
}

/** The same value with every object's keys in sorted order, so that serializing it is canonical. */
function sorted<T>(value: T): T {
  if (Array.isArray(value)) return value.map(sorted) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) out[k] = sorted((value as Record<string, unknown>)[k]);
    return out as T;
  }
  return value;
}

/** Build the program's configuration from leg 1's entries. Keys come out sorted. `port` is always PROXY_PORT. */
export function proxyConfig(opts: ProxyConfigOptions): ProxyConfig {
  const local = opts.local === true;
  return sorted({
    version: PROXY_PROGRAM_VERSION,
    listenCidr: opts.listenCidr,
    port: PROXY_PORT,
    controlPort: opts.controlPort ?? PROXY_CONTROL_PORT,
    allow: opts.allow.map((e) => ({
      host: e.literal ? literalHost(e.host) : e.host,
      wildcard: e.wildcard,
      ports: [...e.ports],
      literal: e.literal,
      local,
    })),
    forwards: (opts.forwards ?? []).map((f) => ({ host: f.host, port: f.port })),
    resolvers: [...opts.resolvers],
    limits: { ...(opts.limits ?? {}) },
  });
}

/**
 * The program's text. It sits beside this module, in `src` under vitest and in `dist` once built; tsc appends
 * a `//# sourceMappingURL=` line to the built copy, which is stripped.
 */
export function proxySource(): string {
  const text = fs.readFileSync(new URL("./proxy.cjs", import.meta.url), "utf8");
  return text.replace(/\n\/\/# sourceMappingURL=[^\n]*\s*$/, "\n");
}

/** The arguments to `node` that run the proxy: `main` gets exactly one argument, the configuration. */
export function proxyLaunchArgs(config: ProxyConfig): string[] {
  return ["-e", `${proxySource()}\n;main(JSON.parse(process.argv[1]))`, JSON.stringify(config)];
}
