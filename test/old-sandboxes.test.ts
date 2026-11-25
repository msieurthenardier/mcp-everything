import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeLeftPart } from "../src/install/installer.js";
import { BEFORE_NOTE, LABEL_MAX, removalCommands, SandboxRefusedError, type SandboxFacts } from "../src/sandbox/ownership.js";
import { ROOT } from "./sources.js";

const ID = "0123abcd";
const before = (kind: "container" | "volume", sandbox: string): SandboxFacts => ({ kind, sandbox, cls: "before" });
const mine = (kind: "container" | "volume", sandbox: string): SandboxFacts => ({ kind, sandbox, cls: "mine" });

const PROHIBITION = "Do not remove it yourself; ask the operator";
const CONFIRMS = "If the operator confirms it is this installation's and not wanted";

describe("the wording about a sandbox made before ownership was recorded", () => {
  it("every message carries the prohibition and no docker command", () => {
    const e = new SandboxRefusedError([before("container", "mcpe-old"), before("volume", "mcpe-old-vol")], ID);
    expect(e.message).toContain(BEFORE_NOTE);
    expect(e.message).toContain("this installation cannot tell whether it is its own and does not act on it");
    expect(e.message).toContain(PROHIBITION);
    expect(e.message).toContain("See project_info.");
    expect(e.message).not.toMatch(/docker (rm|volume)/);
    const left = describeLeftPart(before("container", "mcpe-old"));
    expect(left).toContain(PROHIBITION);
    expect(left).not.toMatch(/docker (rm|volume)/);
    expect(left).not.toContain("treated as");
  });

  it("the commands come only from removalCommands, after 'If the operator confirms'", () => {
    const text = removalCommands([before("container", "mcpe-old"), before("volume", "mcpe-old-vol")]);
    expect(text.startsWith(CONFIRMS)).toBe(true);
    expect(text).toBe(
      `${CONFIRMS}, they can run \`docker rm -f mcpe-old\` and \`docker volume rm mcpe-old-vol\`, then reinstall the project.`,
    );
    expect(text.indexOf("docker rm")).toBeGreaterThan(text.indexOf("If the operator confirms"));
  });

  it("names only the before parts, and nothing at all when no part is before", () => {
    expect(removalCommands([mine("container", "mcpe-a"), before("volume", "mcpe-v")])).toContain("`docker volume rm mcpe-v`");
    expect(removalCommands([mine("container", "mcpe-a"), before("volume", "mcpe-v")])).not.toContain("mcpe-a");
    expect(removalCommands([mine("container", "mcpe-a")])).toBe("");
    expect(removalCommands([{ kind: "volume", sandbox: "x", cls: "another", owner: "o" }])).toBe("");
  });

  it("a mixed list names the before part as the refused one", () => {
    const e = new SandboxRefusedError([mine("container", "mcpe-c"), before("volume", "mcpe-v")], ID);
    expect([e.kind, e.sandbox, e.reason]).toEqual(["volume", "mcpe-v", "before"]);
  });

  it("the reason is mapped from the class of the first refused part", () => {
    const reason = (f: SandboxFacts) => new SandboxRefusedError([f], ID).reason;
    expect(reason(before("container", "a"))).toBe("before");
    expect(reason({ kind: "container", sandbox: "a", cls: "another", owner: "o" })).toBe("another");
    expect(reason({ kind: "container", sandbox: "a", cls: "not-ours" })).toBe("not-ours");
  });
});

describe("the refusal message names each part once", () => {
  const BEFORE = "was made before ownership was recorded; this installation cannot tell whether it is its own and does not act on it. Do not remove it yourself; ask the operator";
  const msg = (...f: SandboxFacts[]) => new SandboxRefusedError(f, "e44f84eb").message;

  it("a sandbox made before ownership, as the operator saw it", () => {
    const m = msg({ kind: "container", sandbox: "mcpe-gron", project: "github:tomnomnom/gron", cls: "before" });
    expect(m).toBe(
      `Refusing to act on container "mcpe-gron" (project label "github:tomnomnom/gron"): it ${BEFORE}. This installation is e44f84eb. See project_info.`,
    );
    expect(m.split("mcpe-gron")).toHaveLength(2);
  });

  it("another installation's sandbox", () => {
    expect(msg({ kind: "container", sandbox: "mcpe-x", project: "p", cls: "another", owner: "other-id" })).toBe(
      'Refusing to act on container "mcpe-x" (project label "p"): it is another installation\'s (owner label "other-id"). This installation is e44f84eb.',
    );
  });

  it("a sandbox with no project label", () => {
    expect(msg({ kind: "container", sandbox: "mcpe-x", cls: "not-ours" })).toBe(
      'Refusing to act on container "mcpe-x" (no project label): it was not created by mcp-everything. This installation is e44f84eb.',
    );
  });

  it("a container and its volume are 'the container' and 'the volume'", () => {
    expect(msg({ kind: "container", sandbox: "mcpe-x", project: "p", cls: "mine" }, { kind: "volume", sandbox: "mcpe-x", cls: "before" })).toBe(
      `Refusing to act on container "mcpe-x" (project label "p") and volume "mcpe-x": the container is this installation's; the volume ${BEFORE}. This installation is e44f84eb. See project_info.`,
    );
  });

  it("two parts of one kind are told apart by name", () => {
    expect(
      msg(
        { kind: "container", sandbox: "mcpe-a", project: "p", cls: "not-ours" },
        { kind: "container", sandbox: "mcpe-b", project: "p", cls: "mine" },
      ),
    ).toBe(
      'Refusing to act on container "mcpe-a" (project label "p") and container "mcpe-b" (project label "p"): container "mcpe-a" was not created by mcp-everything; container "mcpe-b" is this installation\'s. This installation is e44f84eb.',
    );
  });
});

describe("the name grammar of a printed command", () => {
  const raw = (name: string) => removalCommands([before("container", name)]);

  it("prints a command for a name Docker accepts, up to LABEL_MAX characters", () => {
    expect(raw("a".repeat(LABEL_MAX))).toContain(`docker rm -f ${"a".repeat(LABEL_MAX)}`);
    expect(raw("mcpe_old.1-x")).toContain("`docker rm -f mcpe_old.1-x`");
  });

  it.each([
    ["a space", "mcpe old"],
    ["a leading hyphen", "-rf"],
    ["a semicolon", "x;y"],
    ["a quote", "x'y"],
    ["a newline", "x\ny"],
    ["empty", ""],
    [`more than ${LABEL_MAX} characters`, "a".repeat(LABEL_MAX + 1)],
  ])("prints no command for a name with %s", (_n, name) => {
    const text = raw(name);
    expect(text).toContain("remove it in Docker");
    expect(text).not.toContain("docker rm");
    expect(text).not.toContain("`");
  });
});

describe("no text says a sandbox made before ownership is treated as this installation's", () => {
  const walk = (p: string): string[] =>
    fs.statSync(p).isDirectory() ? fs.readdirSync(p).flatMap((n) => walk(path.join(p, n))) : [p];

  it("src, docs and README.md never say 'treated as this installation'", () => {
    const files = [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "docs")), path.join(ROOT, "README.md")];
    expect(files.length).toBeGreaterThan(10);
    const hits = files.filter((f) => /treated as this installation/i.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f));
    expect(hits).toEqual([]);
  });
});
