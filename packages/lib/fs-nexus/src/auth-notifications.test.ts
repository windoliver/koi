/**
 * Unit tests for createAuthNotificationHandler.
 *
 * Verifies that:
 *  - auth_required routes to oauthChannel.onAuthRequired (not channel.send)
 *  - auth_progress still routes to channel.send (nexus-specific keepalive)
 *  - auth_complete routes to oauthChannel.onAuthComplete (not channel.send)
 *  - errors from oauthChannel callbacks are swallowed
 */

import { describe, expect, mock, test } from "bun:test";
import type { AuthCompleteNotification, AuthRequiredNotification, ChannelAdapter } from "@koi/core";
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
    capabilities: {
      text: true,
      images: false,
      files: false,
      buttons: false,
      audio: false,
      video: false,
      threads: false,
      supportsA2ui: false,
    } as const,
    name: "test-channel",
  };
  return { channel, sent };
}

function makeOAuthChannel() {
  const oauthChannel = {
    onAuthRequired: mock(async (_n: AuthRequiredNotification) => {}),
    onAuthComplete: mock(async (_n: AuthCompleteNotification) => {}),
    submitAuthCode: mock((_url: string) => {}),
  };
  return { oauthChannel };
}

describe("createAuthNotificationHandler", () => {
  test("auth_required — calls oauthChannel.onAuthRequired with correct fields", async () => {
    const { oauthChannel } = makeOAuthChannel();
    const { channel, sent } = makeChannel();
    const handler = createAuthNotificationHandler(
      oauthChannel,
      channel as unknown as ChannelAdapter,
    );

    const n: BridgeNotification = {
      jsonrpc: "2.0",
      method: "auth_required",
      params: {
        provider: "google-drive",
        user_email: "user@example.com",
        auth_url: "https://accounts.google.com/auth?test=1",
        message: "Authorize Google Drive to continue",
        mode: "local",
      },
    };

    handler(n);
    // Fire-and-forget — wait one microtask for the void promise to settle
    await new Promise<void>((r) => setTimeout(r, 0));

    expect(oauthChannel.onAuthRequired).toHaveBeenCalledTimes(1);
    const arg = oauthChannel.onAuthRequired.mock.calls[0]?.[0];
    expect(arg?.provider).toBe("google-drive");
    expect(arg?.authUrl).toBe("https://accounts.google.com/auth?test=1");
    expect(arg?.message).toBe("Authorize Google Drive to continue");
    expect(arg?.mode).toBe("local");
    // channel.send must NOT be called — text formatting moves to CLI's OAuthChannel impl
    expect(sent).toHaveLength(0);
  });

  test("auth_required — maps auth_url to authUrl in notification", async () => {
    const { oauthChannel } = makeOAuthChannel();
    const { channel } = makeChannel();
    const handler = createAuthNotificationHandler(
      oauthChannel,
      channel as unknown as ChannelAdapter,
    );

    const n: BridgeNotification = {
      jsonrpc: "2.0",
      method: "auth_required",
      params: {
        provider: "dropbox",
        user_email: "user@example.com",
        auth_url: "https://dropbox.com/oauth2/authorize?client_id=abc",
        message: "Authorize Dropbox",
        mode: "local",
      },
    };

    handler(n);
    await new Promise<void>((r) => setTimeout(r, 0));

    const arg = oauthChannel.onAuthRequired.mock.calls[0]?.[0];
    // auth_url (snake_case from bridge) must be mapped to authUrl (camelCase)
    expect(arg?.authUrl).toBe("https://dropbox.com/oauth2/authorize?client_id=abc");
  });

  test("auth_required — passes instructions when present", async () => {
    const { oauthChannel } = makeOAuthChannel();
    const { channel } = makeChannel();
    const handler = createAuthNotificationHandler(
      oauthChannel,
      channel as unknown as ChannelAdapter,
    );

    const n: BridgeNotification = {
      jsonrpc: "2.0",
      method: "auth_required",
      params: {
        provider: "google-drive",
        user_email: "user@example.com",
        auth_url: "https://accounts.google.com/auth",
        message: "Authorize",
        mode: "remote",
        instructions: "Paste the redirect URL back here",
      },
    };

    handler(n);
    await new Promise<void>((r) => setTimeout(r, 0));

    const arg = oauthChannel.onAuthRequired.mock.calls[0]?.[0];
    expect(arg?.instructions).toBe("Paste the redirect URL back here");
    expect(arg?.mode).toBe("remote");
  });

  test("auth_progress — sends waiting message with elapsed time via channel.send", async () => {
    const { oauthChannel } = makeOAuthChannel();
    const { channel, sent } = makeChannel();
    const handler = createAuthNotificationHandler(
      oauthChannel,
      channel as unknown as ChannelAdapter,
    );

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
    // oauthChannel must NOT be called for progress events
    expect(oauthChannel.onAuthRequired).not.toHaveBeenCalled();
    expect(oauthChannel.onAuthComplete).not.toHaveBeenCalled();
  });

  test("auth_complete — calls oauthChannel.onAuthComplete with provider", async () => {
    const { oauthChannel } = makeOAuthChannel();
    const { channel, sent } = makeChannel();
    const handler = createAuthNotificationHandler(
      oauthChannel,
      channel as unknown as ChannelAdapter,
    );

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

    expect(oauthChannel.onAuthComplete).toHaveBeenCalledTimes(1);
    const arg = oauthChannel.onAuthComplete.mock.calls[0]?.[0];
    expect(arg?.provider).toBe("google-drive");
    // channel.send must NOT be called
    expect(sent).toHaveLength(0);
  });

  test("oauthChannel.onAuthRequired error is swallowed — does not throw", async () => {
    const { oauthChannel } = makeOAuthChannel();
    // Override onAuthRequired to throw
    oauthChannel.onAuthRequired = mock(async (_n: AuthRequiredNotification) => {
      throw new Error("onAuthRequired failed");
    });
    const { channel } = makeChannel();
    const handler = createAuthNotificationHandler(
      oauthChannel,
      channel as unknown as ChannelAdapter,
    );

    const n: BridgeNotification = {
      jsonrpc: "2.0",
      method: "auth_required",
      params: {
        provider: "google-drive",
        user_email: "",
        auth_url: "https://accounts.google.com/auth",
        message: "Authorize",
        mode: "local",
      },
    };

    // Must not throw
    expect(() => handler(n)).not.toThrow();
    // Wait for the promise to settle (even though it errors)
    await new Promise<void>((r) => setTimeout(r, 10));
  });

  test("auth_complete — oauthChannel error is swallowed — does not throw", async () => {
    const { oauthChannel } = makeOAuthChannel();
    oauthChannel.onAuthComplete = mock(async (_n: AuthCompleteNotification) => {
      throw new Error("onAuthComplete failed");
    });
    const { channel } = makeChannel();
    const handler = createAuthNotificationHandler(
      oauthChannel,
      channel as unknown as ChannelAdapter,
    );

    const n: BridgeNotification = {
      jsonrpc: "2.0",
      method: "auth_complete",
      params: {
        provider: "google-drive",
        user_email: "",
      },
    };

    expect(() => handler(n)).not.toThrow();
    await new Promise<void>((r) => setTimeout(r, 10));
    // Confirm the callback was actually invoked (test would pass vacuously if branch was removed)
    expect(oauthChannel.onAuthComplete).toHaveBeenCalledTimes(1);
  });

  test("pre-authed — zero send() and oauthChannel calls when no notifications arrive", async () => {
    const { oauthChannel } = makeOAuthChannel();
    const { channel, sent } = makeChannel();
    createAuthNotificationHandler(oauthChannel, channel as unknown as ChannelAdapter);
    // Handler created but no notifications fired
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(0);
    expect(oauthChannel.onAuthRequired).not.toHaveBeenCalled();
    expect(oauthChannel.onAuthComplete).not.toHaveBeenCalled();
  });

  test("auth_required — unparseable auth_url logged with placeholder (covers redactUrl catch)", async () => {
    const { oauthChannel } = makeOAuthChannel();
    // Make onAuthRequired throw so the error logger (which calls redactUrl) runs
    oauthChannel.onAuthRequired = mock(async (_n: AuthRequiredNotification) => {
      throw new Error("boom");
    });
    const { channel } = makeChannel();
    const handler = createAuthNotificationHandler(
      oauthChannel,
      channel as unknown as ChannelAdapter,
    );

    const n: BridgeNotification = {
      jsonrpc: "2.0",
      method: "auth_required",
      params: {
        provider: "test-provider",
        user_email: "",
        // Not a valid URL — triggers the catch branch in redactUrl
        auth_url: "not a valid url ://",
        message: "Authorize",
        mode: "local",
      },
    };

    expect(() => handler(n)).not.toThrow();
    await new Promise<void>((r) => setTimeout(r, 10));
    // onAuthRequired was called (and threw); error was swallowed
    expect(oauthChannel.onAuthRequired).toHaveBeenCalledTimes(1);
  });

  test("auth_required error swallowed after dispose — active=false branch", async () => {
    const { oauthChannel } = makeOAuthChannel();
    // Never resolves, so the settled callback runs after dispose()
    let rejectFn!: (e: unknown) => void;
    oauthChannel.onAuthRequired = mock(
      () =>
        new Promise<void>((_res, rej) => {
          rejectFn = rej;
        }),
    );
    const { channel } = makeChannel();
    const handler = createAuthNotificationHandler(
      oauthChannel,
      channel as unknown as ChannelAdapter,
    );

    const n: BridgeNotification = {
      jsonrpc: "2.0",
      method: "auth_required",
      params: {
        provider: "google-drive",
        user_email: "",
        auth_url: "https://accounts.google.com/auth",
        message: "Authorize",
        mode: "local",
      },
    };

    handler(n);
    // Dispose before the promise settles — active becomes false
    handler.dispose();
    // Now reject: the catch guard sees !active and returns early (no console.error)
    rejectFn(new Error("late error"));
    await new Promise<void>((r) => setTimeout(r, 10));
    // No throw from the handler or dispose
  });

  test("auth_progress — channel.send() failure is swallowed", async () => {
    const { oauthChannel } = makeOAuthChannel();
    const { channel } = makeChannel(async () => {
      throw new Error("send failed during progress");
    });
    const handler = createAuthNotificationHandler(
      oauthChannel,
      channel as unknown as ChannelAdapter,
    );

    const n: BridgeNotification = {
      jsonrpc: "2.0",
      method: "auth_progress",
      params: {
        provider: "google-drive",
        elapsed_seconds: 10,
        message: "Still waiting...",
      },
    };

    expect(() => handler(n)).not.toThrow();
    await new Promise<void>((r) => setTimeout(r, 10));
    // channel.send was called once and its error was swallowed
    expect(channel.send).toHaveBeenCalledTimes(1);
  });
});
