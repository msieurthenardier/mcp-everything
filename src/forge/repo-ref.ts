import type { Config } from "../config.js";
import type { Forge, RepoRef } from "../types.js";

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

function validSegment(seg: string): boolean {
  return SEGMENT.test(seg) && seg !== "." && seg !== ".." && !seg.endsWith(".git") && seg.length <= 100;
}

function build(forge: Forge, host: string, segments: string[]): RepoRef {
  if (forge === "github" && segments.length !== 2) {
    throw new Error(`GitHub repositories are "owner/name"; got "${segments.join("/")}"`);
  }
  if (segments.length < 2 || segments.length > 8) {
    throw new Error(`Repository path must look like "owner/name"; got "${segments.join("/")}"`);
  }
  for (const seg of segments) {
    if (!validSegment(seg)) throw new Error(`Invalid repository path segment "${seg}"`);
  }
  const path = segments.join("/");
  const prefix = host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : host;
  return {
    forge,
    host,
    path,
    cloneUrl: `https://${host}/${path}.git`,
    id: `${prefix}:${path}`,
    name: segments[segments.length - 1]!,
  };
}

function splitPath(raw: string, forge: Forge): string[] {
  let segments = raw.split("/").filter((s) => s.length > 0);
  // Drop web UI suffixes: /tree/main, /blob/..., and GitLab's /-/tree/...
  const dash = segments.indexOf("-");
  if (dash >= 2) segments = segments.slice(0, dash);
  if (forge === "github" && segments.length > 2) segments = segments.slice(0, 2);
  const last = segments.length - 1;
  if (last >= 0 && segments[last]!.endsWith(".git")) {
    segments[last] = segments[last]!.slice(0, -4);
  }
  return segments;
}

/**
 * Accepts:
 *   owner/name                      (GitHub by default)
 *   github:owner/name, gitlab:group/sub/name
 *   https://github.com/owner/name[.git][/tree/...]
 *   https://gitlab.com/group/sub/name[/-/tree/...]
 *   <allowed-host>/path or <allowed-host>:path
 *
 * Only https URLs on allow-listed hosts are ever produced; anything else throws.
 */
export function parseRepoRef(input: string, hosts: Config["hosts"]): RepoRef {
  const spec = input.trim();
  if (!spec || spec.length > 300 || /[\s\u0000-\u001f]/.test(spec)) {
    throw new Error("Repository spec is empty or contains whitespace/control characters");
  }

  const url = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(spec);
  if (url) {
    const scheme = url[1]!.toLowerCase();
    if (scheme !== "https" && scheme !== "http") {
      throw new Error(`Only https repository URLs are supported (got ${scheme}://)`);
    }
    const rest = url[2]!.replace(/[?#].*$/, "");
    const slash = rest.indexOf("/");
    if (slash < 0) throw new Error(`No repository path in URL "${spec}"`);
    const authority = rest.slice(0, slash).toLowerCase();
    if (authority.includes("@")) throw new Error("Credentials in repository URLs are not allowed");
    const host = authority.replace(/^www\./, "");
    const forge = hosts[host];
    if (!forge) throw new Error(`Host "${host}" is not an allowed forge (${Object.keys(hosts).join(", ")})`);
    return build(forge, host, splitPath(rest.slice(slash + 1), forge));
  }

  const prefixed = /^([A-Za-z0-9.-]+):(.+)$/.exec(spec);
  if (prefixed) {
    const key = prefixed[1]!.toLowerCase();
    const host = key === "github" ? "github.com" : key === "gitlab" ? "gitlab.com" : key;
    const forge = hosts[host];
    if (!forge) throw new Error(`Unknown forge "${prefixed[1]}" (allowed: github, gitlab, ${Object.keys(hosts).join(", ")})`);
    return build(forge, host, splitPath(prefixed[2]!, forge));
  }

  const first = spec.split("/")[0]!.toLowerCase();
  if (hosts[first]) {
    const forge = hosts[first]!;
    return build(forge, first, splitPath(spec.slice(first.length + 1), forge));
  }
  return build("github", "github.com", splitPath(spec, "github"));
}

/** A git ref (branch, tag or commit) that is safe to hand to `git`. */
export function validateGitRef(ref: string): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_./+@-]{0,199}$/.test(ref) || ref.includes("..") || ref.endsWith(".lock")) {
    throw new Error(`Invalid git ref "${ref}"`);
  }
  return ref;
}
