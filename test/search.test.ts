import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { searchProjects } from "../src/forge/search.js";

interface Call {
  url: URL;
  headers: Record<string, string>;
}

function fakeFetch(calls: Call[], handlers: { github?: () => Response; gitlab?: () => Response }): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const handler = url.host === "api.github.com" ? handlers.github : handlers.gitlab;
    if (!handler) throw new Error(`unexpected request to ${url.host}`);
    return handler();
  }) as typeof fetch;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

const github = () =>
  json({
    items: [
      { full_name: "a/big", html_url: "https://github.com/a/big", description: "Big", stargazers_count: 900, language: "Rust", license: { spdx_id: "MIT" }, archived: false, pushed_at: "2026-01-01" },
      { full_name: "a/unlicensed", description: null, stargazers_count: 5, license: { spdx_id: "NOASSERTION" }, archived: true },
      { description: "malformed entry without a name" },
    ],
  });
const gitlab = () =>
  json([{ path_with_namespace: "grp/sub/mid", web_url: "https://gitlab.com/grp/sub/mid", description: "Mid", star_count: 100, last_activity_at: "2026-02-02" }]);

const cfg = (env: Record<string, string> = {}) => loadConfig({ HOME: "/tmp", ...env });

describe("searchProjects", () => {
  it("merges both forges by stars and maps their fields", async () => {
    const calls: Call[] = [];
    const out = await searchProjects(cfg(), { query: "thing", forge: "all", limit: 10 }, fakeFetch(calls, { github, gitlab }));
    expect(out.errors).toEqual([]);
    expect(out.results.map((r) => r.id)).toEqual(["github:a/big", "gitlab:grp/sub/mid", "github:a/unlicensed"]);
    expect(out.results[0]).toMatchObject({ forge: "github", stars: 900, language: "Rust", license: "MIT", url: "https://github.com/a/big" });
    expect(out.results[2]).toMatchObject({ license: undefined, archived: true, description: "", url: "https://github.com/a/unlicensed" });
  });

  it("builds the queries, including the language filter", async () => {
    const calls: Call[] = [];
    await searchProjects(cfg(), { query: "json viewer", forge: "all", language: "Go", limit: 7 }, fakeFetch(calls, { github, gitlab }));
    const gh = calls.find((c) => c.url.host === "api.github.com")!;
    expect(gh.url.searchParams.get("q")).toBe('json viewer language:"Go"');
    expect(gh.url.searchParams.get("per_page")).toBe("7");
    const gl = calls.find((c) => c.url.host === "gitlab.com")!;
    expect(gl.url.searchParams.get("search")).toBe("json viewer");
    expect(gl.url.searchParams.get("with_programming_language")).toBe("Go");
    expect(gl.url.searchParams.get("visibility")).toBe("public");
  });

  it("sends tokens only when configured and identifies itself generically", async () => {
    const anon: Call[] = [];
    await searchProjects(cfg(), { query: "x", forge: "all", limit: 1 }, fakeFetch(anon, { github, gitlab }));
    for (const c of anon) {
      expect(c.headers.Authorization).toBeUndefined();
      expect(c.headers["PRIVATE-TOKEN"]).toBeUndefined();
      expect(c.headers["User-Agent"]).toBe("mcp-everything");
    }
    const authed: Call[] = [];
    await searchProjects(cfg({ GITHUB_TOKEN: "gh-secret", GITLAB_TOKEN: "gl-secret" }), { query: "x", forge: "all", limit: 1 }, fakeFetch(authed, { github, gitlab }));
    expect(authed.find((c) => c.url.host === "api.github.com")!.headers.Authorization).toBe("Bearer gh-secret");
    expect(authed.find((c) => c.url.host === "gitlab.com")!.headers["PRIVATE-TOKEN"]).toBe("gl-secret");
    // Each token goes only to its own forge.
    expect(authed.find((c) => c.url.host === "gitlab.com")!.headers.Authorization).toBeUndefined();
  });

  it("only queries the selected forge", async () => {
    const calls: Call[] = [];
    await searchProjects(cfg(), { query: "x", forge: "gitlab", limit: 5 }, fakeFetch(calls, { gitlab }));
    expect(calls.map((c) => c.url.host)).toEqual(["gitlab.com"]);
  });

  it("returns partial results with an explanatory error when one forge is rate limited", async () => {
    const limited = () => json({ message: "rate limit" }, 403, { "x-ratelimit-remaining": "0" });
    const out = await searchProjects(cfg(), { query: "x", forge: "all", limit: 5 }, fakeFetch([], { github: limited, gitlab }));
    expect(out.results.map((r) => r.id)).toEqual(["gitlab:grp/sub/mid"]);
    expect(out.errors).toEqual([expect.stringMatching(/api\.github\.com responded 403 .*GITHUB_TOKEN/)]);
  });

  it("drops an unsafe language filter instead of injecting it into the query", async () => {
    const calls: Call[] = [];
    await searchProjects(cfg(), { query: "x", forge: "github", language: 'Go" user:evil', limit: 5 }, fakeFetch(calls, { github }));
    expect(calls[0]!.url.searchParams.get("q")).toBe("x");
  });
});
