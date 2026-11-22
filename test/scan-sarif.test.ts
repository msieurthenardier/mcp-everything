import { describe, expect, it } from "vitest";
import { parseSarif } from "../src/scan/sarif.js";

const sarif = (runs: unknown[], version: unknown = "2.1.0") => JSON.stringify({ version, runs });
const run = (results: unknown[], rules?: unknown[]) => ({ tool: { driver: { name: "t", ...(rules ? { rules } : {}) } }, results });
const ok = (text: string) => {
  const r = parseSarif(text, "trivy");
  if (!r.ok) throw new Error(`not ok: ${r.reason}`);
  return r;
};

describe("parseSarif: refusal", () => {
  it.each([
    ["not json", "hello"],
    ["empty", ""],
    ["an array", "[]"],
    ["null", "null"],
    ["a string", '"x"'],
    ["wrong version", sarif([], "2.0.0")],
    ["numeric version", sarif([], 2.1)],
    ["no version", JSON.stringify({ runs: [] })],
    ["runs not an array", JSON.stringify({ version: "2.1.0", runs: {} })],
    ["no runs", JSON.stringify({ version: "2.1.0" })],
  ])("%s -> ok false with a short reason", (_n, text) => {
    const r = parseSarif(text, "trivy");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeLessThan(60);
  });
  it("never quotes the input or JSON.parse's message", () => {
    const text = '{"a": "\u001b[31msecret-marker\\u001b[0m", oops}';
    const r = parseSarif(text, "x");
    expect(r).toEqual({ ok: false, reason: "output is not valid JSON" });
    const msg = (() => {
      try {
        JSON.parse(text);
      } catch (e) {
        return (e as Error).message;
      }
      return "";
    })();
    expect(msg).not.toBe("");
    if (!r.ok) {
      expect(r.reason).not.toContain("secret-marker");
      expect(r.reason).not.toContain("\u001b");
      expect(r.reason).not.toContain(msg);
    }
  });
  it("handles deeply nested JSON without throwing", () => {
    const deep = "[".repeat(200_000) + "]".repeat(200_000);
    expect(() => parseSarif(deep, "x")).not.toThrow();
    expect(parseSarif(deep, "x").ok).toBe(false);
  });
  it("runs: [] is ok with zero counts", () => {
    expect(ok(sarif([]))).toEqual({ ok: true, counts: { error: 0, warning: 0, note: 0 }, findings: [], omitted: 0, notes: [] });
  });
});

