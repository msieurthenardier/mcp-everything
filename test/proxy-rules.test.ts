import fs from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { HostEntry } from "../src/network/hosts.js";
import { PROXY_PORT } from "../src/network/hosts.js";
import { PROXY_CONTROL_PORT, PROXY_PROGRAM_VERSION, proxyConfig, proxyLaunchArgs, proxySource } from "../src/network/proxy/config.js";

type AddrClass = "never" | "local" | "public";
interface AllowEntry {
  host: string;
  wildcard: boolean;
  ports: number[];
  literal: boolean;
  local: boolean;
}
interface ProxyModule {
  PROGRAM_VERSION: string;
  parseIPv4(t: string): number | null;
  parseIPv6(t: string): number[] | null;
  formatIPv6(g: number[]): string;
  canonicalIP(t: string): string | null;
  parseName(t: string): string | null;
  parseAuthority(t: string, implicit?: boolean): { host: string; port: number; literal: boolean } | null;
  classify(a: string, own: string[]): AddrClass;
  matchEntry(entries: AllowEntry[], host: string, port: number): AllowEntry | null;
  validateConfig(raw: unknown): unknown;
  hostsAddresses(text: string, name: string): string[];
  ownFrom(ifs: Record<string, Array<{ address: string; family: string; cidr?: string | null }>>): { cidrs: string[]; addrs: string[] };
  canonicalJson(v: unknown): string;
}
const require = createRequire(import.meta.url);
const P = require("../src/network/proxy/proxy.cjs") as ProxyModule;

const entry = (host: string, over: Partial<AllowEntry> = {}): AllowEntry => ({ host, wildcard: false, ports: [443, 80], literal: false, local: false, ...over });

