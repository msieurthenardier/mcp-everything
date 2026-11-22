/**
 * The built-in check: reads the build files of a checkout and reports where the install recipe runs the
 * repository's own code, plus a few red flags in that code. It is a reading aid, not a model of every
 * build tool: files that configuration points at are named, not read, and `notes` says what is not covered.
 * Every path and byte of content here is repository-controlled; nothing is executed, nothing is trusted.
 */
import { parse as parseToml } from "smol-toml";
import type { Ecosystem } from "../types.js";
import { oneLine } from "../util/text.js";
import { emptyCounts, MAX_FINDINGS } from "./sarif.js";
import type { BuildFile, BuildWalk, CheckOutcome, Finding, Level } from "./types.js";

// ---------------------------------------------------------------------------
// The one table of file kinds. `fileKind`, `BUILD_FILE_PATTERNS`, the `incomplete` rules and the tests all
// read it. Every entry is expressible as a busybox `find -name` / `-path` test or a root `[ -f ]` check.
// ---------------------------------------------------------------------------

export interface BuildFilePattern {
  kind: "name" | "glob" | "path";
  pattern: string;
  rootOnly: boolean;
  ecosystems: Ecosystem[];
  /** Read for presence only: the walk reports the file with empty content, counts it in no budget and never truncates it. */
  presenceOnly?: true;
}

const E_NODE: Ecosystem[] = ["node"];
const E_PY: Ecosystem[] = ["python"];
// Python build backends (maturin, setuptools-rust, meson-python, scikit-build-core) make these matter to `python` too.
const E_RUST_PY: Ecosystem[] = ["rust", "python"];
const E_MAKE: Ecosystem[] = ["make", "autotools", "go"];

function name(pattern: string, rootOnly: boolean, ecosystems: Ecosystem[]): BuildFilePattern {
  return { kind: "name", pattern, rootOnly, ecosystems };
}

const TABLE: BuildFilePattern[] = [
  // node (recipes.ts NODE). The two lockfiles are read for their presence only: they choose the package manager.
  name("package.json", false, E_NODE),
  name("binding.gyp", false, E_NODE),
  name(".pnpmfile.cjs", true, E_NODE),
  name(".yarnrc.yml", true, E_NODE),
  name(".yarnrc", true, E_NODE),
  name(".npmrc", true, E_NODE),
  { ...name("pnpm-lock.yaml", true, E_NODE), presenceOnly: true },
  { ...name("yarn.lock", true, E_NODE), presenceOnly: true },
  // python (recipes.ts PYTHON)
  name("setup.py", true, E_PY),
  name("setup.cfg", true, E_PY),
  name("pyproject.toml", true, E_PY),
  name("hatch.toml", true, E_PY),
  name("hatch_build.py", true, E_PY),
  name("requirements.txt", true, E_PY),
  name("meson.build", true, E_PY),
  name("meson.options", true, E_PY),
  name("meson_options.txt", true, E_PY),
  // rust (recipes.ts RUST); also read for python projects built by a Rust backend
  name("Cargo.toml", false, E_RUST_PY),
  name("build.rs", false, E_RUST_PY),
  { kind: "path", pattern: ".cargo/config.toml", rootOnly: true, ecosystems: ["rust"] },
  { kind: "path", pattern: ".cargo/config", rootOnly: true, ecosystems: ["rust"] },
  // cmake (recipes.ts CMAKE); the root CMakeLists.txt also matters to scikit-build-core
  name("CMakeLists.txt", false, ["cmake", "python"]),
  { kind: "glob", pattern: "*.cmake", rootOnly: false, ecosystems: ["cmake"] },
  // autotools (recipes.ts AUTOTOOLS)
  name("configure", true, ["autotools"]),
  name("configure.ac", true, ["autotools"]),
  name("Makefile.am", true, ["autotools"]),
  name("Makefile.in", true, ["autotools"]),
  { kind: "glob", pattern: "*.m4", rootOnly: true, ecosystems: ["autotools"] },
  // make (recipes.ts MAKE; GO falls back to make; AUTOTOOLS runs make)
  name("Makefile", false, E_MAKE),
  name("makefile", false, E_MAKE),
  name("GNUmakefile", false, E_MAKE),
  { kind: "glob", pattern: "*.mk", rootOnly: false, ecosystems: ["make"] },
  // ruby (recipes.ts RUBY)
  name("Gemfile", true, ["ruby"]),
  { kind: "glob", pattern: "*.gemspec", rootOnly: true, ecosystems: ["ruby"] },
  name("extconf.rb", false, ["ruby"]),
  name("Rakefile", false, ["ruby"]),
];

/** Structured list leg 4's walk reads exactly. A fresh copy per call site is not needed: it is never mutated. */
export const BUILD_FILE_PATTERNS: readonly BuildFilePattern[] = TABLE.map((e) => ({ ...e, ecosystems: [...e.ecosystems] }));

/** Directories the walk prunes (leg 4 owns the pruning). */
export const PRUNE_DIRS: readonly string[] = [".git", "node_modules", "target", "vendor", ".venv", "venv", "__pycache__"];

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function isRoot(path: string): boolean {
  return !path.includes("/");
}

function matches(e: BuildFilePattern, path: string): boolean {
  if (e.kind === "path") return path === e.pattern;
  if (e.rootOnly && !isRoot(path)) return false;
  const base = baseName(path);
  return e.kind === "glob" ? base.length > e.pattern.length - 1 && base.endsWith(e.pattern.slice(1)) : base === e.pattern;
}

/** The kind (the table's pattern) a path is classified as, or undefined when no analysis reads it. */
export function fileKind(path: string): string | undefined {
  return TABLE.find((e) => matches(e, path))?.pattern;
}

function kindEntry(path: string): BuildFilePattern | undefined {
  return TABLE.find((e) => matches(e, path));
}

function readsKind(eco: Ecosystem, path: string): boolean {
  return kindEntry(path)?.ecosystems.includes(eco) ?? false;
}

