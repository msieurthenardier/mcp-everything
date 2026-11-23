import path from "node:path";
import { WORK_DIR, WORKSPACE } from "../sandbox/scripts.js";
import type { ToolDef } from "../types.js";

export interface Invocation {
  argv: string[];
  cwd: string;
  stdin?: string;
  timeoutSec?: number;
}

export class ToolInputError extends Error {}

/** Resolve a caller-supplied directory, confined to /workspace. */
export function resolveCwd(cwd: unknown, fallback: string): string {
  if (cwd === undefined || cwd === null || cwd === "") return fallback;
  if (typeof cwd !== "string") throw new ToolInputError("cwd must be a string");
  const resolved = path.posix.resolve(WORK_DIR, cwd);
  if (resolved !== WORKSPACE && !resolved.startsWith(`${WORKSPACE}/`)) {
    throw new ToolInputError(`cwd must stay inside ${WORKSPACE} (got "${cwd}")`);
  }
  return resolved;
}

function scalar(value: unknown, what: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  throw new ToolInputError(`${what} must be a string or number`);
}

function stringList(value: unknown, what: string): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) throw new ToolInputError(`${what} must be an array of strings`);
  return value.map((v, i) => scalar(v, `${what}[${i}]`));
}

/**
 * Turn validated tool input into an argv for the sandbox. Values are only
 * ever placed into argv slots; nothing here is interpreted by a shell.
 */
export function buildInvocation(tool: ToolDef, input: Record<string, unknown>): Invocation {
  const argv = [...tool.argv];
  const known = new Set(["args", "stdin", "cwd", "timeout_seconds"]);
  if (tool.valueProp) known.add(tool.valueProp);

  for (const opt of tool.options) {
    known.add(opt.prop);
    const value = input[opt.prop];
    if (value === undefined || value === null || value === false) continue;
    if (!opt.takesValue) {
      if (value !== true) throw new ToolInputError(`${opt.prop} is a flag; pass true to set it`);
      argv.push(opt.flag);
      continue;
    }
    if (opt.optionalValue && value === true) {
      argv.push(opt.flag);
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      const text = scalar(v, opt.prop);
      if (opt.choices && !opt.choices.includes(text)) {
        throw new ToolInputError(`${opt.prop} must be one of: ${opt.choices.join(", ")}`);
      }
      if (opt.optionalValue) argv.push(`${opt.flag}=${text}`);
      else argv.push(opt.flag, text);
    }
  }

  const unknown = Object.keys(input).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    const valid = [...known].sort().join(", ");
    throw new ToolInputError(
      `Unknown argument(s): ${unknown.join(", ")}. Valid arguments: ${valid}. Use "args" for anything else.`,
    );
  }

  if (tool.valueProp) {
    const value = input[tool.valueProp];
    if (value === undefined || value === null || value === "") {
      throw new ToolInputError(`${tool.valueProp} is required`);
    }
    const text = scalar(value, tool.valueProp);
    if (tool.kind === "script") {
      const allowed = (tool.inputSchema as { properties?: Record<string, { enum?: string[] }> }).properties?.[
        tool.valueProp
      ]?.enum;
      if (allowed && !allowed.includes(text)) {
        throw new ToolInputError(`${tool.valueProp} must be one of: ${allowed.join(", ")}`);
      }
    }
    argv.push(text);
  }

  argv.push(...stringList(input.args, "args"));

  let timeoutSec: number | undefined;
  if (input.timeout_seconds !== undefined && input.timeout_seconds !== null) {
    const n = Number(input.timeout_seconds);
    if (!Number.isFinite(n) || n <= 0) throw new ToolInputError("timeout_seconds must be a positive number");
    timeoutSec = Math.min(n, 3600);
  }

  let stdin: string | undefined;
  if (input.stdin !== undefined && input.stdin !== null) {
    if (typeof input.stdin !== "string") throw new ToolInputError("stdin must be a string");
    stdin = input.stdin;
  }

  return { argv, cwd: resolveCwd(input.cwd, tool.cwd), stdin, timeoutSec };
}
