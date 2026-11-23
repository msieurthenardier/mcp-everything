import { randomBytes } from "node:crypto";
import net from "node:net";
import type { Config } from "../config.js";
import { isInstallationId } from "../installation.js";
import { cloneHosts } from "../network/defaults.js";
import { parseHostEntry, PROXY_PORT, type HostEntry } from "../network/hosts.js";
import { joinRefusals, refusalLines } from "../network/refusals.js";
import { PROXY_CONTROL_PORT, PROXY_PROGRAM_VERSION, proxyConfig, proxyLaunchArgs, type ProxyConfig } from "../network/proxy/config.js";
import type { RepoRef } from "../types.js";
import { run, type RunResult } from "../util/exec.js";
import { BUILD_FILE_PATTERNS, PRUNE_DIRS } from "../scan/build-hooks.js";
import type { BuildFile, BuildWalk } from "../scan/types.js";
import { cleanTerminalText, oneLine } from "../util/text.js";
import type { ScannerSpec } from "../scan/types.js";

/** Paths inside every sandbox. */
export const WORKSPACE = "/workspace";
export const REPO_DIR = "/workspace/repo";
export const WORK_DIR = "/workspace/work";
export const PREFIX = "/opt/mcpe";
export const BIN_DIR = "/opt/mcpe/bin";
export const VENV_DIR = "/opt/mcpe/venv";

const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export interface ProbeData {
  commit: string;
  /** Top-level entries of the repository. */
  entries: Array<{ name: string; dir: boolean }>;
  /** Contents of well-known manifest files, keyed by file name. */
  files: Record<string, string>;
  /** The build files the walk of the clone read (see WALK_SCRIPT). Always present. */
  walk: BuildWalk;
}

export interface ExecOptions {
  cwd?: string;
  stdin?: string;
  timeoutSec: number;
  maxBytes?: number;
  onOutput?: (chunk: string) => void;
  /**
   * Start the sandbox and run the command once more when the first attempt
   * failed only because the container was stopped. Default true; cleanup that
   * must not wake a stopped sandbox passes false.
   */
  restart?: boolean;
  /**
   * Variables for this command (`docker exec -e NAME=value`). NOT for secrets: values are visible in `ps` and in
   * Docker's own listings. A checked reference's own `env` is merged over this one and wins, so a caller cannot
   * remove the variables the reference carries (the proxy's, once leg 7 sets them).
   */
  env?: Record<string, string>;
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * `-e NAME=value` pairs for `docker exec`. Names are identifiers and values hold no line break or NUL. The one
 * validator for `execOnce` and the MCP connector, so that the two cannot drift. Nothing is secret here: argv is public.
 */
export function envFlags(env: Record<string, string> | undefined): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!ENV_NAME_PATTERN.test(k)) throw new Error(`Invalid environment variable name ${JSON.stringify(k.slice(0, 60))}`);
    if (typeof v !== "string" || /[\r\n\u0000]/.test(v)) throw new Error(`Environment variable ${k} must be a string without line breaks`);
    out.push("-e", `${k}=${v}`);
  }
  return out;
}

export interface ExecResult extends RunResult {
  timedOut: boolean;
}

export const MANIFESTS = [
  "package.json",
  "pnpm-lock.yaml",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "Makefile",
  "makefile",
  "GNUmakefile",
  // Runtime version pins.
  ".nvmrc",
  ".node-version",
  ".tool-versions",
  ".python-version",
  ".ruby-version",
  "Gemfile",
  "rust-toolchain.toml",
  "rust-toolchain",
];

// Runs in the probe image (busybox sh). Every untrusted value is a positional
// parameter; all file names and contents come back base64-encoded so repository
// content cannot forge protocol lines.
const CLONE_SCRIPT = `
set -eu
url="$1"; ref="$2"; submodules="$3"; shift 3
export GIT_TERMINAL_PROMPT=0
rm -rf ${REPO_DIR}
mkdir -p ${WORK_DIR}
extra=""
[ "$submodules" = "1" ] && extra="--recurse-submodules --shallow-submodules"
if [ -n "$ref" ]; then
  if ! git -c credential.helper= clone --quiet --depth 1 $extra --branch "$ref" -- "$url" ${REPO_DIR} >&2; then
    rm -rf ${REPO_DIR}
    git init --quiet ${REPO_DIR} >&2
    git -C ${REPO_DIR} remote add origin "$url" >&2
    git -C ${REPO_DIR} -c credential.helper= fetch --quiet --depth 1 origin "$ref" >&2
    git -C ${REPO_DIR} checkout --quiet FETCH_HEAD >&2
  fi
else
  git -c credential.helper= clone --quiet --depth 1 $extra -- "$url" ${REPO_DIR} >&2
fi
cd ${REPO_DIR}
printf 'HEAD %s\\n' "$(git rev-parse HEAD)"
ls -1A | head -n 500 | while IFS= read -r f; do
  kind=f; [ -d "$f" ] && kind=d
  printf 'ENTRY %s %s\\n' "$kind" "$(printf %s "$f" | base64 | tr -d '\\n')"
done
while [ $# -gt 0 ] && [ "$1" != "--walk--" ]; do
  f="$1"; shift
  if [ -f "$f" ] && [ ! -L "$f" ]; then
    printf 'FILE %s %s\\n' "$f" "$(head -c 300000 "$f" | base64 | tr -d '\\n')"
  fi
done
if [ $# -gt 0 ]; then shift; fi
`;

/** The marker argument that ends the manifest names and begins the walk's arguments. */
export const WALK_SEPARATOR = "--walk--";

/**
 * The walk's arguments, after the separator: the number of pruned directory names, those names, then one
 * quadruple per pattern: `kind pattern rootOnly presenceOnly` (flags `1` or `0`). They are data: the script
 * only ever uses them quoted, as `find` operands. None holds a shell-special character other than the glob `*`
 * (which is only ever an operand of `-name`).
 */
export function walkArguments(): string[] {
  return [
    String(PRUNE_DIRS.length),
    ...PRUNE_DIRS,
    ...BUILD_FILE_PATTERNS.flatMap((e) => [e.kind, e.pattern, e.rootOnly ? "1" : "0", e.presenceOnly ? "1" : "0"]),
  ];
}

// Appended to CLONE_SCRIPT (and run alone by the tests, which is why it enters the checkout itself). Its
// arguments are those of walkArguments(). It reads the build files named by the patterns, within budgets (200
// files, 64 KB each, 2 MB in all, 40 per pattern), and says what it could not read: every `INCOMPLETE` line
// names a reason, and a link is reported, never read. Nothing here may make the script fail once the clone
// has succeeded, so `-eu` is turned off first and the script ends with `exit 0`. All names and contents are
// base64, so repository text cannot forge a line. The arguments are used only quoted, never `eval`ed.
export const WALK_SCRIPT = `
set +eu
cd ${REPO_DIR}
b64() { printf %s "$1" | base64 | tr -d '\\n'; }
np="$1"; shift
prune=""; i=0
while [ "$i" -lt "$np" ]; do prune="$prune $1"; shift; i=$((i + 1)); done
# wfind <depth option> <depth> <-name|-path> <pattern> [<extra -path>]: files and links under the checkout, pruning .git and the prune names.
wfind() {
  d1="$1"; d2="$2"; t="$3"; pat="$4"; deep="$5"
  set -- \\( -name .git
  set -f
  for p in $prune; do set -- "$@" -o -name "$p"; done
  set +f
  if [ -n "$deep" ]; then
    find . "$d1" "$d2" "$@" \\) -prune -o \\( -type f -o -type l \\) "$t" "$pat" -path "$deep" -print
  else
    find . "$d1" "$d2" "$@" \\) -prune -o \\( -type f -o -type l \\) "$t" "$pat" -print
  fi
}
walkfind() { { wfind "$@" || echo '#WALKFAIL'; }; }
verdict() {
  case "$1" in
    '#WALKFAIL'*) echo 'INCOMPLETE walk' ;;
    ?*) echo "INCOMPLETE $2" ;;
  esac
}
nlpat=$(printf '*\\n*')
verdict "$(walkfind -mindepth 0 -path "$nlpat" | head -n 1)" newline
all=""
rootlist=""
while [ "$#" -ge 4 ]; do
  kind="$1"; pat="$2"; root="$3"; presence="$4"; shift 4
  case "$kind" in
    name|glob) t=-name ;;
    path) t=-path ;;
    *) continue ;;
  esac
  if [ "$root" = 1 ] && [ "$kind" != glob ]; then
    if [ "$presence" = 1 ]; then
      if [ -L "./$pat" ]; then echo "LINK $(b64 "$pat")"
      elif [ -f "./$pat" ]; then echo "BUILD $(b64 "$pat") 0 "
      fi
    elif [ -L "./$pat" ] || [ -f "./$pat" ]; then
      rootlist="$rootlist
./$pat"
    fi
    continue
  fi
  if [ "$root" = 1 ]; then maxd=1; else maxd=8; fi
  if [ "$kind" = path ]; then pat="*/$pat"; fi
  # Root-level matches (and the failure marker) sort first, so the cap never drops them for nested files.
  out=$(walkfind -maxdepth "$maxd" "$t" "$pat" | sed -E 's,^(\\./[^/]*|#WALKFAIL)$,0&,;ta;s,^,1,;:a' | sort | head -n 41 | cut -c2-)
  if [ -n "$out" ] && [ "$(printf '%s\\n' "$out" | wc -l)" -ge 41 ]; then
    echo 'INCOMPLETE pattern'
    out=$(printf '%s\\n' "$out" | head -n 40)
  fi
  all="$all
$out"
  if [ "$root" != 1 ]; then
    verdict "$(walkfind -maxdepth 1000 "$t" "$pat" './*/*/*/*/*/*/*/*/*' | head -n 1)" depth
  fi
done
found=$(printf '%s\\n' "$all" | sort -u)
near=$(printf '%s\\n' "$found" | grep -E '^(\\./[^/]*|#WALKFAIL)$')
far=$(printf '%s\\n' "$found" | grep -vE '^(\\./[^/]*|#WALKFAIL)$')
files=0; bytes=0
printf '%s\\n%s\\n%s\\n' "$rootlist" "$near" "$far" | {
  while IFS= read -r line; do
    case "$line" in
      '') continue ;;
      '#WALKFAIL') echo 'INCOMPLETE walk'; continue ;;
      ./*) ;;
      *) continue ;;
    esac
    p="\${line#./}"
    if [ -L "$line" ]; then echo "LINK $(b64 "$p")"; continue; fi
    [ -f "$line" ] || continue
    size=$(wc -c < "$line"); size=$((size + 0))
    trunc=0; take=$size
    if [ "$size" -gt 65536 ]; then trunc=1; take=65536; fi
    if [ "$files" -ge 200 ]; then echo 'INCOMPLETE files'; break; fi
    if [ $((bytes + take)) -gt 2097152 ]; then echo 'INCOMPLETE bytes'; break; fi
    files=$((files + 1)); bytes=$((bytes + take))
    echo "BUILD $(b64 "$p") $trunc $(head -c 65536 "$line" | base64 | tr -d '\\n')"
  done
}
exit 0
`;

/** The clone script followed by the walk: what the probe container runs. Exported for tests. */
export const PROBE_SCRIPT = CLONE_SCRIPT + WALK_SCRIPT;

// Entrypoint of every sandbox with an idle timeout: $1 is the timeout and $2 the
// poll interval, both in seconds. Exits 0 (stopping the container) once nothing
// has run for the timeout. Activity is any process besides PID 1, this shell and
// its sleep, or a gap in the PIDs of successive sleeps (a process was created
// and ended between polls). Time comes from /proc/uptime, and the loop uses
// builtins only, so it never sees its own children as activity. PATH is fixed
// because the container's own puts project-writable directories first.
// The loop's only fork is its sleep, and that fork fails at the sandbox's
// process limit. A failed fork exits a non-interactive dash or busybox shell,
// which would stop the container, so it runs under `command eval` (an error
// there does not abort the shell) and is retried at once. A poll that had to
// retry counts as activity, and the first failure is announced once on stderr.
// Its behavior under a contested process limit is tested only by the fork-pressure
// cases in test/integration/docker.test.ts, which `npm run test:docker` skips.
// Run `npm run test:docker:pressure` after changing this script or the images.
// The guard was measured on dash 0.5.12 (Debian 13, `buildpack-deps:stable`) and
// BusyBox 1.37.0 `sh` (Alpine 3.24, the pinned `alpine/git` image of `probeImage` in
// src/config.ts) in November 2026. The dash tag floats, so a newer shell behind it
// is untested until the pressure cases have been run against it; the pin changes
// only when someone bumps it, and the cases should be run then too.
const WATCHDOG_SCRIPT = `
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
idle="$1"; poll="$2"
read up _ < /proc/uptime; last=\${up%%.*}
prev=0; warned=0
while :; do
  starved=0
  until command eval 'sleep "$poll" & pid=$!' 2>/dev/null; do
    starved=1
    [ "$warned" = 1 ] || { warned=1; echo "watchdog: cannot fork (process limit reached); retrying" >&2; }
  done
  active=$starved
  [ "$pid" -eq $((prev + 1)) ] || active=1
  prev=$pid
  for d in /proc/[0-9]*; do
    case "\${d#/proc/}" in 1|$$|$pid) ;; *) active=1 ;; esac
  done
  read up _ < /proc/uptime; now=\${up%%.*}
  if [ "$active" = 1 ]; then last=$now
  elif [ $((now - last)) -ge $((idle + poll)) ]; then exit 0
  fi
  wait "$pid"
done
`;

/** How often the watchdog looks, given the idle timeout. */
export function watchdogPollSec(idleSec: number): number {
  return Math.min(15, Math.max(1, Math.floor(idleSec / 4)));
}

/**
 * True when a result is, in its entirety, one of docker's own "could not exec,
 * the container is stopped" failures: the command never started.
 */
export function isStoppedExecFailure(r: {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}): boolean {
  if (r.timedOut || r.truncated) return false;
  const out = r.stdout.trim();
  const err = r.stderr.trim();
  if (r.code === 1) {
    return out === "" && /^Error response from daemon: [Cc]ontainer \S+ is not running$/.test(err);
  }
  if (r.code === 128) {
    return (
      err === "" &&
      (out === "cannot exec in a stopped state" ||
        out === "OCI runtime exec failed: exec failed: cannot exec in a stopped container")
    );
  }
  return false;
}

const INCOMPLETE_REASONS = ["pattern", "newline", "depth", "files", "bytes", "walk"];

/**
 * Parse the clone's stdout. Lines are matched exactly (no trimming): `BUILD` has four space-separated parts
 * (the fourth may be empty), `LINK` and `INCOMPLETE` two. `outputTruncated` says the capture hit its cap:
 * the last line may then be partial and is dropped, and the walk is marked incomplete.
 */
export function parseProbeOutput(stdout: string, outputTruncated = false): ProbeData {
  const data: ProbeData = { commit: "", entries: [], files: {}, walk: { files: [] } };
  const b64 = (s: string | undefined) => Buffer.from(s ?? "", "base64").toString("utf8");
  const lines = stdout.split("\n");
  if (outputTruncated) lines.pop();
  const skipped: string[] = [];
  for (const line of lines) {
    const parts = line.split(" ");
    if (parts[0] === "HEAD" && /^[0-9a-f]{40,64}$/.test(parts[1] ?? "")) {
      data.commit = parts[1]!;
    } else if (parts[0] === "ENTRY" && parts.length === 3) {
      data.entries.push({ name: b64(parts[2]), dir: parts[1] === "d" });
    } else if (parts[0] === "FILE" && parts.length === 3 && MANIFESTS.includes(parts[1]!)) {
      data.files[parts[1]!] = b64(parts[2]);
    } else if (parts[0] === "BUILD" && parts.length === 4 && (parts[2] === "0" || parts[2] === "1")) {
      const file: BuildFile = { path: b64(parts[1]), content: b64(parts[3]) };
      if (parts[2] === "1") file.truncated = true;
      data.walk.files.push(file);
    } else if (parts[0] === "LINK" && parts.length === 2) {
      skipped.push(b64(parts[1]));
    } else if (parts[0] === "INCOMPLETE" && parts.length === 2 && INCOMPLETE_REASONS.includes(parts[1]!)) {
      data.walk.incomplete ??= parts[1]!;
    }
  }
  if (skipped.length > 0) data.walk.skippedLinks = skipped;
  if (outputTruncated) data.walk.incomplete = "output";
  return data;
}

/** The label every sandbox of mcp-everything carries, and the one that names its installation. */
export const GENERIC_LABEL = "mcp-everything";
export const OWNER_LABEL = "mcp-everything.owner";
export const PROJECT_LABEL = "mcp-everything.project";

/**
 * Whose a container or volume is, judged from its labels alone: "mine" (the owner
 * label is this installation's id), "another" (an owner label with any other
 * value, empty or malformed included), "before" (the generic label `1` and no
 * owner label: made before ownership was recorded) or "not-ours".
 */
export type SandboxClass = "mine" | "another" | "before" | "not-ours";

export function classifySandbox(labels: Record<string, unknown> | null | undefined, installationId: string): SandboxClass {
  if (labels === null || labels === undefined || typeof labels !== "object" || Array.isArray(labels)) return "not-ours";
  if (Object.hasOwn(labels, OWNER_LABEL)) return labels[OWNER_LABEL] === installationId ? "mine" : "another";
  return labels[GENERIC_LABEL] === "1" ? "before" : "not-ours";
}

/** What `Docker.ownership` reports: a class, "missing", or "unavailable" (Docker could not be asked). */
export interface OwnershipReport {
  state: SandboxClass | "missing" | "unavailable";
  /** The owner label as recorded, for another's only. */
  owner?: string;
}

