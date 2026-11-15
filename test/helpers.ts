import type { ProjectRecord } from "../src/types.js";

/** A minimal ready project record for tests. */
export function record(slug: string, repoPath = `owner/${slug}`): ProjectRecord {
  return {
    slug,
    repo: { forge: "github", host: "github.com", path: repoPath, cloneUrl: `https://github.com/${repoPath}.git`, id: `github:${repoPath}`, name: slug },
    image: "img",
    container: `mcpe-${slug}`,
    volume: `mcpe-${slug}`,
    ecosystems: ["generic"],
    primary: "generic",
    network: false,
    status: "ready",
    warnings: [],
    commands: [],
    tools: [],
    meta: { npmScripts: [], makeTargets: [], pythonModules: [], nodePackages: [], hasPythonEnv: false, hasNode: false },
    installedAt: "2026-01-01T00:00:00.000Z",
  };
}
