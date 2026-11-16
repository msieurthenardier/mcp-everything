import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SHUTDOWN_DEADLINE_MS, boundedShutdown } from "../src/shutdown.js";

const DEADLINE = 1000;

describe("boundedShutdown", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(close: () => Promise<unknown>) {
    const exit = vi.fn();
    const log = vi.fn();
    const closeFn = vi.fn(close);
    const handler = boundedShutdown({ close: closeFn, exit, deadlineMs: DEADLINE, log });
    return { exit, log, closeFn, handler };
  }

  it("uses a 15 second deadline", () => {
    expect(SHUTDOWN_DEADLINE_MS).toBe(15_000);
  });

  it("exits 0 once when close settles, and clears the timer", async () => {
    const { exit, log, handler } = setup(async () => undefined);
    handler();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(DEADLINE * 2);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it("exits 0 when close rejects", async () => {
    const { exit, handler } = setup(() => Promise.reject(new Error("boom")));
    handler();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("exits 0 when close throws synchronously", async () => {
    const { exit, handler } = setup(() => {
      throw new Error("boom");
    });
    handler();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits 1 at the deadline and not before when close hangs, logging one line", async () => {
    const { exit, log, handler } = setup(() => new Promise(() => {}));
    handler();
    await vi.advanceTimersByTimeAsync(DEADLINE - 1);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/did not finish within/);
    await vi.advanceTimersByTimeAsync(DEADLINE * 2);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("does not exit 0 when close settles after the deadline fired", async () => {
    let release!: () => void;
    const { exit, handler } = setup(() => new Promise<void>((r) => (release = r)));
    handler();
    await vi.advanceTimersByTimeAsync(DEADLINE);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("ignores a second call while pending", async () => {
    const { exit, closeFn, handler } = setup(() => new Promise(() => {}));
    handler();
    const timers = vi.getTimerCount();
    handler();
    expect(closeFn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(timers);
    await vi.advanceTimersByTimeAsync(DEADLINE);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("ignores a second call after the shutdown finished", async () => {
    const { exit, closeFn, handler } = setup(async () => undefined);
    handler();
    await vi.advanceTimersByTimeAsync(0);
    handler();
    expect(closeFn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
