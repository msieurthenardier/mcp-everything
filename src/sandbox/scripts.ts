import { BUILD_FILE_PATTERNS, PRUNE_DIRS } from "../scan/build-hooks.js";
import type { BuildFile, BuildWalk } from "../scan/types.js";

/** Paths inside every sandbox. */
export const WORKSPACE = "/workspace";
export const REPO_DIR = "/workspace/repo";
export const WORK_DIR = "/workspace/work";
export const PREFIX = "/opt/mcpe";
export const BIN_DIR = "/opt/mcpe/bin";
export const VENV_DIR = "/opt/mcpe/venv";
/** Where build output really lives: on the sandbox's volume; PREFIX is a symlink to it. */
export const OUTPUT_DIR = `${WORKSPACE}/.mcpe`;
/** Ruby's GEM_HOME, under PREFIX and so on the volume. */
export const GEM_DIR = `${PREFIX}/gems`;

export const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export interface ProbeData {
  commit: string;
  /** Top-level entries of the repository. */
  entries: Array<{ name: string; dir: boolean }>;
  /** Contents of well-known manifest files, keyed by file name. */
  files: Record<string, string>;
  /** The build files the walk of the clone read (see WALK_SCRIPT). Always present. */
  walk: BuildWalk;
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
export const WATCHDOG_SCRIPT = `
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
