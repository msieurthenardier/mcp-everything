import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { API } from "typescript/unstable/sync";
import { SyntaxKind, type Node, type SourceFile } from "typescript/unstable/ast";
import { Docker } from "../src/sandbox/docker.js";
import { DOCKER_CLASSES } from "./sources.js";

/**
 * No bypass (leg 7). Every method of `Docker` is in exactly one table: the methods the containment hook guards, or a
 * documented table of methods that are not a sandbox start or exec, or that are unhooked by design. A new path fails a
 * test by name. Built with TypeScript's own AST (TypeScript 7 has no JavaScript compiler API: this is its
 * `typescript/unstable/sync` interface, which runs the native parser), not with regular expressions.
 */

const ROOT = path.resolve(import.meta.dirname, "..");

/** Methods whose body asks the hook (`this.hooked(...)`) before it starts a sandbox or runs a command in one. */
const HOOK_GUARDED = ["acquire", "ensureRunning", "startIfStopped", "exec"];

/**
 * Not a sandbox start or exec: it reads, classifies, creates or removes an object, or it starts and runs only a
 * container it made itself (a one-shot, a proxy) or a new sandbox that has no network or proxy to repair yet.
 */
const NOT_A_START_OR_EXEC: Record<string, string> = {
  assertAvailable: "docker version",
  sandboxName: "a name",
  docker: "the one place the binary is run (every call below goes through it)",
  clock: "the time",
  ask: "docker, with a failure turned into a typed error",
  isNotThere: "judges an answer",
  isNetworkNotThere: "judges an answer",
  unreadable: "makes an error",
  inspectContainer: "docker inspect",
  look: "inspect",
  inspectVolume: "docker volume inspect",
  containerFacts: "a value",
  volumeFacts: "a value",
  refuseUnless: "a check",
  resolveContainer: "inspect and classify",
  refuseRuntimeMismatch: "a check",
  runtimeRefusal: "judges an answer",
  assertRuntime: "the runtime trial: a one-shot of its own",
  checkRuntime: "the runtime trial: a one-shot of its own",
  inspectSandbox: "inspect and classify, for containment",
  ownership: "inspect and classify",
  state: "inspect",
  networkState: "inspect",
  doesNotExist: "makes an error",
  ensureImage: "docker pull",
  limits: "flags",
  imagePath: "docker image inspect",
  assertNameFree: "inspect",
  makeVolume: "docker volume create",
  requireVolumes: "docker volume inspect",
  createSandboxVolume: "docker volume create",
  removeStagingVolume: "docker volume rm",
  stagingName: "a name",
  runOnce: "a one-shot: a container it creates, runs and removes itself",
  runCreated: "a one-shot's create, start -a and rm",
  runBehindProxy: "a one-shot and its own proxy and network",
  startProxy: "starts the one-shot's own proxy",
  startAndAwait: "starts a proxy this call made, or a project's proxy, classified by owner and role",
  awaitProxyReady: "waits for a proxy",
  proxyStatus: "docker exec of the status one-liner in a PROXY (never a sandbox)",
  readRefusals: "reads a proxy's status",
  lastLogLine: "docker logs",
  checkedProxy: "inspect and classify a proxy",
  listProjectProxies: "docker ps and inspect",
  listOwnSandboxes: "docker ps and inspect (leg 10: this installation's sandboxes, for the startup pass)",
  projectProxyStatus: "reads a proxy's status",
  projectProxyAttached: "docker inspect",
  findProjectNetwork: "docker network inspect",
  checkContainedNetwork: "a check",
  findContainedNetwork: "docker network inspect",
  networkLabels: "reads an inspect",
  createNetwork: "docker network create",
  createContainedNetwork: "docker network create",
  dropNetwork: "removes a network this call made",
  dropContainer: "removes a container this call made",
  rmContainer: "docker rm",
  rmProxy: "docker rm of a proxy",
  rmNetwork: "docker network rm",
  projectObjects: "lists a sandbox's proxies and network",
  removeContainer: "docker rm",
  destroy: "docker rm and volume rm",
  destroyNow: "the body of destroy",
  removeProjectProxy: "docker rm of a proxy",
  removeProjectProxyNamed: "docker rm of a proxy",
  removeProjectNetwork: "docker network rm",
  sweepCheckLeftovers: "removes what it listed and classified",
  readUpstreamResolvers: "a one-shot",
  readResolvers: "a one-shot",
  invalidateResolvers: "forgets a value",
  probe: "a one-shot clone",
  runScanner: "a one-shot scanner, over a staging volume (source stage) or a sandbox volume (build stage); both gated by requireVolumes",
  copyVolume: "a one-shot copy",
  hooked: "calls the hook with facts it was given",
  hookCached: "reads a cache",
  invalidate: "clears a cache",
  setContainment: "installs the hook",
  execOnce: "the primitive of exec; reached only from exec (checked below)",
  startId: "the primitive of the starts; reached only from the guarded methods and startForContainment (checked below)",
  attachProjectNetwork: "docker network connect and disconnect: moves a sandbox between networks, never starts or execs it",
  setNetwork: "docker network connect and disconnect, never a start or an exec",
  setNetworkNow: "the body of setNetwork",
  disconnectForce: "docker network disconnect",
  ensureProjectNetwork: "docker network inspect and create",
  createProjectProxy: "creates, joins and starts a PROXY it made itself (startAndAwait)",
  startProjectProxy: "starts a project's PROXY, classified by owner and role",
  // A new sandbox is created on `bridge` here. There is nothing to repair yet: it has no network of its own and no proxy.
  // Leg 8 (T15): under `MCPE_NETWORK=contained` it is only created (`start: false`, `docker create`), and `Containment.contain`
  // starts it after it is contained, through `startForContainment`; a start here under containment is refused by the method
  // itself (a unit case). Under `open` it is `docker run -d` as before: the listed exception for the open mode.
  createContainer: "docker run -d (open) or docker create (contained, start: false): makes a NEW sandbox on bridge; refuses a start under containment",
  projectRefusals: "docker ps and a read of each project proxy's status: what the proxies refused",
  // Leg 13 (proxy by address).
  probeSubnet: "a throwaway network this call made, read and removed",
  networkCreateFailure: "makes an error",
  detachProjectProxy: "docker network disconnect of a PROXY, classified by owner and role",
  restoreProjectProxy: "stop, connect and start of a PROXY (startAndAwait), classified by owner and role",
  clearLocalAccess: "calls writeLocalAccess (listed below) when a sandbox leaves its network",
  // Leg 14 (gVisor network changes).
  needsRestartToChangeNetwork: "a judgement of facts it was given",
  afterStarted: "calls the post-start step with facts it was given",
};

