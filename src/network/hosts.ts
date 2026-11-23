import net from "node:net";
import { domainToASCII } from "node:url";

/**
 * The grammar of a host entry: what the agent may add to a project's `hosts` (mode "agent"), what an
 * operator's MCPE_LOCAL_ACCESS names ("local-access") and what a scanner's `hosts` may hold ("scanner").
 * Pure: no DNS, no I/O. The resolve-time range check (leg 3) is the real boundary; this grammar gives an
 * early, clear refusal and normalizes what is stored.
 *
 * Order of checks. It matters: `url.domainToASCII` rewrites IPv4 shorthand into dotted quads ("127.1",
 * "0x7f.1" and "2130706433" all become "127.0.0.1") while `net.isIP` of the raw input is 0, so a name must
 * be judged on the converted form, and only after the one trailing dot is gone (otherwise "1.2.3.4." would
 * pass as a name). Each step has a name, carried on HostEntryError.step:
 *   1. raw       empty, over 300 characters, whitespace, control characters, @ / \ % ? #, a scheme.
 *   2. port      split off the port; `[addr]` or `[addr]:port`, else after the last colon; a second colon
 *                outside brackets is refused. No port means [443, 80]; a named port means only that port.
 *   3. literal   a bracketed host is an IPv6 literal, a dotted quad an IPv4 literal. Accepted only in
 *                "scanner" mode.
 *   4. name      ASCII names match [A-Za-z0-9.*-] and are lower-cased; they go through domainToASCII only when
 *                a label starts with "xn--". Non-ASCII names go through domainToASCII. An empty result is
 *                refused. The converted form is what is stored.
 *   5. on the result, in this order: remove ONE trailing dot; refuse empty labels; split off a leading "*."
 *      as the wildcard flag (a "*" anywhere else is refused, step wildcard); then on the remaining name
 *      refuse an IP literal outside scanner mode (literal), refuse a last label that ends in a number in the
 *      WHATWG sense (number), check each label (label), the 253-character limit and, for a non-wildcard, two
 *      labels (label).
 *   6. local     "agent" mode only: refuse a last label that names a local network.
 *   7. wildcard  only "*." as the whole first label, in "agent" and "scanner" modes; refuse `*.<tld>` and
 *                `*.<x>.<cc>` (a heuristic, see TWO_LABEL_PREFIXES; not a public-suffix list).
 *
 * `*.example.com` does not match `example.com` itself; the grammar only records the flag, and matching is
 * the proxy's.
 */

export type HostMode = "agent" | "local-access" | "scanner";

export type HostStep = "raw" | "port" | "literal" | "name" | "number" | "label" | "local" | "wildcard";

export class HostEntryError extends Error {
  constructor(
    readonly step: HostStep,
    message: string,
  ) {
    super(message);
    this.name = "HostEntryError";
  }
}

export interface HostEntry {
  /** Normalized: lower-case, ASCII, no trailing dot, no wildcard prefix; an IPv6 literal is bracketed. */
  host: string;
  /** The entry began with "*.". */
  wildcard: boolean;
  /** [443, 80] when no port was named; otherwise just the named port. */
  ports: number[];
  /** An IP literal (scanner mode only). */
  literal: boolean;
}

/** The port the proxy listens on; no local-access target may use it. */
export const PROXY_PORT = 3128;

/**
 * The second-level labels that, under a two-letter TLD, make `*.<x>.<cc>` too broad (`*.co.uk`). A heuristic,
 * not a public-suffix list: hosting suffixes such as `*.github.io` or `*.pages.dev` pass.
 */
export const TWO_LABEL_PREFIXES: readonly string[] = [
  "co", "com", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "gob", "nic", "mil", "ltd", "plc", "sch",
];

/** Last labels that name a local network. */
const LOCAL_LABELS = new Set(["localhost", "local", "internal", "lan", "home", "arpa", "localdomain"]);

const MAX_RAW = 300;
const MAX_NAME = 253;

function refuse(step: HostStep, message: string): never {
  throw new HostEntryError(step, message);
}

