import { randomBytes } from "node:crypto";
import { PROXY_PORT, type HostEntry } from "../network/hosts.js";
import { PROXY_CONTROL_PORT, PROXY_PROGRAM_VERSION, proxyConfig, proxyLaunchArgs, type ProxyConfig } from "../network/proxy/config.js";
import type { RunResult } from "../util/exec.js";
import { oneLine } from "../util/text.js";
import { DockerBase, FULL_ID, type OneShotResult, type OneShotSpec, ONE_SHOT_ROLES, type SandboxRef } from "./docker-base.js";
import { ContainmentUnavailableError, DockerUnavailableError, ProxyStartError, RuntimeUnavailableError } from "./errors.js";
import {
  HOSTS_NAME,
  isRuncRuntime,
  LOCAL_ACCESS_MARK,
  LOCAL_ACCESS_SCRIPT,
  lowerHalf,
  newProjectProxyName,
  OWN_HOST_NAMES,
  parseProxyReport,
  parseResolvConf,
  projectNetworkName,
  proxyAddress,
  proxyNetworkSpec,
  type ProxyRefusalRow,
  type ProxyReport,
} from "./network-spec.js";
import {
  classifySandbox,
  clean,
  OWNER_LABEL,
  PROJECT_LABEL,
  ROLE_LABEL,
  SANDBOX_LABEL,
  SandboxRefusedError,
  type SandboxFacts,
  type SandboxInspectFacts,
} from "./ownership.js";

const EXTRA_CAPS: readonly string[] = ["CHOWN", "FOWNER", "DAC_OVERRIDE", "FSETID"];
/** The role of the network a one-shot behind a proxy runs on. */
export const ONESHOT_NET_ROLE = "oneshot-net";
/** What the message of a refused network says a Docker needs. No number until one has been measured (leg 4 measured 29.4.2 and 29.8.2 as working, no lower bound). */
const ISOLATED_BRIDGE_NEEDS = "a Docker version whose bridge driver supports gateway_mode_ipv4=isolated";
/** The roles of a project's network and proxies, and the label that names the sandbox they belong to. */
export const PROJECT_NET_ROLE = "project-net";
const PROJECT_PROXY_ROLE = "project-proxy";
const RESERVED_LABELS = new Set(["mcp-everything", OWNER_LABEL, ROLE_LABEL, PROJECT_LABEL, SANDBOX_LABEL]);
const NETWORK_FORMAT =
  '{"id":{{json .Id}},"name":{{json .Name}},"internal":{{json .Internal}},"ipv6":{{json .EnableIPv6}},"ipam":{{json .IPAM.Config}},"labels":{{json .Labels}},"created":{{json .Created}}}';
const POOLS_EXHAUSTED = /all predefined address pools have been fully subnetted/i;
/**
 * Docker's refusal of a subnet that overlaps one in use: another network took it between the probe and the real create.
 * Older daemons say "Pool overlaps with other one"; Docker 29 says "cannot create network ...: conflicts with network ...".
 */
const POOL_OVERLAPS = /pool overlaps|conflicts with network/i;
/** How many times a network create is retried, with a fresh probe, when its subnet overlaps. */
const POOL_RETRIES = 3;

/** A contained network, checked after it was made. */
export interface ContainedNetwork {
  id: string;
  name: string;
  subnet: string;
}

/** A project's proxy, as `listProjectProxies` found it. */
export interface ProjectProxy {
  id: string;
  name: string;
  running: boolean;
  labels: Record<string, string>;
}

/** What `checkContainedNetwork` found: a contained network that is ours, or why not. */
type NetworkCheck =
  | { kind: "ok"; id: string; subnet: string }
  | { kind: "unreadable" }
  | { kind: "foreign"; problem: string; labels: Record<string, unknown> | null }
  | { kind: "uncontained"; problem: string };

const networkInspectArgs = (target: string): string[] => ["network", "inspect", "--format", NETWORK_FORMAT, target];

/** The refusal for a network that is not this installation's, role and project: always "another" or "not-ours". */
function foreignNetworkRefusal(name: string, labels: Record<string, unknown> | null, installationId: string): SandboxRefusedError {
  const asStrings = labels === null ? null : (Object.fromEntries(Object.entries(labels).filter(([, v]) => typeof v === "string")) as Record<string, string>);
  const cls = classifySandbox(asStrings, installationId);
  return new SandboxRefusedError(
    [{ kind: "network", sandbox: name, cls: cls === "another" ? "another" : "not-ours", owner: asStrings?.[OWNER_LABEL], project: asStrings?.[PROJECT_LABEL] }],
    installationId,
  );
}

export class DockerNetwork extends DockerBase {
  /**
   * With a runtime named, check once per process that Docker lists it and can run a container with it. A success
   * is cached; a failure is not; concurrent first callers share one check. Does nothing when no runtime is named.
   * The trial runs `true` from the probe image (`alpine/git` has it as a BusyBox applet); an overridden
   * MCPE_PROBE_IMAGE without `true` fails the trial with Docker's "executable file not found".
   */
  async assertRuntime(): Promise<void> {
    const name = this.cfg.docker.runtime;
    if (!name || this.runtimeOk === name) return;
    if (!this.runtimeCheck) {
      const p: Promise<void> = this.checkRuntime(name)
        .then(() => {
          this.runtimeOk = name;
        })
        .finally(() => {
          if (this.runtimeCheck === p) this.runtimeCheck = undefined;
        });
      this.runtimeCheck = p;
    }
    return this.runtimeCheck;
  }

  private async checkRuntime(name: string): Promise<void> {
    const info = await this.ask(["info", "--format", '{"runtimes":{{json .Runtimes}},"default":{{json .DefaultRuntime}}}'], 30_000);
    if (info.code !== 0 || info.timedOut || info.truncated) throw this.unreadable("the runtimes Docker lists", info);
    let listed: { runtimes?: unknown; default?: unknown };
    try {
      listed = JSON.parse(info.stdout.trim()) as { runtimes?: unknown; default?: unknown };
    } catch {
      throw this.unreadable("the runtimes Docker lists", { ...info, code: 0 });
    }
    if (!listed || typeof listed.runtimes !== "object" || listed.runtimes === null || Array.isArray(listed.runtimes)) {
      throw this.unreadable("the runtimes Docker lists", { ...info, code: 0 });
    }
    if (typeof listed.default === "string" && listed.default !== "") this.daemonDefaultRuntime = listed.default;
    if (!Object.prototype.hasOwnProperty.call(listed.runtimes, name)) {
      throw new RuntimeUnavailableError(name, `Docker lists no runtime called ${oneLine(name, 100)}`);
    }
    if (name === "runsc") {
      // gVisor's default root-filesystem overlay discards writes outside volumes when a sandbox exits, and a build lives
      // in the container's layer: an idle-stopped sandbox would lose its tools. A warning, not a refusal: the registration is the operator's.
      const entry = (listed.runtimes as Record<string, { runtimeArgs?: unknown } | null>)[name];
      const args = Array.isArray(entry?.runtimeArgs) ? (entry.runtimeArgs as unknown[]) : [];
      if (!args.some((a) => typeof a === "string" && /^-{1,2}overlay2=none$/.test(a))) {
        this.log(
          "warning: the runtime runsc is not registered with --overlay2=none; a sandbox that idles out can lose what was built in it. " +
            "Register it with: runsc install -- --overlay2=none",
        );
      }
    }
    try {
      await this.ensureImage(this.cfg.docker.probeImage);
    } catch (e) {
      throw new RuntimeUnavailableError(name, oneLine((e as Error).message, 200));
    }
    let res: RunResult;
    try {
      res = await this.runOnce({
        role: "runtime-check",
        image: this.cfg.docker.probeImage,
        network: "none",
        entrypoint: "true",
        args: [],
        timeoutMs: 60_000,
        maxBytes: 64 * 1024,
      });
    } catch (e) {
      if (e instanceof RuntimeUnavailableError || e instanceof DockerUnavailableError) throw e;
      throw new RuntimeUnavailableError(name, oneLine((e as Error).message, 200));
    }
    if (res.timedOut) throw new RuntimeUnavailableError(name, "a trial container did not finish within 60 seconds");
    if (res.code !== 0) {
      const line = res.stderr.split("\n").find((l) => l.trim() !== "");
      throw new RuntimeUnavailableError(name, (line !== undefined ? oneLine(line, 200) : "") || `a trial container exited with code ${res.code}`);
    }
  }

