import type { Config } from "../config.js";
import { ConfigError } from "../errors.js";
import { parseRepoRef } from "../forge/repo-ref.js";
import type { RepoRef } from "../types.js";
import { HostEntryError, PROXY_PORT, parseHostEntry } from "./hosts.js";

/** One local service a repository's sandbox may reach: a host name and a port. */
export interface LocalTarget {
  host: string;
  port: number;
}

const NAME = "MCPE_LOCAL_ACCESS";

/** At most the offending segment, cut to 80 characters; never the whole variable. */
function quote(segment: string): string {
  const s = segment.length > 80 ? `${segment.slice(0, 80)}...` : segment;
  return JSON.stringify(s);
}

function parseTarget(raw: string, segment: string): LocalTarget {
  let entry;
  try {
    entry = parseHostEntry(raw, "local-access");
  } catch (e) {
    if (!(e instanceof HostEntryError)) throw e;
    if (e.step === "literal") {
      throw new ConfigError(
        `${NAME}: ${quote(segment)}: target ${quote(raw)} is an IP literal. A contained sandbox reaches local access only by a name that resolves to the proxy, so use a name, such as host.docker.internal:<port>.`,
      );
    }
    throw new ConfigError(`${NAME}: ${quote(segment)}: target ${quote(raw)} ${e.message}.`);
  }
  if (entry.ports.length !== 1) throw new ConfigError(`${NAME}: ${quote(segment)}: target ${quote(raw)} needs a port, as in db.lan:5432.`);
  return { host: entry.host, port: entry.ports[0]! };
}

/**
 * Parse MCPE_LOCAL_ACCESS: `<repo>=<host>:<port>[,<host>:<port>...][;<repo>=...]`. Keys resolve through
 * parseRepoRef (so they may use MCPE_EXTRA_HOSTS) and are stored by lower-cased id.
 */
export function parseLocalAccess(raw: string | undefined, hosts: Config["hosts"]): Record<string, LocalTarget[]> {
  const result: Record<string, LocalTarget[]> = {};
  for (const rawSegment of (raw ?? "").split(";")) {
    const segment = rawSegment.trim();
    if (segment === "") continue;
    const eq = segment.indexOf("=");
    if (eq < 0) throw new ConfigError(`${NAME}: ${quote(segment)} needs the form <repo>=<host>:<port>[,<host>:<port>].`);
    const key = segment.slice(0, eq).trim();
    let id: string;
    try {
      id = parseRepoRef(key, hosts).id.toLowerCase();
    } catch (e) {
      throw new ConfigError(`${NAME}: repository ${quote(key)} is not valid: ${(e as Error).message}`);
    }
    if (Object.hasOwn(result, id)) throw new ConfigError(`${NAME}: repository ${quote(key)} is named twice.`);
    const targets: LocalTarget[] = [];
    for (const rawTarget of segment.slice(eq + 1).split(",")) {
      const text = rawTarget.trim();
      if (text === "") continue;
      const target = parseTarget(text, segment);
      if (target.port === PROXY_PORT) {
        throw new ConfigError(`${NAME}: ${quote(segment)}: target ${quote(text)} uses port ${PROXY_PORT}, the proxy's own.`);
      }
      const clash = targets.find((t) => t.port === target.port);
      if (clash) {
        throw new ConfigError(
          `${NAME}: ${quote(segment)}: targets ${clash.host}:${clash.port} and ${target.host}:${target.port} use the same port; one repository needs a different port for each.`,
        );
      }
      targets.push(target);
    }
    if (targets.length === 0) throw new ConfigError(`${NAME}: ${quote(segment)} names no target.`);
    result[id] = targets;
  }
  return result;
}

/** The repository's local-access targets, or []. Ids compare case-insensitively. */
export function localAccessFor(cfg: Pick<Config, "network">, repo: RepoRef): LocalTarget[] {
  const found = cfg.network.localAccess[repo.id.toLowerCase()];
  return found ? [...found] : [];
}