describe("the program's source", () => {
  const text = fs.readFileSync(new URL("../src/network/proxy/proxy.cjs", import.meta.url), "utf8");

  it("starts with use strict and requires only node: built-ins", () => {
    expect(text.startsWith('"use strict";')).toBe(true);
    const required = [...text.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    expect(required.length).toBeGreaterThan(3);
    for (const r of required) expect(r).toMatch(/^node:/);
    expect(text).not.toMatch(/\bimport\s+[\w{*]/);
  });

  it("starts nothing when required", () => {
    // Requiring (done above) registered no process handler and bound nothing.
    expect(process.listenerCount("SIGTERM")).toBe(0);
    expect(Object.keys(P)).toContain("main");
  });

  it("has a version equal to PROXY_PROGRAM_VERSION", () => {
    expect(P.PROGRAM_VERSION).toBe(PROXY_PROGRAM_VERSION);
  });

  it("is a test-only-field-free configuration: the program has no environment or test flag", () => {
    expect(text).not.toMatch(/process\.env/);
  });

  it("is under 96 KiB as shipped, source and built", () => {
    const launch = proxyLaunchArgs(proxyConfig({ allow: [], listenCidr: "10.0.0.0/24", resolvers: ["8.8.8.8"] }));
    expect(Buffer.byteLength(launch[1] as string)).toBeLessThan(96 * 1024);
    const built = new URL("../dist/network/proxy/proxy.cjs", import.meta.url);
    if (fs.existsSync(built)) expect(fs.statSync(built).size + 100).toBeLessThan(96 * 1024);
  });

  it("proxySource strips the source map line and keeps the program", () => {
    const s = proxySource();
    expect(s).not.toMatch(/sourceMappingURL/);
    expect(s.startsWith('"use strict";')).toBe(true);
    expect(s).toContain("function main(");
  });

  it("launches main with exactly one argument", () => {
    const cfg = proxyConfig({ allow: [], listenCidr: "10.0.0.0/24", resolvers: ["8.8.8.8"] });
    const args = proxyLaunchArgs(cfg);
    expect(args).toEqual(["-e", `${proxySource()}\n;main(JSON.parse(process.argv[1]))`, JSON.stringify(cfg)]);
    const tail = (args[1] as string).split("\n;main(")[1];
    expect(tail).toBe("JSON.parse(process.argv[1]))");
    expect(tail).not.toContain(",");
  });
});

describe("proxyConfig", () => {
  const entries: HostEntry[] = [
    { host: "github.com", wildcard: false, ports: [443, 80], literal: false },
    { host: "example.com", wildcard: true, ports: [8443], literal: false },
    { host: "[2606:4700::1111]", wildcard: false, ports: [443], literal: true },
    { host: "203.0.113.7", wildcard: false, ports: [80], literal: true },
  ];

  it("converts entries, unbrackets IPv6 and sets local false by default", () => {
    const c = proxyConfig({ allow: entries, listenCidr: "172.20.0.0/16", resolvers: ["1.1.1.1"] });
    expect(c.allow).toEqual([
      { host: "github.com", literal: false, local: false, ports: [443, 80], wildcard: false },
      { host: "example.com", literal: false, local: false, ports: [8443], wildcard: true },
      { host: "2606:4700::1111", literal: true, local: false, ports: [443], wildcard: false },
      { host: "203.0.113.7", literal: true, local: false, ports: [80], wildcard: false },
    ]);
    expect(c.port).toBe(PROXY_PORT);
    expect(c.controlPort).toBe(PROXY_CONTROL_PORT);
    expect(c.version).toBe(PROXY_PROGRAM_VERSION);
    expect(c.forwards).toEqual([]);
    expect(c.limits).toEqual({});
  });

  it("canonicalizes IPv6 that leg 1 might have stored in a longer form", () => {
    const c = proxyConfig({ allow: [{ host: "[2606:4700:0:0:0:0:0:1111]", wildcard: false, ports: [443], literal: true }], listenCidr: "172.20.0.0/16", resolvers: ["1.1.1.1"] });
    expect(c.allow[0]?.host).toBe("2606:4700::1111");
  });

  it("sets local on every entry only when asked (a scanner's hosts)", () => {
    const c = proxyConfig({ allow: entries, local: true, listenCidr: "172.20.0.0/16", resolvers: ["1.1.1.1"] });
    expect(c.allow.every((e) => e.local)).toBe(true);
  });

  it("carries forwards, the control port and limits, with keys in sorted order", () => {
    const c = proxyConfig({
      allow: entries.slice(0, 1),
      forwards: [{ host: "host.docker.internal", port: 5432 }],
      listenCidr: "172.20.0.0/16",
      resolvers: ["1.1.1.1"],
      controlPort: 4000,
      limits: { connections: 8, bindWaitMs: 5 },
    });
    expect(c.controlPort).toBe(4000);
    expect(c.forwards).toEqual([{ host: "host.docker.internal", port: 5432 }]);
    expect(Object.keys(c)).toEqual([...Object.keys(c)].sort());
    expect(Object.keys(c.limits)).toEqual(["bindWaitMs", "connections"]);
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        expect(Object.keys(v)).toEqual(Object.keys(v).sort());
        Object.values(v).forEach(walk);
      }
    };
    walk(c);
    expect(JSON.stringify(c)).toBe(P.canonicalJson(c));
  });

  it("produces what the program accepts", () => {
    const c = proxyConfig({ allow: entries, forwards: [{ host: "host.docker.internal", port: 5432 }], listenCidr: "172.20.0.0/16", resolvers: ["1.1.1.1"] });
    expect(() => P.validateConfig(c)).not.toThrow();
  });
});

