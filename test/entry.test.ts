import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { guardStdout, runEntry } from "../src/entry.js";
import { loadConfig } from "../src/config.js";
import { McpProxy } from "../src/proxy/mcp-proxy.js";
import { App } from "../src/server.js";
import { FakeDocker } from "./helpers.js";

const DEADLINE = 1000;

type Mode = "normal" | "hold" | "reject";

describe.each([
  { label: "a transport that closes itself on end", selfClose: true },
  { label: "a transport that does not", selfClose: false },
])("entry wiring with $label", ({ selfClose }) => {
  let dir: string;
  let app: App;
  let proxy: HeldProxy;
  let input: EventEmitter;
  let signals: EventEmitter;
  let events: string[];
  let exit: Mock<(code: number) => void>;
  let log: Mock<(line: string) => void>;
  let selfClosed: boolean;
  let closeCalls: number;
  let closeRejects: boolean;
  let selfClosedAtCloseAll: boolean | undefined;
  let counts: { end: number; SIGINT: number; SIGTERM: number } | undefined;
  let release: () => void;

  /** closeAll can be held open, made to reject, and says when it ran. */
  class HeldProxy extends McpProxy {
    mode: Mode = "normal";
    gate = new Promise<void>((resolve) => (release = resolve));
    override async closeAll(): Promise<void> {
      events.push("closeAll:start");
      selfClosedAtCloseAll = selfClosed;
      if (this.mode === "hold") await this.gate;
      if (this.mode === "reject") throw new Error("closeAll failed");
      await super.closeAll();
      events.push("closeAll:end");
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcpe-entry-"));
    const cfg = loadConfig({ HOME: dir, MCPE_DATA_DIR: dir });
    const docker = new FakeDocker(cfg);
    proxy = new HeldProxy(cfg, docker);
    app = new App({ cfg, docker, proxy });
    input = new EventEmitter();
    signals = new EventEmitter();
    events = [];
    selfClosed = false;
    closeCalls = 0;
    closeRejects = false;
    selfClosedAtCloseAll = undefined;
    counts = undefined;
    exit = vi.fn<(code: number) => void>((code) => void events.push(`exit:${code}`));
    log = vi.fn<(line: string) => void>();
  });
  afterEach(async () => {
    // The file's cleanup runs the real shutdown, like test/server.test.ts.
    proxy.mode = "normal";
    release();
    vi.useRealTimers();
    await app.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const serve = async () => {
    return {
      close: async () => {
        closeCalls++;
        events.push("close");
        if (closeRejects) throw new Error("close failed");
      },
    };
  };

  /** The serving double: records the listener counts when called; when it stands for the v2 transport it listens first. */
  const serving = async () => {
    counts = {
      end: input.listenerCount("end"),
      SIGINT: signals.listenerCount("SIGINT"),
      SIGTERM: signals.listenerCount("SIGTERM"),
    };
    if (selfClose) input.on("end", () => void (selfClosed = true));
    return serve();
  };

  const wire = () => runEntry({ input, signals, exit, app, serve: serving, deadlineMs: DEADLINE, log, console: { ...console } });
  const settle = () => vi.advanceTimersByTimeAsync(0);

  it("registers its listeners after serving has started, and one of each", async () => {
    await wire();
    expect(counts).toEqual({ end: 0, SIGINT: 0, SIGTERM: 0 });
    expect(input.listenerCount("end")).toBe(selfClose ? 2 : 1);
    expect(signals.listenerCount("SIGINT")).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
  });

  it("runs closeAll before exit(0), and does not exit while closeAll is held open", async () => {
    proxy.mode = "hold";
    await wire();
    input.emit("end");
    await vi.advanceTimersByTimeAsync(DEADLINE - 1);
    expect(events).toEqual(["closeAll:start"]);
    expect(exit).not.toHaveBeenCalled();
    release();
    await settle();
    expect(events).toEqual(["closeAll:start", "closeAll:end", "close", "exit:0"]);
  });

  it("calls the handle's close after closeAll has settled, not before", async () => {
    proxy.mode = "hold";
    await wire();
    input.emit("end");
    await vi.advanceTimersByTimeAsync(10);
    expect(closeCalls).toBe(0);
    release();
    await settle();
    expect(closeCalls).toBe(1);
    expect(events.indexOf("close")).toBeGreaterThan(events.indexOf("closeAll:end"));
  });

  it("exits exactly once when end, SIGINT and SIGTERM all arrive", async () => {
    await wire();
    input.emit("end");
    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(DEADLINE * 2);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(events.filter((e) => e === "closeAll:start")).toHaveLength(1);
    expect(closeCalls).toBe(1);
  });

  it.each(["SIGINT", "SIGTERM"])("%s alone does what end does", async (sig) => {
    await wire();
    signals.emit(sig);
    await settle();
    expect(events).toEqual(["closeAll:start", "closeAll:end", "close", "exit:0"]);
  });

  it("still closes the handle and exits 0 when closeAll rejects", async () => {
    proxy.mode = "reject";
    await wire();
    input.emit("end");
    await settle();
    expect(closeCalls).toBe(1);
    expect(events).toEqual(["closeAll:start", "close", "exit:0"]);
  });

  it("exits 0 when the handle's close rejects after a closeAll that resolved", async () => {
    closeRejects = true;
    await wire();
    input.emit("end");
    await settle();
    expect(closeCalls).toBe(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits 1 at the deadline and not before when closeAll never settles, logging the bounded shutdown's line", async () => {
    proxy.mode = "hold";
    await wire();
    input.emit("end");
    await vi.advanceTimersByTimeAsync(DEADLINE - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith("shutdown did not finish within 1 s; exiting");
    expect(closeCalls).toBe(0);
  });

  it("starts closeAll with the transport's own close already done, when the transport closes itself", async () => {
    await wire();
    input.emit("end");
    await settle();
    expect(selfClosedAtCloseAll).toBe(selfClose);
    // The self-close is never counted as a call of the handle's close.
    expect(closeCalls).toBe(1);
  });
});

describe("guardStdout", () => {
  const names = ["debug", "log", "info"] as const;
  const saved = names.map((n) => console[n]);
  afterEach(() => {
    names.forEach((n, i) => {
      console[n] = saved[i]!;
    });
    vi.restoreAllMocks();
  });

  it("sends console.debug, console.log and console.info to stderr and nothing to stdout", () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    // console.error is what Node writes to stderr; the guard must route the three to it.
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    guardStdout();
    for (const n of names) console[n](`via ${n}`);
    expect(out).not.toHaveBeenCalled();
    expect(err.mock.calls.map((c) => c[0])).toEqual(["via debug", "via log", "via info"]);
  });
});

describe("runEntry guards stdout before serving", () => {
  const names = ["debug", "log", "info"] as const;
  const saved = names.map((n) => console[n]);
  afterEach(() => {
    names.forEach((n, i) => {
      console[n] = saved[i]!;
    });
    vi.restoreAllMocks();
  });

  it("sends console.debug, console.log and console.info to stderr from the moment serving starts", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runEntry({
      input: new EventEmitter(),
      signals: new EventEmitter(),
      exit: () => undefined,
      app: { shutdown: async () => undefined },
      serve: async () => {
        // What a dependency does while serving starts.
        for (const n of names) console[n](`at serve ${n}`);
        return { close: async () => undefined };
      },
      log: () => undefined,
    });
    expect(out).not.toHaveBeenCalled();
    expect(err.mock.calls.map((c) => c[0])).toEqual(["at serve debug", "at serve log", "at serve info"]);
  });
});