/** Unhooked by design, containment-internal: only `Containment` calls these, and none of them execs in a sandbox. */

const UNHOOKED_BY_DESIGN: Record<string, string> = {
  startForContainment: "the start containment makes itself, before and without the hook, while it builds the network and the proxy",
  // Leg 14. Under a non-runc runtime a running sandbox's network can only change while it is stopped: `whileStopped` is stop, the
  // change, then the unhooked start and the post-start step. Reached only from `setNetworkNow` and `attachProjectNetwork` (the
  // network changes containment makes) and `restartSandbox` (the T18 rollback's restart); never an exec.
  whileStopped: "stop, a network change and an unhooked start of a sandbox, for containment's own network changes under a non-runc runtime",
  restartSandbox: "containment's restart of a running sandbox when it rolls back a restore (T18): resolves and classifies, then whileStopped",
  // The one exec in a sandbox that is not the hook's: a root write of `/etc/hosts` (a fixed script, validated lines). Through the
  // hook it would recurse (the hook repairs, and repair writes). Only `Containment` and the class's own `clearLocalAccess` call it.
  writeLocalAccess: "a root exec of a fixed script that writes the sandbox's /etc/hosts, called by containment's post-start step and replacement",
};

/** The calls that start a sandbox or run a command in one. */
const PRIMITIVES = new Set(["startId", "execOnce", "startIfStopped", "ensureRunning"]);
const VERBS = new Set(["start", "exec", "run", "restart", "unpause", "attach"]);

