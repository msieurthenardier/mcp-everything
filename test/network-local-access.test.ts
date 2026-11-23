import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ConfigError } from "../src/errors.js";
import { parseRepoRef } from "../src/forge/repo-ref.js";
import { localAccessFor, parseLocalAccess } from "../src/network/local-access.js";

const HOSTS = { "github.com": "github", "gitlab.com": "gitlab", "git.example.com": "gitlab" } as const;
const parse = (raw: string | undefined) => parseLocalAccess(raw, { ...HOSTS });
const bad = (raw: string, re: RegExp) => {
  expect(() => parse(raw)).toThrow(ConfigError);
  expect(() => parse(raw)).toThrow(re);
};

describe("parseLocalAccess", () => {
  it("is empty when unset, empty or only separators", () => {
    expect(parse(undefined)).toEqual({});
    expect(parse("")).toEqual({});
    expect(parse(" ; ;")).toEqual({});
  });
  it("accepts a plain key, a github: key and a URL key, stored by lower-cased id", () => {
    expect(parse("Acme/Postgres-MCP=db.lan:5432")).toEqual({ "github:acme/postgres-mcp": [{ host: "db.lan", port: 5432 }] });
    expect(parse("github:o/r=db.lan:5432")).toEqual({ "github:o/r": [{ host: "db.lan", port: 5432 }] });
    expect(parse("https://github.com/O/R=db.lan:5432")).toEqual({ "github:o/r": [{ host: "db.lan", port: 5432 }] });
    expect(parse("git.example.com/g/r=cache.lan:6379")).toEqual({ "git.example.com:g/r": [{ host: "cache.lan", port: 6379 }] });
  });
  it("splits several targets and repositories, ignoring whitespace and a trailing ;", () => {
    expect(parse(" a/b = db.lan:5432 , host.docker.internal:6379 ; c/d=x.lan:1; ")).toEqual({
      "github:a/b": [{ host: "db.lan", port: 5432 }, { host: "host.docker.internal", port: 6379 }],
      "github:c/d": [{ host: "x.lan", port: 1 }],
    });
  });
  it("removes one trailing dot from a target", () => {
    expect(parse("a/b=db.lan.:5432")["github:a/b"]).toEqual([{ host: "db.lan", port: 5432 }]);
  });
  it("allows one host on different ports, and one port for different repositories", () => {
    expect(parse("a/b=db.lan:6379,db.lan:6380")["github:a/b"]).toHaveLength(2);
    expect(Object.keys(parse("a/b=db.lan:5432;c/d=db.lan:5432"))).toHaveLength(2);
  });

  it("refuses a key parseRepoRef refuses, naming it", () => {
    bad("nope=db.lan:5432", /repository "nope" is not valid/);
    bad("https://example.org/a/b=db.lan:5432", /example\.org/);
  });
  it("refuses a repository named twice, in any case or spelling", () => {
    bad("a/b=db.lan:1;A/B=db.lan:2", /named twice/);
    bad("a/b=db.lan:1;github:a/b=db.lan:2", /named twice/);
  });
  it("refuses a segment with no = or no target", () => {
    bad("a/b", /needs the form/);
    bad("a/b=", /names no target/);
  });
  it("refuses an IP literal and says why", () => {
    bad("a/b=192.168.1.20:5432", /IP literal.*by a name.*host\.docker\.internal/);
    bad("a/b=[::1]:5432", /IP literal/);
    bad("a/b=192.168.1.20.:5432", /IP literal/);
  });
  it("refuses a missing port, a bad port, a wildcard and a single label", () => {
    bad("a/b=db.lan", /needs a port/);
    bad("a/b=db.lan:0", /port "0"/);
    bad("a/b=*.a.com:80", /wildcard/);
    bad("a/b=db:5432", /two labels/);
    bad("a/b=127.1:5432", /last label that is a number/);
  });
  it("refuses two targets on one port, naming both, and the proxy's own port", () => {
    bad("a/b=db.lan:5432,cache.lan:5432", /db\.lan:5432 and cache\.lan:5432/);
    bad("a/b=db.lan:3128", /port 3128, the proxy's own/);
  });
  it("quotes at most 80 characters of the segment, not the whole variable", () => {
    const long = `a/b=${"x".repeat(200)}.lan:1`;
    let msg = "";
    try {
      parse(`c/d=ok.lan:1;${long}`);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).not.toContain("c/d");
    expect(msg).not.toContain("x".repeat(100));
    expect(msg).toContain("x".repeat(60));
  });
});

describe("localAccessFor", () => {
  const cfg = loadConfig({ MCPE_LOCAL_ACCESS: "Acme/Postgres-MCP=db.lan:5432,db.lan:5433", MCPE_EXTRA_HOSTS: "git.example.com=gitlab" });
  it("returns the repository's targets, comparing ids case-insensitively", () => {
    expect(localAccessFor(cfg, parseRepoRef("acme/postgres-mcp", cfg.hosts))).toEqual([
      { host: "db.lan", port: 5432 },
      { host: "db.lan", port: 5433 },
    ]);
    expect(localAccessFor(cfg, parseRepoRef("ACME/POSTGRES-MCP", cfg.hosts))).toHaveLength(2);
  });
  it("returns [] for another repository, and a copy each time", () => {
    expect(localAccessFor(cfg, parseRepoRef("acme/other", cfg.hosts))).toEqual([]);
    localAccessFor(cfg, parseRepoRef("acme/postgres-mcp", cfg.hosts)).length = 0;
    expect(localAccessFor(cfg, parseRepoRef("acme/postgres-mcp", cfg.hosts))).toHaveLength(2);
  });
  it("resolves keys through MCPE_EXTRA_HOSTS", () => {
    const c = loadConfig({ MCPE_EXTRA_HOSTS: "git.example.com=gitlab", MCPE_LOCAL_ACCESS: "git.example.com/g/r=x.lan:1" });
    expect(localAccessFor(c, parseRepoRef("git.example.com/g/r", c.hosts))).toEqual([{ host: "x.lan", port: 1 }]);
    expect(() => loadConfig({ MCPE_LOCAL_ACCESS: "https://git.example.com/g/r=x.lan:1" })).toThrow(ConfigError);
  });
});