  /**
   * Run one command in a fresh, owned, named, one-shot container and remove it by id whatever
   * happens (success, failure, a timeout, a throw). `docker run --rm` cannot do that: a timeout
   * kills only the `docker` client and leaves the container running. So: `create --rm` (the
   * daemon also removes it on exit, which keeps a crashed Node process from leaking an exited
   * one), `start -a <id>` through `run()`, and `rm -f <id>` in a `finally`.
   *
   * It mounts whatever it is given. It acts only on the container it made, so it is not in the
   * guarded table; callers must classify every volume they pass (mine, staging, sandbox) first.
   * A Node process killed mid-call leaves a container named `...-<role>-<hex>` with the label
   * `mcp-everything.role`; leg 6's startup sweep removes those.
   *
   * No caller text reaches the name or the labels: the role is a closed type and the rest is
   * the installation id and random hexadecimal.
   *
   * With `egress` the call runs behind its own one-shot proxy on its own contained network (`runBehindProxy`);
   * `network` must then be absent. Without it the Docker calls are exactly those of a call on `spec.network`.
   */
  protected async runOnce(spec: OneShotSpec): Promise<OneShotResult> {
    if (!(ONE_SHOT_ROLES as readonly string[]).includes(spec.role)) throw new Error(`Unknown one-shot role ${JSON.stringify(spec.role)}`);
    const caps = spec.caps ?? [];
    for (const c of caps) if (!EXTRA_CAPS.includes(c)) throw new Error(`Capability ${JSON.stringify(c)} is not one a one-shot container may have`);
    if (spec.egress) {
      if (spec.network !== undefined) throw new Error("A one-shot with egress makes its own network; it must not be given one");
      return this.runBehindProxy(spec, spec.egress);
    }
    if (spec.network === undefined) throw new Error("A one-shot without egress needs a network");
    // The trial is how the runtime is checked, so it must not check itself.
    if (spec.role !== "runtime-check") await this.assertRuntime();
    return this.runCreated(spec, spec.network, []);
  }

  /** Remove a network of this call's own by id or random name; every failure is ignored (the sweep removes what is left). */
  private async dropNetwork(target: string): Promise<void> {
    try {
      await this.docker(["network", "rm", target], { timeoutMs: 60_000 });
    } catch {
      /* never masks the outcome */
    }
  }

  /** The same for a container of this call's own. */
  private async dropContainer(target: string): Promise<void> {
    try {
      await this.docker(["rm", "-f", "-v", target], { timeoutMs: 60_000 });
    } catch {
      /* never masks the outcome */
    }
  }

  /**
   * Make a network that has no way out and check that Docker made it so: internal, no IPv6, one IPv4 subnet and no
   * gateway (DD3), and labelled as this installation's. Its name is `<prefix><id>-<role>-<hex>` unless the caller
   * gives one (a project's, leg 6). It returns the checked network, or removes what it made and throws. There is
   * never a fallback to `bridge`: a Docker that cannot make this network cannot contain anything.
   * Acts only on the network it created, so it is not in the guarded table.
   */
  async createContainedNetwork(opts: { role: string; name?: string; project?: string; sandbox?: string }): Promise<ContainedNetwork> {
    return (await this.createNetwork(opts)).net;
  }

  /**
   * Judge an inspect of a network against what is expected of a contained one: whose it is (owner, role, and the
   * project and sandbox when given), then internal, no IPv6, exactly one IPv4 subnet and no gateway (DD3). Used for
   * a network just made and for one found by name (adoption). Pure: it asks Docker nothing and changes nothing.
   */
  private checkContainedNetwork(res: RunResult, expect: { id?: string; role: string; project?: string; sandbox?: string }): NetworkCheck {
    if (res.code !== 0 || res.timedOut || res.truncated) return { kind: "unreadable" };
    let v: { id?: unknown; internal?: unknown; ipv6?: unknown; ipam?: unknown; labels?: unknown } | null;
    try {
      v = JSON.parse(res.stdout.trim()) as typeof v;
      if (v === null || typeof v !== "object") throw new Error("not an object");
    } catch {
      return { kind: "unreadable" };
    }
    if (typeof v.id !== "string") return { kind: "unreadable" };
    if (expect.id !== undefined && v.id !== expect.id) return { kind: "uncontained", problem: "Docker answered about another network" };
    const labels =
      v.labels !== null && typeof v.labels === "object" && !Array.isArray(v.labels) ? (v.labels as Record<string, unknown>) : null;
    const foreign = (problem: string): NetworkCheck => ({ kind: "foreign", problem, labels });
    if (labels === null || labels[OWNER_LABEL] !== this.installationId) return foreign("it does not carry this installation's owner label");
    if (labels[ROLE_LABEL] !== expect.role) return foreign(`it does not have the role ${expect.role}`);
    if (expect.project !== undefined && labels[PROJECT_LABEL] !== expect.project) return foreign("it does not carry this project's label");
    if (expect.sandbox !== undefined && labels[SANDBOX_LABEL] !== expect.sandbox) return foreign("it does not carry this sandbox's label");
    const ipam = Array.isArray(v.ipam) ? (v.ipam as Array<Record<string, unknown> | null>) : null;
    const v4 = (ipam ?? []).filter((e) => e !== null && typeof e === "object" && typeof e.Subnet === "string" && /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(e.Subnet));
    if (v.internal !== true) return { kind: "uncontained", problem: "it is not internal" };
    if (v.ipv6 !== false) return { kind: "uncontained", problem: "IPv6 is on" };
    if (ipam === null || v4.length !== 1) return { kind: "uncontained", problem: "it does not have exactly one IPv4 subnet" };
    if (ipam.some((e) => e !== null && typeof e === "object" && Object.hasOwn(e, "Gateway") && e.Gateway !== "" && e.Gateway !== null && e.Gateway !== undefined)) {
      return { kind: "uncontained", problem: "it has a gateway" };
    }
    return { kind: "ok", id: v.id, subnet: v4[0]!.Subnet as string };
  }

