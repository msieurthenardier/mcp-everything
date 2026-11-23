/**
 * The built-in `dependencies` check: GitHub's dependency graph for a github.com repository, and OSV's list of the
 * exact versions in it that are known malicious (error) or vulnerable (warning). It sends the repository's owner
 * and name to GitHub and package names and versions to OSV, never anything from a clone; the token goes to
 * api.github.com only. Everything it reads is hostile: own properties of plain objects only, cleaned and bounded.
 */
import type { RepoRef } from "../types.js";
import { getCapped, postCapped, HttpFailure, type FetchLike, type HttpResult } from "./http.js";
import {
  LOCATION_MAX,
  MAX_FINDINGS,
  MESSAGE_MAX,
  RULE_ID_MAX,
  SEVERITY_MAX,
  clean,
  emptyCounts,
  isObject,
  own,
} from "./sarif.js";
import type { CheckOutcome, Finding, Level } from "./types.js";

export interface DependencyLookup {
  check(repo: RepoRef, ref: string | undefined, signal: AbortSignal): Promise<CheckOutcome | undefined>;
}

/** The lookup used wherever none is injected: it records its calls, sends nothing, and adds no outcome to a report. */
export function inertDependencyLookup(): DependencyLookup & { calls: Array<{ repo: RepoRef; ref: string | undefined }> } {
  const calls: Array<{ repo: RepoRef; ref: string | undefined }> = [];
  return {
    calls,
    async check(repo, ref) {
      calls.push({ repo, ref });
      return undefined;
    },
  };
}

const GITHUB = "https://api.github.com";
const OSV = "https://api.osv.dev";
const MAX_PACKAGES = 5000;
const BATCH_SIZE = 1000;
const MAX_FOLLOWUPS = 10;
const DEADLINE_MS = 60_000;
const REPO_CAP = 1024 * 1024;
const GRAPH_CAP = 16 * 1024 * 1024;
const BATCH_CAP = 16 * 1024 * 1024;
const VULN_CAP = 2 * 1024 * 1024;
/** Workflow steps and bare repositories: not what a build runs, so never sent and never counted. */
const EXCLUDED_TYPES = new Set(["githubactions", "github"]);
const NAME_MAX = 80;
const VERSION_MAX = 40;
const ID_MAX = 30;
const SUMMARY_MAX = 120;

// ---- parsing the graph --------------------------------------------------------------------------------------------

export interface SbomPackage {
  purl: string;
  name?: string;
  version?: string;
}

export type SbomParse = { ok: true; packages: SbomPackage[] } | { ok: false };