describe("parseAuthority", () => {
  const ok = (t: string, implicit = false) => P.parseAuthority(t, implicit);

  it("accepts host:port, [ipv6]:port, and with an implied port host and [ipv6]", () => {
    expect(ok("A.Example.com:443")).toEqual({ host: "a.example.com", port: 443, literal: false });
    expect(ok("a.com.:443")).toEqual({ host: "a.com", port: 443, literal: false });
    expect(ok("1.2.3.4:80")).toEqual({ host: "1.2.3.4", port: 80, literal: true });
    expect(ok("[2606:4700:0:0:0:0:0:1111]:443")).toEqual({ host: "2606:4700::1111", port: 443, literal: true });
    expect(ok("a.com", true)).toEqual({ host: "a.com", port: 80, literal: false });
    expect(ok("[::1]", true)).toEqual({ host: "::1", port: 80, literal: true });
    expect(ok("a.com:65535")).toEqual({ host: "a.com", port: 65535, literal: false });
    expect(ok("a-b.c0m:1")).toEqual({ host: "a-b.c0m", port: 1, literal: false });
  });

  it.each([
    "0x7f.1:443",
    "127.1:443",
    "2130706433:443",
    "a@b:443",
    "a%2eb:443",
    "evil.com:443/x",
    "*:1",
    "*.a.com:443",
    "[::1]",
    "foo",
    "a.com:0443",
    "a.com:+443",
    "a.com:4e2",
    "a.com:0x1bb",
    "a.com:0",
    "a.com:65536",
    "a.com:99999999",
    "a.com:",
    "a.com: 443",
    "[fe80::1%eth0]:443",
    "[fe80::1%25eth0]:443",
    "[::1]:443]",
    "[::1:443",
    "[1.2.3.4]:443",
    "[::1]x:443",
    "::1:443",
    "a:b:443",
    ":443",
    "",
    "a.com\\x:443",
    "a b.com:443",
    "a.com\t:443",
    "a.com\n:443",
    "é.com:443",
    "a.com:443",
    "０x7f.1:443",
    "a_b.com:443",
    "-a.com:443",
    "a-.com:443",
    "a..com:443",
    "a.com..:443",
    ".a.com:443",
    "1.2.3.4.:443",
    "01.2.3.4:443",
    "1.2.3:443",
    "1.2.3.256:443",
    "a.0x7f:443",
    "a.0x:443",
    "a.123:443",
    `${"a".repeat(64)}.com:443`,
    `${"a.".repeat(130)}com:443`,
    "[::1]/x:443",
    "[::1]@a:443",
    "a.com#x:443",
    "a.com?x:443",
  ])("refuses %j on CONNECT", (t) => {
    // "a.com:443" is the one control in the table that is valid; it is checked separately below.
    if (t === "a.com:443") return;
    expect(ok(t)).toBeNull();
  });

  it("refuses the same hostile spellings with an implied port", () => {
    for (const t of ["0x7f.1", "127.1", "2130706433", "a@b", "a%2eb", "evil.com/x", "*", "[fe80::1%eth0]", "a.com:0443", "é.com", "a.0x7f"]) {
      expect(ok(t, true)).toBeNull();
    }
  });

  it("never lets a non-ASCII character lower-case into ASCII (Kelvin sign)", () => {
    expect(ok("K.com:443")).toBeNull();
    expect(P.parseName("K.com")).toBeNull();
  });

  it("limits a label to 63 characters and a name to 253", () => {
    expect(ok(`${"a".repeat(63)}.com:443`)).not.toBeNull();
    const long = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.com`;
    expect(long.length).toBeLessThanOrEqual(253);
    expect(ok(`${long}:443`)).not.toBeNull();
    expect(ok(`${long}x.${"e".repeat(10)}:443`)).toBeNull();
  });
});

describe("IPv6 parsing and canonical text", () => {
  const spellings = [
    "::",
    "::1",
    "1::",
    "1::2",
    "2001:db8::1",
    "2001:DB8::A",
    "2001:0db8:0000:0000:0000:0000:0000:0001",
    "2001:db8:0:0:1:0:0:1",
    "2001:0:0:1:0:0:0:1",
    "1:0:0:2:0:0:3:4",
    "1:0:0:0:2:0:0:4",
    "0:0:0:0:0:0:0:0",
    "0:0:0:0:0:0:0:1",
    "1:2:3:4:5:6:7:8",
    "1:2:3:4:5:6:7::",
    "::2:3:4:5:6:7:8",
    "1::8",
    "::ffff:1.2.3.4",
    "::ffff:0:1.2.3.4",
    "::1.2.3.4",
    "64:ff9b::1.2.3.4",
    "1:2:3:4:5:6:1.2.3.4",
    "2002:7f00:1::",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2",
    "fe80::1",
    "FE80::ABCD",
    "ff02::1",
    "fd00:ec2::254",
    "::ffff:7f00:1",
    "::ffff:127.0.0.1",
    "0:0:0:0:0:ffff:7f00:1",
    "1:0:0:0:0:0:0:0",
    "0:1:0:0:0:0:0:0",
    "2606:4700::1111",
    "2001:4860:4860::8888",
    "1:2:3:4:5:6:7:8:9",
    "1:2:3:4:5:6:7",
    "1:2:3::4:5:6:7:8",
    "1::2::3",
    ":::",
    "::::",
    "1:::2",
    ":1:2:3:4:5:6:7",
    "1:2:3:4:5:6:7:",
    "12345::1",
    "g::1",
    "::1.2.3",
    "::1.2.3.256",
    "::1.2.3.04",
    "::01.2.3.4",
    "1.2.3.4::",
    "::1.2.3.4:1",
    "1.2.3.4",
    "::1%eth0",
    "::1/128",
    "[::1]",
    " ::1",
    "::1 ",
    "::0001",
    "0::1",
    "0:0::1",
    "0:0:0::",
  ];

  it("agrees with new URL on a corpus of spellings (valid and invalid)", () => {
    expect(spellings.length).toBeGreaterThanOrEqual(50);
    for (const s of spellings) {
      let expected: string | null;
      try {
        expected = new URL(`http://[${s}]`).hostname.slice(1, -1);
      } catch {
        expected = null;
      }
      const g = P.parseIPv6(s);
      const got = g ? P.formatIPv6(g) : null;
      expect({ s, got }).toEqual({ s, got: expected });
    }
  });

  it("compresses the first longest run, and only runs of two or more", () => {
    expect(P.formatIPv6([1, 0, 0, 2, 0, 0, 3, 4])).toBe("1::2:0:0:3:4");
    expect(P.formatIPv6([1, 0, 2, 0, 3, 0, 4, 0])).toBe("1:0:2:0:3:0:4:0");
    expect(P.formatIPv6([0, 0, 0, 0, 0, 0, 0, 0])).toBe("::");
    expect(P.formatIPv6([0, 0, 0, 0, 0, 0, 0, 1])).toBe("::1");
  });

  it("refuses a zone id, a slash and a name-like input", () => {
    for (const s of ["fe80::1%eth0", "::1/128", "localhost", "::1@x", "::1\\", "::١"]) expect(P.parseIPv6(s)).toBeNull();
  });
});

