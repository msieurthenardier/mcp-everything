import { describe, expect, it } from "vitest";
import { decide, emptyCounts, totalCounts, unreachableBlock } from "../src/scan/policy.js";
import { LEVELS, levelAtLeast, type CheckOutcome, type Level, type ScannerSpec } from "../src/scan/types.js";

const check = (name: string, status: CheckOutcome["status"], counts: Partial<Record<Level, number>> = {}, notes: string[] = []): CheckOutcome => ({
  name,
  kind: name === "build-hooks" ? "builtin" : "scanner",
  status,
  counts: { ...emptyCounts(), ...counts },
  findings: [],
  omitted: 0,
  notes,
});

describe("levels", () => {
  it("orders highest first", () => {
    expect(LEVELS).toEqual(["error", "warning", "note"]);
    expect(levelAtLeast("error", "warning")).toBe(true);
    expect(levelAtLeast("warning", "warning")).toBe(true);
    expect(levelAtLeast("note", "warning")).toBe(false);
    expect(levelAtLeast("warning", "error")).toBe(false);
  });
});

describe("counts", () => {
  it("emptyCounts and totalCounts", () => {
    expect(emptyCounts()).toEqual({ error: 0, warning: 0, note: 0 });
    const t = totalCounts([check("a", "ran", { error: 1, note: 2 }), check("b", "failed", { error: 5 }), check("c", "incomplete", { warning: 3 })]);
    expect(t).toEqual({ error: 6, warning: 3, note: 2 });
    expect(totalCounts([check("a", "ran", { error: 1 }), check("b", "failed", { error: 5 })], ["ran"])).toEqual({ error: 1, warning: 0, note: 0 });
  });
});

describe("decide", () => {
  it("off builds and says scanning is off, keeping blockAt", () => {
    const d = decide("off", "warning", [check("a", "ran", { error: 9 })]);
    expect(d).toEqual({ mode: "off", blockAt: "warning", verdict: "build", reason: "scanning is off" });
  });

  it("warn builds, with counts across ran and incomplete checks", () => {
    const d = decide("warn", "error", [check("a", "ran", { error: 2 }), check("b", "incomplete", { warning: 1, note: 4 }), check("c", "failed", { error: 7 })]);
    expect(d.verdict).toBe("build");
    expect(d.blockAt).toBe("error");
    expect(d.reason).toContain("2 error, 1 warning, 4 note");
    expect(d.reason).toContain("c failed and was not counted");
  });

  // mode block x blockAt x (a check at each level, failed, not-run, incomplete)
  const statuses: CheckOutcome["status"][] = ["ran", "incomplete", "failed", "not-run"];
  describe.each(["error", "warning", "note"] as Level[])("block at %s", (blockAt) => {
    for (const status of statuses) {
      for (const level of LEVELS) {
        const counted = status === "ran" || status === "incomplete";
        const expectBlock = counted && levelAtLeast(level, blockAt);
        it(`${status} check with one ${level} -> ${expectBlock ? "block" : "build"}`, () => {
          const d = decide("block", blockAt, [check("trivy", status, { [level]: 1 })]);
          expect(d.verdict).toBe(expectBlock ? "block" : "build");
          expect(d.blockAt).toBe(blockAt);
          if (expectBlock) expect(d.reason).toBe(`1 finding at ${blockAt} or above, from trivy`);
          if (status === "failed") expect(d.reason).toContain("trivy failed and was not counted");
          if (status === "not-run") expect(d.reason).toContain("trivy did not run and was not counted");
        });
      }
    }
    it("an empty set of checks builds", () => expect(decide("block", blockAt, []).verdict).toBe("build"));
  });

  it("names every blocking check and sums its findings", () => {
    const d = decide("block", "error", [check("trivy", "ran", { error: 1 }), check("semgrep", "incomplete", { error: 1 }), check("clean", "ran")]);
    expect(d.reason).toBe("2 findings at error or above, from trivy, semgrep");
  });

  it("notes count only when blockAt is note", () => {
    const hooks = check("build-hooks", "ran", {}, ["dependencies' build code is not listed"]);
    expect(decide("block", "note", [hooks]).verdict).toBe("block");
    expect(decide("block", "warning", [hooks]).verdict).toBe("build");
    expect(decide("block", "error", [hooks]).verdict).toBe("build");
    expect(decide("block", "note", [check("build-hooks", "failed", {}, ["x"])]).verdict).toBe("build");
  });
});

describe("unreachableBlock", () => {
  const spec: ScannerSpec = { name: "t", image: "i", command: ["c"], network: false, timeoutSec: 300, env: [] };
  it("speaks only for block at error with no scanners", () => {
    const s = unreachableBlock("error", []);
    expect(s).toMatch(/cannot block/);
    expect(unreachableBlock("error", [spec])).toBeUndefined();
    expect(unreachableBlock("warning", [])).toBeUndefined();
    expect(unreachableBlock("note", [])).toBeUndefined();
    expect(unreachableBlock("error", [], "warn")).toBeUndefined();
    expect(unreachableBlock("error", [], "off")).toBeUndefined();
  });
});
