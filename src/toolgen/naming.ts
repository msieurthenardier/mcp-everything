import { createHash } from "node:crypto";

/**
 * MCP clients forward tool names to model APIs that require
 * ^[a-zA-Z0-9_-]{1,64}$, and prepend their own `mcp__<server>__` prefix.
 * Keeping generated names within 42 characters leaves room for that.
 */
export const MAX_TOOL_NAME = 42;

export function sanitizeIdent(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 6);
}

/** Repository names that say nothing without their owner ("httpie/cli"). */
const GENERIC_NAMES = new Set([
  "cli", "core", "app", "server", "client", "main", "src", "code", "project", "tool", "tools", "lib", "sdk",
  "api", "web", "www", "docs", "engine", "desktop", "mobile", "backend", "frontend", "monorepo", "platform",
]);

/** Cut `value` to `n` characters without leaving a trailing `_`, so a following `_` never makes `__`. */
function cut(value: string, n: number): string {
  return value.slice(0, n).replace(/_+$/, "");
}

/** Stable short slug for a project, unique among `taken`. */
export function makeSlug(repoName: string, owner: string, taken: (slug: string) => boolean): string {
  let name = sanitizeIdent(repoName) || "project";
  const ownerIdent = sanitizeIdent(owner);
  if (GENERIC_NAMES.has(name) && ownerIdent && ownerIdent !== name) name = `${cut(ownerIdent, 12)}_${name}`;
  const base = cut(name, 18);
  if (!taken(base)) return base;
  const withOwner = `${cut(base, 12)}_${sanitizeIdent(owner).slice(0, 5) || "x"}`;
  if (!taken(withOwner)) return withOwner;
  for (let i = 2; ; i++) {
    const candidate = `${cut(base, 14)}_${i}`;
    if (!taken(candidate)) return candidate;
  }
}

/** `<slug>__<part>_<part>`, truncated with a hash suffix when too long, unique in `used`. */
export function makeToolName(slug: string, parts: string[], used: Set<string>): string {
  const tail = parts.map(sanitizeIdent).filter(Boolean).join("_") || "run";
  let name = `${slug}__${tail}`;
  if (name.length > MAX_TOOL_NAME) {
    name = `${name.slice(0, MAX_TOOL_NAME - 7)}_${shortHash(name)}`;
  }
  let unique = name;
  for (let i = 2; used.has(unique); i++) {
    const suffix = `_${i}`;
    unique = `${name.slice(0, MAX_TOOL_NAME - suffix.length)}${suffix}`;
  }
  used.add(unique);
  return unique;
}
