/**
 * Error path tests for discordSend().
 *
 * Validates API failure propagation and partial send failure behavior.
 */

import { describe, expect, mock, test } from "bun:test";
import type { DiscordSendTarget } from "./platform-send.js";
import { discordSend } from "./platform-send.js";

function makeGetChannel(
  channel: DiscordSendTarget,
): (threadId: string) => DiscordSendTarget | undefined {
  return () => channel;
}

describe("discordSend — error paths", () => {
  test("propagates channel.send API error", async () => {
    const channel: DiscordSendTarget = {
      send: mock(async () => {
        throw new Error("Missing Permissions");
      }),
      sendTyping: mock(async () => {}),
    };

    await expect(
      discordSend(makeGetChannel(channel), {
        content: [{ kind: "text", text: "hello" }],
        threadId: "g1:c1",
      }),
    ).rejects.toThrow("Missing Permissions");
  });

  test("propagates network error on send", async () => {
    const channel: DiscordSendTarget = {
      send: mock(async () => {
        throw new TypeError("fetch failed");
      }),
      sendTyping: mock(async () => {}),
    };

    await expect(
      discordSend(makeGetChannel(channel), {
        content: [{ kind: "text", text: "hello" }],
        threadId: "g1:c1",
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test("fails on second send when first succeeds (overflow text)", async () => {
    // let justified: tracks call count
    let callCount = 0;
    const channel: DiscordSendTarget = {
      send: mock(async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error("Unknown Message");
        }
        return {};
      }),
      sendTyping: mock(async () => {}),
    };

    // Long text that splits into 2+ payloads
    const longText = "x".repeat(3000);
    await expect(
      discordSend(makeGetChannel(channel), {
        content: [{ kind: "text", text: longText }],
        threadId: "g1:c1",
      }),
    ).rejects.toThrow("Unknown Message");
    expect(callCount).toBe(2);
  });
});
