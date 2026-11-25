import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import { cleanTerminalText, oneLine } from "../util/text.js";

/** A project's network: `<sandbox name>-net`. */
export function projectNetworkName(sandbox: string): string {
  return `${sandbox}-net`;
}

/** A fresh name for a project's proxy: `<sandbox name>-proxy-<8 hex>`. */
export function newProjectProxyName(sandbox: string): string {
  return `${sandbox}-proxy-${randomBytes(4).toString("hex")}`;
}

/** The network state a list of networks makes, for a sandbox of that name: nothing, its own `-net` only, or anything else. */
export function networkModeOf(sandbox: string, networks: readonly string[]): NetworkMode {
  if (networks.length === 0) return "off";
  return networks.length === 1 && networks[0] === projectNetworkName(sandbox) ? "contained" : "open";
}

/**
 * The proxy's address on a contained network: the last usable host address of its IPv4 subnet (for `172.22.0.0/16`,
 * `172.22.255.254`), never the broadcast address. Contained containers reach the proxy at this address and not by a
 * name, because a name needs Docker's embedded DNS, which gVisor's network stack cannot reach. The networks are made
 * with an `--ip-range` in their lower half, so the daemon never hands this address out. Pure. A `/31`, a `/32` and
 * anything that is not an IPv4 CIDR have no such address and are refused.
 */
export function proxyAddress(subnet: string): string {
  const { base, prefix } = parseSubnet(subnet);
  return dotted(base + 2 ** (32 - prefix) - 2);
}

/**
 * The MAC address every proxy on a network is created with: a locally administered unicast address (`02:` prefix) derived
 * from the network's id, the same for the same id. A proxy that replaces another on the same network thereby has the same
 * IP and the same MAC, so a sandbox's neighbor cache (which gVisor does not refresh) stays right across a replacement. Pure.
 */
export function proxyMac(networkId: string): string {
  const h = createHash("sha256").update(`proxy-mac:${networkId}`).digest();
  return ["02", ...Array.from(h.subarray(0, 5), (b) => b.toString(16).padStart(2, "0"))].join(":");
}

/** The `--network` value that creates a proxy on its network at the proxy's address and MAC (the bridge is connected after the create). */
export function proxyNetworkSpec(net: { id: string; name: string; subnet: string }): string {
  return `name=${net.name},ip=${proxyAddress(net.subnet)},mac-address=${proxyMac(net.id)}`;
}

/**
 * Whether a runtime is runc (`runc`, `io.containerd.runc.v2`), the one that sees a network joined or left while a container
 * runs. An absent runtime counts as the daemon's default. Anything else (gVisor's `runsc`) does not see it.
 */
export function isRuncRuntime(runtime: string | null | undefined, daemonDefault?: string): boolean {
  const r = runtime !== undefined && runtime !== null && runtime !== "" ? runtime : daemonDefault !== undefined && daemonDefault !== "" ? daemonDefault : "runc";
  return r === "runc" || r === "io.containerd.runc.v2";
}

function parseSubnet(subnet: string): { base: number; prefix: number } {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(subnet);
  if (!m) throw new Error(`Not an IPv4 subnet: ${oneLine(subnet, 80)}`);
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) throw new Error(`Not an IPv4 subnet: ${oneLine(subnet, 80)}`);
  const prefix = Number(m[5]);
  if (prefix < 1 || prefix > 30) throw new Error(`The subnet ${oneLine(subnet, 80)} has no room for a proxy address (it needs a prefix of /1 to /30)`);
  const ip = ((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (ip & mask) >>> 0, prefix };
}

const dotted = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

/** The lower half of a subnet, as the `--ip-range` a contained network is made with (`172.22.0.0/16` gives `172.22.0.0/17`). */
export function lowerHalf(subnet: string): string {
  const { base, prefix } = parseSubnet(subnet);
  return `${dotted(base)}/${prefix + 1}`;
}

/** The marker that ends each line mcp-everything writes into a sandbox's `/etc/hosts`. */
export const LOCAL_ACCESS_MARK = "# mcpe-local-access";
/**
 * The script a root `docker exec` runs to put the local-access lines into `/etc/hosts` (`sh -c SCRIPT sh <lines> <file>`).
 * Idempotent: it does nothing when the marked lines are already the wanted ones. Otherwise it builds the new content
 * (every line that is not marked, then the wanted lines) and writes it with ONE `printf` redirected into the file:
 * no `sed -i` and no `mv`, because `/etc/hosts` is a bind mount that cannot be replaced.
 */