  /** The network of a name, judged by `checkContainedNetwork`: undefined when it is not there; a refusal when it is someone else's. Never changes anything. */
  protected async findContainedNetwork(
    name: string,
    expect: { role: string; project?: string; sandbox?: string },
  ): Promise<ContainedNetwork | undefined> {
    const res = await this.ask(networkInspectArgs(name), 30_000);
    if (this.isNetworkNotThere(res)) return undefined;
    const check = this.checkContainedNetwork(res, expect);
    switch (check.kind) {
      case "ok":
        return { id: check.id, name, subnet: check.subnet };
      case "unreadable":
        throw this.unreadable(`the network ${clean(name)}`, res.code !== 0 || res.timedOut || res.truncated ? res : { ...res, code: 0 });
      case "foreign":
        throw foreignNetworkRefusal(name, check.labels, this.installationId);
      default:
        throw new ContainmentUnavailableError(
          `The network ${clean(name)} is not contained (${check.problem}); it was left as it is. Containment needs ${ISOLATED_BRIDGE_NEEDS}.`,
        );
    }
  }

  /** The error for a `network create` that failed: pools used up have their own advice. */
  private networkCreateFailure(created: RunResult): ContainmentUnavailableError {
    const line = created.stderr.split("\n").map((l) => l.trim()).filter((l) => l !== "").at(-1) ?? "";
    if (POOLS_EXHAUSTED.test(created.stderr)) {
      return new ContainmentUnavailableError(
        "Could not create the contained network: all of Docker's predefined address pools are used up. " +
          "Remove unused networks or give Docker more room with default-address-pools in its daemon configuration.",
      );
    }
    return new ContainmentUnavailableError(`Could not create the contained network: ${oneLine(line, 200) || "docker network create failed"}`);
  }

  /**
   * The subnet the daemon would give a new contained network: a throwaway network made without `--subnet` (labelled as a
   * one-shot network, so the sweep removes one that is leaked), read and removed at once. Throws like a network create
   * does, and when the subnet is too small to hold the proxy's address.
   */
  private async probeSubnet(): Promise<string> {
    const name = `${this.cfg.docker.namePrefix}${this.installationId}-${ONESHOT_NET_ROLE}-${randomBytes(4).toString("hex")}`;
    const made = await this.docker(
      [
        "network", "create", "--internal",
        "-o", "com.docker.network.bridge.gateway_mode_ipv4=isolated",
        "--ipv6=false",
        "--label", `${OWNER_LABEL}=${this.installationId}`,
        "--label", `${ROLE_LABEL}=${ONESHOT_NET_ROLE}`,
        name,
      ],
      { timeoutMs: 60_000 },
    );
    if (made.timedOut) {
      await this.dropNetwork(name);
      throw new DockerUnavailableError("Could not create the contained network: docker network create timed out");
    }
    if (made.code !== 0) throw this.networkCreateFailure(made);
    const id = made.stdout.trim();
    if (!FULL_ID.test(id)) {
      await this.dropNetwork(name);
      throw new DockerUnavailableError(`Could not create the contained network: Docker printed no usable id: ${oneLine(id, 80) || "(nothing)"}`);
    }
    let res: RunResult;
    try {
      res = await this.ask(networkInspectArgs(id), 30_000);
    } catch (e) {
      await this.dropNetwork(id);
      throw e;
    }
    await this.dropNetwork(id);
    const check = this.checkContainedNetwork(res, { id, role: ONESHOT_NET_ROLE });
    if (check.kind !== "ok") {
      if (check.kind === "unreadable") throw this.unreadable("the probe network", res.code !== 0 || res.timedOut || res.truncated ? res : { ...res, code: 0 });
      throw new ContainmentUnavailableError(
        `Docker made a network that is not contained (${check.kind === "foreign" ? "it is not labelled as asked" : check.problem}); containment needs ${ISOLATED_BRIDGE_NEEDS}. The network was removed.`,
      );
    }
    try {
      proxyAddress(check.subnet);
    } catch {
      throw new ContainmentUnavailableError(`Docker's address pools give subnets too small to hold the proxy (${oneLine(check.subnet, 40)}); give Docker larger pools with default-address-pools.`);
    }
    return check.subnet;
  }

  /**
   * Make the network, or (for a name the caller fixed) adopt the one that is there when a create failed or timed out
   * and the network is ours and passes the check. With a fixed name nothing is ever removed by name: that could
   * remove a racing creator's network. A network of a random name that failed its check is removed by its id.
   */
  private async createNetwork(opts: { role: string; name?: string; project?: string; sandbox?: string }): Promise<{ net: ContainedNetwork; created: boolean }> {
    const fixed = opts.name !== undefined;
    const name = opts.name ?? `${this.cfg.docker.namePrefix}${this.installationId}-${opts.role}-${randomBytes(4).toString("hex")}`;
    const expect = { role: opts.role, project: opts.project, sandbox: opts.sandbox };
    // Probe, then pin: the daemon's own pools choose a subnet (a throwaway network says which), and the real network is
    // made with that subnet and an `--ip-range` in its lower half, so that the proxy's address (the last usable host,
    // outside the range) is never handed out. Another network may take the subnet in between: then a fresh probe.
    let created: RunResult;
    for (let attempt = 0; ; attempt++) {
      const subnet = await this.probeSubnet();
      created = await this.docker(
        [
          "network", "create", "--internal",
          "-o", "com.docker.network.bridge.gateway_mode_ipv4=isolated",
          "--ipv6=false",
          "--subnet", subnet,
          "--ip-range", lowerHalf(subnet),
          "--label", `${OWNER_LABEL}=${this.installationId}`,
          "--label", `${ROLE_LABEL}=${opts.role}`,
          ...(opts.project !== undefined ? ["--label", `${PROJECT_LABEL}=${opts.project}`] : []),
          ...(opts.sandbox !== undefined ? ["--label", `${SANDBOX_LABEL}=${opts.sandbox}`] : []),
          name,
        ],
        { timeoutMs: 60_000 },
      );
      if (created.code !== 0 && !created.timedOut && POOL_OVERLAPS.test(created.stderr) && attempt < POOL_RETRIES) continue;
      break;
    }
    if (created.timedOut) {
      if (fixed) {
        const adopted = await this.findContainedNetwork(name, expect);
        if (adopted) return { net: adopted, created: false };
      } else {
        // The daemon may have made it under this call's own name. Residual risk: it is made after this; the sweep removes it.
        await this.dropNetwork(name);
      }
      throw new DockerUnavailableError("Could not create the contained network: docker network create timed out");
    }
    if (created.code !== 0) {
      if (fixed) {
        // "Already exists" is a lost race (or a leftover): the network may be ours, and then it is adopted.
        const adopted = await this.findContainedNetwork(name, expect);
        if (adopted) return { net: adopted, created: false };
      }
      throw this.networkCreateFailure(created);
    }
    const id = created.stdout.trim();
    if (!FULL_ID.test(id)) {
      if (!fixed) await this.dropNetwork(name);
      throw new DockerUnavailableError(`Could not create the contained network: Docker printed no usable id: ${oneLine(id, 80) || "(nothing)"}`);
    }
    let res: RunResult;
    try {
      res = await this.ask(networkInspectArgs(id), 30_000);
    } catch (e) {
      await this.dropNetwork(id);
      throw e;
    }
    const check = this.checkContainedNetwork(res, { ...expect, id });
    if (check.kind !== "ok") {
      // By id: this call made it, so the id is its own even under a fixed name.
      await this.dropNetwork(id);
      if (check.kind === "unreadable") throw this.unreadable(`the contained network ${clean(name)}`, res.code !== 0 || res.timedOut || res.truncated ? res : { ...res, code: 0 });
      throw new ContainmentUnavailableError(
        `Docker made a network that is not contained (${check.problem}); containment needs ${ISOLATED_BRIDGE_NEEDS}. The network was removed.`,
      );
    }
    return { net: { id, name, subnet: check.subnet }, created: true };
  }

