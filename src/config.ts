import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Ecosystem } from "./types.js";
import { ConfigError } from "./errors.js";
import { parseLocalAccess, type LocalTarget } from "./network/local-access.js";
import { parseScannersFile } from "./scan/scanners-file.js";
import { LEVELS, type Level, type ScannerSpec } from "./scan/types.js";

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
    /** The image the one-shot and project proxies run (`node -e`); needs Node 22 or later. */
    proxyImage: string;
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
  /** Checking a project's own code before it runs. */
  scan: {
    mode: "off" | "warn" | "block";
    /** The configured threshold, whatever the mode. */
    blockAt: Level;
    timeoutSec: number;
    scanners: ScannerSpec[];
    scannersFile?: string;
  };
  /** How sandboxes reach the network. */
  network: {
    mode: "open" | "contained";
    /** Local services a repository's sandbox may reach under containment, by lower-cased repository id. */
    localAccess: Record<string, LocalTarget[]>;
  };
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

/** Largest scanners file accepted. */
const MAX_SCANNERS_FILE_BYTES = 1_000_000;

/**
 * Default reader for the scanners file. It stats first and refuses anything but a regular file of
 * at most 1 MB, so a FIFO or /dev/zero cannot hang startup.
 */
function readScannersFileFromDisk(file: string): string {
  const st = fs.statSync(file);
  if (!st.isFile()) throw new ConfigError(`MCPE_SCANNERS=${JSON.stringify(file)} is not a regular file`);
  if (st.size > MAX_SCANNERS_FILE_BYTES) {
    throw new ConfigError(`MCPE_SCANNERS=${JSON.stringify(file)} is ${st.size} bytes; at most ${MAX_SCANNERS_FILE_BYTES}`);
  }
  return fs.readFileSync(file, "utf8");
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = readScannersFileFromDisk,
): Config {
  const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  const img = (eco: string, fallback: string) =>
    env[`MCPE_IMAGE_${eco.toUpperCase()}`] || env.MCPE_IMAGE || fallback;
  const set = (eco: string) => Boolean(env[`MCPE_IMAGE_${eco.toUpperCase()}`] || env.MCPE_IMAGE);
  // Full (non-slim) Debian-based images: they ship git, a C toolchain and
  // coreutils `timeout`, which the install recipes rely on.
  const generic = "buildpack-deps:stable";
  const hosts = parseHosts(env.MCPE_EXTRA_HOSTS);
  const network: Config["network"] = { mode: parseNetworkMode(env.MCPE_NETWORK), localAccess: parseLocalAccess(env.MCPE_LOCAL_ACCESS, hosts) };
  const scan = parseScan(env, readFile);
  if (network.mode === "contained") {
    const bare = scan.scanners.find((s) => s.network && s.hosts.length === 0);
    if (bare) {
      throw new ConfigError(
        `MCPE_SCANNERS: scanner ${JSON.stringify(bare.name)} has "network": true and needs "hosts" under MCPE_NETWORK=contained.`,
      );
    }
  }
  return {
    dataDir: env.MCPE_DATA_DIR || path.join(dataHome, "mcp-everything"),
    githubToken: env.GITHUB_TOKEN || env.GH_TOKEN || undefined,
    gitlabToken: env.GITLAB_TOKEN || undefined,
    hosts,
    docker: {
      bin: env.MCPE_DOCKER_BIN || "docker",
      runtime: env.MCPE_DOCKER_RUNTIME || undefined,
      memory: limit(env.MCPE_MEMORY, "4g", true),
      cpus: limit(env.MCPE_CPUS, "2", false),
      pidsLimit: int(env.MCPE_PIDS_LIMIT, 1024),
      namePrefix: parseNamePrefix(env.MCPE_NAME_PREFIX),
      // Pinned by the index digest (the multi-arch manifest list), with the tag it was read under.
      // To bump: `docker buildx imagetools inspect alpine/git:latest` gives the digest and Docker Hub
      // lists the version tag that `latest` points to; then run the Docker suite and the pressure cases.
      probeImage: env.MCPE_PROBE_IMAGE || "alpine/git:2.54.1@sha256:29cff25811f790b9f72fc266bf8009a5a911714c0e03c31c47339c50909d9aef",
      // Pinned by the index digest, with the tag it was read under: `node:22-alpine` (Docker Hub, 2026-11-22;
      // read with `docker buildx imagetools inspect node:22-alpine`, Node 22 on Alpine). The proxy program runs
      // under `node -e`, so any image with Node 22 or later and no other need works. To bump, read the digest the
      // same way and run the Docker suite.
      proxyImage: env.MCPE_PROXY_IMAGE || "node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a",
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
    scan,
    network,
  };
}

/** Unset, empty or `open` gives open; `contained` gives contained; anything else is an error, not a silent fallback. */
function parseNetworkMode(raw: string | undefined): Config["network"]["mode"] {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "open") return "open";
  if (v === "contained") return "contained";
  throw new ConfigError(`MCPE_NETWORK=${JSON.stringify(raw)} is not valid: use open or contained.`);
}

function parseScan(env: NodeJS.ProcessEnv, readFile: (path: string) => string): Config["scan"] {
  const rawMode = (env.MCPE_SCAN ?? "").trim().toLowerCase();
  let mode: Config["scan"]["mode"];
  if (rawMode === "" || rawMode === "off") mode = "off";
  else if (rawMode === "on" || rawMode === "warn") mode = "warn";
  else if (rawMode === "block") mode = "block";
  else throw new ConfigError(`MCPE_SCAN=${JSON.stringify(env.MCPE_SCAN)} is not valid: use off, on, warn or block.`);

  const rawAt = (env.MCPE_SCAN_BLOCK_AT ?? "").trim().toLowerCase();
  let blockAt: Level = "error";
  if (rawAt !== "") {
    if (!(LEVELS as readonly string[]).includes(rawAt)) {
      throw new ConfigError(`MCPE_SCAN_BLOCK_AT=${JSON.stringify(env.MCPE_SCAN_BLOCK_AT)} is not valid: use error, warning or note.`);
    }
    if (mode !== "block") throw new ConfigError("MCPE_SCAN_BLOCK_AT has effect only with MCPE_SCAN=block.");
    blockAt = rawAt as Level;
  }

  const rawTimeout = env.MCPE_SCAN_TIMEOUT;
  let timeoutSec = 900;
  if (rawTimeout !== undefined && rawTimeout !== "") {
    const n = /^[0-9]+$/.test(rawTimeout) ? Number(rawTimeout) : NaN;
    if (!(n >= 60 && n <= 3600)) {
      throw new ConfigError(`MCPE_SCAN_TIMEOUT=${JSON.stringify(rawTimeout)} is not valid: use whole seconds from 60 to 3600.`);
    }
    timeoutSec = n;
  }

  const file = env.MCPE_SCANNERS;
  if (file === undefined || file === "") return { mode, blockAt, timeoutSec, scanners: [] };
  let text: string;
  try {
    text = readFile(file);
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    throw new ConfigError(`MCPE_SCANNERS=${JSON.stringify(file)} cannot be read${code ? ` (${code})` : ""}.`);
  }
  if (text.length > MAX_SCANNERS_FILE_BYTES) {
    throw new ConfigError(`MCPE_SCANNERS=${JSON.stringify(file)} is larger than ${MAX_SCANNERS_FILE_BYTES} bytes.`);
  }
  return { mode, blockAt, timeoutSec, scanners: parseScannersFile(text, file), scannersFile: file };
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
