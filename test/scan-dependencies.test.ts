import { describe, expect, it } from "vitest";
import { parseRepoRef } from "../src/forge/repo-ref.js";
import {
  dependencyFindings,
  detailId,
  githubOsvLookup,
  inertDependencyLookup,
  isExactVersion,
  orderAffected,
  parseSbom,
  type AffectedPackage,
} from "../src/scan/dependencies.js";
import { decide } from "../src/scan/policy.js";
import { MAX_FINDINGS } from "../src/scan/sarif.js";
import type { CheckOutcome } from "../src/scan/types.js";

const GH = parseRepoRef("acme/widget", { "github.com": "github", "gitlab.com": "gitlab" } as never);
const never = () => new AbortController().signal;

// ---- hand-written payloads -----------------------------------------------------------------------------------------

const sbom = (purls: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    sbom: {
      SPDXID: "SPDXRef-DOCUMENT",
      packages: [
        { SPDXID: "SPDXRef-repo", name: "com.github.acme/widget", externalRefs: [{ referenceType: "purl", referenceLocator: "pkg:github/acme/widget" }] },
        ...purls.map((p, i) => ({ SPDXID: `SPDXRef-p${i}`, name: `n${i}`, versionInfo: "1", externalRefs: [{ referenceType: "purl", referenceLocator: p }] })),
      ],
      relationships: [{ spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: "SPDXRef-repo" }],
      ...extra,
    },
  });

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect?: string;
}

type Route = (call: Call) => Response | Promise<Response> | undefined;