function checkRaw(raw: string): void {
  if (raw.length === 0) refuse("raw", "is empty");
  if (raw.length > MAX_RAW) refuse("raw", `is longer than ${MAX_RAW} characters`);
  if (raw.includes("://")) refuse("raw", "must be a host name, not a URL (no scheme)");
  if (/[\s\u0000-\u001f\u007f-\u009f]/.test(raw)) refuse("raw", "contains whitespace or a control character");
  if (/[@/\\%?#]/.test(raw)) refuse("raw", "contains a character not allowed in a host (@ / \\ % ? #)");
}

function parsePort(text: string): number {
  if (!/^[1-9][0-9]{0,4}$/.test(text)) refuse("port", `port "${text}" must be a whole number from 1 to 65535 with no leading zero`);
  const n = Number(text);
  if (n > 65535) refuse("port", `port "${text}" must be a whole number from 1 to 65535`);
  return n;
}

/** Split `raw` into the host part (brackets kept) and the named port, if any. */
function splitPort(raw: string): { hostPart: string; port?: number } {
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    if (close < 0) refuse("port", "has an opening [ with no closing ]");
    const rest = raw.slice(close + 1);
    const hostPart = raw.slice(0, close + 1);
    if (rest === "") return { hostPart };
    if (!rest.startsWith(":")) refuse("port", "has text after the closing ] that is not a :port");
    return { hostPart, port: parsePort(rest.slice(1)) };
  }
  const first = raw.indexOf(":");
  if (first < 0) return { hostPart: raw };
  if (raw.indexOf(":", first + 1) >= 0) refuse("port", "has more than one colon; an IPv6 literal needs brackets, as in [::1]:443");
  const hostPart = raw.slice(0, first);
  if (hostPart === "") refuse("port", "has a port but no host");
  return { hostPart, port: parsePort(raw.slice(first + 1)) };
}

function ports(port: number | undefined): number[] {
  return port === undefined ? [443, 80] : [port];
}

function ipv4Canonical(host: string): boolean {
  return net.isIPv4(host) && host.split(".").every((o) => o === String(Number(o)));
}

function literalRefusal(): never {
  return refuse("literal", "is an IP literal; use a host name");
}

function bracketed(hostPart: string, mode: HostMode, port: number | undefined): HostEntry {
  if (mode !== "scanner") literalRefusal();
  const inner = hostPart.slice(1, -1);
  if (!/^[0-9a-fA-F:.]+$/.test(inner) || !inner.includes(":")) refuse("literal", "has brackets around something that is not an IPv6 address");
  let canonical: string;
  try {
    canonical = new URL(`http://[${inner}]`).hostname;
  } catch {
    return refuse("literal", "has brackets around something that is not an IPv6 address");
  }
  return { host: canonical, wildcard: false, ports: ports(port), literal: true };
}

/** Step 4: the name as stored, lower-cased and converted to ASCII where needed. */
function toAsciiName(hostPart: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\u0000-\u007f]*$/.test(hostPart)) {
    if (!/^[A-Za-z0-9.*-]+$/.test(hostPart)) refuse("name", "contains a character other than letters, digits, dots, hyphens and a leading *");
    const lower = hostPart.toLowerCase();
    if (!lower.split(".").some((l) => l.startsWith("xn--"))) return lower;
    const converted = domainToASCII(lower);
    if (converted === "") refuse("name", "is not a valid internationalized name");
    return converted;
  }
  const converted = domainToASCII(hostPart);
  if (converted === "") refuse("name", "is not a valid internationalized name");
  return converted;
}

function endsInNumber(label: string): boolean {
  return /^[0-9]+$/.test(label) || /^0[xX][0-9a-fA-F]*$/.test(label);
}

/**
 * Parse one host entry. `raw` may be "name", "name:port", "*.name", "[v6]:port" or (scanner mode) a literal.
 * Throws HostEntryError; every stored value is the normalized form.
 */
