import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DashboardDataSource, DashboardEvent } from "@koi/dashboard-types";
import type { SseProducer } from "./producer.js";
import { createSseProducer } from "./producer.js";

type EventListener = (event: DashboardEvent) => void;

function createMockDataSource(): {
  readonly dataSource: DashboardDataSource;
  readonly emit: (event: DashboardEvent) => void;
} {
  let listeners: EventListener[] = [];

  const dataSource: DashboardDataSource = {
    listAgents: () => [],
    getAgent: () => undefined,
    terminateAgent: () => ({ ok: true, value: undefined }),
    listChannels: () => [],
    listSkills: () => [],
    getSystemMetrics: () => ({
      uptimeMs: 1000,
      heapUsedMb: 100,
      heapTotalMb: 512,
      activeAgents: 0,
      totalAgents: 0,
      activeChannels: 0,
    }),
    subscribe: (listener: EventListener) => {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
  };

  const emit = (event: DashboardEvent): void => {
    for (const listener of listeners) {
      listener(event);
    }
  };

  return { dataSource, emit };
}

function makeEvent(subKind: string = "activity"): DashboardEvent {
  return {
    kind: "system",
    subKind: "activity",
    message: `test-${subKind}`,
    timestamp: Date.now(),
  } as DashboardEvent;
}

describe("createSseProducer", () => {
  let producer: SseProducer;
  let emit: (event: DashboardEvent) => void;

  beforeEach(() => {
    const mock = createMockDataSource();
    emit = mock.emit;
    producer = createSseProducer(mock.dataSource, {
      batchIntervalMs: 50,
      maxConnections: 3,
    });
  });

  afterEach(() => {
    producer.dispose();
  });

  test("starts with zero connections", () => {
    expect(producer.connectionCount()).toBe(0);
  });

  test("connect returns SSE response", () => {
    const req = new Request("http://localhost/events");
    const response = producer.connect(req);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(producer.connectionCount()).toBe(1);
  });

  test("enforces max connections with 503", () => {
    for (let i = 0; i < 3; i++) {
      producer.connect(new Request("http://localhost/events"));
    }
    expect(producer.connectionCount()).toBe(3);

    const response = producer.connect(new Request("http://localhost/events"));
    expect(response.status).toBe(503);
  });

  test("batches events and sends to connected clients", async () => {
    const req = new Request("http://localhost/events");
    const response = producer.connect(req);

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) return; // unreachable — satisfies TypeScript
    const decoder = new TextDecoder();

    // First read: initial keepalive
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain(":keepalive");

    // Emit event after connection
    emit(makeEvent());

    // Wait for batch flush (50ms interval + margin)
    await new Promise((resolve) => setTimeout(resolve, 100));

    const second = await reader.read();
    const text = decoder.decode(second.value);
    expect(text).toContain("data:");
    expect(text).toContain('"seq":1');

    reader.releaseLock();
  });

  test("returns 410 after dispose", () => {
    producer.dispose();
    const response = producer.connect(new Request("http://localhost/events"));
    expect(response.status).toBe(410);
  });
});
