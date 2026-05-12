import { describe, expect, mock, test } from "bun:test";
import type { SystemSignal } from "@koi/core";
import { agentId, zoneId } from "@koi/core";
import { createNexusSignalSource } from "./nexus.js";

describe("createNexusSignalSource", () => {
  test("maps write events into vfs signals", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const source = createNexusSignalSource({
      channels: ["vfs"],
      subscribe: (_channels, next) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    });

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal));
    listener?.({
      channel: "vfs",
      event: "write",
      path: "/tmp/a.txt",
      zoneId: "zone-1",
      emittedAt: 10,
    });
    await new Promise((resolve) => queueMicrotask(resolve));
    stop();

    expect(seen).toEqual([
      {
        kind: "vfs",
        event: "write",
        path: "/tmp/a.txt",
        zoneId: zoneId("zone-1"),
        emittedAt: 10,
      },
    ]);
  });

  test("maps lifecycle transitions and respects path filters", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const source = createNexusSignalSource({
      pathFilters: ["/workspace/docs/*"],
      subscribe: (_channels, next) => {
        listener = next;
        return () => {};
      },
    });

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal));
    listener?.({
      channel: "vfs",
      event: "write",
      path: "/workspace/src/a.ts",
      emittedAt: 1,
    });
    listener?.({
      channel: "agent",
      event: "transition",
      agentId: "agent-1",
      from: "running",
      to: "terminated",
      reason: { kind: "error" },
      generation: 2,
      emittedAt: 2,
    });
    await new Promise((resolve) => queueMicrotask(resolve));
    stop();

    expect(seen).toEqual([
      {
        kind: "agent_lifecycle",
        agentId: agentId("agent-1"),
        from: "running",
        to: "terminated",
        reason: { kind: "error" },
        generation: 2,
        emittedAt: 2,
      },
    ]);
  });

  test("accepts error transition reasons when cause is explicitly undefined", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const source = createNexusSignalSource({
      subscribe: (_channels, next) => {
        listener = next;
        return () => {};
      },
    });

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal));
    listener?.({
      channel: "agent",
      event: "transition",
      agentId: "agent-1",
      from: "running",
      to: "terminated",
      reason: { kind: "error", cause: undefined },
      generation: 2,
      emittedAt: 2,
    });
    await new Promise((resolve) => queueMicrotask(resolve));
    stop();

    expect(seen).toEqual([
      {
        kind: "agent_lifecycle",
        agentId: agentId("agent-1"),
        from: "running",
        to: "terminated",
        reason: { kind: "error", cause: undefined },
        generation: 2,
        emittedAt: 2,
      },
    ]);
  });

  test("drops lifecycle transitions with invalid contract shapes", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const source = createNexusSignalSource({
      subscribe: (_channels, next) => {
        listener = next;
        return () => {};
      },
    });

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal));
    listener?.({
      channel: "agent",
      event: "transition",
      agentId: "agent-1",
      from: "running",
      to: "failed",
      reason: { kind: "error" },
      generation: 2,
      emittedAt: 2,
    });
    listener?.({
      channel: "agent",
      event: "transition",
      agentId: "agent-1",
      from: "running",
      to: "terminated",
      reason: "error",
      generation: 2,
      emittedAt: 3,
    });
    await new Promise((resolve) => queueMicrotask(resolve));
    stop();

    expect(seen).toEqual([]);
  });

  test("drops lifecycle transitions with non-finite numeric fields", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const source = createNexusSignalSource({
      subscribe: (_channels, next) => {
        listener = next;
        return () => {};
      },
    });

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal));
    listener?.({
      channel: "agent",
      event: "transition",
      agentId: "agent-1",
      from: "running",
      to: "terminated",
      reason: { kind: "error" },
      generation: Number.POSITIVE_INFINITY,
      emittedAt: 5,
    });
    listener?.({
      channel: "agent",
      event: "transition",
      agentId: "agent-1",
      from: "running",
      to: "terminated",
      reason: { kind: "error" },
      generation: 2,
      emittedAt: Number.NaN,
    });
    listener?.({
      channel: "vfs",
      event: "write",
      path: "/tmp/non-finite.txt",
      emittedAt: Number.POSITIVE_INFINITY,
    });
    await new Promise((resolve) => queueMicrotask(resolve));
    stop();

    expect(seen).toEqual([]);
  });

  test("drops lifecycle transitions with non-integer or negative generation and restarted attempts", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const source = createNexusSignalSource({
      subscribe: (_channels, next) => {
        listener = next;
        return () => {};
      },
    });

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal));
    listener?.({
      channel: "agent",
      event: "transition",
      agentId: "agent-1",
      from: "running",
      to: "terminated",
      reason: { kind: "completed" },
      generation: -1,
      emittedAt: 6,
    });
    listener?.({
      channel: "agent",
      event: "transition",
      agentId: "agent-1",
      from: "running",
      to: "terminated",
      reason: { kind: "completed" },
      generation: 1.5,
      emittedAt: 7,
    });
    listener?.({
      channel: "agent",
      event: "transition",
      agentId: "agent-1",
      from: "suspended",
      to: "running",
      reason: { kind: "restarted", attempt: 1.25, strategy: "retry" },
      generation: 3,
      emittedAt: 8,
    });
    listener?.({
      channel: "agent",
      event: "transition",
      agentId: "agent-1",
      from: "suspended",
      to: "running",
      reason: { kind: "restarted", attempt: Number.POSITIVE_INFINITY, strategy: "retry" },
      generation: 4,
      emittedAt: 9,
    });
    await new Promise((resolve) => queueMicrotask(resolve));
    stop();

    expect(seen).toEqual([]);
  });

  test("drops lifecycle transitions with invalid state pairs", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const source = createNexusSignalSource({
      subscribe: (_channels, next) => {
        listener = next;
        return () => {};
      },
    });

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal));
    listener?.({
      channel: "agent",
      event: "transition",
      agentId: "agent-1",
      from: "created",
      to: "idle",
      reason: { kind: "completed" },
      generation: 2,
      emittedAt: 4,
    });
    await new Promise((resolve) => queueMicrotask(resolve));
    stop();

    expect(seen).toEqual([]);
  });

  test("maps delete events into vfs signals", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const source = createNexusSignalSource({
      channels: ["vfs"],
      subscribe: (_channels, next) => {
        listener = next;
        return () => {};
      },
    });

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal));
    listener?.({
      channel: "vfs",
      event: "delete",
      path: "/tmp/dead.txt",
      zoneId: "zone-2",
      emittedAt: 12,
    });
    await new Promise((resolve) => queueMicrotask(resolve));
    stop();

    expect(seen).toEqual([
      {
        kind: "vfs",
        event: "delete",
        path: "/tmp/dead.txt",
        zoneId: zoneId("zone-2"),
        emittedAt: 12,
      },
    ]);
  });

  test("maps rename events into vfs rename signals", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const source = createNexusSignalSource({
      channels: ["vfs"],
      subscribe: (_channels, next) => {
        listener = next;
        return () => {};
      },
    });

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal));
    listener?.({
      channel: "vfs",
      event: "rename",
      from: "/tmp/old.txt",
      to: "/tmp/new.txt",
      zoneId: "zone-1",
      emittedAt: 11,
    });
    await new Promise((resolve) => queueMicrotask(resolve));
    stop();

    expect(seen).toEqual([
      {
        kind: "vfs",
        event: "rename",
        path: "/tmp/old.txt",
        from: "/tmp/old.txt",
        to: "/tmp/new.txt",
        zoneId: zoneId("zone-1"),
        emittedAt: 11,
      },
    ]);
  });

  test("filters rename events using from/to instead of a synthetic path field", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const source = createNexusSignalSource({
      pathFilters: ["/workspace/docs/*"],
      subscribe: (_channels, next) => {
        listener = next;
        return () => {};
      },
    });

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal));
    listener?.({
      channel: "vfs",
      event: "rename",
      from: "/workspace/docs/old.md",
      to: "/workspace/src/new.md",
      emittedAt: 14,
    });
    listener?.({
      channel: "vfs",
      event: "rename",
      from: "/workspace/src/old.ts",
      to: "/workspace/docs/new.ts",
      emittedAt: 15,
    });
    listener?.({
      channel: "vfs",
      event: "rename",
      from: "/workspace/src/old.ts",
      to: "/workspace/src/new.ts",
      emittedAt: 16,
    });
    await new Promise((resolve) => queueMicrotask(resolve));
    stop();

    expect(seen).toEqual([
      {
        kind: "vfs",
        event: "rename",
        path: "/workspace/docs/old.md",
        from: "/workspace/docs/old.md",
        to: "/workspace/src/new.md",
        emittedAt: 14,
      },
      {
        kind: "vfs",
        event: "rename",
        path: "/workspace/src/old.ts",
        from: "/workspace/src/old.ts",
        to: "/workspace/docs/new.ts",
        emittedAt: 15,
      },
    ]);
  });

  test("forwards subscription listener errors and stays subscribed", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const source = createNexusSignalSource({
      subscribe: (_channels, next) => {
        listener = next;
        return () => {};
      },
    });

    const seen: SystemSignal[] = [];
    const onError = mock(() => {});
    const stop = source.watch((signal) => seen.push(signal), { onError });
    listener?.(
      Object.defineProperty({}, "channel", {
        get() {
          throw new Error("bad event");
        },
      }),
    );
    listener?.({
      channel: "vfs",
      event: "write",
      path: "/tmp/recovered.txt",
      emittedAt: 13,
    });
    await new Promise((resolve) => queueMicrotask(resolve));
    stop();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([
      {
        kind: "vfs",
        event: "write",
        path: "/tmp/recovered.txt",
        emittedAt: 13,
      },
    ]);
  });

  test("stop prevents an already-queued nexus delivery from reaching the handler", async () => {
    let listener: ((event: unknown) => void) | undefined;
    const source = createNexusSignalSource({
      subscribe: (_channels, next) => {
        listener = next;
        return () => {};
      },
    });

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal));
    listener?.({
      channel: "vfs",
      event: "write",
      path: "/tmp/queued.txt",
      emittedAt: 16,
    });
    stop();
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(seen).toEqual([]);
  });

  test("unsubscribe detaches the underlying listener and disconnect fires once", () => {
    let cleanupCalls = 0;
    const source = createNexusSignalSource({
      subscribe: (_channels, _next) => () => {
        cleanupCalls += 1;
      },
    });

    const onDisconnect = mock(() => {});
    const stop = source.watch(() => {}, { onDisconnect });

    stop();
    stop();

    expect(cleanupCalls).toBe(1);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});