export function parseHostEntry(raw: string, mode: HostMode): HostEntry {
  // 1
  checkRaw(raw);
  // 2
  const { hostPart, port } = splitPort(raw);
  // 3
  if (hostPart.startsWith("[")) return bracketed(hostPart, mode, port);
  if (net.isIPv4(hostPart)) {
    if (mode !== "scanner") literalRefusal();
    if (!ipv4Canonical(hostPart)) refuse("number", "has a number with a leading zero in a dotted address");
    return { host: hostPart, wildcard: false, ports: ports(port), literal: true };
  }
  // 4
  let name = toAsciiName(hostPart);
  // 5
  if (name.endsWith(".")) name = name.slice(0, -1);
  if (name === "" || name.split(".").some((l) => l === "")) refuse("label", "has an empty label");
  let wildcard = false;
  if (name.startsWith("*.")) {
    wildcard = true;
    name = name.slice(2);
  }
  if (name.includes("*")) refuse("wildcard", "may have * only as the whole first label, as in *.example.com");
  if (wildcard && mode === "local-access") refuse("wildcard", "may not have a wildcard in a local-access target");
  if (net.isIP(name) !== 0) {
    if (mode !== "scanner" || wildcard) literalRefusal();
    if (!ipv4Canonical(name)) refuse("number", "is not a dotted IPv4 address");
    return { host: name, wildcard: false, ports: ports(port), literal: true };
  }
  const labels = name.split(".");
  const last = labels[labels.length - 1]!;
  if (endsInNumber(last)) refuse("number", "has a last label that is a number, which resolvers read as an IPv4 address");
  for (const l of labels) {
    if (l.length < 1 || l.length > 63 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(l)) {
      refuse("label", `has a label "${l.slice(0, 20)}" that is not 1 to 63 letters, digits or hyphens, starting and ending with a letter or digit`);
    }
  }
  if (name.length > MAX_NAME) refuse("label", `is longer than ${MAX_NAME} characters`);
  if (!wildcard && labels.length < 2) refuse("label", "needs at least two labels, as in example.com");
  // 6
  if (mode === "agent" && LOCAL_LABELS.has(last)) refuse("local", `ends in .${last}, a local name; the sandbox cannot reach local networks`);
  // 7
  if (wildcard) {
    if (labels.length < 2) refuse("wildcard", "may not be *.<tld>; name a domain");
    if (labels.length === 2 && /^[a-z]{2}$/.test(last) && TWO_LABEL_PREFIXES.includes(labels[0]!)) {
      refuse("wildcard", `*.${name} covers a whole registry suffix; name a domain under it`);
    }
  }
  return { host: name, wildcard, ports: ports(port), literal: false };
}

/** The stored text of an entry: `host` or `host:port` (a port only when one was named), `*.` kept. */
export function formatHostEntry(entry: HostEntry): string {
  return `${entry.wildcard ? "*." : ""}${entry.host}${entry.ports.length === 1 ? `:${entry.ports[0]}` : ""}`;
}

/** The most entries one `hosts`, `add` or `remove` list may hold. */
export const MAX_HOST_LIST = 64;

/** The agent's entries, each parsed in agent mode and normalized, de-duplicated and sorted. Throws HostEntryError on the first bad one. */
export function normalizeAgentHosts(list: readonly string[]): string[] {
  return [...new Set(list.map((raw) => formatHostEntry(parseHostEntry(raw, "agent"))))].sort();
}

/**
 * A project's recorded `hosts` united with entries to add: the added ones are parsed and normalized (HostEntryError
 * on a bad one); what is recorded is kept as it is, even an entry that no longer parses (a hand-edited file must not
 * break the tools that merge into it; the allowance drops such an entry with a warning). Anything that is not a
 * string is dropped. Sorted, de-duplicated.
 */
export function unionHosts(current: unknown, add: readonly string[]): string[] {
  const kept = Array.isArray(current) ? current.filter((x): x is string => typeof x === "string") : [];
  return [...new Set([...kept, ...normalizeAgentHosts(add)])].sort();
}
