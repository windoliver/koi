/**
 * Tests for the outbound request tracker.
 */

import { describe, expect, test } from "bun:test";
import type { AcpTransport } from "@koi/acp-protocol";
import { createRequestTracker } from "./request-tracker.js";

function createMockTransport(): AcpTransport & { readonly sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    send(messageJson: string): void {
      sent.push(messageJson);
    },
    receive(): AsyncIterable<never> {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return { done: true as const, value: undefined as never };
            },
          };
        },
      };
    },
    close(): void {},
  };
}

describe("createRequestTracker", () => {
  test("sendRequest sends a JSON-RPC request and returns a promise", async () => {
    const transport = createMockTransport();
    const tracker = createRequestTracker(transport);

    const promise = tracker.sendRequest("test/method", { key: "value" }, 5000);
    expect(tracker.pending()).toBe(1);

    // Parse the sent message to get the id
    const sent = JSON.parse(transport.sent[0] as string) as { id: number };
    tracker.resolveResponse(sent.id, { success: true });

    const result = await promise;
    expect(result).toEqual({ success: true });
    expect(tracker.pending()).toBe(0);
  });

  test("resolves matching response by ID", async () => {
    const transport = createMockTransport();
    const tracker = createRequestTracker(transport);

    const p1 = tracker.sendRequest("m1", {}, 5000);
    const p2 = tracker.sendRequest("m2", {}, 5000);

    const id1 = (JSON.parse(transport.sent[0] as string) as { id: number }).id;
    const id2 = (JSON.parse(transport.sent[1] as string) as { id: number }).id;

    tracker.resolveResponse(id2, "second");
    tracker.resolveResponse(id1, "first");

    expect(await p1).toBe("first");
    expect(await p2).toBe("second");
  });

  test("rejectResponse rejects the matching pending request", async () => {
    const transport = createMockTransport();
    const tracker = createRequestTracker(transport);

    const promise = tracker.sendRequest("test", {}, 5000);
    const id = (JSON.parse(transport.sent[0] as string) as { id: number }).id;

    tracker.rejectResponse(id, { code: -32600, message: "Bad request" });

    await expect(promise).rejects.toThrow("RPC error (-32600)");
    expect(tracker.pending()).toBe(0);
  });

  test("timeout rejects the request", async () => {
    const transport = createMockTransport();
    const tracker = createRequestTracker(transport);

    const promise = tracker.sendRequest("slow", {}, 50); // 50ms timeout

    await expect(promise).rejects.toThrow("timed out");
    expect(tracker.pending()).toBe(0);
  });

  test("rejectAll rejects all pending requests", async () => {
    const transport = createMockTransport();
    const tracker = createRequestTracker(transport);

    const p1 = tracker.sendRequest("m1", {}, 5000);
    const p2 = tracker.sendRequest("m2", {}, 5000);

    tracker.rejectAll("Shutting down");

    await expect(p1).rejects.toThrow("Shutting down");
    await expect(p2).rejects.toThrow("Shutting down");
    expect(tracker.pending()).toBe(0);
  });

  test("ignores resolveResponse for unknown IDs", () => {
    const transport = createMockTransport();
    const tracker = createRequestTracker(transport);

    // Should not throw
    tracker.resolveResponse(999, "no-match");
    expect(tracker.pending()).toBe(0);
  });

  test("ignores resolveResponse for null ID", () => {
    const transport = createMockTransport();
    const tracker = createRequestTracker(transport);

    tracker.resolveResponse(null, "ignored");
    expect(tracker.pending()).toBe(0);
  });
});
