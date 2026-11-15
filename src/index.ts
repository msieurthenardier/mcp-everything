#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { App, prepareDataDir } from "./server.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  prepareDataDir(cfg.dataDir);
  // stdout carries the MCP protocol; diagnostics go to stderr.
  const app = new App({ cfg, log: (line) => process.stderr.write(`[mcp-everything] ${line}\n`) });
  app.start();
  await app.server.connect(new StdioServerTransport());
  const shutdown = () => {
    void app
      .shutdown()
      .then(() => app.server.close())
      .finally(() => process.exit(0));
  };
  // The client hanging up (stdin closing) must also stop proxied servers.
  process.stdin.on("end", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  process.stderr.write(`[mcp-everything] fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
