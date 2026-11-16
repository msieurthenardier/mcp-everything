import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

const readJson = (rel: string) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), "utf8"));

describe("VERSION", () => {
  it("equals the version in package.json and in package-lock.json", () => {
    const pkg = readJson("../package.json");
    const lock = readJson("../package-lock.json");
    expect(VERSION).toBe(pkg.version);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
  });
});
