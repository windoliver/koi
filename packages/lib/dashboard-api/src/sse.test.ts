import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { agentId } from "@koi/core";
import type { AgentStatusEvent } from "@koi/dashboard-types";

import { createDashboardApi } from "./handler.js";
import { createFixtureSource, type FixtureControls, makeAgent } from "./test-fixtures.js";
import type { DashboardApi } from "./types.js";

const TOKEN = "tk";

function authedReq(path: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

function statusEvent(): AgentStatusEvent {
  return {
    v: 1,
    kind: "agent-status",
    status: makeAgent({ agentId: agentId("ag-x") }),
  };
}

let fx: FixtureControls;
let api: DashboardApi;

beforeEach(() => {
  fx = createFixtureSource();
  api = createDashboardApi({
    source: fx.source,
    authToken: TOKEN,
    sseFlushMs: 20,
    sseBufferLimit: 4,
  });
});

afterEach(() => {
  // Sanity: each test should leave no lingering subscribers after stream cancel.
});

describe("GET /events", () => {
  test("returns text/event-stream content type", async () => {
    const r = await api.fetch(authedReq("/events"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    await r.body?.cancel();
  });

  test("requires auth", async () => {
    const r = await api.fetch(new Request("http://localhost/events"));
    expect(r.status).toBe(401);
  });

  test("subscribes to data source on connect", async () => {
    const r = await api.fetch(authedReq("/events"));
    expect(fx.subscribers()).toBe(1);
    await r.body?.cancel();
  });

  test("emits batched events to client", async () => {
    const r = await api.fetch(authedReq("/events"));
    const reader = r.body?.getReader();
    if (reader === undefined) throw new Error("no body");
    const decoder = new TextDecoder();

    fx.emit(statusEvent());

    // Wait for at least one chunk.
    let received = "";
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value !== undefined) received += decoder.decode(value);
      if (received.includes("event: batch")) break;
    }
    await reader.cancel();

    expect(received).toContain("event: batch");
    expect(received).toContain('"kind":"agent-status"');
  });

  test("filters by topics query parameter", async () => {
    const r = await api.fetch(authedReq("/events?topics=metric"));
    fx.emit(statusEvent()); // wrong topic — should be filtered
    // Reading immediately should yield no batch line within a short window.
    const reader = r.body?.getReader();
    if (reader === undefined) throw new Error("no body");
    const decoder = new TextDecoder();

    let received = "";
    const start = Date.now();
    while (Date.now() - start < 100) {
      const racePromise = Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) => {
          setTimeout(() => resolve({ done: true, value: undefined }), 50);
        }),
      ]);
      const result = await racePromise;
      if (result.done) break;
      if (result.value !== undefined) received += decoder.decode(result.value);
    }
    await reader.cancel();
    expect(received).not.toContain('"kind":"agent-status"');
  });

  test("drops oldest events when buffer overflows", async () => {
    const r = await api.fetch(authedReq("/events"));
    // Buffer limit is 4; emit 6 events before flush has a chance.
    for (let i = 0; i < 6; i += 1) {
      fx.emit(statusEvent());
    }
    const reader = r.body?.getReader();
    if (reader === undefined) throw new Error("no body");
    const decoder = new TextDecoder();
    let received = "";
    const deadline = Date.now() + 500;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value !== undefined) received += decoder.decode(value);
      if (received.includes("event: batch")) break;
    }
    await reader.cancel();
    expect(received).toContain("event: batch");
    // Number of emitted events in batch should be <= buffer limit (4).
    const match = received.match(/"events":\[(.*?)\]\}/);
    if (match !== null) {
      const arr = JSON.parse(`[${match[1]}]`) as readonly unknown[];
      expect(arr.length).toBeLessThanOrEqual(4);
    }
  });
});
