import type { Config } from "../config.js";
import { isStaleInstall } from "../install/installer.js";
import type { Registry } from "../registry.js";
import { projectNetworkName } from "../sandbox/network-spec.js";
import { PROJECT_LABEL, type SandboxInspectFacts } from "../sandbox/ownership.js";
import type { ProjectRecord } from "../types.js";
import type { Clock, Containment } from "./containment.js";

/**
 * The startup containment pass (flight 02, leg 10; DD8). Under `MCPE_NETWORK=contained`, when the server starts, every
 * sandbox of this installation (an owner label, a project label, no role) is brought to the state its record says: one that
 * is meant to be contained and is on `bridge` is contained, one the record says is off is taken off (the fail-safe), a
 * contained one's proxy is repaired or replaced when its session configuration changed. Nothing here starts a sandbox.
 *
 * Two layers, so that no exec into a sandbox runs before its step is done, without per-key promises being registered
 * before the listing is known: the gate (`registerStartupGate`, registered synchronously by `startContainmentPass`)
 * covers the window until the listing returns; in one synchronous block after it, one promise per project is registered and
 * the gate is released. A key's promise is settled by the step of the sandbox the record names, and by nothing else.
 *
 * Orphaned proxies and networks, the proxies of stopped sandboxes and stale lock files are not handled here (squawk 0052).
 * A labelled sandbox with no record is left as it is: a standing gap in "nothing runs uncontained", stated in the README.
 * A sandbox made before ownership was recorded has no owner label, so it is never listed here; and it never runs, because
 * every start of it is refused.
 */

/** The whole pass is bounded: when it passes, the steps not yet started do not start and every unsettled key is rejected. */
export const STARTUP_PASS_LIMIT_MS = 300_000;
/** How many sandboxes' steps run at once. */
export const STARTUP_CONCURRENCY = 4;

export const NOT_FINISHED = "startup containment did not finish";

/** The kinds of warning the pass puts on a record; each replaces an earlier one of the same kind. */
export type StartupKind = "take-off" | "contain-failed" | "kept-newer-proxy";
export const STARTUP_WARNING_PREFIX: Record<StartupKind, string> = {
  "take-off": "Startup containment (taken off the network): ",
  "contain-failed": "Startup containment (not contained): ",
  "kept-newer-proxy": "Startup containment (newer proxy kept): ",
};

export type StartupAction =
  | { kind: "leave-alone"; reason: "no-record" | "other-sandbox" | "gone" }
  | { kind: "skip" }
  | { kind: "contain" }
  | { kind: "repair" }
  | { kind: "take-off"; warn: boolean }
  | { kind: "nothing" }
  | { kind: "reject"; reason: string };

export interface StartupStepResult {
  action: StartupAction;
  /** The step was for the sandbox the record names: it settles the key's promise. */
  settles: boolean;
  /** What a repair's replacement did. */
  replaced?: "unchanged" | "replaced" | "kept-newer";
}

/** What Docker shows of a sandbox's networks: none, `bridge` (alone or with its own), its own `-net` only, or a network mcp-everything does not manage. */
export type DockerState = "none" | "bridge" | "own" | "foreign";

export function dockerStateOf(sandbox: string, networks: readonly string[]): DockerState {
  if (networks.length === 0) return "none";
  const own = projectNetworkName(sandbox);
  if (networks.some((n) => n !== "bridge" && n !== own)) return "foreign";
  return networks.includes("bridge") ? "bridge" : "own";
}

/**
 * DD8's table, pure: what the step does for a record and a sandbox's fresh facts. The rows:
 * - R1 no record: leave alone.
 * - R2 the record names another container (a renamed reinstall's old sandbox, a twin): leave alone.
 * - R3 `installing` and not stale: skip.
 * - R4 record on, Docker `bridge` (alone or with `-net`): contain.
 * - R5 record on, `-net` only: repair (the record label and the session label; a newer proxy kept).
 * - R6 record on, no network: contain.
 * - R7 record off, `bridge`: take off, with a warning (the fail-safe).
 * - R8 record off, `-net`: take off.
 * - R9 record off, no network: nothing.
 * - R10 record on, a network mcp-everything does not manage: rejected.
 * - R11 record off, a network mcp-everything does not manage: take off, with a warning.
 */