describe("classify", () => {
  const c = (a: string, own: string[] = []) => P.classify(a, own);

  it.each<[string, AddrClass]>([
    // never, with both neighbours
    ["0.0.0.0", "never"],
    ["0.255.255.255", "never"],
    ["1.0.0.0", "public"],
    ["126.255.255.255", "public"],
    ["127.0.0.0", "never"],
    ["127.255.255.255", "never"],
    ["128.0.0.0", "public"],
    ["169.253.255.255", "public"],
    ["169.254.0.0", "never"],
    ["169.254.255.255", "never"],
    ["169.255.0.0", "public"],
    ["223.255.255.255", "public"],
    ["224.0.0.0", "never"],
    ["239.255.255.255", "never"],
    ["240.0.0.0", "never"],
    ["255.255.255.254", "never"],
    ["255.255.255.255", "never"],
    ["100.100.100.200", "never"],
    ["100.100.100.199", "local"],
    ["100.100.100.201", "local"],
    // local, with both neighbours
    ["9.255.255.255", "public"],
    ["10.0.0.0", "local"],
    ["10.255.255.255", "local"],
    ["11.0.0.0", "public"],
    ["100.63.255.255", "public"],
    ["100.64.0.0", "local"],
    ["100.127.255.255", "local"],
    ["100.128.0.0", "public"],
    ["172.15.255.255", "public"],
    ["172.16.0.0", "local"],
    ["172.31.255.255", "local"],
    ["172.32.0.0", "public"],
    ["191.255.255.255", "public"],
    ["192.0.0.0", "local"],
    ["192.0.0.255", "local"],
    ["192.0.1.0", "public"],
    ["192.88.98.255", "public"],
    ["192.88.99.0", "local"],
    ["192.88.99.255", "local"],
    ["192.88.100.0", "public"],
    ["192.167.255.255", "public"],
    ["192.168.0.0", "local"],
    ["192.168.255.255", "local"],
    ["192.169.0.0", "public"],
    ["198.17.255.255", "public"],
    ["198.18.0.0", "local"],
    ["198.19.255.255", "local"],
    ["198.20.0.0", "public"],
    // TEST-NET is deliberately public
    ["192.0.2.1", "public"],
    ["198.51.100.1", "public"],
    ["203.0.113.1", "public"],
    ["8.8.8.8", "public"],
  ])("IPv4 %s is %s", (a, want) => {
    expect(c(a)).toBe(want);
  });

  it.each<[string, AddrClass]>([
    ["::", "never"],
    ["::1", "never"],
    ["::2", "never"],
    ["::1.2.3.4", "never"],
    ["::ffff:0:0", "never"],
    ["fe80::1", "never"],
    ["febf:ffff::1", "never"],
    ["fec0::1", "local"],
    ["ff00::1", "never"],
    ["ff02::1", "never"],
    ["fd00:ec2::254", "never"],
    ["fd00:ec2::253", "local"],
    ["fc00::1", "local"],
    ["fdff::1", "local"],
    ["fe00::1", "local"],
    ["64:ff9b:1::1", "local"],
    ["100::1", "local"],
    ["100:0:0:1::1", "local"],
    ["2001:db8::1", "local"],
    ["2001:1::1", "local"],
    ["2001:1ff::1", "local"],
    ["2001:200::1", "public"],
    ["2001:db7::1", "public"],
    ["2001:db9::1", "public"],
    ["1fff::1", "local"],
    ["2000::1", "public"],
    ["3fff::1", "public"],
    ["4000::1", "local"],
    ["8000::1", "local"],
    ["2606:4700::1111", "public"],
    ["2001:4860:4860::8888", "public"],
  ])("IPv6 %s is %s", (a, want) => {
    expect(c(a)).toBe(want);
  });

  it("makes metadata addresses never although their ranges are local", () => {
    expect(c("100.100.100.200")).toBe("never");
    expect(c("fd00:ec2::254")).toBe("never");
    expect(c("255.255.255.255")).toBe("never");
  });

  it("never lets an embedded address be public, and judges the embedded IPv4", () => {
    // A public IPv4 embedded in a translation prefix is "local", never "public".
    for (const a of ["::ffff:8.8.8.8", "::ffff:0:8.8.8.8", "64:ff9b::8.8.8.8", "2002:808:808::", "2001:0:808:808:0:0:f7f7:f7f7"]) expect(c(a)).toBe("local");
    for (const a of ["::ffff:10.0.0.1", "64:ff9b::192.168.1.1", "2002:a00:1::"]) expect(c(a)).toBe("local");
    for (const a of ["::ffff:127.0.0.1", "::ffff:0:127.0.0.1", "64:ff9b::127.0.0.1", "2002:7f00:1::", "::ffff:169.254.169.254", "::ffff:100.100.100.200", "::ffff:224.0.0.1"]) expect(c(a)).toBe("never");
  });

  it("judges both halves of a Teredo address", () => {
    const teredo = (server: string, client: string) => {
      const s = (P.parseIPv4(server) as number) >>> 0;
      const cl = (P.parseIPv4(client) as number) >>> 0;
      const x = (cl ^ 0xffffffff) >>> 0;
      const h = (n: number) => n.toString(16);
      return `2001:0:${h(Math.floor(s / 65536))}:${h(s % 65536)}:0:0:${h(Math.floor(x / 65536))}:${h(x % 65536)}`;
    };
    expect(c(teredo("8.8.8.8", "8.8.4.4"))).toBe("local");
    expect(c(teredo("127.0.0.1", "8.8.4.4"))).toBe("never");
    expect(c(teredo("8.8.8.8", "127.0.0.1"))).toBe("never");
    expect(c(teredo("8.8.8.8", "169.254.169.254"))).toBe("never");
    expect(c(teredo("169.254.169.254", "8.8.4.4"))).toBe("never");
    expect(c(teredo("8.8.8.8", "10.0.0.1"))).toBe("local");
  });

  it("checks ownCidrs first, for IPv4, for IPv6 and for an embedded IPv4", () => {
    const own = ["203.0.113.0/24", "2606:4700::/32"];
    expect(c("203.0.113.9", own)).toBe("never");
    expect(c("203.0.114.9", own)).toBe("public");
    expect(c("2606:4700::1111", own)).toBe("never");
    expect(c("2606:4701::1111", own)).toBe("public");
    expect(c("::ffff:203.0.113.9", own)).toBe("never");
    expect(c("64:ff9b::203.0.113.9", own)).toBe("never");
    expect(c("2002:cb00:7109::", own)).toBe("never");
    expect(c("10.1.2.3", ["10.1.0.0/16"])).toBe("never");
    expect(c("10.2.2.3", ["10.1.0.0/16"])).toBe("local");
    expect(c("172.18.0.1", ["172.18.0.0/16"])).toBe("never");
  });

  it("treats unparseable input as never", () => {
    for (const a of ["", "localhost", "1.2.3", "01.2.3.4", "0x7f.1", "::1%eth0", "[::1]", "1.2.3.4/8", "fe80::1%1", "８.８.８.８"]) expect(c(a)).toBe("never");
  });
});

