import { oneLine } from "../util/text.js";

/** The label every sandbox of mcp-everything carries, and the one that names its installation. */
export const GENERIC_LABEL = "mcp-everything";
export const OWNER_LABEL = "mcp-everything.owner";
export const PROJECT_LABEL = "mcp-everything.project";
export const ROLE_LABEL = "mcp-everything.role";
export const SANDBOX_LABEL = "mcp-everything.sandbox";

/**
 * Whose a container or volume is, judged from its labels alone: "mine" (the owner
 * label is this installation's id), "another" (an owner label with any other
 * value, empty or malformed included), "before" (the generic label `1` and no
 * owner label: made before ownership was recorded) or "not-ours".
 */
export type SandboxClass = "mine" | "another" | "before" | "not-ours";

export function classifySandbox(labels: Record<string, unknown> | null | undefined, installationId: string): SandboxClass {
  if (labels === null || labels === undefined || typeof labels !== "object" || Array.isArray(labels)) return "not-ours";
  if (Object.hasOwn(labels, OWNER_LABEL)) return labels[OWNER_LABEL] === installationId ? "mine" : "another";
  return labels[GENERIC_LABEL] === "1" ? "before" : "not-ours";
}

/** What `Docker.ownership` reports: a class, "missing", or "unavailable" (Docker could not be asked). */
export interface OwnershipReport {
  state: SandboxClass | "missing" | "unavailable";
  /** The owner label as recorded, for another's only. */
  owner?: string;
}

/** What a refusal says about one sandbox, or one of the proxies and networks that go with it. */
export interface SandboxFacts {
  kind: "container" | "volume" | "network" | "proxy";
  sandbox: string;
  cls: SandboxClass;
  /** The owner label as recorded (another's only). */
  owner?: string;
  /** The project label as recorded (containers, proxies and networks). */
  project?: string;
}

/** One inspect of a sandbox: what the containment hook is given (leg 7). */
export interface SandboxInspectFacts {
  id: string;
  name: string;
  running: boolean;
  labels: Record<string, string> | null;
  networks: string[];
  /** The id of each network the sandbox is on, by name; absent when the answer did not carry them (a scripted double). */
  networkIds?: Record<string, string>;
  runtime: string | undefined;
}

export const LABEL_MAX = 64;

/**
 * How much of an owner label is shown anywhere an operator reads it (a refusal, an install warning, project_info).
 * Imported by those other places so the cut cannot drift. LABEL_MAX still bounds every other text from Docker.
 */
export const OWNER_SHOWN = 64;
export const clean = (v: string) => oneLine(v, LABEL_MAX);

/**
 * What every message says about a sandbox made before ownership was recorded (no period: callers end the sentence).
 * Nothing can tell whose it is, so it is never acted on, and an agent is told not to remove it. The `docker`
 * commands are not here: they appear only in `removalCommands`, which `project_info` and `uninstall_project` add.
 */
export const BEFORE_NOTE =
  "was made before ownership was recorded; this installation cannot tell whether it is its own and does not act on it. Do not remove it yourself; ask the operator";

/** Docker's own grammar for a container or volume name, and the length a printed name may have. */
const DOCKER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/**
 * What the operator can do about the `before` parts of a list of facts, phrased to the operator: the commands that
 * remove each one, by kind, then a reinstall. A name outside Docker's grammar, or longer than LABEL_MAX, gets no command
 * ("remove it in Docker"). Empty when no part is `before`. Only containers and volumes are named; networks and proxies
 * are never `before`. Used by `project_info`'s owner line and `uninstall_project`'s result, and nowhere else: a
 * tool error or a warning carries the prohibition and a pointer here. A mixed pair (a `mine` container on a `before`
 * volume) can only be made by hand; removing such a volume needs the container using it gone first, and only the
 * `before` parts are named here.
 */
export function removalCommands(facts: readonly SandboxFacts[]): string {
  const parts = facts.filter((f) => f.cls === "before" && (f.kind === "container" || f.kind === "volume"));
  if (parts.length === 0) return "";
  const printable = parts.every((f) => f.sandbox.length <= LABEL_MAX && DOCKER_NAME.test(f.sandbox));
  const how = printable
    ? parts.map((f) => (f.kind === "container" ? `\`docker rm -f ${f.sandbox}\`` : `\`docker volume rm ${f.sandbox}\``)).join(" and ")
    : "remove it in Docker";
  return `If the operator confirms it is this installation's and not wanted, they can ${printable ? `run ${how}` : how}, then reinstall the project.`;
}

function describeFacts(f: SandboxFacts): string {
  const what = `${f.kind} "${clean(f.sandbox)}"`;
  const project = f.kind !== "volume" ? `, project label ${f.project === undefined ? "(none)" : `"${clean(f.project)}"`}` : "";
  switch (f.cls) {
    case "another":
      return `${what} is another installation's (owner label "${oneLine(f.owner ?? "", OWNER_SHOWN)}"${project})`;
    case "not-ours":
      return `${what} was not created by mcp-everything${project}`;
    case "before":
      return `${what}${project} ${BEFORE_NOTE}`;
    default:
      return `${what} is this installation's${project}`;
  }
}

/** The one place a refusal's message is built. A `before` part adds a pointer to the commands, which are not here. */
function refusalMessage(facts: SandboxFacts[], installationId: string): string {
  const subject = facts.map((f) => `${f.kind} "${clean(f.sandbox)}"`).join(" and ");
  const see = facts.some((f) => f.cls === "before") ? " See project_info." : "";
  return `Refusing to act on ${subject}: ${facts.map(describeFacts).join("; ")}. This installation is ${installationId}.${see}`;
}

/** A sandbox is another installation's, not mcp-everything's, or of a kind that cannot be told apart: nothing was done to it. */
export class SandboxRefusedError extends Error {
  /** The first sandbox that was refused. */
  readonly kind: SandboxFacts["kind"];
  readonly sandbox: string;
  readonly reason: "another" | "not-ours" | "before";
  readonly owner: string | undefined;
  readonly installationId: string;
  /** Every sandbox the refusal speaks of (a container and its volume, for `destroy`). */
  readonly sandboxes: readonly SandboxFacts[];

  constructor(facts: SandboxFacts[], installationId: string) {
    super(refusalMessage(facts, installationId));
    this.name = "SandboxRefusedError";
    const first = facts.find((f) => f.cls === "another" || f.cls === "not-ours" || f.cls === "before") ?? facts[0]!;
    this.kind = first.kind;
    this.sandbox = first.sandbox;
    // Mapped explicitly: a class that is none of these (never refused) must not read as another's.
    this.reason = first.cls === "another" ? "another" : first.cls === "before" ? "before" : "not-ours";
    this.owner = first.owner;
    this.installationId = installationId;
    this.sandboxes = facts;
  }
}
