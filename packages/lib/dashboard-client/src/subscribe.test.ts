import { describe, expect, test } from "bun:test";
import type { KoiError } from "@koi/core";
import type { WsEvent } from "@koi/dashboard-types";
import { openSubscription, type WsLike } from "./subscribe.js";

interface FakeSocket extends WsLike {
  readonly sent: string[];
  closed: boolean;
  fireOpen(): void;
  fireMessage(data: unknown): void;
  fireClose(): void;
  fireError(cause: unknown): void;
}

function fakeSocket(): FakeSocket {
  const handlers = new Map<string, ((arg: unknown) => void)[]>();
  const sent: string[] = [];
  const socket: FakeSocket = {
    sent,
    closed: false,
    send: (data): void => {
      sent.push(data);
    },
    close: (): void => {
      socket.closed = true;
    },
    addEventListener: ((event: string, handler: (arg: unknown) => void): void => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }) as WsLike["addEventListener"],
    fireOpen: (): void => {
      for (const h of handlers.get("open") ?? []) h(undefined);
    },
    fireMessage: (data): void => {
      for (const h of handlers.get("message") ?? []) h({ data });
    },
    fireClose: (): void => {
      for (const h of handlers.get("close") ?? []) h(undefined);
    },
    fireError: (cause): void => {
      for (const h of handlers.get("error") ?? []) h(cause);
    },
  };
  return socket;
}

describe("openSubscription", () => {
  test("sends a v1 subscribe frame on open", () => {
    const socket = fakeSocket();
    openSubscription(() => socket, "ws://x", ["metric"], { onEvent: () => {} });
    socket.fireOpen();
    expect(socket.sent).toHaveLength(1);
    const sent = socket.sent[0] ?? "";
    expect(JSON.parse(sent)).toEqual({ v: 1, kind: "subscribe", topics: ["metric"] });
  });

  test("dispatches a typed metric event", () => {
    const socket = fakeSocket();
    const seen: WsEvent[] = [];
    openSubscription(() => socket, "ws://x", ["metric"], {
      onEvent: (e) => seen.push(e),
    });
    socket.fireOpen();
    socket.fireMessage(
      JSON.stringify({
        v: 1,
        kind: "metric",
        points: [{ name: "cpu", value: 1, timestampMs: 1 }],
      }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("metric");
  });

  test("ignores unknown and malformed frames (forward compatibility)", () => {
    const socket = fakeSocket();
    const seen: WsEvent[] = [];
    openSubscription(() => socket, "ws://x", ["metric"], {
      onEvent: (e) => seen.push(e),
    });
    socket.fireOpen();
    socket.fireMessage(JSON.stringify({ v: 2, kind: "future-topic" }));
    socket.fireMessage(JSON.stringify({ v: 1, kind: "metric" })); // missing points
    socket.fireMessage("not-json");
    expect(seen).toHaveLength(0);
  });

  test("late frames after unsubscribe are dropped", () => {
    const socket = fakeSocket();
    const seen: WsEvent[] = [];
    const teardown = openSubscription(() => socket, "ws://x", ["metric"], {
      onEvent: (e) => seen.push(e),
    });
    socket.fireOpen();
    teardown();
    socket.fireMessage(
      JSON.stringify({
        v: 1,
        kind: "metric",
        points: [{ name: "cpu", value: 1, timestampMs: 1 }],
      }),
    );
    expect(seen).toHaveLength(0);
  });

  test("frames after onError or onClose are dropped", () => {
    const socket = fakeSocket();
    const seen: WsEvent[] = [];
    openSubscription(() => socket, "ws://x", ["metric"], {
      onEvent: (e) => seen.push(e),
    });
    socket.fireOpen();
    socket.fireError(new Error("dead"));
    socket.fireMessage(
      JSON.stringify({
        v: 1,
        kind: "metric",
        points: [{ name: "cpu", value: 1, timestampMs: 1 }],
      }),
    );
    expect(seen).toHaveLength(0);
  });

  test("teardown closes the socket immediately when already open", () => {
    const socket = fakeSocket();
    const teardown = openSubscription(() => socket, "ws://x", ["trace"], {
      onEvent: () => {},
    });
    socket.fireOpen();
    teardown();
    expect(socket.closed).toBe(true);
  });

  test("teardown defers close until after open", () => {
    const socket = fakeSocket();
    const teardown = openSubscription(() => socket, "ws://x", ["trace"], {
      onEvent: () => {},
    });
    teardown();
    expect(socket.closed).toBe(false);
    socket.fireOpen();
    expect(socket.closed).toBe(true);
    expect(socket.sent).toHaveLength(0);
  });

  test("forwards a retryable EXTERNAL error when the socket errors", () => {
    const socket = fakeSocket();
    const errors: KoiError[] = [];
    openSubscription(() => socket, "ws://x", ["trace"], {
      onEvent: () => {},
      onError: (e) => errors.push(e),
    });
    socket.fireError(new Error("boom"));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("EXTERNAL");
    expect(errors[0]?.retryable).toBe(true);
  });

  test("late error after pre-open teardown is suppressed", () => {
    const socket = fakeSocket();
    let errors = 0;
    let closes = 0;
    const teardown = openSubscription(() => socket, "ws://x", ["trace"], {
      onEvent: () => {},
      onError: () => {
        errors += 1;
      },
      onClose: () => {
        closes += 1;
      },
    });
    teardown();
    socket.fireError(new Error("late handshake failure"));
    socket.fireClose();
    expect(errors).toBe(0);
    expect(closes).toBe(0);
  });

  test("caller teardown does NOT fire onClose (caller already knows)", () => {
    const socket = fakeSocket();
    let closes = 0;
    const teardown = openSubscription(() => socket, "ws://x", ["trace"], {
      onEvent: () => {},
      onClose: () => {
        closes += 1;
      },
    });
    socket.fireOpen();
    teardown();
    socket.fireClose();
    expect(closes).toBe(0);
  });

  test("remote close fires onClose exactly once", () => {
    const socket = fakeSocket();
    let closes = 0;
    openSubscription(() => socket, "ws://x", ["trace"], {
      onEvent: () => {},
      onClose: () => {
        closes += 1;
      },
    });
    socket.fireOpen();
    socket.fireClose();
    socket.fireClose();
    expect(closes).toBe(1);
  });

  test("error and close are mutually terminal — only the first fires", () => {
    const socket = fakeSocket();
    let closes = 0;
    let errors = 0;
    openSubscription(() => socket, "ws://x", ["trace"], {
      onEvent: () => {},
      onError: () => {
        errors += 1;
      },
      onClose: () => {
        closes += 1;
      },
    });
    socket.fireError(new Error("boom"));
    socket.fireClose();
    expect(errors).toBe(1);
    expect(closes).toBe(0);
  });
});
