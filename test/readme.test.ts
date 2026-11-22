import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const root = path.resolve(import.meta.dirname, "..");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const configSource = fs.readFileSync(path.join(root, "src", "config.ts"), "utf8");

/** The text of one `## ` section, up to the next one. */
function section(title: string): string {
  const start = readme.indexOf(`\n## ${title}\n`);
  expect(start, `README has a "${title}" section`).toBeGreaterThanOrEqual(0);
  const next = readme.indexOf("\n## ", start + 1);
  return readme.slice(start, next < 0 ? undefined : next);
}

const SCAN_VARIABLES = ["MCPE_SCAN", "MCPE_SCAN_BLOCK_AT", "MCPE_SCAN_TIMEOUT", "MCPE_SCANNERS"];

describe("the README and the code agree", () => {
  it.each(SCAN_VARIABLES)("names %s", (name) => {
    expect(readme).toContain(`\`${name}\``);
  });
  it("names the check tool", () => {
    expect(readme).toContain("`check_project`");
    expect(section("Built-in tools")).toContain("`check_project`");
  });
  it("has the new section before the security model", () => {
    expect(readme.indexOf("\n## Checking projects before they run\n")).toBeGreaterThan(0);
    expect(readme.indexOf("\n## Checking projects before they run\n")).toBeLessThan(readme.indexOf("\n## Security model\n"));
  });
  it("lists every MCPE_SCAN* variable of the Configuration table in loadConfig, and every one loadConfig reads in the table", () => {
    const rows = section("Configuration")
      .split("\n")
      .filter((l) => l.startsWith("| `MCPE_SCAN"));
    const listed = rows.map((l) => /^\| `(MCPE_SCAN\w*)`/.exec(l)![1]!);
    expect(listed.sort()).toEqual([...SCAN_VARIABLES].sort());
    for (const name of listed) expect(configSource).toContain(`env.${name}`);
    const read = [...configSource.matchAll(/env\.(MCPE_SCAN\w*)/g)].map((m) => m[1]!);
    expect([...new Set(read)].sort()).toEqual([...SCAN_VARIABLES].sort());
  });
  it("states the defaults and limits the code has", () => {
    const cfg = loadConfig({ HOME: "/nonexistent", MCPE_DATA_DIR: "/nonexistent" });
    const table = section("Configuration");
    expect(table).toMatch(new RegExp(`\\| \`MCPE_SCAN_TIMEOUT\` \\| \`${cfg.scan.timeoutSec}\` \\|`));
    expect(table).toMatch(new RegExp(`\\| \`MCPE_SCAN_BLOCK_AT\` \\| \`${cfg.scan.blockAt}\` \\|`));
    expect(table).toMatch(new RegExp(`\\| \`MCPE_SCAN\` \\| \`${cfg.scan.mode}\` \\|`));
    expect(table).toContain(`\`${cfg.docker.probeImage}\``);
    expect(table).not.toContain("alpine/git:latest");
  });
});
