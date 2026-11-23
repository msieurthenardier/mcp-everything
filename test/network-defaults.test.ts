import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_HOSTS_VERSION, ECOSYSTEM_HOSTS, EVERY_BUILD_HOSTS, buildHosts, cloneHosts, sandboxHosts } from "../src/network/defaults.js";
import { parseHostEntry } from "../src/network/hosts.js";
import { parseRepoRef } from "../src/forge/repo-ref.js";
import type { Ecosystem } from "../src/types.js";

describe("default host table", () => {
  it("pins the table to its version (bump DEFAULT_HOSTS_VERSION and this pair together)", () => {
    const canonical = JSON.stringify({
      every: [...EVERY_BUILD_HOSTS].sort(),
      eco: Object.fromEntries(Object.entries(ECOSYSTEM_HOSTS).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v].sort()])),
    });
    const hash = createHash("sha256").update(canonical).digest("hex");
    expect([DEFAULT_HOSTS_VERSION, hash]).toEqual([1, "337b81e3d318a732bb2ca266a694a53a8748699a0ded79cbd68be4bc1b3d1459"]);
  });

  it("parses every entry with the agent grammar", () => {
    const all = [...EVERY_BUILD_HOSTS, ...Object.values(ECOSYSTEM_HOSTS).flat()];
    expect(all.length).toBeGreaterThan(10);
    for (const h of all) expect(parseHostEntry(h, "agent").host).toBe(h);
  });

  it("buildHosts is every build's row plus the ecosystems', sorted and de-duplicated", () => {
    expect(buildHosts([])).toEqual([...EVERY_BUILD_HOSTS].sort());
    expect(buildHosts(["python"])).toEqual([...EVERY_BUILD_HOSTS, "pypi.org", "files.pythonhosted.org"].sort());
    const two = buildHosts(["go", "go", "ruby"]);
    expect(two).toEqual([...new Set(two)].sort());
    expect(two).toContain("proxy.golang.org");
    expect(two).toContain("rubygems.org");
    expect(two).toContain("deb.debian.org");
    expect(two).toContain("github.com");
  });

  it("sandboxHosts leaves out Debian and GitHub", () => {
    expect(sandboxHosts(["rust"])).toEqual(["crates.io", "index.crates.io", "static.crates.io", "static.rust-lang.org"]);
    expect(sandboxHosts(["node", "node"])).toEqual([...ECOSYSTEM_HOSTS.node].sort());
    expect(sandboxHosts([])).toEqual([]);
    expect(sandboxHosts(["go"])).not.toContain("github.com");
  });

  it.each<Ecosystem>(["cmake", "autotools", "make", "generic"])("%s adds nothing", (eco) => {
    expect(buildHosts([eco])).toEqual(buildHosts([]));
    expect(sandboxHosts([eco])).toEqual([]);
  });

  it("returns a fresh array each call", () => {
    const a = buildHosts(["python"]);
    a.push("evil.example");
    a.length = 0;
    expect(buildHosts(["python"])).toContain("pypi.org");
    const s = sandboxHosts(["python"]);
    s.length = 0;
    expect(sandboxHosts(["python"])).toHaveLength(2);
  });

  it("cloneHosts is the repository's forge", () => {
    expect(cloneHosts(parseRepoRef("o/r", { "github.com": "github", "gitlab.com": "gitlab" }))).toEqual(["github.com"]);
    expect(cloneHosts(parseRepoRef("gitlab:g/r", { "github.com": "github", "gitlab.com": "gitlab" }))).toEqual(["gitlab.com"]);
    expect(cloneHosts(parseRepoRef("git.example.com/g/r", { "github.com": "github", "git.example.com": "gitlab" }))).toEqual(["git.example.com"]);
  });
});