export function startupAction(
  record: ProjectRecord | undefined,
  facts: Pick<SandboxInspectFacts, "networks">,
  sandboxName: string,
  now: number,
  cfg: Config,
): StartupAction {
  if (!record) return { kind: "leave-alone", reason: "no-record" }; // R1
  if (record.container !== sandboxName) return { kind: "leave-alone", reason: "other-sandbox" }; // R2
  if (record.status === "installing" && !isStaleInstall(record, now, cfg)) return { kind: "skip" }; // R3
  const docker = dockerStateOf(sandboxName, facts.networks);
  if (record.network) {
    switch (docker) {
      case "bridge":
        return { kind: "contain" }; // R4
      case "own":
        return { kind: "repair" }; // R5
      case "none":
        return { kind: "contain" }; // R6
      case "foreign":
        return { kind: "reject", reason: "attached to a network mcp-everything does not manage" }; // R10
    }
  }
  switch (docker) {
    case "bridge":
    case "foreign":
      return { kind: "take-off", warn: true }; // R7, R11
    case "own":
      return { kind: "take-off", warn: false }; // R8
    case "none":
      return { kind: "nothing" }; // R9
  }
}

export interface StartupDeps {
  containment: Pick<Containment, "registerStartupGate" | "registerStartup" | "startupStep">;
  docker: { listOwnSandboxes(): Promise<SandboxInspectFacts[]>; ensureImage(image: string): Promise<void> };
  registry: Pick<Registry, "refresh" | "findByRepo">;
  cfg: Pick<Config, "docker">;
  clock: Clock;
  log: (line: string) => void;
  /** Settles when the reconciliation of stale installs is done: the pass needs reconciled records. Never rejects. */
  after?: Promise<unknown>;
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
  reject(e: unknown): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface KeyState extends Deferred {
  key: string;
  /** The container the record named when the key was registered. */
  container: string;
  remaining: number;
  settled: boolean;
}

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, " ").slice(0, 200);

/**
 * Starts the pass. The gate is registered synchronously, before this returns (before any tool call can arrive); the rest runs
 * in the background. The returned promise never rejects: it settles when every step is done, or at the bound.
 */
export function startContainmentPass(d: StartupDeps): Promise<void> {
  const gate = deferred();
  d.containment.registerStartupGate(gate.promise);
  return run(d, gate).catch((e: unknown) => {
    d.log(`startup: containment pass failed: ${reasonOf(e)}`);
    gate.reject(e); // a no-op when the gate is already settled
  });
}

