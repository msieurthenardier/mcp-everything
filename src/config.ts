import os from "node:os";
import path from "node:path";
import type { Ecosystem } from "./types.js";
import { ConfigError } from "./errors.js";

export interface Config {
  dataDir: string;
  githubToken?: string;
  gitlabToken?: string;
  /** Hosts repositories may be cloned from, mapped to the forge API they speak. */
  hosts: Record<string, "github" | "gitlab">;
  docker: {
    bin: string;
    runtime?: string;
    memory: string;
    cpus: string;
    pidsLimit: number;
    /** Prefix of container and volume names; lets separate registries coexist. */
    namePrefix: string;
    probeImage: string;
    images: Record<Ecosystem, string>;
    /** Ecosystems whose image the operator chose; version detection leaves those alone. */
    imageOverridden: Record<Ecosystem, boolean>;
  };
  installTimeoutSec: number;
  toolTimeoutSec: number;
  helpTimeoutSec: number;
  /** How long a proxied MCP server may take to answer `initialize`. */
  mcpStartupTimeoutSec: number;
  /** Proxied MCP servers idle for this long are shut down. */
  mcpIdleSec: number;
  /**
   * A sandbox container stops itself after this long without activity; 0 keeps
   * it running. Fixed when the container is created. (Not mcpIdleSec, which
   * closes proxied MCP servers.)
   */
  sandboxIdleSec: number;
  maxToolsPerProject: number;
  maxOutputBytes: number;
}

// Docker reads a zero --memory / --cpus as "no limit"; treat it like an unset
// value so a stray zero cannot switch a sandbox limit off. Anything else is
// passed through to docker untouched. The patterns cover the spellings Docker
// was measured to read as zero (0, 00, .0, 0.0, +0, -0, 0e0, 0_0; for memory
// also an optional unit such as g, GiB, mb or " g"; for cpus also 0/1 and 0x0).
const ZERO = String.raw`[+-]?(?:0[0_]*(?:\.0*)?|\.0+)(?:e[+-]?\d+)?`;
const ZERO_MEMORY = new RegExp(`^${ZERO} ?(?:[kmgtp](?:i?b)?|b)?$`, "i");
const ZERO_CPUS = new RegExp(`^(?:${ZERO}(?:/[1-9]\\d*)?|[+-]?0x0+)$`, "i");

function limit(value: string | undefined, fallback: string, unit: boolean): string {
  if (!value) return fallback;
  return (unit ? ZERO_MEMORY : ZERO_CPUS).test(value) ? fallback : value;
}

function int(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Like int(), but 0 is a valid value. */
function nonNegativeInt(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const HOSTNAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

/**
 * Parse MCPE_EXTRA_HOSTS, e.g. "gitlab.gnome.org=gitlab,git.example.com=gitlab".
 * github.com and gitlab.com are always allowed.
 */
export function parseHosts(spec: string | undefined): Config["hosts"] {
  const hosts: Config["hosts"] = { "github.com": "github", "gitlab.com": "gitlab" };
  for (const entry of (spec ?? "").split(",")) {
    const [rawHost, rawKind] = entry.trim().toLowerCase().split("=");
    if (!rawHost) continue;
    if (!HOSTNAME.test(rawHost)) throw new ConfigError(`MCPE_EXTRA_HOSTS: invalid host "${rawHost}"`);
    const kind = rawKind ?? "gitlab";
    if (kind !== "github" && kind !== "gitlab") {
      throw new ConfigError(`MCPE_EXTRA_HOSTS: "${rawHost}" must be =github or =gitlab`);
    }
    hosts[rawHost] = kind;
  }
  return hosts;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  const img = (eco: string, fallback: string) =>
    env[`MCPE_IMAGE_${eco.toUpperCase()}`] || env.MCPE_IMAGE || fallback;
  const set = (eco: string) => Boolean(env[`MCPE_IMAGE_${eco.toUpperCase()}`] || env.MCPE_IMAGE);
  // Full (non-slim) Debian-based images: they ship git, a C toolchain and
  // coreutils `timeout`, which the install recipes rely on.
  const generic = "buildpack-deps:stable";
  return {
    dataDir: env.MCPE_DATA_DIR || path.join(dataHome, "mcp-everything"),
    githubToken: env.GITHUB_TOKEN || env.GH_TOKEN || undefined,
    gitlabToken: env.GITLAB_TOKEN || undefined,
    hosts: parseHosts(env.MCPE_EXTRA_HOSTS),
    docker: {
      bin: env.MCPE_DOCKER_BIN || "docker",
      runtime: env.MCPE_DOCKER_RUNTIME || undefined,
      memory: limit(env.MCPE_MEMORY, "4g", true),
      cpus: limit(env.MCPE_CPUS, "2", false),
      pidsLimit: int(env.MCPE_PIDS_LIMIT, 1024),
      namePrefix: parseNamePrefix(env.MCPE_NAME_PREFIX),
      probeImage: env.MCPE_PROBE_IMAGE || "alpine/git:latest",
      images: {
        rust: img("rust", "rust:1"),
        go: img("go", "golang:1"),
        python: img("python", "python:3.13"),
        node: img("node", "node:lts"),
        ruby: img("ruby", "ruby:3"),
        cmake: img("cmake", generic),
        autotools: img("autotools", generic),
        make: img("make", generic),
        generic: img("generic", generic),
      },
      imageOverridden: {
        rust: set("rust"),
        go: set("go"),
        python: set("python"),
        node: set("node"),
        ruby: set("ruby"),
        cmake: set("cmake"),
        autotools: set("autotools"),
        make: set("make"),
        generic: set("generic"),
      },
    },
    installTimeoutSec: int(env.MCPE_INSTALL_TIMEOUT, 900),
    toolTimeoutSec: int(env.MCPE_TOOL_TIMEOUT, 120),
    helpTimeoutSec: int(env.MCPE_HELP_TIMEOUT, 10),
    mcpStartupTimeoutSec: int(env.MCPE_MCP_STARTUP_TIMEOUT, 30),
    mcpIdleSec: int(env.MCPE_MCP_IDLE_TIMEOUT, 600),
    sandboxIdleSec: nonNegativeInt(env.MCPE_SANDBOX_IDLE_TIMEOUT, 1800),
    maxToolsPerProject: int(env.MCPE_MAX_TOOLS_PER_PROJECT, 40),
    maxOutputBytes: int(env.MCPE_MAX_OUTPUT_BYTES, 100_000),
  };
}

/** Unset or empty gives the default; a set value that is not a valid name prefix is an error, not a silent fallback. */
function parseNamePrefix(raw: string | undefined): string {
  if (!raw) return "mcpe-";
  if (!/^[a-z0-9][a-z0-9_.-]{0,30}$/.test(raw)) {
    throw new ConfigError(
      `MCPE_NAME_PREFIX=${JSON.stringify(raw)} is not valid: use 1-31 characters from [a-z0-9_.-], starting with a letter or digit.`,
    );
  }
  return raw;
}
