import fs from "node:fs";
import path from "node:path";

/**
 * The source files that hold the `Docker` class and the `Containment` class, as lists, so that a test which reads them as text
 * (or collects their members) keeps working when a class is split over several files: add the new file to its list.
 * Paths are relative to the repository root.
 */

export const ROOT = path.resolve(import.meta.dirname, "..");

/** The files that make up the `Docker` class and its module-level helpers. */
export const DOCKER_SOURCES: readonly string[] = [
  "src/sandbox/scripts.ts",
  "src/sandbox/ownership.ts",
  "src/sandbox/errors.ts",
  "src/sandbox/network-spec.ts",
  "src/sandbox/docker-base.ts",
  "src/sandbox/docker-network.ts",
  "src/sandbox/docker.ts",
];

/** The files that make up the `Containment` class and its module-level helpers. */
export const CONTAINMENT_SOURCES: readonly string[] = ["src/network/containment.ts", "src/network/containment-core.ts", "src/network/project-lock.ts"];

/** The classes whose members the no-bypass test collects, as `{ file, className }`; `Docker` first, then any class it is split into. */
export const DOCKER_CLASSES: ReadonlyArray<{ file: string; className: string }> = [
  { file: "src/sandbox/docker.ts", className: "Docker" },
  { file: "src/sandbox/docker-network.ts", className: "DockerNetwork" },
  { file: "src/sandbox/docker-base.ts", className: "DockerBase" },
];

/**
 * The own property names along a prototype chain, up to but not including `Object.prototype`, each once (`constructor` left out), so that a
 * base class holding some of the methods counts too. `keep` filters by descriptor.
 */
export function prototypeChainNames(start: object, keep: (d: PropertyDescriptor) => boolean = () => true): string[] {
  const names = new Set<string>();
  for (let p: object | null = start; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const n of Object.getOwnPropertyNames(p)) if (n !== "constructor" && keep(Object.getOwnPropertyDescriptor(p, n)!)) names.add(n);
  }
  return [...names];
}

/** The text of the files, joined by a newline, in list order. */
export function readSources(files: readonly string[]): string {
  return files.map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
}
