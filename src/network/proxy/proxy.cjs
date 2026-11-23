"use strict";
// @ts-check
/*
 * mcp-everything's egress proxy: one self-contained CommonJS file, run with `node -e` in a container.
 * It is the security boundary of network containment, and everything it reads comes from the project's code.
 *
 *  - It allows only the hosts in its configuration, resolves every name itself, classifies every address it
 *    would connect to and connects only to a checked literal address.
 *  - One request per client connection: after the first request or CONNECT the socket is spent.
 *  - It carries the operator's TCP forwards, keeps a bounded list of refusals and reports on loopback.
 *
 * Only `node:` built-ins are required. Nothing starts when the file is required: `main(config)` starts it.
 * `deps` is an optional test seam that production never fills in.
 */

const net = require("node:net");
const http = require("node:http");
const dns = require("node:dns");
const os = require("node:os");
const fs = require("node:fs");
const crypto = require("node:crypto");

/** The program's own version; `PROXY_PROGRAM_VERSION` in config.ts must equal it. */
const PROGRAM_VERSION = "1";

/**
 * @typedef {import("node:net").Socket} Socket
 * @typedef {{host: string, wildcard: boolean, ports: number[], literal: boolean, local: boolean}} AllowEntry
 * @typedef {{host: string, port: number}} Forward
 * @typedef {{connections: number, handshakeMs: number, attemptMs: number, tunnelIdleMs: number, upstreamIdleMs: number, requestTimeoutMs: number, headersTimeoutMs: number, bindWaitMs: number}} Limits
 * @typedef {{version: string, listenCidr: string, port: number, controlPort: number, allow: AllowEntry[], forwards: Forward[], resolvers: string[], limits: Limits}} Config
 * @typedef {{address: string, family: string | number, cidr?: string | null}} IfaceAddr
 * @typedef {Record<string, IfaceAddr[] | undefined>} Interfaces
 * @typedef {{host: string, port: number, family: number, autoSelectFamily: boolean}} ConnectOptions
 * @typedef {{resolve?: (name: string) => Promise<string[]>, connect?: (o: ConnectOptions) => Socket, interfaces?: () => Interfaces, readHosts?: () => string, fault?: (where: string) => void}} Deps
 * @typedef {{cidrs: string[], addrs: string[]}} Own
 * @typedef {"never" | "local" | "public"} AddrClass
 */

const DEFAULT_LIMITS = {
  connections: 256,
  handshakeMs: 15000,
  attemptMs: 5000,
  tunnelIdleMs: 15 * 60 * 1000,
  upstreamIdleMs: 60000,
  requestTimeoutMs: 30000,
  headersTimeoutMs: 10000,
  bindWaitMs: 10000,
};
const MAX_ATTEMPTS = 4;
const MAX_REFUSALS = 50;
/** The one name whose /etc/hosts addresses a forward may reach even inside the proxy's own subnets. */
const GATEWAY_NAME = "host.docker.internal";

// ---------------------------------------------------------------- addresses

/**
 * Strict dotted-decimal IPv4, no leading zeros. Returns the address as a number, or null.
 * @param {string} text
 * @returns {number | null}
 */
function parseIPv4(text) {
  if (typeof text !== "string") return null;
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/**
 * @param {number} n
 * @returns {string}
 */
function formatIPv4(n) {
  return [Math.floor(n / 16777216) % 256, Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256].join(".");
}

/**
 * The program's own IPv6 parser: eight groups, or null. It refuses a zone id, `/`, `@`, `\`, whitespace and
 * non-ASCII by its character set, and takes a dotted tail only under the strict IPv4 rules.
 * @param {string} text
 * @returns {number[] | null}
 */
function parseIPv6(text) {
  if (typeof text !== "string" || text.length < 2 || text.length > 45) return null;
  if (!/^[0-9a-fA-F:.]+$/.test(text)) return null;
  /**
   * @param {string} part
   * @param {boolean} allowTail
   * @returns {number[] | null}
   */
  const side = (part, allowTail) => {
    if (part === "") return [];
    const items = part.split(":");
    /** @type {number[]} */
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const it = String(items[i]);
      if (it.includes(".")) {
        if (!allowTail || i !== items.length - 1) return null;
        const v4 = parseIPv4(it);
        if (v4 === null) return null;
        out.push(Math.floor(v4 / 65536), v4 % 65536);
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(it)) return null;
        out.push(parseInt(it, 16));
      }
    }
    return out;
  };
  const halves = text.split("::");
  if (halves.length > 2) return null;
  if (halves.length === 1) {
    const g = side(text, true);
    return g && g.length === 8 ? g : null;
  }
  const left = side(String(halves[0]), false);
  const right = side(String(halves[1]), true);
  if (!left || !right || left.length + right.length > 7) return null;
  return [...left, ...new Array(8 - left.length - right.length).fill(0), ...right];
}

/**
 * Canonical IPv6 text, the form `new URL("http://[...]").hostname` gives without brackets: lower-case, the
 * first longest run of two or more zero groups compressed, no dotted tail.
 * @param {number[]} g
 * @returns {string}
 */
function formatIPv6(g) {
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (g[i] === 0) {
      let j = i;
      while (j < 8 && g[j] === 0) j++;
      if (j - i > bestLen) {
        bestLen = j - i;
        bestStart = i;
      }
      i = j;
    } else i++;
  }
  const hex = (/** @type {number} */ x) => x.toString(16);
  if (bestLen < 2) return g.map(hex).join(":");
  return `${g.slice(0, bestStart).map(hex).join(":")}::${g.slice(bestStart + bestLen).map(hex).join(":")}`;
}

/**
 * @param {string} text
 * @returns {string | null} the canonical text of an IPv4 or IPv6 literal, or null
 */
function canonicalIP(text) {
  const v4 = parseIPv4(text);
  if (v4 !== null) return text;
  const g = parseIPv6(text);
  return g ? formatIPv6(g) : null;
}

/**
 * @typedef {{v: 4, base: number, bits: number} | {v: 6, base: number[], bits: number}} Cidr
 * @param {string} text
 * @returns {Cidr | null}
 */
