import type { Config } from "../config.js";
import type { RepoRef } from "../types.js";
import { run, type RunResult } from "../util/exec.js";

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
}

export interface ExecOptions {
  cwd?: string;
  stdin?: string;
  timeoutSec: number;
  maxBytes?: number;
  env?: Record<string, string>;
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

const MANIFESTS = [
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
const PROBE_SCRIPT = `
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
for f in "$@"; do
  if [ -f "$f" ] && [ ! -L "$f" ]; then
    printf 'FILE %s %s\\n' "$f" "$(head -c 300000 "$f" | base64 | tr -d '\\n')"
  fi
done
`;

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
// BusyBox 1.37.0 `sh` (Alpine 3.24, `alpine/git:latest`) in November 2026. Both tags
// float, so a newer shell behind either is untested until the pressure cases have
// been run against it.
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

export function parseProbeOutput(stdout: string): ProbeData {
  const data: ProbeData = { commit: "", entries: [], files: {} };
  const b64 = (s: string | undefined) => Buffer.from(s ?? "", "base64").toString("utf8");
  for (const line of stdout.split("\n")) {
    const parts = line.split(" ");
    if (parts[0] === "HEAD" && /^[0-9a-f]{40,64}$/.test(parts[1] ?? "")) {
      data.commit = parts[1]!;
    } else if (parts[0] === "ENTRY" && parts.length === 3) {
      data.entries.push({ name: b64(parts[2]), dir: parts[1] === "d" });
    } else if (parts[0] === "FILE" && parts.length === 3 && MANIFESTS.includes(parts[1]!)) {
      data.files[parts[1]!] = b64(parts[2]);
    }
  }
  return data;
}

export class Docker {
  constructor(private readonly cfg: Config) {}

  protected docker(args: string[], opts: Parameters<typeof run>[2] = {}): Promise<RunResult> {
    return run(this.cfg.docker.bin, args, opts);
  }

  /** Throws a readable error unless the Docker daemon is reachable. */
  async assertAvailable(): Promise<void> {
    let res: RunResult;
    try {
      res = await this.docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 15_000 });
    } catch (e) {
      throw new Error(`Docker CLI "${this.cfg.docker.bin}" could not be run: ${(e as Error).message}`);
    }
    if (res.code !== 0) {
      throw new Error(`Docker daemon is not reachable: ${res.stderr.trim() || "unknown error"}`);
    }
  }

