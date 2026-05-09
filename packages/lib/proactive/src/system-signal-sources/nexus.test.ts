import { describe, expect, test } from "bun:test";
import type { SystemSignal } from "@koi/core";
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
        zoneId: "zone-1",
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
      to: "failed",
      reason: "error",
      generation: 2,
      emittedAt: 2,
    });
    await new Promise((resolve) => queueMicrotask(resolve));
    stop();

    expect(seen).toEqual([
      {
        kind: "agent_lifecycle",
        agentId: "agent-1",
        from: "running",
        to: "failed",
        reason: "error",
        generation: 2,
        emittedAt: 2,
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
      path: "/tmp/ignored.txt",
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
        zoneId: "zone-1",
        emittedAt: 11,
      },
    ]);
  });
});