function parseCidr(text) {
  if (typeof text !== "string") return null;
  const parts = text.split("/");
  if (parts.length !== 2 || !/^[0-9]{1,3}$/.test(String(parts[1]))) return null;
  const bits = Number(parts[1]);
  const v4 = parseIPv4(String(parts[0]));
  if (v4 !== null) return bits <= 32 ? { v: 4, base: v4, bits } : null;
  const g = parseIPv6(String(parts[0]));
  return g && bits <= 128 ? { v: 6, base: g, bits } : null;
}

/**
 * @param {number} n
 * @param {number} base
 * @param {number} bits
 */
function inV4(n, base, bits) {
  const size = 2 ** (32 - bits);
  return Math.floor(n / size) === Math.floor(base / size);
}

/**
 * @param {number[]} g
 * @param {number[]} base
 * @param {number} bits
 */
function inV6(g, base, bits) {
  let rem = bits;
  for (let i = 0; i < 8 && rem > 0; i++) {
    const shift = 16 - Math.min(16, rem);
    if (((g[i] || 0) >> shift) !== ((base[i] || 0) >> shift)) return false;
    rem -= 16;
  }
  return true;
}

/**
 * @param {Cidr} c
 * @returns {string} the network of a CIDR in canonical text
 */
function networkText(c) {
  if (c.v === 4) {
    const size = 2 ** (32 - c.bits);
    return `${formatIPv4(Math.floor(c.base / size) * size)}/${c.bits}`;
  }
  const g = c.base.map((x, i) => {
    const take = Math.max(0, Math.min(16, c.bits - 16 * i));
    return x & ((0xffff << (16 - take)) & 0xffff);
  });
  return `${formatIPv6(g)}/${c.bits}`;
}

/**
 * The proxy's own subnets and addresses, from os.networkInterfaces(); sorted.
 * @param {Interfaces} ifs
 * @returns {Own}
 */
function ownFrom(ifs) {
  const cidrs = new Set();
  const addrs = new Set();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      const ip = canonicalIP(a.address);
      if (ip === null) continue;
      addrs.add(ip);
      const c = parseCidr(typeof a.cidr === "string" ? a.cidr : "");
      cidrs.add(c ? networkText(c) : `${ip}/${ip.includes(":") ? 128 : 32}`);
    }
  }
  return { cidrs: [...cidrs].sort(), addrs: [...addrs].sort() };
}

/** @type {Record<AddrClass, number>} */
const RANK = { public: 0, local: 1, never: 2 };
/**
 * @param {AddrClass} a
 * @param {AddrClass} b
 * @returns {AddrClass}
 */
const worse = (a, b) => (RANK[a] >= RANK[b] ? a : b);

/**
 * @param {string[]} list
 * @returns {Array<[number, number]>}
 */
function v4Table(list) {
  return list.map((t) => {
    const c = parseCidr(t);
    if (!c || c.v !== 4) throw new Error(`bad table entry ${t}`);
    return [c.base, c.bits];
  });
}

const NEVER4 = v4Table(["0.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32", "100.100.100.200/32"]);
// TEST-NET (192.0.2/24, 198.51.100/24, 203.0.113/24) is deliberately public: the tests use 203.0.113.x as
// public addresses. Do not "fix" it.
const LOCAL4 = v4Table(["10.0.0.0/8", "100.64.0.0/10", "172.16.0.0/12", "192.0.0.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15"]);

/**
 * @param {number} n
 * @param {Array<[number, number]>} table
 */
const inTable4 = (n, table) => table.some(([b, bits]) => inV4(n, b, bits));

/**
 * @param {Cidr[]} own
 * @param {number} n
 */
const own4 = (own, n) => own.some((c) => c.v === 4 && inV4(n, c.base, c.bits));
/**
 * @param {Cidr[]} own
 * @param {number[]} g
 */
const own6 = (own, g) => own.some((c) => c.v === 6 && inV6(g, c.base, c.bits));

/**
 * @param {number} n
 * @param {Cidr[]} own
 * @returns {AddrClass}
 */
function class4(n, own) {
  if (own4(own, n)) return "never";
  if (inTable4(n, NEVER4)) return "never";
  if (inTable4(n, LOCAL4)) return "local";
  return "public";
}

const FD00_EC2_254 = [0xfd00, 0x0ec2, 0, 0, 0, 0, 0, 0x254];

/**
 * IPv6 is an allowlist. The proxy's own subnets come first, then the embeddings (judged by the worse of the
 * embedded IPv4's class and "local"), then never, then local, and only the rest of 2000::/3 is public.
 * @param {number[]} g
 * @param {Cidr[]} own
 * @returns {AddrClass}
 */
function class6(g, own) {
  if (own6(own, g)) return "never";
  const zero = (/** @type {number} */ a, /** @type {number} */ b) => g.slice(a, b).every((x) => x === 0);
  const v4 = (/** @type {number | undefined} */ hi, /** @type {number | undefined} */ lo) => (hi || 0) * 65536 + (lo || 0);
  /** @type {number[] | null} */
  let embedded = null;
  if (zero(0, 5) && g[5] === 0xffff) embedded = [v4(g[6], g[7])]; // ::ffff:0:0/96 mapped
  else if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) embedded = [v4(g[6], g[7])]; // ::ffff:0:0:0/96 SIIT
  else if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) embedded = [v4(g[6], g[7])]; // 64:ff9b::/96 NAT64
  else if (g[0] === 0x2002) embedded = [v4(g[1], g[2])]; // 6to4, bits 16-47
  else if (g[0] === 0x2001 && g[1] === 0) {
    // Teredo: the server is bits 32-63, the client the last 32 bits inverted. Both are judged.
    embedded = [v4(g[2], g[3]), v4((g[6] || 0) ^ 0xffff, (g[7] || 0) ^ 0xffff)];
  }
  if (embedded) {
    /** @type {AddrClass} */
    let cls = "local";
    for (const n of embedded) cls = worse(cls, class4(n, own));
    return cls;
  }
  if (zero(0, 6)) return "never"; // ::/96: "::", "::1" and IPv4-compatible
  if (inV6(g, [0xfe80], 10) || (g[0] || 0) >> 8 === 0xff) return "never"; // fe80::/10, ff00::/8
  if (g.every((x, i) => x === FD00_EC2_254[i])) return "never"; // a cloud metadata address, inside fc00::/7
  if (((g[0] || 0) >> 13) !== 1) return "local"; // everything outside 2000::/3 (fc00::/7, fec0::/10, 64:ff9b:1::/48, 100::/64 ...)
  if (g[0] === 0x2001 && ((g[1] || 0) < 0x200 || g[1] === 0xdb8)) return "local"; // 2001::/23 (not Teredo) and 2001:db8::/32
  return "public";
}

