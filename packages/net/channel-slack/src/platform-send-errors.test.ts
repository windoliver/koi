/**
 * Error path tests for slackSend().
 *
 * Validates that API failures propagate correctly and that partial
 * send failures (multi-payload messages) don't swallow errors.
 */

import { describe, expect, mock, test } from "bun:test";
import type { OutboundMessage } from "@koi/core";
import type { SlackWebApi } from "./platform-send.js";
import { slackSend } from "./platform-send.js";

function msg(content: OutboundMessage["content"], threadId: string): OutboundMessage {
  return { content, threadId };
}

describe("slackSend — error paths", () => {
  test("propagates postMessage API error with original cause", async () => {
    const apiError = new Error("channel_not_found");
    const api: SlackWebApi = {
      postMessage: mock(async () => {
        throw apiError;
      }),
    };

    await expect(
      slackSend(api, msg([{ kind: "text", text: "hello" }], "C_INVALID")),
    ).rejects.toThrow("channel_not_found");
  });

  test("propagates network error on postMessage", async () => {
    const api: SlackWebApi = {
      postMessage: mock(async () => {
        throw new TypeError("fetch failed");
      }),
    };

    await expect(
      slackSend(api, msg([{ kind: "text", text: "hello" }], "C456")),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test("fails on second payload when first succeeds (partial failure)", async () => {
    // let justified: tracks call count for conditional failure
    let callCount = 0;
    const api: SlackWebApi = {
      postMessage: mock(async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error("rate_limited");
        }
        return { ok: true };
      }),
    };

    // 6 buttons → 2 payloads (5 + 1), second payload fails
    const buttons = Array.from({ length: 6 }, (_, i) => ({
      kind: "button" as const,
      label: `btn${i}`,
      action: `action${i}`,
    }));

    await expect(slackSend(api, msg(buttons, "C456"))).rejects.toThrow("rate_limited");
    expect(callCount).toBe(2);
  });
});