  /**
   * A project's contained network: found by name (`<sandbox name>-net`), made when it is not there, adopted when it
   * is there and is this installation's, role `project-net`, this project's and this sandbox's and passes the check
   * (a lost creation race included). Someone else's is `SandboxRefusedError`; ours but not contained is
   * `ContainmentUnavailableError`. Acts only on what it creates or classifies itself by owner, role and name.
   */
  async ensureProjectNetwork(sandbox: string, project: string): Promise<ContainedNetwork & { created: boolean }> {
    const name = projectNetworkName(sandbox);
    const found = await this.findContainedNetwork(name, { role: PROJECT_NET_ROLE, project, sandbox });
    if (found) return { ...found, created: false };
    const made = await this.createNetwork({ role: PROJECT_NET_ROLE, name, project, sandbox });
    return { ...made.net, created: made.created };
  }

  /**
   * A project's network by name (`network inspect`, T14), judged as `ensureProjectNetwork` judges it, but never made:
   * undefined when it is not there. Someone else's is `SandboxRefusedError`. Read-only.
   */
  async findProjectNetwork(sandbox: string, project: string): Promise<ContainedNetwork | undefined> {
    return this.findContainedNetwork(projectNetworkName(sandbox), { role: PROJECT_NET_ROLE, project, sandbox });
  }

  /**
   * Whether a container, given by the full id `listProjectProxies` returned, is on the given network at the proxy's
   * address (`proxyAddress` of the subnet): the CONFIGURED address, `IPAMConfig.IPv4Address`, which is readable while the
   * container is stopped, not the one it is running with. One read-only inspect; it changes nothing. False when it is
   * gone or not so attached.
   */
  async projectProxyAttached(id: string, net: { id: string; name: string; subnet: string }): Promise<boolean> {
    if (!FULL_ID.test(id)) throw new Error("A proxy is named by its full id");
    const res = await this.ask(["inspect", "--type", "container", "--format", "{{json .NetworkSettings.Networks}}", id], 30_000);
    if (this.isNotThere(res)) return false;
    if (res.code !== 0 || res.timedOut || res.truncated) throw this.unreadable("the networks of a project proxy", res);
    let v: unknown;
    try {
      v = JSON.parse(res.stdout.trim());
    } catch {
      throw this.unreadable("the networks of a project proxy", { ...res, code: 0 });
    }
    if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
    const entry = (v as Record<string, { NetworkID?: unknown; IPAMConfig?: { IPv4Address?: unknown } | null } | null>)[net.name];
    if (entry === null || entry === undefined || typeof entry !== "object") return false;
    return entry.NetworkID === net.id && entry.IPAMConfig?.IPv4Address === proxyAddress(net.subnet);
  }

  /**
   * Take a project's proxy off the project network (replacement's first step: two containers cannot hold one address).
   * Classified first: this installation's, role `project-proxy`. `network disconnect -f` by network id; a proxy that is
   * gone, or not on the network, is success. The proxy keeps running on `bridge`; with no proxy on its network the
   * sandbox has no route, which fails closed.
   */
  async detachProjectProxy(id: string, net: { id: string }): Promise<void> {
    const p = await this.checkedProxy(id);
    if (!p) return;
    await this.disconnectForce(net.id, p.id, p.name);
  }

  /**
   * Put a project's proxy back at its address after a failed replacement: stop it, `network connect --ip <address>`, start it,
   * wait until it is ready, and check that it is attached at the address. Stopped first because connecting a running
   * container to a network is not reliable under every runtime. Classified like `detachProjectProxy`. Throws
   * `ProxyStartError` when any step fails (the caller then has no proxy: fail closed, repaired on the next use).
   */
  async restoreProjectProxy(id: string, net: ContainedNetwork): Promise<void> {
    const p = await this.checkedProxy(id);
    if (!p) throw new ProxyStartError("it no longer exists");
    const address = proxyAddress(net.subnet);
    const stopped = await this.docker(["stop", "-t", "2", p.id], { timeoutMs: 60_000 });
    if (stopped.code !== 0 && !this.isNotThere(stopped)) {
      throw new ProxyStartError(`it could not be stopped: ${stopped.timedOut ? "timed out" : oneLine(stopped.stderr.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "", 200) || "docker stop failed"}`);
    }
    const joined = await this.docker(["network", "connect", "--ip", address, net.id, p.id], { timeoutMs: 60_000 });
    if (joined.code !== 0 || joined.timedOut) {
      throw new ProxyStartError(`it could not be joined to the project network at ${address}: ${joined.timedOut ? "timed out" : oneLine(joined.stderr.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "", 200) || "docker network connect failed"}`);
    }
    await this.startAndAwait(p.id, true);
    if (!(await this.projectProxyAttached(p.id, net))) throw new ProxyStartError(`it is not attached at ${address}`);
  }

