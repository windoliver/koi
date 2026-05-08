import { describe, expect, it } from "bun:test";
import type { KoiError, Result, WorkerEvent } from "@koi/core";
import { agentId, workerId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";
import { createRemoteBackend } from "../remote-backend.js";

type Handler = (
  method: string,
  params: Record<string, unknown>,
) => Promise<Result<unknown, KoiError>>;

function makeTransport(handler: Handler): {
  transport: NexusTransport;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  return {
    transport: {
      kind: "http",
      call: async <T>(
        method: string,
        params: Record<string, unknown>,
      ): Promise<Result<T, KoiError>> => {
        calls.push({ method, params });
        return handler(method, params) as Promise<Result<T, KoiError>>;
      },
      close: () => {},
    },
    calls,
  };
}

describe("remote backend", () => {
  it("probes availability, spawns remotely, and replays buffered + polled events", async () => {
    const id = workerId("remote-1");
    const { transport, calls } = makeTransport(async (method, params) => {
      if (method === "workers.probe") return { ok: true, value: { available: true } };
      if (method === "workers.spawn") {
        expect(params).toEqual({
          workerId: "remote-1",
          agentId: "agent-remote-1",
          command: ["bun", "--version"],
          cwd: "/tmp/remote-1",
          env: { FOO: "bar" },
          backendHints: { heartbeat: true },
        });
        return { ok: true, value: { startedAt: 123, pid: 4101, cursor: 0 } };
      }
      if (method === "workers.events") {
        return {
          ok: true,
          value: {
            cursor: params.cursor ?? 0,
            nextCursor: 1,
            alive: false,
            events: [
              {
                kind: "exited",
                workerId: "remote-1",
                at: 456,
                code: 0,
                state: "terminated",
              },
            ],
          },
        };
      }
      if (method === "workers.status") return { ok: true, value: { alive: false } };
      throw new Error(`unexpected method ${method}`);
    });

    const backend = createRemoteBackend({ transport, pollIntervalMs: 1 });

    expect(await backend.isAvailable()).toBe(true);
    const spawned = await backend.spawn({
      workerId: id,
      agentId: agentId("agent-remote-1"),
      command: ["bun", "--version"],
      cwd: "/tmp/remote-1",
      env: { FOO: "bar" },
      backendHints: { heartbeat: true },
    });

    expect(spawned.ok).toBe(true);
    if (!spawned.ok) return;
    expect(spawned.value.backendKind).toBe("remote");
    expect(spawned.value.startedAt).toBe(123);

    const events: WorkerEvent[] = [];
    for await (const ev of backend.watch(id)) {
      events.push(ev);
    }

    expect(events.map((ev) => ev.kind)).toEqual(["started", "exited"]);
    expect(events[0]).toMatchObject({ kind: "started", pid: 4101, workerId: "remote-1", at: 123 });
    expect(calls.map((call) => call.method)).toEqual([
      "workers.probe",
      "workers.spawn",
      "workers.events",
    ]);
  });

  it("rejects empty commands before transport use", async () => {
    const { transport, calls } = makeTransport(async () => ({ ok: true, value: undefined }));
    const backend = createRemoteBackend({ transport });

    const spawned = await backend.spawn({
      workerId: workerId("remote-empty"),
      agentId: agentId("agent-remote-empty"),
      command: [],
    });

    expect(spawned.ok).toBe(false);
    if (!spawned.ok) expect(spawned.error.code).toBe("VALIDATION");
    expect(calls).toEqual([]);
  });

  it("watch exits cleanly when aborted mid-poll", async () => {
    const id = workerId("remote-abort");
    const { transport } = makeTransport(async (method) => {
      if (method === "workers.spawn") return { ok: true, value: { startedAt: 1000, cursor: 0 } };
      if (method === "workers.events") {
        return { ok: true, value: { events: [], nextCursor: 0, alive: true } };
      }
      if (method === "workers.status") return { ok: true, value: { alive: true } };
      if (method === "workers.probe") return { ok: true, value: true };
      throw new Error(`unexpected method ${method}`);
    });

    const backend = createRemoteBackend({ transport, pollIntervalMs: 50 });
    const spawned = await backend.spawn({
      workerId: id,
      agentId: agentId("agent-remote-abort"),
      command: ["bun", "-e", "setTimeout(()=>{},10000)"],
    });
    expect(spawned.ok).toBe(true);

    const controller = new AbortController();
    const kinds: string[] = [];
    const watchPromise = (async (): Promise<void> => {
      for await (const ev of backend.watch(id, controller.signal)) {
        kinds.push(ev.kind);
        if (ev.kind === "started") queueMicrotask(() => controller.abort());
      }
    })();

    await Promise.race([
      watchPromise,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), 1000)),
    ]);

    expect(kinds).toEqual(["started"]);
  });

  it("treats unknown workers as already gone", async () => {
    const { transport, calls } = makeTransport(async (method) => {
      if (method === "workers.status") {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: "no such worker", retryable: false },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const backend = createRemoteBackend({ transport, pollIntervalMs: 1 });

    const events: WorkerEvent[] = [];
    for await (const ev of backend.watch(workerId("gone-worker"))) {
      events.push(ev);
    }

    expect(events).toEqual([]);
    expect(calls.map((call) => call.method)).toEqual(["workers.status"]);
  });

  it("same-id respawn replaces the prior watcher state", async () => {
    const id = workerId("remote-respawn");
    let generation = 0;
    let terminated = false;
    const { transport } = makeTransport(async (method, params) => {
      if (method === "workers.spawn") {
        generation += 1;
        return { ok: true, value: { startedAt: generation * 100, cursor: generation } };
      }
      if (method === "workers.events") {
        const cursor = Number(paramsToCursor(params));
        if (cursor === 2) {
          return {
            ok: true,
            value: {
              events: [
                {
                  kind: "exited",
                  workerId: "remote-respawn",
                  at: 250,
                  code: 0,
                  state: "terminated",
                },
              ],
              nextCursor: 3,
              alive: false,
            },
          };
        }
        return { ok: true, value: { events: [], nextCursor: cursor, alive: true } };
      }
      if (method === "workers.status") return { ok: true, value: { alive: !terminated } };
      if (method === "workers.probe") return { ok: true, value: true };
      if (method === "workers.terminate") {
        terminated = true;
        return { ok: true, value: undefined };
      }
      throw new Error(`unexpected method ${method}`);
    });

    const backend = createRemoteBackend({ transport, pollIntervalMs: 1 });
    expect(
      (
        await backend.spawn({
          workerId: id,
          agentId: agentId("agent-remote-respawn-1"),
          command: ["bun", "-e", "1"],
        })
      ).ok,
    ).toBe(true);

    const firstController = new AbortController();
    const firstKinds: string[] = [];
    const firstWatch = (async (): Promise<void> => {
      for await (const ev of backend.watch(id, firstController.signal)) {
        firstKinds.push(ev.kind);
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      (
        await backend.spawn({
          workerId: id,
          agentId: agentId("agent-remote-respawn-2"),
          command: ["bun", "-e", "2"],
        })
      ).ok,
    ).toBe(true);

    await Promise.race([
      firstWatch,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("timeout")), 1000)),
    ]);
    expect(firstKinds).toEqual(["started", "exited"]);

    const secondKinds: string[] = [];
    for await (const ev of backend.watch(id)) {
      secondKinds.push(ev.kind);
    }
    expect(secondKinds).toEqual(["started", "exited"]);
  });

  it("propagates transport errors from workers.spawn", async () => {
    const { transport } = makeTransport(async (method) => {
      if (method === "workers.spawn") {
        return {
          ok: false,
          error: { code: "INTERNAL", message: "remote unavailable", retryable: true },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const backend = createRemoteBackend({ transport });

    const spawned = await backend.spawn({
      workerId: workerId("remote-spawn-fail"),
      agentId: agentId("agent-spawn-fail"),
      command: ["bun", "-v"],
    });
    expect(spawned.ok).toBe(false);
    if (!spawned.ok) expect(spawned.error.code).toBe("INTERNAL");
  });

  it("rejects malformed workers.spawn payloads", async () => {
    const { transport } = makeTransport(async (method) => {
      if (method === "workers.spawn") return { ok: true, value: "not-an-object" };
      throw new Error(`unexpected method ${method}`);
    });
    const backend = createRemoteBackend({ transport });

    const spawned = await backend.spawn({
      workerId: workerId("remote-bad-payload"),
      agentId: agentId("agent-bad-payload"),
      command: ["bun", "-v"],
    });
    expect(spawned.ok).toBe(false);
    if (!spawned.ok) expect(spawned.error.code).toBe("VALIDATION");
  });

  it("drops cross-worker events from polled batches", async () => {
    const id = workerId("remote-scope");
    let pollCount = 0;
    const { transport } = makeTransport(async (method) => {
      if (method === "workers.spawn")
        return { ok: true, value: { startedAt: 1, cursor: 0, events: [] } };
      if (method === "workers.events") {
        pollCount += 1;
        if (pollCount === 1) {
          return {
            ok: true,
            value: {
              events: [
                {
                  kind: "exited",
                  workerId: "OTHER",
                  at: 50,
                  code: 1,
                  state: "terminated",
                },
                {
                  kind: "exited",
                  workerId: "remote-scope",
                  at: 60,
                  code: 0,
                  state: "terminated",
                },
              ],
              nextCursor: 1,
              alive: false,
            },
          };
        }
        return { ok: true, value: { events: [], nextCursor: 1, alive: true } };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const backend = createRemoteBackend({ transport, pollIntervalMs: 1 });

    expect(
      (
        await backend.spawn({
          workerId: id,
          agentId: agentId("agent-scope"),
          command: ["bun", "-v"],
        })
      ).ok,
    ).toBe(true);

    const seen: WorkerEvent[] = [];
    for await (const ev of backend.watch(id)) {
      seen.push(ev);
    }
    expect(seen.every((ev) => ev.workerId === "remote-scope")).toBe(true);
    expect(seen.some((ev) => ev.kind === "exited")).toBe(true);
  });

  it("skips unknown event kinds in polled batches", async () => {
    const id = workerId("remote-unknown");
    let pollCount = 0;
    const { transport } = makeTransport(async (method) => {
      if (method === "workers.spawn")
        return { ok: true, value: { startedAt: 1, cursor: 0, events: [] } };
      if (method === "workers.events") {
        pollCount += 1;
        if (pollCount === 1) {
          return {
            ok: true,
            value: {
              events: [
                { kind: "paused", workerId: "remote-unknown", at: 50 },
                {
                  kind: "exited",
                  workerId: "remote-unknown",
                  at: 60,
                  code: 0,
                  state: "terminated",
                },
              ],
              nextCursor: 1,
              alive: false,
            },
          };
        }
        return { ok: true, value: { events: [], nextCursor: 1, alive: true } };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const backend = createRemoteBackend({ transport, pollIntervalMs: 1 });

    expect(
      (
        await backend.spawn({
          workerId: id,
          agentId: agentId("agent-unknown"),
          command: ["bun", "-v"],
        })
      ).ok,
    ).toBe(true);

    const kinds: string[] = [];
    for await (const ev of backend.watch(id)) {
      kinds.push(ev.kind);
    }
    expect(kinds).toEqual(["started", "exited"]);
  });

  it("yields heartbeat events from polled batches", async () => {
    const id = workerId("remote-hb");
    let pollCount = 0;
    const { transport } = makeTransport(async (method) => {
      if (method === "workers.spawn")
        return { ok: true, value: { startedAt: 1, cursor: 0, events: [] } };
      if (method === "workers.events") {
        pollCount += 1;
        if (pollCount === 1) {
          return {
            ok: true,
            value: {
              events: [{ kind: "heartbeat", workerId: "remote-hb", at: 50 }],
              nextCursor: 1,
              alive: true,
            },
          };
        }
        return {
          ok: true,
          value: {
            events: [
              {
                kind: "exited",
                workerId: "remote-hb",
                at: 60,
                code: 0,
                state: "terminated",
              },
            ],
            nextCursor: 2,
            alive: false,
          },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const backend = createRemoteBackend({ transport, pollIntervalMs: 1 });

    expect(
      (
        await backend.spawn({
          workerId: id,
          agentId: agentId("agent-hb"),
          command: ["bun", "-v"],
        })
      ).ok,
    ).toBe(true);

    const kinds: string[] = [];
    for await (const ev of backend.watch(id)) {
      kinds.push(ev.kind);
    }
    expect(kinds).toContain("heartbeat");
    expect(kinds).toContain("exited");
  });

  it("synthesizes crashed when spawn reports alive=false without a terminal event", async () => {
    const id = workerId("remote-dead-spawn");
    const { transport } = makeTransport(async (method) => {
      if (method === "workers.spawn")
        return { ok: true, value: { startedAt: 1, cursor: 0, alive: false, events: [] } };
      if (method === "workers.events")
        return { ok: true, value: { events: [], nextCursor: 0, alive: false } };
      throw new Error(`unexpected method ${method}`);
    });
    const backend = createRemoteBackend({ transport, pollIntervalMs: 1 });

    expect(
      (
        await backend.spawn({
          workerId: id,
          agentId: agentId("agent-dead-spawn"),
          command: ["bun", "-v"],
        })
      ).ok,
    ).toBe(true);

    const kinds: string[] = [];
    for await (const ev of backend.watch(id)) {
      kinds.push(ev.kind);
    }
    expect(kinds).toContain("started");
    expect(kinds).toContain("crashed");
  });

  it("rejects concurrent watchers on the same worker", async () => {
    const id = workerId("remote-concurrent");
    const { transport } = makeTransport(async (method) => {
      if (method === "workers.spawn")
        return { ok: true, value: { startedAt: 1, cursor: 0, events: [] } };
      if (method === "workers.events")
        return { ok: true, value: { events: [], nextCursor: 0, alive: true } };
      throw new Error(`unexpected method ${method}`);
    });
    const backend = createRemoteBackend({ transport, pollIntervalMs: 50 });

    expect(
      (
        await backend.spawn({
          workerId: id,
          agentId: agentId("agent-concurrent"),
          command: ["bun", "-v"],
        })
      ).ok,
    ).toBe(true);

    const firstController = new AbortController();
    const firstWatch = (async (): Promise<void> => {
      for await (const _ev of backend.watch(id, firstController.signal)) {
        // drain
      }
    })();
    await new Promise((r) => setTimeout(r, 5));

    let threw = false;
    try {
      const iter = backend.watch(id)[Symbol.asyncIterator]();
      await iter.next();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    firstController.abort();
    await firstWatch;
  });

  it("respawn fails with CONFLICT when previous remote worker is still alive", async () => {
    const id = workerId("remote-conflict");
    const { transport } = makeTransport(async (method) => {
      if (method === "workers.spawn")
        return { ok: true, value: { startedAt: 1, cursor: 0, events: [] } };
      if (method === "workers.events")
        return { ok: true, value: { events: [], nextCursor: 0, alive: true } };
      if (method === "workers.terminate") return { ok: true, value: undefined };
      if (method === "workers.status") return { ok: true, value: { alive: true } };
      throw new Error(`unexpected method ${method}`);
    });
    const backend = createRemoteBackend({ transport, pollIntervalMs: 50 });

    expect(
      (
        await backend.spawn({
          workerId: id,
          agentId: agentId("agent-conflict-1"),
          command: ["bun", "-v"],
        })
      ).ok,
    ).toBe(true);

    const second = await backend.spawn({
      workerId: id,
      agentId: agentId("agent-conflict-2"),
      command: ["bun", "-v"],
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("CONFLICT");
  });

  it("isAlive after terminate ack queries remote status to confirm", async () => {
    const id = workerId("remote-confirm");
    let statusCalls = 0;
    const { transport } = makeTransport(async (method) => {
      if (method === "workers.spawn")
        return { ok: true, value: { startedAt: 1, cursor: 0, events: [] } };
      if (method === "workers.terminate") return { ok: true, value: undefined };
      if (method === "workers.status") {
        statusCalls += 1;
        return { ok: true, value: { alive: false } };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const backend = createRemoteBackend({ transport, pollIntervalMs: 50 });

    expect(
      (
        await backend.spawn({
          workerId: id,
          agentId: agentId("agent-confirm"),
          command: ["bun", "-v"],
        })
      ).ok,
    ).toBe(true);

    const term = await backend.terminate(id, "test");
    expect(term.ok).toBe(true);

    const alive = await backend.isAlive(id);
    expect(alive).toBe(false);
    expect(statusCalls).toBeGreaterThan(0);
  });

  it("isAlive preserves cached liveness on transient status failures", async () => {
    const id = workerId("remote-flaky");
    const { transport } = makeTransport(async (method) => {
      if (method === "workers.spawn")
        return { ok: true, value: { startedAt: 1, cursor: 0, events: [] } };
      if (method === "workers.terminate") return { ok: true, value: undefined };
      if (method === "workers.status") {
        return {
          ok: false,
          error: { code: "INTERNAL", message: "nexus down", retryable: true },
        };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const backend = createRemoteBackend({ transport, pollIntervalMs: 50 });

    expect(
      (
        await backend.spawn({
          workerId: id,
          agentId: agentId("agent-flaky"),
          command: ["bun", "-v"],
        })
      ).ok,
    ).toBe(true);

    expect((await backend.terminate(id, "test")).ok).toBe(true);
    const alive = await backend.isAlive(id);
    expect(alive).toBe(true);
  });
});

function paramsToCursor(params: unknown): number {
  if (params === null || typeof params !== "object") return 0;
  const value = (params as Record<string, unknown>).cursor;
  return typeof value === "number" ? value : 0;
}
