import { describe, expect, it } from "vitest";
import { HostEntryError, PROXY_PORT, TWO_LABEL_PREFIXES, formatHostEntry, parseHostEntry, type HostMode, type HostStep } from "../src/network/hosts.js";

const step = (raw: string, mode: HostMode): HostStep | undefined => {
  try {
    parseHostEntry(raw, mode);
  } catch (e) {
    expect(e).toBeInstanceOf(HostEntryError);
    return (e as HostEntryError).step;
  }
  return undefined;
};

describe("parseHostEntry: refusals", () => {
  it.each<[string, HostStep]>([
    // IPv4 shorthand and numeric names
    ["127.1", "number"],
    ["127.1.", "number"],
    ["0x7f.1", "number"],
    ["0x7f.0x1", "number"],
    ["1.0x1", "number"],
    ["a.0x7f", "number"],
    ["2130706433", "number"],
    ["0177.0.0.1", "number"],
    ["010.0.0.1", "number"],
    ["1.2.3", "number"],
    // IP literals outside scanner mode
    ["1.2.3.4", "literal"],
    ["1.2.3.4.", "literal"],
    ["127.0.0.1.", "literal"],
    // labels
    ["a..b", "label"],
    ["-a.com", "label"],
    ["a_b.com", "name"],
    ["a.com..", "label"],
    ["xn--a.com", "name"],
    ["XN--A.COM", "name"],
    ["localhost", "label"],
    ["0x7f", "number"],
    // local names
    ["host.docker.internal", "local"],
    ["foo.localhost", "local"],
    ["printer.local", "local"],
    ["db.lan", "local"],
    ["x.home", "local"],
    ["1.0.0.127.in-addr.arpa", "local"],
    ["a.localdomain", "local"],
    // wildcards
    ["*", "wildcard"],
    ["a.*.com", "wildcard"],
    ["*.*.a.com", "wildcard"],
    ["*.com", "wildcard"],
    ["*.co.uk", "wildcard"],
    ["*.com.au", "wildcard"],
    ["*.1.2.3.4", "literal"],
    ["a*.com", "wildcard"],
    // ports and literals
    ["a.com:0", "port"],
    ["a.com:65536", "port"],
    ["a.com:080", "port"],
    ["a.com:+80", "port"],
    ["a.com:80.0", "port"],
    ["a.com:0x50", "port"],
    ["a.com:", "port"],
    [":80", "port"],
    ["::1", "port"],
    ["[1.2.3.4]", "literal"],
    ["[::1]", "literal"],
    ["[fe80::1%eth0]", "raw"],
    // raw
    ["", "raw"],
    ["https://a.com", "raw"],
    ["a.com/x", "raw"],
    ["u@a.com", "raw"],
    ["a b.com", "raw"],
    ["a.com\n", "raw"],
    ["a.com?x", "raw"],
    ["a.com#x", "raw"],
    ["a\\b.com", "raw"],
    ["a%41.com", "raw"],
    [`${"a".repeat(301)}.com`, "raw"],
    // label and name limits
    [`${"a".repeat(64)}.com`, "label"],
    [`${Array.from({ length: 54 }, () => "abcd").join(".")}.com`, "label"],
  ])("agent mode refuses %j at step %s", (raw, expected) => {
    expect(step(raw, "agent")).toBe(expected);
  });

  it("refuses a name that is a registry-suffix wildcard with a message", () => {
    expect(() => parseHostEntry("*.co.uk", "agent")).toThrow(/registry suffix/);
    expect(() => parseHostEntry("localhost", "agent")).toThrow(/two labels/);
    expect(() => parseHostEntry("host.docker.internal", "agent")).toThrow(/local name/);
    expect(() => parseHostEntry("1.2.3.4", "agent")).toThrow(/IP literal/);
    expect(() => parseHostEntry("a.com:0", "agent")).toThrow(/port "0"/);
  });

  it("refuses wildcards in local-access mode but accepts local names there", () => {
    expect(step("*.a.com", "local-access")).toBe("wildcard");
    expect(step("db.lan", "local-access")).toBeUndefined();
    expect(step("host.docker.internal:5432", "local-access")).toBeUndefined();
    expect(step("1.2.3.4:80", "local-access")).toBe("literal");
    expect(step("[::1]:80", "local-access")).toBe("literal");
  });

  it("refuses single labels and bad numbers in scanner mode too", () => {
    expect(step("localhost", "scanner")).toBe("label");
    expect(step("0x7f", "scanner")).toBe("number");
    expect(step("127.1", "scanner")).toBe("number");
    expect(step("0177.0.0.1", "scanner")).toBe("number");
    expect(step("*.1.2.3.4", "scanner")).toBe("literal");
    expect(step("*.co.uk", "scanner")).toBe("wildcard");
    expect(step("[1.2.3.4]", "scanner")).toBe("literal");
    expect(step("[fe80::1%eth0]", "scanner")).toBe("raw");
    expect(step("fe80::1", "scanner")).toBe("port");
  });
});

