/**
 * Unit tests for createAuthNotificationHandler.
 *
 * Verifies that each notification method produces the correct channel message
 * and that errors from channel.send() are swallowed.
 */

import { describe, expect, mock, test } from "bun:test";
import { createAuthNotificationHandler } from "./auth-notifications.js";
import type { BridgeNotification } from "./types.js";

function makeChannel(sendImpl?: () => Promise<void>) {
  const sent: Array<{
    readonly content: readonly { readonly kind: string; readonly text: string }[];
  }> = [];
  const channel = {
    send: mock(
      async (msg: {
        readonly content: readonly { readonly kind: string; readonly text: string }[];
      }) => {
        sent.push(msg);
        await (sendImpl?.() ?? Promise.resolve());
      },
    ),
    // ChannelAdapter surface — unused fields stubbed
    connect: mock(async () => {}),
    disconnect: mock(async () => {}),
    onMessage: mock(() => () => {}),
    capabilities: { streaming: false as const },
    name: "test-channel",
  };
  return { channel, sent };
}

describe("createAuthNotificationHandler", () => {
  test("auth_required — sends message with auth URL", async () => {
    const { channel, sent } = makeChannel();
    const handler = createAuthNotificationHandler(channel as never);

    const n: BridgeNotification = {
      jsonrpc: "2.0",
      method: "auth_required",
      params: {
        provider: "google-drive",
        user_email: "user@example.com",
        auth_url: "https://accounts.google.com/auth?test=1",
        message: "Authorize Google Drive to continue",
      },
    };

    handler(n);
    // Fire-and-forget — wait one microtask for the void promise to settle
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(sent).toHaveLength(1);
    const text = sent[0]?.content[0]?.text ?? "";
    expect(text).toContain("Authorize Google Drive to continue");
    expect(text).toContain("https://accounts.google.com/auth?test=1");
    expect(text).toContain("google-drive");
  });

  test("auth_progress — sends waiting message with elapsed time", async () => {
    const { channel, sent } = makeChannel();
    const handler = createAuthNotificationHandler(channel as never);

    const n: BridgeNotification = {
      jsonrpc: "2.0",
      method: "auth_progress",
      params: {
        provider: "google-drive",
        elapsed_seconds: 30,
        message: "Still waiting for google-drive authorization...",
      },
    };

    handler(n);
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(sent).toHaveLength(1);
    const text = sent[0]?.content[0]?.text ?? "";
    expect(text).toContain("30s elapsed");
    expect(text).toContain("Still waiting");
  });

  test("auth_complete — sends completion message", async () => {
    const { channel, sent } = makeChannel();
    const handler = createAuthNotificationHandler(channel as never);

    const n: BridgeNotification = {
      jsonrpc: "2.0",
      method: "auth_complete",
      params: {
        provider: "google-drive",
        user_email: "user@example.com",
      },
    };

    handler(n);
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(sent).toHaveLength(1);
    const text = sent[0]?.content[0]?.text ?? "";
    expect(text).toContain("google-drive");
    expect(text).toContain("complete");
  });

  test("channel.send() error is swallowed — does not throw", async () => {
    const { channel } = makeChannel(async () => {
      throw new Error("channel send failed");
    });
    const handler = createAuthNotificationHandler(channel as never);

    const n: BridgeNotification = {
      jsonrpc: "2.0",
      method: "auth_required",
      params: {
        provider: "google-drive",
        user_email: "",
        auth_url: "https://accounts.google.com/auth",
        message: "Authorize",
      },
    };

    // Must not throw
    expect(() => handler(n)).not.toThrow();
    // Wait for the promise to settle (even though it errors)
    await new Promise<void>((r) => setTimeout(r, 10));
  });

  test("pre-authed — zero send() calls when no notifications arrive", async () => {
    const { channel, sent } = makeChannel();
    createAuthNotificationHandler(channel as never);
    // Handler created but no notifications fired
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(0);
  });
});
