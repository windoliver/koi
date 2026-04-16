import { afterEach, describe, expect, it } from "bun:test";
import type { Supervisor } from "@koi/core";
import { registerSignalHandlers } from "../signal-handlers.js";

describe("registerSignalHandlers", () => {
  const removed: Array<() => void> = [];
  afterEach(() => {
    for (const r of removed) r();
    removed.length = 0;
  });

  it("invokes supervisor.shutdown on SIGTERM", async () => {
    const calls: string[] = [];
    const fakeSupervisor = {
      shutdown: async (reason: string) => {
        calls.push(reason);
        return { ok: true, value: undefined };
      },
    } as unknown as Supervisor;

    const cleanup = registerSignalHandlers(fakeSupervisor);
    removed.push(cleanup);

    process.emit("SIGTERM", "SIGTERM");
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toContain("SIGTERM");
  });

  it("invokes supervisor.shutdown on SIGINT", async () => {
    const calls: string[] = [];
    const fakeSupervisor = {
      shutdown: async (reason: string) => {
        calls.push(reason);
        return { ok: true, value: undefined };
      },
    } as unknown as Supervisor;

    const cleanup = registerSignalHandlers(fakeSupervisor);
    removed.push(cleanup);

    process.emit("SIGINT", "SIGINT");
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toContain("SIGINT");
  });
});