/** Truncation of these generated files is routine (a committed `configure` is large): a note, not `incomplete`. */
const GENERATED_KINDS = new Set(["configure", "Makefile.in", "*.m4"]);

/** Files where `eval` and friends are everyday: decoder and executor must share a line. */
const SAME_LINE_KINDS = new Set(["Makefile", "makefile", "GNUmakefile", "*.mk", "configure", "*.m4", "Makefile.am", "Makefile.in", "configure.ac"]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function own(o: unknown, k: string): unknown {
  return isObj(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function strip(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/** Cut before cleaning so a hostile megabyte string costs nothing, then clean to one line. */
function clip(s: string, max = 80): string {
  return oneLine(s.slice(0, max * 3), max);
}

function splitLines(text: string): string[] {
  return text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** 1-based line of a character index. */
function lineAt(content: string, idx: number): number {
  let n = 1;
  for (let i = content.indexOf("\n"); i !== -1 && i < idx; i = content.indexOf("\n", i + 1)) n++;
  return n;
}

function lineOfText(content: string, needle: string, from = 0): number {
  const i = content.indexOf(needle, from);
  return i < 0 ? 1 : lineAt(content, i);
}

/** Line of a script: search from the `"scripts"` key onward for its quoted key (1 when not found). */
function scriptLine(content: string, key: string): number {
  const s = content.indexOf('"scripts"');
  const i = content.indexOf(JSON.stringify(key), s < 0 ? 0 : s);
  return i < 0 ? 1 : lineAt(content, i);
}

/** The root Makefile GNU make would pick. */
function pickMakefile(files: Map<string, BuildFile>): BuildFile | undefined {
  for (const n of ["GNUmakefile", "makefile", "Makefile"]) {
    const f = files.get(n);
    if (f) return f;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Red flags. Linear: no line-length cap, no windows. Every pattern has only fixed, small gaps.
// ---------------------------------------------------------------------------

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh"]);
const OTHER_INTERPRETERS = /^(?:python\d*(?:\.\d+)*|node|perl|ruby|php|deno|bun)$/;
const DOWNLOAD_WORD = /(?<![\w.-])(?:curl|wget)(?![\w-])/;

interface Seg {
  text: string;
  /** Fed by the previous segment through `|`. */
  piped: boolean;
  /** Index of the command a `$(`, `<(` or backtick belongs to, or -1. */
  parent: number;
}

/** Split at `|`, `;`, `&&`, `||`, `$(`, `<(` and backticks, tracking pipes and enclosing commands. */
function segments(text: string): Seg[] {
  const segs: Seg[] = [];
  const stack: number[] = [];
  let start = 0;
  let piped = false;
  let inTick = false;
  const parent = (): number => stack[stack.length - 1] ?? -1;
  const cut = (end: number, nextStart: number, nextPiped: boolean): number => {
    segs.push({ text: text.slice(start, end), piped, parent: parent() });
    start = nextStart;
    piped = nextPiped;
    return segs.length - 1;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "|") {
      if (n === "|") {
        cut(i, i + 2, false);
        i++;
      } else cut(i, i + 1, true);
    } else if (c === ";") cut(i, i + 1, false);
    else if (c === "&" && n === "&") {
      cut(i, i + 2, false);
      i++;
    } else if ((c === "$" || c === "<") && n === "(") {
      stack.push(cut(i, i + 2, false));
      i++;
    } else if (c === "`") {
      if (!inTick) {
        stack.push(cut(i, i + 1, false));
        inTick = true;
      } else {
        cut(i, i + 1, false);
        stack.pop();
        inTick = false;
      }
    } else if (c === ")" && stack.length && !inTick) {
      cut(i, i + 1, false);
      stack.pop();
    }
  }
  segs.push({ text: text.slice(start), piped, parent: parent() });
  return segs;
}

const MAX_TOKENS = 400;

/** The first tokens of a segment, quotes dropped. `more` when the segment had further tokens. */
function tokens(text: string): { list: string[]; more: boolean } {
  const list: string[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const t = m[0].replace(/["']/g, "");
    if (t) list.push(t);
    if (list.length >= MAX_TOKENS) return { list, more: re.lastIndex < text.length };
  }
  return { list, more: false };
}

/** Indexed read of an array whose bounds the caller has checked. */
function at<T>(a: readonly T[], i: number): T {
  return a[i] as T;
}

function base(t: string): string {
  return t.slice(t.lastIndexOf("/") + 1);
}

/** Index of the command word after `sudo` (with flags) and `env` (with flags and assignments). */
function skipWrappers(t: string[]): number {
  let i = 0;
  for (;;) {
    const b = i < t.length ? base(at(t, i)) : "";
    if (b === "sudo") {
      i++;
      while (i < t.length && at(t, i).startsWith("-")) i += /^-[ugChpRTUr]$/.test(at(t, i)) ? 2 : 1;
    } else if (b === "env") {
      i++;
      while (i < t.length && (at(t, i).startsWith("-") || /^\w+=/.test(at(t, i)))) i++;
    } else return i;
  }
}

/** True when the segment is an interpreter that reads its standard input as its program. */
function readsStdinAsProgram(text: string): boolean {
  const { list: t } = tokens(text);
  let i = skipWrappers(t);
  if (i >= t.length) return false;
  let cmd = base(at(t, i++));
  if (cmd === "busybox") {
    if (i >= t.length) return false;
    cmd = base(at(t, i++));
    if (!SHELLS.has(cmd)) return false;
  }
  const shell = SHELLS.has(cmd);
  if (!shell && !OTHER_INTERPRETERS.test(cmd)) return false;
  for (; i < t.length; i++) {
    const a = at(t, i);
    if (a === "-") return true;
    if (a === "--") {
      if (shell) return true;
      continue;
    }
    if (a.startsWith("--")) {
      if (/^--(?:eval|print|command|exec)/.test(a)) return false;
      continue;
    }
    if (a.startsWith("-")) {
      // A program given on the command line (-c, -e, -m, ...) means the download is not the program.
      if ((shell ? /c/ : /[cemEpr]/).test(a.slice(1))) return false;
      if (shell && a.slice(1).includes("s")) return true;
      continue;
    }
    if ((cmd === "deno" || cmd === "bun") && a === "run") continue;
    return false; // a script or file argument: that file is the program
  }
  return true;
}

/** True when a `$(…)`/`<(…)` inside this command's text is run as its program. */
function runsSubstitution(text: string): boolean {
  const { list: t } = tokens(text);
  const i = skipWrappers(t);
  if (i >= t.length) return false;
  let cmd = base(at(t, i));
  let rest = t.slice(i + 1);
  if (cmd === "busybox" && rest.length) {
    cmd = base(at(rest, 0));
    rest = rest.slice(1);
  }
  const runner = cmd === "eval" || cmd === "source" || cmd === "." || SHELLS.has(cmd) || OTHER_INTERPRETERS.test(cmd);
  return runner && rest.every((a) => a.startsWith("-"));
}

/** curl/wget feeding an interpreter that reads it as its program. */
function downloadExec(text: string): boolean {
  if (!DOWNLOAD_WORD.test(text)) return false;
  const segs = segments(text);
  for (let i = 0; i < segs.length; i++) {
    const seg = at(segs, i);
    if (!DOWNLOAD_WORD.test(seg.text)) continue;
    const next = segs[i + 1];
    if (next && next.piped && readsStdinAsProgram(next.text)) return true;
    const parent = segs[seg.parent];
    if (parent && runsSubstitution(parent.text)) return true;
  }
  return false;
}

const BASE64_FLAGS = /base64((?:\s+-+[\w=]+)+)/g;
const BASE64_DECODE_FLAG = /(?:^|\s)(?:-[A-Za-z0-9]*[dD][A-Za-z0-9]*|--decode)(?=\s|$)/;
const DECODER_WORDS = /atob\(|b64decode|fromhex|unhexlify/;
const BUFFER_FROM = /Buffer\.from\(/;
const BUFFER_ENC = /['"](?:base64|hex)['"]/;
/** Executor words, matched as words: `evaluate(` is not `eval`. */
const EXECUTOR = /(?<![\w$])(?:eval|execSync|child_process)(?![\w$])|(?<![\w$])exec\s*\(|(?<![\w$])Function\s*\(|\|\s*(?:sh|bash)(?![\w-])|(?<![\w$.-])(?:ba)?sh\s+-c(?![\w-])/;

function hasDecoder(line: string): boolean {
  if (DECODER_WORDS.test(line)) return true;
  if (BUFFER_FROM.test(line) && BUFFER_ENC.test(line)) return true;
  if (line.includes("base64")) {
    for (const m of line.matchAll(BASE64_FLAGS)) if (BASE64_DECODE_FLAG.test(m[1] ?? "")) return true;
  }
  return false;
}

// A write directly to a persistence target. Fixed, small gaps only (whitespace and one quote).
const HOME = String.raw`["']?(?<![\w./-])(?:~|\$HOME|\$\{HOME\}|\$\(HOME\)|/root)["']?/`;
const HOME_TARGET = String.raw`(?:\.bashrc|\.bash_profile|\.profile|\.zshrc|\.gitconfig|\.netrc|\.pypirc|\.ssh/|\.aws/)`;
const ETC = String.raw`(?<![\w./-])/etc/(?:profile|cron|sudoers|ld\.so|(?:passwd|shadow|environment)(?![\w.-]))`;
const PERSIST = `(?:${HOME}${HOME_TARGET}|${ETC})`;
const PERSIST_QUICK = /\.(?:bashrc|bash_profile|profile|zshrc|gitconfig|netrc|pypirc|ssh\/|aws\/)|\/etc\//;
const WRITE_REDIRECT = new RegExp(String.raw`(?:>>?\s*|\btee(?:\s+-[\w-]+)*\s+)${PERSIST}`);
const WRITE_CALL = new RegExp(String.raw`(?:\b(?:writeFile|appendFile)(?:Sync)?\(\s*${PERSIST}|\bopen\(\s*${PERSIST}[^"'\s,)]*["']?\s*,\s*["'][wa])`);
const COPY_HEAD = /^\s*(?:sudo(?:\s+-\S+)*\s+)?(?:cp|mv|install|ln)\s/;
const PERSIST_LAST_ARG = new RegExp(`${PERSIST}\\S*\\s*$`);

function writesOutside(line: string): boolean {
  if (!PERSIST_QUICK.test(line)) return false;
  if (WRITE_REDIRECT.test(line) || WRITE_CALL.test(line)) return true;
  let start = 0;
  for (let i = 0; i <= line.length; i++) {
    const c = line[i];
    if (i < line.length && c !== ";" && c !== "&" && c !== "|") continue;
    const seg = line.slice(start, i);
    if (COPY_HEAD.test(seg) && PERSIST_LAST_ARG.test(seg)) return true;
    start = i + 1;
  }
  return false;
}

export interface RedFlagHit {
  rule: "build-hooks/download-exec" | "build-hooks/decode-exec" | "build-hooks/write-outside";
  /** 1-based, within the text. */
  line: number;
  /** Further matching lines in the same text. */
  more: number;
}

const DECODE_WINDOW = 10;

/** All red flags in one text: at most one hit per rule, at its first matching line. */
export function scanRedFlags(text: string, sameLineOnly: boolean): RedFlagHit[] {
  const lines = splitLines(text);
  const dl: number[] = [];
  const wo: number[] = [];
  // Logical lines for the shell-ish rules: a line ending in a backslash joins the next.
  for (let i = 0; i < lines.length; i++) {
    const first = i;
    let logical = at(lines, i);
    if (logical.endsWith("\\")) {
      const parts = [logical.slice(0, -1)];
      while (i + 1 < lines.length && at(lines, i).endsWith("\\")) {
        i++;
        const l = at(lines, i);
        parts.push(l.endsWith("\\") ? l.slice(0, -1) : l);
      }
      logical = parts.join(" ");
    }
    if (downloadExec(logical)) dl.push(first + 1);
    if (writesOutside(logical)) wo.push(first + 1);
  }
  const dec: number[] = [];
  let lastDecoder = -Infinity;
  let lastExecutor = -Infinity;
  const window = sameLineOnly ? 0 : DECODE_WINDOW;
  for (let i = 0; i < lines.length; i++) {
    const d = hasDecoder(at(lines, i));
    const x = EXECUTOR.test(at(lines, i));
    if (d) lastDecoder = i;
    if (x) lastExecutor = i;
    if ((d && i - lastExecutor <= window) || (x && i - lastDecoder <= window)) dec.push(i + 1);
  }
  const hits: RedFlagHit[] = [];
  const add = (rule: RedFlagHit["rule"], ls: number[]) => {
    if (ls.length) hits.push({ rule, line: at(ls, 0), more: ls.length - 1 });
  };
  add("build-hooks/download-exec", dl);
  add("build-hooks/decode-exec", dec);
  add("build-hooks/write-outside", wo);
  return hits;
}

const RED_FLAG_TEXT: Record<RedFlagHit["rule"], string> = {
  "build-hooks/download-exec": "downloads with curl/wget and runs the result as code",
  "build-hooks/decode-exec": "decodes data and runs it",
  "build-hooks/write-outside": "writes to a startup or credential file outside the project",
};

// ---------------------------------------------------------------------------
// State shared by the per-ecosystem analyses
// ---------------------------------------------------------------------------

interface Raw {
  rule: string;
  level: Level;
  path: string;
  line: number;
  message: string;
}

interface ScanJob {
  path: string;
  /** Line of the text's first line within the file. */
  base: number;
  text: string;
  sameLine: boolean;
}

interface State {
  eco: Ecosystem;
  files: Map<string, BuildFile>;
  items: Raw[];
  notes: string[];
  reasons: string[];
  /** Files with a `runs` finding: red flags are searched in the whole of each (package.json: scripts only). */
  reported: Set<string>;
  scans: ScanJob[];
  /** Bad root TOML files make the outcome incomplete. */
  badRootToml: string[];
}

function add(st: State, path: string, line: number, message: string, rule = "build-hooks/runs"): void {
  st.items.push({ rule, level: "note", path, line, message });
}

/** A `runs` finding on a file the walk read (scanned for red flags). */
function runs(st: State, path: string, line: number, message: string): void {
  add(st, path, line, message);
  if (st.files.has(path)) st.reported.add(path);
}

/** A file configuration points at: reported as read when the walk read it, else named and marked not read. */
function named(st: State, where: BuildFile, line: number, target: string, what: string): void {
  const t = target.replace(/^\.\//, "");
  const walked = !t.startsWith("/") && !t.split("/").includes("..") && st.files.get(t);
  if (walked) runs(st, t, 1, `${what}`);
  else add(st, where.path, line, `${what}: ${clip(t, 60)} (named here, not read)`);
}

function parseJson(st: State, f: BuildFile): unknown {
  try {
    return JSON.parse(strip(f.content));
  } catch {
    st.notes.push(`${clip(f.path)} could not be parsed as JSON; its scripts were not listed`);
    return undefined;
  }
}

function parseTomlFile(st: State, f: BuildFile): Obj | undefined {
  try {
    return parseToml(strip(f.content)) as Obj;
  } catch {
    // smol-toml may reject what the build tool accepts, and hooks could hide there; every exception, RangeError included.
    if (isRoot(f.path) || f.path === ".cargo/config.toml" || f.path === ".cargo/config") st.badRootToml.push(f.path);
    st.notes.push(`${clip(f.path)} could not be parsed as TOML; it was not analysed`);
    return undefined;
  }
}

function packageScripts(st: State, f: BuildFile): Obj | undefined {
  const pkg = parseJson(st, f);
  if (pkg === undefined) return undefined;
  if (!isObj(pkg)) {
    st.notes.push(`${clip(f.path)} is not a JSON object; its scripts were not listed`);
    return undefined;
  }
  const scripts = own(pkg, "scripts");
  if (scripts === undefined) return {};
  if (!isObj(scripts)) {
    st.notes.push(`${clip(f.path)} has a "scripts" that is not an object; it was not listed`);
    return undefined;
  }
  return scripts;
}

/** The script strings of `names` that are strings, with their lines. */
function reportScripts(st: State, f: BuildFile, scripts: Obj, names: string[], say: (n: string, s: string) => string): void {
  for (const n of names) {
    const s = str(own(scripts, n));
    if (s === undefined) continue;
    const line = scriptLine(f.content, n);
    add(st, f.path, line, say(n, s));
    st.scans.push({ path: f.path, base: line, text: s, sameLine: false });
  }
}

// ---------------------------------------------------------------------------
// node: recipes.ts NODE
// ---------------------------------------------------------------------------

const NODE_ROOT_SCRIPTS = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"];
const NODE_BUILD_SCRIPTS = ["prebuild", "build", "postbuild"];
const NODE_NESTED_SCRIPTS = ["preinstall", "install", "postinstall"];

function analyzeNode(st: State): void {
  const pm = st.files.has("pnpm-lock.yaml") ? "pnpm" : st.files.has("yarn.lock") ? "yarn" : "npm";
  const conditional = (n: string) => n === "prepublish" || (/^(?:pre|post)/.test(n) && n !== "prepare");
  const root = st.files.get("package.json");
  if (root) {
    const scripts = packageScripts(st, root);
    if (scripts) {
      reportScripts(st, root, scripts, NODE_ROOT_SCRIPTS, (n, s) =>
        conditional(n)
          ? `package.json "${n}" script, if the package manager runs it: ${clip(s)}`
          : `package.json "${n}" script runs during \`${pm} install\`: ${clip(s)}`,
      );
      if (typeof own(scripts, "build") === "string") {
        reportScripts(st, root, scripts, NODE_BUILD_SCRIPTS, (n, s) =>
          n === "build"
            ? `package.json "build" script runs as \`${pm} run build\`: ${clip(s)}`
            : `package.json "${n}" script, if the package manager runs it: ${clip(s)}`,
        );
      }
    }
  }
  for (const f of st.files.values()) {
    if (baseName(f.path) === "package.json" && f.path !== "package.json") {
      const scripts = packageScripts(st, f);
      if (scripts) {
        reportScripts(st, f, scripts, NODE_NESTED_SCRIPTS, (n, s) =>
          `"${n}" script, only if this is an installed workspace package: ${clip(s)}`);
      }
    }
    if (baseName(f.path) === "binding.gyp") {
      const pkg = st.files.get(dirName(f.path) ? `${dirName(f.path)}/package.json` : "package.json");
      if (pkg) {
        const scripts = packageScripts(st, pkg);
        if (scripts && own(scripts, "install") === undefined && own(scripts, "preinstall") === undefined) {
          runs(st, f.path, 1, "binding.gyp beside a package.json with no install script: npm may run `node-gyp rebuild`");
        }
      }
    }
  }
  const pnpmfile = st.files.get(".pnpmfile.cjs");
  if (pnpmfile && st.files.has("pnpm-lock.yaml")) runs(st, ".pnpmfile.cjs", 1, ".pnpmfile.cjs is code that pnpm loads during install");
  const yarnrcYml = st.files.get(".yarnrc.yml");
  if (yarnrcYml && st.files.has("yarn.lock")) {
    splitLines(yarnrcYml.content).forEach((l, i) => {
      const m = /^\s*(yarnPath|plugins)\s*:\s*(.*)$/.exec(l);
      if (m) named(st, yarnrcYml, i + 1, (m[2] ?? "").replace(/["']/g, "").trim() || (m[1] ?? ""), `.yarnrc.yml sets ${m[1]}, which yarn runs`);
    });
  }
  const yarnrc = st.files.get(".yarnrc");
  if (yarnrc && st.files.has("yarn.lock")) {
    splitLines(yarnrc.content).forEach((l, i) => {
      const m = /^\s*yarn-path\s+["']?([^"'\s]+)/.exec(l);
      if (m) named(st, yarnrc, i + 1, m[1] ?? "", ".yarnrc sets yarn-path, which yarn runs");
    });
  }
  const npmrc = st.files.get(".npmrc");
  if (npmrc) {
    splitLines(npmrc.content).forEach((l, i) => {
      if (/^\s*[;#]/.test(l)) return;
      const key = /^\s*(script-shell|node-options|git|node-gyp)\s*=/i.exec(l);
      if (key) add(st, ".npmrc", i + 1, `.npmrc sets ${(key[1] ?? "").toLowerCase()}, which changes what npm runs`);
      if (/^\s*(?:@[^:=\s]+:)?registry\s*=/i.test(l)) add(st, ".npmrc", i + 1, ".npmrc sets a registry: it changes where packages come from", "build-hooks/source");
    });
  }
  st.notes.push("node: corepack and a package.json `packageManager` field may fetch the package manager itself");
}

// ---------------------------------------------------------------------------
// python: recipes.ts PYTHON
// ---------------------------------------------------------------------------

const REQ_INDEX = /^(?:--index-url|--extra-index-url|-i|--find-links|-f|--trusted-host)(?:\s|=|$)/;
const REQ_LOCAL = /^(?:\.{1,2}(?:\/|$)|\/|file:|[^\s:@=<>~!;,[]+\/|[\w.-]+\s*@\s*file:)/;

function hatchHooks(st: State, h: Obj, file: BuildFile): void {
  const hooks: Array<[string, unknown]> = [
    ["build hook", own(own(own(h, "build"), "hooks"), "custom")],
    ["metadata hook", own(own(own(h, "metadata"), "hooks"), "custom")],
  ];
  const targets = own(own(h, "build"), "targets");
  if (isObj(targets)) for (const t of Object.keys(targets)) hooks.push([`build target hook (${clip(t, 30)})`, own(own(own(targets, t), "hooks"), "custom")]);
  for (const [label, custom] of hooks) {
    if (!isObj(custom)) continue;
    named(st, file, lineOfText(file.content, "custom"), str(own(custom, "path")) ?? "hatch_build.py", `hatch custom ${label} runs repository code`);
  }
  const version = own(h, "version");
  if (str(own(version, "source")) === "code") {
    named(st, file, lineOfText(file.content, '"code"'), str(own(version, "path")) ?? "(no path given)", "hatch version source `code` runs repository code");
  }
}

function analyzePython(st: State): void {
  const has = (p: string) => st.files.has(p);
  const installDot = has("pyproject.toml") || has("setup.py") || has("setup.cfg");
  if (has("setup.py")) runs(st, "setup.py", 1, "setup.py runs when `pip install .` builds the project");

  const ppFile = st.files.get("pyproject.toml");
  const pp = ppFile ? parseTomlFile(st, ppFile) : undefined;
  if (ppFile && pp) {
    const bs = own(pp, "build-system");
    const backend = str(own(bs, "build-backend"));
    const requires = own(bs, "requires");
    const reqs = Array.isArray(requires) ? requires.filter((r): r is string => typeof r === "string") : [];
    if (backend) st.notes.push(`python: build backend ${clip(backend, 60)} (from pyproject.toml)`);
    if (own(bs, "backend-path") !== undefined) add(st, "pyproject.toml", lineOfText(ppFile.content, "backend-path"), "pyproject.toml sets backend-path: an in-tree build backend runs repository code");
    for (const r of reqs) {
      if (/:\/\//.test(r) || /@\s*file:/.test(r)) add(st, "pyproject.toml", lineOfText(ppFile.content, r.slice(0, 40)), `a build requirement comes from a URL or path: ${clip(r, 60)}`, "build-hooks/source");
    }
    const tool = own(pp, "tool");
    const hatch = own(tool, "hatch");
    if (isObj(hatch)) hatchHooks(st, hatch, ppFile);
    const poetryBuild = own(own(tool, "poetry"), "build");
    const poetryScript = str(poetryBuild) ?? str(own(poetryBuild, "script"));
    if (poetryScript !== undefined) named(st, ppFile, lineOfText(ppFile.content, "build"), poetryScript, "poetry build script runs repository code");
    const pdmScript = str(own(own(own(tool, "pdm"), "build"), "setup-script"));
    if (pdmScript !== undefined) named(st, ppFile, lineOfText(ppFile.content, "setup-script"), pdmScript, "pdm setup-script runs repository code");
    const dyn = own(own(tool, "setuptools"), "dynamic");
    if (isObj(dyn)) {
      for (const k of Object.keys(dyn)) {
        const a = str(own(dyn[k], "attr"));
        if (a !== undefined) add(st, "pyproject.toml", lineOfText(ppFile.content, "attr"), `setuptools may import ${clip(a, 60)} (dynamic ${clip(k, 30)})`);
      }
    }
    // Backends that build with another tool make that tool's files matter.
    const b = backend ?? "";
    const rustLike = b.startsWith("maturin") || reqs.some((r) => /^\s*setuptools[-_]rust\b/i.test(r));
    if (rustLike) {
      const manifest = str(own(own(tool, "maturin"), "manifest-path")) ?? "Cargo.toml";
      named(st, ppFile, 1, manifest, "this Rust build backend runs cargo, so the manifest and its build script run");
      const dir = dirName(manifest);
      const bs2 = dir ? `${dir}/build.rs` : "build.rs";
      if (has(bs2)) runs(st, bs2, 1, "build.rs runs when the Rust build backend builds the project");
    }
    if (b.startsWith("mesonpy")) {
      for (const p of ["meson.build", "meson.options", "meson_options.txt"]) if (has(p)) runs(st, p, 1, `${p} is run by the meson-python backend`);
    }
    if (b.startsWith("scikit_build_core")) {
      const src = str(own(own(own(tool, "scikit-build"), "cmake"), "source-dir")) ?? str(own(own(pp, "tool"), "scikit-build.cmake.source-dir")) ?? ".";
      const cm = src === "." || src === "" ? "CMakeLists.txt" : `${src.replace(/^\.\//, "").replace(/\/$/, "")}/CMakeLists.txt`;
      named(st, ppFile, 1, cm, "the scikit-build-core backend runs cmake, which runs this file");
    }
  }
  const hatchToml = st.files.get("hatch.toml");
  if (hatchToml) {
    const h = parseTomlFile(st, hatchToml);
    if (h) hatchHooks(st, h, hatchToml);
  }
  const cfg = st.files.get("setup.cfg");
  if (cfg) {
    splitLines(cfg.content).forEach((l, i) => {
      const m = /(?:^|[=\s])attr:\s*([\w.]+)/.exec(l);
      if (m) add(st, "setup.cfg", i + 1, `setuptools may import the module named by \`attr: ${clip(m[1] ?? "", 60)}\``);
    });
  }
  const req = st.files.get("requirements.txt");
  if (req) {
    const role = installDot ? "fallback when `pip install .` fails" : "the install path";
    splitLines(req.content).forEach((raw, i) => {
      const l = raw.replace(/(?:^|\s)#.*$/, "").trim();
      if (!l) return;
      if (/^(?:-e|--editable)(?:\s|=|$)/.test(l)) runs(st, "requirements.txt", i + 1, `requirements.txt (${role}) installs an editable project, which builds local code: ${clip(l, 60)}`);
      else if (/^(?:-r|--requirement|-c|--constraint)(?:\s|=|$)/.test(l)) runs(st, "requirements.txt", i + 1, `requirements.txt (${role}) includes another file, not read: ${clip(l, 60)}`);
      else if (REQ_INDEX.test(l)) add(st, "requirements.txt", i + 1, `requirements.txt (${role}) changes where packages come from: ${clip(l, 60)}`, "build-hooks/source");
      else if (!l.startsWith("-") && REQ_LOCAL.test(l)) runs(st, "requirements.txt", i + 1, `requirements.txt (${role}) installs local code, which builds it: ${clip(l, 60)}`);
    });
  }
  st.notes.push("python: an external build backend runs its own code and may run repository scripts it is configured to");
}

// ---------------------------------------------------------------------------
// rust: recipes.ts RUST
// ---------------------------------------------------------------------------

function analyzeRust(st: State): void {
  for (const f of st.files.values()) {
    if (baseName(f.path) !== "Cargo.toml") continue;
    const dir = dirName(f.path);
    const at = (n: string) => (dir ? `${dir}/${n}` : n);
    const nested = dir !== "";
    const when = nested ? "if this crate is built as a member or dependency, " : "";
    const toml = parseTomlFile(st, f);
    if (!toml) {
      if (st.files.has(at("build.rs"))) runs(st, at("build.rs"), 1, `build.rs beside a Cargo.toml that could not be parsed: ${when}it runs when the crate is built`);
      continue;
    }
    const pkg = own(toml, "package");
    const isPackage = isObj(pkg);
    if (isPackage) {
      const build = own(pkg, "build");
      if (typeof build === "string") {
        named(st, f, lineOfText(f.content, "build"), at(build.replace(/^\.\//, "")), `${when}Cargo.toml's \`build = ...\` replaces build.rs; this runs at build`);
      } else if (build !== false && own(pkg, "autobuild") !== false && st.files.has(at("build.rs"))) {
        runs(st, at("build.rs"), 1, nested ? "build.rs runs if this crate is built as a member or dependency" : "build.rs runs during `cargo build --release`");
      }
    }
    const lib = own(toml, "lib");
    if (own(lib, "proc-macro") === true || own(lib, "proc_macro") === true) {
      runs(st, f.path, lineOfText(f.content, "proc-macro"), `${when}proc-macro crate: its code runs inside the compiler`);
    }
  }
  for (const path of [".cargo/config.toml", ".cargo/config"]) {
    const f = st.files.get(path);
    if (!f) continue;
    const cfg = parseTomlFile(st, f);
    if (!cfg) continue;
    const build = own(cfg, "build");
    for (const k of ["rustc-wrapper", "rustc-workspace-wrapper", "rustc", "rustdoc"]) {
      const v = str(own(build, k));
      if (v !== undefined) add(st, path, lineOfText(f.content, k), `${path} sets build.${k}, which cargo runs: ${clip(v, 60)}`);
    }
    const flagsText = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").join(" ") : (str(v) ?? ""));
    if (/-C\s*linker\s*=/.test(flagsText(own(build, "rustflags")))) add(st, path, lineOfText(f.content, "rustflags"), `${path} sets -C linker= in build.rustflags`);
    const target = own(cfg, "target");
    if (isObj(target)) {
      for (const t of Object.keys(target)) {
        for (const k of ["linker", "ar"]) {
          const v = str(own(target[t], k));
          if (v !== undefined) add(st, path, lineOfText(f.content, k), `${path} sets target.${clip(t, 30)}.${k}, which cargo runs: ${clip(v, 60)}`);
        }
        if (/-C\s*linker\s*=/.test(flagsText(own(target[t], "rustflags")))) add(st, path, lineOfText(f.content, "rustflags"), `${path} sets -C linker= in target.${clip(t, 30)}.rustflags`);
      }
    }
    if (str(own(own(cfg, "registry"), "credential-provider")) !== undefined || Array.isArray(own(own(cfg, "registry"), "credential-provider"))) {
      add(st, path, lineOfText(f.content, "credential-provider"), `${path} sets registry.credential-provider, a program cargo runs`);
    }
    if (isObj(own(cfg, "source"))) add(st, path, lineOfText(f.content, "[source"), `${path} has [source]: it changes where code comes from`, "build-hooks/source");
    if (own(cfg, "patch") !== undefined) add(st, path, lineOfText(f.content, "[patch"), `${path} has [patch]: it changes where code comes from`, "build-hooks/source");
  }
  st.notes.push("rust: dependencies' build scripts also run during `cargo build`; they are not listed");
}

// ---------------------------------------------------------------------------
// go: recipes.ts GO
// ---------------------------------------------------------------------------

function analyzeGo(st: State): void {
  const mk = pickMakefile(st.files);
  if (mk) runs(st, mk.path, 1, `${mk.path} runs only if a \`go install\` fails and nothing was installed (the recipe then runs \`make\`)`);
  st.notes.push("go: `go install` runs nothing from the repository (cgo C sources are compiled, not run)");
}

// ---------------------------------------------------------------------------
// ruby: recipes.ts RUBY
// ---------------------------------------------------------------------------

function analyzeRuby(st: State): void {
  if (st.files.has("Gemfile")) runs(st, "Gemfile", 1, "Gemfile is Ruby code evaluated by `bundle install`, including any gemspec, eval_gemfile or plugin it names");
  const spec = [...st.files.keys()].filter((p) => isRoot(p) && p.endsWith(".gemspec")).sort()[0];
  const extNamed = new Set<string>();
  if (spec) {
    const f = st.files.get(spec) as BuildFile;
    runs(st, spec, 1, `${spec} is Ruby code evaluated by \`gem build\``);
    for (const m of f.content.matchAll(/\.extensions\s*(?:=|<<)\s*(\[[^\]]*\]|["'][^"']+["'])/g)) {
      for (const q of (m[1] ?? "").matchAll(/["']([^"']+)["']/g)) {
        const p = (q[1] ?? "").replace(/^\.\//, "");
        extNamed.add(p);
        const line = lineAt(f.content, m.index ?? 0);
        named(st, f, line, p, `${spec} names ${baseName(p) || "a file"} as an extension; it runs when the gem is installed`);
      }
    }
  }
  for (const f of st.files.values()) {
    const b = baseName(f.path);
    if ((b === "extconf.rb" || b === "Rakefile") && !extNamed.has(f.path)) runs(st, f.path, 1, `${b} runs only if a gemspec names it under extensions`);
  }
}

// ---------------------------------------------------------------------------
// cmake / autotools / make: recipes.ts CMAKE, AUTOTOOLS, MAKE
// ---------------------------------------------------------------------------

function analyzeCmake(st: State): void {
  for (const f of st.files.values()) {
    const b = baseName(f.path);
    if (f.path === "CMakeLists.txt") runs(st, f.path, 1, "CMakeLists.txt runs during `cmake` configure");
    else if (b === "CMakeLists.txt") runs(st, f.path, 1, "runs only if reached by add_subdirectory");
    else if (b.endsWith(".cmake")) runs(st, f.path, 1, "runs only if reached by include()");
  }
  st.notes.push("cmake: FetchContent and ExternalProject fetch and build outside code");
}

function analyzeAutotools(st: State): void {
  const hasConfigure = st.files.has("configure");
  const sources = [...st.files.keys()].filter((p) => p === "configure.ac" || p === "Makefile.am" || (isRoot(p) && p.endsWith(".m4")));
  if (hasConfigure) runs(st, "configure", 1, "configure runs if it is executable (`./configure`)");
  for (const p of sources) {
    runs(st, p, 1, hasConfigure ? `${p} is run through \`autoreconf\` if configure is not executable` : `${p} is run through \`autoreconf -fi\` (configure is absent)`);
  }
  if (st.files.has("Makefile.in")) runs(st, "Makefile.in", 1, "Makefile.in becomes the Makefile that `make` runs");
  for (const n of ["GNUmakefile", "makefile", "Makefile"]) if (st.files.has(n)) runs(st, n, 1, `${n} is run by \`make\``);
  for (const f of st.files.values()) {
    if (f.truncated && GENERATED_KINDS.has(fileKind(f.path) ?? "")) {
      add(st, f.path, 1, `${clip(f.path)} was read only up to ${f.content.length} characters (the walk's per-file cap); the rest was not checked`, "build-hooks/truncated");
    }
  }
  st.notes.push("autotools: configure's helper scripts (config.guess, config.sub, install-sh, missing) and nested configure scripts run too and are not analysed");
}

function analyzeMake(st: State): void {
  const mk = pickMakefile(st.files);
  if (mk) runs(st, mk.path, 1, `${mk.path} is run by \`make\``);
  for (const f of st.files.values()) {
    if (f === mk) continue;
    const b = baseName(f.path);
    const isMake = b === "Makefile" || b === "makefile" || b === "GNUmakefile";
    if ((isMake && !isRoot(f.path)) || b.endsWith(".mk")) runs(st, f.path, 1, "runs only if reached by recursion or include");
  }
  st.notes.push("make: files a Makefile includes are not read unless they were walked");
}

// ---------------------------------------------------------------------------
// The outcome
// ---------------------------------------------------------------------------

const LOCATION_MAX = 120;
const MESSAGE_MAX = 200;
const RULE_MAX = 80;

function toFinding(r: Raw): Finding {
  const suffix = `:${r.line}`;
  return {
    check: "build-hooks",
    ruleId: oneLine(r.rule, RULE_MAX),
    level: r.level,
    message: oneLine(r.message, MESSAGE_MAX),
    location: `${oneLine(r.path.slice(0, 400), LOCATION_MAX - suffix.length)}${suffix}`,
  };
}

const LEVEL_ORDER: Level[] = ["error", "warning", "note"];

/**
 * Analyse the build files of a checkout for the recipe `ecosystem` will build with. Pure: reads `walk`, runs nothing.
 */
export function analyzeBuildHooks(ecosystem: Ecosystem, walk: BuildWalk): CheckOutcome {
  const files = new Map<string, BuildFile>();
  for (const f of walk.files) if (!files.has(f.path)) files.set(f.path, f);
  const st: State = { eco: ecosystem, files, items: [], notes: [], reasons: [], reported: new Set(), scans: [], badRootToml: [] };

  switch (ecosystem) {
    case "node": analyzeNode(st); break;
    case "python": analyzePython(st); break;
    case "rust": analyzeRust(st); break;
    case "go": analyzeGo(st); break;
    case "ruby": analyzeRuby(st); break;
    case "cmake": analyzeCmake(st); break;
    case "autotools": analyzeAutotools(st); break;
    case "make": analyzeMake(st); break;
    case "generic": st.notes.push("generic: nothing is built, so no repository code runs during the build"); break;
  }

  // Red flags: whole files that were reported (package.json: only the reported script strings).
  for (const p of st.reported) {
    const f = files.get(p) as BuildFile;
    if (baseName(p) === "package.json") continue;
    st.scans.push({ path: p, base: 1, text: f.content, sameLine: SAME_LINE_KINDS.has(fileKind(p) ?? "") });
  }
  const flags = new Map<string, { path: string; rule: RedFlagHit["rule"]; line: number; more: number }>();
  for (const job of st.scans) {
    for (const h of scanRedFlags(job.text, job.sameLine)) {
      const key = `${job.path}\u0000${h.rule}`;
      const prev = flags.get(key);
      if (prev) prev.more += 1 + h.more;
      else flags.set(key, { path: job.path, rule: h.rule, line: job.base + h.line - 1, more: h.more });
    }
  }
  const redFlags: Raw[] = [...flags.values()].map((h) => ({
    rule: h.rule,
    level: "warning",
    path: h.path,
    line: h.line,
    message: `${clip(h.path, 60)} ${RED_FLAG_TEXT[h.rule]}${h.more ? ` (and ${h.more} more line${h.more === 1 ? "" : "s"})` : ""}`,
  }));

  // Completeness.
  const reasons: string[] = [];
  if (walk.incomplete) reasons.push(`the walk of the checkout stopped short: ${clip(walk.incomplete, 120)}`);
  for (const link of walk.skippedLinks ?? []) {
    if (readsKind(ecosystem, link)) reasons.push(`${clip(link, 80)} is a symbolic link and was not read`);
  }
  for (const f of walk.files) {
    if (f.truncated && readsKind(ecosystem, f.path) && !GENERATED_KINDS.has(fileKind(f.path) ?? "")) {
      reasons.push(`${clip(f.path, 80)} was cut at the walk's per-file cap`);
    }
  }
  for (const p of st.badRootToml) reasons.push(`${clip(p, 80)} could not be parsed`);

  const all = [...redFlags, ...st.items];
  const counts = emptyCounts();
  for (const r of all) counts[r.level]++;
  const ordered = LEVEL_ORDER.flatMap((l) => all.filter((r) => r.level === l));
  const kept = ordered.slice(0, MAX_FINDINGS);

  const notes = [
    `Ecosystem analysed: ${ecosystem}.`,
    "This check is a heuristic reading aid, not a guarantee: it does not detect obfuscation (`\\x63url`, a command split across variables).",
    "Build code of dependencies is not listed.",
    "Files that a hook invokes, and files that configuration points at, are not read.",
    "A download saved to a file and run later is not detected.",
    "After the build, mcp-everything runs the project's executables for discovery (`--help`), so \"before any of its code runs\" covers the build.",
    ...st.notes.map((n) => oneLine(n, 300)),
    ...(reasons.length ? [`Incomplete: ${reasons.join("; ")}.`.slice(0, 1500)] : []),
  ];
  return {
    name: "build-hooks",
    kind: "builtin",
    status: reasons.length ? "incomplete" : "ran",
    counts,
    findings: kept.map(toFinding),
    omitted: ordered.length - kept.length,
    notes: notes.map((n) => oneLine(n, 1500)),
  };
}
