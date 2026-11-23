import type { Ecosystem, RepoRef } from "../types.js";

/**
 * The default host table (flight 02, DD5): what a contained build reaches without being told. It is a
 * starting table, measured and corrected in a later leg.
 *
 * Bump DEFAULT_HOSTS_VERSION on ANY change to the table below; a test pins the table's hash to the version.
 */
export const DEFAULT_HOSTS_VERSION = 1;

/** Every build: Debian's package servers (the recipes' `need` runs apt-get) and GitHub with its download hosts. */
export const EVERY_BUILD_HOSTS: readonly string[] = [
  "deb.debian.org",
  "security.debian.org",
  "github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
];

/** A `Record<Ecosystem, …>`, so a new ecosystem is a compile error until it has a row. */
export const ECOSYSTEM_HOSTS: Record<Ecosystem, readonly string[]> = {
  python: ["pypi.org", "files.pythonhosted.org"],
  node: ["registry.npmjs.org", "nodejs.org", "repo.yarnpkg.com", "registry.yarnpkg.com"],
  rust: ["crates.io", "index.crates.io", "static.crates.io", "static.rust-lang.org"],
  go: ["proxy.golang.org", "sum.golang.org"],
  ruby: ["rubygems.org", "index.rubygems.org"],
  cmake: [],
  autotools: [],
  make: [],
  generic: [],
};

function uniqueSorted(hosts: Iterable<string>): string[] {
  return [...new Set(hosts)].sort();
}

/** Every build's hosts plus the rows of `ecosystems`; sorted, de-duplicated, a fresh array. */
export function buildHosts(ecosystems: readonly Ecosystem[]): string[] {
  return uniqueSorted([...EVERY_BUILD_HOSTS, ...ecosystems.flatMap((e) => ECOSYSTEM_HOSTS[e])]);
}

/** Only the ecosystems' rows (no Debian, no GitHub); sorted, de-duplicated, a fresh array. */
export function sandboxHosts(ecosystems: readonly Ecosystem[]): string[] {
  return uniqueSorted(ecosystems.flatMap((e) => ECOSYSTEM_HOSTS[e]));
}

/** What a clone reaches: the repository's own forge. */
export function cloneHosts(repo: RepoRef): string[] {
  return [repo.host];
}
