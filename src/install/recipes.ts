import path from "node:path";
import { BIN_DIR, OUTPUT_DIR, PREFIX, REPO_DIR, VENV_DIR, WORK_DIR, WORKSPACE } from "../sandbox/scripts.js";
import type { Ecosystem } from "../types.js";

/**
 * Install recipes. Each is a fixed POSIX shell script run inside the sandbox;
 * nothing from the repository is ever interpolated into them. Their contract:
 *
 *   - leave runnable executables in /opt/mcpe/bin (or, for Python, console
 *     scripts in the /opt/mcpe/venv virtualenv). /opt/mcpe is a symlink to
 *     /workspace/.mcpe, so the output is on the sandbox's volume, and
 *   - print `MCPE_WARN <message>` for non-fatal problems, and
 *   - print `MCPE_SOFT_FAIL` when a core build step failed without aborting.
 */

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The prelude's output step: clear the volume's output directory (every attempt, so a retry never sees the last one's
 * output), then make `prefix` a symlink to it, unless the image has a real directory there: that is warned about and left.
 * Only constants are interpolated, never anything from the repository.
 */
export function outputStep({ output, prefix }: { output: string; prefix: string }): string {
  const parent = path.posix.dirname(prefix);
  return `rm -rf ${q(output)}
mkdir -p ${q(output)} ${q(parent)}
if [ -d ${q(prefix)} ] && [ ! -L ${q(prefix)} ]; then
  echo "MCPE_WARN the image has its own ${prefix}; the build output is not on the sandbox's volume"
else
  ln -sfn ${q(output)} ${q(prefix)}
fi`;
}

const PRELUDE = `
set -e
${outputStep({ output: OUTPUT_DIR, prefix: PREFIX })}
mkdir -p ${BIN_DIR} ${WORK_DIR}
cd ${REPO_DIR}
warn() { echo "MCPE_WARN $*"; }
# A core build step failed but the recipe can carry on: worth a retry on
# another runtime version if the project allows one.
soft_fail() { echo "MCPE_SOFT_FAIL"; warn "$@"; }
need() { command -v "$1" >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq --no-install-recommends "$2" >/dev/null; }; }
link_elves() {
  # Symlink freshly built ELF executables that never got "installed".
  for dir in "$@"; do
    [ -d "$dir" ] || continue
    find "$dir" -maxdepth 3 -type f -perm -u+x ! -name '*.so*' ! -name '*.o' ! -path '*/.git/*' ! -path '*/CMakeFiles/*' 2>/dev/null | head -n 200 | while IFS= read -r f; do
      [ "$(head -c 4 "$f" | od -An -c | tr -d ' ')" = '177ELF' ] || continue
      name=$(basename "$f")
      [ -e "${BIN_DIR}/$name" ] || ln -s "$f" "${BIN_DIR}/$name"
    done
  done
}
`;

const PYTHON = `
python3 -m venv ${VENV_DIR}
${VENV_DIR}/bin/python -m pip install --quiet --upgrade pip
if [ -f pyproject.toml ] || [ -f setup.py ] || [ -f setup.cfg ]; then
  if ! ${VENV_DIR}/bin/pip install .; then
    if [ -f requirements.txt ]; then
      soft_fail "pip install . failed; installed requirements.txt instead"
      ${VENV_DIR}/bin/pip install -r requirements.txt
    else
      exit 1
    fi
  fi
elif [ -f requirements.txt ]; then
  ${VENV_DIR}/bin/pip install -r requirements.txt
fi
`;

const NODE = `
corepack enable >/dev/null 2>&1 || true
run="npm run"
if [ -f pnpm-lock.yaml ]; then
  command -v pnpm >/dev/null 2>&1 || npm install -g pnpm
  pnpm install --frozen-lockfile || pnpm install
  run="pnpm run"
elif [ -f yarn.lock ]; then
  command -v yarn >/dev/null 2>&1 || npm install -g yarn
  yarn install
  run="yarn run"
elif [ -f package-lock.json ] || [ -f npm-shrinkwrap.json ]; then
  npm ci || npm install
else
  npm install
fi
if node -e 'const s=require("./package.json").scripts||{};process.exit(s.build?0:1)' 2>/dev/null; then
  $run build || soft_fail "build script failed; binaries that need a build step may be missing"
fi
`;

