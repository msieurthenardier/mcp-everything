import { randomBytes } from "node:crypto";
import type { Config } from "../config.js";
import { isInstallationId } from "../installation.js";
import type { RepoRef } from "../types.js";
import { run, type RunResult } from "../util/exec.js";
import { BUILD_FILE_PATTERNS, PRUNE_DIRS } from "../scan/build-hooks.js";
import type { BuildFile, BuildWalk } from "../scan/types.js";
import { oneLine } from "../util/text.js";
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
# wfind <depth option> <depth> <-name|-path> <pattern>: files and links under the checkout, pruning .git and the prune names.
wfind() {
  d1="$1"; d2="$2"; t="$3"; pat="$4"
  set -- \\( -name .git
  set -f
  for p in $prune; do set -- "$@" -o -name "$p"; done
  set +f
  find . "$d1" "$d2" "$@" \\) -prune -o \\( -type f -o -type l \\) "$t" "$pat" -print
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
    verdict "$(walkfind -mindepth 9 "$t" "$pat" | head -n 1)" depth
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
}

function makeRef(id: string, name: string): SandboxRef {
  return Object.freeze({ id, name });
}

/** What a refusal says about one sandbox. */
export interface SandboxFacts {
  kind: "container" | "volume";
  sandbox: string;
  cls: SandboxClass;
  /** The owner label as recorded (another's only). */
  owner?: string;
  /** The project label as recorded (containers only). */
  project?: string;
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
  const project = f.kind === "container" ? `, project label ${f.project === undefined ? "(none)" : `"${clean(f.project)}"`}` : "";
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
  readonly kind: "container" | "volume";
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

const NOT_THERE = /no such (container|object|volume)/i;
const FULL_ID = /^[0-9a-f]{64}$/;
const ROLE_LABEL = "mcp-everything.role";
const ONE_SHOT_ROLES: readonly string[] = ["clone", "scan", "copy"];
const EXTRA_CAPS: readonly string[] = ["CHOWN", "FOWNER", "DAC_OVERRIDE", "FSETID"];

/** What a one-shot container is for; the label and the name carry it, and nothing a caller types. */
export type OneShotRole = "clone" | "scan" | "copy";
/** The only capabilities a one-shot container may be given beyond none. */
export type OneShotCap = "CHOWN" | "FOWNER" | "DAC_OVERRIDE" | "FSETID";
export interface OneShotSpec {
  role: OneShotRole;
  image: string;
  network: string;
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
// A format that label content cannot confuse (every value is JSON). Never `{{json .}}`: it holds the environment.
const NETWORKS = '"networks":{{json .NetworkSettings.Networks}}';
const BASE_FORMAT = `{"id":{{json .Id}},"running":{{json .State.Running}},${NETWORKS}}`;
const FULL_FORMAT = `{"id":{{json .Id}},"running":{{json .State.Running}},"labels":{{json .Config.Labels}},${NETWORKS}}`;

interface ContainerFacts {
  id: string;
  running: boolean;
  networks: string[];
  labels: Record<string, string> | null;
}

type Target = string | SandboxRef;

export class Docker {
  constructor(
    private readonly cfg: Config,
    /** The installation id: it is in the name and the owner label of every sandbox this layer creates. */
    readonly installationId: string,
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
  private isNotThere(res: RunResult): boolean {
    return typeof res.code === "number" && res.code !== 0 && !res.timedOut && !res.truncated && NOT_THERE.test(res.stderr);
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
    return {
      id: o.id,
      running: o.running,
      networks: Object.keys(o.networks ?? {}),
      labels: withLabels ? ((o.labels as Record<string, string> | null) ?? null) : null,
    };
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

  private async startId(id: string, label: string): Promise<void> {
    const res = await this.ask(["start", id], 60_000);
    if (res.code !== 0) throw new Error(`Failed to start sandbox ${clean(label)}: ${res.stderr.trim()}`);
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
   */
  protected async runOnce(spec: OneShotSpec): Promise<RunResult> {
    if (!ONE_SHOT_ROLES.includes(spec.role)) throw new Error(`Unknown one-shot role ${JSON.stringify(spec.role)}`);
    const caps = spec.caps ?? [];
    for (const c of caps) if (!EXTRA_CAPS.includes(c)) throw new Error(`Capability ${JSON.stringify(c)} is not one a one-shot container may have`);
    const name = `${this.cfg.docker.namePrefix}${this.installationId}-${spec.role}-${randomBytes(4).toString("hex")}`;
    const created = await this.docker(
      [
        "create", "--rm",
        "--name", name,
        "--label", "mcp-everything=1",
        "--label", `${OWNER_LABEL}=${this.installationId}`,
        "--label", `${ROLE_LABEL}=${spec.role}`,
        ...this.limits(),
        ...caps.flatMap((c) => ["--cap-add", c]),
        "--network", spec.network,
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
      await this.docker(["rm", "-f", name], { timeoutMs: 30_000 }).catch(() => undefined);
      throw new Error(`Could not create the ${spec.role} container: docker create timed out`);
    }
    const id = created.stdout.trim();
    if (created.code !== 0) throw new Error(`Could not create the ${spec.role} container: ${created.stderr.trim().split("\n").slice(-3).join("\n") || "docker create failed"}`);
    if (!FULL_ID.test(id)) throw new Error(`Could not create the ${spec.role} container: Docker printed no usable id: ${oneLine(id, 80) || "(nothing)"}`);
    try {
      return await this.docker(["start", "-a", id], { timeoutMs: spec.timeoutMs, maxBytes: spec.maxBytes });
    } finally {
      try {
        // "No such container" is success (--rm may have removed it). Any other failure is ignored: it must
        // never mask the command's outcome, and leg 6's startup sweep removes what is left.
        await this.docker(["rm", "-f", id], { timeoutMs: 60_000 });
      } catch {
        /* as above */
      }
    }
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
   * (checked before any container exists). The image's own entrypoint runs with `spec.command` as its arguments, no
   * network unless the scanner is configured to have one, the checkout mounted read-only at /scan and the working
   * directory /scan/repo (a checkout with no `repo` directory makes `start` fail: the caller reports it as a failed run).
   */
  async runScanner(volume: string, spec: ScannerSpec, opts: { timeoutMs: number; envFile?: string }): Promise<RunResult> {
    await this.requireVolumes([{ name: volume, role: "staging" }]);
    return this.runOnce({
      role: "scan",
      image: spec.image,
      network: spec.network ? "bridge" : "none",
      mountFlags: [`type=volume,src=${volume},dst=/scan,readonly`],
      workdir: "/scan/repo",
      envFile: opts.envFile,
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
   * Remove what a check left behind that is this installation's and old: containers with a role of `clone`,
   * `scan` or `copy` and volumes with the role `staging`. It acts only on what it listed and then re-verified by
   * inspect (the owner label is this installation's id, the role is in the allowlist, the age is known and over
   * `maxAgeSec`), removing containers by their full id. A thing that is gone meanwhile is skipped. It never
   * throws: Docker failures are counted, for the caller to log. Never anything without a role label or with
   * another owner.
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
        if (c.labels[OWNER_LABEL] !== this.installationId || !ONE_SHOT_ROLES.includes(String(c.labels[ROLE_LABEL]))) continue;
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
        if (!old(v.created)) continue;
        await remove(["volume", "rm", "-f", name], name);
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
    const res = await this.runOnce({
      role: "clone",
      image: this.cfg.docker.probeImage,
      network: "bridge",
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
      throw new Error(`Could not clone ${repo.cloneUrl}${opts.ref ? ` at ${opts.ref}` : ""}:\n${detail || "git failed"}`);
    }
    const data = parseProbeOutput(res.stdout, res.truncated);
    if (!data.commit) throw new Error(`Clone of ${repo.cloneUrl} produced no commit`);
    return data;
  }

  /** Start the long-lived sandbox container for a project. */
  async createContainer(opts: { name: string; volume: string; image: string; project: string }): Promise<SandboxRef> {
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
    const res = await this.docker(
      [
        "run", "-d", "--init",
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
      ],
      { timeoutMs: 120_000 },
    );
    if (res.code !== 0) throw new Error(`Failed to start sandbox container: ${res.stderr.trim()}`);
    const id = res.stdout.trim();
    if (!FULL_ID.test(id)) throw new Error(`Docker started a sandbox container but printed no usable id: ${oneLine(id, 80) || "(nothing)"}`);
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
    if (!c.running) await this.startId(c.id, name);
    return makeRef(c.id, name);
  }

  /**
   * Run argv inside a sandbox, given by name (classified first) or by checked
   * reference. The command is wrapped in coreutils `timeout` so it is killed
   * inside the container, with a host-side kill as backstop.
   */
  async exec(target: Target, argv: string[], opts: ExecOptions): Promise<ExecResult> {
    let id: string;
    if (typeof target === "string") {
      const c = await this.resolveContainer(target);
      if (!c) throw this.doesNotExist(target);
      id = c.id;
    } else {
      id = target.id;
    }
    const first = await this.execOnce(id, argv, opts);
    if (opts.restart === false || !isStoppedExecFailure(first)) return first;
    // The sandbox idled out between the caller's liveness check and this exec.
    if (!(await this.startIfStopped(id))) return first;
    return this.execOnce(id, argv, opts);
  }

  /** On an id already checked: start it if stopped; false when it is gone. */
  private async startIfStopped(id: string): Promise<boolean> {
    const c = await this.inspectContainer(id, false);
    if (!c) return false;
    if (!c.running) await this.startId(id, id);
    return true;
  }

  private async execOnce(container: string, argv: string[], opts: ExecOptions): Promise<ExecResult> {
    const secs = Math.max(1, Math.floor(opts.timeoutSec));
    const args = ["exec", "-i"];
    if (opts.cwd) args.push("-w", opts.cwd);
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
  private async look(target: Target): Promise<ContainerFacts | null> {
    return typeof target === "string" ? this.resolveContainer(target) : this.inspectContainer(target.id, false);
  }

  /** "running", "stopped" or "missing". */
  async state(target: Target): Promise<"running" | "stopped" | "missing"> {
    const c = await this.look(target);
    if (!c) return "missing";
    return c.running ? "running" : "stopped";
  }

  /** Make sure the container is up; by name, returns false if it no longer exists. A reference that is gone is an error. */
  async ensureRunning(target: Target): Promise<boolean> {
    const c = await this.look(target);
    if (!c) {
      if (typeof target === "string") return false;
      throw new Error(`Sandbox ${clean(target.name)} no longer exists`);
    }
    if (!c.running) await this.startId(c.id, typeof target === "string" ? target : target.name);
    return true;
  }

  async hasNetwork(target: Target): Promise<boolean> {
    const c = await this.look(target);
    return c !== null && c.networks.length > 0;
  }

  async setNetwork(target: Target, enabled: boolean): Promise<void> {
    const name = typeof target === "string" ? target : target.name;
    const c = await this.look(target);
    if (!c) {
      if (!enabled && typeof target === "string") return; // gone: nothing to detach
      throw typeof target === "string" ? this.doesNotExist(target) : new Error(`Sandbox ${clean(target.name)} no longer exists`);
    }
    const connected = c.networks.length > 0;
    if (connected === enabled) return;
    const res = await this.docker(["network", enabled ? "connect" : "disconnect", "bridge", c.id], { timeoutMs: 60_000 });
    if (res.code !== 0) {
      throw new Error(`Failed to ${enabled ? "enable" : "disable"} network for ${clean(name)}: ${res.stderr.trim()}`);
    }
  }

  private async rmContainer(id: string, name: string): Promise<void> {
    const rm = await this.docker(["rm", "-f", id], { timeoutMs: 120_000 });
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
    const c = await this.inspectContainer(container, true);
    const v = await this.inspectVolume(volume);
    const facts: SandboxFacts[] = [];
    if (c) facts.push(this.containerFacts(container, c));
    if (v) facts.push(this.volumeFacts(volume, v.labels));
    this.refuseUnless(facts);
    if (c) await this.rmContainer(c.id, container);
    if (v) {
      const rm = await this.docker(["volume", "rm", "-f", volume], { timeoutMs: 120_000 });
      if (rm.code !== 0) throw new Error(`Failed to remove volume ${clean(volume)}: ${rm.stderr.trim()}`);
    }
  }
}