/**
 * Classify an address the proxy would connect to. Unparseable input is "never". `ownCidrs` is checked first,
 * for IPv4, for IPv6 and for an embedded IPv4; then never beats local, which beats public.
 * @param {string} address
 * @param {string[]} ownCidrs
 * @returns {AddrClass}
 */
function classify(address, ownCidrs) {
  const own = [];
  for (const t of ownCidrs || []) {
    const c = parseCidr(t);
    if (c) own.push(c);
  }
  const n = parseIPv4(address);
  if (n !== null) return class4(n, own);
  const g = parseIPv6(address);
  return g ? class6(g, own) : "never";
}

/**
 * The IPv4 addresses an IPv6 address embeds (mapped, SIIT, NAT64, 6to4, Teredo).
 * @param {number[]} g
 * @returns {number[]}
 */
function embeddedV4(g) {
  const out = [];
  const zero = (/** @type {number} */ a, /** @type {number} */ b) => g.slice(a, b).every((x) => x === 0);
  const v4 = (/** @type {number | undefined} */ hi, /** @type {number | undefined} */ lo) => (hi || 0) * 65536 + (lo || 0);
  if ((zero(0, 5) && g[5] === 0xffff) || (zero(0, 4) && g[4] === 0xffff && g[5] === 0) || (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6))) out.push(v4(g[6], g[7]));
  if (g[0] === 0x2002) out.push(v4(g[1], g[2]));
  if (g[0] === 0x2001 && g[1] === 0) out.push(v4(g[2], g[3]), v4((g[6] || 0) ^ 0xffff, (g[7] || 0) ^ 0xffff));
  return out;
}

/**
 * True for the proxy's own interface addresses, or an IPv6 address embedding one.
 * @param {string} address
 * @param {Own} own
 */
function isOwnAddress(address, own) {
  const ip = canonicalIP(address);
  if (ip === null) return true;
  if (own.addrs.includes(ip)) return true;
  const g = parseIPv6(ip);
  return g ? embeddedV4(g).some((n) => own.addrs.includes(formatIPv4(n))) : false;
}

// ---------------------------------------------------------------- authority and matching

/**
 * A host name: [a-z0-9-] labels of 1-63 characters not starting or ending with "-", at most 253 in all,
 * lower-cased with one trailing dot removed, whose last label does not end in a number. Names do not allow
 * "_", consistently with leg 1's grammar. Do not "fix" that.
 * @param {string} text
 * @returns {string | null}
 */
function parseName(text) {
  if (typeof text !== "string" || !/^[A-Za-z0-9.-]+$/.test(text)) return null;
  let h = text.toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h.length === 0 || h.length > 253) return null;
  const labels = h.split(".");
  for (const l of labels) if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) return null;
  const last = String(labels[labels.length - 1]);
  if (/^[0-9]+$/.test(last) || /^0x[0-9a-f]*$/.test(last)) return null;
  return h;
}

/**
 * @param {string} t
 * @returns {number | null}
 */
function parsePort(t) {
  if (!/^[1-9][0-9]{0,4}$/.test(t)) return null;
  const n = Number(t); // t is checked: Number() is never used on unchecked text
  return n <= 65535 ? n : null;
}

/**
 * The strict grammar for a CONNECT target or an absolute-URI authority: `host:port`, `[ipv6]:port`, and with
 * `implicitPort` (plain HTTP) also `host` or `[ipv6]` with an implied 80. Null means 400, never resolved.
 * @param {string} text
 * @param {boolean} [implicitPort]
 * @returns {{host: string, port: number, literal: boolean} | null}
 */
function parseAuthority(text, implicitPort) {
  if (typeof text !== "string" || text.length === 0 || text.length > 300 || !/^[\x21-\x7e]+$/.test(text)) return null;
  /** @type {string | null} */
  let portText = null;
  if (text[0] === "[") {
    const close = text.indexOf("]");
    if (close < 0) return null;
    const rest = text.slice(close + 1);
    if (rest !== "") {
      if (rest[0] !== ":") return null;
      portText = rest.slice(1);
    }
    const g = parseIPv6(text.slice(1, close));
    if (!g) return null;
    const port = portText === null ? (implicitPort ? 80 : null) : parsePort(portText);
    return port === null ? null : { host: formatIPv6(g), port, literal: true };
  }
  const colon = text.indexOf(":");
  let host = text;
  if (colon >= 0) {
    if (text.indexOf(":", colon + 1) >= 0) return null;
    host = text.slice(0, colon);
    portText = text.slice(colon + 1);
  }
  const port = portText === null ? (implicitPort ? 80 : null) : parsePort(portText);
  if (port === null || host === "") return null;
  if (parseIPv4(host) !== null) return { host, port, literal: true };
  const name = parseName(host);
  return name === null ? null : { host: name, port, literal: false };
}

/**
 * @param {string} host
 * @returns {boolean}
 */
const isLiteralHost = (host) => host.includes(":") || parseIPv4(host) !== null;

/**
 * The entry that allows `host:port`, or null. An IP literal matches only a `literal` entry with the same
 * canonical address, and a name never matches a literal entry. When several match, a `local` one wins.
 * @param {AllowEntry[]} entries
 * @param {string} host a host that passed parseAuthority
 * @param {number} port
 * @returns {AllowEntry | null}
 */
function matchEntry(entries, host, port) {
  const literal = isLiteralHost(host);
  /** @type {AllowEntry | null} */
  let found = null;
  for (const e of entries) {
    if (e.literal !== literal || !e.ports.includes(port)) continue;
    // A wildcard entry covers names under it, never the name itself.
    const ok = e.wildcard ? !literal && host.endsWith(`.${e.host}`) : e.host === host;
    if (!ok) continue;
    if (e.local) return e;
    if (!found) found = e;
  }
  return found;
}

// ---------------------------------------------------------------- configuration

/**
 * @param {unknown} v
 * @returns {string}
 */
function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = /** @type {Record<string, unknown>} */ (v);
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/**
 * Validate the one JSON configuration. Throws an Error whose message is the one-line reason.
 * @param {unknown} raw
 * @returns {Config}
 */