describe("parseSarif: which results count", () => {
  it("skips pass, notApplicable, informational and suppressed, and says how many", () => {
    const r = ok(
      sarif([
        run([
          { ruleId: "a", level: "error", kind: "pass" },
          { ruleId: "b", level: "error", kind: "notApplicable" },
          { ruleId: "c", level: "error", kind: "informational" },
          { ruleId: "d", level: "error", suppressions: [{ kind: "inSource", status: "accepted" }] },
          { ruleId: "e", level: "error", suppressions: [{ kind: "inSource" }] },
          { ruleId: "f", level: "error", suppressions: [{ status: "rejected" }] },
          { ruleId: "g", level: "error", suppressions: [] },
          { ruleId: "h", level: "error", kind: "fail" },
          { ruleId: "i", level: "error", kind: "review" },
        ]),
      ]),
    );
    expect(r.counts.error).toBe(4);
    expect(r.notes).toEqual(["5 results were suppressed or not failures and were not counted"]);
  });
  it("uses the result level, then the rule default by index, then by id, then warning", () => {
    const rules = [{ id: "r0", defaultConfiguration: { level: "error" } }, { id: "r1", defaultConfiguration: { level: "note" } }, { id: "r2" }];
    const r = ok(
      sarif([
        run(
          [
            { ruleId: "x", level: "note", ruleIndex: 0 }, // note
            { ruleId: "x", ruleIndex: 0 }, // error by index
            { ruleId: "r1" }, // note by id
            { ruleId: "r1", ruleIndex: 99 }, // out of range -> id -> note
            { ruleId: "r1", ruleIndex: -1 }, // note
            { ruleId: "r2" }, // rule without a level -> warning
            { ruleId: "missing" }, // warning
            {}, // warning
            { ruleId: "r1", ruleIndex: "0" }, // note by id
          ],
          rules,
        ),
      ]),
    );
    expect(r.counts).toEqual({ error: 1, warning: 3, note: 5 });
  });
  it("does not count level none", () => {
    const r = ok(sarif([run([{ level: "none" }, { ruleId: "r", ruleIndex: 0 }], [{ id: "r", defaultConfiguration: { level: "none" } }])]));
    expect(r.counts).toEqual({ error: 0, warning: 0, note: 0 });
  });
  it("counts a level SARIF does not define as warning, with a note", () => {
    const r = ok(sarif([run([{ level: "critical" }, { level: 5 }, { level: "ERROR" }, { level: "error" }], [])]));
    expect(r.counts).toEqual({ error: 1, warning: 3, note: 0 });
    expect(r.notes).toEqual(["3 results had a level SARIF does not define and were counted as warning"]);
  });
  it("also counts an undefined rule default level as warning, with the note", () => {
    const r = ok(sarif([run([{ ruleId: "r" }], [{ id: "r", defaultConfiguration: { level: "severe" } }])]));
    expect(r.counts.warning).toBe(1);
    expect(r.notes).toHaveLength(1);
  });
  it("counts every result of every run", () => {
    const r = ok(sarif([run([{ level: "error" }]), run([{ level: "error" }, { level: "note" }])]));
    expect(r.counts).toEqual({ error: 2, warning: 0, note: 1 });
  });
  it("does not read inherited properties", () => {
    const text = '{"version":"2.1.0","runs":[{"results":[{"__proto__":{"level":"error"},"level":"note"}]}]}';
    expect(ok(text).counts).toEqual({ error: 0, warning: 0, note: 1 });
  });
});

describe("parseSarif: findings", () => {
  it("builds a finding with rule id, message, location and severity", () => {
    const r = ok(
      sarif([
        run([
          {
            ruleId: "CVE-1",
            level: "error",
            message: { text: "bad thing" },
            locations: [{ physicalLocation: { artifactLocation: { uri: "src/a.js" }, region: { startLine: 12 } } }],
            properties: { "security-severity": 9.8 },
          },
        ]),
      ]),
    );
    expect(r.findings).toEqual([
      { check: "trivy", ruleId: "CVE-1", level: "error", message: "bad thing", location: "src/a.js:12", securitySeverity: "9.8" },
    ]);
    expect(r.omitted).toBe(0);
  });
  it("defaults missing pieces and ignores bad ones", () => {
    const r = ok(
      sarif([
        run([
          { level: "error" },
          { level: "error", message: { markdown: "md" }, locations: [{ physicalLocation: { artifactLocation: { uri: "f" }, region: { startLine: 0 } } }] },
          { level: "error", message: { text: 5 }, locations: "nope" },
          { level: "error", message: "str", locations: [{ physicalLocation: { artifactLocation: { uri: "g" }, region: { startLine: 1.5 } } }], properties: { "security-severity": {} } },
          "junk",
          null,
          7,
          { level: "error", locations: [null], properties: [] },
        ]),
      ]),
    );
    expect(r.findings.map((f) => [f.ruleId, f.message, f.location, f.securitySeverity])).toEqual([
      ["(no rule id)", "(no message)", undefined, undefined],
      ["(no rule id)", "md", "f", undefined],
      ["(no rule id)", "(no message)", undefined, undefined],
      ["(no rule id)", "(no message)", "g", undefined],
      ["(no rule id)", "(no message)", undefined, undefined],
    ]);
  });
  it("skips malformed runs and results members without throwing", () => {
    const r = ok(JSON.stringify({ version: "2.1.0", runs: [null, 3, {}, { results: {} }, { results: [{ level: "note" }], tool: 5 }] }));
    expect(r.counts.note).toBe(1);
  });
  it("cleans every string to one line within its cap", () => {
    const r = ok(
      sarif([
        run([
          {
            ruleId: "\u001b[31mred\u001b[0m\nline2\u0007",
            level: "error",
            message: { text: "\u001b[31mred\u001b[0m\nline2\u0007" },
            locations: [{ physicalLocation: { artifactLocation: { uri: "a\nb\u001b[0m" } } }],
            properties: { "security-severity": "\u001b[1m7.5\u001b[0m\n" },
          },
        ]),
      ]),
    );
    const f = r.findings[0]!;
    expect(f.ruleId).toBe("red line2");
    expect(f.message).toBe("red line2");
    expect(f.location).toBe("a b");
    expect(f.securitySeverity).toBe("7.5");
  });
  it("caps rule id 80, message 200, location 120, severity 16", () => {
    const long = "x".repeat(5000);
    const r = ok(
      sarif([
        run([
          {
            ruleId: long,
            level: "error",
            message: { text: long },
            locations: [{ physicalLocation: { artifactLocation: { uri: long }, region: { startLine: 3 } } }],
            properties: { "security-severity": long },
          },
        ]),
      ]),
    );
    const f = r.findings[0]!;
    expect(f.ruleId).toHaveLength(80);
    expect(f.message).toHaveLength(200);
    expect(f.location!.length).toBeLessThanOrEqual(120);
    expect(f.securitySeverity).toHaveLength(16);
  });
  it("keeps the line number when a long uri is cut", () => {
    const r = ok(sarif([run([{ level: "error", locations: [{ physicalLocation: { artifactLocation: { uri: "u".repeat(500) }, region: { startLine: 42 } } }] }])]));
    expect(r.findings[0]!.location!.length).toBeLessThanOrEqual(120);
    expect(r.findings[0]!.location!.endsWith(":42")).toBe(true);
  });
});

