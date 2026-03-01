/**
 * Tests for the ACP server approval bridge.
 */

import { describe, expect, test } from "bun:test";
import type { AcpTransport } from "@koi/acp-protocol";
import { createApprovalHandler } from "./approval-bridge.js";
import { createRequestTracker } from "./request-tracker.js";

function createMockTransport(): AcpTransport & {
  readonly sent: string[];
  readonly respondTo: (id: number, result: unknown) => void;
} {
  const sent: string[] = [];
  // let: store tracker reference for responding
  let trackerRef: ReturnType<typeof createRequestTracker> | undefined;

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
    respondTo(id: number, result: unknown): void {
      trackerRef?.resolveResponse(id, result);
    },
    set tracker(t: ReturnType<typeof createRequestTracker>) {
      trackerRef = t;
    },
  } as AcpTransport & {
    readonly sent: string[];
    readonly respondTo: (id: number, result: unknown) => void;
  };
}

describe("createApprovalHandler", () => {
  test("returns allow when IDE selects allow option", async () => {
    const transport = createMockTransport();
    const tracker = createRequestTracker(transport);

    const handler = createApprovalHandler(tracker, () => "sess_1", 5000);

    // Respond to the permission request after a short delay
    const resultPromise = handler({
      toolId: "tool_1",
      input: { path: "/foo.ts" },
      reason: "Write file",
    });

    // Wait for the request to be sent
    await new Promise((r) => setTimeout(r, 10));

    // Parse the sent request to get its ID
    const sent = JSON.parse(transport.sent[0] as string) as { id: number };
    tracker.resolveResponse(sent.id, { outcome: "selected", optionId: "allow" });

    const result = await resultPromise;
    expect(result.kind).toBe("allow");
  });

  test("returns deny when IDE selects deny option", async () => {
    const transport = createMockTransport();
    const tracker = createRequestTracker(transport);

    const handler = createApprovalHandler(tracker, () => "sess_1", 5000);

    const resultPromise = handler({
      toolId: "tool_1",
      input: {},
      reason: "Execute command",
    });

    await new Promise((r) => setTimeout(r, 10));

    const sent = JSON.parse(transport.sent[0] as string) as { id: number };
    tracker.resolveResponse(sent.id, { outcome: "selected", optionId: "deny" });

    const result = await resultPromise;
    expect(result.kind).toBe("deny");
  });

  test("returns deny when IDE cancels", async () => {
    const transport = createMockTransport();
    const tracker = createRequestTracker(transport);

    const handler = createApprovalHandler(tracker, () => "sess_1", 5000);

    const resultPromise = handler({
      toolId: "tool_1",
      input: {},
      reason: "Delete file",
    });

    await new Promise((r) => setTimeout(r, 10));

    const sent = JSON.parse(transport.sent[0] as string) as { id: number };
    tracker.resolveResponse(sent.id, { outcome: "cancelled" });

    const result = await resultPromise;
    expect(result.kind).toBe("deny");
  });

  test("returns deny on timeout (fail-closed)", async () => {
    const transport = createMockTransport();
    const tracker = createRequestTracker(transport);

    // Very short timeout
    const handler = createApprovalHandler(tracker, () => "sess_1", 50);

    const result = await handler({
      toolId: "tool_1",
      input: {},
      reason: "Slow IDE",
    });

    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("failed");
    }
  });

  test("returns deny when no session is active", async () => {
    const transport = createMockTransport();
    const tracker = createRequestTracker(transport);

    const handler = createApprovalHandler(tracker, () => undefined, 5000);

    const result = await handler({
      toolId: "tool_1",
      input: {},
      reason: "No session",
    });

    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("No active ACP session");
    }
  });
});
