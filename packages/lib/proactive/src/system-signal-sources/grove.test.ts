import { describe, expect, mock, test } from "bun:test";
import type { SystemSignal } from "@koi/core";
import {
  createClosedAwareGroveHandler,
  createGroveSignalSource,
  type GroveEventSourceLike,
  shouldAcceptGroveFrontierEvent,
} from "./grove.js";

describe("createGroveSignalSource", () => {
  test("uses groveUrl as the transport target passed to the event source factory", () => {
    let targetUrl: string | undefined;
    const source = createGroveSignalSource({
      groveUrl: "http://localhost:4515",
      eventSourceFactory: (url) => {
        targetUrl = url;
        return {
          close() {},
          onmessage: null,
          onerror: null,
        };
      },
    });

    const stop = source.watch(() => {});
    stop();

    expect(targetUrl).toBe("http://localhost:4515");
  });

  test("emits a frontier signal when an accepted frontier_changed event arrives", async () => {
    let onMessage: ((event: MessageEvent<string>) => void) | undefined;
    const source = createGroveSignalSource({
      groveUrl: "http://localhost:4515",
      now: () => 4242,
      eventSourceFactory: () =>
        ({
          close() {},
          set onmessage(fn: GroveEventSourceLike["onmessage"]) {
            onMessage = fn ?? undefined;
          },
          set onerror(_fn: GroveEventSourceLike["onerror"]) {},
        }) satisfies GroveEventSourceLike,
    });

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal));
    onMessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "frontier_changed",
          metric: "retrieval_quality",
          improvement: 0.22,
        }),
      }),
    );
    await new Promise((resolve) => queueMicrotask(resolve));
    stop();

    expect(seen).toEqual([
      {
        kind: "frontier",
        metric: "retrieval_quality",
        improvement: 0.22,
        emittedAt: 4242,
      },
    ]);
  });

  test("uses upstream emittedAt when supplied", async () => {
    let onMessage: ((event: MessageEvent<string>) => void) | undefined;
    const source = createGroveSignalSource({
      groveUrl: "http://localhost:4515",
      now: () => 9999,
      eventSourceFactory: () =>
        ({
          close() {},
          set onmessage(fn: GroveEventSourceLike["onmessage"]) {
            onMessage = fn ?? undefined;
          },
          set onerror(_fn: GroveEventSourceLike["onerror"]) {},
        }) satisfies GroveEventSourceLike,
    });

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal));
    onMessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "frontier_changed",
          metric: "retrieval_quality",
          improvement: 0.22,
          emittedAt: 1700,
        }),
      }),
    );
    await new Promise((resolve) => queueMicrotask(resolve));
    stop();

    expect(seen[0]).toEqual({
      kind: "frontier",
      metric: "retrieval_quality",
      improvement: 0.22,
      emittedAt: 1700,
    });
  });

  test("does not emit when minImprovement filter rejects the event", async () => {
    let onMessage: ((event: MessageEvent<string>) => void) | undefined;
    const source = createGroveSignalSource({
      groveUrl: "http://localhost:4515",
      minImprovement: 0.5,
      eventSourceFactory: () =>
        ({
          close() {},
          set onmessage(fn: GroveEventSourceLike["onmessage"]) {
            onMessage = fn ?? undefined;
          },
          set onerror(_fn: GroveEventSourceLike["onerror"]) {},
        }) satisfies GroveEventSourceLike,
    });

    const seen: SystemSignal[] = [];
    const stop = source.watch((signal) => seen.push(signal));
    onMessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "frontier_changed",
          metric: "retrieval_quality",
          improvement: 0.1,
        }),
      }),
    );
    await new Promise((resolve) => queueMicrotask(resolve));
    stop();

    expect(seen).toEqual([]);
  });

  test("routes malformed payloads to onError", async () => {
    let onMessage: ((event: MessageEvent<string>) => void) | undefined;
    const source = createGroveSignalSource({
      groveUrl: "http://localhost:4515",
      eventSourceFactory: () =>
        ({
          close() {},
          set onmessage(fn: GroveEventSourceLike["onmessage"]) {
            onMessage = fn ?? undefined;
          },
          set onerror(_fn: GroveEventSourceLike["onerror"]) {},
        }) satisfies GroveEventSourceLike,
    });

    const onError = mock(() => {});
    const stop = source.watch(() => {}, { onError });
    onMessage?.(new MessageEvent("message", { data: "not json" }));
    await new Promise((resolve) => queueMicrotask(resolve));
    stop();

    expect(onError).toHaveBeenCalledTimes(1);
  });

  test("filters frontier updates below the configured minImprovement", async () => {
    expect(
      shouldAcceptGroveFrontierEvent("retrieval_quality", 0.22, {
        minImprovement: 0.5,
      }),
    ).toBe(false);
    expect(
      shouldAcceptGroveFrontierEvent("retrieval_quality", 0.5, {
        minImprovement: 0.5,
      }),
    ).toBe(true);
  });

  test("rejects non-finite frontier improvement values", () => {
    expect(
      shouldAcceptGroveFrontierEvent("retrieval_quality", Number.NaN, {
        minImprovement: 0.5,
      }),
    ).toBe(false);
    expect(
      shouldAcceptGroveFrontierEvent("retrieval_quality", Number.POSITIVE_INFINITY, {
        minImprovement: 0.5,
      }),
    ).toBe(false);
  });

  test("closed-aware grove handler suppresses buffered delivery after unsubscribe", () => {
    const seen: string[] = [];
    let closed = false;
    const handler = createClosedAwareGroveHandler(
      (value: string) => seen.push(value),
      () => closed,
    );

    closed = true;
    handler("ignored");
    closed = false;
    handler("delivered");

    expect(seen).toEqual(["delivered"]);
  });

  test("stop prevents buffered grove callbacks from reaching subscribers", async () => {
    let onMessage: ((event: MessageEvent<string>) => void) | undefined;
    let onErrorEvent: ((event: unknown) => void) | undefined;
    const source = createGroveSignalSource({
      groveUrl: "http://localhost:4515",
      minImprovement: 0.5,
      eventSourceFactory: () =>
        ({
          close() {},
          set onmessage(fn: GroveEventSourceLike["onmessage"]) {
            onMessage = fn ?? undefined;
          },
          set onerror(fn: GroveEventSourceLike["onerror"]) {
            onErrorEvent = fn ?? undefined;
          },
        }) satisfies GroveEventSourceLike,
    });

    const onError = mock(() => {});
    const stop = source.watch(() => {}, { onError });
    stop();

    onMessage?.(new MessageEvent("message", { data: "not json" }));
    onErrorEvent?.(new Error("socket dropped"));
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(onError).toHaveBeenCalledTimes(0);
  });

  test("forwards upstream errors and disconnects cleanly", () => {
    let onErrorEvent: ((event: unknown) => void) | undefined;
    let closed = 0;
    const source = createGroveSignalSource({
      groveUrl: "http://localhost:4515",
      metrics: ["retrieval_quality"],
      minImprovement: 0.5,
      eventSourceFactory: () =>
        ({
          close() {
            closed += 1;
          },
          set onmessage(_fn: GroveEventSourceLike["onmessage"]) {},
          set onerror(fn: GroveEventSourceLike["onerror"]) {
            onErrorEvent = fn ?? undefined;
          },
        }) satisfies GroveEventSourceLike,
    });

    const onError = mock(() => {});
    const onDisconnect = mock(() => {});
    const stop = source.watch(() => {}, { onError, onDisconnect });

    onErrorEvent?.(new Error("socket dropped"));
    stop();
    stop();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(closed).toBe(1);
  });
});