async function run(d: StartupDeps, gate: Deferred): Promise<void> {
  const keys = new Map<string, KeyState>();
  let bounded = false;
  const counts: Record<string, number> = {};
  const count = (what: string): void => {
    counts[what] = (counts[what] ?? 0) + 1;
  };

  const limit = d.clock.after(STARTUP_PASS_LIMIT_MS);
  const bound = limit.promise.then(() => {
    bounded = true;
    gate.reject(new Error(NOT_FINISHED)); // a no-op once the listing has been handled
    for (const st of keys.values()) {
      if (st.settled) continue;
      st.settled = true;
      d.log(`startup: ${st.key}: containment failed: ${NOT_FINISHED}`);
      count("rejected");
      st.reject(new Error(NOT_FINISHED));
    }
  });

  const settle = (st: KeyState, error?: unknown): void => {
    if (st.settled) return;
    st.settled = true;
    if (error === undefined) st.resolve();
    else {
      d.log(`startup: ${st.key}: containment failed: ${reasonOf(error)}`);
      count("rejected");
      st.reject(error);
    }
  };

  // The proxy image, once per pass, outside every lock (never inside `withProjectLock`); a pull that failed fails each key that needs it.
  let image: Promise<void> | undefined;
  const ensureImageOnce = (): Promise<void> => (image ??= d.docker.ensureImage(d.cfg.docker.proxyImage));

  const work = (async () => {
    if (d.after) await d.after;
    let listed: SandboxInspectFacts[];
    try {
      listed = await d.docker.listOwnSandboxes();
    } catch (e) {
      d.log(`startup: the sandboxes could not be listed; network containment was not checked: ${reasonOf(e)}`);
      gate.reject(e);
      return;
    }
    if (bounded) return; // the bound passed first: the gate was rejected, and nothing is registered late

    // One synchronous block: register one promise per project, then release the gate. No await in between.
    const byKey = new Map<string, SandboxInspectFacts[]>();
    for (const f of listed) {
      const label = f.labels?.[PROJECT_LABEL];
      if (label === undefined || label === "") continue;
      const k = label.toLowerCase();
      byKey.set(k, [...(byKey.get(k) ?? []), f]);
    }
    let unreadable = false;
    try {
      d.registry.refresh();
    } catch {
      unreadable = true; // every key is registered; each step meets the unreadable registry and rejects
    }
    const steps: Array<{ key: string; facts: SandboxInspectFacts; st: KeyState }> = [];
    for (const [key, group] of byKey) {
      let record: ProjectRecord | undefined;
      if (!unreadable) {
        try {
          record = d.registry.findByRepo(key);
        } catch {
          unreadable = true;
        }
      }
      const container = record?.container;
      // A key with no record, or none of whose listed sandboxes the record names, has nothing to wait for: resolved at once.
      if (!unreadable && (container === undefined || !group.some((f) => f.name === container))) {
        counts["leave-alone"] = (counts["leave-alone"] ?? 0) + group.length;
        continue;
      }
      const state = deferred();
      const st: KeyState = { ...state, key, container: container ?? "", remaining: group.length, settled: false };
      keys.set(key, st);
      d.containment.registerStartup(key, st.promise);
      for (const facts of group) steps.push({ key, facts, st });
    }
    gate.resolve();

    const finish = (st: KeyState): void => {
      st.remaining--;
      if (st.remaining <= 0) settle(st);
    };
    const one = async (s: { key: string; facts: SandboxInspectFacts; st: KeyState }): Promise<void> => {
      const { key, facts, st } = s;
      try {
        // The image is ensured before a step whose record says on (a peek; the step re-reads under the lock).
        if (!unreadable) {
          d.registry.refresh();
          const rec = d.registry.findByRepo(key);
          if (rec && rec.container === facts.name && rec.network && rec.status !== "installing") await ensureImageOnce();
        }
        const out = await d.containment.startupStep(key, facts.name);
        count(out.action.kind);
        if (out.settles) settle(st);
      } catch (e) {
        if (facts.name === st.container || unreadable) settle(st, e);
        else d.log(`startup: ${key}: ${facts.name}: ${reasonOf(e)}`);
      } finally {
        finish(st);
      }
    };
    const queue = [...steps];
    const worker = async (): Promise<void> => {
      for (;;) {
        if (bounded) return; // steps not yet started do not start
        const next = queue.shift();
        if (!next) return;
        await one(next);
      }
    };
    await Promise.all(Array.from({ length: STARTUP_CONCURRENCY }, worker));
  })().catch((e: unknown) => {
    d.log(`startup: containment pass failed: ${reasonOf(e)}`);
    gate.reject(e);
    for (const st of keys.values()) settle(st, e);
  });

  await Promise.race([work, bound]);
  limit.cancel();
  const parts = Object.entries(counts).map(([k, v]) => `${k} ${v}`);
  d.log(`startup: network containment pass${bounded ? " (stopped at its bound)" : ""}: ${parts.length > 0 ? parts.join(", ") : "no sandboxes"}`);
}