const RUST = `
export CARGO_TARGET_DIR=${WORKSPACE}/target
cargo build --release --bins || cargo build --release
find ${WORKSPACE}/target/release -maxdepth 1 -type f -perm -u+x ! -name '*.so' ! -name '*.d' ! -name '*.rlib' ! -name '.*' -exec cp {} ${BIN_DIR}/ ';'
`;

// GOTOOLCHAIN=auto lets the go command download the toolchain go.mod asks for
// when it is newer than the image's (the official image disables that).
// GOFLAGS is exported here rather than container-wide: `make` re-exports any
// variable it inherited from the environment, which breaks Makefiles that use
// GOFLAGS as a plain make variable.
const GO = `
export GOBIN=${BIN_DIR} GOFLAGS=-buildvcs=false GOTOOLCHAIN=auto
failed=0
go list -f '{{if eq .Name "main"}}{{.Dir}}{{end}}' ./... 2>/dev/null \\
  | sed -n 's|^${REPO_DIR}|.|p' \\
  | grep -Ev '/(internal|examples?|_examples|testdata|tests?|hack|docs?)(/|$)' \\
  | head -n 15 > /tmp/mcpe-mains || true
[ -s /tmp/mcpe-mains ] || warn "no main packages found in the root Go module"
while IFS= read -r pkg; do
  go install "$pkg" || { warn "go install $pkg failed"; failed=1; }
done < /tmp/mcpe-mains
if [ "$failed" = 1 ] && [ -z "$(ls -A ${BIN_DIR})" ] && { [ -f Makefile ] || [ -f GNUmakefile ] || [ -f makefile ]; }; then
  # Some Go projects generate sources from their Makefile before compiling.
  unset GOFLAGS
  if make; then link_elves ${REPO_DIR}; else warn "fallback make failed"; fi
fi
`;

const RUBY = `
if [ -f Gemfile ]; then bundle install || warn "bundle install failed"; fi
spec=$(ls *.gemspec 2>/dev/null | head -n 1)
if [ -n "$spec" ]; then
  if gem build "$spec" -o /tmp/mcpe.gem && gem install /tmp/mcpe.gem; then
    gem spec /tmp/mcpe.gem executables | sed -n 's/^- //p' | while IFS= read -r exe; do
      target=$(command -v "$exe" || true)
      [ -n "$target" ] && ln -sf "$target" "${BIN_DIR}/$exe"
    done
  else
    warn "gem build/install failed"
  fi
fi
`;

const CMAKE = `
need cmake cmake
cmake -S . -B ${WORKSPACE}/build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=${PREFIX}
cmake --build ${WORKSPACE}/build -j "$(nproc)"
cmake --install ${WORKSPACE}/build || warn "cmake --install failed; linking built executables instead"
link_elves ${WORKSPACE}/build
`;

const AUTOTOOLS = `
if [ ! -x configure ]; then
  need autoreconf autoconf; need automake automake; need libtoolize libtool
  autoreconf -fi
fi
./configure --prefix=${PREFIX}
make -j "$(nproc)"
make install || warn "make install failed; linking built executables instead"
link_elves ${REPO_DIR}
`;

const MAKE = `
make -j "$(nproc)" || make || warn "make failed"
make install PREFIX=${PREFIX} prefix=${PREFIX} >/dev/null 2>&1 || true
link_elves ${REPO_DIR}
`;

const BODIES: Record<Ecosystem, string> = {
  python: PYTHON,
  node: NODE,
  rust: RUST,
  go: GO,
  ruby: RUBY,
  cmake: CMAKE,
  autotools: AUTOTOOLS,
  make: MAKE,
  generic: "",
};

export function recipeFor(ecosystem: Ecosystem): string {
  return `${PRELUDE}\n${BODIES[ecosystem]}`;
}

/**
 * Printed as JSON by the project's own interpreter: which console scripts and
 * importable modules belong to distributions installed from the local checkout
 * (PEP 610 direct_url.json), as opposed to their dependencies. Scripts of a
 * distribution that requires an MCP SDK are reported as MCP server candidates.
 */
