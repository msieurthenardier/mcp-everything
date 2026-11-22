import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/errors.js";
import { parseScannersFile } from "../src/scan/scanners-file.js";

const entry = (over: Record<string, unknown> = {}) => ({ name: "trivy", image: "aquasec/trivy:0.50", command: ["trivy", "fs", "."], ...over });
const parse = (v: unknown) => parseScannersFile(typeof v === "string" ? v : JSON.stringify(v), "s.json");
const bad = (v: unknown, re: RegExp) => {
  expect(() => parse(v)).toThrow(ConfigError);
  expect(() => parse(v)).toThrow(re);
};

describe("parseScannersFile", () => {
  it("accepts an empty list and applies defaults", () => {
    expect(parse({ scanners: [] })).toEqual([]);
    expect(parse({ scanners: [entry()] })).toEqual([
      { name: "trivy", image: "aquasec/trivy:0.50", command: ["trivy", "fs", "."], network: false, timeoutSec: 300, env: [] },
    ]);
  });
  it("accepts every field", () => {
    const [s] = parse({ scanners: [entry({ network: true, timeout_seconds: 10, env: ["TOKEN", "_x1"], stage: "source" })] });
    expect(s).toMatchObject({ network: true, timeoutSec: 10, env: ["TOKEN", "_x1"] });
  });
  it("refuses text that is not JSON without quoting it", () => {
    try {
      parse("{\u001b[31m oops");
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe("s.json: not valid JSON");
    }
  });
  it.each([[[]], ["null"], ["3"], ['"x"']])("refuses a non-object top level %j", (v) => bad(v, /JSON object/));
  it("refuses other or missing top-level keys", () => {
    bad({ scanners: [], extra: 1 }, /unknown key "extra"/);
    bad({}, /"scanners" must be an array/);
    bad({ scanners: {} }, /"scanners" must be an array/);
    bad('{"__proto__":{"scanners":[]}}', /unknown key "__proto__"/);
  });
  it("allows 16 entries and refuses 17", () => {
    const many = (n: number) => ({ scanners: Array.from({ length: n }, (_, i) => entry({ name: `s${i}` })) });
    expect(parse(many(16))).toHaveLength(16);
    bad(many(17), /at most 16/);
  });
  it.each(["", "Trivy", "-a", "a_b", "a".repeat(33), "has space", 5, null])("refuses name %j", (name) => bad({ scanners: [entry({ name })] }, /scanners\[0\].*"name"/));
  it("accepts a 32-character name", () => expect(parse({ scanners: [entry({ name: "a".repeat(32) })] })).toHaveLength(1));
  it("refuses a duplicate and the reserved name, naming the entry", () => {
    bad({ scanners: [entry(), entry({ image: "x" })] }, /scanners\[1\] \(trivy\).*earlier/);
    bad({ scanners: [entry({ name: "build-hooks" })] }, /scanners\[0\] \(build-hooks\).*reserved/);
  });
  it.each(["", "-x", "a b", "a".repeat(202), 3, null])("refuses image %j", (image) => bad({ scanners: [entry({ image })] }, /"image"/));
  it("refuses a missing image", () => bad({ scanners: [{ name: "a", command: ["x"] }] }, /scanners\[0\] \(a\).*"image"/));
  it("validates command", () => {
    bad({ scanners: [entry({ command: [] })] }, /"command"/);
    bad({ scanners: [entry({ command: "trivy" })] }, /"command"/);
    bad({ scanners: [entry({ command: Array(65).fill("x") })] }, /"command"/);
    bad({ scanners: [entry({ command: ["a", 1] })] }, /"command"/);
    bad({ scanners: [entry({ command: ["x".repeat(4097)] })] }, /"command"/);
    bad({ scanners: [entry({ command: ["a\u0000b"] })] }, /"command"/);
    expect(parse({ scanners: [entry({ command: Array(64).fill("x".repeat(4096)) })] })).toHaveLength(1);
  });
  it("validates network, timeout_seconds, env and stage", () => {
    bad({ scanners: [entry({ network: "yes" })] }, /"network"/);
    for (const t of [9, 1801, 10.5, "30", null]) bad({ scanners: [entry({ timeout_seconds: t })] }, /"timeout_seconds"/);
    expect(parse({ scanners: [entry({ timeout_seconds: 1800 })] })[0]!.timeoutSec).toBe(1800);
    for (const e of ["A", [1], ["1A"], ["a-b"], [""], ["a".repeat(129)]]) bad({ scanners: [entry({ env: e })] }, /"env"/);
    bad({ scanners: [entry({ stage: "built" })] }, /"stage"/);
  });
  it("refuses unknown fields, including prototype-ish keys, and non-object entries", () => {
    bad({ scanners: [entry({ extra: 1 })] }, /scanners\[0\] \(trivy\).*unknown field "extra"/);
    bad({ scanners: [JSON.parse('{"__proto__": {"x": 1}, "name": "a", "image": "i", "command": ["c"]}')] }, /unknown field "__proto__"/);
    bad({ scanners: ["trivy"] }, /scanners\[0\].*object/);
    bad({ scanners: [null] }, /scanners\[0\].*object/);
  });
  it("does not read inherited values", () => {
    // `name` etc. must be own keys; an entry with only inherited-looking data is simply missing them.
    bad({ scanners: [{}] }, /"name"/);
  });
});