/** A checked container: its full id and its name, and nothing else. */
export interface SandboxRef {
  readonly id: string;
  readonly name: string;
  /** Variables every exec through this reference carries; they win over a caller's `ExecOptions.env`. */
  readonly env?: Readonly<Record<string, string>>;
}

/** A checked reference; `env` is copied and frozen. */
export function makeRef(id: string, name: string, env?: Record<string, string>): SandboxRef {
  return Object.freeze({ id, name, ...(env !== undefined ? { env: Object.freeze({ ...env }) } : {}) });
}

/** What a refusal says about one sandbox, or one of the proxies and networks that go with it. */
export interface SandboxFacts {
  kind: "container" | "volume" | "network" | "proxy";
  sandbox: string;
  cls: SandboxClass;
  /** The owner label as recorded (another's only). */
  owner?: string;
  /** The project label as recorded (containers, proxies and networks). */
  project?: string;
}

/** One inspect of a sandbox: what the containment hook is given (leg 7). */
export interface SandboxInspectFacts {
  id: string;
  name: string;
  running: boolean;
  labels: Record<string, string> | null;
  networks: string[];
  /** The id of each network the sandbox is on, by name; absent when the answer did not carry them (a scripted double). */
  networkIds?: Record<string, string>;
  runtime: string | undefined;
}

/** A project's network: `<sandbox name>-net`. */
export function projectNetworkName(sandbox: string): string {
  return `${sandbox}-net`;
}

/**
 * What the hook is asked for: "full" may repair the sandbox's proxy and network before the start or exec that
 * follows; "observe" (cleanup: an exec with `restart: false`) only answers the environment and changes nothing.
 */
export type ContainmentHookMode = "full" | "observe";

/**
 * The containment hook (leg 7): given one inspect's facts, it returns the environment a command in that sandbox
 * needs (the proxy's variables) or undefined, and it may throw to refuse the start or exec. It must use only
 * primitives that do not pass through the hook itself (a test counts the entries).
 */
export type ContainmentHook = (facts: SandboxInspectFacts, mode: ContainmentHookMode) => Promise<Record<string, string> | undefined>;

/**
 * The post-start step (leg 13): called after a sandbox is running, with its facts and whether Docker started it just
 * now (`started`) or it was already running. It writes the sandbox's local-access names into its `/etc/hosts`, which
 * Docker rewrites on every start. It must never throw (a failure is logged by the step itself), and it may use only
 * primitives that do not pass through the hook.
 */
export type AfterStartHook = (facts: SandboxInspectFacts, started: boolean) => Promise<void>;

/** A fresh name for a project's proxy: `<sandbox name>-proxy-<8 hex>`. */
export function newProjectProxyName(sandbox: string): string {
  return `${sandbox}-proxy-${randomBytes(4).toString("hex")}`;
}

/** The network state a list of networks makes, for a sandbox of that name: nothing, its own `-net` only, or anything else. */
export function networkModeOf(sandbox: string, networks: readonly string[]): NetworkMode {
  if (networks.length === 0) return "off";
  return networks.length === 1 && networks[0] === projectNetworkName(sandbox) ? "contained" : "open";
}

const LABEL_MAX = 64;

/**
 * How much of an owner label is shown anywhere an operator reads it (a refusal, an install warning, project_info).
 * Imported by those other places so the cut cannot drift. LABEL_MAX still bounds every other text from Docker.
 */
export const OWNER_SHOWN = 64;
const clean = (v: string) => oneLine(v, LABEL_MAX);

function describeFacts(f: SandboxFacts): string {
  const what = `${f.kind} "${clean(f.sandbox)}"`;
  const project = f.kind !== "volume" ? `, project label ${f.project === undefined ? "(none)" : `"${clean(f.project)}"`}` : "";
  switch (f.cls) {
    case "another":
      return `${what} is another installation's (owner label "${oneLine(f.owner ?? "", OWNER_SHOWN)}"${project})`;
    case "not-ours":
      return `${what} was not created by mcp-everything${project}`;
    case "before":
      return `${what} was made before ownership was recorded (treated as this installation's${project})`;
    default:
      return `${what} is this installation's${project}`;
  }
}

/** The one place a refusal's message is built. */
function refusalMessage(facts: SandboxFacts[], installationId: string): string {
  const subject = facts.map((f) => `${f.kind} "${clean(f.sandbox)}"`).join(" and ");
  return `Refusing to act on ${subject}: ${facts.map(describeFacts).join("; ")}. This installation is ${installationId}.`;
}

/** A sandbox is another installation's or not mcp-everything's, so nothing was done to it. */
export class SandboxRefusedError extends Error {
  /** The first sandbox that was refused. */
  readonly kind: SandboxFacts["kind"];
  readonly sandbox: string;
  readonly reason: "another" | "not-ours";
  readonly owner: string | undefined;
  readonly installationId: string;
  /** Every sandbox the refusal speaks of (a container and its volume, for `destroy`). */
  readonly sandboxes: readonly SandboxFacts[];

  constructor(facts: SandboxFacts[], installationId: string) {
    super(refusalMessage(facts, installationId));
    this.name = "SandboxRefusedError";
    const first = facts.find((f) => f.cls === "another" || f.cls === "not-ours") ?? facts[0]!;
    this.kind = first.kind;
    this.sandbox = first.sandbox;
    this.reason = first.cls === "another" ? "another" : "not-ours";
    this.owner = first.owner;
    this.installationId = installationId;
    this.sandboxes = facts;
  }
}

/** A volume a method was given is missing, from before ownership, or has the wrong role: nothing was created. */
export class VolumeNotUsableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VolumeNotUsableError";
  }
}

/** Docker could not be asked, or answered in a way that cannot be read: nothing was assumed. */
export class DockerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerUnavailableError";
  }
}

/**
 * MCPE_DOCKER_RUNTIME names a runtime Docker does not list or cannot run a container with. Naming a runtime is
 * requiring it: nothing falls back to another.
 */
export class RuntimeUnavailableError extends Error {
  readonly runtime: string;
  readonly reason: string;
  constructor(runtime: string, reason: string) {
    super(
      `MCPE_DOCKER_RUNTIME names ${oneLine(runtime, 100)}, but Docker cannot run containers with it (${reason}); ` +
        "install it and register it with Docker, or unset MCPE_DOCKER_RUNTIME.",
    );
    this.name = "RuntimeUnavailableError";
    this.runtime = runtime;
    this.reason = reason;
  }
}

/**
 * Containment cannot be had on this Docker: the network it made is not contained, its address pools are used up,
 * or it has no upstream DNS server to give the proxy. Never a reason to fall back to `bridge`.
 */
export class ContainmentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainmentUnavailableError";
  }
}

/** The network proxy did not start or did not become ready. Never a refusal of anything the one-shot asked for. */
export class ProxyStartError extends Error {
  constructor(detail: string) {
    super(`the network proxy did not start: ${detail}`);
    this.name = "ProxyStartError";
  }
}

/**
 * A clone that failed. `detail` is Docker's and git's own text; under containment `refusals` are the lines for the hosts
 * the clone's proxy refused (at most 10 lines), and the message carries them after `detail`. A check that must cut the
 * text puts `refusals` first, so that the cut is of git's stderr and never of the refusal.
 */
export class CloneFailedError extends Error {
  constructor(
    readonly detail: string,
    readonly refusals: readonly string[],
  ) {
    super(refusals.length > 0 ? `${detail}\n${joinRefusals(refusals, "\n")}` : detail);
    this.name = "CloneFailedError";
  }
}

/** An existing sandbox was created under a runtime other than the one now required; it was not started or run in. */
export class RuntimeMismatchError extends Error {
  readonly sandbox: string;
  readonly named: string;
  readonly actual: string;
  constructor(sandbox: string, named: string, actual: string) {
    super(
      `Sandbox ${clean(sandbox)} was created before MCPE_DOCKER_RUNTIME=${oneLine(named, 100)} was set; ` +
        `Docker reports its runtime as ${oneLine(actual, 100)}. Reinstall the project to run it under ${oneLine(named, 100)}.`,
    );
    this.name = "RuntimeMismatchError";
    this.sandbox = sandbox;
    this.named = named;
    this.actual = actual;
  }
}

const NOT_THERE = /no such (container|object|volume)/i;
/** Docker's wording for a network that is not there: `No such network` or, on the daemon this was measured on, `network X not found`. Networks only. */
const NETWORK_NOT_THERE = /no such network|\bnetwork \S+ not found\b/i;
const FULL_ID = /^[0-9a-f]{64}$/;
const ROLE_LABEL = "mcp-everything.role";
/** The roles of the containers a one-shot call makes (the label and the name carry one). A network has its own role, below. */
export const ONE_SHOT_ROLES = ["clone", "scan", "copy", "runtime-check", "resolv-read", "oneshot-proxy"] as const;
const UNKNOWN_RUNTIME = "unknown or invalid runtime name";
const EXTRA_CAPS: readonly string[] = ["CHOWN", "FOWNER", "DAC_OVERRIDE", "FSETID"];
/** The role of the network a one-shot behind a proxy runs on. */
const ONESHOT_NET_ROLE = "oneshot-net";
/** What the message of a refused network says a Docker needs. No number until one has been measured (leg 4 measured 29.4.2 and 29.8.2 as working, no lower bound). */
const ISOLATED_BRIDGE_NEEDS = "a Docker version whose bridge driver supports gateway_mode_ipv4=isolated";
/**
 * The proxy's address on a contained network: the last usable host address of its IPv4 subnet (for `172.22.0.0/16`,
 * `172.22.255.254`), never the broadcast address. Contained containers reach the proxy at this address and not by a
 * name, because a name needs Docker's embedded DNS, which gVisor's network stack cannot reach. The networks are made
 * with an `--ip-range` in their lower half, so the daemon never hands this address out. Pure. A `/31`, a `/32` and
 * anything that is not an IPv4 CIDR have no such address and are refused.
 */
export function proxyAddress(subnet: string): string {
  const { base, prefix } = parseSubnet(subnet);
  return dotted(base + 2 ** (32 - prefix) - 2);
}

function parseSubnet(subnet: string): { base: number; prefix: number } {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(subnet);
  if (!m) throw new Error(`Not an IPv4 subnet: ${oneLine(subnet, 80)}`);
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) throw new Error(`Not an IPv4 subnet: ${oneLine(subnet, 80)}`);
  const prefix = Number(m[5]);
  if (prefix < 1 || prefix > 30) throw new Error(`The subnet ${oneLine(subnet, 80)} has no room for a proxy address (it needs a prefix of /1 to /30)`);
  const ip = ((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (ip & mask) >>> 0, prefix };
}

const dotted = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

/** The lower half of a subnet, as the `--ip-range` a contained network is made with (`172.22.0.0/16` gives `172.22.0.0/17`). */
function lowerHalf(subnet: string): string {
  const { base, prefix } = parseSubnet(subnet);
  return `${dotted(base)}/${prefix + 1}`;
}

/** `{ networkIds }` from an inspect's `NetworkSettings.Networks`: the full ids it carries, by network name; nothing when it carries none. */
function networkIdsOf(networks: unknown): { networkIds?: Record<string, string> } {
  if (networks === null || typeof networks !== "object" || Array.isArray(networks)) return {};
  const ids: Record<string, string> = {};
  for (const [name, v] of Object.entries(networks as Record<string, unknown>)) {
    const id = v !== null && typeof v === "object" ? (v as { NetworkID?: unknown }).NetworkID : undefined;
    if (typeof id === "string" && FULL_ID.test(id)) ids[name] = id;
  }
  return Object.keys(ids).length > 0 ? { networkIds: ids } : {};
}

/** The marker that ends each line mcp-everything writes into a sandbox's `/etc/hosts`. */
export const LOCAL_ACCESS_MARK = "# mcpe-local-access";
/**
 * The script a root `docker exec` runs to put the local-access lines into `/etc/hosts` (`sh -c SCRIPT sh <lines> <file>`).
 * Idempotent: it does nothing when the marked lines are already the wanted ones. Otherwise it builds the new content
 * (every line that is not marked, then the wanted lines) and writes it with ONE `printf` redirected into the file:
 * no `sed -i` and no `mv`, because `/etc/hosts` is a bind mount that cannot be replaced.
 */
export const LOCAL_ACCESS_SCRIPT = [
  `want="$1"; file="$2"`,
  `have=$(grep '${LOCAL_ACCESS_MARK}$' "$file")`,
  `[ "$have" = "$want" ] && exit 0`,
  `keep=$(grep -v '${LOCAL_ACCESS_MARK}$' "$file")`,
  `if [ -n "$want" ]; then printf '%s\\n%s\\n' "$keep" "$want"; else printf '%s\\n' "$keep"; fi > "$file"`,
].join("\n");
/** Names a forward target may not take in a sandbox's `/etc/hosts`: the sandbox's own (its hostname is `sandbox`). */
const OWN_HOST_NAMES = new Set(["localhost", "sandbox", "ip6-localhost", "ip6-loopback", "ip6-localnet", "ip6-mcastprefix", "ip6-allnodes", "ip6-allrouters"]);
const HOSTS_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
/** The roles of a project's network and proxies, and the label that names the sandbox they belong to. */
const PROJECT_NET_ROLE = "project-net";
const PROJECT_PROXY_ROLE = "project-proxy";
export const SANDBOX_LABEL = "mcp-everything.sandbox";
const RESERVED_LABELS = new Set(["mcp-everything", OWNER_LABEL, ROLE_LABEL, PROJECT_LABEL, SANDBOX_LABEL]);
const NETWORK_FORMAT =
  '{"id":{{json .Id}},"name":{{json .Name}},"internal":{{json .Internal}},"ipv6":{{json .EnableIPv6}},"ipam":{{json .IPAM.Config}},"labels":{{json .Labels}},"created":{{json .Created}}}';
const POOLS_EXHAUSTED = /all predefined address pools have been fully subnetted/i;
/** Docker's refusal of a subnet that overlaps one in use: another network took it between the probe and the real create. */
const POOL_OVERLAPS = /pool overlaps/i;
/** How many times a network create is retried, with a fresh probe, when its subnet overlaps. */
const POOL_RETRIES = 3;

/** What a one-shot container is for; the label and the name carry it, and nothing a caller types. */
export type OneShotRole = (typeof ONE_SHOT_ROLES)[number];
/** The only capabilities a one-shot container may be given beyond none. */
export type OneShotCap = "CHOWN" | "FOWNER" | "DAC_OVERRIDE" | "FSETID";
export interface OneShotSpec {
  role: OneShotRole;
  image: string;
  /** Required without `egress`; an error with it (the call makes its own network). */
  network?: string;
  /** Run behind a one-shot proxy on a contained network, allowed only these hosts. `local` is a scanner's (DD12). */
  egress?: { allow: HostEntry[]; local?: boolean };
  /** `-v` values, `<volume>:<path>[:ro]`. Callers must have classified the volumes. */
  mounts?: string[];
  /** `--mount` values (a read-only mount needs the long form's `readonly`). Callers must have classified the volumes. */
  mountFlags?: string[];
  /** A file of NAME=value lines for `--env-file`; the caller writes it, guards it and removes it. */
  envFile?: string;
  workdir?: string;
  /** When omitted, no `--entrypoint` flag: the image's own entrypoint runs. */
  entrypoint?: string;
  caps?: OneShotCap[];
  /** Arguments after the image. */
  args: string[];
  timeoutMs: number;
  maxBytes: number;
}

export const PROXY_KINDS = ["connect", "http", "forward"] as const;
export const PROXY_REASONS = [
  "not-allowed", "refused-address", "no-address", "resolve-failed", "connect-failed", "timeout", "bad-request", "method", "cap",
] as const;
/** One row of the proxy's refusals, as leg 3's `/status` gives it, after it was checked here. */
export interface ProxyRefusalRow {
  kind: (typeof PROXY_KINDS)[number];
  host: string | null;
  port: number | null;
  reason: (typeof PROXY_REASONS)[number];
  count: number;
  firstAt: string;
  lastAt: string;
}
/** What the proxy refused, read when a one-shot behind it failed; `unavailable` when it could not be read. */
export type ProxyReport = { unavailable: true } | { rows: ProxyRefusalRow[]; total: number; resolverFailures: number };
/** What `runOnce` returns: the run, and (only for a failed run behind a proxy) what the proxy refused. */
export type OneShotResult = RunResult & { proxy?: ProxyReport };
/** A contained network, checked after it was made. */
export interface ContainedNetwork {
  id: string;
  name: string;
  subnet: string;
}

/** A project's proxy, as `listProjectProxies` found it. */
export interface ProjectProxy {
  id: string;
  name: string;
  running: boolean;
  labels: Record<string, string>;
}

/** What `checkContainedNetwork` found: a contained network that is ours, or why not. */
type NetworkCheck =
  | { kind: "ok"; id: string; subnet: string }
  | { kind: "unreadable" }
  | { kind: "foreign"; problem: string; labels: Record<string, unknown> | null }
  | { kind: "uncontained"; problem: string };

const networkInspectArgs = (target: string): string[] => ["network", "inspect", "--format", NETWORK_FORMAT, target];

/** The refusal for a network that is not this installation's, role and project: always "another" or "not-ours". */
function foreignNetworkRefusal(name: string, labels: Record<string, unknown> | null, installationId: string): SandboxRefusedError {
  const asStrings = labels === null ? null : (Object.fromEntries(Object.entries(labels).filter(([, v]) => typeof v === "string")) as Record<string, string>);
  const cls = classifySandbox(asStrings, installationId);
  return new SandboxRefusedError(
    [{ kind: "network", sandbox: name, cls: cls === "another" ? "another" : "not-ours", owner: asStrings?.[OWNER_LABEL], project: asStrings?.[PROJECT_LABEL] }],
    installationId,
  );
}

