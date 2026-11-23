import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ECOSYSTEM_HOSTS, EVERY_BUILD_HOSTS } from "../src/network/defaults.js";

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
  it("documents a scanner's entrypoint", () => {
    expect(section("Checking projects before they run")).toContain("`entrypoint`");
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

describe("the README and the network containment code agree", () => {
  const NETWORK_NAME = /MCPE_(?:NETWORK\w*|LOCAL_ACCESS\w*|PROXY_IMAGE\w*)/;
  const cfg = loadConfig({ HOME: "/nonexistent", MCPE_DATA_DIR: "/nonexistent" });

  it("lists every MCPE_NETWORK*, MCPE_LOCAL_ACCESS and MCPE_PROXY_IMAGE variable loadConfig reads in the Configuration table, and nothing else of those", () => {
    const listed = section("Configuration")
      .split("\n")
      .map((l) => new RegExp(`^\\| \`(${NETWORK_NAME.source})\``).exec(l)?.[1])
      .filter((n): n is string => n !== undefined);
    const read = [...configSource.matchAll(new RegExp(`env\\.(${NETWORK_NAME.source})`, "g"))].map((m) => m[1]!);
    expect(read.length).toBeGreaterThan(0);
    expect([...new Set(listed)].sort()).toEqual([...new Set(read)].sort());
    expect(listed.length).toBe(new Set(listed).size);
  });
  it("states the defaults loadConfig gives", () => {
    const table = section("Configuration");
    expect(cfg.network.mode).toBe("open");
    expect(table).toMatch(new RegExp(`\\| \`MCPE_NETWORK\` \\| \`${cfg.network.mode}\` \\|`));
    expect(table).toMatch(new RegExp(`\\| \`MCPE_PROXY_IMAGE\` \\| \`${cfg.docker.proxyImage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\` \\|`));
    expect(table).toMatch(/\| `MCPE_LOCAL_ACCESS` \| none \|/);
    expect(Object.keys(cfg.network.localAccess)).toEqual([]);
  });
  it("has the Network containment section between the check section and the security model", () => {
    const check = readme.indexOf("\n## Checking projects before they run\n");
    const containment = readme.indexOf("\n## Network containment\n");
    const model = readme.indexOf("\n## Security model\n");
    expect(check).toBeGreaterThan(0);
    expect(containment).toBeGreaterThan(check);
    expect(model).toBeGreaterThan(containment);
  });
  it("names set_project_hosts and the hosts parameter among the built-in tools", () => {
    const tools = section("Built-in tools");
    expect(tools).toContain("`set_project_hosts`");
    expect(tools).toMatch(/`install_project`[^\n]*`hosts`/);
  });
  it("accepts the MCPE_LOCAL_ACCESS example it gives", () => {
    const m = /MCPE_LOCAL_ACCESS="([^"]+)"/.exec(section("Network containment"));
    expect(m, "the section has an MCPE_LOCAL_ACCESS example").not.toBeNull();
    const c = loadConfig({ HOME: "/nonexistent", MCPE_DATA_DIR: "/nonexistent", MCPE_LOCAL_ACCESS: m![1]! });
    expect(Object.keys(c.network.localAccess).length).toBeGreaterThan(0);
  });

  describe("the default host table", () => {
    const text = section("Network containment");
    const start = text.indexOf("\n### The default hosts\n");
    const body = text.slice(start, text.indexOf("\n### ", start + 1));
    /** Row cells of the table in that subsection, without the header and the divider. */
    const rows = body
      .split("\n")
      .filter((l) => l.startsWith("| ") && !l.startsWith("| Build system") && !l.startsWith("| ---"))
      .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
    const ticks = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);

    it("exists, with one row for every build and one per ecosystem group", () => {
      expect(start).toBeGreaterThanOrEqual(0);
      expect(rows.length).toBeGreaterThan(1);
      for (const r of rows) expect(r).toHaveLength(2);
    });
    it("lists every host of src/network/defaults.ts and no host the code lacks (computed from the module)", () => {
      const inCode = [...EVERY_BUILD_HOSTS, ...Object.values(ECOSYSTEM_HOSTS).flat()];
      const inReadme = rows.flatMap((r) => ticks(r[1]!));
      expect([...new Set(inReadme)].sort()).toEqual([...new Set(inCode)].sort());
      expect(inReadme.length).toBe(new Set(inReadme).size);
    });
    it("puts every host in the row of the build system the code gives it", () => {
      const every = rows.find((r) => r[0] === "Every build");
      expect(every).toBeDefined();
      expect(ticks(every![1]!).sort()).toEqual([...EVERY_BUILD_HOSTS].sort());
      for (const [eco, hosts] of Object.entries(ECOSYSTEM_HOSTS)) {
        const row = rows.find((r) => ticks(r[0]!).includes(eco));
        expect(row, `a row names ${eco}`).toBeDefined();
        expect(ticks(row![1]!).sort(), eco).toEqual([...hosts].sort());
      }
    });
  });
});