  /**
   * Write a sandbox's local-access names into its `/etc/hosts`: one line per name, `<address> <name>   # mcpe-local-access`,
   * replacing earlier marked lines (none when `names` is empty). A root `docker exec` of `LOCAL_ACCESS_SCRIPT`, idempotent,
   * and not through the hook. The container is classified first (anything but this installation's, a sandbox made before ownership included, is refused); a name that is
   * not a plain lower-case host name, or is one of the sandbox's own (`localhost`, its hostname, its short id), is refused.
   * Throws when the write fails.
   */
  async writeLocalAccess(ref: { id: string; name: string }, address: string, names: string[]): Promise<void> {
    if (!FULL_ID.test(ref.id)) throw new Error("A sandbox is named by its full id");
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address) || address.split(".").some((o) => Number(o) > 255)) throw new Error(`Not an IPv4 address: ${oneLine(address, 40)}`);
    for (const n of names) {
      if (n.length > 253 || !HOSTS_NAME.test(n)) throw new Error(`The local-access name ${JSON.stringify(oneLine(n, 60))} is not a plain host name`);
      if (OWN_HOST_NAMES.has(n) || n === ref.id.slice(0, 12)) throw new Error(`The local-access name ${n} is one of the sandbox's own and cannot be pointed at the proxy`);
    }
    const c = await this.inspectContainer(ref.id, true);
    if (!c) return;
    this.refuseUnless([this.containerFacts(ref.name, c)]);
    const lines = [...new Set(names)].map((n) => `${address} ${n}   ${LOCAL_ACCESS_MARK}`).join("\n");
    const res = await this.docker(["exec", "-u", "0", c.id, "sh", "-c", LOCAL_ACCESS_SCRIPT, "sh", lines, "/etc/hosts"], { timeoutMs: 30_000, maxBytes: 16 * 1024 });
    if (res.code !== 0 || res.timedOut) {
      throw new Error(`Could not write the local-access names into ${clean(ref.name)}: ${res.timedOut ? "timed out" : oneLine(res.stderr, 200) || `exit code ${res.code}`}`);
    }
  }

  /**
   * Put the sandbox on a project network: `network disconnect -f` first (its failure is ignored: a stopped container
   * keeps the name of a network that was removed, and this clears it, T14), then `network connect`. The disconnect
   * names the network by its NAME, because the stale entry of a removed network is keyed by name (and a name that
   * is there again resolves to the network just made); the connect names it by id.
   */
  async attachProjectNetwork(
    sandbox: SandboxRef,
    net: { id: string; name: string },
    running?: { running: boolean; runtime?: string | null },
  ): Promise<void> {
    const attach = async (): Promise<void> => {
      await this.docker(["network", "disconnect", "-f", net.name, sandbox.id], { timeoutMs: 60_000 }).catch(() => undefined);
      const res = await this.docker(["network", "connect", net.id, sandbox.id], { timeoutMs: 60_000 });
      if (res.code !== 0) throw new Error(`Failed to attach ${clean(sandbox.name)} to its project network: ${res.stderr.trim()}`);
    };
    if (running && this.needsRestartToChangeNetwork(running)) await this.whileStopped(sandbox.id, sandbox.name, attach);
    else await attach();
  }

  /**
   * Whether a sandbox that is running must be stopped to have its network changed: it is running, and its runtime is not
   * runc (gVisor's network stack does not see a network joined or left while the sandbox runs).
   */
  protected needsRestartToChangeNetwork(c: { running: boolean; runtime?: string | null }): boolean {
    return c.running && !isRuncRuntime(c.runtime, this.daemonDefaultRuntime);
  }

  /**
   * Change a running sandbox's networks the way a non-runc runtime needs: `docker stop`, the change, `docker start`, then the
   * post-start step (the local-access names: Docker rewrote `/etc/hosts`). A change that fails leaves the sandbox stopped
   * (never started on the wrong networks) and throws. Unhooked: this is containment's own step.
   */
  protected async whileStopped(id: string, name: string, change: () => Promise<void>): Promise<void> {
    const stopped = await this.docker(["stop", "-t", "5", id], { timeoutMs: 60_000 });
    if (stopped.code !== 0 && !this.isNotThere(stopped)) {
      throw new Error(`Failed to stop sandbox ${clean(name)} to change its network: ${stopped.timedOut ? "timed out" : stopped.stderr.trim()}`);
    }
    await change();
    await this.startId(id, name, true);
    const after = await this.inspectContainer(id, true);
    if (after) await this.afterStarted(after, name, true);
  }

  /**
   * Stop and start a running sandbox, then run the post-start step. The restart containment's T18 rollback makes, after it put
   * the old proxy back under a non-runc runtime. Undefined-safe: a sandbox that is gone or not running is left alone.
   */
  async restartSandbox(name: string): Promise<void> {
    const c = await this.resolveContainer(name);
    if (!c || !c.running) return;
    await this.whileStopped(c.id, name, async () => undefined);
  }

  /**
   * The upstream DNS servers, read once from a container on `bridge` (DD4): what a container there is given is what
   * the proxy should ask, wherever the host's own resolver is (a stub on the loopback is no use inside a container).
   * Cached per instance; a failure is not kept; concurrent callers share one read; `invalidateResolvers` clears it.
   */
  async readUpstreamResolvers(): Promise<string[]> {
    if (!this.upstreamResolvers) {
      const p: Promise<string[]> = this.readResolvers().catch((e: unknown) => {
        if (this.upstreamResolvers === p) this.upstreamResolvers = undefined;
        throw e;
      });
      this.upstreamResolvers = p;
    }
    return [...(await this.upstreamResolvers)];
  }

  /** Forget the resolvers, so that the next caller reads them again (the proxy counted resolver failures). */
  invalidateResolvers(): void {
    this.upstreamResolvers = undefined;
  }

  private async readResolvers(): Promise<string[]> {
    await this.ensureImage(this.cfg.docker.probeImage);
    const res = await this.runOnce({
      role: "resolv-read",
      image: this.cfg.docker.probeImage,
      network: "bridge",
      entrypoint: "cat",
      args: ["/etc/resolv.conf"],
      timeoutMs: 60_000,
      maxBytes: 64 * 1024,
    });
    if (res.timedOut || res.code !== 0) {
      throw new DockerUnavailableError(
        `Could not read the upstream DNS servers: ${res.timedOut ? "timed out" : oneLine(res.stderr.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "", 200) || `exit code ${res.code}`}`,
      );
    }
    const servers = parseResolvConf(res.stdout);
    if (servers.length === 0) throw new ContainmentUnavailableError("no usable upstream DNS server: a container on bridge is given only a loopback resolver or none");
    return servers;
  }

  /**
   * `GET /status` of a running proxy, asked through `docker exec` of a Node one-liner (the control endpoint is
   * on the proxy's own loopback). The one-liner sets its own socket timeout and calls `process.exit`, so a killed
   * CLI leaves no process behind. The parsed JSON, or undefined when it cannot be had or read. Never throws.
   * One place for the caps: readiness, the refusals read and leg 6 all come here.
   */
  private async proxyStatus(id: string, timeoutMs: number, maxBytes: number): Promise<unknown> {
    const script =
      `const h=require("http");const r=h.get({host:"127.0.0.1",port:${PROXY_CONTROL_PORT},path:"/status",timeout:2000},` +
      `(s)=>{let b="";s.setEncoding("utf8");s.on("data",(c)=>{b+=c});s.on("end",()=>{process.stdout.write(b);process.exit(s.statusCode===200?0:3)})});` +
      `r.on("timeout",()=>{r.destroy();process.exit(2)});r.on("error",()=>process.exit(1));setTimeout(()=>process.exit(4),2500)`;
    try {
      const res = await this.docker(["exec", id, "node", "-e", script], { timeoutMs, maxBytes });
      if (res.code !== 0 || res.timedOut || res.truncated) return undefined;
      return JSON.parse(res.stdout.trim()) as unknown;
    } catch {
      return undefined;
    }
  }

  /** What the proxy refused, for a failed run. Never throws. */
  private async readRefusals(id: string): Promise<ProxyReport> {
    try {
      const st = await this.proxyStatus(id, 3_000, 64 * 1024);
      return st === undefined ? { unavailable: true } : parseProxyReport(st);
    } catch {
      return { unavailable: true };
    }
  }

  /** The last line of a container's own log, cleaned; undefined when the log cannot be read or says nothing. */
  private async lastLogLine(id: string): Promise<string | undefined> {
    try {
      const res = await this.docker(["logs", "--tail", "20", id], { timeoutMs: 15_000, maxBytes: 64 * 1024 });
      if (res.code !== 0 || res.timedOut) return undefined;
      const line = `${res.stdout}\n${res.stderr}`.split("\n").map((l) => oneLine(l, 200)).filter((l) => l !== "").at(-1);
      return line;
    } catch {
      return undefined;
    }
  }

  /**
   * Create the proxy on `bridge`, join it to the contained network under its alias, start it and wait until it
   * says it is ready. `held.proxy` names it (by its own name until the id is known) as soon as anything could
   * exist, so that the caller's teardown finds it whatever fails here.
   */
  private async startProxy(
    contained: ContainedNetwork,
    resolvers: string[],
    egress: { allow: HostEntry[]; local?: boolean },
    held: { proxy?: string },
  ): Promise<string> {
    const name = `${this.cfg.docker.namePrefix}${this.installationId}-oneshot-proxy-${randomBytes(4).toString("hex")}`;
    held.proxy = name;
    const created = await this.docker(
      [
        "create",
        "--name", name,
        "--label", "mcp-everything=1",
        "--label", `${OWNER_LABEL}=${this.installationId}`,
        "--label", `${ROLE_LABEL}=oneshot-proxy`,
        ...this.limits(),
        "--user", "node",
        "--read-only",
        "--tmpfs", "/tmp:size=8m",
        // Created on the contained network at its address and fixed MAC; `bridge` (the way out) is connected after the create,
        // because `docker create` cannot take both. There is never a fallback to a name: a name needs Docker's embedded DNS.
        "--network", proxyNetworkSpec(contained),
        "--entrypoint", "node",
        this.cfg.docker.proxyImage,
        ...proxyLaunchArgs(
          proxyConfig({ allow: egress.allow, local: egress.local, listenCidr: contained.subnet, resolvers, limits: { bindWaitMs: 3_000 } }),
        ),
      ],
      { timeoutMs: 60_000 },
    );
    if (created.timedOut) throw new ProxyStartError("docker create timed out");
    if (created.code !== 0) {
      const refusal = this.runtimeRefusal(created.stderr);
      if (refusal) throw refusal;
      throw new ProxyStartError(oneLine(created.stderr.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "", 200) || "docker create failed");
    }
    const id = created.stdout.trim();
    if (!FULL_ID.test(id)) throw new ProxyStartError(`Docker printed no usable id: ${oneLine(id, 80) || "(nothing)"}`);
    held.proxy = id;
    // The way out must be joined before the proxy starts, or the proxy would start with one network and miss the other.
    const joined = await this.docker(["network", "connect", "bridge", id], { timeoutMs: 60_000 });
    if (joined.code !== 0 || joined.timedOut) {
      throw new ProxyStartError(`it could not be joined to bridge: ${joined.timedOut ? "timed out" : oneLine(joined.stderr.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "", 200) || "docker network connect failed"}`);
    }
    const started = await this.docker(["start", id], { timeoutMs: 60_000 });
    if (started.code !== 0 || started.timedOut) {
      const refusal = started.timedOut ? undefined : this.runtimeRefusal(started.stderr);
      if (refusal) throw refusal;
      throw new ProxyStartError(started.timedOut ? "docker start timed out" : oneLine(started.stderr.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "", 200) || "docker start failed");
    }
    await this.awaitProxyReady(id);
    return id;
  }

  /**
   * Wait for the proxy's `/status` to say `ready` at this program's version, within the budget; a proxy that exited
   * fails at once. `anyVersion` (a proxy this session did not make, started by leg 7) accepts any version string.
   */
  private async awaitProxyReady(id: string, anyVersion = false): Promise<void> {
    const { budgetMs, pollMs } = this.proxyReadiness;
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const res = await this.ask(["inspect", "--type", "container", "--format", '{"running":{{json .State.Running}},"exitCode":{{json .State.ExitCode}}}', id], 30_000);
      let state: { running?: unknown; exitCode?: unknown } | undefined;
      try {
        state = res.code === 0 && !res.timedOut && !res.truncated ? (JSON.parse(res.stdout.trim()) as typeof state) : undefined;
      } catch {
        state = undefined;
      }
      if (!state || typeof state.running !== "boolean") throw this.unreadable(`the proxy ${clean(id)}`, res.code !== 0 ? res : { ...res, code: 0 });
      if (!state.running) {
        throw new ProxyStartError((await this.lastLogLine(id)) ?? `exited with code ${typeof state.exitCode === "number" ? state.exitCode : "unknown"}`);
      }
      const st = (await this.proxyStatus(id, 3_000, 64 * 1024)) as { ready?: unknown; version?: unknown } | undefined;
      if (st && typeof st === "object" && st.ready === true && (anyVersion ? typeof st.version === "string" : st.version === PROXY_PROGRAM_VERSION)) return;
      if (Date.now() >= deadline) {
        throw new ProxyStartError((await this.lastLogLine(id)) ?? `it was not ready within ${budgetMs / 1000} s`);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /**
   * Run a one-shot behind its own proxy (DD2), in this order: the runtime check; the images (every pull before any
   * object exists); the upstream resolvers; a contained network; the proxy (created, joined, started, ready); the
   * one-shot on the network, with the proxy variables. Whatever happens it is torn down in the order one-shot, proxy,
   * network, each removal tolerant and none masking the outcome. A failed run (non-zero, timed out or thrown) has the
   * proxy's refusals read first, before the proxy goes.
   */
  private async runBehindProxy(spec: OneShotSpec, egress: { allow: HostEntry[]; local?: boolean }): Promise<OneShotResult> {
    await this.assertRuntime();
    await this.ensureImage(this.cfg.docker.proxyImage);
    await this.ensureImage(spec.image);
    const resolvers = await this.readUpstreamResolvers();
    const contained = await this.createContainedNetwork({ role: ONESHOT_NET_ROLE });
    const held: { proxy?: string } = {};
    try {
      const proxyId = await this.startProxy(contained, resolvers, egress, held);
      const url = `http://${proxyAddress(contained.subnet)}:${PROXY_PORT}`;
      const env = [
        "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy",
      ].flatMap((k) => ["-e", `${k}=${url}`]);
      env.push("-e", "NO_PROXY=", "-e", "NODE_USE_ENV_PROXY=1");
      const state = { started: false };
      let res: RunResult;
      try {
        res = await this.runCreated(spec, contained.name, env, state);
      } catch (e) {
        // A throw from the run itself (not from its create) still has refusals to read. They cannot be returned, so they ride on the error.
        if (state.started) {
          const report = await this.readRefusals(proxyId);
          if (e instanceof Error) (e as Error & { proxy?: ProxyReport }).proxy = report;
        }
        throw e;
      }
      if (res.code !== 0 || res.timedOut) return { ...res, proxy: await this.readRefusals(proxyId) };
      return res;
    } finally {
      if (held.proxy !== undefined) await this.dropContainer(held.proxy);
      await this.dropNetwork(contained.id);
    }
  }

  /**
   * A project's proxy: created on `bridge` (the way out), joined to the project network at `proxyAddress` of its subnet
   * (no alias: a sandbox reaches the proxy by that address, and a local service by a name its `/etc/hosts` gives that
   * address, DD10), then started and waited for until it reports this program's version. Hardened as the one-shot's proxy,
   * plus `--add-host host.docker.internal:host-gateway` so that a forward to the host has an address. No `--rm`, no
   * restart policy. `labels` are the caller's configuration labels (leg 7); they may not name any label this
   * layer sets. The project network must exist and be this project's (never created here). On any failure it
   * removes what it made, by the name it chose or the id it was given, and throws `ProxyStartError` (or the
   * runtime's own error). Acts only on what it creates.
   */
  async createProjectProxy(
    sandbox: string,
    project: string,
    config: ProxyConfig,
    labels: Record<string, string>,
    opts: { name?: string } = {},
  ): Promise<{ id: string; name: string }> {
    // A caller that must be able to remove the proxy by name even when this call is abandoned (containment's
    // deadline) gives the name beforehand; it has to be the name this method would have chosen.
    if (opts.name !== undefined && !new RegExp(`^${sandbox.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-proxy-[0-9a-f]{8}$`).test(opts.name)) {
      throw new Error(`A project proxy of ${clean(sandbox)} is named <sandbox>-proxy-<8 hex>`);
    }
    for (const [k, v] of Object.entries(labels)) {
      if (RESERVED_LABELS.has(k) || !/^mcp-everything\.[a-z][a-z0-9.-]{0,60}$/.test(k)) throw new Error(`A proxy label may not be named ${JSON.stringify(k.slice(0, 60))}`);
      if (typeof v !== "string" || /[\r\n\u0000]/.test(v)) throw new Error(`The proxy label ${k} must be a string without line breaks`);
    }
    await this.assertRuntime();
    await this.ensureImage(this.cfg.docker.proxyImage);
    const net = await this.findContainedNetwork(projectNetworkName(sandbox), { role: PROJECT_NET_ROLE, project, sandbox });
    if (!net) throw new ProxyStartError(`the project network ${clean(projectNetworkName(sandbox))} does not exist`);
    const name = opts.name ?? newProjectProxyName(sandbox);
    let held = name;
    try {
      const created = await this.docker(
        [
          "create",
          "--name", name,
          "--label", "mcp-everything=1",
          "--label", `${OWNER_LABEL}=${this.installationId}`,
          "--label", `${ROLE_LABEL}=${PROJECT_PROXY_ROLE}`,
          "--label", `${PROJECT_LABEL}=${project}`,
          "--label", `${SANDBOX_LABEL}=${sandbox}`,
          ...Object.entries(labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]),
          ...this.limits(),
          "--user", "node",
          "--read-only",
          "--tmpfs", "/tmp:size=8m",
          "--network", proxyNetworkSpec(net),
          "--add-host", "host.docker.internal:host-gateway",
          "--entrypoint", "node",
          this.cfg.docker.proxyImage,
          ...proxyLaunchArgs(config),
        ],
        { timeoutMs: 60_000 },
      );
      if (created.timedOut) throw new ProxyStartError("docker create timed out");
      if (created.code !== 0) {
        const refusal = this.runtimeRefusal(created.stderr);
        if (refusal) throw refusal;
        throw new ProxyStartError(oneLine(created.stderr.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "", 200) || "docker create failed");
      }
      const id = created.stdout.trim();
      if (!FULL_ID.test(id)) throw new ProxyStartError(`Docker printed no usable id: ${oneLine(id, 80) || "(nothing)"}`);
      held = id;
      // The way out is joined before the proxy starts, or it would start with one network and miss the other.
      const joined = await this.docker(["network", "connect", "bridge", id], { timeoutMs: 60_000 });
      if (joined.code !== 0 || joined.timedOut) {
        throw new ProxyStartError(`it could not be joined to bridge: ${joined.timedOut ? "timed out" : oneLine(joined.stderr.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "", 200) || "docker network connect failed"}`);
      }
      await this.startAndAwait(id, false);
      return { id, name };
    } catch (e) {
      await this.dropContainer(held);
      throw e;
    }
  }

  /** `docker start`, then readiness: the one place both the one-shot's proxy and a project's wait for a proxy that was started. */
  private async startAndAwait(id: string, anyVersion: boolean): Promise<void> {
    const started = await this.docker(["start", id], { timeoutMs: 60_000 });
    if (started.code !== 0 || started.timedOut) {
      const refusal = started.timedOut ? undefined : this.runtimeRefusal(started.stderr);
      if (refusal) throw refusal;
      throw new ProxyStartError(started.timedOut ? "docker start timed out" : oneLine(started.stderr.split("\n").filter((l) => l.trim() !== "").at(-1) ?? "", 200) || "docker start failed");
    }
    await this.awaitProxyReady(id, anyVersion);
  }

  /**
   * Start a project's proxy that already exists (a stopped one) and wait until it is ready. Any version string is
   * accepted, so that an older session can start a newer proxy it keeps (leg 7). The proxy is classified first:
   * this installation's and role `project-proxy`, else a refusal.
   */
  async startProjectProxy(id: string): Promise<void> {
    const p = await this.checkedProxy(id);
    if (!p) throw new ProxyStartError("it no longer exists");
    await this.startAndAwait(p.id, true);
  }

  /** `GET /status` of a project's proxy, or undefined when it cannot be had. A public wrapper of the one status read. Never throws. */
  async projectProxyStatus(id: string): Promise<unknown> {
    if (!FULL_ID.test(id)) return undefined;
    return this.proxyStatus(id, 3_000, 64 * 1024);
  }

  /**
   * What a project's proxies refused, as rows: it lists the sandbox's proxies, reads each one's status (`projectProxyStatus`)
   * and parses it with the same parser a one-shot's report goes through. Never throws; a proxy that cannot be read, or
   * that is not there, gives no rows. The install reads this once, right after the build and before the network changes.
   */
  async projectRefusals(sandbox: string): Promise<ProxyRefusalRow[]> {
    try {
      const rows: ProxyRefusalRow[] = [];
      for (const p of (await this.listProjectProxies(sandbox)).slice(0, 4)) {
        const report = parseProxyReport(await this.projectProxyStatus(p.id));
        if ("rows" in report) rows.push(...report.rows);
      }
      return rows;
    } catch {
      return [];
    }
  }

  /** A proxy by id, classified: its facts, null when gone, a refusal unless it is this installation's with the role `project-proxy`. */
  private async checkedProxy(id: string): Promise<ProjectProxy | null> {
    if (!FULL_ID.test(id)) throw new Error("A proxy is named by its full id");
    const c = await this.inspectContainer(id, true);
    if (!c) return null;
    const cls = classifySandbox(c.labels, this.installationId);
    if (cls !== "mine" || c.labels?.[ROLE_LABEL] !== PROJECT_PROXY_ROLE) {
      throw new SandboxRefusedError(
        [{ kind: "proxy", sandbox: c.name ?? id, cls: cls === "another" ? "another" : "not-ours", owner: c.labels?.[OWNER_LABEL], project: c.labels?.[PROJECT_LABEL] }],
        this.installationId,
      );
    }
    return { id: c.id, name: c.name ?? id, running: c.running, labels: c.labels ?? {} };
  }

  /**
   * The project proxies of a sandbox: containers with this installation's owner label and the role `project-proxy`
   * (label filters), kept only when the inspect says their name is `<sandbox>-proxy-<8 hex>` and they carry the
   * sandbox's name and a project label. Needs no container and no label from it, so it works after the container
   * is gone, and a twin sandbox with the same repository is never listed. Throws when Docker cannot be asked.
   */
  async listProjectProxies(sandbox: string): Promise<ProjectProxy[]> {
    const res = await this.ask(
      ["ps", "-a", "-q", "--no-trunc", "--filter", `label=${OWNER_LABEL}=${this.installationId}`, "--filter", `label=${ROLE_LABEL}=${PROJECT_PROXY_ROLE}`],
      60_000,
    );
    if (res.code !== 0 || res.timedOut || res.truncated) throw this.unreadable("the project proxies", res);
    const ids = res.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    const wanted = new RegExp(`^${sandbox.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-proxy-[0-9a-f]{8}$`);
    const found: ProjectProxy[] = [];
    for (const id of ids) {
      if (!FULL_ID.test(id)) throw this.unreadable("the project proxies", { ...res, code: 0, stdout: "" });
      const c = await this.inspectContainer(id, true);
      if (!c || c.name === undefined || !wanted.test(c.name) || c.labels === null) continue;
      if (c.labels[OWNER_LABEL] !== this.installationId || c.labels[ROLE_LABEL] !== PROJECT_PROXY_ROLE) continue;
      if (c.labels[SANDBOX_LABEL] !== sandbox || !Object.hasOwn(c.labels, PROJECT_LABEL)) continue;
      found.push({ id: c.id, name: c.name, running: c.running, labels: c.labels });
    }
    return found;
  }

  /**
   * This installation's sandboxes (leg 10): containers with this installation's owner label and a project label (label
   * filters), each inspected, dropping any that carries a role (a proxy, a one-shot) or whose owner is not this installation's
   * (the inspect is judged again, not the filter alone). A sandbox with no owner label (made before ownership was recorded,
   * or not ours) is not listed: the filter is on the owner label. Reads only; throws when Docker cannot be asked.
   */
  async listOwnSandboxes(): Promise<SandboxInspectFacts[]> {
    const res = await this.ask(
      ["ps", "-a", "-q", "--no-trunc", "--filter", `label=${OWNER_LABEL}=${this.installationId}`, "--filter", `label=${PROJECT_LABEL}`],
      60_000,
    );
    if (res.code !== 0 || res.timedOut || res.truncated) throw this.unreadable("this installation's sandboxes", res);
    const ids = res.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    const found: SandboxInspectFacts[] = [];
    for (const id of ids) {
      if (!FULL_ID.test(id)) throw this.unreadable("this installation's sandboxes", { ...res, code: 0, stdout: "" });
      const c = await this.inspectContainer(id, true);
      if (!c || c.name === undefined || c.labels === null) continue;
      if (c.labels[OWNER_LABEL] !== this.installationId || Object.hasOwn(c.labels, ROLE_LABEL)) continue;
      if (!Object.hasOwn(c.labels, PROJECT_LABEL) || c.labels[PROJECT_LABEL] === "") continue;
      found.push({ id: c.id, name: c.name, running: c.running, labels: c.labels, networks: [...c.networks], ...(c.networkIds ? { networkIds: { ...c.networkIds } } : {}), runtime: c.runtime });
    }
    return found;
  }

  /** Remove a project proxy and its anonymous volumes, by id, after it is classified as this installation's. Gone is success. */
  async removeProjectProxy(id: string): Promise<void> {
    const p = await this.checkedProxy(id);
    if (p) await this.rmProxy(p.id, p.name);
  }

  /**
   * Remove one project proxy by the name its creator chose (`<sandbox>-proxy-<8 hex>`), for the creator whose call
   * was abandoned and never learned the id. It resolves the name, requires the sandbox's label on it, and then
   * removes it exactly as `removeProjectProxy` does (classified by owner and role). Gone is success.
   */
  async removeProjectProxyNamed(sandbox: string, name: string): Promise<void> {
    if (!new RegExp(`^${sandbox.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-proxy-[0-9a-f]{8}$`).test(name)) {
      throw new Error(`A project proxy of ${clean(sandbox)} is named <sandbox>-proxy-<8 hex>`);
    }
    const c = await this.inspectContainer(name, true);
    if (!c) return;
    if (c.labels?.[SANDBOX_LABEL] !== sandbox) {
      throw new SandboxRefusedError([{ kind: "proxy", sandbox: name, cls: "not-ours", owner: c.labels?.[OWNER_LABEL], project: c.labels?.[PROJECT_LABEL] }], this.installationId);
    }
    await this.removeProjectProxy(c.id);
  }

  protected async rmProxy(id: string, name: string): Promise<void> {
    const rm = await this.docker(["rm", "-f", "-v", id], { timeoutMs: 120_000 });
    if (rm.code !== 0 && !this.isNotThere(rm)) throw new Error(`Failed to remove proxy ${clean(name)}: ${rm.stderr.trim()}`);
  }

  /** Remove a project network by id, after it is classified as this installation's with the role `project-net`. Gone is success. */
  async removeProjectNetwork(net: string | { id: string }): Promise<void> {
    const id = typeof net === "string" ? net : net.id;
    if (!FULL_ID.test(id)) throw new Error("A network is named by its full id");
    const res = await this.ask(networkInspectArgs(id), 30_000);
    if (this.isNetworkNotThere(res)) return;
    const found = this.networkLabels(id, res);
    if (found.labels?.[OWNER_LABEL] !== this.installationId || found.labels[ROLE_LABEL] !== PROJECT_NET_ROLE) {
      throw foreignNetworkRefusal(found.name, found.labels, this.installationId);
    }
    await this.rmNetwork(id, found.name);
  }

  protected async rmNetwork(id: string, name: string): Promise<void> {
    const rm = await this.docker(["network", "rm", id], { timeoutMs: 60_000 });
    if (rm.code !== 0 && !this.isNetworkNotThere(rm)) throw new Error(`Failed to remove network ${clean(name)}: ${rm.stderr.trim()}`);
  }

  /** The name and labels from a network inspect; throws when the answer cannot be read. */
  private networkLabels(target: string, res: RunResult): { name: string; labels: Record<string, string> | null } {
    type Inspect = { id?: unknown; name?: unknown; labels?: unknown };
    const parse = (): Inspect | null => {
      if (res.code !== 0 || res.timedOut || res.truncated) return null;
      try {
        return JSON.parse(res.stdout.trim()) as Inspect | null;
      } catch {
        return null;
      }
    };
    const v = parse();
    const l = v?.labels;
    const labelsOk = l === null || (typeof l === "object" && !Array.isArray(l) && Object.values(l as object).every((x) => typeof x === "string"));
    if (!v || typeof v !== "object" || typeof v.id !== "string" || !labelsOk) {
      throw this.unreadable(`the network ${clean(target)}`, res.code !== 0 || res.timedOut || res.truncated ? res : { ...res, code: 0 });
    }
    return { name: typeof v.name === "string" && v.name !== "" ? v.name : target, labels: (l as Record<string, string> | null) ?? null };
  }

  /**
   * What goes with a sandbox: its project proxies and its `-net` (found by name), each classified. A `-net` that is
   * not this installation's, role `project-net`, is `another` or `not-ours`, so that the caller's refusal covers it.
   * Reads only; the caller removes in its own order.
   */
  protected async projectObjects(sandbox: string): Promise<{ proxies: ProjectProxy[]; net?: { id: string; name: string }; facts: SandboxFacts[] }> {
    const proxies = await this.listProjectProxies(sandbox);
    const facts: SandboxFacts[] = proxies.map((p) => ({
      kind: "proxy",
      sandbox: p.name,
      cls: classifySandbox(p.labels, this.installationId),
      owner: p.labels[OWNER_LABEL],
      project: p.labels[PROJECT_LABEL],
    }));
    const name = projectNetworkName(sandbox);
    const res = await this.ask(networkInspectArgs(name), 30_000);
    if (this.isNetworkNotThere(res)) return { proxies, facts };
    const n = this.networkLabels(name, res);
    const id = (JSON.parse(res.stdout.trim()) as { id: string }).id;
    const mine = n.labels?.[OWNER_LABEL] === this.installationId && n.labels[ROLE_LABEL] === PROJECT_NET_ROLE;
    const cls = mine ? "mine" : classifySandbox(n.labels, this.installationId) === "another" ? "another" : "not-ours";
    facts.push({ kind: "network", sandbox: name, cls, owner: n.labels?.[OWNER_LABEL], project: n.labels?.[PROJECT_LABEL] });
    return { proxies, net: { id, name }, facts };
  }

  /** `network disconnect -f`: a network that is gone, or one the container is not on, is not a failure. */
  protected async disconnectForce(network: string, id: string, name: string): Promise<void> {
    const res = await this.docker(["network", "disconnect", "-f", network, id], { timeoutMs: 60_000 });
    if (res.code !== 0 && !this.isNetworkNotThere(res) && !this.isNotThere(res) && !/is not connected to/i.test(res.stderr)) {
      throw new Error(`Failed to disable network for ${clean(name)}: ${res.stderr.trim()}`);
    }
  }
}