interface Site {
  caller: string;
  what: string;
  /** Offset of the call in its file, to compare the order of two calls in one method. */
  at: number;
}

let api: API;
/** Every class that makes up `Docker` (`DOCKER_CLASSES`), found in the program. */
let dockerClasses: Node[];
let all: SourceFile[];

function walk(node: Node, fn: (n: Node) => void): void {
  fn(node);
  node.forEachChild((c) => {
    walk(c, fn);
    return undefined;
  });
}

function nameOf(member: Node): string | undefined {
  const n = (member as unknown as { name?: { text?: string } }).name;
  return typeof n?.text === "string" ? n.text : undefined;
}

function members(cls: Node): Node[] {
  return (cls as unknown as { members: Node[] }).members.filter((m) => nameOf(m) !== undefined);
}

/** The members of every class in `DOCKER_CLASSES`, in list order. */
function dockerMembers(): Node[] {
  return dockerClasses.flatMap(members);
}

/** The methods, accessors and class-field functions of every class in `DOCKER_CLASSES`, by name, once each. */
function memberNames(): string[] {
  const out: string[] = [];
  for (const m of dockerMembers()) {
    if (m.kind === SyntaxKind.MethodDeclaration || m.kind === SyntaxKind.GetAccessor || m.kind === SyntaxKind.SetAccessor) out.push(nameOf(m)!);
    else if (m.kind === SyntaxKind.PropertyDeclaration) {
      const init = (m as unknown as { initializer?: Node }).initializer;
      if (init && (init.kind === SyntaxKind.ArrowFunction || init.kind === SyntaxKind.FunctionExpression)) out.push(nameOf(m)!);
    }
  }
  return [...new Set(out)];
}

const isThisAccess = (n: Node): string | undefined => {
  if (n.kind !== SyntaxKind.PropertyAccessExpression) return undefined;
  const pa = n as unknown as { expression: Node; name: { text: string } };
  return pa.expression.kind === SyntaxKind.ThisKeyword ? pa.name.text : undefined;
};

/** Every call in the class that starts or execs: a call of a primitive, or `this.docker(`/`this.ask(` with a start-or-exec verb or a verb that is not a literal. */
function sites(): Site[] {
  const found: Site[] = [];
  for (const m of dockerMembers()) {
    const caller = nameOf(m)!;
    walk(m, (n) => {
      if (n.kind !== SyntaxKind.CallExpression) return;
      const call = n as unknown as { expression: Node; arguments: Node[] };
      const callee = isThisAccess(call.expression);
      if (callee !== undefined && PRIMITIVES.has(callee)) found.push({ caller, what: `this.${callee}`, at: n.pos });
      if (callee === "docker" || callee === "ask") {
        const first = call.arguments[0];
        if (!first) return;
        // `networkInspectArgs(x)` builds `network inspect <x>`: read-only, the one named builder.
        if (first.kind === SyntaxKind.CallExpression && (first as unknown as { expression: { text?: string } }).expression.text === "networkInspectArgs") return;
        if (first.kind !== SyntaxKind.ArrayLiteralExpression) {
          found.push({ caller, what: `this.${callee}(<not a literal>)`, at: n.pos });
          return;
        }
        const el = (first as unknown as { elements: Node[] }).elements[0];
        if (!el || el.kind !== SyntaxKind.StringLiteral) {
          found.push({ caller, what: `this.${callee}([<not a literal verb>])`, at: n.pos });
          return;
        }
        const verb = (el as unknown as { text: string }).text;
        if (VERBS.has(verb)) found.push({ caller, what: `this.${callee}(["${verb}"…])`, at: n.pos });
      }
      // The binary run directly, bypassing `this.docker`.
      if (call.expression.kind === SyntaxKind.Identifier && (call.expression as unknown as { text: string }).text === "run") {
        found.push({ caller, what: "run(...)", at: n.pos });
      }
    });
  }
  return found;
}