function validateConfig(raw) {
  /** @returns {never} */
  const fail = (/** @type {string} */ msg) => {
    throw new Error(`config: ${msg}`);
  };
  const isObj = (/** @type {unknown} */ v) => !!v && typeof v === "object" && !Array.isArray(v);
  /**
   * @param {unknown} v
   * @param {string[]} required
   * @param {string[]} optional
   * @param {string} where
   * @returns {Record<string, any>}
   */
  const obj = (v, required, optional, where) => {
    if (!isObj(v)) return fail(`${where} must be an object`);
    const o = /** @type {Record<string, any>} */ (v);
    for (const k of Object.keys(o)) if (!required.includes(k) && !optional.includes(k)) fail(`${where} has an unknown field`);
    for (const k of required) if (!Object.prototype.hasOwnProperty.call(o, k)) fail(`${where} lacks ${k}`);
    return o;
  };
  const port = (/** @type {unknown} */ v, /** @type {string} */ where) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) fail(`${where} must be a port from 1 to 65535`);
    return /** @type {number} */ (v);
  };
  const c = obj(raw, ["version", "listenCidr", "port", "controlPort", "allow", "forwards", "resolvers", "limits"], [], "config");
  if (c.version !== PROGRAM_VERSION) fail("version is not this program's version");
  const cidr = parseCidr(c.listenCidr);
  // A CIDR broader than a /8 is never one of our networks.
  if (!cidr || cidr.v !== 4 || cidr.bits < 8) fail("listenCidr must be an IPv4 CIDR no broader than /8");
  const p = port(c.port, "port");
  const cp = port(c.controlPort, "controlPort");
  if (p === cp) fail("controlPort must differ from port");

  if (!Array.isArray(c.allow) || c.allow.length > 5000) fail("allow must be a list");
  /** @type {AllowEntry[]} */
  const allow = c.allow.map((/** @type {unknown} */ e) => {
    const o = obj(e, ["host", "wildcard", "ports", "literal", "local"], [], "an allow entry");
    if (typeof o.host !== "string" || typeof o.wildcard !== "boolean" || typeof o.literal !== "boolean" || typeof o.local !== "boolean") fail("an allow entry has a field of the wrong type");
    if (!Array.isArray(o.ports) || o.ports.length < 1 || o.ports.length > 64) fail("an allow entry needs 1 to 64 ports");
    const ports = o.ports.map((/** @type {unknown} */ x) => port(x, "an allow port"));
    if (new Set(ports).size !== ports.length) fail("an allow entry repeats a port");
    if (o.literal) {
      if (o.wildcard) fail("a literal entry cannot be a wildcard");
      if (canonicalIP(o.host) !== o.host) fail("a literal entry's host is not a canonical IP address");
    } else if (parseName(o.host) !== o.host || o.host.endsWith(".")) fail("an allow entry's host is not a lower-case name");
    return { host: o.host, wildcard: o.wildcard, ports, literal: o.literal, local: o.local };
  });

  if (!Array.isArray(c.forwards) || c.forwards.length > 64) fail("forwards must be a list");
  const used = new Set([p, cp]);
  /** @type {Forward[]} */
  const forwards = c.forwards.map((/** @type {unknown} */ e) => {
    const o = obj(e, ["host", "port"], [], "a forward");
    const fp = port(o.port, "a forward port");
    // Names only, under leg 1's grammar (no "_"), with at least two labels.
    if (typeof o.host !== "string" || parseName(o.host) !== o.host || o.host.endsWith(".") || o.host.split(".").length < 2) fail("a forward's host is not a name");
    if (used.has(fp)) fail("a forward port is used twice or is the proxy's own");
    used.add(fp);
    return { host: o.host, port: fp };
  });

  if (!Array.isArray(c.resolvers) || c.resolvers.length < 1 || c.resolvers.length > 8) fail("resolvers must be a list of 1 to 8 addresses");
  const resolvers = c.resolvers.map((/** @type {unknown} */ r) => {
    const ip = typeof r === "string" ? canonicalIP(r) : null;
    if (ip === null || ip !== r) fail("a resolver is not a canonical IP address");
    const g = parseIPv6(String(ip));
    const loop = g ? (g[0] === 0 && zeroTo(g, 5) && (g[5] === 0xffff ? Math.floor((g[6] || 0) / 256) === 127 : (g[6] === 0 && g[7] === 1))) : Math.floor(Number(parseIPv4(String(ip))) / 16777216) === 127;
    // Docker's embedded DNS (127.0.0.11) answers with network aliases, and a loopback resolver is the proxy's own.
    if (loop) fail("a resolver may not be loopback or Docker's embedded DNS");
    return String(ip);
  });

  const l = obj(c.limits, [], Object.keys(DEFAULT_LIMITS), "limits");
  const limits = { ...DEFAULT_LIMITS };
  for (const k of Object.keys(l)) {
    const v = l[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 86400000) fail(`limits.${k} must be a whole number from 1 to 86400000`);
    /** @type {Record<string, number>} */ (limits)[k] = v;
  }
  if (limits.headersTimeoutMs > limits.requestTimeoutMs) fail("limits.headersTimeoutMs may not exceed requestTimeoutMs");
  return { version: c.version, listenCidr: c.listenCidr, port: p, controlPort: cp, allow, forwards, resolvers, limits };
}

/**
 * @param {number[]} g
 * @param {number} n
 */
const zeroTo = (g, n) => g.slice(0, n).every((x) => x === 0);

/**
 * The addresses /etc/hosts gives a name: every line whose name fields (the second onward) hold it exactly,
 * case-insensitively. CRLF and tabs are handled, `#` comments are stripped, a malformed line or a zone id is
 * skipped.
 * @param {string} text
 * @param {string} name
 * @returns {string[]}
 */
function hostsAddresses(text, name) {
  const want = name.toLowerCase();
  /** @type {string[]} */
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const hash = line.indexOf("#");
    const body = (hash >= 0 ? line.slice(0, hash) : line).trim();
    if (!body) continue;
    const f = body.split(/[ \t]+/);
    const ip = canonicalIP(String(f[0]));
    if (ip === null) continue;
    if (f.slice(1).some((n) => n.toLowerCase() === want)) out.push(ip);
  }
  return out;
}

// ---------------------------------------------------------------- headers

