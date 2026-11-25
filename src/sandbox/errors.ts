import { joinRefusals } from "../network/refusals.js";
import { oneLine } from "../util/text.js";
import { clean } from "./ownership.js";

/** A volume a method was given is missing or has the wrong role: nothing was created. */
export class VolumeNotUsableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VolumeNotUsableError";
  }
}

/** Docker could not be asked, or answered in a way that cannot be read: nothing was assumed. */
export class DockerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DockerUnavailableError";
  }
}

/**
 * MCPE_DOCKER_RUNTIME names a runtime Docker does not list or cannot run a container with. Naming a runtime is
 * requiring it: nothing falls back to another.
 */
export class RuntimeUnavailableError extends Error {
  readonly runtime: string;
  readonly reason: string;
  constructor(runtime: string, reason: string) {
    super(
      `MCPE_DOCKER_RUNTIME names ${oneLine(runtime, 100)}, but Docker cannot run containers with it (${reason}); ` +
        "install it and register it with Docker, or unset MCPE_DOCKER_RUNTIME.",
    );
    this.name = "RuntimeUnavailableError";
    this.runtime = runtime;
    this.reason = reason;
  }
}

/**
 * Containment cannot be had on this Docker: the network it made is not contained, its address pools are used up,
 * or it has no upstream DNS server to give the proxy. Never a reason to fall back to `bridge`.
 */
export class ContainmentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainmentUnavailableError";
  }
}

/** The network proxy did not start or did not become ready. Never a refusal of anything the one-shot asked for. */
export class ProxyStartError extends Error {
  constructor(detail: string) {
    super(`the network proxy did not start: ${detail}`);
    this.name = "ProxyStartError";
  }
}

/**
 * A clone that failed. `detail` is Docker's and git's own text; under containment `refusals` are the lines for the hosts
 * the clone's proxy refused (at most 10 lines), and the message carries them after `detail`. A check that must cut the
 * text puts `refusals` first, so that the cut is of git's stderr and never of the refusal.
 */
export class CloneFailedError extends Error {
  constructor(
    readonly detail: string,
    readonly refusals: readonly string[],
  ) {
    super(refusals.length > 0 ? `${detail}\n${joinRefusals(refusals, "\n")}` : detail);
    this.name = "CloneFailedError";
  }
}

/** An existing sandbox was created under a runtime other than the one now required; it was not started or run in. */
export class RuntimeMismatchError extends Error {
  readonly sandbox: string;
  readonly named: string;
  readonly actual: string;
  constructor(sandbox: string, named: string, actual: string) {
    super(
      `Sandbox ${clean(sandbox)} was created before MCPE_DOCKER_RUNTIME=${oneLine(named, 100)} was set; ` +
        `Docker reports its runtime as ${oneLine(actual, 100)}. Reinstall the project to run it under ${oneLine(named, 100)}.`,
    );
    this.name = "RuntimeMismatchError";
    this.sandbox = sandbox;
    this.named = named;
    this.actual = actual;
  }
}
