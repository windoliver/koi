import { describe, expect, test } from "bun:test";
import type { WsEvent } from "@koi/dashboard-types";
import { openSubscription, type WsLike } from "./subscribe.js";

interface FakeSocket extends WsLike {
  readonly sent: string[];
  closed: boolean;
  fireOpen(): void;
  fireMessage(data: unknown): void;
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
  };
  return socket;
}

describe("openSubscription", () => {
  test("sends a v1 subscribe frame on open", () => {
    const socket = fakeSocket();
    openSubscription(
      () => socket,
      "ws://x",
      ["metric"],
      () => {},
    );
    socket.fireOpen();
    expect(socket.sent).toHaveLength(1);
    const sent = socket.sent[0] ?? "";
    expect(JSON.parse(sent)).toEqual({ v: 1, kind: "subscribe", topics: ["metric"] });
  });

  test("dispatches a typed metric event", () => {
    const socket = fakeSocket();
    const seen: WsEvent[] = [];
    openSubscription(
      () => socket,
      "ws://x",
      ["metric"],
      (e) => seen.push(e),
    );
    socket.fireOpen();
    socket.fireMessage(JSON.stringify({ v: 1, kind: "metric", points: [] }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe("metric");
  });

  test("ignores unknown frames (forward compatibility)", () => {
    const socket = fakeSocket();
    const seen: WsEvent[] = [];
    openSubscription(
      () => socket,
      "ws://x",
      ["metric"],
      (e) => seen.push(e),
    );
    socket.fireOpen();
    socket.fireMessage(JSON.stringify({ v: 2, kind: "future-topic" }));
    socket.fireMessage("not-json");
    expect(seen).toHaveLength(0);
  });

  test("teardown closes the socket immediately when already open", () => {
    const socket = fakeSocket();
    const teardown = openSubscription(
      () => socket,
      "ws://x",
      ["trace"],
      () => {},
    );
    socket.fireOpen();
    teardown();
    expect(socket.closed).toBe(true);
  });

  test("teardown defers close until after open", () => {
    const socket = fakeSocket();
    const teardown = openSubscription(
      () => socket,
      "ws://x",
      ["trace"],
      () => {},
    );
    teardown();
    expect(socket.closed).toBe(false);
    socket.fireOpen();
    expect(socket.closed).toBe(true);
    expect(socket.sent).toHaveLength(0);
  });
});
