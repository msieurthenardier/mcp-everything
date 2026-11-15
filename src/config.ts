import os from "node:os";
import path from "node:path";
import type { Ecosystem } from "./types.js";

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
  maxToolsPerProject: number;
  maxOutputBytes: number;
}

function int(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
    if (!HOSTNAME.test(rawHost)) throw new Error(`MCPE_EXTRA_HOSTS: invalid host "${rawHost}"`);
    const kind = rawKind ?? "gitlab";
    if (kind !== "github" && kind !== "gitlab") {
      throw new Error(`MCPE_EXTRA_HOSTS: "${rawHost}" must be =github or =gitlab`);
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
      memory: env.MCPE_MEMORY || "4g",
      cpus: env.MCPE_CPUS || "2",
      pidsLimit: int(env.MCPE_PIDS_LIMIT, 1024),
      namePrefix: /^[a-z0-9][a-z0-9_.-]{0,30}$/.test(env.MCPE_NAME_PREFIX ?? "") ? env.MCPE_NAME_PREFIX! : "mcpe-",
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
    maxToolsPerProject: int(env.MCPE_MAX_TOOLS_PER_PROJECT, 40),
    maxOutputBytes: int(env.MCPE_MAX_OUTPUT_BYTES, 100_000),
  };
}