export const LOCAL_ACCESS_SCRIPT = [
  `want="$1"; file="$2"`,
  `have=$(grep '${LOCAL_ACCESS_MARK}$' "$file")`,
  `[ "$have" = "$want" ] && exit 0`,
  `keep=$(grep -v '${LOCAL_ACCESS_MARK}$' "$file")`,
  `if [ -n "$want" ]; then printf '%s\\n%s\\n' "$keep" "$want"; else printf '%s\\n' "$keep"; fi > "$file"`,
].join("\n");
/** Names a forward target may not take in a sandbox's `/etc/hosts`: the sandbox's own (its hostname is `sandbox`). */
export const OWN_HOST_NAMES = new Set(["localhost", "sandbox", "ip6-localhost", "ip6-loopback", "ip6-localnet", "ip6-mcastprefix", "ip6-allnodes", "ip6-allrouters"]);
export const HOSTS_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

export const PROXY_KINDS = ["connect", "http", "forward"] as const;
export const PROXY_REASONS = [
  "not-allowed", "refused-address", "no-address", "resolve-failed", "connect-failed", "timeout", "bad-request", "method", "cap",
] as const;
/** One row of the proxy's refusals, as leg 3's `/status` gives it, after it was checked here. */
export interface ProxyRefusalRow {
  kind: (typeof PROXY_KINDS)[number];
  host: string | null;
  port: number | null;
  reason: (typeof PROXY_REASONS)[number];
  count: number;
  firstAt: string;
  lastAt: string;
}
/** What the proxy refused, read when a one-shot behind it failed; `unavailable` when it could not be read. */
export type ProxyReport = { unavailable: true } | { rows: ProxyRefusalRow[]; total: number; resolverFailures: number };

const MAX_REPORT_ROWS = 50;
const isCount = (n: unknown, min: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= min;

/**
 * The proxy's `/status` as a report. Nothing in it is trusted: the shape is checked, `kind` and `reason` must be in
 * leg 3's vocabularies, a row that is not valid is dropped (at most 50 are kept), text is cleaned and cut, and an
 * answer that is not an object with a rows array and two counts is `unavailable`.
 */
export function parseProxyReport(value: unknown): ProxyReport {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { unavailable: true };
  const v = value as { refusals?: unknown; total?: unknown; resolverFailures?: unknown };
  if (!Array.isArray(v.refusals) || !isCount(v.total, 0) || !isCount(v.resolverFailures, 0)) return { unavailable: true };
  const rows: ProxyRefusalRow[] = [];
  // Look at no more than a bounded number of entries, whatever the array holds.
  for (const raw of v.refusals.slice(0, MAX_REPORT_ROWS * 4)) {
    if (rows.length >= MAX_REPORT_ROWS) break;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    if (!(PROXY_KINDS as readonly unknown[]).includes(r.kind) || !(PROXY_REASONS as readonly unknown[]).includes(r.reason)) continue;
    if (r.host !== null && (typeof r.host !== "string" || r.host.length > 253)) continue;
    if (r.port !== null && !(isCount(r.port, 1) && r.port <= 65535)) continue;
    if (!isCount(r.count, 1) || typeof r.firstAt !== "string" || typeof r.lastAt !== "string") continue;
    rows.push({
      kind: r.kind as ProxyRefusalRow["kind"],
      host: r.host === null ? null : cleanTerminalText(r.host as string),
      port: r.port as number | null,
      reason: r.reason as ProxyRefusalRow["reason"],
      count: r.count,
      firstAt: cleanTerminalText(r.firstAt).slice(0, 64),
      lastAt: cleanTerminalText(r.lastAt).slice(0, 64),
    });
  }
  return { rows, total: v.total, resolverFailures: v.resolverFailures };
}

/** The nameservers of a resolv.conf that the proxy may use: IPv4 and IPv6 literals, no loopback, IPv4 first. */
export function parseResolvConf(text: string): string[] {
  const v4: string[] = [];
  const v6: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*nameserver\s+(\S+)\s*(?:#.*)?$/.exec(line);
    if (!m) continue;
    const a = m[1]!;
    if (a.includes("%")) continue;
    if (net.isIPv4(a)) {
      if (a.startsWith("127.") || a === "0.0.0.0") continue;
      if (!v4.includes(a)) v4.push(a);
    } else if (net.isIPv6(a)) {
      const lower = a.toLowerCase();
      if (lower === "::1" || lower === "::" || lower.startsWith("::ffff:127.")) continue;
      if (!v6.includes(a)) v6.push(a);
    }
  }
  return [...v4, ...v6];
}

/** The network a sandbox is on: none, its own project network only, or `bridge` (or anything else). */
export type NetworkMode = "off" | "contained" | "open";
