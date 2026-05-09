import { describe, expect, mock, test } from "bun:test";
import type { SystemSignal } from "@koi/core";
import { createGroveSignalSource } from "./grove.js";

describe("createGroveSignalSource", () => {
  test("ignores unsupported frontier events instead of inventing signals", async () => {
    let onMessage: ((event: MessageEvent<string>) => void) | undefined;
    const source = createGroveSignalSource({
      groveUrl: "http://localhost:4515",
      eventSourceFactory: () =>
        ({
          close() {},
          set onmessage(fn) {
            onMessage = fn ?? undefined;
          },
          set onerror(_fn) {},
        }) as never,
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

    expect(seen).toEqual([]);
  });

  test("routes malformed payloads to onError", async () => {
    let onMessage: ((event: MessageEvent<string>) => void) | undefined;
    const source = createGroveSignalSource({
      groveUrl: "http://localhost:4515",
      eventSourceFactory: () =>
        ({
          close() {},
          set onmessage(fn) {
            onMessage = fn ?? undefined;
          },
          set onerror(_fn) {},
        }) as never,
    });

    const onError = mock(() => {});
    const stop = source.watch(() => {}, { onError });
    onMessage?.(new MessageEvent("message", { data: "not json" }));
    await new Promise((resolve) => queueMicrotask(resolve));
    stop();

    expect(onError).toHaveBeenCalledTimes(1);
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
          set onmessage(_fn) {},
          set onerror(fn) {
            onErrorEvent = fn ?? undefined;
          },
        }) as never,
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
