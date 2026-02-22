/**
 * Channel adapter contract test suite.
 *
 * Validates that any ChannelAdapter implementation satisfies the L0 contract.
 * Usage: import { testChannelAdapter } from "@koi/test-utils" and call it
 * inside a describe() block with a factory function.
 */

import { expect, test } from "bun:test";
import type { ChannelAdapter, InboundMessage, OutboundMessage } from "@koi/core";

export interface ChannelContractOptions {
  /** Factory that creates a fresh adapter instance for each test. */
  readonly createAdapter: () => ChannelAdapter | Promise<ChannelAdapter>;
  /** Timeout for each test in milliseconds. Defaults to 5_000. */
  readonly timeoutMs?: number;
}

/**
 * Runs the channel adapter contract test suite.
 *
 * Call this inside a `describe()` block. It will register tests that verify
 * the adapter satisfies all L0 contract invariants.
 */
export function testChannelAdapter(options: ChannelContractOptions): void {
  const { createAdapter, timeoutMs = 5_000 } = options;

  test("name is a non-empty string", async () => {
    const adapter = await createAdapter();
    expect(typeof adapter.name).toBe("string");
    expect(adapter.name.length).toBeGreaterThan(0);
  });

  test("capabilities declares all required fields as booleans", async () => {
    const adapter = await createAdapter();
    const caps = adapter.capabilities;
    const requiredFields = [
      "text",
      "images",
      "files",
      "buttons",
      "audio",
      "video",
      "threads",
    ] as const;
    for (const field of requiredFields) {
      expect(typeof caps[field]).toBe("boolean");
    }
  });

  test(
    "connect() resolves without error",
    async () => {
      const adapter = await createAdapter();
      await adapter.connect();
      await adapter.disconnect();
    },
    timeoutMs,
  );

  test(
    "disconnect() resolves without error after connect",
    async () => {
      const adapter = await createAdapter();
      await adapter.connect();
      await adapter.disconnect();
    },
    timeoutMs,
  );

  test(
    "disconnect() is safe to call without prior connect",
    async () => {
      const adapter = await createAdapter();
      // Should not throw even if not connected
      await adapter.disconnect();
    },
    timeoutMs,
  );

  test(
    "send() resolves without error after connect",
    async () => {
      const adapter = await createAdapter();
      await adapter.connect();
      const message: OutboundMessage = {
        content: [{ kind: "text", text: "Hello from contract test" }],
      };
      await adapter.send(message);
      await adapter.disconnect();
    },
    timeoutMs,
  );

  test(
    "onMessage() returns an unsubscribe function",
    async () => {
      const adapter = await createAdapter();
      const handler = async (_msg: InboundMessage): Promise<void> => {};
      const unsubscribe = adapter.onMessage(handler);
      expect(typeof unsubscribe).toBe("function");
      // Calling unsubscribe should not throw
      unsubscribe();
    },
    timeoutMs,
  );

  test(
    "onMessage() unsubscribe is idempotent",
    async () => {
      const adapter = await createAdapter();
      const handler = async (_msg: InboundMessage): Promise<void> => {};
      const unsubscribe = adapter.onMessage(handler);
      unsubscribe();
      unsubscribe(); // Should not throw on double-call
    },
    timeoutMs,
  );

  test(
    "send() with empty content array does not throw",
    async () => {
      const adapter = await createAdapter();
      await adapter.connect();
      const message: OutboundMessage = { content: [] };
      await adapter.send(message);
      await adapter.disconnect();
    },
    timeoutMs,
  );
}
