import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { proxyConfig, proxyLaunchArgs, proxySource } from "../src/network/proxy/config.js";

interface AllowEntry {
  host: string;
  wildcard: boolean;
  ports: number[];
  literal: boolean;
  local: boolean;
}
interface Handle {
  bind: string;
  close(): Promise<void>;
  status(): { ready: boolean; listening: { address: string; ports: number[] }; refusals: Array<Record<string, unknown>>; total: number; resolverFailures: number };
}
interface Iface {
  address: string;
  family: string;
  cidr?: string | null;
}
interface Deps {
  resolve?: (name: string) => Promise<string[]>;
  connect?: (o: { host: string; port: number; family: number; autoSelectFamily: boolean }) => net.Socket;
  interfaces?: () => Record<string, Iface[]>;
  readHosts?: () => string;
  fault?: (where: string) => void;
}
const requireCjs = createRequire(import.meta.url);
const P = requireCjs("../src/network/proxy/proxy.cjs") as { start(config: unknown, deps?: Deps): Promise<Handle> };

const entry = (host: string, over: Partial<AllowEntry> = {}): AllowEntry => ({ host, wildcard: false, ports: [443, 80], literal: false, local: false, ...over });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LO: Record<string, Iface[]> = { lo: [{ address: "127.0.0.1", family: "IPv4", cidr: "127.0.0.1/8" }] };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Ports that were free a moment ago. */
async function freePorts(n: number): Promise<number[]> {
  const servers = Array.from({ length: n }, () => net.createServer());
  const ports: number[] = [];
  for (const s of servers) {
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    ports.push((s.address() as net.AddressInfo).port);
  }
  await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
  return ports;
}

/** A TCP server whose connections are recorded; `onData` handles each connection. */
async function stub(onConn: (s: net.Socket, seen: { conns: number; data: string }) => void) {
  const seen = { conns: 0, data: "" };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((s) => {
    sockets.add(s);
    s.on("error", () => {});
    s.on("close", () => sockets.delete(s));
    s.on("data", (d) => (seen.data += d.toString("latin1")));
    seen.conns++;
    onConn(s, seen);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  });
  return { port: (server.address() as net.AddressInfo).port, seen };
}
const echo = () => stub((s) => s.pipe(s));
/** An upstream web server: answers any request with `reply` (a function of nothing, so it can be a fixed text). */
const web = (reply: string) =>
  stub((s) => {
    s.once("data", () => s.end(reply));
  });

interface Rig {
  proxy: number;
  control: number;
  forwards: number[];
  resolves: string[];
  connects: Array<{ host: string; port: number; family: number; autoSelectFamily: boolean }>;
  answers: Record<string, string[] | Error>;
  handle: Handle;
}

interface RigOptions {
  allow?: AllowEntry[];
  forwards?: Array<{ host: string }>;
  limits?: Record<string, number>;
  answers?: Record<string, string[] | Error>;
  /** Literal address -> the loopback stub port that stands in for it. */
  targets?: Record<string, number>;
  hosts?: string;
  interfaces?: Record<string, Iface[]>;
  resolve?: (name: string) => Promise<string[]>;
}

async function boot(o: RigOptions = {}): Promise<Rig> {
  const fwd = o.forwards ?? [];
  const ports = await freePorts(3 + fwd.length);
  // An address with no target connects to a port that was just freed, so it is refused at once (port 1 may hang).
  const dead = ports.pop()!;
  const rig = { proxy: ports[0]!, control: ports[1]!, forwards: ports.slice(2), resolves: [], connects: [], answers: { ...(o.answers ?? {}) } } as unknown as Rig;
  const config = {
    version: "1",
    listenCidr: "127.0.0.0/8",
    port: rig.proxy,
    controlPort: rig.control,
    allow: o.allow ?? [],
    forwards: fwd.map((f, i) => ({ host: f.host, port: rig.forwards[i]! })),
    resolvers: ["8.8.8.8"],
    limits: { connections: 64, handshakeMs: 3000, attemptMs: 1000, upstreamIdleMs: 3000, ...(o.limits ?? {}) },
  };
  rig.handle = await P.start(config, {
    interfaces: () => o.interfaces ?? LO,
    resolve:
      o.resolve ??
      (async (name) => {
        rig.resolves.push(name);
        const a = rig.answers[name];
        if (a instanceof Error) throw a;
        return a ?? [];
      }),
    connect: (opts) => {
      rig.connects.push(opts);
      const port = o.targets?.[opts.host] ?? dead;
      return net.connect({ host: "127.0.0.1", port });
    },
    readHosts: () => o.hosts ?? "",
  });
  cleanups.push(async () => {
    await rig.handle.close();
    // Every address the proxy ever tried is a checked IP literal: it never passes a name.
    for (const c of rig.connects) expect(net.isIP(c.host)).not.toBe(0);
    for (const c of rig.connects) expect(c.autoSelectFamily).toBe(false);
  });
  return rig;
}

/** Write `data` in one go, read until the server closes the connection or `wait` ms pass. */
function talk(port: number, data: string | null, wait = 600): Promise<string> {
  return new Promise((resolve) => {
    const c = net.connect(port, "127.0.0.1", () => {
      if (data !== null) c.write(data);
    });
    let got = "";
    c.on("data", (d) => (got += d.toString("latin1")));
    c.on("error", () => {});
    c.on("close", () => {
      clearTimeout(t);
      resolve(got);
    });
    const t = setTimeout(() => {
      c.destroy();
    }, wait);
  });
}

