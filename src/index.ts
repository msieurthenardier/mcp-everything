#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { App, prepareDataDir } from "./server.js";
import { runEntry, serveApp } from "./entry.js";
import { SHUTDOWN_DEADLINE_MS } from "./shutdown.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  prepareDataDir(cfg.dataDir);
  // stdout carries the MCP protocol; diagnostics go to stderr.
  const app = new App({ cfg, log: (line) => process.stderr.write(`[mcp-everything] ${line}\n`) });
  app.start();
  await runEntry({
    input: process.stdin,
    signals: process,
    exit: (code) => process.exit(code),
    app,
    serve: async () => serveApp(app),
    deadlineMs: SHUTDOWN_DEADLINE_MS,
    log: (line) => process.stderr.write(`[mcp-everything] ${line}\n`),
  });
}

main().catch((e) => {
  process.stderr.write(`[mcp-everything] fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
