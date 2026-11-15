import { describe, expect, it } from "vitest";
import { parseHosts } from "../src/config.js";
import { parseRepoRef, validateGitRef } from "../src/forge/repo-ref.js";

const hosts = parseHosts("gitlab.gnome.org=gitlab");

describe("parseRepoRef", () => {
  it("defaults bare owner/name to GitHub", () => {
    expect(parseRepoRef("astral-sh/ruff", hosts)).toEqual({
      forge: "github",
      host: "github.com",
      path: "astral-sh/ruff",
      cloneUrl: "https://github.com/astral-sh/ruff.git",
      id: "github:astral-sh/ruff",
      name: "ruff",
    });
  });

  it("accepts forge prefixes and nested GitLab groups", () => {
    expect(parseRepoRef("github:BurntSushi/ripgrep", hosts).id).toBe("github:BurntSushi/ripgrep");
    const r = parseRepoRef("gitlab:gitlab-org/cli/glab", hosts);
    expect(r).toMatchObject({ forge: "gitlab", path: "gitlab-org/cli/glab", name: "glab" });
    expect(r.cloneUrl).toBe("https://gitlab.com/gitlab-org/cli/glab.git");
  });

  it("accepts web URLs with .git, tree paths, queries and www", () => {
    expect(parseRepoRef("https://github.com/psf/black.git", hosts).id).toBe("github:psf/black");
    expect(parseRepoRef("https://www.github.com/psf/black/tree/main/src?x=1#readme", hosts).id).toBe("github:psf/black");
    expect(parseRepoRef("https://gitlab.com/inkscape/inkscape/-/tree/master", hosts).id).toBe("gitlab:inkscape/inkscape");
  });

  it("accepts extra allow-listed hosts", () => {
    const r = parseRepoRef("https://gitlab.gnome.org/GNOME/gimp", hosts);
    expect(r).toMatchObject({ forge: "gitlab", host: "gitlab.gnome.org", id: "gitlab.gnome.org:GNOME/gimp" });
    expect(parseRepoRef("gitlab.gnome.org/GNOME/gimp", hosts).cloneUrl).toBe("https://gitlab.gnome.org/GNOME/gimp.git");
  });

  it.each([
    ["https://evil.example.com/a/b", /not an allowed forge/],
    ["git@github.com:a/b.git", /Unknown forge|Invalid/],
    ["ssh://git@github.com/a/b", /Only https/],
    ["file:///etc/passwd", /Only https/],
    ["https://user:pw@github.com/a/b", /Credentials/],
    ["--upload-pack=x/y", /Invalid repository path segment/],
    ["a/..", /Invalid repository path segment/],
    ["justaname", /owner\/name/],
    ["a/b c", /whitespace/],
    ["", /empty/],
  ])("rejects %s", (input, message) => {
    expect(() => parseRepoRef(input, hosts)).toThrow(message);
  });
});

describe("validateGitRef", () => {
  it("accepts branches, tags and shas", () => {
    for (const ref of ["main", "v1.2.3", "release/2.x", "0123abcd", "feature_x+y"]) expect(validateGitRef(ref)).toBe(ref);
  });
  it("rejects option-like and traversal refs", () => {
    for (const ref of ["-b", "--upload-pack=x", "a..b", "a b", "x.lock", ""]) expect(() => validateGitRef(ref)).toThrow();
  });
});

describe("parseHosts", () => {
  it("always includes github.com and gitlab.com and validates extras", () => {
    expect(parseHosts(undefined)).toEqual({ "github.com": "github", "gitlab.com": "gitlab" });
    expect(parseHosts("git.example.org")["git.example.org"]).toBe("gitlab");
    expect(() => parseHosts("bad host")).toThrow();
    expect(() => parseHosts("x.org=svn")).toThrow();
  });
});
