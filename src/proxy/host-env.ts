import { ENV_NAME, UNUSABLE_ENV_VALUE } from "./mcp-proxy.js";

/**
 * Variables an operator sets on the mcp-everything process as `{slug}__{NAME}`
 * reach the MCP servers of that project as `NAME`. Everything here is pure:
 * the environment object is an argument, never read from the process.
 */

const SEPARATOR = "__";

export interface HostVariable {
  /** The name the server sees. */
  name: string;
  /** The name in the process environment, with its prefix. */
  full: string;
  value: string;
}

/**
 * The variables the project owns. A variable belongs to the project whose slug
 * is the longest one, among `slugs`, that its name starts with (`slug__`);
 * only then is the remainder checked for being a valid name. The project's own
 * slug always counts, so one not yet recorded still gets its variables.
 */
export function ownedVariables(slug: string, slugs: Iterable<string>, env: Record<string, string | undefined>): HostVariable[] {
  const all = [...new Set([...slugs, slug])];
  const out: HostVariable[] = [];
  for (const [full, value] of Object.entries(env)) {
    if (value === undefined) continue;
    let owner: string | undefined;
    for (const s of all) {
      if (full.startsWith(`${s}${SEPARATOR}`) && (owner === undefined || s.length > owner.length)) owner = s;
    }
    if (owner !== slug) continue;
    const name = full.slice(slug.length + SEPARATOR.length);
    if (!ENV_NAME.test(name)) continue;
    out.push({ name, full, value });
  }
  return out;
}

/** The names a project receives, for display. Never reads or judges a value, so it cannot throw. */
export function hostVariableNames(slug: string, slugs: Iterable<string>, env: Record<string, string | undefined>): string[] {
  return ownedVariables(slug, slugs, env).map((v) => v.name);
}

/** Errors thrown for an unusable value, so callers can tell them from other failures without a subclass. */
const unusable = new WeakSet<object>();

/** True for the error `launchVariables` throws when a value cannot be passed. */
export function isUnusableValueError(e: unknown): boolean {
  return typeof e === "object" && e !== null && unusable.has(e);
}

/**
 * The variables to launch with, unprefixed name to value. Throws a plain Error
 * naming the variable (never its value) when a value cannot be passed.
 */
export function launchVariables(slug: string, slugs: Iterable<string>, env: Record<string, string | undefined>): Record<string, string> {
  const owned = ownedVariables(slug, slugs, env);
  for (const v of owned) {
    if (UNUSABLE_ENV_VALUE.test(v.value)) {
      const error = new Error(`Environment variable ${v.full} contains a line break or NUL character and cannot be passed to the MCP server.`);
      unusable.add(error);
      throw error;
    }
  }
  // fromEntries defines own properties, so a variable named __proto__ stays data.
  return Object.fromEntries(owned.map((v) => [v.name, v.value]));
}
