import type { Config } from "../config.js";
import type { SearchResult } from "../types.js";

export interface SearchParams {
  query: string;
  forge: "github" | "gitlab" | "all";
  language?: string;
  limit: number;
}

type FetchLike = typeof fetch;

// A fixed, generic client identity: nothing about the user or host leaves here.
const USER_AGENT = "mcp-everything";

async function getJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetchImpl(url, {
    headers: { "User-Agent": USER_AGENT, ...headers },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const hint =
      res.status === 403 || res.status === 429
        ? remaining === "0"
          ? " (rate limit exhausted; set GITHUB_TOKEN / GITLAB_TOKEN for a higher limit)"
          : " (forbidden or rate limited)"
        : "";
    throw new Error(`${new URL(url).host} responded ${res.status}${hint}`);
  }
  return res.json();
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

async function searchGitHub(cfg: Config, p: SearchParams, fetchImpl: FetchLike = fetch): Promise<SearchResult[]> {
  let q = p.query.trim();
  if (p.language && /^[A-Za-z0-9+#. -]{1,40}$/.test(p.language)) {
    q += ` language:"${p.language}"`;
  }
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=${p.limit}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (cfg.githubToken) headers.Authorization = `Bearer ${cfg.githubToken}`;
  const body = obj(await getJson(fetchImpl, url, headers));
  const items = Array.isArray(body.items) ? body.items : [];
  return items.flatMap((raw): SearchResult[] => {
    const r = obj(raw);
    const full = str(r.full_name);
    if (!full) return [];
    const spdx = str(obj(r.license).spdx_id);
    return [
      {
        id: `github:${full}`,
        forge: "github",
        path: full,
        url: str(r.html_url) ?? `https://github.com/${full}`,
        description: str(r.description) ?? "",
        stars: num(r.stargazers_count),
        language: str(r.language),
        license: spdx && spdx !== "NOASSERTION" ? spdx : undefined,
        archived: r.archived === true,
        updatedAt: str(r.pushed_at),
      },
    ];
  });
}

async function searchGitLab(cfg: Config, p: SearchParams, fetchImpl: FetchLike = fetch): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    search: p.query.trim(),
    order_by: "star_count",
    sort: "desc",
    visibility: "public",
    per_page: String(p.limit),
  });
  if (p.language) params.set("with_programming_language", p.language);
  const headers: Record<string, string> = {};
  if (cfg.gitlabToken) headers["PRIVATE-TOKEN"] = cfg.gitlabToken;
  const body = await getJson(fetchImpl, `https://gitlab.com/api/v4/projects?${params}`, headers);
  const items = Array.isArray(body) ? body : [];
  return items.flatMap((raw): SearchResult[] => {
    const r = obj(raw);
    const full = str(r.path_with_namespace);
    if (!full) return [];
    return [
      {
        id: `gitlab:${full}`,
        forge: "gitlab",
        path: full,
        url: str(r.web_url) ?? `https://gitlab.com/${full}`,
        description: str(r.description) ?? "",
        stars: num(r.star_count),
        archived: r.archived === true,
        updatedAt: str(r.last_activity_at),
      },
    ];
  });
}

export interface SearchOutcome {
  results: SearchResult[];
  errors: string[];
}

/** Query the selected forges concurrently; one failing forge does not sink the other. */
export async function searchProjects(cfg: Config, p: SearchParams, fetchImpl: FetchLike = fetch): Promise<SearchOutcome> {
  const jobs: Array<Promise<SearchResult[]>> = [];
  if (p.forge !== "gitlab") jobs.push(searchGitHub(cfg, p, fetchImpl));
  if (p.forge !== "github") jobs.push(searchGitLab(cfg, p, fetchImpl));
  const settled = await Promise.allSettled(jobs);
  const results: SearchResult[] = [];
  const errors: string[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") results.push(...s.value);
    else errors.push(s.reason instanceof Error ? s.reason.message : String(s.reason));
  }
  results.sort((a, b) => b.stars - a.stars);
  return { results: results.slice(0, p.limit), errors };
}
