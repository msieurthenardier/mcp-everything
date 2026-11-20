/**
 * Startup was refused because a setting or the data directory is invalid.
 * The message tells the operator what to fix, so the fatal handler prints it without a stack.
 */
export class ConfigError extends Error {}

/** The one stderr line for a fatal startup error: no stack for a ConfigError, the stack for anything unexpected. */
export function formatFatal(e: unknown): string {
  const detail = e instanceof ConfigError ? `${e.name}: ${e.message}` : e instanceof Error ? e.stack ?? e.message : String(e);
  return `[mcp-everything] fatal: ${detail}\n`;
}