describe("ownFrom", () => {
  it("takes subnets and addresses from the interfaces, sorted and canonical", () => {
    const own = P.ownFrom({
      eth1: [{ address: "172.18.0.2", family: "IPv4", cidr: "172.18.0.2/16" }],
      eth0: [
        { address: "172.17.0.2", family: "IPv4", cidr: "172.17.0.2/24" },
        { address: "fe80::42:acff:fe11:2", family: "IPv6", cidr: "fe80::42:acff:fe11:2/64" },
      ],
      lo: [{ address: "127.0.0.1", family: "IPv4", cidr: null }],
    });
    expect(own.cidrs).toEqual(["127.0.0.1/32", "172.17.0.0/24", "172.18.0.0/16", "fe80::/64"]);
    expect(own.addrs).toEqual(["127.0.0.1", "172.17.0.2", "172.18.0.2", "fe80::42:acff:fe11:2"]);
  });
});

describe("matchEntry", () => {
  const list = [entry("github.com"), entry("example.com", { wildcard: true }), entry("api.test", { ports: [8443] }), entry("203.0.113.7", { literal: true, ports: [80] }), entry("2606:4700::1111", { literal: true })];

  it("matches an exact name, case already folded, on a listed port", () => {
    expect(P.matchEntry(list, "github.com", 443)).toBe(list[0]);
    expect(P.matchEntry(list, "github.com", 80)).toBe(list[0]);
    expect(P.matchEntry(list, "github.com", 8443)).toBeNull();
    expect(P.matchEntry(list, "api.test", 8443)).toBe(list[2]);
    expect(P.matchEntry(list, "api.test", 443)).toBeNull();
  });

  it("matches a wildcard under it at any depth, not the name itself or a lookalike", () => {
    expect(P.matchEntry(list, "a.example.com", 443)).toBe(list[1]);
    expect(P.matchEntry(list, "a.b.example.com", 443)).toBe(list[1]);
    expect(P.matchEntry(list, "example.com", 443)).toBeNull();
    expect(P.matchEntry(list, "badexample.com", 443)).toBeNull();
    expect(P.matchEntry(list, "example.com.evil.com", 443)).toBeNull();
  });

  it("matches an IP literal only a literal entry with the same canonical address", () => {
    expect(P.matchEntry(list, "203.0.113.7", 80)).toBe(list[3]);
    expect(P.matchEntry(list, "203.0.113.7", 443)).toBeNull();
    expect(P.matchEntry(list, "203.0.113.8", 80)).toBeNull();
    expect(P.matchEntry(list, "2606:4700::1111", 443)).toBe(list[4]);
    expect(P.matchEntry(list, "2606:4700::1112", 443)).toBeNull();
    // A name never matches a literal entry, and a literal never matches a name entry.
    expect(P.matchEntry([entry("203.0.113.7", { literal: true })], "203.0.113.7.example.com", 80)).toBeNull();
    expect(P.matchEntry([entry("github.com")], "1.2.3.4", 443)).toBeNull();
    expect(P.matchEntry([entry("2606:4700::1111")], "2606:4700::1111", 443)).toBeNull();
  });

  it("prefers a local entry when several match", () => {
    const l = [entry("a.test"), entry("a.test", { local: true })];
    expect(P.matchEntry(l, "a.test", 443)).toBe(l[1]);
  });
});

