import fs from "node:fs";
import path from "node:path";
import { newEnvFileName, validateEnv } from "../proxy/mcp-proxy.js";
import { SandboxRefusedError, VolumeNotUsableError } from "../sandbox/docker.js";
import type { RunResult } from "../util/exec.js";
import { oneLine } from "../util/text.js";
import { emptyCounts, parseSarif } from "./sarif.js";
import type { CheckOutcome, Finding, ScannerSpec } from "./types.js";

/** The two things `runScanners` needs from Docker; the class satisfies it. */
export interface ScanDocker {
  ensureImage(image: string, onOutput?: (chunk: string) => void, pullTimeoutMs?: number): Promise<void>;
  runScanner(volume: string, spec: ScannerSpec, opts: { timeoutMs: number; envFile?: string }): Promise<RunResult>;
}

export interface RunScannersOptions {
  /** The overall budget for every scanner, pulls included (`MCPE_SCAN_TIMEOUT`). */
  totalTimeoutSec: number;
  /** Where `tmp/` holds the credentials file of a scanner that is given variables. */
  dataDir: string;
  /** The clock, in milliseconds. */
  now?: () => number;
  /** Where the variables a scanner names are read from. */
  env?: NodeJS.ProcessEnv;
}

/** A scanner that would get less than this is not started. */
const MIN_RUN_MS = 10_000;
const STDERR_TAIL = 300;
const MIN_SECRET = 4;

/**
 * Run the operator's scanners over a staging volume, one at a time, and turn each run into an outcome, in the
 * order given. The budget covers the image pulls and the runs. The one-shot container's own `create` (60 s) and
 * `rm` are outside it. A refusal, or a staging volume that cannot be used, propagates and aborts the run (every
 * scanner would meet it); any other Docker failure fails only the scanner it met.
 *
 * Nothing a scanner prints reaches an outcome except through `parseSarif` and a bounded stderr tail, and the
 * values given to a scanner through `env` are removed from all of it.
 */
export async function runScanners(docker: ScanDocker, volume: string, scanners: ScannerSpec[], opts: RunScannersOptions): Promise<CheckOutcome[]> {
  const now = opts.now ?? Date.now;
  const env = opts.env ?? process.env;
  const start = now();
  const left = () => opts.totalTimeoutSec * 1000 - (now() - start);
  const out: CheckOutcome[] = [];
  let exhausted = false;
  for (const spec of scanners) {
    if (!exhausted && left() < MIN_RUN_MS) exhausted = true;
    if (exhausted) {
      out.push(outcome(spec, "not-run", "no time left in the scan budget"));
      continue;
    }

    const vars = readEnv(spec, env);
    if (typeof vars === "string") {
      out.push(outcome(spec, "failed", vars));
      continue;
    }

    try {
      await docker.ensureImage(spec.image, undefined, left());
    } catch {
      out.push(outcome(spec, "failed", "image could not be pulled")); // never ensureImage's message: it carries the pull's stderr
      continue;
    }
    const timeoutMs = Math.min(spec.timeoutSec * 1000, left());
    if (timeoutMs < MIN_RUN_MS) {
      exhausted = true;
      out.push(outcome(spec, "not-run", "no time left in the scan budget"));
      continue;
    }
    out.push(await runOne(docker, volume, spec, vars, timeoutMs, opts.dataDir));
  }
  return out;
}

function outcome(spec: ScannerSpec, status: CheckOutcome["status"], error: string): CheckOutcome {
  return { name: spec.name, kind: "scanner", status, counts: emptyCounts(), findings: [], omitted: 0, notes: [], error };
}

/** The values to pass, or the fixed text of why not. Never a value in the text. */
function readEnv(spec: ScannerSpec, env: NodeJS.ProcessEnv): Record<string, string> | string {
  const vars: Record<string, string> = {};
  for (const name of spec.env) {
    const value = env[name];
    if (value === undefined) return `environment variable ${oneLine(name, 100)} is not set`;
    try {
      Object.assign(vars, validateEnv({ [name]: value }));
    } catch {
      return `environment variable ${oneLine(name, 100)} cannot be passed to a scanner`;
    }
  }
  return vars;
}

async function runOne(
  docker: ScanDocker,
  volume: string,
  spec: ScannerSpec,
  vars: Record<string, string>,
  timeoutMs: number,
  dataDir: string,
): Promise<CheckOutcome> {
  const redact = redactor(Object.values(vars));
  let envFile: string | undefined;
  try {
    if (Object.keys(vars).length > 0) {
      try {
        const dir = path.join(dataDir, "tmp");
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        // Named before the write: a write that fails part-way can leave the file, and the `finally` removes it.
        envFile = path.join(dir, newEnvFileName());
        fs.writeFileSync(envFile, Object.entries(vars).map(([k, v]) => `${k}=${v}\n`).join(""), { flag: "wx", mode: 0o600 });
      } catch {
        return outcome(spec, "failed", "the credentials file for the scanner could not be written");
      }
    }
    let res: RunResult;
    try {
      res = await docker.runScanner(volume, spec, { timeoutMs, envFile });
    } catch (e) {
      if (e instanceof SandboxRefusedError || e instanceof VolumeNotUsableError) throw e;
      return outcome(spec, "failed", "Docker did not answer");
    }
    return interpret(spec, res, timeoutMs, redact);
  } finally {
    if (envFile !== undefined) {
      try {
        fs.rmSync(envFile, { force: true });
      } catch {
        /* the startup sweep of env files removes it later */
      }
    }
  }
}

function interpret(spec: ScannerSpec, res: RunResult, timeoutMs: number, redact: (text: string) => string): CheckOutcome {
  // Redacted before it is cut, so a value is never half in and half out of the tail.
  const tail = oneLine(redact(res.stderr).slice(-STDERR_TAIL), STDERR_TAIL);
  const failed = (reason: string): CheckOutcome => outcome(spec, "failed", redact(tail ? `${reason}: ${tail}` : reason));
  if (res.timedOut) return failed(`timed out after ${Math.round(timeoutMs / 1000)} s`);
  if (res.truncated) return failed("output over 8 MB");
  // The exit code is ignored: scanners exit non-zero when they find something.
  const parsed = parseSarif(redact(res.stdout), spec.name);
  if (!parsed.ok) return failed(parsed.reason);
  const clean = (f: Finding): Finding => ({
    ...f,
    ruleId: redact(f.ruleId),
    message: redact(f.message),
    ...(f.location !== undefined ? { location: redact(f.location) } : {}),
  });
  return {
    name: spec.name,
    kind: "scanner",
    status: "ran",
    counts: parsed.counts,
    findings: parsed.findings.map(clean),
    omitted: parsed.omitted,
    notes: parsed.notes.map(redact),
  };
}

/** Replaces each value of 4 characters or more, and its whitespace-flattened form, with `[redacted]`; the longest first. */
function redactor(values: string[]): (text: string) => string {
  const needles = new Set<string>();
  for (const v of values) {
    if (v.length >= MIN_SECRET) needles.add(v);
    const flat = v.replace(/\s+/g, " ").trim();
    if (flat.length >= MIN_SECRET) needles.add(flat);
  }
  const ordered = [...needles].sort((a, b) => b.length - a.length);
  return (text) => ordered.reduce((t, n) => t.split(n).join("[redacted]"), text);
}