beforeAll(() => {
  api = new API({ cwd: ROOT });
  const snapshot = api.updateSnapshot({ openProject: path.join(ROOT, "tsconfig.json") });
  const project = snapshot.getProjects()[0]!;
  const get = (f: string) => {
    const sf = project.program.getSourceFile(f);
    if (!sf) throw new Error(`no source file ${f}`);
    return sf;
  };
  dockerClasses = DOCKER_CLASSES.map(({ file, className }) => {
    const cls = get(path.join(ROOT, file)).statements.find((s) => s.kind === SyntaxKind.ClassDeclaration && nameOf(s) === className);
    if (!cls) throw new Error(`class ${className} not found in ${file}`);
    return cls;
  });
  all = project.program.getSourceFileNames().filter((f) => f.startsWith(path.join(ROOT, "src") + path.sep) && f.endsWith(".ts")).map(get);
});
afterAll(() => api?.close());

describe("no bypass of the containment hook", () => {
  it("the tables and the class agree: every method and class-field function is in exactly one, and nothing else is", () => {
    // Own names along Docker's prototype chain up to Object.prototype, so a base class holding some of the methods counts too.
    const protoSet = new Set<string>();
    for (let p: object | null = Docker.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const n of Object.getOwnPropertyNames(p)) if (n !== "constructor") protoSet.add(n);
    }
    const protoNames = [...protoSet];
    const fromSource = memberNames();
    // Fields hold functions only as class fields (they are not on the prototype): none is expected, and the two views agree.
    expect([...fromSource].sort()).toEqual([...protoNames].sort());
    const tables = [HOOK_GUARDED, Object.keys(NOT_A_START_OR_EXEC), Object.keys(UNHOOKED_BY_DESIGN)];
    const flat = tables.flat();
    expect(new Set(flat).size, `a method is in two tables: ${flat.filter((n, i) => flat.indexOf(n) !== i).join(", ")}`).toBe(flat.length);
    const unlisted = fromSource.filter((n) => !flat.includes(n));
    expect(unlisted, `new Docker methods that no table judges (a new path is a bypass until someone says it is not): ${unlisted.join(", ")}`).toEqual([]);
    const stale = flat.filter((n) => !fromSource.includes(n));
    expect(stale, `tables name methods that are gone: ${stale.join(", ")}`).toEqual([]);
  });

  it("every call that starts or execs sits in a hook-guarded method, or in a documented table (by name)", () => {
    const allowed = new Set([...HOOK_GUARDED, ...Object.keys(UNHOOKED_BY_DESIGN)]);
    // Direct verbs belong to the machinery methods below; primitive calls belong to the guarded or unhooked-by-design ones.
    const MACHINERY = new Set(["startId", "execOnce", "runCreated", "startProxy", "startAndAwait", "proxyStatus", "createContainer", "docker", "ask", "writeLocalAccess"]);
    // An argument list that is not a literal is judged by hand: `ask` forwards its caller's; `execOnce` builds `exec -i ...`;
    // the sweep builds `ps`, `inspect` and `rm` of containers it listed and classified.
    const DYNAMIC = new Set(["ask", "execOnce", "sweepCheckLeftovers"]);
    for (const s of sites()) {
      if (s.what.includes("<not a")) {
        expect(DYNAMIC.has(s.caller), `${s.caller} calls ${s.what}: an argument list the test cannot read, in a method not judged by hand`).toBe(true);
        continue;
      }
      const ok = s.what.startsWith("this.docker") || s.what.startsWith("this.ask") || s.what === "run(...)" ? MACHINERY.has(s.caller) : allowed.has(s.caller);
      expect(ok, `${s.caller} calls ${s.what}: a start or exec outside the hook-guarded methods and the documented tables`).toBe(true);
    }
  });

  it("calls of the primitives come only from the guarded methods and startForContainment, with the exact callers recorded", () => {
    const callers = (what: string) => [...new Set(sites().filter((s) => s.what === what).map((s) => s.caller))].sort();
    expect(callers("this.startId")).toEqual(["acquire", "ensureRunning", "startForContainment", "startIfStopped", "whileStopped"]);
    expect(callers("this.execOnce")).toEqual(["exec"]);
    expect(callers("this.startIfStopped")).toEqual(["exec"]);
    expect(callers("this.ensureRunning")).toEqual([]);
  });

  it("each guarded method asks the hook before its first start or exec", () => {
    const byName = new Map(dockerMembers().map((m) => [nameOf(m)!, m]));
    for (const name of HOOK_GUARDED) {
      const member = byName.get(name)!;
      const hooked: number[] = [];
      const acts: number[] = [];
      walk(member, (n) => {
        if (n.kind !== SyntaxKind.CallExpression) return;
        const callee = isThisAccess((n as unknown as { expression: Node }).expression);
        if (callee === "hooked") hooked.push(n.pos);
        if (callee === "startId" || callee === "execOnce") acts.push(n.pos);
      });
      if (name === "exec") {
        // exec is guarded twice: by name and by reference it asks `hooked` before `execOnce`; the retry asks through startIfStopped.
        expect(hooked.length, "exec asks the hook for a name and for a reference").toBeGreaterThanOrEqual(2);
      } else {
        expect(hooked.length, `${name} never asks the hook`).toBeGreaterThanOrEqual(1);
      }
      if (acts.length > 0) expect(Math.min(...hooked), `${name} starts or execs before it asks the hook`).toBeLessThan(Math.min(...acts));
    }
  });

  it("startForContainment is called only by containment.ts", () => {
    const users: string[] = [];
    for (const sf of all) {
      walk(sf, (n) => {
        if (n.kind === SyntaxKind.PropertyAccessExpression && (n as unknown as { name: { text: string } }).name.text === "startForContainment") users.push(path.relative(ROOT, sf.fileName));
      });
    }
    const outside = [...new Set(users)].filter((f) => f !== path.join("src", "network", "containment.ts") && f !== path.join("src", "sandbox", "docker.ts"));
    expect(outside).toEqual([]);
  });

  it("writeLocalAccess is called only by containment.ts and by docker.ts's own clearLocalAccess", () => {
    const users: string[] = [];
    for (const sf of all) {
      walk(sf, (n) => {
        if (n.kind === SyntaxKind.PropertyAccessExpression && (n as unknown as { name: { text: string } }).name.text === "writeLocalAccess") users.push(path.relative(ROOT, sf.fileName));
      });
    }
    expect([...new Set(users)].sort()).toEqual([path.join("src", "network", "containment.ts"), path.join("src", "sandbox", "docker.ts")]);
    const callers: string[] = [];
    for (const m of dockerMembers()) {
      walk(m, (n) => {
        if (n.kind === SyntaxKind.CallExpression && isThisAccess((n as unknown as { expression: Node }).expression) === "writeLocalAccess") callers.push(nameOf(m)!);
      });
    }
    expect([...new Set(callers)]).toEqual(["clearLocalAccess"]);
  });

  it("the startup step (leg 10) and its lock-free internals start and exec through the unhooked start only, and never wait or hook", () => {
    const sf = all.find((f) => f.fileName === path.join(ROOT, "src/network/containment.ts"))!;
    const cls = sf.statements.find((s) => s.kind === SyntaxKind.ClassDeclaration && nameOf(s) === "Containment")!;
    const byName = new Map(members(cls).map((m) => [nameOf(m)!, m]));
    // What each of these may call, by property name, on `this` or `this.docker`.
    const FORBIDDEN = ["acquire", "ensureRunning", "startIfStopped", "exec", "startId", "execOnce", "waitFor", "ensureContained", "ensureImage", "openUnlessContained", "contain", "replace", "repair", "startupStep"];
    const calls = (name: string): string[] => {
      const out: string[] = [];
      walk(byName.get(name)!, (n) => {
        if (n.kind !== SyntaxKind.CallExpression) return;
        const e = (n as unknown as { expression: Node }).expression;
        if (e.kind !== SyntaxKind.PropertyAccessExpression) return;
        out.push((e as unknown as { name: { text: string } }).name.text);
      });
      return out;
    };
    for (const name of ["startupStep", "containLocked", "takeOffLocked", "repairLocked", "replaceLocked"]) {
      const used = calls(name);
      for (const f of FORBIDDEN) expect(used, `${name} calls ${f}`).not.toContain(f);
    }
    // The only start it can make is the unhooked one (and `contain` alone asks for it, with `start`); the step takes the lock once, and the locked internals never do.
    expect(calls("startupStep").filter((c) => c === "withProjectLock")).toHaveLength(1);
    for (const name of ["containLocked", "takeOffLocked", "repairLocked", "replaceLocked"]) expect(calls(name)).not.toContain("withProjectLock");
    expect(calls("startupStep")).not.toContain("startForContainment");
    // The pass (startup.ts) reaches Docker only for the listing and the image.
    const pass = all.find((f) => f.fileName === path.join(ROOT, "src/network/startup.ts"))!;
    const used = new Set<string>();
    walk(pass, (n) => {
      if (n.kind !== SyntaxKind.CallExpression) return;
      const e = (n as unknown as { expression: Node }).expression;
      if (e.kind === SyntaxKind.PropertyAccessExpression) used.add((e as unknown as { name: { text: string } }).name.text);
    });
    for (const f of ["acquire", "exec", "startForContainment", "setNetwork", "setContainment", "removeProjectProxy"]) expect(used.has(f), `startup.ts calls ${f}`).toBe(false);
  });

  it("cfg.docker.bin is used only by the Docker class and by dockerConnector, which depends on acquire's environment", () => {
    const users = new Map<string, Set<string>>();
    for (const sf of all) {
      walk(sf, (n) => {
        if (n.kind !== SyntaxKind.PropertyAccessExpression) return;
        const pa = n as unknown as { expression: Node; name: { text: string } };
        if (pa.name.text !== "bin" || pa.expression.kind !== SyntaxKind.PropertyAccessExpression) return;
        if ((pa.expression as unknown as { name: { text: string } }).name.text !== "docker") return;
        const file = path.relative(ROOT, sf.fileName);
        // The enclosing function's name, as far as the tree says.
        let up: Node | undefined = n;
        let where = "<module>";
        while (up) {
          const nm = nameOf(up);
          if ((up.kind === SyntaxKind.MethodDeclaration || up.kind === SyntaxKind.FunctionDeclaration) && nm) {
            where = nm;
            break;
          }
          up = up.parent;
        }
        if (!users.has(file)) users.set(file, new Set());
        users.get(file)!.add(where);
      });
    }
    // `dockerConnector` is a function returning an arrow: the enclosing named function is it. It runs `docker exec -i <id> sh -c <the server>`
    // on a reference whose `env` came from `acquire` (the hook's answer): the proxy variables travel as `-e` flags.
    expect([...users.keys()].sort()).toEqual([path.join("src", "proxy", "mcp-proxy.ts"), path.join("src", "sandbox", "docker-base.ts")]);
    expect([...users.get(path.join("src", "proxy", "mcp-proxy.ts"))!]).toEqual(["dockerConnector"]);
    expect([...users.get(path.join("src", "sandbox", "docker-base.ts"))!].sort()).toEqual(["assertAvailable", "ask", "docker"].sort());
  });
});