describe("the README and the dependency check agree", () => {
  const checking = section("Checking projects before they run");
  const dependencySection = checking.slice(checking.indexOf("### The dependency check"), checking.indexOf("### The tool-description check"));
  it("has a section that says what it asks, of whom, and when, including check_project with scanning off", () => {
    expect(dependencySection).toContain("api.osv.dev");
    expect(dependencySection).toContain("GitHub");
    expect(dependencySection).toMatch(/`check_project` \*\*whatever `MCPE_SCAN` says\*\*/);
    expect(dependencySection).toContain("`malicious-package`");
    expect(dependencySection).toContain("`vulnerable-package`");
    expect(dependencySection).toMatch(/Ranges are not looked up/);
    expect(dependencySection).toMatch(/Workflow actions .* are not\s+checked/);
    expect(dependencySection).toMatch(/pinned `ref`/);
    expect(dependencySection).toContain("`GITHUB_TOKEN`");
    expect(dependencySection).toContain("github.com");
  });
  it("warns about block at warning and at note, and no longer says the built-in check can never block", () => {
    expect(checking).toMatch(/Blocking at `warning`\*\* also blocks any GitHub repository with a\s+known-vulnerable dependency/);
    expect(checking).toMatch(/Blocking at `note`\*\* blocks every project/);
    expect(checking).not.toContain("can never block anything");
  });
  it("says what reaches outside services, and what the graph misses", () => {
    const outside = readme.slice(readme.indexOf("### What reaches outside services"));
    expect(outside).toContain("`api.github.com`");
    expect(outside).toContain("not narrowed by containment");
    expect(outside).toContain("whatever `MCPE_SCAN` says");
    expect(checking).toMatch(/What the dependency graph misses/);
  });
});

describe("the README and the tool-description check agree", () => {
  const checking = section("Checking projects before they run");
  const start = checking.indexOf("### The tool-description check");
  const text = checking.slice(start, checking.indexOf("### What none of this protects against"));
  it("has the section, between the dependency check and what none of this protects against", () => {
    expect(start).toBeGreaterThan(checking.indexOf("### The dependency check"));
    expect(text).toContain("`tool-descriptions`");
  });
  it("says when it runs and what it reads, and that check_project does not run it", () => {
    expect(text).toMatch(/end of every discovery, while `MCPE_SCAN` is not\s+`off`/);
    expect(text).toContain("`refresh_mcp`");
    expect(text).toMatch(/`check_project` does not run it either/);
    expect(text).toMatch(/every tool in the catalog, published or not/);
  });
  it("lists the rules by level, and that a proxied server's own tool name is exempt from the last error rule", () => {
    expect(text).toMatch(/`error`: hidden characters/);
    expect(text).toMatch(/`warning`: invisible characters/);
    expect(text).toMatch(/own tool name is exempt/);
    expect(text).toMatch(/does not quote|never quote the text they matched/);
  });
  it("says what block withholds, that select_project_tools cannot bring it back, and that other sessions republish it", () => {
    expect(text).toMatch(/\*\*withheld\*\*/);
    expect(text).toMatch(/`select_project_tools` cannot bring a withheld tool back/);
    expect(text).toMatch(/`off` or\s+`warn` republishes what a `block` session withheld/);
    expect(text).toMatch(/The check failing never withholds anything/);
  });
  it("says it is a reading aid that can be evaded and can misfire", () => {
    expect(text).toMatch(/reading aid/);
    expect(text).toMatch(/evaded/);
    expect(text).toMatch(/misfire/);
  });
  it("says in the tools table that find_project_tools leaves withheld tools out, and that the check never blocks an install", () => {
    expect(section("Built-in tools")).toContain("except tools withheld by the tool-description check");
    expect(checking).toMatch(/never blocks an install, whatever the level: under `block` it withholds tools/);
  });
});