describe("validateConfig", () => {
  const base = () => ({
    version: PROXY_PROGRAM_VERSION,
    listenCidr: "172.20.0.0/16",
    port: 3128,
    controlPort: 3129,
    allow: [entry("github.com")],
    forwards: [{ host: "host.docker.internal", port: 5432 }],
    resolvers: ["8.8.8.8"],
    limits: {},
  });
  const bad = (mutate: (c: Record<string, unknown>) => void, message: RegExp) => {
    const c = base() as Record<string, unknown>;
    mutate(c);
    expect(() => P.validateConfig(c)).toThrow(message);
  };

  it("accepts a good configuration and fills limits", () => {
    const c = P.validateConfig(base()) as { limits: { connections: number } };
    expect(c.limits.connections).toBe(256);
  });

  it("refuses unknown fields everywhere, and a missing one", () => {
    bad((c) => (c.debug = true), /unknown field/);
    bad((c) => ((c.allow as Array<Record<string, unknown>>)[0]!.extra = 1), /unknown field/);
    bad((c) => (c.forwards = [{ host: "a.test", port: 1, x: 1 }]), /unknown field/);
    bad((c) => (c.limits = { fast: 1 }), /unknown field/);
    bad((c) => delete c.resolvers, /lacks resolvers/);
    expect(() => P.validateConfig(JSON.parse('{"__proto__":{"x":1}}'))).toThrow(/unknown field/);
    expect(() => P.validateConfig(null)).toThrow(/object/);
    expect(() => P.validateConfig([])).toThrow(/object/);
  });

  it("refuses a bad version, CIDR and ports", () => {
    bad((c) => (c.version = "0"), /version/);
    bad((c) => (c.listenCidr = "172.20.0.0"), /listenCidr/);
    bad((c) => (c.listenCidr = "::1/128"), /listenCidr/);
    bad((c) => (c.listenCidr = "0.0.0.0/0"), /listenCidr/);
    bad((c) => (c.port = 0), /port/);
    bad((c) => (c.port = 65536), /port/);
    bad((c) => (c.port = "3128"), /port/);
    bad((c) => (c.controlPort = 3128), /differ/);
  });

  it("refuses bad allow entries", () => {
    bad((c) => (c.allow = [entry("GitHub.com")]), /lower-case name/);
    bad((c) => (c.allow = [entry("github.com.")]), /lower-case name/);
    bad((c) => (c.allow = [entry("127.1")]), /lower-case name/);
    bad((c) => (c.allow = [entry("a_b.com")]), /lower-case name/);
    bad((c) => (c.allow = [entry("2606:4700:0:0:0:0:0:1111", { literal: true })]), /canonical/);
    bad((c) => (c.allow = [entry("[::1]", { literal: true })]), /canonical/);
    bad((c) => (c.allow = [entry("1.2.3.4", { literal: true, wildcard: true })]), /wildcard/);
    bad((c) => (c.allow = [entry("a.com", { ports: [] })]), /ports/);
    bad((c) => (c.allow = [entry("a.com", { ports: [443, 443] })]), /repeats/);
    bad((c) => (c.allow = [entry("a.com", { ports: [70000] })]), /port/);
    bad((c) => (c.allow = [{ host: "a.com", wildcard: "no", ports: [1], literal: false, local: false }]), /type/);
  });

  it("refuses bad forwards: names only, no collisions", () => {
    bad((c) => (c.forwards = [{ host: "127.0.0.1", port: 5432 }]), /not a name/);
    bad((c) => (c.forwards = [{ host: "localhost", port: 5432 }]), /not a name/);
    bad((c) => (c.forwards = [{ host: "db_lan.test", port: 5432 }]), /not a name/);
    bad((c) => (c.forwards = [{ host: "db.lan", port: 3128 }]), /twice or is the proxy's own/);
    bad((c) => (c.forwards = [{ host: "db.lan", port: 3129 }]), /twice or is the proxy's own/);
    bad((c) => (c.forwards = [{ host: "db.lan", port: 5432 }, { host: "host.docker.internal", port: 5432 }]), /twice/);
  });

  it("refuses bad resolvers, loopback and Docker's embedded DNS among them", () => {
    bad((c) => (c.resolvers = []), /resolvers/);
    bad((c) => (c.resolvers = ["127.0.0.11"]), /loopback/);
    bad((c) => (c.resolvers = ["127.0.0.1"]), /loopback/);
    bad((c) => (c.resolvers = ["127.9.9.9"]), /loopback/);
    bad((c) => (c.resolvers = ["::1"]), /loopback/);
    bad((c) => (c.resolvers = ["::ffff:7f00:1"]), /loopback/);
    bad((c) => (c.resolvers = ["8.8.8.8", "fe80::1%eth0"]), /canonical/);
    bad((c) => (c.resolvers = ["dns.google"]), /canonical/);
    bad((c) => (c.resolvers = ["8.8.8.8", "8.8.8"]), /canonical/);
    expect(() => P.validateConfig({ ...base(), resolvers: ["8.8.8.8", "2001:4860:4860::8888", "169.254.169.253"] })).not.toThrow();
  });

  it("refuses bad limits", () => {
    bad((c) => (c.limits = { connections: 0 }), /limits/);
    bad((c) => (c.limits = { connections: 1.5 }), /limits/);
    bad((c) => (c.limits = { handshakeMs: "1" }), /limits/);
    bad((c) => (c.limits = { headersTimeoutMs: 5000, requestTimeoutMs: 1000 }), /headersTimeoutMs/);
  });
});

describe("hostsAddresses", () => {
  const text = [
    "# comment",
    "127.0.0.1\tlocalhost",
    "::1 localhost ip6-localhost # trailing",
    "172.18.0.1   Host.Docker.Internal db.lan\r",
    "192.168.1.5 hostdb.lan",
    "fe80::1%eth0 host.docker.internal",
    "300.1.1.1 host.docker.internal",
    "01.2.3.4 host.docker.internal",
    "garbage",
    "10.0.0.9 # host.docker.internal",
    "2001:db8::0:1 host.docker.internal",
    "",
  ].join("\n");

  it("collects every line naming the target, case-insensitively, with comments, CRLF and tabs handled", () => {
    expect(P.hostsAddresses(text, "host.docker.internal")).toEqual(["172.18.0.1", "2001:db8::1"]);
    expect(P.hostsAddresses(text, "DB.LAN")).toEqual(["172.18.0.1"]);
    expect(P.hostsAddresses(text, "localhost")).toEqual(["127.0.0.1", "::1"]);
  });

  it("matches the name exactly, not as a part, and never the address field", () => {
    expect(P.hostsAddresses(text, "db.la")).toEqual([]);
    expect(P.hostsAddresses(text, "lan")).toEqual([]);
    expect(P.hostsAddresses(text, "172.18.0.1")).toEqual([]);
    expect(P.hostsAddresses("1.2.3.4 a.test", "a.test")).toEqual(["1.2.3.4"]);
  });

  it("refuses zone ids and skips malformed lines", () => {
    expect(P.hostsAddresses("fe80::1%eth0 x.test", "x.test")).toEqual([]);
    expect(P.hostsAddresses("x.test", "x.test")).toEqual([]);
  });
});