const HOP = new Set(["connection", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade", "expect", "via", "forwarded"]);

/**
 * @param {string[]} raw a flat rawHeaders list
 * @returns {Set<string>} the header names listed in Connection
 */
function connectionTokens(raw) {
  const set = new Set();
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (String(raw[i]).toLowerCase() !== "connection") continue;
    for (const t of String(raw[i + 1]).split(",")) {
      const x = t.trim().toLowerCase();
      if (x) set.add(x);
    }
  }
  return set;
}

/**
 * @param {string} name
 * @param {Set<string>} listed
 */
function isHopByHop(name, listed) {
  const n = name.toLowerCase();
  return HOP.has(n) || n.startsWith("proxy-") || n.startsWith("x-forwarded-") || listed.has(n);
}

// ---------------------------------------------------------------- the program

class Refuse extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

/** @type {Record<string, number>} */
const STATUS = {
  "not-allowed": 403,
  "refused-address": 403,
  "no-address": 502,
  "resolve-failed": 502,
  "connect-failed": 502,
  timeout: 504,
  "bad-request": 400,
  method: 405,
};

/**
 * One cleaned line for stderr.
 * @param {unknown} e
 */
const clean = (e) =>
  String(e instanceof Error ? e.message : e)
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 200);

/** @param {Socket} s */
const kill = (s) => {
  try {
    s.destroy();
  } catch {
    /* already gone */
  }
};

/**
 * @param {string[]} servers
 * @returns {(name: string) => Promise<string[]>}
 */
function makeResolver(servers) {
  // There is no cache, on purpose: a cache would reopen check-then-use races.
  const r = new dns.promises.Resolver({ timeout: 3000, tries: 2 });
  r.setServers(servers);
  return async (name) => {
    const [a, b] = await Promise.allSettled([r.resolve4(name), r.resolve6(name)]);
    /** @type {string[]} */
    const out = [];
    let failed = false;
    for (const x of [a, b]) {
      if (x.status === "fulfilled") out.push(...x.value);
      else if (!["ENOTFOUND", "ENODATA"].includes(String(/** @type {any} */ (x.reason)?.code))) failed = true;
    }
    // A missing name is an answer. SERVFAIL, timeouts and refusals are a failure unless an address came back.
    if (out.length === 0 && failed) throw new Error("resolution failed");
    return out;
  };
}

/** @returns {string} */
function readHostsFile() {
  try {
    return fs.readFileSync("/etc/hosts", "utf8").slice(0, 1 << 20);
  } catch {
    return "";
  }
}

/**
 * Start the proxy. Resolves to a handle once every listener is bound; the control endpoint is bound last.
 * @param {unknown} rawConfig
 * @param {Deps} [deps]
 */
