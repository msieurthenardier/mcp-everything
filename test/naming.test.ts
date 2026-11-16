import { describe, expect, it } from "vitest";
import { makeSlug, makeToolName, MAX_TOOL_NAME, sanitizeIdent } from "../src/toolgen/naming.js";

const VALID = /^[a-z0-9_]+$/;

describe("sanitizeIdent", () => {
  it("lowercases and collapses punctuation", () => {
    expect(sanitizeIdent("My-Cool.Tool")).toBe("my_cool_tool");
    expect(sanitizeIdent("--weird--")).toBe("weird");
    expect(sanitizeIdent("日本語")).toBe("");
  });
});

describe("makeSlug", () => {
  const none = () => false;
  it("never returns a slug containing a double underscore", () => {
    const a = makeSlug("abc-defghij-klmnop", "owner2", (s) => s === "abc_defghij_klmnop");
    const b = makeSlug("cli", "abcdefghijk-lm", none);
    const c = makeSlug("abcdefghijklm-nop", "owner", (s) => s === "abcdefghijklm_nop" || s === "abcdefghijkl_owner");
    for (const s of [a, b, c]) expect(s).not.toContain("__");
    expect(a).toBe("abc_defghij_owner");
    expect(b).toBe("abcdefghijk_cli");
    expect(c).toBe("abcdefghijklm_2");
  });
  it("uses the repository name", () => {
    expect(makeSlug("ripgrep", "BurntSushi", none)).toBe("ripgrep");
    expect(makeSlug("Some.Repo-Name", "o", none)).toBe("some_repo_name");
  });
  it("adds the owner to generic names", () => {
    expect(makeSlug("cli", "httpie", none)).toBe("httpie_cli");
    expect(makeSlug("cli", "cli", none)).toBe("cli");
  });
  it("disambiguates collisions, first by owner then by number", () => {
    const taken = new Set(["ruff"]);
    const a = makeSlug("ruff", "someone", (s) => taken.has(s));
    expect(a).toBe("ruff_someo");
    taken.add(a);
    expect(makeSlug("ruff", "someone", (s) => taken.has(s))).toBe("ruff_2");
  });
  it("never returns an empty or oversized slug", () => {
    expect(makeSlug("日本語", "o", none)).toBe("o_project");
    expect(makeSlug("a".repeat(80), "o", none).length).toBeLessThanOrEqual(18);
  });
});

describe("makeToolName", () => {
  it("joins slug and command path", () => {
    expect(makeToolName("ruff", ["ruff", "check"], new Set())).toBe("ruff__ruff_check");
    expect(makeToolName("x", ["git-lfs", "ls-files"], new Set())).toBe("x__git_lfs_ls_files");
  });
  it("stays within the length limit with a stable hash suffix", () => {
    const parts = ["kubectl", "config", "set-credentials-for-something-long"];
    const a = makeToolName("kubernetes_project", parts, new Set());
    const b = makeToolName("kubernetes_project", parts, new Set());
    expect(a).toBe(b);
    expect(a.length).toBeLessThanOrEqual(MAX_TOOL_NAME);
    expect(a).toMatch(VALID);
  });
  it("keeps names unique within a set", () => {
    const used = new Set<string>();
    const names = [makeToolName("p", ["a-b"], used), makeToolName("p", ["a_b"], used), makeToolName("p", ["a.b"], used)];
    expect(new Set(names).size).toBe(3);
    for (const n of names) expect(n).toMatch(VALID);
  });
  it("falls back when nothing usable remains", () => {
    expect(makeToolName("p", ["***"], new Set())).toBe("p__run");
  });
});
