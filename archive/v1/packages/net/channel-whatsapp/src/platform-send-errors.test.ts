/**
 * Error path tests for whatsappSend().
 *
 * Validates socket send failures propagate correctly.
 */

import { describe, expect, mock, test } from "bun:test";
import type { WASocketApi } from "./platform-send.js";
import { whatsappSend } from "./platform-send.js";

describe("whatsappSend — error paths", () => {
  test("propagates socket sendMessage error", async () => {
    const socket: WASocketApi = {
      sendMessage: mock(async () => {
        throw new Error("Connection Closed");
      }),
    };

    await expect(
      whatsappSend(socket, {
        content: [{ kind: "text", text: "hello" }],
        threadId: "5511999999999@s.whatsapp.net",
      }),
    ).rejects.toThrow("Connection Closed");
  });

  test("propagates network timeout error", async () => {
    const socket: WASocketApi = {
      sendMessage: mock(async () => {
        throw new Error("Timed out");
      }),
    };

    await expect(
      whatsappSend(socket, {
        content: [{ kind: "text", text: "hello" }],
        threadId: "5511999999999@s.whatsapp.net",
      }),
    ).rejects.toThrow("Timed out");
  });

  test("fails on second chunk when first succeeds (partial failure)", async () => {
    // let justified: tracks call count for conditional failure
    let callCount = 0;
    const socket: WASocketApi = {
      sendMessage: mock(async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error("rate-overlimit");
        }
        return {};
      }),
    };

    await expect(
      whatsappSend(socket, {
        content: [
          { kind: "text", text: "text part" },
          { kind: "image", url: "https://example.com/img.png" },
        ],
        threadId: "5511999999999@s.whatsapp.net",
      }),
    ).rejects.toThrow("rate-overlimit");
    expect(callCount).toBe(2);
  });
});