// Every spelling of an IPv4 address that a resolver could read as one.
const SPELLINGS = [
  "127.0.0.1", "127.0.0.1.", "127.1", "127.1.", "127.0.1", "0x7f.1", "0x7f.0x1", "0x7f.0.0.1", "0x7f000001",
  "2130706433", "2130706433.", "017700000001", "0177.0.0.1", "0177.1", "0x7f.0x0.0x0.0x1", "0X7F.1",
  "1.2.3.4", "10.1", "010.0.0.1", "192.168.1", "3232235777", "0300.0250.01.01", "0xc0.0xa8.1.1", "0x0a000001",
  "１２７.0.0.1", "127。0。0。1", "127．0．0．1", "１２７.１",
  "0.0.0.0", "0", "00", "4294967295", "255.255.255.255", "1.2.3.4.",
];

describe("IPv4 spellings", () => {
  it("has at least 20 spellings", () => expect(SPELLINGS.length).toBeGreaterThanOrEqual(20));
  it.each(SPELLINGS)("refuses %j in agent and local-access modes", (raw) => {
    expect(step(raw, "agent")).toBeDefined();
    expect(step(raw, "local-access")).toBeDefined();
    expect(step(`${raw}:443`, "agent")).toBeDefined();
  });
});

describe("parseHostEntry: accepted", () => {
  it("normalizes: lower-case, trailing dot, fullwidth", () => {
    expect(parseHostEntry("a.com.", "agent")).toEqual({ host: "a.com", wildcard: false, ports: [443, 80], literal: false });
    expect(parseHostEntry("ａ.com", "agent").host).toBe("a.com");
    expect(parseHostEntry("A.Example.COM", "agent").host).toBe("a.example.com");
    expect(parseHostEntry("a。com", "agent").host).toBe("a.com");
  });
  it("accepts wildcards that are narrow enough", () => {
    expect(parseHostEntry("*.a.co.uk", "agent")).toMatchObject({ host: "a.co.uk", wildcard: true });
    expect(parseHostEntry("*.github.io", "agent")).toMatchObject({ host: "github.io", wildcard: true });
    expect(parseHostEntry("*.pages.dev", "scanner").wildcard).toBe(true);
    expect(parseHostEntry("*.s3.amazonaws.com", "agent").wildcard).toBe(true);
    expect(parseHostEntry("*.example.com:8443", "agent")).toMatchObject({ wildcard: true, ports: [8443] });
  });
  it("looks only at the last label for the numeric rule", () => {
    expect(parseHostEntry("127.0.0.1.nip.io", "agent").host).toBe("127.0.0.1.nip.io");
    expect(parseHostEntry("0x7f.example.com", "agent").host).toBe("0x7f.example.com");
  });
  it("accepts punycode that is valid", () => {
    expect(parseHostEntry("xn--nxasmq6b.com", "agent").host).toBe("xn--nxasmq6b.com");
    expect(parseHostEntry("bücher.example", "agent").host).toBe("xn--bcher-kva.example");
  });
  it("ports: none means 443 and 80, a named port means only it", () => {
    expect(parseHostEntry("a.com", "agent").ports).toEqual([443, 80]);
    expect(parseHostEntry("a.com:443", "agent").ports).toEqual([443]);
    expect(parseHostEntry("a.com:80", "agent").ports).toEqual([80]);
    expect(parseHostEntry("a.com:65535", "agent").ports).toEqual([65535]);
    expect(parseHostEntry("a.com:1", "agent").ports).toEqual([1]);
  });
  it("local-access accepts local names", () => {
    expect(parseHostEntry("db.lan", "local-access")).toEqual({ host: "db.lan", wildcard: false, ports: [443, 80], literal: false });
    expect(parseHostEntry("db.lan.:5432", "local-access")).toMatchObject({ host: "db.lan", ports: [5432] });
  });
  it("scanner mode accepts literals, stored canonical", () => {
    expect(parseHostEntry("[::ffff:127.0.0.1]:443", "scanner")).toEqual({ host: "[::ffff:7f00:1]", wildcard: false, ports: [443], literal: true });
    expect(parseHostEntry("[0:0:0:0:0:0:0:1]", "scanner").host).toBe("[::1]");
    expect(parseHostEntry("10.0.0.5:8080", "scanner")).toEqual({ host: "10.0.0.5", wildcard: false, ports: [8080], literal: true });
    expect(parseHostEntry("1.2.3.4", "scanner")).toMatchObject({ host: "1.2.3.4", literal: true });
    expect(parseHostEntry("1.2.3.4.", "scanner").host).toBe("1.2.3.4");
    expect(parseHostEntry("db.lan", "scanner").host).toBe("db.lan");
    expect(parseHostEntry("host.docker.internal", "scanner").host).toBe("host.docker.internal");
  });
});

describe("formatHostEntry and constants", () => {
  it("gives host or host:port, with brackets for IPv6 and the wildcard kept", () => {
    expect(formatHostEntry(parseHostEntry("A.com.", "agent"))).toBe("a.com");
    expect(formatHostEntry(parseHostEntry("a.com:443", "agent"))).toBe("a.com:443");
    expect(formatHostEntry(parseHostEntry("*.a.com:80", "agent"))).toBe("*.a.com:80");
    expect(formatHostEntry(parseHostEntry("[0:0:0:0:0:0:0:1]:9", "scanner"))).toBe("[::1]:9");
  });
  it("exports the proxy port and the wildcard list", () => {
    expect(PROXY_PORT).toBe(3128);
    expect(TWO_LABEL_PREFIXES).toContain("co");
    expect(TWO_LABEL_PREFIXES).toHaveLength(16);
  });
});