/** Reads GitHub's SPDX answer. Anything unexpected is ignored; only a body that is not an SBOM at all is a failure. */
export function parseSbom(text: string): SbomParse {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const sbom = isObject(doc) ? own(doc, "sbom") : undefined;
  const list = isObject(sbom) ? own(sbom, "packages") : undefined;
  if (!isObject(sbom) || !Array.isArray(list)) return { ok: false };

  const described = new Set<string>();
  const rels = own(sbom, "relationships");
  if (Array.isArray(rels)) {
    for (const r of rels) {
      if (!isObject(r)) continue;
      const from = own(r, "spdxElementId");
      const kind = own(r, "relationshipType");
      const to = own(r, "relatedSpdxElement");
      if (from === "SPDXRef-DOCUMENT" && kind === "DESCRIBES" && typeof to === "string") described.add(to);
    }
  }

  const packages: SbomPackage[] = [];
  for (const p of list) {
    if (!isObject(p)) continue;
    const id = own(p, "SPDXID");
    if (typeof id === "string" && described.has(id)) continue;
    const refs = own(p, "externalRefs");
    if (!Array.isArray(refs)) continue;
    let purl: string | undefined;
    for (const r of refs) {
      if (!isObject(r) || own(r, "referenceType") !== "purl") continue;
      const loc = own(r, "referenceLocator");
      purl = typeof loc === "string" && loc !== "" ? loc : undefined;
      break;
    }
    if (purl === undefined) continue;
    const entry: SbomPackage = { purl };
    const name = own(p, "name");
    const version = own(p, "versionInfo");
    if (typeof name === "string") entry.name = name;
    if (typeof version === "string") entry.version = version;
    packages.push(entry);
  }
  return { ok: true, packages };
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

interface ParsedPurl {
  type: string;
  name: string;
  version?: string;
}

/** A purl without its qualifiers and subpath, split into type, name and version (the text after the last `@`). */
function parsePurl(purl: string): ParsedPurl | undefined {
  const base = purl.split("#")[0]!.split("?")[0]!;
  if (!base.startsWith("pkg:")) return undefined;
  const body = base.slice(4).replace(/^\/+/, "");
  const slash = body.indexOf("/");
  if (slash <= 0) return undefined;
  const rest = body.slice(slash + 1);
  const at = rest.lastIndexOf("@");
  return {
    type: body.slice(0, slash).toLowerCase(),
    name: decode(at >= 0 ? rest.slice(0, at) : rest),
    version: at >= 0 ? decode(rest.slice(at + 1)) : undefined,
  };
}

const EXACT = /^v?\d+(\.\d+)+([-+][0-9A-Za-z.+_!-]*)?$/;

/**
 * An allowlist: whether a purl names one exact version of a package rather than a range, tag, placeholder or
 * source spec. `v` is a purl (`pkg:…@version`, qualifiers and subpath ignored) or a bare version.
 */
export function isExactVersion(type: string, v: string): boolean {
  let version: string;
  if (v.startsWith("pkg:")) {
    const parsed = parsePurl(v);
    if (!parsed || parsed.version === undefined) return false;
    version = parsed.version;
  } else {
    version = v;
  }
  if (!EXACT.test(version) || version.includes(".+")) return false;
  if (version.split(".").some((s) => s === "x" || s === "X" || s === "*")) return false;
  if (type.toLowerCase() === "npm" && !/^v?\d+\.\d+\.\d+/.test(version)) return false;
  return true;
}

// ---- findings -----------------------------------------------------------------------------------------------------

export interface AffectedPackage {
  /** The purl as GitHub gave it. */
  key: string;
  type: string;
  name: string;
  version: string;
  ids: string[];
}

export interface PackageDetail {
  summary?: string;
  severity?: string;
}

function isMalicious(a: AffectedPackage): boolean {
  return a.ids.some((id) => id.startsWith("MAL-"));
}

/** Malicious packages first, then vulnerable ones, each in the graph's order. */
export function orderAffected(affected: readonly AffectedPackage[]): AffectedPackage[] {
  return [...affected.filter(isMalicious), ...affected.filter((a) => !isMalicious(a))];
}

/** The one advisory fetched for a package: its first `MAL-` id when malicious, else its first id. */
export function detailId(a: AffectedPackage): string {
  return a.ids.find((id) => id.startsWith("MAL-")) ?? a.ids[0]!;
}

/** One finding per affected package. Counts are exact; at most `MAX_FINDINGS` are kept, errors first. */
export function dependencyFindings(
  affected: readonly AffectedPackage[],
  details: ReadonlyMap<string, PackageDetail> = new Map(),
): { counts: Record<Level, number>; findings: Finding[]; omitted: number } {
  const counts = emptyCounts();
  for (const a of affected) counts[isMalicious(a) ? "error" : "warning"]++;
  const ordered = orderAffected(affected);
  const findings: Finding[] = ordered.slice(0, MAX_FINDINGS).map((a) => {
    const malicious = isMalicious(a);
    const shown = a.ids.slice(0, 5).map((id) => clean(id, ID_MAX));
    const more = a.ids.length - shown.length;
    const detail = details.get(a.key);
    const summary = detail?.summary ? clean(detail.summary, SUMMARY_MAX) : "";
    const message =
      `${clean(a.name, NAME_MAX)} ${clean(a.version, VERSION_MAX)}: known ${malicious ? "malicious" : "vulnerable"} ` +
      `(${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""})${summary ? `: ${summary}` : ""}`;
    const finding: Finding = {
      check: "dependencies",
      ruleId: clean(malicious ? "malicious-package" : "vulnerable-package", RULE_ID_MAX),
      level: malicious ? "error" : "warning",
      message: clean(message, MESSAGE_MAX),
      location: clean(`${a.type}:${a.name}`, LOCATION_MAX),
    };
    const sev = detail?.severity ? clean(detail.severity, SEVERITY_MAX) : "";
    if (sev) finding.securitySeverity = sev;
    return finding;
  });
  return { counts, findings, omitted: Math.max(0, affected.length - findings.length) };
}

// ---- the lookup ---------------------------------------------------------------------------------------------------

export interface GithubOsvOptions {
  fetch: FetchLike;
  githubToken?: string;
  /** Reserved: the deadline is an AbortSignal, so no clock is read. */
  now?: () => number;
  /** The whole check's deadline (default 60 s); for tests. */
  deadlineMs?: number;
}

type Service = "github" | "osv";

/** A check that stopped with a fixed reason. Never built from response content. */
class Stop extends Error {
  constructor(
    readonly status: "failed" | "not-run",
    readonly reason: string,
  ) {
    super(reason);
  }
}

interface Entry {
  purl: string;
  type: string;
  name: string;
  version: string;
  exact: boolean;
}

function toEntry(p: SbomPackage): Entry | undefined {
  const parsed = parsePurl(p.purl);
  if (!parsed || EXCLUDED_TYPES.has(parsed.type)) return undefined;
  const hasExtras = p.purl.includes("#") || p.purl.includes("?");
  let name = parsed.name;
  let version = parsed.version ?? "";
  if (hasExtras && p.name && p.version) {
    // The purl's own name and version may sit behind qualifiers; prefer the graph's fields for display.
    name = p.name.startsWith(`${parsed.type}:`) ? p.name.slice(parsed.type.length + 1) : p.name;
    version = p.version;
  }
  return { purl: p.purl, type: parsed.type, name, version, exact: isExactVersion(parsed.type, p.purl) };
}

function githubHeaders(token: string | undefined): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    // Only requests to api.github.com are built with these headers.
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function failureReason(kind: HttpFailure["kind"], step: string, service: "GitHub" | "OSV"): string {
  switch (kind) {
    case "redirect":
      return service === "GitHub"
        ? "GitHub redirected (the repository may have been renamed or moved)"
        : "OSV redirected the request";
    case "timeout":
      return `${step} timed out`;
    case "cap":
      return `${step} was larger than the check reads`;
    default:
      return `${step} could not be reached`;
  }
}

/** The real lookup. Never throws: every failure is a `failed` outcome with a fixed reason. */
export function githubOsvLookup(opts: GithubOsvOptions): DependencyLookup {
  const { fetch: fetchImpl, githubToken } = opts;
  return {
    async check(repo, ref, caller) {
      const contacted: Service[] = [];
      const mark = (s: Service) => () => {
        if (!contacted.includes(s)) contacted.push(s);
      };
      const finish = (o: Partial<CheckOutcome> & Pick<CheckOutcome, "status">): CheckOutcome => ({
        name: "dependencies",
        kind: "builtin",
        counts: emptyCounts(),
        findings: [],
        omitted: 0,
        notes: [],
        contacted: [...contacted],
        ...o,
      });

      if (caller.aborted) return finish({ status: "failed", error: "the dependency check was cancelled" });
      if (repo.host !== "github.com") {
        return finish({
          status: "not-run",
          error: `${repo.forge === "gitlab" ? "GitLab" : clean(repo.host, 80)} has no public dependency graph`,
        });
      }

      const deadline = AbortSignal.timeout(opts.deadlineMs ?? DEADLINE_MS);
      const signal = AbortSignal.any([deadline, caller]);
      const repoPath = repo.path.split("/").map(encodeURIComponent).join("/");

      const call = async (
        service: "GitHub" | "OSV",
        step: string,
        run: (onSend: () => void) => Promise<HttpResult>,
      ): Promise<HttpResult> => {
        try {
          return await run(mark(service === "GitHub" ? "github" : "osv"));
        } catch (e) {
          if (e instanceof HttpFailure) {
            if (e.kind === "aborted") throw e;
            throw new Stop("failed", failureReason(e.kind, step, service));
          }
          throw e;
        }
      };
      const ghGet = (step: string, path: string, cap: number) =>
        call("GitHub", step, (onSend) => getCapped(fetchImpl, `${GITHUB}${path}`, { headers: githubHeaders(githubToken), capBytes: cap, signal, onSend }));
      const osvPost = (step: string, path: string, body: string) =>
        call("OSV", step, (onSend) =>
          postCapped(fetchImpl, `${OSV}${path}`, body, { headers: { "Content-Type": "application/json" }, capBytes: BATCH_CAP, signal, onSend }),
        );

      try {
        // A pinned ref is compared with the default branch: the graph describes only that.
        if (ref !== undefined && ref !== "" && ref !== "HEAD") {
          const res = await ghGet("GitHub's repository answer", `/repos/${repoPath}`, REPO_CAP);
          if (res.status !== 200) throw new Stop("failed", `GitHub's repository answer was not usable (status ${res.status})`);
          let branch: unknown;
          try {
            const doc: unknown = JSON.parse(res.text);
            branch = isObject(doc) ? own(doc, "default_branch") : undefined;
          } catch {
            branch = undefined;
          }
          if (typeof branch !== "string" || branch === "") {
            throw new Stop("failed", "GitHub's repository answer could not be read");
          }
          if (branch !== ref) {
            return finish({
              status: "not-run",
              error: `GitHub's dependency graph describes the default branch (${clean(branch, 80)}), not ${clean(ref, 80)}; check without a ref to see it`,
            });
          }
        }

        const graph = await ghGet("GitHub's dependency graph answer", `/repos/${repoPath}/dependency-graph/sbom`, GRAPH_CAP);
        if (graph.status === 404) return finish({ status: "not-run", error: "no dependency graph for this repository" });
        if (graph.status === 429 || (graph.status === 403 && graph.headers.get("x-ratelimit-remaining") === "0")) {
          throw new Stop("failed", "GitHub's rate limit was reached; set GITHUB_TOKEN to raise it");
        }
        if (graph.status === 403) {
          throw new Stop("failed", "GitHub refused the dependency graph request (status 403); if the repository is private, set GITHUB_TOKEN");
        }
        if (graph.status !== 200) throw new Stop("failed", `GitHub's dependency graph answer was not usable (status ${graph.status})`);
        const parsed = parseSbom(graph.text);
        if (!parsed.ok) throw new Stop("failed", "GitHub's dependency graph answer could not be read");

        // Which packages count: not workflow steps, once each, at most MAX_PACKAGES in the graph's order.
        const seen = new Set<string>();
        const entries: Entry[] = [];
        let beyond = 0;
        for (const p of parsed.packages) {
          const e = toEntry(p);
          if (!e || seen.has(e.purl)) continue;
          seen.add(e.purl);
          if (entries.length >= MAX_PACKAGES) beyond++;
          else entries.push(e);
        }
        const exact = entries.filter((e) => e.exact);
        const notes: string[] = [];
        if (exact.length < entries.length) {
          notes.push(
            `${entries.length - exact.length} of ${entries.length} dependencies have no exact version on the default branch (usually no lockfile) and were not looked up`,
          );
        }
        if (beyond > 0) notes.push(`${beyond} more dependencies beyond the first ${MAX_PACKAGES} were not considered`);

        // OSV: one batch per 1000 packages, matched by index; follow-up pages for the queries that have a token.
        const ids: string[][] = exact.map(() => []);
        type Item = { i: number; token?: string };
        const query = async (items: Item[]): Promise<Item[]> => {
          const body = JSON.stringify({
            queries: items.map((it) => ({ package: { purl: exact[it.i]!.purl }, ...(it.token ? { page_token: it.token } : {}) })),
          });
          const res = await osvPost("OSV's batch answer", "/v1/querybatch", body);
          if (res.status !== 200) throw new Stop("failed", `OSV's batch answer was not usable (status ${res.status})`);
          let results: unknown;
          try {
            const doc: unknown = JSON.parse(res.text);
            results = isObject(doc) ? own(doc, "results") : undefined;
          } catch {
            results = undefined;
          }
          if (!Array.isArray(results)) throw new Stop("failed", "OSV's batch answer could not be read");
          if (results.length !== items.length) throw new Stop("failed", "OSV's batch answer did not match the query");
          const next: Item[] = [];
          results.forEach((r, k) => {
            if (!isObject(r)) return;
            const i = items[k]!.i;
            const vulns = own(r, "vulns");
            if (Array.isArray(vulns)) {
              for (const v of vulns) {
                const id = isObject(v) ? own(v, "id") : undefined;
                if (typeof id === "string" && id !== "" && !ids[i]!.includes(id)) ids[i]!.push(id);
              }
            }
            const token = own(r, "next_page_token");
            if (typeof token === "string" && token !== "") next.push({ i, token });
          });
          return next;
        };

        let todo: Item[] = [];
        for (let start = 0; start < exact.length; start += BATCH_SIZE) {
          const items: Item[] = [];
          for (let i = start; i < Math.min(start + BATCH_SIZE, exact.length); i++) items.push({ i });
          todo.push(...(await query(items)));
        }
        let followups = 0;
        while (todo.length > 0 && followups < MAX_FOLLOWUPS) {
          followups++;
          const rest = todo.slice(BATCH_SIZE);
          todo = [...rest, ...(await query(todo.slice(0, BATCH_SIZE)))];
        }
        if (todo.length > 0) notes.push("the list of advisories was cut short: some packages have more advisories than were read");

        const affected: AffectedPackage[] = [];
        exact.forEach((e, i) => {
          if (ids[i]!.length > 0) affected.push({ key: e.purl, type: e.type, name: e.name, version: e.version, ids: ids[i]! });
        });

        // Summary and severity only for the packages shown, one advisory each; a failed fetch drops only its summary.
        const details = new Map<string, PackageDetail>();
        await Promise.all(
          orderAffected(affected)
            .slice(0, MAX_FINDINGS)
            .map(async (a) => {
              try {
                const res = await call("OSV", "OSV's advisory answer", (onSend) =>
                  getCapped(fetchImpl, `${OSV}/v1/vulns/${encodeURIComponent(detailId(a))}`, { capBytes: VULN_CAP, signal, onSend }),
                );
                if (res.status !== 200) return;
                const doc: unknown = JSON.parse(res.text);
                if (!isObject(doc)) return;
                const summary = own(doc, "summary");
                const spec = own(doc, "database_specific");
                const severity = isObject(spec) ? own(spec, "severity") : undefined;
                const d: PackageDetail = {};
                if (typeof summary === "string") d.summary = summary;
                if (typeof severity === "string") d.severity = severity;
                details.set(a.key, d);
              } catch {
                // Only this package's summary is lost.
              }
            }),
        );
        if (signal.aborted) throw new HttpFailure("aborted");

        const { counts, findings, omitted } = dependencyFindings(affected, details);
        return finish({
          status: notes.length > 0 ? "incomplete" : "ran",
          counts,
          findings,
          omitted,
          notes,
          lookedUp: exact.length,
        });
      } catch (e) {
        if (caller.aborted) return finish({ status: "failed", error: "the dependency check was cancelled" });
        if (deadline.aborted) return finish({ status: "failed", error: "the dependency check ran out of time" });
        if (e instanceof Stop) return finish({ status: e.status, error: e.reason });
        return finish({ status: "failed", error: "the dependency check could not complete" });
      }
    },
  };
}