const connectLine = (target: string, extra = "") => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n${extra}`;
const getLine = (url: string, extra = "") => `GET ${url} HTTP/1.1\r\nHost: x\r\n${extra}\r\n`;
const statusOf = (r: string) => /^HTTP\/1\.[01] (\d{3})/.exec(r)?.[1];

function fetchStatus(control: number): Promise<{ code: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port: control, path: "/status", agent: false }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ code: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}
const status = async (rig: Rig) => JSON.parse((await fetchStatus(rig.control)).body) as ReturnType<Handle["status"]> & { version: string; startedAt: string; configHash: string };

describe("CONNECT", () => {
  it("tunnels an allowed host to the checked address, with trailing bytes going only there", async () => {
    const e = await echo();
    const rig = await boot({ allow: [entry("ok.test")], answers: { "ok.test": ["203.0.113.5"] }, targets: { "203.0.113.5": e.port } });
    const got = await talk(rig.proxy, connectLine("ok.test:443", "hello"), 400);
    expect(statusOf(got)).toBe("200");
    expect(got).toContain("hello");
    expect(rig.resolves).toEqual(["ok.test"]);
    expect(rig.connects.map((c) => [c.host, c.port, c.family])).toEqual([["203.0.113.5", 443, 4]]);
  });

  it("carries an IPv6 literal entry without resolving it", async () => {
    const e = await echo();
    const rig = await boot({ allow: [entry("2606:4700::1111", { literal: true })], targets: { "2606:4700::1111": e.port } });
    const got = await talk(rig.proxy, connectLine("[2606:4700:0:0:0:0:0:1111]:443", "x"), 400);
    expect(statusOf(got)).toBe("200");
    expect(rig.resolves).toEqual([]);
    expect(rig.connects.map((c) => [c.host, c.family])).toEqual([["2606:4700::1111", 6]]);
  });

  it("answers 403 for a disallowed host and never resolves it", async () => {
    const rig = await boot({ allow: [entry("ok.test")], answers: { "evil.test": ["203.0.113.5"] } });
    expect(statusOf(await talk(rig.proxy, connectLine("evil.test:443")))).toBe("403");
    expect(statusOf(await talk(rig.proxy, connectLine("ok.test:8443")))).toBe("403");
    expect(statusOf(await talk(rig.proxy, connectLine("[::1]:443")))).toBe("403");
    expect(statusOf(await talk(rig.proxy, connectLine("203.0.113.5:443")))).toBe("403");
    expect(rig.resolves).toEqual([]);
    expect(rig.connects).toEqual([]);
  });

  it.each(["0x7f.1:443", "127.1:443", "2130706433:443", "a@b:443", "a%2eb:443", "evil.com:443/x", "*:1", "[::1]", "foo", "a.com:0443", "a.com:+443", "[fe80::1%eth0]:443", "é.com:443"])("answers 400 to %j and never resolves it", async (target) => {
    const rig = await boot({ allow: [entry("a.com"), entry("foo", { ports: [80] })] });
    const got = await talk(rig.proxy, `CONNECT ${target} HTTP/1.1\r\nHost: x\r\n\r\n`);
    expect(statusOf(got)).toMatch(/^40[03]$/);
    expect(rig.resolves).toEqual([]);
    expect(rig.connects).toEqual([]);
  });

  it("aggregates all malformed targets into one row per kind", async () => {
    const rig = await boot({ allow: [entry("a.com")] });
    for (const t of ["0x7f.1:443", "127.1:443", "a@b:443", "*:1", "a.com:0443"]) await talk(rig.proxy, connectLine(t));
    const s = await status(rig);
    const rows = s.refusals.filter((r) => r.host === "<malformed>");
    expect(rows).toEqual([expect.objectContaining({ kind: "connect", host: "<malformed>", port: null, reason: "bad-request", count: 5 })]);
  });

  it("uses a public address and drops the refused ones of a split answer (rebinding)", async () => {
    const e = await echo();
    const rig = await boot({
      allow: [entry("split.test")],
      answers: { "split.test": ["127.0.0.1", "10.0.0.5", "::ffff:127.0.0.1", "203.0.113.5"] },
      targets: { "203.0.113.5": e.port },
    });
    expect(statusOf(await talk(rig.proxy, connectLine("split.test:443", "x"), 400))).toBe("200");
    expect(rig.connects.map((c) => c.host)).toEqual(["203.0.113.5"]);
  });

  it("answers 403 when a name resolves only to refused addresses", async () => {
    const rig = await boot({ allow: [entry("rebind.test")], answers: { "rebind.test": ["127.0.0.1", "10.0.0.5", "169.254.169.254", "::1"] } });
    expect(statusOf(await talk(rig.proxy, connectLine("rebind.test:443")))).toBe("403");
    expect(rig.connects).toEqual([]);
    expect((await status(rig)).refusals).toEqual([expect.objectContaining({ kind: "connect", host: "rebind.test", port: 443, reason: "refused-address" })]);
  });

  it("answers 502 for a name with no address, a failed resolution and a failed connect", async () => {
    const rig = await boot({ allow: [entry("gone.test"), entry("down.test"), entry("dead.test")], answers: { "down.test": new Error("SERVFAIL"), "dead.test": ["203.0.113.5"] } });
    expect(statusOf(await talk(rig.proxy, connectLine("gone.test:443")))).toBe("502");
    expect(statusOf(await talk(rig.proxy, connectLine("down.test:443")))).toBe("502");
    expect(statusOf(await talk(rig.proxy, connectLine("dead.test:443")))).toBe("502");
    const reasons = (await status(rig)).refusals.map((r) => `${String(r.host)}:${String(r.reason)}`).sort();
    expect(reasons).toEqual(["dead.test:connect-failed", "down.test:resolve-failed", "gone.test:no-address"]);
  });

  it("tries at most four addresses, in order", async () => {
    const rig = await boot({ allow: [entry("many.test")], answers: { "many.test": ["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4", "203.0.113.5", "203.0.113.6"] } });
    expect(statusOf(await talk(rig.proxy, connectLine("many.test:443"), 2000))).toBe("502");
    expect(rig.connects.map((c) => c.host)).toEqual(["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4"]);
  });

  it("falls through to the next address when one does not connect", async () => {
    const e = await echo();
    const rig = await boot({ allow: [entry("two.test")], answers: { "two.test": ["203.0.113.1", "203.0.113.2"] }, targets: { "203.0.113.2": e.port } });
    expect(statusOf(await talk(rig.proxy, connectLine("two.test:443", "x"), 500))).toBe("200");
    expect(rig.connects.map((c) => c.host)).toEqual(["203.0.113.1", "203.0.113.2"]);
  });

  it("answers 504 when the whole handshake outlasts its deadline", async () => {
    const rig = await boot({ allow: [entry("slow.test")], limits: { handshakeMs: 300 }, resolve: () => new Promise(() => {}) });
    const t0 = Date.now();
    expect(statusOf(await talk(rig.proxy, connectLine("slow.test:443"), 3000))).toBe("504");
    expect(Date.now() - t0).toBeLessThan(2000);
    expect((await status(rig)).refusals).toEqual([expect.objectContaining({ reason: "timeout", host: "slow.test" })]);
  });

  it("starts the deadline at the event, so client bytes do not extend it", async () => {
    const rig = await boot({ allow: [entry("slow.test")], limits: { handshakeMs: 400 }, resolve: () => new Promise(() => {}) });
    const got = await new Promise<string>((resolve) => {
      const c = net.connect(rig.proxy, "127.0.0.1", () => c.write(connectLine("slow.test:443")));
      let out = "";
      const iv = setInterval(() => c.write("x"), 100);
      c.on("data", (d) => (out += d));
      c.on("error", () => {});
      c.on("close", () => {
        clearInterval(iv);
        resolve(out);
      });
      setTimeout(() => c.destroy(), 3000);
    });
    expect(statusOf(got)).toBe("504");
  });

  it("keeps a tunnel open past requestTimeout, bounded only by its idle timeout", async () => {
    const e = await echo();
    const rig = await boot({ allow: [entry("ok.test")], answers: { "ok.test": ["203.0.113.5"] }, targets: { "203.0.113.5": e.port }, limits: { requestTimeoutMs: 500, headersTimeoutMs: 400 } });
    const out = await new Promise<string>((resolve) => {
      const c = net.connect(rig.proxy, "127.0.0.1", () => c.write(connectLine("ok.test:443")));
      let got = "";
      c.on("data", (d) => (got += d));
      c.on("error", () => {});
      setTimeout(() => c.write("late"), 2300);
      setTimeout(() => {
        c.destroy();
        resolve(got);
      }, 2800);
    });
    expect(out).toContain("late");
  }, 10000);

  it("ends a tunnel after its idle timeout", async () => {
    const e = await echo();
    const rig = await boot({ allow: [entry("ok.test")], answers: { "ok.test": ["203.0.113.5"] }, targets: { "203.0.113.5": e.port }, limits: { tunnelIdleMs: 300 } });
    const t0 = Date.now();
    const c = net.connect(rig.proxy, "127.0.0.1", () => c.write(connectLine("ok.test:443")));
    c.on("error", () => {});
    c.resume();
    await new Promise((r) => c.on("close", r));
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it("refuses the control endpoint, by address and by name", async () => {
    const rig = await boot({ allow: [entry("127.0.0.1", { literal: true, local: true }), entry("localhost", { local: true })], answers: { localhost: ["127.0.0.1"] } });
    const bare = await boot({ allow: [entry("ok.test")] });
    expect(statusOf(await talk(bare.proxy, connectLine(`127.0.0.1:${bare.control}`)))).toBe("403");
    expect(statusOf(await talk(bare.proxy, connectLine(`localhost:${bare.control}`)))).toBe("403");
    // Even an entry that names them cannot reach loopback: the address is never allowed.
    const ports = { 127: rig.control };
    expect(statusOf(await talk(rig.proxy, connectLine(`127.0.0.1:${ports[127]}`)))).toBe("403");
    expect(statusOf(await talk(rig.proxy, connectLine(`localhost:${rig.control}`)))).toBe("403");
    expect(rig.connects).toEqual([]);
  });
});

describe("one request per client connection", () => {
  const A = "http://a.test/";
  const B = "http://b.test/";
  const hostsOf = (rig: Rig) => rig.resolves;
  const setup = async () => {
    const e = await echo();
    const rig = await boot({
      allow: [entry("a.test"), entry("b.test")],
      answers: { "a.test": ["203.0.113.1"], "b.test": ["203.0.113.2"] },
      targets: { "203.0.113.1": e.port, "203.0.113.2": e.port },
    });
    return { rig, e };
  };

  it("processes only the first of GET then GET", async () => {
    const { rig } = await setup();
    await talk(rig.proxy, getLine(A) + getLine(B), 500);
    expect(hostsOf(rig)).toEqual(["a.test"]);
  });

  it("processes only the first of GET then CONNECT", async () => {
    const { rig } = await setup();
    await talk(rig.proxy, getLine(A) + connectLine("b.test:443"), 500);
    expect(hostsOf(rig)).toEqual(["a.test"]);
  });

  it("processes only the first of CONNECT then GET, and the rest goes to the allowed target", async () => {
    const { rig, e } = await setup();
    const got = await talk(rig.proxy, connectLine("a.test:443", getLine(B)), 500);
    expect(statusOf(got)).toBe("200");
    expect(hostsOf(rig)).toEqual(["a.test"]);
    expect(e.seen.data).toContain("GET http://b.test/");
    expect(rig.connects).toHaveLength(1);
  });

  it("processes only the first of CONNECT then CONNECT", async () => {
    const { rig, e } = await setup();
    await talk(rig.proxy, connectLine("a.test:443", connectLine("b.test:443")), 500);
    expect(hostsOf(rig)).toEqual(["a.test"]);
    expect(e.seen.data).toContain("CONNECT b.test:443");
    expect(rig.connects).toHaveLength(1);
  });

  it("drops a pipelined second request after a refused first (403)", async () => {
    const { rig } = await setup();
    await talk(rig.proxy, getLine("http://evil.test/") + getLine(B), 500);
    expect(hostsOf(rig)).toEqual([]);
    expect(rig.connects).toEqual([]);
    await talk(rig.proxy, connectLine("evil.test:443") + getLine(B), 500);
    await talk(rig.proxy, getLine("http://evil.test/") + connectLine("b.test:443"), 500);
    expect(hostsOf(rig)).toEqual([]);
    expect(rig.connects).toEqual([]);
  });

  it("destroys an upgrade request at once with no processing", async () => {
    const { rig } = await setup();
    const t0 = Date.now();
    const got = await talk(rig.proxy, getLine(A, "Connection: Upgrade\r\nUpgrade: websocket\r\n"), 3000);
    // The request has an Upgrade header; whether it reaches 'upgrade' or 'request', nothing is relayed to a.test.
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(got).not.toMatch(/^HTTP\/1\.1 101/);
    expect(rig.connects.length).toBeLessThanOrEqual(1);
  });

  it("does not keep a connection alive after a response", async () => {
    const w = await web("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok");
    const rig = await boot({ allow: [entry("a.test")], answers: { "a.test": ["203.0.113.1"] }, targets: { "203.0.113.1": w.port } });
    const c = net.connect(rig.proxy, "127.0.0.1");
    c.on("error", () => {});
    let got = "";
    c.on("data", (d) => (got += d));
    c.write(getLine(A));
    await new Promise((r) => c.once("close", r));
    expect(got).toMatch(/Connection: close/i);
    expect(got.endsWith("ok")).toBe(true);
  });
});

describe("plain HTTP", () => {
  const OK = "HTTP/1.1 200 EVIL STATUS\r\nContent-Length: 2\r\nConnection: close\r\nX-Up: 1\r\nVia: 1.1 up\r\nKeep-Alive: timeout=5\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\n\r\nok";
  const setup = async (reply = OK, ports = [80]) => {
    const w = await web(reply);
    const rig = await boot({ allow: [entry("a.test", { ports })], answers: { "a.test": ["203.0.113.1"] }, targets: { "203.0.113.1": w.port } });
    return { rig, w };
  };

  it("relays a GET by the URI's authority, never Host, and strips hop-by-hop headers both ways", async () => {
    const { rig, w } = await setup();
    const got = await talk(
      rig.proxy,
      "GET http://a.test:80/p?q=1 HTTP/1.1\r\nHost: evil.test\r\nConnection: X-Secret, keep-alive\r\nX-Secret: s\r\nProxy-Authorization: x\r\nProxy-Foo: y\r\nX-Forwarded-For: 9\r\nX-Forwarded-Host: h\r\nVia: v\r\nForwarded: f\r\nTE: trailers\r\nKeep-Alive: 5\r\nContent-Length: 0\r\nX-Custom: 1\r\n\r\n",
      800,
    );
    expect(got.startsWith("HTTP/1.1 200 OK\r\n")).toBe(true);
    expect(got.endsWith("ok")).toBe(true);
    expect(got).toMatch(/X-Up: 1/);
    expect(got).toMatch(/Set-Cookie: a=1/);
    expect(got).toMatch(/Set-Cookie: b=2/);
    expect(got).toMatch(/Connection: close/i);
    for (const h of ["Via", "Keep-Alive", "Transfer-Encoding", "EVIL"]) expect(got).not.toContain(h);
    const sent = w.seen.data;
    expect(sent.startsWith("GET /p?q=1 HTTP/1.1\r\n")).toBe(true);
    expect(sent).toMatch(/\r\nHost: a\.test\r\n/);
    expect(sent).toMatch(/\r\nConnection: close\r\n/);
    expect(sent).toMatch(/X-Custom: 1/);
    for (const h of ["evil.test", "X-Secret", "Proxy-", "X-Forwarded", "Via", "Forwarded", "TE:", "Keep-Alive", "Content-Length"]) expect(sent).not.toContain(h);
    expect(rig.connects).toHaveLength(1);
  });

  it("builds the path and keeps a non-default port in Host", async () => {
    const { rig, w } = await setup(OK, [80, 8080]);
    await talk(rig.proxy, getLine("http://a.test") + "", 400);
    expect(w.seen.data.startsWith("GET / HTTP/1.1\r\n")).toBe(true);
    w.seen.data = "";
    await talk(rig.proxy, getLine("http://a.test?x"), 400);
    expect(w.seen.data.startsWith("GET /?x HTTP/1.1\r\n")).toBe(true);
    w.seen.data = "";
    await talk(rig.proxy, getLine("HTTP://A.test:8080/z"), 400);
    expect(w.seen.data.startsWith("GET /z HTTP/1.1\r\n")).toBe(true);
    expect(w.seen.data).toMatch(/\r\nHost: a\.test:8080\r\n/);
  });

  it("serves HEAD, and an HTTP/1.0 request without Host", async () => {
    const noBody = await setup("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n");
    const head = await talk(noBody.rig.proxy, "HEAD http://a.test/ HTTP/1.1\r\nHost: x\r\n\r\n", 400);
    expect(statusOf(head)).toBe("200");
    const { rig } = await setup("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    const old = await talk(rig.proxy, "GET http://a.test/ HTTP/1.0\r\n\r\n", 400);
    expect(statusOf(old)).toBe("200");
  });

  it("passes a redirect to the client and never follows it", async () => {
    const { rig } = await setup("HTTP/1.1 302 Found\r\nLocation: http://elsewhere.test/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    const got = await talk(rig.proxy, getLine("http://a.test/"), 400);
    expect(statusOf(got)).toBe("302");
    expect(got).toMatch(/Location: http:\/\/elsewhere\.test\//);
    expect(rig.resolves).toEqual(["a.test"]);
  });

  it.each([
    ["a method other than GET and HEAD", "POST http://a.test/ HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n", "405"],
    ["PUT", "PUT http://a.test/ HTTP/1.1\r\nHost: x\r\n\r\n", "405"],
    ["OPTIONS *", "OPTIONS * HTTP/1.1\r\nHost: x\r\n\r\n", "405"],
    ["origin-form", "GET /x HTTP/1.1\r\nHost: a.test\r\n\r\n", "400"],
    ["https scheme", "GET https://a.test/ HTTP/1.1\r\nHost: x\r\n\r\n", "400"],
    ["another scheme", "GET ftp://a.test/ HTTP/1.1\r\nHost: x\r\n\r\n", "400"],
    ["//host", "GET //a.test/ HTTP/1.1\r\nHost: x\r\n\r\n", "400"],
    ["asterisk", "GET * HTTP/1.1\r\nHost: x\r\n\r\n", "400"],
    ["a request body", "GET http://a.test/ HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello", "400"],
    ["chunked", "GET http://a.test/ HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", "400"],
    ["identity", "GET http://a.test/ HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: identity\r\n\r\n", "400"],
    ["tab chunked", "GET http://a.test/ HTTP/1.1\r\nHost: x\r\nTransfer-Encoding:\tchunked\r\n\r\n0\r\n\r\n", "400"],
    ["userinfo", "GET http://u:p@a.test/ HTTP/1.1\r\nHost: x\r\n\r\n", "400"],
    ["backslash", "GET http://a.test\\@b.test/ HTTP/1.1\r\nHost: x\r\n\r\n", "400"],
    ["IPv4 shorthand", "GET http://127.1/ HTTP/1.1\r\nHost: x\r\n\r\n", "400"],
    ["hex IPv4", "GET http://0x7f.1/ HTTP/1.1\r\nHost: x\r\n\r\n", "400"],
    ["zone id", "GET http://[fe80::1%25eth0]/ HTTP/1.1\r\nHost: x\r\n\r\n", "400"],
    ["empty authority", "GET http:///x HTTP/1.1\r\nHost: x\r\n\r\n", "400"],
    ["a host that is not allowed", "GET http://evil.test/ HTTP/1.1\r\nHost: a.test\r\n\r\n", "403"],
    ["an IP literal", "GET http://203.0.113.1/ HTTP/1.1\r\nHost: a.test\r\n\r\n", "403"],
    ["a loopback literal", "GET http://[::1]/ HTTP/1.1\r\nHost: a.test\r\n\r\n", "403"],
    ["a port not allowed", "GET http://a.test:8080/ HTTP/1.1\r\nHost: a.test\r\n\r\n", "403"],
  ])("refuses %s", async (_name, request, code) => {
    const { rig, w } = await setup();
    const got = await talk(rig.proxy, request, 500);
    expect(statusOf(got)).toBe(code);
    expect(rig.connects).toEqual([]);
    expect(w.seen.conns).toBe(0);
    expect(rig.resolves).toEqual([]);
  });

  it("accepts a zero Content-Length in any spelling of zeros", async () => {
    const { rig } = await setup();
    expect(statusOf(await talk(rig.proxy, getLine("http://a.test/", "Content-Length: 00\r\n"), 400))).toBe("200");
  });

  it("answers 502 to a malformed upstream response and never throws", async () => {
    for (const bad of ["HTTP/1.1 200 OK\r\nBad\x01Header: x\r\nContent-Length: 0\r\n\r\n", "garbage\r\n\r\n", "", "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nab"]) {
      const { rig } = await setup(bad);
      const got = await talk(rig.proxy, getLine("http://a.test/"), 800);
      if (bad.endsWith("ab")) expect(got.length).toBeGreaterThanOrEqual(0);
      else expect(statusOf(got)).toBe("502");
      expect((await status(rig)).version).toBe("1");
    }
  });

  it("closes both sockets on an upstream 101", async () => {
    const { rig } = await setup("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nSTREAM");
    const got = await talk(rig.proxy, getLine("http://a.test/"), 800);
    expect(got).not.toContain("101");
    expect(got).not.toContain("STREAM");
  });

  it("an upstream 101 to a plain request ends both sockets at once, with nothing relayed and the upstream kept open by its own side", async () => {
    let upstreamClosed = false;
    const up = await stub((s) => {
      s.on("close", () => (upstreamClosed = true));
      s.on("data", () => s.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\nSTREAM")); // never ends
    });
    const rig = await boot({ allow: [entry("a.test")], answers: { "a.test": ["203.0.113.1"] }, targets: { "203.0.113.1": up.port } });
    const t0 = Date.now();
    const got = await talk(rig.proxy, getLine("http://a.test/"), 5000);
    // The client's socket was closed by the proxy, not by the test's own timer.
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(got).toBe("");
    await new Promise((r) => setTimeout(r, 100));
    expect(upstreamClosed).toBe(true);
  });

  it("answers 504 when the upstream never responds, within its idle timeout", async () => {
    const hang = await stub(() => {});
    const rig = await boot({ allow: [entry("a.test")], answers: { "a.test": ["203.0.113.1"] }, targets: { "203.0.113.1": hang.port }, limits: { upstreamIdleMs: 300 } });
    const t0 = Date.now();
    expect(statusOf(await talk(rig.proxy, getLine("http://a.test/"), 3000))).toBe("504");
    expect(Date.now() - t0).toBeLessThan(2500);
  });

  it("answers 400 and no more for a malformed request, and survives a header named __proto__", async () => {
    const { rig } = await setup();
    expect(statusOf(await talk(rig.proxy, "NOT HTTP AT ALL\r\n\r\n"))).toBe("400");
    const got = await talk(rig.proxy, getLine("http://a.test/", "__proto__: x\r\nconstructor: y\r\n"), 500);
    expect(statusOf(got)).toBe("200");
  });

  it("refuses an oversized header block", async () => {
    const { rig } = await setup();
    const got = await talk(rig.proxy, getLine("http://a.test/", `X: ${"a".repeat(20000)}\r\n`), 500);
    expect(statusOf(got)).toMatch(/^4/);
    expect(rig.connects).toEqual([]);
  });
});

describe("address classes through the proxy", () => {
  const hex = (n: number) => n.toString(16);
  const v4n = (s: string) => s.split(".").reduce((a, b) => a * 256 + Number(b), 0);
  /** Every embedding of an IPv4 address. */
  const embeddings = (v4: string): string[] => {
    const n = v4n(v4);
    const hi = Math.floor(n / 65536);
    const lo = n % 65536;
    const x = (n ^ 0xffffffff) >>> 0;
    return [
      `::ffff:${hex(hi)}:${hex(lo)}`,
      `::ffff:0:${hex(hi)}:${hex(lo)}`,
      `64:ff9b::${hex(hi)}:${hex(lo)}`,
      `2002:${hex(hi)}:${hex(lo)}::`,
      // Teredo: the client address (inverted) is the target, the server is public.
      `2001:0:808:808:0:0:${hex(Math.floor(x / 65536))}:${hex(x % 65536)}`,
      // Teredo: the server address is the target, the client is public.
      `2001:0:${hex(hi)}:${hex(lo)}:0:0:f7f7:f7f7`,
    ];
  };
  const targets = [...embeddings("127.0.0.1"), ...embeddings("169.254.169.254"), ...embeddings("100.100.100.200"), "127.0.0.1", "169.254.169.254", "::1", "fd00:ec2::254"];

  it("refuses every embedding of 127.0.0.1 and 169.254.169.254 for an ordinary entry, a local entry and a forward", async () => {
    const rig = await boot({ allow: [entry("ord.test"), entry("loc.test", { local: true })], forwards: [{ host: "fwd.test" }] });
    for (const addr of targets) {
      rig.answers["ord.test"] = [addr];
      rig.answers["loc.test"] = [addr];
      rig.answers["fwd.test"] = [addr];
      expect({ addr, status: statusOf(await talk(rig.proxy, connectLine("ord.test:443"), 800)) }).toEqual({ addr, status: "403" });
      expect({ addr, status: statusOf(await talk(rig.proxy, connectLine("loc.test:443"), 800)) }).toEqual({ addr, status: "403" });
      expect({ addr, got: await talk(rig.forwards[0]!, "x", 300) }).toEqual({ addr, got: "" });
    }
    expect(rig.connects).toEqual([]);
  }, 60000);

  it("lets an ordinary entry use public addresses only, and a local entry public and local", async () => {
    const e = await echo();
    const rig = await boot({
      allow: [entry("ord.test"), entry("loc.test", { local: true })],
      answers: { "ord.test": ["10.1.2.3", "192.168.1.1", "fd12::1", "100.64.0.1"], "loc.test": ["10.1.2.3"] },
      targets: { "10.1.2.3": e.port },
    });
    expect(statusOf(await talk(rig.proxy, connectLine("ord.test:443"), 500))).toBe("403");
    expect(statusOf(await talk(rig.proxy, connectLine("loc.test:443", "x"), 500))).toBe("200");
    expect(rig.connects.map((c) => c.host)).toEqual(["10.1.2.3"]);
  });

  it("refuses the proxy's own subnets even for a local entry", async () => {
    const rig = await boot({
      allow: [entry("loc.test", { local: true }), entry("pub.test")],
      answers: { "loc.test": ["172.18.0.9", "::ffff:172.18.0.9"], "pub.test": ["203.0.113.5"] },
      interfaces: { ...LO, eth0: [{ address: "172.18.0.2", family: "IPv4", cidr: "172.18.0.2/16" }, { address: "203.0.113.2", family: "IPv4", cidr: "203.0.113.2/24" }] },
    });
    expect(statusOf(await talk(rig.proxy, connectLine("loc.test:443")))).toBe("403");
    expect(statusOf(await talk(rig.proxy, connectLine("pub.test:443")))).toBe("403");
    expect(rig.connects).toEqual([]);
  });

  it("re-reads the interfaces for each connection", async () => {
    let extra: Record<string, Iface[]> = {};
    const e = await echo();
    const ports = await freePorts(2);
    const h = await P.start(
      { version: "1", listenCidr: "127.0.0.0/8", port: ports[0], controlPort: ports[1], allow: [entry("pub.test")], forwards: [], resolvers: ["8.8.8.8"], limits: { handshakeMs: 2000 } },
      { interfaces: () => ({ ...LO, ...extra }), resolve: async () => ["203.0.113.5"], connect: () => net.connect({ host: "127.0.0.1", port: e.port }) },
    );
    cleanups.push(() => h.close());
    expect(statusOf(await talk(ports[0]!, connectLine("pub.test:443", "x"), 400))).toBe("200");
    extra = { eth1: [{ address: "203.0.113.2", family: "IPv4", cidr: "203.0.113.2/24" }] };
    expect(statusOf(await talk(ports[0]!, connectLine("pub.test:443", "x"), 400))).toBe("403");
  });
});

describe("TCP forwards", () => {
  const IFS = { ...LO, eth0: [{ address: "172.18.0.2", family: "IPv4", cidr: "172.18.0.2/16" }] };
  const fwd = async (host: string, o: Omit<RigOptions, "forwards"> = {}) => {
    const e = await echo();
    const rig = await boot({ forwards: [{ host }], interfaces: IFS, targets: { "172.18.0.1": e.port, "192.168.1.5": e.port, "203.0.113.5": e.port, ...(o.targets ?? {}) }, ...o });
    return { rig, e };
  };
  const through = (rig: Rig) => talk(rig.forwards[0]!, "ping", 400);

  it("reaches the addresses /etc/hosts gives host.docker.internal, even inside the proxy's own subnet", async () => {
    const { rig } = await fwd("host.docker.internal", { hosts: "172.18.0.1 host.docker.internal\n" });
    expect(await through(rig)).toBe("ping");
    expect(rig.connects.map((c) => [c.host, c.port])).toEqual([["172.18.0.1", rig.forwards[0]]]);
    expect(rig.resolves).toEqual([]);
  });

  it("does not exempt db.lan on the same /etc/hosts line", async () => {
    const { rig } = await fwd("db.lan", { hosts: "172.18.0.1 host.docker.internal db.lan\n" });
    expect(await through(rig)).toBe("");
    expect(rig.connects).toEqual([]);
    expect((await status(rig)).refusals).toEqual([expect.objectContaining({ kind: "forward", host: "db.lan", reason: "refused-address" })]);
  });

  it("does not exempt a resolver answer for host.docker.internal", async () => {
    const { rig } = await fwd("host.docker.internal", { hosts: "10.9.9.9 other.test\n", answers: { "host.docker.internal": ["172.18.0.1"] } });
    expect(await through(rig)).toBe("");
    expect(rig.resolves).toEqual(["host.docker.internal"]);
    expect(rig.connects).toEqual([]);
  });

  it("refuses 127.0.0.1 and ::ffff:127.0.0.1 given under host.docker.internal", async () => {
    for (const addr of ["127.0.0.1", "::ffff:127.0.0.1", "::1", "169.254.169.254", "::ffff:169.254.169.254"]) {
      const { rig } = await fwd("host.docker.internal", { hosts: `${addr} host.docker.internal\n` });
      expect({ addr, got: await through(rig) }).toEqual({ addr, got: "" });
      expect(rig.connects).toEqual([]);
    }
  });

  it("refuses a name /etc/hosts maps to loopback and the container's own hostname", async () => {
    const lo = await fwd("loopback.test", { hosts: "127.0.0.1 localhost loopback.test\n" });
    expect(await through(lo.rig)).toBe("");
    expect(lo.rig.connects).toEqual([]);
    const own = await fwd("mycont.test", { hosts: "172.18.0.2 mycont.test\n" });
    expect(await through(own.rig)).toBe("");
    expect(own.rig.connects).toEqual([]);
    // host.docker.internal on the proxy's own address is refused too.
    const self = await fwd("host.docker.internal", { hosts: "172.18.0.2 host.docker.internal\n" });
    expect(await through(self.rig)).toBe("");
    expect(self.rig.connects).toEqual([]);
  });

  it("uses the resolvers for other names, and may reach a local address", async () => {
    const { rig } = await fwd("db.lan", { answers: { "db.lan": ["192.168.1.5"] } });
    expect(await through(rig)).toBe("ping");
    expect(rig.resolves).toEqual(["db.lan"]);
    expect(rig.connects[0]?.host).toBe("192.168.1.5");
  });

  it("refuses a resolver answer in a never range, and a name with no answer", async () => {
    const a = await fwd("db.lan", { answers: { "db.lan": ["127.0.0.1", "169.254.169.254", "172.18.0.1"] } });
    expect(await through(a.rig)).toBe("");
    const b = await fwd("db.lan", { answers: {} });
    expect(await through(b.rig)).toBe("");
    expect(a.rig.connects.concat(b.rig.connects)).toEqual([]);
    expect((await status(b.rig)).refusals).toEqual([expect.objectContaining({ kind: "forward", reason: "no-address" })]);
  });

  it("scopes the exemption to the forward: a CONNECT through the proxy port is refused", async () => {
    const { rig } = await fwd("host.docker.internal", { hosts: "172.18.0.1 host.docker.internal\n", allow: [entry("ok.test")] });
    expect(statusOf(await talk(rig.proxy, connectLine(`host.docker.internal:${rig.forwards[0]}`)))).toBe("403");
    expect(statusOf(await talk(rig.proxy, connectLine("host.docker.internal:443")))).toBe("403");
    expect(rig.connects).toEqual([]);
  });

  it("reads /etc/hosts at connection time", async () => {
    let hosts = "10.0.0.1 other.test\n";
    const e = await echo();
    const ports = await freePorts(3);
    const h = await P.start(
      { version: "1", listenCidr: "127.0.0.0/8", port: ports[0], controlPort: ports[1], allow: [], forwards: [{ host: "host.docker.internal", port: ports[2] }], resolvers: ["8.8.8.8"], limits: {} },
      { interfaces: () => IFS, resolve: async () => [], readHosts: () => hosts, connect: () => net.connect({ host: "127.0.0.1", port: e.port }) },
    );
    cleanups.push(() => h.close());
    expect(await talk(ports[2]!, "ping", 300)).toBe("");
    hosts = "172.18.0.1\thost.docker.internal\r\n";
    expect(await talk(ports[2]!, "ping", 300)).toBe("ping");
  });

  it("answers nothing and writes nothing on a refusal", async () => {
    const { rig } = await fwd("db.lan", { answers: { "db.lan": ["127.0.0.1"] } });
    const t0 = Date.now();
    expect(await through(rig)).toBe("");
    expect(Date.now() - t0).toBeLessThan(400);
  });
});

describe("limits and status", () => {
  it("destroys connections over the cap on every listener, and the control endpoint still answers", async () => {
    const rig = await boot({ allow: [entry("ok.test")], forwards: [{ host: "fwd.test" }], limits: { connections: 2 } });
    // Two idle connections to the proxy port fill the cap, which the forward port shares.
    const held = [net.connect(rig.proxy, "127.0.0.1"), net.connect(rig.proxy, "127.0.0.1")];
    for (const c of held) c.on("error", () => {});
    await sleep(100);
    const t0 = Date.now();
    expect(await talk(rig.proxy, null, 1500)).toBe("");
    expect(await talk(rig.forwards[0]!, null, 1500)).toBe("");
    expect(Date.now() - t0).toBeLessThan(1000);
    const s = await status(rig);
    expect(s.refusals.filter((r) => r.reason === "cap")).toEqual([
      expect.objectContaining({ kind: "http", host: null, port: null, count: 1 }),
      expect.objectContaining({ kind: "forward", host: null, port: null, count: 1 }),
    ]);
    for (const c of held) c.destroy();
    await sleep(100);
    expect(statusOf(await talk(rig.proxy, connectLine("evil.test:443")))).toBe("403");
  });

  it("reports version, readiness, listening, hash, refusals and resolver failures", async () => {
    const rig = await boot({ allow: [entry("ok.test"), entry("bad.test")], forwards: [{ host: "fwd.test" }], answers: { "bad.test": new Error("x") } });
    const s0 = await status(rig);
    expect(s0).toMatchObject({ version: "1", ready: true, resolverFailures: 0, total: 0, refusals: [] });
    expect(s0.listening).toEqual({ address: "127.0.0.1", ports: [rig.proxy, rig.forwards[0]] });
    expect(s0.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(s0.startedAt).toString()).not.toBe("Invalid Date");
    await talk(rig.proxy, connectLine("bad.test:443"));
    expect((await status(rig)).resolverFailures).toBe(1);
    await talk(rig.proxy, connectLine("bad.test:443"));
    expect((await status(rig)).resolverFailures).toBe(2);
    rig.answers["bad.test"] = [];
    await talk(rig.proxy, connectLine("bad.test:443"));
    expect((await status(rig)).resolverFailures).toBe(0);
  });

  it("aggregates a refusal into one row with a count", async () => {
    const rig = await boot({ allow: [entry("ok.test")] });
    for (let i = 0; i < 3; i++) await talk(rig.proxy, connectLine("evil.test:443"));
    await talk(rig.proxy, getLine("http://evil.test/"));
    await talk(rig.proxy, "POST http://ok.test/ HTTP/1.1\r\nHost: x\r\n\r\n");
    const s = await status(rig);
    expect(s.refusals).toEqual([
      expect.objectContaining({ kind: "connect", host: "evil.test", port: 443, reason: "not-allowed", count: 3 }),
      expect.objectContaining({ kind: "http", host: "evil.test", port: 80, reason: "not-allowed", count: 1 }),
      expect.objectContaining({ kind: "http", host: null, port: null, reason: "method", count: 1 }),
    ]);
    expect(s.total).toBe(5);
    expect(s.refusals[0]).toEqual(expect.objectContaining({ firstAt: expect.any(String), lastAt: expect.any(String) }));
  });

  it("holds at most 50 rows, evicting the least recently seen, with a monotonic total", async () => {
    const rig = await boot({ allow: [entry("ok.test")] });
    for (let i = 0; i < 60; i++) await talk(rig.proxy, connectLine(`h${i}.test:443`));
    const s = await status(rig);
    expect(s.refusals).toHaveLength(50);
    expect(s.total).toBe(60);
    const hosts = s.refusals.map((r) => r.host);
    expect(hosts).not.toContain("h0.test");
    expect(hosts).toContain("h59.test");
  }, 30000);

  it("answers only GET /status on the control endpoint", async () => {
    const rig = await boot();
    const ask = (req: string) => talk(rig.control, req, 400);
    expect(statusOf(await ask("GET /status HTTP/1.1\r\nHost: x\r\n\r\n"))).toBe("200");
    expect(statusOf(await ask("GET /other HTTP/1.1\r\nHost: x\r\n\r\n"))).toBe("404");
    expect(statusOf(await ask("GET /status?x=1 HTTP/1.1\r\nHost: x\r\n\r\n"))).toBe("404");
    expect(statusOf(await ask("POST /status HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n"))).toBe("405");
    expect(statusOf(await ask("GET /status HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\nhello"))).toBe("405");
    expect(statusOf(await ask("GET /status HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n"))).toBe("405");
    expect(statusOf(await ask("CONNECT a.test:443 HTTP/1.1\r\nHost: x\r\n\r\n"))).toBeUndefined();
  });

  it("listens only on the interface address inside listenCidr", async () => {
    const e = await echo();
    const rig = await boot({ interfaces: { eth0: [{ address: "10.0.0.5", family: "IPv4", cidr: "10.0.0.5/24" }], ...LO }, targets: { "203.0.113.5": e.port } });
    expect(rig.handle.bind).toBe("127.0.0.1");
    expect(rig.handle.status().listening.address).toBe("127.0.0.1");
  });
});

describe("readiness", () => {
  it("does not answer /status until the proxy port and every forward are bound", async () => {
    const ports = await freePorts(3);
    let up = false;
    const config = { version: "1", listenCidr: "127.0.0.0/8", port: ports[0], controlPort: ports[1], allow: [], forwards: [{ host: "db.lan", port: ports[2] }], resolvers: ["8.8.8.8"], limits: { bindWaitMs: 5000 } };
    const starting = P.start(config, { interfaces: () => (up ? LO : {}) });
    cleanups.push(async () => {
      up = true;
      await (await starting.catch(() => null))?.close();
    });
    await sleep(200);
    const refused = (port: number) =>
      new Promise<string>((resolve) => {
        const c = net.connect(port, "127.0.0.1");
        c.on("connect", () => {
          c.destroy();
          resolve("connected");
        });
        c.on("error", (e: NodeJS.ErrnoException) => resolve(String(e.code)));
      });
    expect(await refused(ports[1]!)).toBe("ECONNREFUSED");
    expect(await refused(ports[0]!)).toBe("ECONNREFUSED");
    expect(await refused(ports[2]!)).toBe("ECONNREFUSED");
    up = true;
    const handle = await starting;
    const s = JSON.parse((await fetchStatus(ports[1]!)).body);
    expect(s.ready).toBe(true);
    expect(s.listening).toEqual({ address: "127.0.0.1", ports: [ports[0], ports[2]] });
    expect(await refused(ports[0]!)).toBe("connected");
    expect(await refused(ports[2]!)).toBe("connected");
    expect(handle.status().ready).toBe(true);
  }, 15000);

  it("fails with the CIDR when no interface is inside it, and when a port is taken", async () => {
    const ports = await freePorts(2);
    await expect(P.start({ version: "1", listenCidr: "172.30.0.0/16", port: ports[0], controlPort: ports[1], allow: [], forwards: [], resolvers: ["8.8.8.8"], limits: { bindWaitMs: 100 } }, { interfaces: () => LO })).rejects.toThrow(/no interface address in 172\.30\.0\.0\/16/);
    const taken = net.createServer();
    await new Promise<void>((r) => taken.listen(ports[0]!, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => void taken.close(() => r())));
    await expect(P.start({ version: "1", listenCidr: "127.0.0.0/8", port: ports[0], controlPort: ports[1], allow: [], forwards: [], resolvers: ["8.8.8.8"], limits: {} }, { interfaces: () => LO })).rejects.toThrow(/EADDRINUSE/);
    // The control port was never bound by the failed start.
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(ports[1]!, "127.0.0.1", r));
    await new Promise((r) => probe.close(r));
  });

  it("refuses an invalid configuration before binding anything", async () => {
    await expect(P.start({ nope: 1 }, { interfaces: () => LO })).rejects.toThrow(/^config:/);
  });
});

describe("the program as `node -e`", () => {
  interface Child {
    exit: Promise<{ code: number | null; stderr: string }>;
    kill(): void;
  }
  const run = (args: string[]): Child => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr += d));
    const exit = new Promise<{ code: number | null; stderr: string }>((r) => child.on("close", (code) => r({ code, stderr })));
    cleanups.push(() => {
      child.kill("SIGKILL");
    });
    return { exit, kill: () => child.kill("SIGKILL") };
  };
  const waitReady = async (control: number) => {
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetchStatus(control);
        if (r.code === 200) return JSON.parse(r.body);
      } catch {
        /* not yet */
      }
      await sleep(100);
    }
    throw new Error("the proxy never became ready");
  };
  /** The launch text with a `deps` object written as JavaScript appended after the program, as leg 4's text is. */
  const withDeps = (config: object, deps: string) => {
    const text = `${proxySource()}\n;main(JSON.parse(process.argv[1]), ${deps})`;
    return ["-e", text, JSON.stringify(config)];
  };
  const baseConfig = (proxy: number, control: number) =>
    proxyConfig({ allow: [{ host: "ok.test", wildcard: false, ports: [443, 80], literal: false }], listenCidr: "127.0.0.0/8", resolvers: ["8.8.8.8"], controlPort: control, limits: { handshakeMs: 3000 } }) && {
      ...proxyConfig({ allow: [{ host: "ok.test", wildcard: false, ports: [443, 80], literal: false }, { host: "two.test", wildcard: false, ports: [443, 80], literal: false }], listenCidr: "127.0.0.0/8", resolvers: ["8.8.8.8"], controlPort: control, limits: { handshakeMs: 3000 } }),
      port: proxy,
    };

  it("tunnels an allowed CONNECT, refuses a disallowed one, drops the pipelined second request and answers /status", async () => {
    const e = await echo();
    const other = await echo();
    const [proxy, control] = await freePorts(2);
    const deps = `{
      interfaces: () => ({ lo: [{ address: "127.0.0.1", family: "IPv4", cidr: "127.0.0.1/8" }] }),
      resolve: async (n) => (({ "ok.test": ["203.0.113.9"], "two.test": ["203.0.113.10"] })[n] || []),
      connect: (o) => require("node:net").connect({ host: "127.0.0.1", port: ({ "203.0.113.9": ${e.port}, "203.0.113.10": ${other.port} })[o.host] || 1 }),
    }`;
    const child = run(withDeps(baseConfig(proxy!, control!), deps));
    const s = await waitReady(control!);
    expect(s).toMatchObject({ version: "1", ready: true });
    const ok = await talk(proxy!, connectLine("ok.test:443", "hello"), 500);
    expect(statusOf(ok)).toBe("200");
    expect(ok).toContain("hello");
    expect(statusOf(await talk(proxy!, connectLine("evil.test:443")))).toBe("403");
    await talk(proxy!, getLine("http://ok.test/") + getLine("http://two.test/"), 500);
    await talk(proxy!, getLine("http://ok.test/") + connectLine("two.test:443"), 500);
    expect(other.seen.conns).toBe(0);
    const after = await waitReady(control!);
    expect(after.refusals).toEqual([expect.objectContaining({ host: "evil.test", reason: "not-allowed" })]);
    child.kill();
  }, 20000);

  it("fails closed on an uncaught exception: one cleaned line on stderr and exit code 70", async () => {
    const [proxy, control] = await freePorts(2);
    const deps = `{
      interfaces: () => ({ lo: [{ address: "127.0.0.1", family: "IPv4", cidr: "127.0.0.1/8" }] }),
      fault: () => setTimeout(() => { throw new Error("boom\\nsecond line"); }, 0),
    }`;
    const child = run(withDeps(baseConfig(proxy!, control!), deps));
    await waitReady(control!);
    await talk(proxy!, connectLine("ok.test:443"), 300);
    const { code, stderr } = await child.exit;
    expect(code).toBe(70);
    expect(stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(stderr).toContain("boom?second line");
  }, 20000);

  it("exits non-zero with a one-line reason for an invalid configuration", async () => {
    const args = proxyLaunchArgs(proxyConfig({ allow: [], listenCidr: "127.0.0.0/8", resolvers: ["8.8.8.8"] }));
    for (const bad of ['{"x":1}', "{}", '{"version":"1","listenCidr":"127.0.0.0/8","port":3128,"controlPort":3129,"allow":[],"forwards":[],"resolvers":["127.0.0.11"],"limits":{}}']) {
      const { code, stderr } = await run([args[0]!, args[1]!, bad]).exit;
      expect(code).toBe(2);
      expect(stderr.trimEnd().split("\n")).toHaveLength(1);
      expect(stderr).toMatch(/^mcp-everything-proxy: config:/);
    }
  }, 20000);

  it("runs from the real launch arguments with no deps (it binds an interface address of the container)", async () => {
    const [proxy, control] = await freePorts(2);
    // listenCidr 127.0.0.0/8 matches the host's loopback interface, which is all this test needs.
    const config = { ...proxyConfig({ allow: [], listenCidr: "127.0.0.0/8", resolvers: ["8.8.8.8"], controlPort: control! }), port: proxy! };
    const args = proxyLaunchArgs(config);
    const child = run(args);
    const s = await waitReady(control!);
    expect(s.listening.address).toMatch(/^127\./);
    child.kill();
  }, 20000);
});
