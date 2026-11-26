import { ConfigError } from "../errors.js";
import { HostEntryError, formatHostEntry, parseHostEntry } from "../network/hosts.js";
import type { ScannerSpec } from "./types.js";

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
// The image-reference pattern install_project uses.
const IMAGE = /^[a-z0-9][a-z0-9._/:@-]{0,200}$/i;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const KEYS = new Set(["name", "image", "command", "entrypoint", "network", "timeout_seconds", "env", "stage", "hosts"]);
const MAX_ENTRIES = 16;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate the scanners file's text. Throws ConfigError naming `source`, the entry and the field. */
export function parseScannersFile(text: string, source: string): ScannerSpec[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // JSON.parse's message can quote the input; say only that it is not JSON.
    throw new ConfigError(`${source}: not valid JSON`);
  }
  if (!isObject(data)) throw new ConfigError(`${source}: must be a JSON object with a "scanners" array`);
  for (const k of Object.keys(data)) {
    if (k !== "scanners") throw new ConfigError(`${source}: unknown key ${JSON.stringify(k)} (only "scanners" is allowed)`);
  }
  const list = Object.keys(data).includes("scanners") ? data.scanners : undefined;
  if (!Array.isArray(list)) throw new ConfigError(`${source}: "scanners" must be an array`);
  if (list.length > MAX_ENTRIES) throw new ConfigError(`${source}: "scanners" has ${list.length} entries; at most ${MAX_ENTRIES}`);

  const seen = new Set<string>();
  return list.map((raw, i) => {
    const label = (name?: unknown) =>
      typeof name === "string" && NAME.test(name) ? `${source}: scanners[${i}] (${name})` : `${source}: scanners[${i}]`;
    if (!isObject(raw)) throw new ConfigError(`${label()}: must be an object`);
    const own = Object.keys(raw);
    const get = (k: string): unknown => (own.includes(k) ? raw[k] : undefined);
    const where = label(get("name"));
    for (const k of own) {
      if (!KEYS.has(k)) throw new ConfigError(`${where}: unknown field ${JSON.stringify(k.slice(0, 40))}`);
    }

    const name = get("name");
    if (typeof name !== "string" || !NAME.test(name)) {
      throw new ConfigError(`${where}: "name" must match ${NAME.source}`);
    }
    if (name === "build-hooks") throw new ConfigError(`${where}: "name" build-hooks is reserved for the built-in check`);
    if (seen.has(name)) throw new ConfigError(`${where}: "name" is used by an earlier scanner`);
    seen.add(name);

    const image = get("image");
    if (typeof image !== "string" || !IMAGE.test(image)) {
      throw new ConfigError(`${where}: "image" must be an image reference matching ${IMAGE.source}`);
    }

    const command = get("command");
    if (!Array.isArray(command) || command.length === 0 || command.length > 64) {
      throw new ConfigError(`${where}: "command" must be an array of 1 to 64 strings`);
    }
    for (const c of command) {
      if (typeof c !== "string" || c.length > 4096 || c.includes("\0")) {
        throw new ConfigError(`${where}: "command" entries must be strings of at most 4096 characters with no NUL`);
      }
    }

    const entrypoint = get("entrypoint");
    if (entrypoint !== undefined && (typeof entrypoint !== "string" || entrypoint.length > 256 || entrypoint.includes("\0"))) {
      throw new ConfigError(`${where}: "entrypoint" must be a string of at most 256 characters with no NUL ("" clears the image's entrypoint)`);
    }

    const network = get("network");
    if (network !== undefined && typeof network !== "boolean") throw new ConfigError(`${where}: "network" must be true or false`);

    const timeout = get("timeout_seconds");
    if (timeout !== undefined && (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 10 || timeout > 1800)) {
      throw new ConfigError(`${where}: "timeout_seconds" must be an integer from 10 to 1800`);
    }

    const env = get("env");
    if (env !== undefined) {
      if (!Array.isArray(env) || !env.every((e) => typeof e === "string" && ENV_NAME.test(e))) {
        throw new ConfigError(`${where}: "env" must be an array of variable names matching ${ENV_NAME.source}`);
      }
    }

    const rawHosts = get("hosts");
    const hosts: string[] = [];
    if (rawHosts !== undefined) {
      if (!Array.isArray(rawHosts) || rawHosts.length < 1 || rawHosts.length > 64) {
        throw new ConfigError(`${where}: "hosts" must be an array of 1 to 64 strings`);
      }
      for (const h of rawHosts) {
        if (typeof h !== "string") throw new ConfigError(`${where}: "hosts" entries must be strings`);
        try {
          hosts.push(formatHostEntry(parseHostEntry(h, "scanner")));
        } catch (e) {
          if (!(e instanceof HostEntryError)) throw e;
          throw new ConfigError(`${where}: "hosts" entry ${JSON.stringify(h.slice(0, 80))} ${e.message}`);
        }
      }
    }

    const stage = get("stage");
    if (stage !== undefined && stage !== "source" && stage !== "build") {
      throw new ConfigError(`${where}: "stage" must be "source" or "build"`);
    }

    return {
      name,
      image,
      command: command as string[],
      ...(entrypoint !== undefined ? { entrypoint: entrypoint as string } : {}),
      network: network ?? false,
      hosts,
      timeoutSec: timeout ?? 300,
      env: (env as string[] | undefined) ?? [],
      ...(stage !== undefined ? { stage } : {}),
    };
  });
}