describe("parseSarif: bounds", () => {
  it("keeps at most 20 findings, highest level first then input order, with exact counts", () => {
    const results: unknown[] = [];
    for (let i = 0; i < 30; i++) results.push({ ruleId: `n${i}`, level: "note" });
    for (let i = 0; i < 25; i++) results.push({ ruleId: `w${i}`, level: "warning" });
    for (let i = 0; i < 5; i++) results.push({ ruleId: `e${i}`, level: "error" });
    const r = ok(sarif([run(results)]));
    expect(r.counts).toEqual({ error: 5, warning: 25, note: 30 });
    expect(r.findings).toHaveLength(20);
    expect(r.omitted).toBe(40);
    expect(r.findings.slice(0, 5).map((f) => f.ruleId)).toEqual(["e0", "e1", "e2", "e3", "e4"]);
    expect(r.findings.slice(5).map((f) => f.ruleId)).toEqual(Array.from({ length: 15 }, (_, i) => `w${i}`));
  });
  it("omitted is zero at or under 20", () => {
    const r = ok(sarif([run(Array.from({ length: 20 }, () => ({ level: "note" })))]));
    expect(r.findings).toHaveLength(20);
    expect(r.omitted).toBe(0);
  });
  it("a 1 MB message costs little and is capped", () => {
    const t0 = performance.now();
    const r = ok(sarif([run([{ level: "error", message: { text: "y".repeat(1_000_000) } }])]));
    expect(r.findings[0]!.message).toHaveLength(200);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
  it("parses 8 MB of empty results in under 3 s", () => {
    const body = "{},".repeat(2_800_000) + "{}";
    const text = `{"version":"2.1.0","runs":[{"results":[${body}]}]}`;
    expect(text.length).toBeGreaterThanOrEqual(8_000_000);
    const t0 = performance.now();
    const r = ok(text);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(r.counts.warning).toBe(2_800_001);
    expect(r.findings).toHaveLength(20);
    expect(r.omitted).toBe(2_800_001 - 20);
  });
  it("looks rules up through a map, not a scan per result", () => {
    const rules = Array.from({ length: 20_000 }, (_, i) => ({ id: `r${i}`, defaultConfiguration: { level: "note" } }));
    const results = Array.from({ length: 20_000 }, (_, i) => ({ ruleId: `r${19_999 - i}` }));
    const t0 = performance.now();
    const r = ok(sarif([run(results, rules)]));
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(r.counts.note).toBe(20_000);
  });
});