export const PYTHON_DISCOVERY = `
import json, importlib.metadata as md
out = {"scripts": [], "modules": [], "dists": [], "mcp_scripts": [], "owners": {}}
def req_name(req):
    name = ""
    for ch in req.strip().lower():
        if not (ch.isalnum() or ch in "-_."):
            break
        name += ch
    return name.replace("_", "-")
for d in md.distributions():
    try:
        direct = json.loads(d.read_text("direct_url.json") or "null")
    except Exception:
        direct = None
    if not direct or not str(direct.get("url", "")).startswith("file://"):
        continue
    out["dists"].append(str(d.metadata["Name"]))
    scripts = [ep.name for ep in d.entry_points if ep.group == "console_scripts"]
    out["scripts"].extend(scripts)
    for script in scripts:
        out["owners"][script] = str(d.metadata["Name"])
    if any(req_name(r) in ("mcp", "fastmcp") for r in (d.requires or [])):
        out["mcp_scripts"].extend(scripts)
    tops = set((d.read_text("top_level.txt") or "").split())
    if not tops:
        for f in d.files or []:
            head = str(f).split("/")[0]
            if head.endswith((".dist-info", ".egg-info", ".pth")) or head.startswith(("_", ".")):
                continue
            tops.add(head[:-3] if head.endswith(".py") else head)
    out["modules"].extend(sorted(tops))
print(json.dumps(out))
`;

/**
 * Links every `bin` entry of the root package and of nearby workspace packages
 * into /opt/mcpe/bin and prints what it linked as JSON, plus which of them
 * belong to packages that depend on an MCP SDK. Runs under the sandbox's own
 * node.
 */
export const NODE_DISCOVERY = `
const fs = require("fs"), path = require("path");
const root = ${JSON.stringify(REPO_DIR)}, binDir = ${JSON.stringify(BIN_DIR)};
const SKIP = new Set(["node_modules", ".git", "test", "tests", "__tests__", "fixtures", "examples", "example", "docs", "dist", "build", "coverage", "vendor"]);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const out = { bins: [], packages: [], missing: [], mcp: [], owners: {} };
const MCP_SDK = (d) => d.startsWith("@modelcontextprotocol/") || d === "fastmcp" || d === "mcp-framework";
function visit(dir, depth) {
  const file = path.join(dir, "package.json");
  if (fs.existsSync(file)) {
    let pkg; try { pkg = JSON.parse(fs.readFileSync(file, "utf8")); } catch { pkg = null; }
    if (pkg && typeof pkg === "object") {
      if (typeof pkg.name === "string") out.packages.push(pkg.name);
      const isMcp = Object.keys(Object.assign({}, pkg.dependencies, pkg.peerDependencies)).some(MCP_SDK);
      let bin = pkg.bin;
      if (typeof bin === "string" && typeof pkg.name === "string") bin = { [pkg.name.split("/").pop()]: bin };
      if (bin && typeof bin === "object") {
        for (const [name, rel] of Object.entries(bin)) {
          if (!NAME.test(name) || typeof rel !== "string" || out.bins.length >= 20) continue;
          const target = path.resolve(dir, rel);
          if (!target.startsWith(root + path.sep)) continue;
          if (!fs.existsSync(target)) { out.missing.push(name); continue; }
          if (isMcp && !out.mcp.includes(name)) out.mcp.push(name);
          if (typeof pkg.name === "string" && !(name in out.owners)) out.owners[name] = pkg.name;
          const link = path.join(binDir, name);
          if (fs.existsSync(link)) continue;
          const head = Buffer.alloc(2);
          const fd = fs.openSync(target, "r"); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
          if (head.toString() === "#!") {
            try { fs.chmodSync(target, 0o755); } catch {}
            fs.symlinkSync(target, link);
          } else {
            fs.writeFileSync(link, "#!/bin/sh\\nexec node '" + target.replace(/'/g, "'\\\\''") + "' \\"$@\\"\\n", { mode: 0o755 });
          }
          out.bins.push(name);
        }
      }
    }
  }
  if (depth >= 3) return;
  let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {}
  for (const e of entries) {
    if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith(".")) visit(path.join(dir, e.name), depth + 1);
  }
}
fs.mkdirSync(binDir, { recursive: true });
visit(root, 0);
console.log(JSON.stringify(out));
`;
