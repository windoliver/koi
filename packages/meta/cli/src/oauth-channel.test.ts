import { describe, expect, mock, test } from "bun:test";
import type { ChannelAdapter } from "@koi/core";
import { createOAuthChannel } from "./oauth-channel.js";

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

describe("createOAuthChannel", () => {
  describe("onAuthRequired", () => {
    test("sends formatted message with URL when authUrl is present", async () => {
      const { channel, sent } = makeChannel();
      const oauthChannel = createOAuthChannel({
        channel: channel as unknown as ChannelAdapter,
      });

      await oauthChannel.onAuthRequired({
        provider: "google-drive",
        authUrl: "https://accounts.google.com/auth?test=1",
        message: "Authorize Google Drive to continue",
        mode: "local",
      });
      await new Promise<void>((r) => setTimeout(r, 0));

      expect(sent).toHaveLength(1);
      const text = sent[0]?.content[0]?.text ?? "";
      expect(text).toContain("Authorize Google Drive to continue");
      expect(text).toContain("google-drive");
      expect(text).toContain("https://accounts.google.com/auth?test=1");
    });

    test("sends message without URL line when authUrl is absent (MCP local mode)", async () => {
      const { channel, sent } = makeChannel();
      const oauthChannel = createOAuthChannel({
        channel: channel as unknown as ChannelAdapter,
      });

      await oauthChannel.onAuthRequired({
        provider: "github",
        message: "Authorization required",
        mode: "local",
      });
      await new Promise<void>((r) => setTimeout(r, 0));

      expect(sent).toHaveLength(1);
      const text = sent[0]?.content[0]?.text ?? "";
      expect(text).toBe("**Authorization required**");
      expect(text).not.toContain("browser");
      expect(text).not.toContain("http");
    });

    test("appends remoteHint when mode=remote and instructions is defined", async () => {
      const { channel, sent } = makeChannel();
      const oauthChannel = createOAuthChannel({
        channel: channel as unknown as ChannelAdapter,
      });

      await oauthChannel.onAuthRequired({
        provider: "dropbox",
        authUrl: "https://dropbox.com/oauth2/authorize",
        message: "Authorize Dropbox",
        mode: "remote",
        instructions: "Paste the redirect URL back here",
      });
      await new Promise<void>((r) => setTimeout(r, 0));

      expect(sent).toHaveLength(1);
      const text = sent[0]?.content[0]?.text ?? "";
      expect(text).toContain("_Paste the redirect URL back here_");
    });

    test("does not append remoteHint when mode=remote but instructions is absent", async () => {
      const { channel, sent } = makeChannel();
      const oauthChannel = createOAuthChannel({
        channel: channel as unknown as ChannelAdapter,
      });

      await oauthChannel.onAuthRequired({
        provider: "dropbox",
        authUrl: "https://dropbox.com/oauth2/authorize",
        message: "Authorize Dropbox",
        mode: "remote",
      });
      await new Promise<void>((r) => setTimeout(r, 0));

      expect(sent).toHaveLength(1);
      const text = sent[0]?.content[0]?.text ?? "";
      expect(text).not.toContain("_");
    });

    test("channel.send() error is swallowed — does not throw", async () => {
      const { channel } = makeChannel(async () => {
        throw new Error("send failed");
      });
      const oauthChannel = createOAuthChannel({
        channel: channel as unknown as ChannelAdapter,
      });

      expect(() =>
        oauthChannel.onAuthRequired({
          provider: "google-drive",
          authUrl: "https://accounts.google.com/auth",
          message: "Authorize",
          mode: "local",
        }),
      ).not.toThrow();
      await new Promise<void>((r) => setTimeout(r, 10));
      // send was called — error was swallowed
      expect(channel.send).toHaveBeenCalledTimes(1);
    });
  });

  describe("onAuthComplete", () => {
    test("sends authorization complete message containing provider", async () => {
      const { channel, sent } = makeChannel();
      const oauthChannel = createOAuthChannel({
        channel: channel as unknown as ChannelAdapter,
      });

      await oauthChannel.onAuthComplete({ provider: "google-drive" });
      await new Promise<void>((r) => setTimeout(r, 0));

      expect(sent).toHaveLength(1);
      const text = sent[0]?.content[0]?.text ?? "";
      expect(text).toContain("google-drive");
      expect(text).toContain("authorization complete");
      expect(text).toContain("Continuing...");
    });

    test("channel.send() error is swallowed silently — does not throw", async () => {
      const { channel } = makeChannel(async () => {
        throw new Error("send failed");
      });
      const oauthChannel = createOAuthChannel({
        channel: channel as unknown as ChannelAdapter,
      });

      expect(() => oauthChannel.onAuthComplete({ provider: "google-drive" })).not.toThrow();
      await new Promise<void>((r) => setTimeout(r, 10));
      expect(channel.send).toHaveBeenCalledTimes(1);
    });
  });

  describe("submitAuthCode", () => {
    test("calls onSubmit with url and correlationId when onSubmit is provided", () => {
      const { channel } = makeChannel();
      const onSubmit = mock((_url: string, _correlationId?: string) => {});
      const oauthChannel = createOAuthChannel({
        channel: channel as unknown as ChannelAdapter,
        onSubmit,
      });

      oauthChannel.submitAuthCode("https://example.com/callback?code=abc", "corr-123");

      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit.mock.calls[0]?.[0]).toBe("https://example.com/callback?code=abc");
      expect(onSubmit.mock.calls[0]?.[1]).toBe("corr-123");
    });

    test("is a no-op and does not throw when onSubmit is absent", () => {
      const { channel } = makeChannel();
      const oauthChannel = createOAuthChannel({
        channel: channel as unknown as ChannelAdapter,
      });

      expect(() =>
        oauthChannel.submitAuthCode("https://example.com/callback?code=xyz"),
      ).not.toThrow();
    });
  });
});