function fakeFetch(...routes: Route[]) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? init.body : undefined,
      redirect: init?.redirect,
    };
    calls.push(call);
    for (const r of routes) {
      const res = await r(call);
      if (res) return res;
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
const graph = (purls: string[]): Route => (c) => (c.url.endsWith("/dependency-graph/sbom") ? json(sbom(purls)) : undefined);
const osv =
  (vulns: Record<string, string[]>): Route =>
  (c) => {
    if (!c.url.endsWith("/v1/querybatch")) return undefined;
    const q = (JSON.parse(c.body!) as { queries: Array<{ package: { purl: string } }> }).queries;
    return json({ results: q.map((x) => ({ vulns: (vulns[x.package.purl] ?? []).map((id) => ({ id, modified: "2025-01-01T00:00:00Z" })) })) });
  };
const detail =
  (m: Record<string, { summary?: string; severity?: string }>): Route =>
  (c) => {
    const id = decodeURIComponent(c.url.split("/v1/vulns/")[1] ?? "");
    if (!c.url.includes("/v1/vulns/")) return undefined;
    const d = m[id];
    return d ? json({ id, summary: d.summary, database_specific: { severity: d.severity } }) : new Response("x", { status: 404 });
  };

const lookup = (f: ReturnType<typeof fakeFetch>, token?: string, deadlineMs?: number) => githubOsvLookup({ fetch: f.fetch, githubToken: token, deadlineMs });

// ---- the pure parts ------------------------------------------------------------------------------------------------

describe("parseSbom", () => {
  it("skips the described repository and takes the first purl of each package", () => {
    const r = parseSbom(sbom(["pkg:npm/lodash@4.17.15", "pkg:pypi/jinja2@3.1.2"]));
    expect(r).toEqual({
      ok: true,
      packages: [
        { purl: "pkg:npm/lodash@4.17.15", name: "n0", version: "1" },
        { purl: "pkg:pypi/jinja2@3.1.2", name: "n1", version: "1" },
      ],
    });
  });

  it("ignores what is not shaped as expected, and never throws", () => {
    const text = JSON.stringify({
      sbom: {
        packages: [
          null,
          5,
          { SPDXID: "a" },
          { externalRefs: "x" },
          { externalRefs: [{ referenceType: "cpe23Type", referenceLocator: "cpe:x" }] },
          { externalRefs: [{ referenceType: "purl", referenceLocator: 7 }] },
          { externalRefs: [{ referenceType: "purl", referenceLocator: "pkg:npm/ok@1.2.3" }] },
        ],
        relationships: "no",
      },
    });
    expect(parseSbom(text)).toEqual({ ok: true, packages: [{ purl: "pkg:npm/ok@1.2.3" }] });
  });

  it("reads own properties only", () => {
    const text = '{"__proto__":{"sbom":{"packages":[]}}}';
    expect(parseSbom(text)).toEqual({ ok: false });
  });

  it("is a failure for a body that is not JSON or has no packages array", () => {
    expect(parseSbom("<html>")).toEqual({ ok: false });
    expect(parseSbom("[]")).toEqual({ ok: false });
    expect(parseSbom("{}")).toEqual({ ok: false });
    expect(parseSbom('{"sbom":{"packages":{}}}')).toEqual({ ok: false });
  });
});

describe("isExactVersion", () => {
  const pos: Array<[string, string]> = [
    ["npm", "pkg:npm/lodash@4.17.15"],
    ["npm", "pkg:npm/%40scope/name@1.2.3-beta.1"],
    ["pypi", "pkg:pypi/jinja2@3.1.2"],
    ["pypi", "pkg:pypi/x@1.0"],
    ["golang", "pkg:golang/golang.org/x/net@v0.33.0"],
    ["golang", "pkg:golang/x/y@v0.0.0-20210101120000-abcdef123456"],
    ["golang", "pkg:golang/x/y@v2.0.0+incompatible"],
    ["cargo", "pkg:cargo/serde@1.0.200"],
    ["gem", "pkg:gem/rails@7.1.3.2"],
    ["maven", "pkg:maven/org.x/y@1.0.0"],
    ["composer", "pkg:composer/a/b@2.4.1"],
    ["nuget", "pkg:nuget/Newtonsoft.Json@13.0.3"],
    ["npm", "pkg:npm/a@1.2.3?x=y#sub"],
  ];
  const neg: Array<[string, string]> = [
    ["npm", "pkg:npm/cookie@%5E0.7.1"],
    ["npm", "pkg:npm/a@~1.2.3"],
    ["npm", "pkg:npm/a@1.2"],
    ["npm", "pkg:npm/a@4"],
    ["npm", "pkg:npm/a@1.2.x"],
    ["npm", "pkg:npm/a@*"],
    ["npm", "pkg:npm/a@github:user/repo"],
    ["npm", "pkg:npm/a@file:../x"],
    ["npm", "pkg:npm/a@workspace:*"],
    ["npm", "pkg:npm/a@link:../x"],
    ["npm", "pkg:npm/a@npm%3Aother"],
    ["npm", "pkg:npm/a"],
    ["pypi", "pkg:pypi/a@%3E%3D1.0"],
    ["pypi", "pkg:pypi/a@2024"],
    ["golang", "pkg:golang/x/y@latest"],
    ["cargo", "pkg:cargo/a@%5E1.0"],
    ["gem", "pkg:gem/a@~%3E1.2"],
    ["maven", "pkg:maven/a/b@${project.version}"],
    ["maven", "pkg:maven/a/b@LATEST"],
    ["maven", "pkg:maven/a/b@RELEASE"],
    ["maven", "pkg:maven/a/b@[1.0,2.0)"],
    ["maven", "pkg:maven/a/b@1.0.+"],
    ["composer", "pkg:composer/a/b@dev-main"],
    ["composer", "pkg:composer/a/b@%5E2.0"],
    ["nuget", "pkg:nuget/a@%5B1.0,2.0)"],
  ];
  it.each(pos)("%s: %s is exact", (type, purl) => expect(isExactVersion(type, purl)).toBe(true));
  it.each(neg)("%s: %s is not exact", (type, purl) => expect(isExactVersion(type, purl)).toBe(false));
  it("takes a bare version as well", () => {
    expect(isExactVersion("npm", "1.2.3")).toBe(true);
    expect(isExactVersion("npm", "1.2")).toBe(false);
    expect(isExactVersion("maven", "${project.version}")).toBe(false);
  });
});

describe("dependencyFindings", () => {
  const pkg = (name: string, ids: string[], version = "1.0.0"): AffectedPackage => ({ key: `pkg:npm/${name}@${version}`, type: "npm", name, version, ids });

  it("makes MAL- ids errors and the rest warnings, with exact counts and errors first", () => {
    const a = [pkg("a", ["GHSA-1"]), pkg("b", ["MAL-2025-1", "GHSA-2"]), pkg("c", ["CVE-3"])];
    const r = dependencyFindings(a);
    expect(r.counts).toEqual({ error: 1, warning: 2, note: 0 });
    expect(r.findings.map((f) => [f.level, f.ruleId, f.location])).toEqual([
      ["error", "malicious-package", "npm:b"],
      ["warning", "vulnerable-package", "npm:a"],
      ["warning", "vulnerable-package", "npm:c"],
    ]);
    expect(r.findings[0]).toMatchObject({ check: "dependencies", message: "b 1.0.0: known malicious (MAL-2025-1, GHSA-2)" });
    expect(r.findings[1]!.message).toBe("a 1.0.0: known vulnerable (GHSA-1)");
  });

  it("shows at most five ids, then how many more, and the summary and severity when fetched", () => {
    const ids = ["A-1", "A-2", "A-3", "A-4", "A-5", "A-6", "A-7"];
    const r = dependencyFindings([pkg("x", ids)], new Map([["pkg:npm/x@1.0.0", { summary: "bad things", severity: "HIGH" }]]));
    expect(r.findings[0]!.message).toBe("x 1.0.0: known vulnerable (A-1, A-2, A-3, A-4, A-5, and 2 more): bad things");
    expect(r.findings[0]!.securitySeverity).toBe("HIGH");
  });

  it("keeps at most MAX_FINDINGS, errors first, and counts the rest as omitted while the counts stay exact", () => {
    const many = Array.from({ length: 30 }, (_, i) => pkg(`p${i}`, i === 29 ? ["MAL-1"] : ["GHSA-1"]));
    const r = dependencyFindings(many);
    expect(r.findings).toHaveLength(MAX_FINDINGS);
    expect(r.findings[0]!.level).toBe("error");
    expect(r.omitted).toBe(10);
    expect(r.counts).toEqual({ error: 1, warning: 29, note: 0 });
    expect(orderAffected(many)[0]!.name).toBe("p29");
    expect(detailId(pkg("z", ["GHSA-1", "MAL-9", "MAL-10"]))).toBe("MAL-9");
    expect(detailId(pkg("z", ["GHSA-1", "GHSA-2"]))).toBe("GHSA-1");
  });

  it("cleans and bounds hostile text", () => {
    const r = dependencyFindings(
      [pkg("evil\u001b[31m\nname" + "x".repeat(500), ["GHSA-" + "9".repeat(500)])],
      new Map([["pkg:npm/evil\u001b[31m\nname" + "x".repeat(500) + "@1.0.0", { summary: "line\nbreak\u0007" + "s".repeat(1000), severity: "H".repeat(100) }]]),
    );
    const f = r.findings[0]!;
    expect(f.message.length).toBeLessThanOrEqual(200);
    expect(f.location!.length).toBeLessThanOrEqual(120);
    expect(f.securitySeverity!.length).toBeLessThanOrEqual(16);
    for (const s of [f.message, f.location!, f.securitySeverity!]) expect(s).not.toMatch(/[\u0000-\u001f]/);
  });
});

// ---- the lookup ----------------------------------------------------------------------------------------------------

describe("inertDependencyLookup", () => {
  it("answers nothing and records its calls", async () => {
    const l = inertDependencyLookup();
    expect(await l.check(GH, "main", never())).toBeUndefined();
    expect(l.calls).toEqual([{ repo: GH, ref: "main" }]);
  });
});

describe("githubOsvLookup: which repositories", () => {
  it("sends nothing for a GitLab repository", async () => {
    const f = fakeFetch();
    const repo = parseRepoRef("gitlab.com/group/proj", { "github.com": "github", "gitlab.com": "gitlab" } as never);
    const out = (await lookup(f).check(repo, undefined, never()))!;
    expect(out).toMatchObject({ status: "not-run", error: "GitLab has no public dependency graph", contacted: [] });
    expect(f.calls).toEqual([]);
  });

  it("names the host for another forge", async () => {
    const f = fakeFetch();
    const repo = { ...GH, forge: "gitea", host: "git.example.org" } as never;
    const out = (await lookup(f).check(repo, undefined, never()))!;
    expect(out).toMatchObject({ status: "not-run", error: "git.example.org has no public dependency graph", contacted: [] });
    expect(f.calls).toEqual([]);
  });

  it("returns cancelled, sending nothing, for a signal that is already aborted", async () => {
    const f = fakeFetch();
    const out = (await lookup(f).check(GH, undefined, AbortSignal.abort()))!;
    expect(out).toMatchObject({ status: "failed", error: "the dependency check was cancelled", contacted: [] });
    expect(f.calls).toEqual([]);
  });
});

describe("githubOsvLookup: a pinned ref", () => {
  const repoRoute = (branch: string): Route => (c) => (c.url.endsWith("/repos/acme/widget") ? json({ default_branch: branch }) : undefined);

  it("not-run when the ref is not the default branch; nothing goes to OSV", async () => {
    const f = fakeFetch(repoRoute("main"));
    const out = (await lookup(f).check(GH, "v1.2.0", never()))!;
    expect(out).toMatchObject({
      status: "not-run",
      error: "GitHub's dependency graph describes the default branch (main), not v1.2.0; check without a ref to see it",
      contacted: ["github"],
    });
    expect(f.calls.map((c) => c.url)).toEqual(["https://api.github.com/repos/acme/widget"]);
  });

  it("goes on when the ref is the default branch", async () => {
    const f = fakeFetch(repoRoute("main"), graph(["pkg:npm/lodash@4.17.15"]), osv({}));
    const out = (await lookup(f).check(GH, "main", never()))!;
    expect(out).toMatchObject({ status: "ran", contacted: ["github", "osv"], lookedUp: 1 });
    expect(f.calls[0]!.url).toBe("https://api.github.com/repos/acme/widget");
  });

  it("skips the repository call for an absent, empty or HEAD ref", async () => {
    for (const ref of [undefined, "", "HEAD"]) {
      const f = fakeFetch(graph([]));
      await lookup(f).check(GH, ref, never());
      expect(f.calls.map((c) => c.url)).toEqual(["https://api.github.com/repos/acme/widget/dependency-graph/sbom"]);
    }
  });

  it("fails when the repository answer cannot be used", async () => {
    const f = fakeFetch((c) => (c.url.endsWith("/repos/acme/widget") ? json("nope") : undefined));
    expect(await lookup(f).check(GH, "x", never())).toMatchObject({ status: "failed", error: "GitHub's repository answer could not be read", contacted: ["github"] });
  });
});

describe("githubOsvLookup: the graph", () => {
  it("sends the headers, and the token only to GitHub", async () => {
    const f = fakeFetch(graph(["pkg:npm/lodash@4.17.15"]), osv({}));
    await lookup(f, "tok123").check(GH, undefined, never());
    const gh = f.calls.filter((c) => c.url.startsWith("https://api.github.com/"));
    const other = f.calls.filter((c) => !c.url.startsWith("https://api.github.com/"));
    expect(gh).toHaveLength(1);
    expect(gh[0]!.headers).toMatchObject({ Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", Authorization: "Bearer tok123" });
    expect(other.length).toBeGreaterThan(0);
    for (const c of other) {
      expect(Object.keys(c.headers).map((k) => k.toLowerCase())).not.toContain("authorization");
      expect(JSON.stringify(c)).not.toContain("tok123");
    }
  });

  it("sends no Authorization header without a token, and never follows a redirect", async () => {
    const f = fakeFetch(graph([]));
    await lookup(f).check(GH, undefined, never());
    expect(Object.keys(f.calls[0]!.headers)).not.toContain("Authorization");
    expect(f.calls.every((c) => c.redirect === "error")).toBe(true);
  });

  it("404 is not-run", async () => {
    const f = fakeFetch((c) => (c.url.endsWith("/sbom") ? new Response("", { status: 404 }) : undefined));
    expect(await lookup(f).check(GH, undefined, never())).toMatchObject({ status: "not-run", error: "no dependency graph for this repository", contacted: ["github"] });
  });

  it("403 with no quota left and 429 are rate limits that suggest GITHUB_TOKEN", async () => {
    for (const res of [() => new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0" } }), () => new Response("", { status: 429 })]) {
      const f = fakeFetch((c) => (c.url.endsWith("/sbom") ? res() : undefined));
      const out = (await lookup(f).check(GH, undefined, never()))!;
      expect(out).toMatchObject({ status: "failed", contacted: ["github"] });
      expect(out.error).toMatch(/rate limit/);
      expect(out.error).toMatch(/GITHUB_TOKEN/);
    }
  });

  it("another 403, and any other status, fail with a fixed reason", async () => {
    let f = fakeFetch((c) => (c.url.endsWith("/sbom") ? new Response("", { status: 403 }) : undefined));
    expect((await lookup(f).check(GH, undefined, never()))!.error).not.toMatch(/rate limit/);
    f = fakeFetch((c) => (c.url.endsWith("/sbom") ? new Response("secret", { status: 500 }) : undefined));
    const out = (await lookup(f).check(GH, undefined, never()))!;
    expect(out).toMatchObject({ status: "failed", error: "GitHub's dependency graph answer was not usable (status 500)" });
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("a redirect is a failure that says the repository may have moved", async () => {
    const f = fakeFetch(() => {
      throw Object.assign(new TypeError("fetch failed"), { cause: new Error("unexpected redirect") });
    });
    expect(await lookup(f).check(GH, undefined, never())).toMatchObject({
      status: "failed",
      error: "GitHub redirected (the repository may have been renamed or moved)",
      contacted: ["github"],
    });
  });

  it("a network error is a failure with a fixed reason that quotes nothing", async () => {
    const f = fakeFetch(() => {
      throw new TypeError("fetch failed: secret-host.internal");
    });
    const out = (await lookup(f).check(GH, undefined, never()))!;
    expect(out.status).toBe("failed");
    expect(JSON.stringify(out)).not.toContain("secret-host");
  });

  it("a body over the cap is a failure, not a partial answer", async () => {
    const big = "x".repeat(17 * 1024 * 1024);
    const f = fakeFetch((c) => (c.url.endsWith("/sbom") ? new Response(big) : undefined));
    expect(await lookup(f).check(GH, undefined, never())).toMatchObject({ status: "failed", error: "GitHub's dependency graph answer was larger than the check reads" });
  });

  it("an answer that is not an SBOM is a failure that quotes nothing", async () => {
    const f = fakeFetch((c) => (c.url.endsWith("/sbom") ? new Response("<html>SECRET</html>") : undefined));
    const out = (await lookup(f).check(GH, undefined, never()))!;
    expect(out).toMatchObject({ status: "failed", error: "GitHub's dependency graph answer could not be read" });
    expect(JSON.stringify(out)).not.toContain("SECRET");
  });

  it("an unexpected exception becomes a fixed failure, never its text", async () => {
    const f = fakeFetch((c) => {
      if (c.url.endsWith("/sbom")) return { get status(): number { throw new Error("BOOM-SECRET"); } } as unknown as Response;
      return undefined;
    });
    const out = (await lookup(f).check(GH, undefined, never()))!;
    expect(out.status).toBe("failed");
    expect(JSON.stringify(out)).not.toContain("BOOM");
  });

  it("encodes each path segment", async () => {
    const f = fakeFetch(graph([]));
    const repo = { ...GH, path: "a b/c%d" };
    await lookup(f).check(repo, undefined, never());
    expect(f.calls[0]!.url).toBe("https://api.github.com/repos/a%20b/c%25d/dependency-graph/sbom");
  });
});

describe("githubOsvLookup: what is looked up", () => {
  it("excludes workflow actions and bare repositories silently, and reports a graph of nothing as ran with lookedUp 0", async () => {
    const f = fakeFetch(graph(["pkg:githubactions/actions/checkout@" + "a".repeat(40), "pkg:github/pallets/flask@main"]));
    const out = (await lookup(f).check(GH, undefined, never()))!;
    expect(out).toMatchObject({ status: "ran", lookedUp: 0, notes: [], contacted: ["github"] });
    expect(f.calls).toHaveLength(1);
  });

  it("does not send ranges, and says how many of how many in one note; the status is incomplete", async () => {
    const f = fakeFetch(graph(["pkg:npm/cookie@%5E0.7.1", "pkg:npm/lodash@4.17.15", "pkg:npm/mocha@%5E10", "pkg:pypi/jinja2@3.1.2"]), osv({}));
    const out = (await lookup(f).check(GH, undefined, never()))!;
    expect(out.status).toBe("incomplete");
    expect(out.notes).toEqual(["2 of 4 dependencies have no exact version on the default branch (usually no lockfile) and were not looked up"]);
    expect(out.lookedUp).toBe(2);
    const sent = JSON.parse(f.calls.find((c) => c.url.endsWith("/querybatch"))!.body!) as { queries: Array<{ package: { purl: string } }> };
    expect(sent.queries.map((q) => q.package.purl)).toEqual(["pkg:npm/lodash@4.17.15", "pkg:pypi/jinja2@3.1.2"]);
  });

  it("when nothing is exact, nothing goes to OSV", async () => {
    const f = fakeFetch(graph(["pkg:npm/a@%5E1.0.0"]));
    const out = (await lookup(f).check(GH, undefined, never()))!;
    expect(out).toMatchObject({ status: "incomplete", lookedUp: 0, contacted: ["github"] });
  });

  it("queries a duplicated purl once and gives one finding", async () => {
    const f = fakeFetch(graph(["pkg:pypi/test@0.1.0", "pkg:pypi/test@0.1.0", "pkg:pypi/test@0.1.0"]), osv({ "pkg:pypi/test@0.1.0": ["GHSA-1"] }));
    const out = (await lookup(f).check(GH, undefined, never()))!;
    const sent = JSON.parse(f.calls.find((c) => c.url.endsWith("/querybatch"))!.body!) as { queries: unknown[] };
    expect(sent.queries).toHaveLength(1);
    expect(out.findings).toHaveLength(1);
    expect(out.lookedUp).toBe(1);
  });

  it("considers at most 5000 packages, notes the rest, and sends in chunks of at most 1000", async () => {
    const purls = Array.from({ length: 5100 }, (_, i) => `pkg:pypi/p${i}@1.0.0`);
    const f = fakeFetch(graph(purls), osv({}));
    const out = (await lookup(f).check(GH, undefined, never()))!;
    expect(out.status).toBe("incomplete");
    expect(out.notes).toEqual(["100 more dependencies beyond the first 5000 were not considered"]);
    expect(out.lookedUp).toBe(5000);
    const posts = f.calls.filter((c) => c.url.endsWith("/querybatch"));
    expect(posts).toHaveLength(5);
    for (const p of posts) expect((JSON.parse(p.body!) as { queries: unknown[] }).queries).toHaveLength(1000);
  });
});

describe("githubOsvLookup: OSV", () => {
  it("posts the purl as GitHub gave it, and never an Authorization header", async () => {
    const f = fakeFetch(graph(["pkg:npm/%40scope/name@1.2.3"]), osv({}));
    await lookup(f, "tok").check(GH, undefined, never());
    const post = f.calls.find((c) => c.url === "https://api.osv.dev/v1/querybatch")!;
    expect(post.method).toBe("POST");
    expect(post.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(post.body!)).toEqual({ queries: [{ package: { purl: "pkg:npm/%40scope/name@1.2.3" } }] });
    for (const c of f.calls.filter((x) => x.url.startsWith("https://api.osv.dev/"))) {
      expect(Object.keys(c.headers).map((k) => k.toLowerCase())).not.toContain("authorization");
    }
  });

  it("with a token set and advisories fetched, no request to api.osv.dev (batch or advisory) carries an Authorization header", async () => {
    const f = fakeFetch(
      graph(["pkg:npm/flatmap-stream@0.1.1"]),
      osv({ "pkg:npm/flatmap-stream@0.1.1": ["MAL-2025-20690"] }),
      detail({ "MAL-2025-20690": { summary: "Malicious code", severity: "CRITICAL" } }),
    );
    await lookup(f, "tok").check(GH, undefined, never());
    const osvCalls = f.calls.filter((x) => x.url.startsWith("https://api.osv.dev/"));
    expect(osvCalls.some((c) => c.url.includes("/v1/vulns/"))).toBe(true);
    expect(osvCalls.some((c) => c.url.endsWith("/querybatch"))).toBe(true);
    for (const c of osvCalls) {
      expect(Object.keys(c.headers ?? {}).map((k) => k.toLowerCase())).not.toContain("authorization");
    }
    // Sanity: the token does go to GitHub.
    expect(f.calls.filter((x) => x.url.startsWith("https://api.github.com/")).some((c) => JSON.stringify(c.headers).includes("tok"))).toBe(true);
  });

  it("finds a malicious package (error) and a vulnerable one (warning), with detail from the advisory", async () => {
    const f = fakeFetch(
      graph(["pkg:npm/flatmap-stream@0.1.1", "pkg:npm/lodash@4.17.15", "pkg:npm/safe@1.0.0"]),
      osv({ "pkg:npm/flatmap-stream@0.1.1": ["GHSA-x", "MAL-2025-20690"], "pkg:npm/lodash@4.17.15": ["GHSA-a", "GHSA-b"] }),
      detail({ "MAL-2025-20690": { summary: "Malicious code in flatmap-stream", severity: "CRITICAL" }, "GHSA-a": { summary: "Prototype pollution", severity: "HIGH" } }),
    );
    const out = (await lookup(f).check(GH, undefined, never()))!;
    expect(out).toMatchObject({ status: "ran", counts: { error: 1, warning: 1, note: 0 }, lookedUp: 3, contacted: ["github", "osv"], notes: [] });
    expect(out.findings.map((x) => x.message)).toEqual([
      "flatmap-stream 0.1.1: known malicious (GHSA-x, MAL-2025-20690): Malicious code in flatmap-stream",
      "lodash 4.17.15: known vulnerable (GHSA-a, GHSA-b): Prototype pollution",
    ]);
    expect(out.findings.map((x) => x.securitySeverity)).toEqual(["CRITICAL", "HIGH"]);
    const urls = f.calls.map((c) => c.url);
    expect(urls).toContain("https://api.osv.dev/v1/vulns/MAL-2025-20690");
    expect(urls).toContain("https://api.osv.dev/v1/vulns/GHSA-a");
    expect(urls).not.toContain("https://api.osv.dev/v1/vulns/GHSA-b");
  });

  it("a failed advisory fetch drops only the summary", async () => {
    const f = fakeFetch(graph(["pkg:npm/lodash@4.17.15"]), osv({ "pkg:npm/lodash@4.17.15": ["GHSA-a"] }));
    const out = (await lookup(f).check(GH, undefined, never()))!;
    expect(out.status).toBe("ran");
    expect(out.findings[0]!.message).toBe("lodash 4.17.15: known vulnerable (GHSA-a)");
  });

  it("fetches advisories only for the findings kept", async () => {
    const purls = Array.from({ length: 25 }, (_, i) => `pkg:npm/p${i}@1.0.0`);
    const vulns = Object.fromEntries(purls.map((p, i) => [p, [`GHSA-${i}`]]));
    const f = fakeFetch(graph(purls), osv(vulns));
    const out = (await lookup(f).check(GH, undefined, never()))!;
    expect(out.findings).toHaveLength(20);
    expect(out.omitted).toBe(5);
    expect(out.counts.warning).toBe(25);
    expect(f.calls.filter((c) => c.url.includes("/v1/vulns/"))).toHaveLength(20);
  });

  it("a result list of the wrong length is a failed check", async () => {
    const f = fakeFetch(graph(["pkg:npm/a@1.0.0", "pkg:npm/b@1.0.0"]), (c) => (c.url.endsWith("/querybatch") ? json({ results: [{}] }) : undefined));
    expect(await lookup(f).check(GH, undefined, never())).toMatchObject({ status: "failed", error: "OSV's batch answer did not match the query", contacted: ["github", "osv"] });
  });

  it("a non-200 answer from OSV is a failure naming the step", async () => {
    const f = fakeFetch(graph(["pkg:npm/a@1.0.0"]), (c) => (c.url.endsWith("/querybatch") ? new Response("secret", { status: 503 }) : undefined));
    const out = (await lookup(f).check(GH, undefined, never()))!;
    expect(out).toMatchObject({ status: "failed", error: "OSV's batch answer was not usable (status 503)" });
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("follows next_page_token for only the queries that have one, merging ids without duplicates", async () => {
    const batches: Array<Array<{ package: { purl: string }; page_token?: string }>> = [];
    const f = fakeFetch(graph(["pkg:npm/a@1.0.0", "pkg:npm/b@1.0.0"]), (c) => {
      if (!c.url.endsWith("/querybatch")) return undefined;
      const q = (JSON.parse(c.body!) as { queries: (typeof batches)[number] }).queries;
      batches.push(q);
      if (batches.length === 1) return json({ results: [{ vulns: [{ id: "GHSA-1" }], next_page_token: "t1" }, { vulns: [] }] });
      return json({ results: q.map(() => ({ vulns: [{ id: "GHSA-1" }, { id: "GHSA-2" }] })) });
    });
    const out = (await lookup(f).check(GH, undefined, never()))!;
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual([{ package: { purl: "pkg:npm/a@1.0.0" }, page_token: "t1" }]);
    expect(out.status).toBe("ran");
    expect(out.findings[0]!.message).toContain("(GHSA-1, GHSA-2)");
  });

  it("stops after 10 follow-up requests, says the list was cut short, and the status is incomplete", async () => {
    let n = 0;
    const f = fakeFetch(graph(["pkg:npm/a@1.0.0"]), (c) => {
      if (!c.url.endsWith("/querybatch")) return undefined;
      n++;
      return json({ results: [{ vulns: [{ id: `GHSA-${n}` }], next_page_token: `t${n}` }] });
    });
    const out = (await lookup(f).check(GH, undefined, never()))!;
    expect(n).toBe(11);
    expect(out.status).toBe("incomplete");
    expect(out.notes).toEqual(["the list of advisories was cut short: some packages have more advisories than were read"]);
    expect(out.counts.warning).toBe(1);
  });
});

describe("githubOsvLookup: time and cancellation", () => {
  it("fails with 'ran out of time' at the deadline, saying what was contacted", async () => {
    const f = fakeFetch((c) => {
      if (c.url.endsWith("/sbom")) return new Promise<Response>(() => {});
      return undefined;
    });
    const wrapped = async (url: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        void f.fetch(url, init).then(resolve, reject);
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const l = githubOsvLookup({ fetch: wrapped, deadlineMs: 30 });
    const out = (await l.check(GH, undefined, never()))!;
    expect(out).toMatchObject({ status: "failed", error: "the dependency check ran out of time", contacted: ["github"] });
  });

  it("a caller abort in flight is a cancelled check", async () => {
    const ac = new AbortController();
    const fetchImpl = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        setTimeout(() => ac.abort(), 5);
      });
    const out = (await githubOsvLookup({ fetch: fetchImpl }).check(GH, undefined, ac.signal))!;
    expect(out).toMatchObject({ status: "failed", error: "the dependency check was cancelled", contacted: ["github"] });
  });
});

describe("githubOsvLookup: contacted", () => {
  it("is [] for GitLab, [github] for a pinned ref, a 404 and a rate limit, and [github, osv] for a check that ran", async () => {
    const gitlab = parseRepoRef("gitlab.com/g/p", { "github.com": "github", "gitlab.com": "gitlab" } as never);
    expect((await lookup(fakeFetch()).check(gitlab, undefined, never()))!.contacted).toEqual([]);
    expect((await lookup(fakeFetch((c) => (c.url.endsWith("/repos/acme/widget") ? json({ default_branch: "main" }) : undefined))).check(GH, "dev", never()))!.contacted).toEqual(["github"]);
    expect((await lookup(fakeFetch()).check(GH, undefined, never()))!.contacted).toEqual(["github"]);
    expect((await lookup(fakeFetch(() => new Response("", { status: 429 }))).check(GH, undefined, never()))!.contacted).toEqual(["github"]);
    expect((await lookup(fakeFetch(graph(["pkg:npm/a@1.0.0"]), osv({}))).check(GH, undefined, never()))!.contacted).toEqual(["github", "osv"]);
  });
});

// ---- the policy ----------------------------------------------------------------------------------------------------

describe("what a dependency check counts for the policy", () => {
  const dep = (over: Partial<CheckOutcome>): CheckOutcome => ({
    name: "dependencies", kind: "builtin", status: "ran", counts: { error: 0, warning: 0, note: 0 }, findings: [], omitted: 0, notes: [], contacted: ["github", "osv"], lookedUp: 40, ...over,
  });

  it("at note, a clean check with packages looked up does not count (how many were looked up is not a note)", async () => {
    const out = (await lookup(fakeFetch(graph(["pkg:npm/a@1.0.0", "pkg:pypi/b@2.0.0"]), osv({}))).check(GH, undefined, never()))!;
    expect(out).toMatchObject({ status: "ran", lookedUp: 2, notes: [] });
    expect(decide("block", "note", [out]).verdict).toBe("build");
    expect(decide("block", "note", [dep({})]).verdict).toBe("build");
  });

  it("at note, a check with findings, or with something it could not look up, counts", async () => {
    expect(decide("block", "note", [dep({ counts: { error: 0, warning: 1, note: 0 } })]).verdict).toBe("block");
    expect(decide("block", "note", [dep({ status: "incomplete", notes: ["2 of 4 dependencies have no exact version"] })]).verdict).toBe("block");
    const ranges = (await lookup(fakeFetch(graph(["pkg:npm/a@%5E1.0.0"]))).check(GH, undefined, never()))!;
    expect(decide("block", "note", [ranges]).verdict).toBe("block");
  });
});
