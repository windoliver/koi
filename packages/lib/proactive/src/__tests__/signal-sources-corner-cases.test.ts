/**
 * Corner-case coverage for the system signal source adapters.
 *
 * Focuses on boundaries and adversarial inputs that the unit-test files
 * exercise lightly: handler exceptions, exact-cooldown timing, sensor
 * disappearance, malformed SSE frames, lifecycle self-loops, and the
 * close-aware emitter's resilience under emit-during-emit re-entry.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  GovernanceController,
  GovernanceSnapshot,
  ProcessState,
  SystemSignal,
  TransitionReason,
} from "@koi/core";
import { createGovernanceSignalSource } from "../system-signal-sources/governance.js";
import {
  createGroveSignalSource,
  type GroveEventSourceLike,
} from "../system-signal-sources/grove.js";
import { createNexusSignalSource } from "../system-signal-sources/nexus.js";
import {
  createAsyncEmitter,
  createSubscriptionController,
} from "../system-signal-sources/shared.js";

function controllerFromReadings(readings: GovernanceSnapshot["readings"]): GovernanceController {
  return {
    check: async () => ({ ok: true }),
    checkAll: async () => ({ ok: true }),
    record: async () => {},
    snapshot: async () => ({
      timestamp: 100,
      readings,
      healthy: true,
      violations: [],
    }),
    variables: () => new Map(),
    reading: (name) => readings.find((r) => r.name === name),
  };
}

// ---------------------------------------------------------------------------
// Shared async emitter
// ---------------------------------------------------------------------------

describe("shared emitter — corner cases", () => {
  test("sampleRateMs = 0 delivers every emission", async () => {
    let now = 100;
    const seen: number[] = [];
    const emitter = createAsyncEmitter(
      (s) => {
        if ("emittedAt" in s) seen.push(s.emittedAt);
      },
      { sampleRateMs: 0 },
      () => now,
    );
    emitter.emit({ kind: "vfs", event: "write", path: "/a", emittedAt: 100 });
    now = 100;
    emitter.emit({ kind: "vfs", event: "write", path: "/b", emittedAt: 101 });
    await Promise.resolve();
    expect(seen).toEqual([100, 101]);
  });

  test("throwing handler is caught and subsequent deliveries continue", async () => {
    const seen: number[] = [];
    const onError = mock(() => {});
    const emitter = createAsyncEmitter(
      (s) => {
        if (!("emittedAt" in s)) return;
        if (s.emittedAt === 1) throw new Error("boom");
        seen.push(s.emittedAt);
      },
      { onError },
    );

    emitter.emit({ kind: "vfs", event: "write", path: "/a", emittedAt: 1 });
    emitter.emit({ kind: "vfs", event: "write", path: "/b", emittedAt: 2 });

    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([2]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("throwing handler without onError swallows the error silently", async () => {
    const seen: number[] = [];
    const emitter = createAsyncEmitter((s) => {
      if (!("emittedAt" in s)) return;
      if (s.emittedAt === 1) throw new Error("boom");
      seen.push(s.emittedAt);
    }, undefined);

    emitter.emit({ kind: "vfs", event: "write", path: "/a", emittedAt: 1 });
    emitter.emit({ kind: "vfs", event: "write", path: "/b", emittedAt: 2 });

    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([2]);
  });

  test("emit inside handler does not recurse infinitely", async () => {
    let count = 0;
    let emitter: ReturnType<typeof createAsyncEmitter>;
    emitter = createAsyncEmitter((s) => {
      count += 1;
      if (count < 3 && "emittedAt" in s) {
        emitter.emit({ kind: "vfs", event: "write", path: "/x", emittedAt: count });
      }
    }, undefined);

    emitter.emit({ kind: "vfs", event: "write", path: "/x", emittedAt: 0 });
    await new Promise((r) => setTimeout(r, 5));
    expect(count).toBe(3);
  });

  test("subscription controller rejects double-close after handler runs", () => {
    let closed = 0;
    const ctrl = createSubscriptionController(() => {
      closed += 1;
    });
    ctrl.unsubscribe();
    ctrl.unsubscribe();
    ctrl.unsubscribe();
    expect(closed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Governance source
// ---------------------------------------------------------------------------

describe("governance source — corner cases", () => {
  test("reading exactly equal to limit does not alert (strict >)", async () => {
    const controller = controllerFromReadings([
      { name: "error_rate", current: 0.3, limit: 1, utilization: 0.3 },
    ]);
    const seen: SystemSignal[] = [];
    const stop = createGovernanceSignalSource(
      controller,
      [{ sensor: "error_rate", limit: 0.3, direction: "above" }],
      { now: () => 1, pollIntervalMs: 1 },
    ).watch((s) => seen.push(s), { replay: true });

    await new Promise((r) => setTimeout(r, 5));
    stop();
    expect(seen).toEqual([]);
  });

  test("sensor disappearing between polls does not emit a fictional clear", async () => {
    let readings: GovernanceSnapshot["readings"] = [
      { name: "error_rate", current: 0.4, limit: 1, utilization: 0.4 },
    ];
    const controller: GovernanceController = {
      check: async () => ({ ok: true }),
      checkAll: async () => ({ ok: true }),
      record: async () => {},
      snapshot: async () => ({ timestamp: 0, readings, healthy: true, violations: [] }),
      variables: () => new Map(),
      reading: (name) => readings.find((r) => r.name === name),
    };

    const seen: SystemSignal[] = [];
    const stop = createGovernanceSignalSource(
      controller,
      [{ sensor: "error_rate", limit: 0.3, direction: "above" }],
      { now: () => 1, pollIntervalMs: 1 },
    ).watch((s) => seen.push(s), { replay: true });

    await new Promise((r) => setTimeout(r, 5));
    expect(seen.length).toBe(1);

    readings = [];
    await new Promise((r) => setTimeout(r, 10));
    stop();

    expect(seen.length).toBe(1);
  });

  test("two thresholds on the same sensor with different limits both fire", async () => {
    const controller = controllerFromReadings([
      { name: "context_occupancy", current: 0.95, limit: 1, utilization: 0.95 },
    ]);

    const seen: SystemSignal[] = [];
    const stop = createGovernanceSignalSource(
      controller,
      [
        { sensor: "context_occupancy", limit: 0.5, direction: "above" },
        { sensor: "context_occupancy", limit: 0.8, direction: "above" },
      ],
      { now: () => 1, pollIntervalMs: 1 },
    ).watch((s) => seen.push(s), { replay: true });

    await new Promise((r) => setTimeout(r, 5));
    stop();

    const limits = seen
      .filter((s) => s.kind === "governance")
      .map((s) => (s.kind === "governance" ? s.limit : -1));
    expect(limits.sort()).toEqual([0.5, 0.8]);
  });

  test("snapshot rejection after unsubscribe does not call onError", async () => {
    let resolveSnap: ((value: GovernanceSnapshot) => void) | undefined;
    let rejectSnap: ((err: unknown) => void) | undefined;
    const controller: GovernanceController = {
      check: async () => ({ ok: true }),
      checkAll: async () => ({ ok: true }),
      record: async () => {},
      snapshot: () =>
        new Promise<GovernanceSnapshot>((res, rej) => {
          resolveSnap = res;
          rejectSnap = rej;
        }),
      variables: () => new Map(),
      reading: () => undefined,
    };

    const onError = mock(() => {});
    const stop = createGovernanceSignalSource(
      controller,
      [{ sensor: "x", limit: 0, direction: "above" }],
      { pollIntervalMs: 1 },
    ).watch(() => {}, { replay: true, onError });

    await new Promise((r) => setTimeout(r, 5));
    stop();
    rejectSnap?.(new Error("after-stop"));
    resolveSnap?.({ timestamp: 0, readings: [], healthy: true, violations: [] });

    await new Promise((r) => setTimeout(r, 5));
    expect(onError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Grove source
// ---------------------------------------------------------------------------

describe("grove source — corner cases", () => {
  function fakeEventSource(): {
    readonly onerrorRef: { current: ((e: unknown) => void) | undefined };
    readonly onmessageRef: { current: ((e: MessageEvent<string>) => void) | undefined };
    readonly factory: (url: string) => GroveEventSourceLike;
  } {
    const onerrorRef: { current: ((e: unknown) => void) | undefined } = { current: undefined };
    const onmessageRef: { current: ((e: MessageEvent<string>) => void) | undefined } = {
      current: undefined,
    };
    return {
      onerrorRef,
      onmessageRef,
      factory: () =>
        ({
          close() {},
          set onmessage(fn: GroveEventSourceLike["onmessage"]) {
            onmessageRef.current = fn ?? undefined;
          },
          set onerror(fn: GroveEventSourceLike["onerror"]) {
            onerrorRef.current = fn ?? undefined;
          },
        }) satisfies GroveEventSourceLike,
    };
  }

  test("partial JSON frame routes to onError without throwing", async () => {
    const { onmessageRef, factory } = fakeEventSource();
    const onError = mock(() => {});
    const stop = createGroveSignalSource({
      groveUrl: "http://x",
      eventSourceFactory: factory,
    }).watch(() => {}, { onError });

    onmessageRef.current?.(new MessageEvent("message", { data: '{"type":"frontier_chang' }));
    await new Promise((r) => queueMicrotask(r));
    stop();

    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("improvement = -0 is accepted, non-number improvement is dropped", async () => {
    const { onmessageRef, factory } = fakeEventSource();
    const seen: SystemSignal[] = [];
    const stop = createGroveSignalSource({
      groveUrl: "http://x",
      eventSourceFactory: factory,
      now: () => 1,
    }).watch((s) => seen.push(s));

    onmessageRef.current?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "frontier_changed", metric: "m", improvement: -0 }),
      }),
    );
    onmessageRef.current?.(
      // string improvement violates `typeof === "number"` — must coerce to undefined
      new MessageEvent("message", {
        data: '{"type":"frontier_changed","metric":"m","improvement":"0.5"}',
      }),
    );
    await new Promise((r) => queueMicrotask(r));
    stop();

    const frontiers = seen.filter((s) => s.kind === "frontier");
    expect(frontiers.length).toBe(2);
    // `JSON.stringify(-0) === "0"` — sign vanishes through the wire, so the
    // adapter sees a positive 0 and surfaces that to the consumer.
    expect(frontiers[0]?.kind === "frontier" && frontiers[0].improvement).toBe(0);
    // Second event keeps metric, drops the malformed improvement instead of inventing one.
    expect(frontiers[1]?.kind === "frontier" && frontiers[1].improvement).toBeUndefined();
  });

  test("NaN serializes to JSON null and is treated as missing improvement", async () => {
    const { onmessageRef, factory } = fakeEventSource();
    const seen: SystemSignal[] = [];
    const stop = createGroveSignalSource({
      groveUrl: "http://x",
      minImprovement: 0.1,
      eventSourceFactory: factory,
    }).watch((s) => seen.push(s));

    // `JSON.stringify({improvement: NaN}) === '{"improvement":null}'`. Lock down
    // that the adapter rejects this through the minImprovement filter (improvement
    // is undefined, which fails `improvement >= minImprovement`).
    onmessageRef.current?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "frontier_changed", metric: "m", improvement: Number.NaN }),
      }),
    );
    await new Promise((r) => queueMicrotask(r));
    stop();
    expect(seen).toEqual([]);
  });

  test("empty metrics filter rejects everything", async () => {
    const { onmessageRef, factory } = fakeEventSource();
    const seen: SystemSignal[] = [];
    const stop = createGroveSignalSource({
      groveUrl: "http://x",
      metrics: [],
      eventSourceFactory: factory,
    }).watch((s) => seen.push(s));

    onmessageRef.current?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "frontier_changed", metric: "m", improvement: 0.5 }),
      }),
    );
    await new Promise((r) => queueMicrotask(r));
    stop();
    expect(seen).toEqual([]);
  });

  test("upstream onerror fires before any onmessage and reaches consumer", async () => {
    const { onerrorRef, factory } = fakeEventSource();
    const onError = mock(() => {});
    const stop = createGroveSignalSource({
      groveUrl: "http://x",
      eventSourceFactory: factory,
    }).watch(() => {}, { onError });

    onerrorRef.current?.(new Error("connect failed"));
    await new Promise((r) => queueMicrotask(r));
    stop();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("non-frontier_changed event types are silently ignored", async () => {
    const { onmessageRef, factory } = fakeEventSource();
    const seen: SystemSignal[] = [];
    const onError = mock(() => {});
    const stop = createGroveSignalSource({
      groveUrl: "http://x",
      eventSourceFactory: factory,
    }).watch((s) => seen.push(s), { onError });

    onmessageRef.current?.(
      new MessageEvent("message", {
        data: JSON.stringify({ type: "bounty_settled", id: "abc" }),
      }),
    );
    await new Promise((r) => queueMicrotask(r));
    stop();
    expect(seen).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Nexus source
// ---------------------------------------------------------------------------

describe("nexus source — corner cases", () => {
  function fakeUpstream(): {
    readonly listenerRef: { current: ((event: unknown) => void) | undefined };
    readonly subscribe: (
      _channels: readonly string[] | undefined,
      next: (event: unknown) => void,
    ) => () => void;
  } {
    const ref: { current: ((event: unknown) => void) | undefined } = { current: undefined };
    return {
      listenerRef: ref,
      subscribe: (_channels, next) => {
        ref.current = next;
        return () => {
          ref.current = undefined;
        };
      },
    };
  }

  test("rename with from === to still emits a rename signal", async () => {
    const { listenerRef, subscribe } = fakeUpstream();
    const seen: SystemSignal[] = [];
    const stop = createNexusSignalSource({ subscribe }).watch((s) => seen.push(s));

    listenerRef.current?.({
      channel: "vfs",
      event: "rename",
      from: "/a/b",
      to: "/a/b",
      emittedAt: 7,
    });
    await new Promise((r) => queueMicrotask(r));
    stop();

    expect(seen).toEqual([
      {
        kind: "vfs",
        event: "rename",
        path: "/a/b",
        from: "/a/b",
        to: "/a/b",
        zoneId: undefined,
        emittedAt: 7,
      },
    ]);
  });

  test("agent_lifecycle self-loop is rejected by transition validation", async () => {
    const { listenerRef, subscribe } = fakeUpstream();
    const seen: SystemSignal[] = [];
    const stop = createNexusSignalSource({ subscribe }).watch((s) => seen.push(s));

    listenerRef.current?.({
      channel: "agent",
      event: "transition",
      agentId: "a-1",
      from: "running" satisfies ProcessState,
      to: "running" satisfies ProcessState,
      reason: { kind: "completed" } satisfies TransitionReason,
      generation: 1,
      emittedAt: 1,
    });
    await new Promise((r) => queueMicrotask(r));
    stop();

    expect(seen).toEqual([]);
  });

  test("generation = 0 is accepted (boundary)", async () => {
    const { listenerRef, subscribe } = fakeUpstream();
    const seen: SystemSignal[] = [];
    const stop = createNexusSignalSource({ subscribe }).watch((s) => seen.push(s));

    listenerRef.current?.({
      channel: "agent",
      event: "transition",
      agentId: "a-1",
      from: "created" satisfies ProcessState,
      to: "running" satisfies ProcessState,
      reason: { kind: "assembly_complete" } satisfies TransitionReason,
      generation: 0,
      emittedAt: 1,
    });
    await new Promise((r) => queueMicrotask(r));
    stop();

    expect(seen.length).toBe(1);
    expect(seen[0]?.kind).toBe("agent_lifecycle");
  });

  test("listener invoked after unsubscribe does not deliver to handler", async () => {
    const { listenerRef, subscribe } = fakeUpstream();
    const seen: SystemSignal[] = [];
    const stop = createNexusSignalSource({ subscribe }).watch((s) => seen.push(s));

    stop();
    // Race: external producer hasn't observed the unsubscribe yet.
    listenerRef.current?.({
      channel: "vfs",
      event: "write",
      path: "/x",
      emittedAt: 1,
    });
    await new Promise((r) => queueMicrotask(r));

    expect(seen).toEqual([]);
  });

  test("path filter with literal '*' in middle does not match (suffix-only globs)", async () => {
    const { listenerRef, subscribe } = fakeUpstream();
    const seen: SystemSignal[] = [];
    const stop = createNexusSignalSource({
      subscribe,
      pathFilters: ["/workspace/*/docs"],
    }).watch((s) => seen.push(s));

    listenerRef.current?.({
      channel: "vfs",
      event: "write",
      path: "/workspace/team/docs",
      emittedAt: 1,
    });
    await new Promise((r) => queueMicrotask(r));
    stop();

    // Literal `/workspace/*/docs` is treated as an exact match. The path under
    // test does NOT exactly equal that string, so the filter rejects it. This
    // pins the documented semantics ("simple wildcard suffix matching").
    expect(seen).toEqual([]);
  });
});
