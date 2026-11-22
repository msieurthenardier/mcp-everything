/** Shared data model. Everything in here is persisted to the registry as JSON. */

import type { ScanReport } from "./scan/types.js";

export type Forge = "github" | "gitlab";

export type Ecosystem =
  | "rust"
  | "go"
  | "python"
  | "node"
  | "ruby"
  | "cmake"
  | "autotools"
  | "make"
  | "generic";

/** A parsed, validated pointer to a repository on an allowed forge. */
export interface RepoRef {
  forge: Forge;
  host: string;
  /** `owner/name` on GitHub, `group/sub/name` on GitLab. */
  path: string;
  /** Canonical https clone URL. */
  cloneUrl: string;
  /** Canonical id, e.g. `github:owner/name`. */
  id: string;
  /** Last path segment. */
  name: string;
}

/** One command line option extracted from help text. */
export interface OptionSpec {
  /** JSON property name exposed in the tool schema. */
  prop: string;
  /** Flag to emit, long form preferred (`--output`), else short (`-o`). */
  flag: string;
  short?: string;
  takesValue: boolean;
  /** Value is optional (`--color[=WHEN]`): emitted as `--flag=value`. */
  optionalValue?: boolean;
  valueName?: string;
  choices?: string[];
  description: string;
}

export interface SubcommandSpec {
  name: string;
  description: string;
}

export interface ParsedHelp {
  summary: string;
  usage: string;
  options: OptionSpec[];
  subcommands: SubcommandSpec[];
}

/** An executable discovered (or registered) inside a project sandbox. */
export interface CommandSpec {
  /** Name on PATH, or an absolute path inside the sandbox. */
  name: string;
  /** Other names the same program is installed under. */
  aliases?: string[];
  /** Where it came from, for humans: "console_script", "package.json bin", ... */
  origin: string;
}

export type ToolKind = "cli" | "script" | "code" | "mcp";

/** A generated MCP tool bound to a project sandbox. */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  kind: ToolKind;
  /** Base argv, e.g. ["ruff", "check"]. */
  argv: string[];
  /** Options that may be passed as named properties (kind === "cli"). */
  options: OptionSpec[];
  /** Working directory inside the sandbox. */
  cwd: string;
  /**
   * script: property holding the script/target name appended to argv.
   * code:   property holding source code appended to argv.
   */
  valueProp?: string;
  /** kind === "mcp": which upstream server and tool this forwards to. */
  mcp?: { server: string; tool: string };
}

/** How to launch an MCP server that lives inside a project sandbox (stdio). */
export interface McpServerSpec {
  /** Unique within the project. */
  name: string;
  argv: string[];
  cwd: string;
  /** Extra environment for the server process. May hold secrets. */
  env: Record<string, string>;
  origin: "detected" | "registered";
}

export interface ToolSelection {
  /** Patterns (`*` wildcard) of tools to publish. */
  include: string[];
  exclude: string[];
  /** Per-project replacement for MCPE_MAX_TOOLS_PER_PROJECT. */
  maxTools?: number;
}

export type ProjectStatus = "installing" | "ready" | "failed";

export interface ProjectRecord {
  slug: string;
  repo: RepoRef;
  ref?: string;
  commit?: string;
  image: string;
  /** Why this image was chosen (version pin, declared range, default...). */
  imageReason?: string;
  container: string;
  volume: string;
  ecosystems: Ecosystem[];
  primary: Ecosystem;
  /** Whether the sandbox currently has outbound network access. */
  network: boolean;
  status: ProjectStatus;
  /** One-line reason when status is "failed". */
  error?: string;
  /** Tail of the build output that goes with `error`. */
  errorLog?: string;
  warnings: string[];
  license?: string;
  commands: CommandSpec[];
  /** MCP servers inside the sandbox whose tools are proxied. */
  mcpServers?: McpServerSpec[];
  /** Every tool generated for the project: the searchable, callable catalog. */
  tools: ToolDef[];
  /**
   * Names of the tools advertised in the MCP tool list. Absent in records
   * written before the catalog existed, where every tool was published.
   */
  published?: string[];
  /** An explicit choice of what to publish, made with select_project_tools. */
  selection?: ToolSelection;
  /** Facts gathered at install time that tool generation reuses. */
  meta: ProjectMeta;
  installedAt: string;
  /** What the check of the repository found before this install built it; absent when none was made. */
  scan?: ScanReport;
}

export interface ProjectMeta {
  npmScripts: string[];
  makeTargets: string[];
  pythonModules: string[];
  nodePackages: string[];
  hasPythonEnv: boolean;
  hasNode: boolean;
  /** Root manifests or the repository name suggest this is an MCP server. */
  mcpHint?: boolean;
}

export interface SearchResult {
  id: string;
  forge: Forge;
  path: string;
  url: string;
  description: string;
  stars: number;
  language?: string;
  license?: string;
  archived?: boolean;
  updatedAt?: string;
}