const MAX_REPORT_ROWS = 50;
const isCount = (n: unknown, min: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= min;

/**
 * The proxy's `/status` as a report. Nothing in it is trusted: the shape is checked, `kind` and `reason` must be in
 * leg 3's vocabularies, a row that is not valid is dropped (at most 50 are kept), text is cleaned and cut, and an
 * answer that is not an object with a rows array and two counts is `unavailable`.
 */
export function parseProxyReport(value: unknown): ProxyReport {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { unavailable: true };
  const v = value as { refusals?: unknown; total?: unknown; resolverFailures?: unknown };
  if (!Array.isArray(v.refusals) || !isCount(v.total, 0) || !isCount(v.resolverFailures, 0)) return { unavailable: true };
  const rows: ProxyRefusalRow[] = [];
  // Look at no more than a bounded number of entries, whatever the array holds.
  for (const raw of v.refusals.slice(0, MAX_REPORT_ROWS * 4)) {
    if (rows.length >= MAX_REPORT_ROWS) break;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    if (!(PROXY_KINDS as readonly unknown[]).includes(r.kind) || !(PROXY_REASONS as readonly unknown[]).includes(r.reason)) continue;
    if (r.host !== null && (typeof r.host !== "string" || r.host.length > 253)) continue;
    if (r.port !== null && !(isCount(r.port, 1) && r.port <= 65535)) continue;
    if (!isCount(r.count, 1) || typeof r.firstAt !== "string" || typeof r.lastAt !== "string") continue;
    rows.push({
      kind: r.kind as ProxyRefusalRow["kind"],
      host: r.host === null ? null : cleanTerminalText(r.host as string),
      port: r.port as number | null,
      reason: r.reason as ProxyRefusalRow["reason"],
      count: r.count,
      firstAt: cleanTerminalText(r.firstAt).slice(0, 64),
      lastAt: cleanTerminalText(r.lastAt).slice(0, 64),
    });
  }
  return { rows, total: v.total, resolverFailures: v.resolverFailures };
}

/** The nameservers of a resolv.conf that the proxy may use: IPv4 and IPv6 literals, no loopback, IPv4 first. */
export function parseResolvConf(text: string): string[] {
  const v4: string[] = [];
  const v6: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*nameserver\s+(\S+)\s*(?:#.*)?$/.exec(line);
    if (!m) continue;
    const a = m[1]!;
    if (a.includes("%")) continue;
    if (net.isIPv4(a)) {
      if (a.startsWith("127.") || a === "0.0.0.0") continue;
      if (!v4.includes(a)) v4.push(a);
    } else if (net.isIPv6(a)) {
      const lower = a.toLowerCase();
      if (lower === "::1" || lower === "::" || lower.startsWith("::ffff:127.")) continue;
      if (!v6.includes(a)) v6.push(a);
    }
  }
  return [...v4, ...v6];
}

// A format that label content cannot confuse (every value is JSON). Never `{{json .}}`: it holds the environment.
const NETWORKS = '"networks":{{json .NetworkSettings.Networks}}';
const RUNTIME = '"runtime":{{json .HostConfig.Runtime}}';
const NAME = '"name":{{json .Name}}';
const BASE_FORMAT = `{"id":{{json .Id}},${NAME},"running":{{json .State.Running}},${RUNTIME},${NETWORKS}}`;
const FULL_FORMAT = `{"id":{{json .Id}},${NAME},"running":{{json .State.Running}},"labels":{{json .Config.Labels}},${RUNTIME},${NETWORKS}}`;

interface ContainerFacts {
  id: string;
  /** The container's name, without Docker's leading `/`; absent when the answer has none (a scripted double). */
  name?: string;
  running: boolean;
  networks: string[];
  /** The id of each network by name (NetworkSettings.Networks[name].NetworkID), for the entries that carry one. */
  networkIds?: Record<string, string>;
  labels: Record<string, string> | null;
  /** HostConfig.Runtime; absent, null or empty when the daemon (or a test double) does not say. */
  runtime?: string;
}

type Target = string | SandboxRef;

/** The network a sandbox is on: none, its own project network only, or `bridge` (or anything else). */
export type NetworkMode = "off" | "contained" | "open";

export class Docker {
  /** The runtime name that passed `assertRuntime()` in this process. */
  private runtimeOk: string | undefined;
  /** The check in flight, shared by concurrent callers. */
  private runtimeCheck: Promise<void> | undefined;
  /** The daemon's DefaultRuntime, once `docker info` has answered. */
  private daemonDefaultRuntime: string | undefined;
  /** The upstream DNS servers (or the read in flight): per instance, a failure is not kept. */
  private upstreamResolvers: Promise<string[]> | undefined;
  /** How long a proxy has to become ready, and how often it is asked. A field so that tests can shorten both. */
  protected proxyReadiness = { budgetMs: 10_000, pollMs: 250 };
  /** The containment hook, once `setContainment` installed one. With none, every method behaves as it did before leg 7. */
  private hook: ContainmentHook | undefined;
  /** The post-start step, installed with the hook. */
  private afterStartHook: AfterStartHook | undefined;
  /** The hook's answers for execs by reference on a running sandbox, by container id (see `hookedExecEnv`). */
  private hookCache = new Map<string, { env: Record<string, string> | undefined; expires: number; name: string; key: string | undefined }>();
  /** Bumped by every invalidation: a hook answer that was in flight across one is not cached. */
  private hookGeneration = 0;
  /** How long a hook answer is reused for an exec by reference. A field so that tests can shorten it. */
  protected hookTtlMs = 5_000;

  constructor(
    private readonly cfg: Config,
    /** The installation id: it is in the name and the owner label of every sandbox this layer creates. */
    readonly installationId: string,
    /** Where startup warnings go (the runtime check's); nowhere by default. */
    private readonly log: (line: string) => void = () => {},
  ) {
    if (!isInstallationId(installationId)) {
      throw new Error(`The installation id must be eight lowercase hexadecimal characters, got ${JSON.stringify(installationId)}.`);
    }
  }

  /** The one place the name prefix is joined to anything: the name of a sandbox's container and volume. */
  sandboxName(slug: string): string {
    return `${this.cfg.docker.namePrefix}${this.installationId}-${slug}`;
  }

  protected docker(args: string[], opts: Parameters<typeof run>[2] = {}): Promise<RunResult> {
    return run(this.cfg.docker.bin, args, opts);
  }

  /** The time the hook's cache is judged by. A method, so that a test can move it. */
  protected clock(): number {
    return Date.now();
  }

  /**
   * Install (or, with undefined, remove) the containment hook. Every sandbox start and exec of this class passes
   * through it (`acquire`, `ensureRunning`, the restart inside `exec`, and `exec` itself); nothing else does.
   */
  setContainment(hook: ContainmentHook | undefined, afterStart?: AfterStartHook): void {
    this.hook = hook;
    this.afterStartHook = hook ? afterStart : undefined;
    this.invalidate();
  }

  /** The post-start step for a sandbox that is running now (see `AfterStartHook`); nothing without one. */
  private async afterStarted(c: ContainerFacts, label: string, started: boolean): Promise<void> {
    const step = this.afterStartHook;
    if (!step) return;
    await step(
      { id: c.id, name: c.name ?? label, running: true, labels: c.labels, networks: [...c.networks], ...(c.networkIds ? { networkIds: { ...c.networkIds } } : {}), runtime: c.runtime },
      started,
    );
  }

  /**
   * Forget the hook's cached answers: those for a container id, a sandbox name or a project key (lower-cased
   * repository id), or all of them with no filter. An answer that is being computed while this runs is discarded
   * when it arrives. Called by `setNetwork`, `destroy` and by containment after a replacement.
   */
  invalidate(filter: { id?: string; sandbox?: string; key?: string } = {}): void {
    this.hookGeneration++;
    const all = filter.id === undefined && filter.sandbox === undefined && filter.key === undefined;
    for (const [id, e] of this.hookCache) {
      if (all || filter.id === id || (filter.sandbox !== undefined && filter.sandbox === e.name) || (filter.key !== undefined && filter.key === e.key)) {
        this.hookCache.delete(id);
      }
    }
  }

  /**
   * The hook's answer for one inspect: the environment to give a command in this sandbox, or undefined (no hook,
   * or nothing to add). With `cache`, a sandbox that the inspect said is running keeps the answer for `hookTtlMs`.
   * The one place the hook is called; a stale answer for a contained sandbox fails closed.
   */
  private async hooked(c: ContainerFacts, label: string, mode: ContainmentHookMode, cache = false): Promise<Record<string, string> | undefined> {
    const hook = this.hook;
    if (!hook) return undefined;
    const name = c.name ?? label;
    const generation = this.hookGeneration;
    const env = await hook(
      { id: c.id, name, running: c.running, labels: c.labels, networks: [...c.networks], ...(c.networkIds ? { networkIds: { ...c.networkIds } } : {}), runtime: c.runtime },
      mode,
    );
    if (cache && c.running && generation === this.hookGeneration) {
      this.hookCache.set(c.id, { env, expires: this.clock() + this.hookTtlMs, name, key: c.labels?.[PROJECT_LABEL]?.toLowerCase() });
    }
    return env;
  }

  /** A cached answer for an exec by reference, if one was stored within the last `hookTtlMs`. */
  private hookCached(id: string): { env: Record<string, string> | undefined } | undefined {
    const e = this.hookCache.get(id);
    if (!e) return undefined;
    if (this.clock() >= e.expires) {
      this.hookCache.delete(id);
      return undefined;
    }
    return { env: e.env };
  }

  /** Throws a readable error unless the Docker daemon is reachable. */
  async assertAvailable(): Promise<void> {
    let res: RunResult;
    try {
      res = await this.docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15_000 });
    } catch (e) {
      throw new DockerUnavailableError(`Docker CLI "${this.cfg.docker.bin}" could not be run: ${(e as Error).message}`);
    }
    if (res.code !== 0) {
      throw new DockerUnavailableError(`Docker daemon is not reachable: ${res.stderr.trim() || "unknown error"}`);
    }
  }

  /** Run docker; a binary that cannot be run is "could not be asked". */
  private async ask(args: string[], timeoutMs: number): Promise<RunResult> {
    try {
      return await this.docker(args, { timeoutMs });
    } catch (e) {
      throw new DockerUnavailableError(`Docker CLI "${this.cfg.docker.bin}" could not be run: ${(e as Error).message}`);
    }
  }

  /** True only for a clean, non-zero exit whose own error text says the object is not there. */
  private isNotThere(res: RunResult, wording: RegExp = NOT_THERE): boolean {
    return typeof res.code === "number" && res.code !== 0 && !res.timedOut && !res.truncated && wording.test(res.stderr);
  }

  /** The same for a network command, whose "not there" has its own wording; containers and volumes keep the narrower pattern. */
  private isNetworkNotThere(res: RunResult): boolean {
    return this.isNotThere(res, NETWORK_NOT_THERE);
  }

  private unreadable(what: string, res: RunResult): DockerUnavailableError {
    const why = res.timedOut ? "it timed out" : res.code !== 0 ? oneLine(res.stderr, 200) || `exit code ${res.code}` : "its answer could not be read";
    return new DockerUnavailableError(`Could not find out about ${what}: ${why}`);
  }

  /**
   * One inspect of a container, by name or by full id. Null when it is not there;
   * throws DockerUnavailableError for any other failure or an answer of the wrong shape.
   * Reads labels only when asked to. Never changes anything.
   */
  private async inspectContainer(target: string, withLabels: boolean): Promise<ContainerFacts | null> {
    const what = `container ${clean(target)}`;
    const res = await this.ask(["inspect", "--type", "container", "--format", withLabels ? FULL_FORMAT : BASE_FORMAT, target], 30_000);
    if (this.isNotThere(res)) return null;
    if (res.code !== 0 || res.timedOut || res.truncated) throw this.unreadable(what, res);
    let v: unknown;
    try {
      v = JSON.parse(res.stdout.trim());
    } catch {
      throw this.unreadable(what, { ...res, code: 0 });
    }
    const o = v as { id?: unknown; running?: unknown; labels?: unknown; networks?: unknown } | null;
    const isMap = (x: unknown): x is Record<string, unknown> => x === null || (typeof x === "object" && !Array.isArray(x));
    const labelsOk = !withLabels || (isMap(o?.labels) && Object.values(o?.labels ?? {}).every((x) => typeof x === "string"));
    if (!o || typeof o !== "object" || typeof o.id !== "string" || !FULL_ID.test(o.id) || typeof o.running !== "boolean" || !isMap(o.networks) || !labelsOk) {
      throw this.unreadable(what, { ...res, code: 0 });
    }
    const rt = (v as { runtime?: unknown }).runtime;
    const nm = (v as { name?: unknown }).name;
    return {
      id: o.id,
      ...(typeof nm === "string" && nm !== "" ? { name: nm.replace(/^\//, "") } : {}),
      running: o.running,
      networks: Object.keys(o.networks ?? {}),
      ...networkIdsOf(o.networks),
      labels: withLabels ? ((o.labels as Record<string, string> | null) ?? null) : null,
      ...(typeof rt === "string" && rt !== "" ? { runtime: rt } : {}),
    };
  }

  /**
   * With a runtime named, refuse a container created under another. An absent runtime field counts as the
   * daemon's default (from `docker info`, `runc` until that is known). Exact strings: an operator naming
   * `io.containerd.runc.v2` is refused on sandboxes Docker reports as `runc`, and the message says so.
   */
  private refuseRuntimeMismatch(name: string, c: ContainerFacts): void {
    const named = this.cfg.docker.runtime;
    if (!named) return;
    const actual = c.runtime ?? this.daemonDefaultRuntime ?? "runc";
    if (actual !== named) throw new RuntimeMismatchError(name, named, actual);
  }

  /** Docker's own refusal of an unregistered runtime (never a fallback): the error to throw, or undefined for any other failure. */
  private runtimeRefusal(stderr: string): RuntimeUnavailableError | undefined {
    const named = this.cfg.docker.runtime;
    if (!named) return undefined;
    const line = stderr.split("\n").find((l) => l.includes(UNKNOWN_RUNTIME) && l.includes(named));
    if (line === undefined) return undefined;
    this.runtimeOk = undefined;
    return new RuntimeUnavailableError(named, oneLine(line, 200));
  }

  /**
   * With a runtime named, check once per process that Docker lists it and can run a container with it. A success
   * is cached; a failure is not; concurrent first callers share one check. Does nothing when no runtime is named.
   * The trial runs `true` from the probe image (`alpine/git` has it as a BusyBox applet); an overridden
   * MCPE_PROBE_IMAGE without `true` fails the trial with Docker's "executable file not found".
   */
  async assertRuntime(): Promise<void> {
    const name = this.cfg.docker.runtime;
    if (!name || this.runtimeOk === name) return;
    if (!this.runtimeCheck) {
      const p: Promise<void> = this.checkRuntime(name)
        .then(() => {
          this.runtimeOk = name;
        })
        .finally(() => {
          if (this.runtimeCheck === p) this.runtimeCheck = undefined;
        });
      this.runtimeCheck = p;
    }
    return this.runtimeCheck;
  }

  private async checkRuntime(name: string): Promise<void> {
    const info = await this.ask(["info", "--format", '{"runtimes":{{json .Runtimes}},"default":{{json .DefaultRuntime}}}'], 30_000);
    if (info.code !== 0 || info.timedOut || info.truncated) throw this.unreadable("the runtimes Docker lists", info);
    let listed: { runtimes?: unknown; default?: unknown };
    try {
      listed = JSON.parse(info.stdout.trim()) as { runtimes?: unknown; default?: unknown };
    } catch {
      throw this.unreadable("the runtimes Docker lists", { ...info, code: 0 });
    }
    if (!listed || typeof listed.runtimes !== "object" || listed.runtimes === null || Array.isArray(listed.runtimes)) {
      throw this.unreadable("the runtimes Docker lists", { ...info, code: 0 });
    }
    if (typeof listed.default === "string" && listed.default !== "") this.daemonDefaultRuntime = listed.default;
    if (!Object.prototype.hasOwnProperty.call(listed.runtimes, name)) {
      throw new RuntimeUnavailableError(name, `Docker lists no runtime called ${oneLine(name, 100)}`);
    }
    if (name === "runsc") {
      // gVisor's default root-filesystem overlay discards writes outside volumes when a sandbox exits, and a build lives
      // in the container's layer: an idle-stopped sandbox would lose its tools. A warning, not a refusal: the registration is the operator's.
      const entry = (listed.runtimes as Record<string, { runtimeArgs?: unknown } | null>)[name];
      const args = Array.isArray(entry?.runtimeArgs) ? (entry.runtimeArgs as unknown[]) : [];
      if (!args.some((a) => typeof a === "string" && /^-{1,2}overlay2=none$/.test(a))) {
        this.log(
          "warning: the runtime runsc is not registered with --overlay2=none; a sandbox that idles out can lose what was built in it. " +
            "Register it with: runsc install -- --overlay2=none",
        );
      }
    }
    try {
      await this.ensureImage(this.cfg.docker.probeImage);
    } catch (e) {
      throw new RuntimeUnavailableError(name, oneLine((e as Error).message, 200));
    }
    let res: RunResult;
    try {
      res = await this.runOnce({
        role: "runtime-check",
        image: this.cfg.docker.probeImage,
        network: "none",
        entrypoint: "true",
        args: [],
        timeoutMs: 60_000,
        maxBytes: 64 * 1024,
      });
    } catch (e) {
      if (e instanceof RuntimeUnavailableError || e instanceof DockerUnavailableError) throw e;
      throw new RuntimeUnavailableError(name, oneLine((e as Error).message, 200));
    }
    if (res.timedOut) throw new RuntimeUnavailableError(name, "a trial container did not finish within 60 seconds");
    if (res.code !== 0) {
      const line = res.stderr.split("\n").find((l) => l.trim() !== "");
      throw new RuntimeUnavailableError(name, (line !== undefined ? oneLine(line, 200) : "") || `a trial container exited with code ${res.code}`);
    }
  }

  /** The labels of a volume, or null-for-absent as `undefined`. Same rule as for a container. */
  private async inspectVolume(name: string): Promise<{ labels: Record<string, string> | null } | undefined> {
    const what = `volume ${clean(name)}`;
    const res = await this.ask(["volume", "inspect", "--format", "{{json .Labels}}", name], 30_000);
    if (this.isNotThere(res)) return undefined;
    if (res.code !== 0 || res.timedOut || res.truncated) throw this.unreadable(what, res);
    let v: unknown;
    try {
      v = JSON.parse(res.stdout.trim());
    } catch {
      throw this.unreadable(what, { ...res, code: 0 });
    }
    if (v !== null && (typeof v !== "object" || Array.isArray(v) || !Object.values(v).every((x) => typeof x === "string"))) {
      throw this.unreadable(what, { ...res, code: 0 });
    }
    return { labels: v as Record<string, string> | null };
  }

  private containerFacts(name: string, c: ContainerFacts): SandboxFacts {
    const cls = classifySandbox(c.labels, this.installationId);
    return { kind: "container", sandbox: name, cls, owner: c.labels?.[OWNER_LABEL], project: c.labels?.[PROJECT_LABEL] };
  }

  private volumeFacts(name: string, labels: Record<string, string> | null): SandboxFacts {
    return { kind: "volume", sandbox: name, cls: classifySandbox(labels, this.installationId), owner: labels?.[OWNER_LABEL] };
  }

  private refuseUnless(facts: SandboxFacts[]): void {
    if (facts.some((f) => f.cls === "another" || f.cls === "not-ours")) throw new SandboxRefusedError(facts, this.installationId);
  }

  /** Classify a container by name: its facts when it is mine or from before, null when not there, a refusal otherwise. */
  private async resolveContainer(name: string): Promise<ContainerFacts | null> {
    const c = await this.inspectContainer(name, true);
    if (c) this.refuseUnless([this.containerFacts(name, c)]);
    return c;
  }

  private async startId(id: string, label: string, mapRuntime = false): Promise<void> {
    const res = await this.ask(["start", id], 60_000);
    if (res.code !== 0) {
      // Docker's own refusal of an unregistered runtime is never a plain failure (a new sandbox's first start meets it here).
      const refusal = mapRuntime ? this.runtimeRefusal(res.stderr) : undefined;
      if (refusal) throw refusal;
      throw new Error(`Failed to start sandbox ${clean(label)}: ${res.stderr.trim()}`);
    }
  }

  private doesNotExist(name: string): Error {
    return new Error(`Sandbox ${clean(name)} does not exist`);
  }

  /** `pullTimeoutMs` bounds the pull only (default 900 s); the local inspect keeps its own 30 s. */
  async ensureImage(image: string, onOutput?: (chunk: string) => void, pullTimeoutMs = 900_000): Promise<void> {
    const have = await this.docker(["image", "inspect", "--format", "{{.Id}}", image], { timeoutMs: 30_000 });
    if (have.code === 0) return;
    onOutput?.(`Pulling image ${image}…\n`);
    const pull = await this.docker(["pull", "--quiet", image], { timeoutMs: pullTimeoutMs });
    if (pull.code !== 0) throw new Error(`Failed to pull image ${image}: ${pull.stderr.trim()}`);
  }

  private async imagePath(image: string): Promise<string> {
    const res = await this.docker(["image", "inspect", "--format", "{{json .Config.Env}}", image], {
      timeoutMs: 30_000,
    });
    try {
      const env = JSON.parse(res.stdout) as string[] | null;
      const entry = (env ?? []).find((e) => e.startsWith("PATH="));
      if (entry) return entry.slice(5);
    } catch {
      /* fall through */
    }
    return DEFAULT_PATH;
  }

  private limits(): string[] {
    const d = this.cfg.docker;
    const args = [
      "--memory", d.memory,
      "--cpus", d.cpus,
      "--pids-limit", String(d.pidsLimit),
      "--security-opt", "no-new-privileges",
      "--cap-drop", "ALL",
    ];
    if (d.runtime) args.push("--runtime", d.runtime);
    return args;
  }

  /**
   * Run one command in a fresh, owned, named, one-shot container and remove it by id whatever
   * happens (success, failure, a timeout, a throw). `docker run --rm` cannot do that: a timeout
   * kills only the `docker` client and leaves the container running. So: `create --rm` (the
   * daemon also removes it on exit, which keeps a crashed Node process from leaking an exited
   * one), `start -a <id>` through `run()`, and `rm -f <id>` in a `finally`.
   *
   * It mounts whatever it is given. It acts only on the container it made, so it is not in the
   * guarded table; callers must classify every volume they pass (mine, staging, sandbox) first.
   * A Node process killed mid-call leaves a container named `...-<role>-<hex>` with the label
   * `mcp-everything.role`; leg 6's startup sweep removes those.
   *
   * No caller text reaches the name or the labels: the role is a closed type and the rest is
   * the installation id and random hexadecimal.
   *
   * With `egress` the call runs behind its own one-shot proxy on its own contained network (`runBehindProxy`);
   * `network` must then be absent. Without it the Docker calls are exactly those of a call on `spec.network`.
   */
  protected async runOnce(spec: OneShotSpec): Promise<OneShotResult> {
    if (!(ONE_SHOT_ROLES as readonly string[]).includes(spec.role)) throw new Error(`Unknown one-shot role ${JSON.stringify(spec.role)}`);
    const caps = spec.caps ?? [];
    for (const c of caps) if (!EXTRA_CAPS.includes(c)) throw new Error(`Capability ${JSON.stringify(c)} is not one a one-shot container may have`);
    if (spec.egress) {
      if (spec.network !== undefined) throw new Error("A one-shot with egress makes its own network; it must not be given one");
      return this.runBehindProxy(spec, spec.egress);
    }
    if (spec.network === undefined) throw new Error("A one-shot without egress needs a network");
    // The trial is how the runtime is checked, so it must not check itself.
    if (spec.role !== "runtime-check") await this.assertRuntime();
    return this.runCreated(spec, spec.network, []);
  }

  /**
   * Create, start attached and remove by id one owned container on `network`. `extra` are flags added after the
   * network (the proxy variables of a one-shot behind a proxy; none otherwise). `state.started` is set just before
   * the start, so that a caller can tell a run that failed from a create that did.
   */
  private async runCreated(spec: OneShotSpec, network: string, extra: string[], state?: { started: boolean }): Promise<RunResult> {
    const caps = spec.caps ?? [];
    const name =`${this.cfg.docker.namePrefix}${this.installationId}-${spec.role}-${randomBytes(4).toString("hex")}`;
    const created = await this.docker(
      [
        "create", "--rm",
        "--name", name,
        "--label", "mcp-everything=1",
        "--label", `${OWNER_LABEL}=${this.installationId}`,
        "--label", `${ROLE_LABEL}=${spec.role}`,
        ...this.limits(),
        ...caps.flatMap((c) => ["--cap-add", c]),
        "--network", network,
        ...extra,
        ...(spec.mounts ?? []).flatMap((m) => ["-v", m]),
        ...(spec.mountFlags ?? []).flatMap((m) => ["--mount", m]),
        ...(spec.envFile !== undefined ? ["--env-file", spec.envFile] : []),
        ...(spec.workdir !== undefined ? ["-w", spec.workdir] : []),
        ...(spec.entrypoint !== undefined ? ["--entrypoint", spec.entrypoint] : []),
        spec.image,
        ...spec.args,
      ],
      { timeoutMs: 60_000 },
    );
    if (created.timedOut) {
      // The daemon may have made the container under this call's own random name. Remove it by that name.
      // Residual risk: it may still be created after this; leg 6's startup sweep removes it.
      // `-v` takes its anonymous volumes with it (the probe image declares one); it never removes a named volume.
      await this.docker(["rm", "-f", "-v", name], { timeoutMs: 30_000 }).catch(() => undefined);
      throw new Error(`Could not create the ${spec.role} container: docker create timed out`);
    }
    const id = created.stdout.trim();
    if (created.code !== 0) {
      const refusal = this.runtimeRefusal(created.stderr);
      if (refusal) throw refusal;
    }
    if (created.code !== 0) throw new Error(`Could not create the ${spec.role} container: ${created.stderr.trim().split("\n").slice(-3).join("\n") || "docker create failed"}`);
    if (!FULL_ID.test(id)) throw new Error(`Could not create the ${spec.role} container: Docker printed no usable id: ${oneLine(id, 80) || "(nothing)"}`);
    try {
      if (state) state.started = true;
      return await this.docker(["start", "-a", id], { timeoutMs: spec.timeoutMs, maxBytes: spec.maxBytes });
    } finally {
      try {
        // "No such container" is success (--rm may have removed it). Any other failure is ignored: it must
        // never mask the command's outcome, and leg 6's startup sweep removes what is left.
        await this.docker(["rm", "-f", "-v", id], { timeoutMs: 60_000 });
      } catch {
        /* as above */
      }
    }
  }

  /** Remove a network of this call's own by id or random name; every failure is ignored (the sweep removes what is left). */
  private async dropNetwork(target: string): Promise<void> {
    try {
      await this.docker(["network", "rm", target], { timeoutMs: 60_000 });
    } catch {
      /* never masks the outcome */
    }
  }

  /** The same for a container of this call's own. */
  private async dropContainer(target: string): Promise<void> {
    try {
      await this.docker(["rm", "-f", "-v", target], { timeoutMs: 60_000 });
    } catch {
      /* never masks the outcome */
    }
  }

  /**
   * Make a network that has no way out and check that Docker made it so: internal, no IPv6, one IPv4 subnet and no
   * gateway (DD3), and labelled as this installation's. Its name is `<prefix><id>-<role>-<hex>` unless the caller
   * gives one (a project's, leg 6). It returns the checked network, or removes what it made and throws. There is
   * never a fallback to `bridge`: a Docker that cannot make this network cannot contain anything.
   * Acts only on the network it created, so it is not in the guarded table.
   */
  async createContainedNetwork(opts: { role: string; name?: string; project?: string; sandbox?: string }): Promise<ContainedNetwork> {
    return (await this.createNetwork(opts)).net;
  }

  /**
   * Judge an inspect of a network against what is expected of a contained one: whose it is (owner, role, and the
   * project and sandbox when given), then internal, no IPv6, exactly one IPv4 subnet and no gateway (DD3). Used for
   * a network just made and for one found by name (adoption). Pure: it asks Docker nothing and changes nothing.
   */
  private checkContainedNetwork(res: RunResult, expect: { id?: string; role: string; project?: string; sandbox?: string }): NetworkCheck {
    if (res.code !== 0 || res.timedOut || res.truncated) return { kind: "unreadable" };
    let v: { id?: unknown; internal?: unknown; ipv6?: unknown; ipam?: unknown; labels?: unknown } | null;
    try {
      v = JSON.parse(res.stdout.trim()) as typeof v;
      if (v === null || typeof v !== "object") throw new Error("not an object");
    } catch {
      return { kind: "unreadable" };
    }
    if (typeof v.id !== "string") return { kind: "unreadable" };
    if (expect.id !== undefined && v.id !== expect.id) return { kind: "uncontained", problem: "Docker answered about another network" };
    const labels =
      v.labels !== null && typeof v.labels === "object" && !Array.isArray(v.labels) ? (v.labels as Record<string, unknown>) : null;
    const foreign = (problem: string): NetworkCheck => ({ kind: "foreign", problem, labels });
    if (labels === null || labels[OWNER_LABEL] !== this.installationId) return foreign("it does not carry this installation's owner label");
    if (labels[ROLE_LABEL] !== expect.role) return foreign(`it does not have the role ${expect.role}`);
    if (expect.project !== undefined && labels[PROJECT_LABEL] !== expect.project) return foreign("it does not carry this project's label");
    if (expect.sandbox !== undefined && labels[SANDBOX_LABEL] !== expect.sandbox) return foreign("it does not carry this sandbox's label");
    const ipam = Array.isArray(v.ipam) ? (v.ipam as Array<Record<string, unknown> | null>) : null;
    const v4 = (ipam ?? []).filter((e) => e !== null && typeof e === "object" && typeof e.Subnet === "string" && /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(e.Subnet));
    if (v.internal !== true) return { kind: "uncontained", problem: "it is not internal" };
    if (v.ipv6 !== false) return { kind: "uncontained", problem: "IPv6 is on" };
    if (ipam === null || v4.length !== 1) return { kind: "uncontained", problem: "it does not have exactly one IPv4 subnet" };
    if (ipam.some((e) => e !== null && typeof e === "object" && Object.hasOwn(e, "Gateway") && e.Gateway !== "" && e.Gateway !== null && e.Gateway !== undefined)) {
      return { kind: "uncontained", problem: "it has a gateway" };
    }
    return { kind: "ok", id: v.id, subnet: v4[0]!.Subnet as string };
  }

  /** The network of a name, judged by `checkContainedNetwork`: undefined when it is not there; a refusal when it is someone else's. Never changes anything. */
  private async findContainedNetwork(
    name: string,
    expect: { role: string; project?: string; sandbox?: string },
  ): Promise<ContainedNetwork | undefined> {
    const res = await this.ask(networkInspectArgs(name), 30_000);
    if (this.isNetworkNotThere(res)) return undefined;
    const check = this.checkContainedNetwork(res, expect);
    switch (check.kind) {
      case "ok":
        return { id: check.id, name, subnet: check.subnet };
      case "unreadable":
        throw this.unreadable(`the network ${clean(name)}`, res.code !== 0 || res.timedOut || res.truncated ? res : { ...res, code: 0 });
      case "foreign":
        throw foreignNetworkRefusal(name, check.labels, this.installationId);
      default:
        throw new ContainmentUnavailableError(
          `The network ${clean(name)} is not contained (${check.problem}); it was left as it is. Containment needs ${ISOLATED_BRIDGE_NEEDS}.`,
        );
    }
  }

  /** The error for a `network create` that failed: pools used up have their own advice. */
  private networkCreateFailure(created: RunResult): ContainmentUnavailableError {
    const line = created.stderr.split("\n").map((l) => l.trim()).filter((l) => l !== "").at(-1) ?? "";
    if (POOLS_EXHAUSTED.test(created.stderr)) {
      return new ContainmentUnavailableError(
        "Could not create the contained network: all of Docker's predefined address pools are used up. " +
          "Remove unused networks or give Docker more room with default-address-pools in its daemon configuration.",
      );
    }
    return new ContainmentUnavailableError(`Could not create the contained network: ${oneLine(line, 200) || "docker network create failed"}`);
  }

  /**
   * The subnet the daemon would give a new contained network: a throwaway network made without `--subnet` (labelled as a
   * one-shot network, so the sweep removes one that is leaked), read and removed at once. Throws like a network create
   * does, and when the subnet is too small to hold the proxy's address.
   */
  private async probeSubnet(): Promise<string> {
    const name = `${this.cfg.docker.namePrefix}${this.installationId}-${ONESHOT_NET_ROLE}-${randomBytes(4).toString("hex")}`;
    const made = await this.docker(
      [
        "network", "create", "--internal",
        "-o", "com.docker.network.bridge.gateway_mode_ipv4=isolated",
        "--ipv6=false",
        "--label", `${OWNER_LABEL}=${this.installationId}`,
        "--label", `${ROLE_LABEL}=${ONESHOT_NET_ROLE}`,
        name,
      ],
      { timeoutMs: 60_000 },
    );
    if (made.timedOut) {
      await this.dropNetwork(name);
      throw new DockerUnavailableError("Could not create the contained network: docker network create timed out");
    }
    if (made.code !== 0) throw this.networkCreateFailure(made);
    const id = made.stdout.trim();
    if (!FULL_ID.test(id)) {
      await this.dropNetwork(name);
      throw new DockerUnavailableError(`Could not create the contained network: Docker printed no usable id: ${oneLine(id, 80) || "(nothing)"}`);
    }
    let res: RunResult;
    try {
      res = await this.ask(networkInspectArgs(id), 30_000);
    } catch (e) {
      await this.dropNetwork(id);
      throw e;
    }
    await this.dropNetwork(id);
    const check = this.checkContainedNetwork(res, { id, role: ONESHOT_NET_ROLE });
    if (check.kind !== "ok") {
      if (check.kind === "unreadable") throw this.unreadable("the probe network", res.code !== 0 || res.timedOut || res.truncated ? res : { ...res, code: 0 });
      throw new ContainmentUnavailableError(
        `Docker made a network that is not contained (${check.kind === "foreign" ? "it is not labelled as asked" : check.problem}); containment needs ${ISOLATED_BRIDGE_NEEDS}. The network was removed.`,
      );
    }
    try {
      proxyAddress(check.subnet);
    } catch {
      throw new ContainmentUnavailableError(`Docker's address pools give subnets too small to hold the proxy (${oneLine(check.subnet, 40)}); give Docker larger pools with default-address-pools.`);
    }
    return check.subnet;
  }

  /**
   * Make the network, or (for a name the caller fixed) adopt the one that is there when a create failed or timed out
   * and the network is ours and passes the check. With a fixed name nothing is ever removed by name: that could
   * remove a racing creator's network. A network of a random name that failed its check is removed by its id.
   */
  private async createNetwork(opts: { role: string; name?: string; project?: string; sandbox?: string }): Promise<{ net: ContainedNetwork; created: boolean }> {
    const fixed = opts.name !== undefined;
    const name = opts.name ?? `${this.cfg.docker.namePrefix}${this.installationId}-${opts.role}-${randomBytes(4).toString("hex")}`;
    const expect = { role: opts.role, project: opts.project, sandbox: opts.sandbox };
    // Probe, then pin: the daemon's own pools choose a subnet (a throwaway network says which), and the real network is
    // made with that subnet and an `--ip-range` in its lower half, so that the proxy's address (the last usable host,
    // outside the range) is never handed out. Another network may take the subnet in between: then a fresh probe.
    let created: RunResult;
    for (let attempt = 0; ; attempt++) {
      const subnet = await this.probeSubnet();
      created = await this.docker(
        [
          "network", "create", "--internal",
          "-o", "com.docker.network.bridge.gateway_mode_ipv4=isolated",
          "--ipv6=false",
          "--subnet", subnet,
          "--ip-range", lowerHalf(subnet),
          "--label", `${OWNER_LABEL}=${this.installationId}`,
          "--label", `${ROLE_LABEL}=${opts.role}`,
          ...(opts.project !== undefined ? ["--label", `${PROJECT_LABEL}=${opts.project}`] : []),
          ...(opts.sandbox !== undefined ? ["--label", `${SANDBOX_LABEL}=${opts.sandbox}`] : []),
          name,
        ],
        { timeoutMs: 60_000 },
      );
      if (created.code !== 0 && !created.timedOut && POOL_OVERLAPS.test(created.stderr) && attempt < POOL_RETRIES) continue;
      break;
    }
    if (created.timedOut) {
      if (fixed) {
        const adopted = await this.findContainedNetwork(name, expect);
        if (adopted) return { net: adopted, created: false };
      } else {
        // The daemon may have made it under this call's own name. Residual risk: it is made after this; the sweep removes it.
        await this.dropNetwork(name);
      }
      throw new DockerUnavailableError("Could not create the contained network: docker network create timed out");
    }
    if (created.code !== 0) {
      if (fixed) {
        // "Already exists" is a lost race (or a leftover): the network may be ours, and then it is adopted.
        const adopted = await this.findContainedNetwork(name, expect);
        if (adopted) return { net: adopted, created: false };
      }
      throw this.networkCreateFailure(created);
    }
    const id = created.stdout.trim();
    if (!FULL_ID.test(id)) {
      if (!fixed) await this.dropNetwork(name);
      throw new DockerUnavailableError(`Could not create the contained network: Docker printed no usable id: ${oneLine(id, 80) || "(nothing)"}`);
    }
    let res: RunResult;
    try {
      res = await this.ask(networkInspectArgs(id), 30_000);
    } catch (e) {
      await this.dropNetwork(id);
      throw e;
    }
    const check = this.checkContainedNetwork(res, { ...expect, id });
    if (check.kind !== "ok") {
      // By id: this call made it, so the id is its own even under a fixed name.
      await this.dropNetwork(id);
      if (check.kind === "unreadable") throw this.unreadable(`the contained network ${clean(name)}`, res.code !== 0 || res.timedOut || res.truncated ? res : { ...res, code: 0 });
      throw new ContainmentUnavailableError(
        `Docker made a network that is not contained (${check.problem}); containment needs ${ISOLATED_BRIDGE_NEEDS}. The network was removed.`,
      );
    }
    return { net: { id, name, subnet: check.subnet }, created: true };
  }

  /**
   * A project's contained network: found by name (`<sandbox name>-net`), made when it is not there, adopted when it
   * is there and is this installation's, role `project-net`, this project's and this sandbox's and passes the check
   * (a lost creation race included). Someone else's is `SandboxRefusedError`; ours but not contained is
   * `ContainmentUnavailableError`. Acts only on what it creates or classifies itself by owner, role and name.
   */
  async ensureProjectNetwork(sandbox: string, project: string): Promise<ContainedNetwork & { created: boolean }> {
    const name = projectNetworkName(sandbox);
    const found = await this.findContainedNetwork(name, { role: PROJECT_NET_ROLE, project, sandbox });
    if (found) return { ...found, created: false };
    const made = await this.createNetwork({ role: PROJECT_NET_ROLE, name, project, sandbox });
    return { ...made.net, created: made.created };
  }

  /**
   * A project's network by name (`network inspect`, T14), judged as `ensureProjectNetwork` judges it, but never made:
   * undefined when it is not there. Someone else's is `SandboxRefusedError`. Read-only.
   */
  async findProjectNetwork(sandbox: string, project: string): Promise<ContainedNetwork | undefined> {
    return this.findContainedNetwork(projectNetworkName(sandbox), { role: PROJECT_NET_ROLE, project, sandbox });
  }

  /**
   * Whether a container, given by the full id `listProjectProxies` returned, is on the given network at the proxy's
   * address (`proxyAddress` of the subnet): the CONFIGURED address, `IPAMConfig.IPv4Address`, which is readable while the
   * container is stopped, not the one it is running with. One read-only inspect; it changes nothing. False when it is
   * gone or not so attached.
   */
  async projectProxyAttached(id: string, net: { id: string; name: string; subnet: string }): Promise<boolean> {
    if (!FULL_ID.test(id)) throw new Error("A proxy is named by its full id");
    const res = await this.ask(["inspect", "--type", "container", "--format", "{{json .NetworkSettings.Networks}}", id], 30_000);
    if (this.isNotThere(res)) return false;
    if (res.code !== 0 || res.timedOut || res.truncated) throw this.unreadable("the networks of a project proxy", res);
    let v: unknown;
    try {
      v = JSON.parse(res.stdout.trim());
    } catch {
      throw this.unreadable("the networks of a project proxy", { ...res, code: 0 });
    }
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const entry = (v as Record<string, { NetworkID?: unknown; IPAMConfig?: { IPv4Address?: unknown } | null } | null>)[net.name];
    if (entry === null || entry === undefined || typeof entry !== "object") return false;
    return entry.NetworkID === net.id && entry.IPAMConfig?.IPv4Address === proxyAddress(net.subnet);
  }

  /**
   * Take a project's proxy off the project network (replacement's first step: two containers cannot hold one address).
   * Classified first: this installation's, role `project-proxy`. `network disconnect -f` by network id; a proxy that is
   * gone, or not on the network, is success. The proxy keeps running on `bridge`; with no proxy on its network the
   * sandbox has no route, which fails closed.
   */
  async detachProjectProxy(id: string, net: { id: string }): Promise<void> {
    const p = await this.checkedProxy(id);
    if (!p) return;
    await this.disconnectForce(net.id, p.id, p.name);
  }

  /**
   * Put a project's proxy back at its address after a failed replacement: stop it, `network connect --ip <address>`, start it,
   * wait until it is ready, and check that it is attached at the address. Stopped first because connecting a running
   * container to a network is not reliable under every runtime. Classified like `detachProjectProxy`. Throws
   * `ProxyStartError` when any step fails (the caller then has no proxy: fail closed, repaired on the next use).
   */
  async restoreProjectProxy(id: string, net: ContainedNetwork): Promise<void> {
    const p = await this.checkedProxy(id);
    if (!p) throw new ProxyStartError("it no longer exists");
    const address = proxyAddress(net.subnet);
    const stopped = await this.docker(["stop", "-t", "2", p.id], { timeoutMs: 60_000 });
    if (stopped.code !== 0 && !this.isNotThere(stopped)) {
      throw new ProxyStartError(`it could not be stopped: ${stopped.timedOut ? "timed out" : oneLine(stopped.stderr.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "", 200) || "docker stop failed"}`);
    }
    const joined = await this.docker(["network", "connect", "--ip", address, net.id, p.id], { timeoutMs: 60_000 });
    if (joined.code !== 0 || joined.timedOut) {
      throw new ProxyStartError(`it could not be joined to the project network at ${address}: ${joined.timedOut ? "timed out" : oneLine(joined.stderr.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "", 200) || "docker network connect failed"}`);
    }
    await this.startAndAwait(p.id, true);
    if (!(await this.projectProxyAttached(p.id, net))) throw new ProxyStartError(`it is not attached at ${address}`);
  }

  /**
   * Write a sandbox's local-access names into its `/etc/hosts`: one line per name, `<address> <name>   # mcpe-local-access`,
   * replacing earlier marked lines (none when `names` is empty). A root `docker exec` of `LOCAL_ACCESS_SCRIPT`, idempotent,
   * and not through the hook. The container is classified first (this installation's, or from before); a name that is
   * not a plain lower-case host name, or is one of the sandbox's own (`localhost`, its hostname, its short id), is refused.
   * Throws when the write fails.
   */
  async writeLocalAccess(ref: { id: string; name: string }, address: string, names: string[]): Promise<void> {
    if (!FULL_ID.test(ref.id)) throw new Error("A sandbox is named by its full id");
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address) || address.split(".").some((o) => Number(o) > 255)) throw new Error(`Not an IPv4 address: ${oneLine(address, 40)}`);
    for (const n of names) {
      if (n.length > 253 || !HOSTS_NAME.test(n)) throw new Error(`The local-access name ${JSON.stringify(oneLine(n, 60))} is not a plain host name`);
      if (OWN_HOST_NAMES.has(n) || n === ref.id.slice(0, 12)) throw new Error(`The local-access name ${n} is one of the sandbox's own and cannot be pointed at the proxy`);
    }
    const c = await this.inspectContainer(ref.id, true);
    if (!c) return;
    this.refuseUnless([this.containerFacts(ref.name, c)]);
    const lines = [...new Set(names)].map((n) => `${address} ${n}   ${LOCAL_ACCESS_MARK}`).join("\n");
    const res = await this.docker(["exec", "-u", "0", c.id, "sh", "-c", LOCAL_ACCESS_SCRIPT, "sh", lines, "/etc/hosts"], { timeoutMs: 30_000, maxBytes: 16 * 1024 });
    if (res.code !== 0 || res.timedOut) {
      throw new Error(`Could not write the local-access names into ${clean(ref.name)}: ${res.timedOut ? "timed out" : oneLine(res.stderr, 200) || `exit code ${res.code}`}`);
    }
  }

  /**
   * Put the sandbox on a project network: `network disconnect -f` first (its failure is ignored: a stopped container
   * keeps the name of a network that was removed, and this clears it, T14), then `network connect`. The disconnect
   * names the network by its NAME, because the stale entry of a removed network is keyed by name (and a name that
   * is there again resolves to the network just made); the connect names it by id.
   */
  async attachProjectNetwork(sandbox: SandboxRef, net: { id: string; name: string }): Promise<void> {
    await this.docker(["network", "disconnect", "-f", net.name, sandbox.id], { timeoutMs: 60_000 }).catch(() => undefined);
    const res = await this.docker(["network", "connect", net.id, sandbox.id], { timeoutMs: 60_000 });
    if (res.code !== 0) throw new Error(`Failed to attach ${clean(sandbox.name)} to its project network: ${res.stderr.trim()}`);
  }

  /**
   * The upstream DNS servers, read once from a container on `bridge` (DD4): what a container there is given is what
   * the proxy should ask, wherever the host's own resolver is (a stub on the loopback is no use inside a container).
   * Cached per instance; a failure is not kept; concurrent callers share one read; `invalidateResolvers` clears it.
   */
  async readUpstreamResolvers(): Promise<string[]> {
    if (!this.upstreamResolvers) {
      const p: Promise<string[]> = this.readResolvers().catch((e: unknown) => {
        if (this.upstreamResolvers === p) this.upstreamResolvers = undefined;
        throw e;
      });
      this.upstreamResolvers = p;
    }
    return [...(await this.upstreamResolvers)];
  }

  /** Forget the resolvers, so that the next caller reads them again (the proxy counted resolver failures). */
  invalidateResolvers(): void {
    this.upstreamResolvers = undefined;
  }

  private async readResolvers(): Promise<string[]> {
    await this.ensureImage(this.cfg.docker.probeImage);
    const res = await this.runOnce({
      role: "resolv-read",
      image: this.cfg.docker.probeImage,
      network: "bridge",
      entrypoint: "cat",
      args: ["/etc/resolv.conf"],
      timeoutMs: 60_000,
      maxBytes: 64 * 1024,
    });
    if (res.timedOut || res.code !== 0) {
      throw new DockerUnavailableError(
        `Could not read the upstream DNS servers: ${res.timedOut ? "timed out" : oneLine(res.stderr.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "", 200) || `exit code ${res.code}`}`,
      );
    }
    const servers = parseResolvConf(res.stdout);
    if (servers.length === 0) throw new ContainmentUnavailableError("no usable upstream DNS server: a container on bridge is given only a loopback resolver or none");
    return servers;
  }

  /**
   * `GET /status` of a running proxy, asked through `docker exec` of a Node one-liner (the control endpoint is
   * on the proxy's own loopback). The one-liner sets its own socket timeout and calls `process.exit`, so a killed
   * CLI leaves no process behind. The parsed JSON, or undefined when it cannot be had or read. Never throws.
   * One place for the caps: readiness, the refusals read and leg 6 all come here.
   */
  private async proxyStatus(id: string, timeoutMs: number, maxBytes: number): Promise<unknown> {
    const script =
      `const h=require("http");const r=h.get({host:"127.0.0.1",port:${PROXY_CONTROL_PORT},path:"/status",timeout:2000},` +
      `(s)=>{let b="";s.setEncoding("utf8");s.on("data",(c)=>{b+=c});s.on("end",()=>{process.stdout.write(b);process.exit(s.statusCode===200?0:3)})});` +
      `r.on("timeout",()=>{r.destroy();process.exit(2)});r.on("error",()=>process.exit(1));setTimeout(()=>process.exit(4),2500)`;
    try {
      const res = await this.docker(["exec", id, "node", "-e", script], { timeoutMs, maxBytes });
      if (res.code !== 0 || res.timedOut || res.truncated) return undefined;
      return JSON.parse(res.stdout.trim()) as unknown;
    } catch {
      return undefined;
    }
  }

  /** What the proxy refused, for a failed run. Never throws. */
  private async readRefusals(id: string): Promise<ProxyReport> {
    try {
      const st = await this.proxyStatus(id, 3_000, 64 * 1024);
      return st === undefined ? { unavailable: true } : parseProxyReport(st);
    } catch {
      return { unavailable: true };
    }
  }

  /** The last line of a container's own log, cleaned; undefined when the log cannot be read or says nothing. */
  private async lastLogLine(id: string): Promise<string | undefined> {
    try {
      const res = await this.docker(["logs", "--tail", "20", id], { timeoutMs: 15_000, maxBytes: 64 * 1024 });
      if (res.code !== 0 || res.timedOut) return undefined;
      const line = `${res.stdout}\n${res.stderr}`.split("\n").map((l) => oneLine(l, 200)).filter((l) => l !== "").at(-1);
      return line;
    } catch {
      return undefined;
    }
  }

  /**
   * Create the proxy on `bridge`, join it to the contained network under its alias, start it and wait until it
   * says it is ready. `held.proxy` names it (by its own name until the id is known) as soon as anything could
   * exist, so that the caller's teardown finds it whatever fails here.
   */
  private async startProxy(
    contained: ContainedNetwork,
    resolvers: string[],
    egress: { allow: HostEntry[]; local?: boolean },
    held: { proxy?: string },
  ): Promise<string> {
    const name = `${this.cfg.docker.namePrefix}${this.installationId}-oneshot-proxy-${randomBytes(4).toString("hex")}`;
    held.proxy = name;
    const created = await this.docker(
      [
        "create",
        "--name", name,
        "--label", "mcp-everything=1",
        "--label", `${OWNER_LABEL}=${this.installationId}`,
        "--label", `${ROLE_LABEL}=oneshot-proxy`,
        ...this.limits(),
        "--user", "node",
        "--read-only",
        "--tmpfs", "/tmp:size=8m",
        "--network", "bridge",
        "--entrypoint", "node",
        this.cfg.docker.proxyImage,
        ...proxyLaunchArgs(
          proxyConfig({ allow: egress.allow, local: egress.local, listenCidr: contained.subnet, resolvers, limits: { bindWaitMs: 3_000 } }),
        ),
      ],
      { timeoutMs: 60_000 },
    );
    if (created.timedOut) throw new ProxyStartError("docker create timed out");
    if (created.code !== 0) {
      const refusal = this.runtimeRefusal(created.stderr);
      if (refusal) throw refusal;
      throw new ProxyStartError(oneLine(created.stderr.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "", 200) || "docker create failed");
    }
    const id = created.stdout.trim();
    if (!FULL_ID.test(id)) throw new ProxyStartError(`Docker printed no usable id: ${oneLine(id, 80) || "(nothing)"}`);
    held.proxy = id;
    // The address must be given before the proxy starts, or the proxy would start with one network and miss the other.
    // There is never a fallback to a name: a name needs Docker's embedded DNS.
    const address = proxyAddress(contained.subnet);
    const joined = await this.docker(["network", "connect", "--ip", address, contained.id, id], { timeoutMs: 60_000 });
    if (joined.code !== 0 || joined.timedOut) {
      throw new ProxyStartError(`it could not be joined to the contained network at ${address}: ${joined.timedOut ? "timed out" : oneLine(joined.stderr.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "", 200) || "docker network connect failed"}`);
    }
    const started = await this.docker(["start", id], { timeoutMs: 60_000 });
    if (started.code !== 0 || started.timedOut) {
      const refusal = started.timedOut ? undefined : this.runtimeRefusal(started.stderr);
      if (refusal) throw refusal;
      throw new ProxyStartError(started.timedOut ? "docker start timed out" : oneLine(started.stderr.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "", 200) || "docker start failed");
    }
    await this.awaitProxyReady(id);
    return id;
  }

  /**
   * Wait for the proxy's `/status` to say `ready` at this program's version, within the budget; a proxy that exited
   * fails at once. `anyVersion` (a proxy this session did not make, started by leg 7) accepts any version string.
   */
  private async awaitProxyReady(id: string, anyVersion = false): Promise<void> {
    const { budgetMs, pollMs } = this.proxyReadiness;
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const res = await this.ask(["inspect", "--type", "container", "--format", '{"running":{{json .State.Running}},"exitCode":{{json .State.ExitCode}}}', id], 30_000);
      let state: { running?: unknown; exitCode?: unknown } | undefined;
      try {
        state = res.code === 0 && !res.timedOut && !res.truncated ? (JSON.parse(res.stdout.trim()) as typeof state) : undefined;
      } catch {
        state = undefined;
      }
      if (!state || typeof state.running !== "boolean") throw this.unreadable(`the proxy ${clean(id)}`, res.code !== 0 ? res : { ...res, code: 0 });
      if (!state.running) {
        throw new ProxyStartError((await this.lastLogLine(id)) ?? `exited with code ${typeof state.exitCode === "number" ? state.exitCode : "unknown"}`);
      }
      const st = (await this.proxyStatus(id, 3_000, 64 * 1024)) as { ready?: unknown; version?: unknown } | undefined;
      if (st && typeof st === "object" && st.ready === true && (anyVersion ? typeof st.version === "string" : st.version === PROXY_PROGRAM_VERSION)) return;
      if (Date.now() >= deadline) {
        throw new ProxyStartError((await this.lastLogLine(id)) ?? `it was not ready within ${budgetMs / 1000} s`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /**
   * Run a one-shot behind its own proxy (DD2), in this order: the runtime check; the images (every pull before any
   * object exists); the upstream resolvers; a contained network; the proxy (created, joined, started, ready); the
   * one-shot on the network, with the proxy variables. Whatever happens it is torn down in the order one-shot, proxy,
   * network, each removal tolerant and none masking the outcome. A failed run (non-zero, timed out or thrown) has the
   * proxy's refusals read first, before the proxy goes.
   */
  private async runBehindProxy(spec: OneShotSpec, egress: { allow: HostEntry[]; local?: boolean }): Promise<OneShotResult> {
    await this.assertRuntime();
    await this.ensureImage(this.cfg.docker.proxyImage);
    await this.ensureImage(spec.image);
    const resolvers = await this.readUpstreamResolvers();
    const contained = await this.createContainedNetwork({ role: ONESHOT_NET_ROLE });
    const held: { proxy?: string } = {};
    try {
      const proxyId = await this.startProxy(contained, resolvers, egress, held);
      const url = `http://${proxyAddress(contained.subnet)}:${PROXY_PORT}`;
      const env = [
        "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
      ].flatMap((k) => ["-e", `${k}=${url}`]);
      env.push("-e", "NO_PROXY=", "-e", "NODE_USE_ENV_PROXY=1");
      const state = { started: false };
      let res: RunResult;
      try {
        res = await this.runCreated(spec, contained.name, env, state);
      } catch (e) {
        // A throw from the run itself (not from its create) still has refusals to read. They cannot be returned, so they ride on the error.
        if (state.started) {
          const report = await this.readRefusals(proxyId);
          if (e instanceof Error) (e as Error & { proxy?: ProxyReport }).proxy = report;
        }
        throw e;
      }
      if (res.code !== 0 || res.timedOut) return { ...res, proxy: await this.readRefusals(proxyId) };
      return res;
    } finally {
      if (held.proxy !== undefined) await this.dropContainer(held.proxy);
      await this.dropNetwork(contained.id);
    }
  }

  /**
   * A project's proxy: created on `bridge` (the way out), joined to the project network at `proxyAddress` of its subnet
   * (no alias: a sandbox reaches the proxy by that address, and a local service by a name its `/etc/hosts` gives that
   * address, DD10), then started and waited for until it reports this program's version. Hardened as the one-shot's proxy,
   * plus `--add-host host.docker.internal:host-gateway` so that a forward to the host has an address. No `--rm`, no
   * restart policy. `labels` are the caller's configuration labels (leg 7); they may not name any label this
   * layer sets. The project network must exist and be this project's (never created here). On any failure it
   * removes what it made, by the name it chose or the id it was given, and throws `ProxyStartError` (or the
   * runtime's own error). Acts only on what it creates.
   */
  async createProjectProxy(
    sandbox: string,
    project: string,
    config: ProxyConfig,
    labels: Record<string, string>,
    opts: { name?: string } = {},
  ): Promise<{ id: string; name: string }> {
    // A caller that must be able to remove the proxy by name even when this call is abandoned (containment's
    // deadline) gives the name beforehand; it has to be the name this method would have chosen.
    if (opts.name !== undefined && !new RegExp(`^${sandbox.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-proxy-[0-9a-f]{8}$`).test(opts.name)) {
      throw new Error(`A project proxy of ${clean(sandbox)} is named <sandbox>-proxy-<8 hex>`);
    }
    for (const [k, v] of Object.entries(labels)) {
      if (RESERVED_LABELS.has(k) || !/^mcp-everything\.[a-z][a-z0-9.-]{0,60}$/.test(k)) throw new Error(`A proxy label may not be named ${JSON.stringify(k.slice(0, 60))}`);
      if (typeof v !== "string" || /[\r\n\u0000]/.test(v)) throw new Error(`The proxy label ${k} must be a string without line breaks`);
    }
    await this.assertRuntime();
    await this.ensureImage(this.cfg.docker.proxyImage);
    const net = await this.findContainedNetwork(projectNetworkName(sandbox), { role: PROJECT_NET_ROLE, project, sandbox });
    if (!net) throw new ProxyStartError(`the project network ${clean(projectNetworkName(sandbox))} does not exist`);
    const name = opts.name ?? newProjectProxyName(sandbox);
    let held = name;
    try {
      const created = await this.docker(
        [
          "create",
          "--name", name,
          "--label", "mcp-everything=1",
          "--label", `${OWNER_LABEL}=${this.installationId}`,
          "--label", `${ROLE_LABEL}=${PROJECT_PROXY_ROLE}`,
          "--label", `${PROJECT_LABEL}=${project}`,
          "--label", `${SANDBOX_LABEL}=${sandbox}`,
          ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
          ...this.limits(),
          "--user", "node",
          "--read-only",
          "--tmpfs", "/tmp:size=8m",
          "--network", "bridge",
          "--add-host", "host.docker.internal:host-gateway",
          "--entrypoint", "node",
          this.cfg.docker.proxyImage,
          ...proxyLaunchArgs(config),
        ],
        { timeoutMs: 60_000 },
      );
      if (created.timedOut) throw new ProxyStartError("docker create timed out");
      if (created.code !== 0) {
        const refusal = this.runtimeRefusal(created.stderr);
        if (refusal) throw refusal;
        throw new ProxyStartError(oneLine(created.stderr.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "", 200) || "docker create failed");
      }
      const id = created.stdout.trim();
      if (!FULL_ID.test(id)) throw new ProxyStartError(`Docker printed no usable id: ${oneLine(id, 80) || "(nothing)"}`);
      held = id;
      // The address is given before the proxy starts, or it would start with one network and miss the other.
      const address = proxyAddress(net.subnet);
      const joined = await this.docker(["network", "connect", "--ip", address, net.id, id], { timeoutMs: 60_000 });
      if (joined.code !== 0 || joined.timedOut) {
        throw new ProxyStartError(`it could not be joined to the project network at ${address}: ${joined.timedOut ? "timed out" : oneLine(joined.stderr.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "", 200) || "docker network connect failed"}`);
      }
      await this.startAndAwait(id, false);
      return { id, name };
    } catch (e) {
      await this.dropContainer(held);
      throw e;
    }
  }

  /** `docker start`, then readiness: the one place both the one-shot's proxy and a project's wait for a proxy that was started. */
  private async startAndAwait(id: string, anyVersion: boolean): Promise<void> {
    const started = await this.docker(["start", id], { timeoutMs: 60_000 });
    if (started.code !== 0 || started.timedOut) {
      const refusal = started.timedOut ? undefined : this.runtimeRefusal(started.stderr);
      if (refusal) throw refusal;
      throw new ProxyStartError(started.timedOut ? "docker start timed out" : oneLine(started.stderr.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "", 200) || "docker start failed");
    }
    await this.awaitProxyReady(id, anyVersion);
  }

  /**
   * Start a project's proxy that already exists (a stopped one) and wait until it is ready. Any version string is
   * accepted, so that an older session can start a newer proxy it keeps (leg 7). The proxy is classified first:
   * this installation's and role `project-proxy`, else a refusal.
   */
  async startProjectProxy(id: string): Promise<void> {
    const p = await this.checkedProxy(id);
    if (!p) throw new ProxyStartError("it no longer exists");
    await this.startAndAwait(p.id, true);
  }

  /** `GET /status` of a project's proxy, or undefined when it cannot be had. A public wrapper of the one status read. Never throws. */
  async projectProxyStatus(id: string): Promise<unknown> {
    if (!FULL_ID.test(id)) return undefined;
    return this.proxyStatus(id, 3_000, 64 * 1024);
  }

  /**
   * What a project's proxies refused, as rows: it lists the sandbox's proxies, reads each one's status (`projectProxyStatus`)
   * and parses it with the same parser a one-shot's report goes through. Never throws; a proxy that cannot be read, or
   * that is not there, gives no rows. The install reads this once, right after the build and before the network changes.
   */
  async projectRefusals(sandbox: string): Promise<ProxyRefusalRow[]> {
    try {
      const rows: ProxyRefusalRow[] = [];
      for (const p of (await this.listProjectProxies(sandbox)).slice(0, 4)) {
        const report = parseProxyReport(await this.projectProxyStatus(p.id));
        if ("rows" in report) rows.push(...report.rows);
      }
      return rows;
    } catch {
      return [];
    }
  }

  /** A proxy by id, classified: its facts, null when gone, a refusal unless it is this installation's with the role `project-proxy`. */
  private async checkedProxy(id: string): Promise<ProjectProxy | null> {
    if (!FULL_ID.test(id)) throw new Error("A proxy is named by its full id");
    const c = await this.inspectContainer(id, true);
    if (!c) return null;
    const cls = classifySandbox(c.labels, this.installationId);
    if (cls !== "mine" || c.labels?.[ROLE_LABEL] !== PROJECT_PROXY_ROLE) {
      throw new SandboxRefusedError(
        [{ kind: "proxy", sandbox: c.name ?? id, cls: cls === "another" ? "another" : "not-ours", owner: c.labels?.[OWNER_LABEL], project: c.labels?.[PROJECT_LABEL] }],
        this.installationId,
      );
    }
    return { id: c.id, name: c.name ?? id, running: c.running, labels: c.labels ?? {} };
  }

  /**
   * The project proxies of a sandbox: containers with this installation's owner label and the role `project-proxy`
   * (label filters), kept only when the inspect says their name is `<sandbox>-proxy-<8 hex>` and they carry the
   * sandbox's name and a project label. Needs no container and no label from it, so it works after the container
   * is gone, and a twin sandbox with the same repository is never listed. Throws when Docker cannot be asked.
   */
  async listProjectProxies(sandbox: string): Promise<ProjectProxy[]> {
    const res = await this.ask(
      ["ps", "-a", "-q", "--no-trunc", "--filter", `label=${OWNER_LABEL}=${this.installationId}`, "--filter", `label=${ROLE_LABEL}=${PROJECT_PROXY_ROLE}`],
      60_000,
    );
    if (res.code !== 0 || res.timedOut || res.truncated) throw this.unreadable("the project proxies", res);
    const ids = res.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    const wanted = new RegExp(`^${sandbox.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-proxy-[0-9a-f]{8}$`);
    const found: ProjectProxy[] = [];
    for (const id of ids) {
      if (!FULL_ID.test(id)) throw this.unreadable("the project proxies", { ...res, code: 0, stdout: "" });
      const c = await this.inspectContainer(id, true);
      if (!c || c.name === undefined || !wanted.test(c.name) || c.labels === null) continue;
      if (c.labels[OWNER_LABEL] !== this.installationId || c.labels[ROLE_LABEL] !== PROJECT_PROXY_ROLE) continue;
      if (c.labels[SANDBOX_LABEL] !== sandbox || !Object.hasOwn(c.labels, PROJECT_LABEL)) continue;
      found.push({ id: c.id, name: c.name, running: c.running, labels: c.labels });
    }
    return found;
  }

  /**
   * This installation's sandboxes (leg 10): containers with this installation's owner label and a project label (label
   * filters), each inspected, dropping any that carries a role (a proxy, a one-shot) or whose owner is not this installation's
   * (the inspect is judged again, not the filter alone). A sandbox from before ownership has no project label and is not
   * listed. Reads only; throws when Docker cannot be asked.
   */
  async listOwnSandboxes(): Promise<SandboxInspectFacts[]> {
    const res = await this.ask(
      ["ps", "-a", "-q", "--no-trunc", "--filter", `label=${OWNER_LABEL}=${this.installationId}`, "--filter", `label=${PROJECT_LABEL}`],
      60_000,
    );
    if (res.code !== 0 || res.timedOut || res.truncated) throw this.unreadable("this installation's sandboxes", res);
    const ids = res.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    const found: SandboxInspectFacts[] = [];
    for (const id of ids) {
      if (!FULL_ID.test(id)) throw this.unreadable("this installation's sandboxes", { ...res, code: 0, stdout: "" });
      const c = await this.inspectContainer(id, true);
      if (!c || c.name === undefined || c.labels === null) continue;
      if (c.labels[OWNER_LABEL] !== this.installationId || Object.hasOwn(c.labels, ROLE_LABEL)) continue;
      if (!Object.hasOwn(c.labels, PROJECT_LABEL) || c.labels[PROJECT_LABEL] === "") continue;
      found.push({ id: c.id, name: c.name, running: c.running, labels: c.labels, networks: [...c.networks], ...(c.networkIds ? { networkIds: { ...c.networkIds } } : {}), runtime: c.runtime });
    }
    return found;
  }

  /** Remove a project proxy and its anonymous volumes, by id, after it is classified as this installation's. Gone is success. */
  async removeProjectProxy(id: string): Promise<void> {
    const p = await this.checkedProxy(id);
    if (p) await this.rmProxy(p.id, p.name);
  }

  /**
   * Remove one project proxy by the name its creator chose (`<sandbox>-proxy-<8 hex>`), for the creator whose call
   * was abandoned and never learned the id. It resolves the name, requires the sandbox's label on it, and then
   * removes it exactly as `removeProjectProxy` does (classified by owner and role). Gone is success.
   */
  async removeProjectProxyNamed(sandbox: string, name: string): Promise<void> {
    if (!new RegExp(`^${sandbox.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-proxy-[0-9a-f]{8}$`).test(name)) {
      throw new Error(`A project proxy of ${clean(sandbox)} is named <sandbox>-proxy-<8 hex>`);
    }
    const c = await this.inspectContainer(name, true);
    if (!c) return;
    if (c.labels?.[SANDBOX_LABEL] !== sandbox) {
      throw new SandboxRefusedError([{ kind: "proxy", sandbox: name, cls: "not-ours", owner: c.labels?.[OWNER_LABEL], project: c.labels?.[PROJECT_LABEL] }], this.installationId);
    }
    await this.removeProjectProxy(c.id);
  }

  private async rmProxy(id: string, name: string): Promise<void> {
    const rm = await this.docker(["rm", "-f", "-v", id], { timeoutMs: 120_000 });
    if (rm.code !== 0 && !this.isNotThere(rm)) throw new Error(`Failed to remove proxy ${clean(name)}: ${rm.stderr.trim()}`);
  }

  /** Remove a project network by id, after it is classified as this installation's with the role `project-net`. Gone is success. */
  async removeProjectNetwork(net: string | { id: string }): Promise<void> {
    const id = typeof net === "string" ? net : net.id;
    if (!FULL_ID.test(id)) throw new Error("A network is named by its full id");
    const res = await this.ask(networkInspectArgs(id), 30_000);
    if (this.isNetworkNotThere(res)) return;
    const found = this.networkLabels(id, res);
    if (found.labels?.[OWNER_LABEL] !== this.installationId || found.labels[ROLE_LABEL] !== PROJECT_NET_ROLE) {
      throw foreignNetworkRefusal(found.name, found.labels, this.installationId);
    }
    await this.rmNetwork(id, found.name);
  }

  private async rmNetwork(id: string, name: string): Promise<void> {
    const rm = await this.docker(["network", "rm", id], { timeoutMs: 60_000 });
    if (rm.code !== 0 && !this.isNetworkNotThere(rm)) throw new Error(`Failed to remove network ${clean(name)}: ${rm.stderr.trim()}`);
  }

  /** The name and labels from a network inspect; throws when the answer cannot be read. */
  private networkLabels(target: string, res: RunResult): { name: string; labels: Record<string, string> | null } {
    type Inspect = { id?: unknown; name?: unknown; labels?: unknown };
    const parse = (): Inspect | null => {
      if (res.code !== 0 || res.timedOut || res.truncated) return null;
      try {
        return JSON.parse(res.stdout.trim()) as Inspect | null;
      } catch {
        return null;
      }
    };
    const v = parse();
    const l = v?.labels;
    const labelsOk = l === null || (typeof l === "object" && !Array.isArray(l) && Object.values(l as object).every((x) => typeof x === "string"));
    if (!v || typeof v !== "object" || typeof v.id !== "string" || !labelsOk) {
      throw this.unreadable(`the network ${clean(target)}`, res.code !== 0 || res.timedOut || res.truncated ? res : { ...res, code: 0 });
    }
    return { name: typeof v.name === "string" && v.name !== "" ? v.name : target, labels: (l as Record<string, string> | null) ?? null };
  }

  /**
   * What goes with a sandbox: its project proxies and its `-net` (found by name), each classified. A `-net` that is
   * not this installation's, role `project-net`, is `another` or `not-ours`, so that the caller's refusal covers it.
   * Reads only; the caller removes in its own order.
   */
  private async projectObjects(sandbox: string): Promise<{ proxies: ProjectProxy[]; net?: { id: string; name: string }; facts: SandboxFacts[] }> {
    const proxies = await this.listProjectProxies(sandbox);
    const facts: SandboxFacts[] = proxies.map((p) => ({
      kind: "proxy",
      sandbox: p.name,
      cls: classifySandbox(p.labels, this.installationId),
      owner: p.labels[OWNER_LABEL],
      project: p.labels[PROJECT_LABEL],
    }));
    const name = projectNetworkName(sandbox);
    const res = await this.ask(networkInspectArgs(name), 30_000);
    if (this.isNetworkNotThere(res)) return { proxies, facts };
    const n = this.networkLabels(name, res);
    const id = (JSON.parse(res.stdout.trim()) as { id: string }).id;
    const mine = n.labels?.[OWNER_LABEL] === this.installationId && n.labels[ROLE_LABEL] === PROJECT_NET_ROLE;
    const cls = mine ? "mine" : classifySandbox(n.labels, this.installationId) === "another" ? "another" : "not-ours";
    facts.push({ kind: "network", sandbox: name, cls, owner: n.labels?.[OWNER_LABEL], project: n.labels?.[PROJECT_LABEL] });
    return { proxies, net: { id, name }, facts };
  }

  /** The name must be free: never build on a volume somebody else may own. */
  private async assertNameFree(volume: string): Promise<void> {
    const existing = await this.inspectVolume(volume);
    if (existing) {
      this.refuseUnless([this.volumeFacts(volume, existing.labels)]);
      throw new Error(`Volume ${clean(volume)} already exists`);
    }
  }

  /** `docker volume create` with the generic and owner labels, and the role when it has one. */
  private async makeVolume(volume: string, role?: "staging"): Promise<void> {
    const vol = await this.docker(
      [
        "volume", "create", "--label", "mcp-everything=1", "--label", `${OWNER_LABEL}=${this.installationId}`,
        ...(role ? ["--label", `${ROLE_LABEL}=${role}`] : []),
        volume,
      ],
      { timeoutMs: 30_000 },
    );
    if (vol.code !== 0) throw new Error(`Failed to create volume: ${vol.stderr.trim()}`);
  }

  /**
   * An empty volume for a sandbox, labelled as `probe` labels a sandbox volume (generic and owner labels, no
   * role). It refuses when the name exists, by the rule `probe` applies: another's or not ours is a refusal, an
   * existing one of this installation is a plain error.
   */
  async createSandboxVolume(volume: string): Promise<void> {
    await this.assertNameFree(volume);
    await this.makeVolume(volume);
  }

  /**
   * A fresh name for a staging volume: `<prefix><installation id>-stg-<8 hex>`, the form no slug produces (a slug
   * is lowercase letters, digits and underscores, never a hyphen). Issues no Docker command; the volume is made by `probe` with the role `staging`.
   */
  stagingName(): string {
    return `${this.cfg.docker.namePrefix}${this.installationId}-stg-${randomBytes(4).toString("hex")}`;
  }

  /**
   * Remove a staging volume. Guarded like the others: a volume that is not there is success; another's or not
   * ours is a refusal; one of this installation's that is not a staging volume (no role, another role, or made
   * before ownership was recorded) is `VolumeNotUsableError` and is left alone. Nothing but a staging volume is
   * ever removed by this method.
   */
  async removeStagingVolume(volume: string): Promise<void> {
    const v = await this.inspectVolume(volume);
    if (!v) return;
    this.refuseUnless([this.volumeFacts(volume, v.labels)]);
    if (classifySandbox(v.labels, this.installationId) !== "mine" || v.labels?.[ROLE_LABEL] !== "staging") {
      throw new VolumeNotUsableError(`Volume ${clean(volume)} is not a staging volume of this installation; it was not removed`);
    }
    const rm = await this.docker(["volume", "rm", "-f", volume], { timeoutMs: 120_000 });
    if (rm.code !== 0) throw new Error(`Failed to remove volume ${clean(volume)}: ${rm.stderr.trim()}`);
  }

  /**
   * Inspect every volume first, then require each to exist, be this installation's (`mine`: a volume from before
   * ownership is never a staging volume or a copy's target) and carry the wanted role (`staging`) or none. Throws
   * before anything is created. A refusal names every volume it speaks of.
   */
  private async requireVolumes(wants: Array<{ name: string; role: "staging" | "none" }>): Promise<void> {
    const found: Array<Awaited<ReturnType<Docker["inspectVolume"]>>> = [];
    for (const w of wants) found.push(await this.inspectVolume(w.name));
    this.refuseUnless(wants.flatMap((w, i) => (found[i] ? [this.volumeFacts(w.name, found[i]!.labels)] : [])));
    wants.forEach((w, i) => {
      const v = found[i];
      if (!v) throw new VolumeNotUsableError(`Volume ${clean(w.name)} does not exist`);
      if (classifySandbox(v.labels, this.installationId) !== "mine") {
        throw new VolumeNotUsableError(`Volume ${clean(w.name)} was made before ownership was recorded; it cannot be used here`);
      }
      const role = v.labels?.[ROLE_LABEL];
      if (w.role === "staging" && role !== "staging") throw new VolumeNotUsableError(`Volume ${clean(w.name)} is not a staging volume`);
      if (w.role === "none" && role !== undefined) throw new VolumeNotUsableError(`Volume ${clean(w.name)} is not a sandbox volume (it has the role ${oneLine(role, LABEL_MAX)})`);
    });
  }

  /**
   * Run one operator scanner over a staging volume. The volume must be this installation's staging volume
   * (checked before any container exists). The image's own entrypoint runs with `spec.command` as its arguments (or `spec.entrypoint` replaces it; "" clears it), no
   * network unless the scanner is configured to have one, the checkout mounted read-only at /scan and the working
   * directory /scan/repo (a checkout with no `repo` directory makes `start` fail: the caller reports it as a failed run).
   */
  async runScanner(volume: string, spec: ScannerSpec, opts: { timeoutMs: number; envFile?: string }): Promise<OneShotResult> {
    await this.requireVolumes([{ name: volume, role: "staging" }]);
    // Under containment a scanner with a network reaches its own `hosts` and nothing else, local addresses included (DD12);
    // leg 1 refuses a networked scanner without `hosts` at startup.
    const egress =
      spec.network && this.cfg.network.mode === "contained"
        ? { allow: spec.hosts.map((h) => parseHostEntry(h, "scanner")), local: true }
        : undefined;
    return this.runOnce({
      role: "scan",
      image: spec.image,
      ...(egress ? { egress } : { network: spec.network ? "bridge" : "none" }),
      mountFlags: [`type=volume,src=${volume},dst=/scan,readonly`],
      workdir: "/scan/repo",
      envFile: opts.envFile,
      // Straight through: "" must reach `--entrypoint ""` (clears the image's entrypoint), so never `||`.
      entrypoint: spec.entrypoint,
      args: spec.command,
      timeoutMs: opts.timeoutMs,
      maxBytes: 8_000_000,
    });
  }

  /**
   * Copy a staging volume into a new sandbox volume, exactly (`cp -a`: owners, modes, links). `from` must be this
   * installation's staging volume and `to` its sandbox volume (no role); both are inspected before anything is
   * created. The container is the one place that has extra capabilities: it runs no repository code, has no
   * network and reads its source read-only, and without CHOWN, FOWNER, DAC_OVERRIDE and FSETID `cp -a` cannot
   * keep an owner other than root's or read a mode-000 directory. A failed copy leaves `to` partly written; the
   * caller removes it.
   */
  async copyVolume(from: string, to: string): Promise<void> {
    await this.requireVolumes([{ name: from, role: "staging" }, { name: to, role: "none" }]);
    await this.ensureImage(this.cfg.docker.probeImage);
    const res = await this.runOnce({
      role: "copy",
      image: this.cfg.docker.probeImage,
      network: "none",
      entrypoint: "cp",
      caps: ["CHOWN", "FOWNER", "DAC_OVERRIDE", "FSETID"],
      mounts: [`${from}:/from:ro`, `${to}:/to`],
      args: ["-a", "/from/.", "/to/"],
      timeoutMs: 300_000,
      maxBytes: 64_000,
    });
    if (res.timedOut) throw new Error("Could not copy the checkout: timed out after 300s");
    if (res.code !== 0) throw new Error(`Could not copy the checkout: ${oneLine(res.stderr.slice(-300), 300) || `exit code ${res.code}`}`);
  }

  /**
   * Remove what a check left behind that is this installation's and old: containers with a one-shot role (`clone`,
   * `scan`, `copy`, `runtime-check`, `resolv-read`, `oneshot-proxy`), volumes with the role `staging` and networks
   * with the role `oneshot-net`, in that order (a proxy goes before its network). It acts only on what it listed and
   * then re-verified by inspect (the owner label is this installation's id, the role is in the allowlist, the age is
   * known and over `maxAgeSec`), removing containers and networks by their full id. Anything that carries the
   * `mcp-everything.project` label at all, even empty, is never a candidate: it is a project's, whatever its role or
   * name (labels only decide). A thing that is gone meanwhile is skipped, and so is a network that still has
   * endpoints (not a failure: its holder goes first or is a live call's). It never throws: Docker failures are
   * counted, for the caller to log. Never anything without a role label or with another owner.
   *
   * `maxAgeSec` must exceed the longest a live check can hold these things, because another process of the same
   * installation may be mid-check: the clone (600 s), plus the pulls and the scan budget, plus the copy (300 s),
   * plus the staging volume's life through the rest of an install. Leg 7 computes it from the configuration.
   */
  async sweepCheckLeftovers(maxAgeSec: number): Promise<{ removed: string[]; failures: number }> {
    const removed: string[] = [];
    let failures = 0;
    const owned = `label=${OWNER_LABEL}=${this.installationId}`;
    const old = (created: unknown): boolean => {
      const t = typeof created === "string" ? Date.parse(created) : Number.NaN;
      if (Number.isNaN(t)) throw new Error("unreadable creation time");
      return Date.now() - t > maxAgeSec * 1000;
    };
    const listed = async (args: string[]): Promise<string[]> => {
      const res = await this.ask(args, 60_000);
      if (res.code !== 0 || res.timedOut || res.truncated) throw new Error("list failed");
      return res.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    };
    const read = async (args: string[]): Promise<{ labels: Record<string, unknown>; created: unknown; id?: unknown } | null> => {
      const res = await this.ask(args, 30_000);
      if (this.isNotThere(res)) return null;
      if (res.code !== 0 || res.timedOut || res.truncated) throw new Error("inspect failed");
      const v = JSON.parse(res.stdout.trim()) as { labels?: unknown; created?: unknown; id?: unknown } | null;
      if (!v || typeof v !== "object" || !v.labels || typeof v.labels !== "object" || Array.isArray(v.labels)) throw new Error("unreadable inspect");
      return { labels: v.labels as Record<string, unknown>, created: v.created, id: v.id };
    };
    const remove = async (args: string[], what: string): Promise<void> => {
      const res = await this.ask(args, 120_000);
      if (res.code === 0) removed.push(what);
      else if (!this.isNotThere(res)) throw new Error("remove failed");
    };

    let ids: string[] = [];
    try {
      ids = await listed(["ps", "-a", "--no-trunc", "--filter", owned, "--filter", `label=${ROLE_LABEL}`, "--format", "{{.ID}}"]);
    } catch {
      failures++;
    }
    for (const listedId of ids) {
      try {
        if (!FULL_ID.test(listedId)) throw new Error("not a full id");
        const c = await read(["inspect", "--type", "container", "--format", '{"id":{{json .Id}},"labels":{{json .Config.Labels}},"created":{{json .Created}}}', listedId]);
        if (!c) continue;
        if (c.id !== listedId) throw new Error("id mismatch");
        if (c.labels[OWNER_LABEL] !== this.installationId || !(ONE_SHOT_ROLES as readonly string[]).includes(String(c.labels[ROLE_LABEL]))) continue;
        if (Object.hasOwn(c.labels, PROJECT_LABEL)) continue;
        if (!old(c.created)) continue;
        await remove(["rm", "-f", listedId], listedId);
      } catch {
        failures++;
      }
    }

    let names: string[] = [];
    try {
      names = await listed(["volume", "ls", "--filter", owned, "--filter", `label=${ROLE_LABEL}=staging`, "--format", "{{.Name}}"]);
    } catch {
      failures++;
    }
    for (const name of names) {
      try {
        const v = await read(["volume", "inspect", "--format", '{"labels":{{json .Labels}},"created":{{json .CreatedAt}}}', name]);
        if (!v) continue;
        if (v.labels[OWNER_LABEL] !== this.installationId || v.labels[ROLE_LABEL] !== "staging") continue;
        if (Object.hasOwn(v.labels, PROJECT_LABEL)) continue;
        if (!old(v.created)) continue;
        await remove(["volume", "rm", "-f", name], name);
      } catch {
        failures++;
      }
    }

    let nets: string[] = [];
    try {
      nets = await listed(["network", "ls", "--no-trunc", "--filter", owned, "--filter", `label=${ROLE_LABEL}=${ONESHOT_NET_ROLE}`, "--format", "{{.ID}}"]);
    } catch {
      failures++;
    }
    for (const listedId of nets) {
      try {
        if (!FULL_ID.test(listedId)) throw new Error("not a full id");
        const res = await this.ask(["network", "inspect", "--format", '{"id":{{json .Id}},"labels":{{json .Labels}},"created":{{json .Created}}}', listedId], 30_000);
        if (this.isNetworkNotThere(res)) continue;
        if (res.code !== 0 || res.timedOut || res.truncated) throw new Error("inspect failed");
        const n = JSON.parse(res.stdout.trim()) as { id?: unknown; labels?: unknown; created?: unknown } | null;
        if (!n || typeof n !== "object" || n.id !== listedId) throw new Error("unreadable inspect");
        // No labels at all: not ours to judge, so skipped (not a failure).
        if (n.labels === null || typeof n.labels !== "object" || Array.isArray(n.labels)) continue;
        const labels = n.labels as Record<string, unknown>;
        if (labels[OWNER_LABEL] !== this.installationId || labels[ROLE_LABEL] !== ONESHOT_NET_ROLE) continue;
        if (Object.hasOwn(labels, PROJECT_LABEL)) continue;
        if (!old(n.created)) continue;
        const rm = await this.ask(["network", "rm", listedId], 120_000);
        if (rm.code === 0) removed.push(listedId);
        else if (!this.isNetworkNotThere(rm) && !/active endpoints/i.test(rm.stderr)) throw new Error("remove failed");
      } catch {
        failures++;
      }
    }
    return { removed, failures };
  }

  /** Clone the repository into a fresh volume and report what is in it. */
  async probe(
    repo: RepoRef,
    volume: string,
    // `timeoutMs` is for tests only.
    opts: { ref?: string; submodules?: boolean; onOutput?: (chunk: string) => void; volumeRole?: "staging"; timeoutMs?: number },
  ): Promise<ProbeData> {
    await this.assertNameFree(volume);
    await this.ensureImage(this.cfg.docker.probeImage, opts.onOutput);
    await this.makeVolume(volume, opts.volumeRole);
    const timeoutMs = opts.timeoutMs ?? 600_000;
    // Under containment the clone reaches its own forge and nothing else (DD5), through a one-shot proxy. A forge named in
    // MCPE_EXTRA_HOSTS is self-hosted and may be local (DD10); github.com and gitlab.com never are.
    const egress =
      this.cfg.network.mode === "contained"
        ? { allow: cloneHosts(repo).map((h) => parseHostEntry(h, "scanner")), local: repo.host !== "github.com" && repo.host !== "gitlab.com" }
        : undefined;
    const res = await this.runOnce({
      role: "clone",
      image: this.cfg.docker.probeImage,
      ...(egress ? { egress } : { network: "bridge" }),
      mounts: [`${volume}:${WORKSPACE}`],
      entrypoint: "sh",
      args: [
        "-c", PROBE_SCRIPT, "probe",
        repo.cloneUrl, opts.ref ?? "", opts.submodules ? "1" : "0",
        ...MANIFESTS,
        WALK_SEPARATOR,
        ...walkArguments(),
      ],
      timeoutMs,
      maxBytes: 16_000_000,
    });
    if (res.code !== 0) {
      const detail = res.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : res.stderr.trim().split("\n").slice(-6).join("\n");
      const text = `Could not clone ${repo.cloneUrl}${opts.ref ? ` at ${opts.ref}` : ""}:\n${detail || "git failed"}`;
      // Only a report that was read says anything; a proxy that did not start never reaches here (it threw `ProxyStartError`).
      const rows = res.proxy && "rows" in res.proxy ? res.proxy.rows : [];
      throw egress ? new CloneFailedError(text, refusalLines(rows, "clone")) : new Error(text);
    }
    const data = parseProbeOutput(res.stdout, res.truncated);
    if (!data.commit) throw new Error(`Clone of ${repo.cloneUrl} produced no commit`);
    return data;
  }

  /**
   * Make the long-lived sandbox container for a project. By default it is started at once (`docker run -d`, on `bridge`).
   * With `start: false` it is only created (`docker create`, the same arguments, still on `bridge`) so that containment
   * can move it to its own network before its first start (T15). Under `MCPE_NETWORK=contained` a start here is refused:
   * a sandbox that began on `bridge` would have reached the network before it was contained.
   */
  async createContainer(opts: { name: string; volume: string; image: string; project: string; start?: boolean }): Promise<SandboxRef> {
    const start = opts.start !== false;
    if (start && this.cfg.network.mode === "contained") {
      throw new Error("A sandbox is not started on bridge under MCPE_NETWORK=contained: create it with start: false, contain it, then start it.");
    }
    await this.assertRuntime();
    // Only on a volume that exists and is this installation's: `docker run -v` would otherwise make or use any volume.
    const vol = await this.inspectVolume(opts.volume);
    if (!vol) throw new Error(`Volume ${clean(opts.volume)} does not exist; it must be created first`);
    const facts = this.volumeFacts(opts.volume, vol.labels);
    this.refuseUnless([facts]);
    if (facts.cls !== "mine") throw new Error(`Volume ${clean(opts.volume)} was made before ownership was recorded; it cannot hold a new container`);
    await this.ensureImage(opts.image);
    const basePath = await this.imagePath(opts.image);
    const path = [BIN_DIR, `${VENV_DIR}/bin`, "/root/.cargo/bin", "/usr/local/go/bin", basePath].join(":");
    const env: Record<string, string> = {
      PATH: path,
      HOME: "/root",
      TERM: "dumb",
      NO_COLOR: "1",
      CARGO_TERM_COLOR: "never",
      DEBIAN_FRONTEND: "noninteractive",
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
      PIP_ROOT_USER_ACTION: "ignore",
      PYTHONDONTWRITEBYTECODE: "1",
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
      npm_config_audit: "false",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      // Libraries installed next to binaries under the prefix (cmake/autotools).
      LD_LIBRARY_PATH: `${PREFIX}/lib:${PREFIX}/lib64`,
      GIT_TERMINAL_PROMPT: "0",
    };
    const idle = this.cfg.sandboxIdleSec;
    // The arguments after the verb: the same for `run -d` and `create`. Two literal verbs, so that the bypass test reads both.
    const rest = [
      "--init",
      "--name", opts.name,
      "--hostname", "sandbox",
      "--label", "mcp-everything=1",
      "--label", `mcp-everything.owner=${this.installationId}`,
      "--label", `mcp-everything.project=${opts.project}`,
      "--label", `mcp-everything.idle-timeout=${idle}`,
      ...this.limits(),
      // Root inside the container needs these to run package managers
      // (chown/setuid when unpacking and dropping privileges); nothing else.
      "--cap-add", "CHOWN", "--cap-add", "DAC_OVERRIDE", "--cap-add", "FOWNER",
      "--cap-add", "FSETID", "--cap-add", "SETUID", "--cap-add", "SETGID",
      "--network", "bridge",
      "-v", `${opts.volume}:${WORKSPACE}`,
      "-w", REPO_DIR,
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      ...(idle > 0
        ? ["--entrypoint", "/bin/sh", opts.image, "-c", WATCHDOG_SCRIPT, "watchdog", String(idle), String(watchdogPollSec(idle))]
        : ["--entrypoint", "sleep", opts.image, "infinity"]),
    ];
    const res = start ? await this.docker(["run", "-d", ...rest], { timeoutMs: 120_000 }) : await this.docker(["create", ...rest], { timeoutMs: 120_000 });
    if (res.code !== 0) {
      const refusal = this.runtimeRefusal(res.stderr);
      if (refusal) throw refusal;
      throw new Error(`Failed to ${start ? "start" : "create"} sandbox container: ${res.stderr.trim()}`);
    }
    const id = res.stdout.trim();
    if (!FULL_ID.test(id)) throw new Error(`Docker ${start ? "started" : "created"} a sandbox container but printed no usable id: ${oneLine(id, 80) || "(nothing)"}`);
    return makeRef(id, opts.name);
  }

  /**
   * Whose a container is, for a report to the operator: one read-only inspect by
   * name, classified by the same function as every guard. Never throws and never
   * changes anything: a failure to ask is "unavailable", which is not "missing".
   * It can take as long as the inspect's own limit (30 s) when the daemon hangs.
   */
  async ownership(name: string): Promise<OwnershipReport> {
    try {
      const c = await this.inspectContainer(name, true);
      if (!c) return { state: "missing" };
      const facts = this.containerFacts(name, c);
      return facts.owner === undefined || facts.cls !== "another" ? { state: facts.cls } : { state: facts.cls, owner: facts.owner };
    } catch {
      return { state: "unavailable" };
    }
  }

  /**
   * Make a sandbox usable by name, or hold on to a checked reference. Returns the
   * reference for a container that is mine or from before, started if it was
   * stopped; undefined when it is not there; throws a refusal for another's or not ours.
   */
  async acquire(name: string): Promise<SandboxRef | undefined> {
    const c = await this.resolveContainer(name);
    if (!c) return undefined;
    this.refuseRuntimeMismatch(name, c);
    // The hook comes first: it may have to repair the network or the proxy before the sandbox starts (T14).
    const env = await this.hooked(c, name, "full");
    if (!c.running) await this.startId(c.id, name);
    // After a start Docker has rewritten `/etc/hosts`; a sandbox that was running is checked for its lines (the step is cheap and idempotent).
    await this.afterStarted(c, name, !c.running);
    return makeRef(c.id, name, env);
  }

  /**
   * Start a sandbox by name WITHOUT the containment hook, for containment's own use (its `contain` and the startup
   * pass of leg 10), which makes the network and the proxy itself. Classified and runtime-checked like `acquire`.
   * Only `Containment` calls it (a source-scan test enforces that). Undefined when it is not there.
   */
  async startForContainment(name: string): Promise<SandboxRef | undefined> {
    const c = await this.resolveContainer(name);
    if (!c) return undefined;
    this.refuseRuntimeMismatch(name, c);
    if (!c.running) {
      await this.startId(c.id, name, true);
      await this.afterStarted(c, name, true);
    }
    return makeRef(c.id, name);
  }

  /**
   * One inspect of a sandbox by name, classified (another's or not-ours is a refusal), for containment to see the
   * facts again after it waited. Never starts, execs or changes anything, and never calls the hook. Undefined when gone.
   */
  async inspectSandbox(name: string): Promise<SandboxInspectFacts | undefined> {
    const c = await this.resolveContainer(name);
    if (!c) return undefined;
    return { id: c.id, name: c.name ?? name, running: c.running, labels: c.labels, networks: [...c.networks], ...(c.networkIds ? { networkIds: { ...c.networkIds } } : {}), runtime: c.runtime };
  }

  /**
   * Run argv inside a sandbox, given by name (classified first) or by checked
   * reference. The command is wrapped in coreutils `timeout` so it is killed
   * inside the container, with a host-side kill as backstop.
   *
   * With the hook installed it asks the hook for the environment first (`restart: false`, the cleanup's exec,
   * gets the observe-only form and no runtime comparison, so that cleanup never stops on what it cannot repair).
   * A reference's answer is reused for `hookTtlMs` when the inspect said running (the cache); by name the inspect
   * happens anyway.
   */
  async exec(target: Target, argv: string[], opts: ExecOptions): Promise<ExecResult> {
    let id: string;
    const mode: ContainmentHookMode = opts.restart === false ? "observe" : "full";
    // The reference's own environment wins: a caller's `env` cannot take away what the reference carries.
    const caller: Record<string, string> = { ...opts.env };
    const refEnv = typeof target === "string" ? undefined : target.env;
    let fromHook: Record<string, string> | undefined;
    if (typeof target === "string") {
      const c = await this.resolveContainer(target);
      if (!c) throw this.doesNotExist(target);
      this.refuseRuntimeMismatch(target, c);
      id = c.id;
      fromHook = await this.hooked(c, target, mode);
    } else {
      id = target.id;
      if (this.hook) {
        const hit = mode === "full" ? this.hookCached(id) : undefined;
        if (hit) {
          fromHook = hit.env;
        } else {
          const c = await this.inspectContainer(id, true);
          if (c) {
            if (mode === "full") this.refuseRuntimeMismatch(target.name, c);
            fromHook = await this.hooked(c, target.name, mode, mode === "full");
          }
        }
      }
    }
    const first = await this.execOnce(id, argv, opts, { ...caller, ...fromHook, ...refEnv });
    if (opts.restart === false || !isStoppedExecFailure(first)) return first;
    // The sandbox idled out between the caller's liveness check and this exec.
    const again = await this.startIfStopped(id);
    if (!again) return first;
    // The retry uses the fresh answer of the hook that ran before the start, not the one from before it.
    return this.execOnce(id, argv, opts, { ...caller, ...(this.hook ? again.env : fromHook), ...refEnv });
  }

  /** On an id already checked: ask the hook, then start it if stopped; undefined when it is gone, else the hook's environment. */
  private async startIfStopped(id: string): Promise<{ env: Record<string, string> | undefined } | undefined> {
    const c = await this.inspectContainer(id, this.hook !== undefined);
    if (!c) return undefined;
    this.refuseRuntimeMismatch(id, c);
    const env = await this.hooked(c, id, "full");
    if (!c.running) {
      await this.startId(id, id);
      await this.afterStarted(c, id, true);
    }
    return { env };
  }

  /** `env` is already merged (reference over caller); it is validated here, before anything runs. */
  private async execOnce(container: string, argv: string[], opts: ExecOptions, env: Record<string, string> = {}): Promise<ExecResult> {
    const secs = Math.max(1, Math.floor(opts.timeoutSec));
    const args = ["exec", "-i"];
    if (opts.cwd) args.push("-w", opts.cwd);
    args.push(...envFlags(env));
    args.push(container, "timeout", "-k", "5", String(secs), ...argv);
    const started = Date.now();
    const res = await this.docker(args, {
      stdin: opts.stdin,
      timeoutMs: (secs + 15) * 1000,
      maxBytes: opts.maxBytes ?? this.cfg.maxOutputBytes,
      onOutput: opts.onOutput,
    });
    // 124: `timeout` fired. 137 once the limit has passed: SIGKILL after the
    // grace period. (137 earlier than that is something else, e.g. the OOM killer.)
    const overdue = Date.now() - started >= secs * 1000;
    const timedOut = res.timedOut || res.code === 124 || (res.code === 137 && overdue);
    return { ...res, timedOut };
  }

  /** The facts of a sandbox given by name (classified) or by reference (by id, labels not read); null when gone. */
  private async look(target: Target, withLabels = false): Promise<ContainerFacts | null> {
    return typeof target === "string" ? this.resolveContainer(target) : this.inspectContainer(target.id, withLabels);
  }

  /** "running", "stopped" or "missing". */
  async state(target: Target): Promise<"running" | "stopped" | "missing"> {
    const c = await this.look(target);
    if (!c) return "missing";
    return c.running ? "running" : "stopped";
  }

  /** Make sure the container is up; by name, returns false if it no longer exists. A reference that is gone is an error. */
  async ensureRunning(target: Target): Promise<boolean> {
    // A reference's labels are read only when a hook is there to be given them.
    const c = await this.look(target, this.hook !== undefined);
    if (!c) {
      if (typeof target === "string") return false;
      throw new Error(`Sandbox ${clean(target.name)} no longer exists`);
    }
    const label = typeof target === "string" ? target : target.name;
    this.refuseRuntimeMismatch(label, c);
    await this.hooked(c, label, "full");
    if (!c.running) {
      await this.startId(c.id, label);
      await this.afterStarted(c, label, true);
    }
    return true;
  }

  /**
   * "off" (on no network, or the container is gone), "contained" (on its own `-net` and nothing else) or "open"
   * (anything else: `bridge`, `bridge` and `-net`, another network). From one inspect. "contained" says only that
   * it is listed on its own network: whether that network exists is the caller's to check (T14).
   */
  async networkState(target: Target): Promise<NetworkMode> {
    const c = await this.look(target);
    if (!c) return "off";
    return networkModeOf(typeof target === "string" ? target : target.name, c.networks);
  }

  /** `network disconnect -f`: a network that is gone, or one the container is not on, is not a failure. */
  private async disconnectForce(network: string, id: string, name: string): Promise<void> {
    const res = await this.docker(["network", "disconnect", "-f", network, id], { timeoutMs: 60_000 });
    if (res.code !== 0 && !this.isNetworkNotThere(res) && !this.isNotThere(res) && !/is not connected to/i.test(res.stderr)) {
      throw new Error(`Failed to disable network for ${clean(name)}: ${res.stderr.trim()}`);
    }
  }

  /**
   * "off": no network at all. "open": on `bridge`. "contained": on its own project network only (that network must
   * exist and be this project's; this method never makes it, and it never makes the proxy: leg 7 does). Leaving a
   * contained sandbox removes the project's proxies, then its `-net`, after all of them are classified. The sandbox
   * is never left with no network while it should be contained: it is attached to `-net` before `bridge` goes.
   */
  async setNetwork(target: Target, mode: NetworkMode): Promise<void> {
    try {
      await this.setNetworkNow(target, mode);
    } finally {
      // A change of network, whether or not it finished, ends what the hook last said about this sandbox.
      this.invalidate({ sandbox: typeof target === "string" ? target : target.name });
    }
  }

  private async setNetworkNow(target: Target, mode: NetworkMode): Promise<void> {
    if (mode !== "off" && mode !== "open" && mode !== "contained") throw new Error(`Unknown network mode ${JSON.stringify(mode)}`);
    const name = typeof target === "string" ? target : target.name;
    const c = await this.look(target);
    if (!c) {
      if (mode === "off" && typeof target === "string") return; // gone: nothing to detach
      throw typeof target === "string" ? this.doesNotExist(target) : new Error(`Sandbox ${clean(target.name)} no longer exists`);
    }
    const own = projectNetworkName(name);
    const onOwn = c.networks.includes(own);
    const onBridge = c.networks.includes("bridge");
    if (mode === "contained") {
      const project = c.labels?.[PROJECT_LABEL];
      const net = await this.findContainedNetwork(own, { role: PROJECT_NET_ROLE, sandbox: name, ...(project !== undefined ? { project } : {}) });
      if (!net) throw new Error(`The project network ${clean(own)} does not exist; it must be made before ${clean(name)} is contained`);
      await this.attachProjectNetwork(makeRef(c.id, name), net);
      if (onBridge) {
        const res = await this.docker(["network", "disconnect", "bridge", c.id], { timeoutMs: 60_000 });
        if (res.code !== 0) throw new Error(`Failed to disable network for ${clean(name)}: ${res.stderr.trim()}`);
      }
      return;
    }
    if (mode === "open") {
      if (onBridge) return;
      if (onOwn) {
        const objs = await this.projectObjects(name);
        this.refuseUnless(objs.facts);
        for (const p of objs.proxies) await this.rmProxy(p.id, p.name);
        await this.disconnectForce(own, c.id, name);
        if (objs.net) await this.rmNetwork(objs.net.id, objs.net.name);
        await this.clearLocalAccess(c, name);
      }
      const res = await this.docker(["network", "connect", "bridge", c.id], { timeoutMs: 60_000 });
      if (res.code !== 0) throw new Error(`Failed to enable network for ${clean(name)}: ${res.stderr.trim()}`);
      return;
    }
    // off
    if (c.networks.length === 0) return;
    if (!onOwn && c.networks.every((n) => n === "bridge")) {
      const res = await this.docker(["network", "disconnect", "bridge", c.id], { timeoutMs: 60_000 });
      if (res.code !== 0) throw new Error(`Failed to disable network for ${clean(name)}: ${res.stderr.trim()}`);
      return;
    }
    const objs = onOwn ? await this.projectObjects(name) : undefined;
    if (objs) this.refuseUnless(objs.facts);
    for (const n of c.networks) await this.disconnectForce(n, c.id, name);
    if (objs) {
      for (const p of objs.proxies) await this.rmProxy(p.id, p.name);
      if (objs.net) await this.rmNetwork(objs.net.id, objs.net.name);
      await this.clearLocalAccess(c, name);
    }
  }

  /**
   * Take the local-access lines out of a running sandbox's `/etc/hosts` when it leaves its project network (they name an
   * address that is no longer its proxy). Best effort: a failure never fails the network change, and a stopped sandbox
   * gets a fresh `/etc/hosts` at its next start anyway.
   */
  private async clearLocalAccess(c: ContainerFacts, name: string): Promise<void> {
    if (!c.running) return;
    try {
      await this.writeLocalAccess({ id: c.id, name }, "127.0.0.1", []);
    } catch (e) {
      this.log(`could not take the local-access names out of ${clean(name)}: ${oneLine((e as Error).message, 200)}`);
    }
  }

  private async rmContainer(id: string, name: string): Promise<void> {
    // `-v` removes the container's anonymous volumes only, never a named one.
    const rm = await this.docker(["rm", "-f", "-v", id], { timeoutMs: 120_000 });
    if (rm.code !== 0) throw new Error(`Failed to remove container ${clean(name)}: ${rm.stderr.trim()}`);
  }

  /** Remove a sandbox container but keep its volume (to rebuild on another image). */
  async removeContainer(target: Target): Promise<void> {
    const name = typeof target === "string" ? target : target.name;
    const c = await this.resolveContainer(typeof target === "string" ? target : target.id);
    if (!c) return;
    await this.rmContainer(c.id, name);
  }

  /**
   * Remove a project's container and volume. Both are classified before either
   * is removed: if either is another's or not ours, or Docker cannot be asked,
   * neither is. Missing resources are not errors.
   */
  async destroy(container: string, volume: string): Promise<void> {
    try {
      await this.destroyNow(container, volume);
    } finally {
      this.invalidate({ sandbox: container });
    }
  }

  private async destroyNow(container: string, volume: string): Promise<void> {
    const c = await this.inspectContainer(container, true);
    const v = await this.inspectVolume(volume);
    // The project's proxies and `-net` are found by the sandbox's name, so they are found after its container is gone.
    const objs = await this.projectObjects(container);
    const facts: SandboxFacts[] = [];
    if (c) facts.push(this.containerFacts(container, c));
    if (v) facts.push(this.volumeFacts(volume, v.labels));
    facts.push(...objs.facts);
    this.refuseUnless(facts);
    // Container, then its proxies, then the network (nothing is on it any more), then the volume.
    if (c) await this.rmContainer(c.id, container);
    for (const p of objs.proxies) await this.rmProxy(p.id, p.name);
    if (objs.net) await this.rmNetwork(objs.net.id, objs.net.name);
    if (v) {
      const rm = await this.docker(["volume", "rm", "-f", volume], { timeoutMs: 120_000 });
      if (rm.code !== 0) throw new Error(`Failed to remove volume ${clean(volume)}: ${rm.stderr.trim()}`);
    }
  }
}