  async ensureImage(image: string, onOutput?: (chunk: string) => void): Promise<void> {
    const have = await this.docker(["image", "inspect", "--format", "{{.Id}}", image], { timeoutMs: 30_000 });
    if (have.code === 0) return;
    onOutput?.(`Pulling image ${image}…\n`);
    const pull = await this.docker(["pull", "--quiet", image], { timeoutMs: 900_000 });
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

  /** Clone the repository into a fresh volume and report what is in it. */
  async probe(
    repo: RepoRef,
    volume: string,
    opts: { ref?: string; submodules?: boolean; onOutput?: (chunk: string) => void },
  ): Promise<ProbeData> {
    await this.ensureImage(this.cfg.docker.probeImage, opts.onOutput);
    const vol = await this.docker(["volume", "create", "--label", "mcp-everything=1", volume], { timeoutMs: 30_000 });
    if (vol.code !== 0) throw new Error(`Failed to create volume: ${vol.stderr.trim()}`);
    const res = await this.docker(
      [
        "run", "--rm", "--network", "bridge",
        ...this.limits(),
        "-v", `${volume}:${WORKSPACE}`,
        "--entrypoint", "sh",
        this.cfg.docker.probeImage,
        "-c", PROBE_SCRIPT, "probe",
        repo.cloneUrl, opts.ref ?? "", opts.submodules ? "1" : "0",
        ...MANIFESTS,
      ],
      { timeoutMs: 600_000, maxBytes: 8_000_000 },
    );
    if (res.code !== 0) {
      const detail = res.stderr.trim().split("\n").slice(-6).join("\n");
      throw new Error(`Could not clone ${repo.cloneUrl}${opts.ref ? ` at ${opts.ref}` : ""}:\n${detail || "git failed"}`);
    }
    const data = parseProbeOutput(res.stdout);
    if (!data.commit) throw new Error(`Clone of ${repo.cloneUrl} produced no commit`);
    return data;
  }

  /** Start the long-lived sandbox container for a project. */
  async createContainer(opts: { name: string; volume: string; image: string; project: string }): Promise<void> {
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
  }

  /**
   * Run argv inside a sandbox. The command is wrapped in coreutils `timeout`
   * so it is killed inside the container, with a host-side kill as backstop.
   */
  async exec(container: string, argv: string[], opts: ExecOptions): Promise<ExecResult> {
    const first = await this.execOnce(container, argv, opts);
    if (opts.restart === false || !isStoppedExecFailure(first)) return first;
    // The sandbox idled out between the caller's liveness check and this exec.
    if (!(await this.ensureRunning(container))) return first;
    return this.execOnce(container, argv, opts);
  }

  private async execOnce(container: string, argv: string[], opts: ExecOptions): Promise<ExecResult> {
    const secs = Math.max(1, Math.floor(opts.timeoutSec));
    const args = ["exec", "-i"];
    if (opts.cwd) args.push("-w", opts.cwd);
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push("-e", `${k}=${v}`);
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

  /** "running", "stopped" or "missing". */
  async state(container: string): Promise<"running" | "stopped" | "missing"> {
    const res = await this.docker(["inspect", "--format", "{{.State.Running}}", container], { timeoutMs: 30_000 });
    if (res.code !== 0) return "missing";
    return res.stdout.trim() === "true" ? "running" : "stopped";
  }

  /** Make sure the container is up; returns false if it no longer exists. */
  async ensureRunning(container: string): Promise<boolean> {
    const state = await this.state(container);
    if (state === "missing") return false;
    if (state === "stopped") {
      const res = await this.docker(["start", container], { timeoutMs: 60_000 });
      if (res.code !== 0) throw new Error(`Failed to start sandbox ${container}: ${res.stderr.trim()}`);
    }
    return true;
  }

  async hasNetwork(container: string): Promise<boolean> {
    const res = await this.docker(
      ["inspect", "--format", "{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}", container],
      { timeoutMs: 30_000 },
    );
    return res.code === 0 && res.stdout.trim().length > 0;
  }

  async setNetwork(container: string, enabled: boolean): Promise<void> {
    const connected = await this.hasNetwork(container);
    if (connected === enabled) return;
    const res = await this.docker(["network", enabled ? "connect" : "disconnect", "bridge", container], {
      timeoutMs: 60_000,
    });
    if (res.code !== 0) {
      throw new Error(`Failed to ${enabled ? "enable" : "disable"} network for ${container}: ${res.stderr.trim()}`);
    }
  }

  /** Remove a sandbox container but keep its volume (to rebuild on another image). */
  async removeContainer(container: string): Promise<void> {
    const label = '{{index .Config.Labels "mcp-everything"}}';
    const c = await this.docker(["inspect", "--type", "container", "--format", label, container], { timeoutMs: 30_000 });
    if (c.code !== 0) return;
    if (c.stdout.trim() !== "1") throw new Error(`Refusing to remove container "${container}": it was not created by mcp-everything`);
    const rm = await this.docker(["rm", "-f", container], { timeoutMs: 120_000 });
    if (rm.code !== 0) throw new Error(`Failed to remove container ${container}: ${rm.stderr.trim()}`);
  }

  /**
   * Remove a project's container and volume. Missing resources are not errors,
   * but anything not labelled as ours is left alone and reported.
   */
  async destroy(container: string, volume: string): Promise<void> {
    await this.removeContainer(container);
    const v = await this.docker(["volume", "inspect", "--format", '{{index .Labels "mcp-everything"}}', volume], {
      timeoutMs: 30_000,
    });
    if (v.code === 0) {
      if (v.stdout.trim() !== "1") throw new Error(`Refusing to remove volume "${volume}": it was not created by mcp-everything`);
      const rm = await this.docker(["volume", "rm", "-f", volume], { timeoutMs: 120_000 });
      if (rm.code !== 0) throw new Error(`Failed to remove volume ${volume}: ${rm.stderr.trim()}`);
    }
  }
}