async function start(rawConfig, deps) {
  const config = validateConfig(rawConfig);
  const limits = config.limits;
  const configHash = crypto.createHash("sha256").update(canonicalJson(rawConfig)).digest("hex");
  const d = {
    resolve: (deps && deps.resolve) || makeResolver(config.resolvers),
    connect: (deps && deps.connect) || ((/** @type {ConnectOptions} */ o) => net.connect(o)),
    interfaces: (deps && deps.interfaces) || (() => /** @type {Interfaces} */ (os.networkInterfaces())),
    readHosts: (deps && deps.readHosts) || readHostsFile,
    fault: (deps && deps.fault) || (() => {}),
  };
  const startedAt = new Date().toISOString();

  // Refusals: at most 50 rows keyed by (kind, host, port, reason); the least recently seen is evicted.
  /** @type {Map<string, {kind: string, host: string | null, port: number | null, reason: string, count: number, firstAt: string, lastAt: string}>} */
  const rows = new Map();
  let total = 0;
  /**
   * @param {string} kind
   * @param {string | null} host
   * @param {number | null} port
   * @param {string} reason
   */
  const record = (kind, host, port, reason) => {
    total++;
    const key = JSON.stringify([kind, host, port, reason]);
    const now = new Date().toISOString();
    const row = rows.get(key);
    if (row) {
      row.count++;
      row.lastAt = now;
      rows.delete(key);
      rows.set(key, row);
      return;
    }
    if (rows.size >= MAX_REFUSALS) rows.delete(String(rows.keys().next().value));
    rows.set(key, { kind, host, port, reason, count: 1, firstAt: now, lastAt: now });
  };

  let resolverFailures = 0;
  /** @param {string} name */
  const resolveTracked = async (name) => {
    try {
      const a = await d.resolve(name);
      resolverFailures = 0;
      return a;
    } catch (e) {
      resolverFailures++;
      throw e;
    }
  };

  // Every socket the proxy holds, so that close() can end them.
  /** @type {Set<Socket>} */
  const all = new Set();
  let active = 0;
  /**
   * The one connection cap, shared by the proxy port and every forward port.
   * @param {Socket} sock
   * @param {string} kind
   */
  const admit = (sock, kind) => {
    all.add(sock);
    sock.once("close", () => all.delete(sock));
    sock.on("error", () => kill(sock));
    if (active >= limits.connections) {
      record(kind, null, null, "cap");
      kill(sock);
      return;
    }
    active++;
    sock.once("close", () => {
      active--;
    });
  };

  // One request per client connection: the first request or CONNECT marks the socket, and any later request,
  // connect or upgrade event on a marked socket destroys it with no processing and no response.
  const used = new WeakSet();
  /** @param {Socket} sock */
  const firstUse = (sock) => {
    if (used.has(sock)) {
      kill(sock);
      return false;
    }
    used.add(sock);
    return true;
  };

  // ---- upstream
  /**
   * A handshake session: one deadline over resolve, connect and the answer, started at the event.
   * @param {Socket} client
   * @param {() => void} onDeadline
   */
  const session = (client, onDeadline) => {
    /** @type {{dead: null | "timeout" | "gone", pending: Socket | null, timer: NodeJS.Timeout}} */
    const st = {
      dead: null,
      pending: null,
      timer: setTimeout(() => {
        if (st.dead) return;
        st.dead = "timeout";
        if (st.pending) kill(st.pending);
        onDeadline();
      }, limits.handshakeMs),
    };
    client.once("close", () => {
      clearTimeout(st.timer);
      if (!st.dead) st.dead = "gone";
      if (st.pending) kill(st.pending);
    });
    return st;
  };

  /**
   * Connect to one checked literal address, with its own cap. Never passes a name or a lookup.
   * @param {ReturnType<typeof session>} st
   * @param {string} address
   * @param {number} port
   * @returns {Promise<Socket>}
   */
  const dial = (st, address, port) =>
    new Promise((resolve, reject) => {
      /** @type {Socket} */
      let s;
      try {
        s = d.connect({ host: address, port, family: address.includes(":") ? 6 : 4, autoSelectFamily: false });
      } catch {
        reject(new Refuse("connect-failed"));
        return;
      }
      all.add(s);
      s.once("close", () => all.delete(s));
      st.pending = s;
      const timer = setTimeout(() => kill(s), limits.attemptMs);
      s.on("error", () => kill(s));
      s.once("close", () => {
        clearTimeout(timer);
        reject(new Refuse("connect-failed"));
      });
      s.once("connect", () => {
        clearTimeout(timer);
        st.pending = null;
        resolve(s);
      });
    });

  /**
   * Resolve (unless a literal), keep the addresses `permit` allows, try at most four in order.
   * @param {ReturnType<typeof session>} st
   * @param {{host: string, literal: boolean, port: number, lookup: (host: string) => Promise<{addrs: string[], source: string}>, permit: (address: string, source: string) => boolean}} spec
   * @returns {Promise<{socket: Socket, address: string}>}
   */
  const open = async (st, spec) => {
    /** @type {{addrs: string[], source: string}} */
    let found;
    if (spec.literal) found = { addrs: [spec.host], source: "literal" };
    else {
      try {
        found = await spec.lookup(spec.host);
      } catch {
        throw new Refuse(st.dead ? String(st.dead) : "resolve-failed");
      }
    }
    if (st.dead) throw new Refuse(st.dead);
    const seen = new Set();
    /** @type {string[]} */
    const kept = [];
    for (const raw of found.addrs) {
      const a = canonicalIP(String(raw));
      if (a === null || seen.has(a)) continue;
      seen.add(a);
      if (spec.permit(a, found.source)) kept.push(a);
    }
    if (kept.length === 0) throw new Refuse(seen.size === 0 ? "no-address" : "refused-address");
    for (const a of kept.slice(0, MAX_ATTEMPTS)) {
      if (st.dead) throw new Refuse(st.dead);
      try {
        const socket = await dial(st, a, spec.port);
        if (st.dead) {
          kill(socket);
          throw new Refuse(st.dead);
        }
        return { socket, address: a };
      } catch (e) {
        if (st.dead) throw new Refuse(st.dead);
      }
    }
    throw new Refuse("connect-failed");
  };

  /**
   * @param {AllowEntry} entry
   * @param {Own} own
   */
  const connectSpec = (entry, own) => ({
    lookup: async (/** @type {string} */ name) => ({ addrs: await resolveTracked(name), source: "resolver" }),
    permit: (/** @type {string} */ a) => {
      const c = classify(a, own.cidrs);
      return c === "public" || (c === "local" && entry.local === true);
    },
  });

  /**
   * A forward may use public and local addresses, never "never", with one exception: an address inside the
   * proxy's own subnets is allowed only when the target is exactly host.docker.internal, the address came
   * from /etc/hosts, it is not "never" without the own subnets, and it is not one of the proxy's own addresses.
   * @param {string} host
   * @param {Own} own
   */
  const forwardSpec = (host, own) => ({
    lookup: async (/** @type {string} */ name) => {
      const fromHosts = hostsAddresses(d.readHosts(), name);
      if (fromHosts.length > 0) return { addrs: fromHosts, source: "hosts" };
      return { addrs: await resolveTracked(name), source: "resolver" };
    },
    permit: (/** @type {string} */ a, /** @type {string} */ source) => {
      if (classify(a, own.cidrs) !== "never") return true;
      return host === GATEWAY_NAME && source === "hosts" && classify(a, []) !== "never" && !isOwnAddress(a, own);
    },
  });

  /**
   * @param {Socket} a
   * @param {Socket} b
   */
  const tunnel = (a, b) => {
    for (const [s, o] of /** @type {Array<[Socket, Socket]>} */ ([[a, b], [b, a]])) {
      s.setKeepAlive(true, 30000);
      s.setNoDelay(true);
      s.setTimeout(limits.tunnelIdleMs);
      const both = () => {
        kill(a);
        kill(b);
      };
      s.on("timeout", both);
      s.on("error", both);
      s.once("close", () => {
        // End the other side gracefully so that a response still being flushed is not cut.
        o.end();
        const t = setTimeout(() => kill(o), 5000);
        t.unref();
        o.once("close", () => clearTimeout(t));
      });
    }
    a.pipe(b);
    b.pipe(a);
  };

  /**
   * @param {Socket} sock
   * @param {number} code
   * @param {string} reason
   */
  const rawReply = (sock, code, reason) => {
    const body = `mcp-everything proxy: refused (${reason})\n`;
    if (sock.writable) {
      sock.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, () => kill(sock));
    } else kill(sock);
  };

  /**
   * @param {import("node:http").ServerResponse} res
   * @param {number} code
   * @param {string} reason
   */
  const reply = (res, code, reason) => {
    if (res.headersSent) {
      kill(/** @type {Socket} */ (res.socket));
      return;
    }
    const body = `mcp-everything proxy: refused (${reason})\n`;
    res.writeHead(code, { Connection: "close", "Content-Type": "text/plain", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
    res.once("finish", () => res.socket && kill(res.socket));
  };

  // ---- CONNECT
  /**
   * @param {import("node:http").IncomingMessage} req
   * @param {Socket} socket
   * @param {Buffer} head
   */
  const onConnect = async (req, socket, head) => {
    socket.on("error", () => kill(socket));
    if (!firstUse(socket)) return;
    d.fault("connect");
    /** @param {string} kind @param {string | null} host @param {number | null} port @param {string} reason */
    const refuse = (kind, host, port, reason) => {
      record(kind, host, port, reason);
      rawReply(socket, /** @type {number} */ (STATUS[reason]), reason);
    };
    const auth = parseAuthority(String(req.url), false);
    if (!auth) return refuse("connect", "<malformed>", null, "bad-request");
    const entry = matchEntry(config.allow, auth.host, auth.port);
    if (!entry) return refuse("connect", auth.host, auth.port, "not-allowed");
    const st = session(socket, () => {
      record("connect", auth.host, auth.port, "timeout");
      rawReply(socket, 504, "timeout");
    });
    const own = ownFrom(d.interfaces());
    /** @type {{socket: Socket, address: string}} */
    let up;
    try {
      up = await open(st, { host: auth.host, literal: auth.literal, port: auth.port, ...connectSpec(entry, own) });
    } catch (e) {
      clearTimeout(st.timer);
      const reason = e instanceof Refuse ? e.reason : "connect-failed";
      if (reason === "gone") return;
      if (reason === "timeout" && st.dead === "timeout") return; // the deadline already answered
      return refuse("connect", auth.host, auth.port, reason);
    }
    clearTimeout(st.timer);
    if (st.dead || socket.destroyed) return kill(up.socket);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length > 0) up.socket.write(head);
    tunnel(socket, up.socket);
  };

  // ---- plain HTTP
  /**
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   */
  const onRequest = async (req, res) => {
    const socket = /** @type {Socket} */ (req.socket);
    if (!firstUse(socket)) return;
    d.fault("request");
    /** @param {string | null} host @param {number | null} port @param {string} reason */
    const refuse = (host, port, reason) => {
      record("http", host, port, reason);
      reply(res, /** @type {number} */ (STATUS[reason]), reason);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return refuse(null, null, "method");
    const raw = req.rawHeaders;
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const n = String(raw[i]).toLowerCase();
      // A body is refused: any Transfer-Encoding, and a Content-Length that is not all zeros.
      if (n === "transfer-encoding" || (n === "content-length" && !/^0+$/.test(String(raw[i + 1])))) return refuse(null, null, "bad-request");
    }
    const url = String(req.url);
    if (!/^http:\/\//i.test(url)) return refuse(null, null, "bad-request");
    const rest = url.slice(7);
    const authText = String(/^[^/?]*/.exec(rest)?.[0]);
    const pathPart = rest.slice(authText.length);
    const auth = parseAuthority(authText, true);
    if (!auth) return refuse("<malformed>", null, "bad-request");
    const path = pathPart === "" ? "/" : pathPart[0] === "?" ? `/${pathPart}` : pathPart;
    const entry = matchEntry(config.allow, auth.host, auth.port);
    if (!entry) return refuse(auth.host, auth.port, "not-allowed");
    const st = session(socket, () => {
      record("http", auth.host, auth.port, "timeout");
      reply(res, 504, "timeout");
    });
    const own = ownFrom(d.interfaces());
    /** @type {{socket: Socket, address: string}} */
    let up;
    try {
      up = await open(st, { host: auth.host, literal: auth.literal, port: auth.port, ...connectSpec(entry, own) });
    } catch (e) {
      clearTimeout(st.timer);
      const reason = e instanceof Refuse ? e.reason : "connect-failed";
      if (reason === "gone" || (reason === "timeout" && st.dead === "timeout")) return;
      return refuse(auth.host, auth.port, reason);
    }
    clearTimeout(st.timer);
    if (st.dead || socket.destroyed) return kill(up.socket);

    const listed = connectionTokens(raw);
    /** @type {Record<string, string | string[]>} */
    const headers = Object.create(null);
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const name = String(raw[i]);
      const l = name.toLowerCase();
      if (l === "host" || l === "content-length" || isHopByHop(name, listed)) continue;
      const have = headers[name];
      headers[name] = have === undefined ? String(raw[i + 1]) : [...(Array.isArray(have) ? have : [have]), String(raw[i + 1])];
    }
    headers.Host = auth.literal && auth.host.includes(":") ? `[${auth.host}]` : auth.host;
    if (auth.port !== 80) headers.Host += `:${auth.port}`;
    headers.Connection = "close";

    const upSock = up.socket;
    const bothDown = () => {
      kill(upSock);
      kill(socket);
    };
    socket.once("close", () => kill(upSock));
    const upReq = http.request({
      createConnection: () => upSock,
      host: up.address,
      port: auth.port,
      method: req.method,
      path,
      headers,
      setHost: false,
      maxHeaderSize: 16384,
    });
    upReq.on("error", () => {
      if (!res.headersSent) refuse(auth.host, auth.port, "connect-failed");
      bothDown();
    });
    upReq.on("timeout", () => {
      kill(upSock);
      if (!res.headersSent) refuse(auth.host, auth.port, "timeout");
      else kill(socket);
    });
    upReq.on("upgrade", bothDown);
    upReq.on("connect", bothDown);
    upReq.on("response", (r) => {
      try {
        const code = r.statusCode;
        // Only the status code is relayed, never the upstream status message. A 101 ends both sockets (the "upgrade"
        // handler above; without it Node destroys only the upstream socket). Node's parser never hands "response" a
        // status outside 200-599, so the range check is defence in depth.
        if (code === undefined || code < 200 || code > 599) return bothDown();
        const rawRes = r.rawHeaders;
        const listedRes = connectionTokens(rawRes);
        /** @type {string[]} */
        const out = [];
        for (let i = 0; i + 1 < rawRes.length; i += 2) {
          if (!isHopByHop(String(rawRes[i]), listedRes)) out.push(String(rawRes[i]), String(rawRes[i + 1]));
        }
        out.push("Connection", "close");
        res.writeHead(code, out);
        r.on("error", bothDown);
        r.once("end", () => kill(upSock));
        res.on("error", bothDown);
        r.pipe(res);
      } catch {
        bothDown();
      }
    });
    upReq.setTimeout(limits.upstreamIdleMs);
    upReq.end();
  };

  /**
   * @param {import("node:http").Server} server
   * @param {string} kind
   */
  const wireHttp = (server, kind) => {
    server.keepAliveTimeout = 0;
    server.maxHeadersCount = 100;
    server.prependListener("connection", (/** @type {Socket} */ s) => admit(s, kind));
    /** @param {Socket | undefined} s */
    const safe = (s) => {
      if (s) kill(s);
    };
    server.on("request", (req, res) => {
      onRequest(req, res).catch(() => safe(/** @type {Socket} */ (req.socket)));
    });
    server.on("checkContinue", (req, res) => {
      onRequest(req, res).catch(() => safe(/** @type {Socket} */ (req.socket)));
    });
    server.on("checkExpectation", (req, res) => {
      onRequest(req, res).catch(() => safe(/** @type {Socket} */ (req.socket)));
    });
    server.on("connect", (req, socket, head) => {
      onConnect(req, /** @type {Socket} */ (socket), head).catch(() => safe(/** @type {Socket} */ (socket)));
    });
    server.on("upgrade", (_req, socket) => {
      record("http", null, null, "bad-request");
      kill(/** @type {Socket} */ (socket));
    });
    server.on("clientError", (_err, socket) => {
      try {
        // After a response has started (the socket is marked) only destroy.
        if (!socket.destroyed && socket.writable && !used.has(socket)) {
          used.add(socket);
          record("http", null, null, "bad-request");
          socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n", () => kill(socket));
        } else kill(socket);
      } catch {
        kill(socket);
      }
    });
  };

  // ---- forwards
  /**
   * @param {Forward} fwd
   * @param {Socket} socket
   */
  const onForward = async (fwd, socket) => {
    socket.on("error", () => kill(socket));
    if (socket.destroyed) return;
    d.fault("forward");
    const st = session(socket, () => {
      record("forward", fwd.host, fwd.port, "timeout");
      kill(socket);
    });
    const own = ownFrom(d.interfaces());
    try {
      const up = await open(st, { host: fwd.host, literal: false, port: fwd.port, ...forwardSpec(fwd.host, own) });
      clearTimeout(st.timer);
      if (st.dead || socket.destroyed) return kill(up.socket);
      tunnel(socket, up.socket);
    } catch (e) {
      clearTimeout(st.timer);
      const reason = e instanceof Refuse ? e.reason : "connect-failed";
      if (reason !== "gone" && !(reason === "timeout" && st.dead === "timeout")) record("forward", fwd.host, fwd.port, reason);
      kill(socket);
    }
  };

  // ---- listening
  /**
   * @param {import("node:net").Server} server
   * @param {number} port
   * @param {string} host
   */
  const listen = (server, port, host) =>
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve(undefined);
      });
    });

  // The bind address: the interface address inside listenCidr. Retried every 500 ms, because a second network
  // may be connected just after the program starts.
  const cidr = /** @type {Cidr} */ (parseCidr(config.listenCidr));
  const findBind = async () => {
    const until = Date.now() + limits.bindWaitMs;
    for (;;) {
      const ifs = d.interfaces();
      for (const name of Object.keys(ifs).sort()) {
        for (const a of ifs[name] || []) {
          const n = parseIPv4(a.address);
          if (n !== null && cidr.v === 4 && inV4(n, cidr.base, cidr.bits)) return a.address;
        }
      }
      const left = until - Date.now();
      if (left <= 0) throw new Error(`no interface address in ${config.listenCidr}`);
      await new Promise((r) => setTimeout(r, Math.min(500, left)));
    }
  };
  const bind = await findBind();

  /** @type {Array<import("node:net").Server>} */
  const servers = [];
  const close = async () => {
    for (const s of servers) s.close();
    for (const s of [...all]) kill(s);
    await new Promise((r) => setTimeout(r, 0));
  };
  try {
    const proxy = http.createServer({
      maxHeaderSize: 16384,
      headersTimeout: limits.headersTimeoutMs,
      requestTimeout: limits.requestTimeoutMs,
      keepAliveTimeout: 0,
      connectionsCheckingInterval: 1000,
    });
    wireHttp(proxy, "http");
    servers.push(proxy);
    await listen(proxy, config.port, bind);
    for (const fwd of config.forwards) {
      const s = net.createServer({ allowHalfOpen: true });
      s.prependListener("connection", (sock) => admit(sock, "forward"));
      s.on("connection", (sock) => {
        onForward(fwd, sock).catch(() => kill(sock));
      });
      servers.push(s);
      await listen(s, fwd.port, bind);
    }

    // The control endpoint listens only after every other listener is bound, so that it answering means ready.
    // It is on loopback inside the proxy, and does not count against the cap.
    const control = http.createServer({ maxHeaderSize: 4096, headersTimeout: 5000, requestTimeout: 10000, keepAliveTimeout: 0 }, (req, res) => {
      try {
        const raw = req.rawHeaders;
        let body = false;
        for (let i = 0; i + 1 < raw.length; i += 2) {
          const n = String(raw[i]).toLowerCase();
          if (n === "transfer-encoding" || (n === "content-length" && !/^0+$/.test(String(raw[i + 1])))) body = true;
        }
        /** @param {number} code */
        const plain = (code) => {
          res.writeHead(code, { Connection: "close", "Content-Length": 0 });
          res.end();
        };
        if (req.url !== "/status") return plain(404);
        if (req.method !== "GET" || body) return plain(405);
        const text = JSON.stringify(status());
        res.writeHead(200, { Connection: "close", "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
        res.end(text);
      } catch {
        kill(/** @type {Socket} */ (req.socket));
      }
    });
    control.on("clientError", (_e, s) => kill(s));
    control.on("upgrade", (_r, s) => kill(/** @type {Socket} */ (s)));
    control.on("connect", (_r, s) => kill(/** @type {Socket} */ (s)));
    control.on("connection", (s) => {
      all.add(s);
      s.once("close", () => all.delete(s));
      s.on("error", () => kill(s));
    });
    servers.push(control);
    await listen(control, config.controlPort, "127.0.0.1");
  } catch (e) {
    await close();
    throw e;
  }

  function status() {
    return {
      version: PROGRAM_VERSION,
      ready: true,
      listening: { address: bind, ports: [config.port, ...config.forwards.map((f) => f.port)] },
      startedAt,
      configHash,
      refusals: [...rows.values()],
      resolverFailures,
      total,
    };
  }
  return { bind, close, status };
}

/**
 * The entry point of `node -e`. A failure to start exits with a one-line reason on stderr; an uncaught
 * exception fails closed: one cleaned line and exit code 70, so that the sandbox has no way out while the
 * proxy is down.
 * @param {unknown} config
 * @param {Deps} [deps]
 */
function main(config, deps) {
  process.on("uncaughtException", (e) => {
    process.stderr.write(`mcp-everything-proxy: uncaught: ${clean(e)}\n`);
    process.exit(70);
  });
  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
  return start(config, deps).catch((e) => {
    process.stderr.write(`mcp-everything-proxy: ${clean(e)}\n`);
    process.exit(2);
  });
}

module.exports = {
  PROGRAM_VERSION,
  parseIPv4,
  parseIPv6,
  formatIPv6,
  canonicalIP,
  parseName,
  parseAuthority,
  classify,
  matchEntry,
  validateConfig,
  hostsAddresses,
  ownFrom,
  canonicalJson,
  start,
  main,
};
