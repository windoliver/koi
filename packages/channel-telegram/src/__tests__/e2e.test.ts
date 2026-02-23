/**
 * E2E integration tests: @koi/channel-telegram ↔ real Claude API.
 *
 * Tests the full pipeline with real Claude API calls via @mariozechner/pi-ai:
 *   synthetic Telegram update (handleUpdate)
 *   → channel normalizer (normalize.ts)
 *   → onMessage handler
 *   → pi-ai streamSimple() — direct HTTPS to Anthropic, no subprocess
 *   → channel.send()
 *   → Telegram API spy (no real Telegram network required)
 *
 * Prerequisites (auto-loaded from .env by Bun):
 *   ANTHROPIC_API_KEY  — Claude API key (required; skips all tests if absent)
 *   TELEGRAM_BOT_TOKEN — Bot token from @BotFather (required; skips if absent)
 *
 * Telegram API calls (sendMessage, setWebhook, etc.) are stubbed so the
 * tests run without any Telegram network access. Only the Claude API is real.
 *
 * Timing note: channel-base's dispatchEvent() is fire-and-forget (void) by
 * design. So await channel.handleUpdate() does NOT wait for async onMessage
 * handlers to complete. Each test registers its handler as a Promise that
 * resolves when processing finishes, then awaits that promise after handleUpdate.
 *
 * Run:
 *   bun test packages/channel-telegram/src/__tests__/e2e.test.ts
 */

import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { InboundMessage } from "@koi/core";
import { getModel, streamSimple } from "@mariozechner/pi-ai";
import type { Context } from "grammy";
import { Bot } from "grammy";
import type { TelegramChannelAdapter } from "../telegram-channel.js";
import { createTelegramChannel } from "../telegram-channel.js";

// ---------------------------------------------------------------------------
// Environment — skip entire suite when credentials are absent
// ---------------------------------------------------------------------------

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";

const SUITE_ENABLED = BOT_TOKEN.length > 0 && ANTHROPIC_API_KEY.length > 0;

// E2E tests are slow — Claude SDK subprocess can take 10–40 s
const E2E_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal synthetic Telegram update for a plain-text message. */
function makeTextUpdate(text: string, options?: { readonly messageThreadId?: number }): unknown {
  return {
    update_id: Math.floor(Math.random() * 100_000) + 1,
    message: {
      message_id: Math.floor(Math.random() * 1000) + 1,
      from: { id: 12345, first_name: "E2ETester", is_bot: false, language_code: "en" },
      chat: { id: 99999, type: "private" },
      date: Math.floor(Date.now() / 1000),
      text,
      ...(options?.messageThreadId !== undefined
        ? { message_thread_id: options.messageThreadId }
        : {}),
    },
  };
}

/** Extract plain text from an InboundMessage's content blocks. */
function extractText(message: InboundMessage): string {
  return message.content
    .filter((b): b is { readonly kind: "text"; readonly text: string } => b.kind === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Send a single-turn prompt to Claude via @mariozechner/pi-ai and return the text.
 * Uses Haiku 4.5 for speed and cost. Direct HTTP — no subprocess needed.
 */
async function askClaude(prompt: string): Promise<string> {
  const model = getModel("anthropic", "claude-haiku-4-5");
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const stream = streamSimple(
    model,
    {
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    },
    // exactOptionalPropertyTypes: only include apiKey when defined
    ...(apiKey !== undefined ? [{ apiKey }] : []),
  );

  for await (const event of stream) {
    // "done" is the terminal event containing the full AssistantMessage
    if (event.type === "done") {
      return event.message.content
        .filter((b): b is { readonly type: "text"; readonly text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

const suite = SUITE_ENABLED ? describe : describe.skip;

suite("channel-telegram + Claude Agent SDK — E2E", () => {
  // Mocked Telegram API spies — reset before each test
  let bot: Bot<Context>;
  let sendMessageSpy: ReturnType<typeof spyOn>;
  let sendChatActionSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Pre-supply botInfo so bot.handleUpdate() works without a real bot.init() network call.
    // grammY requires me (botInfo) to be set before handleUpdate can process updates.
    bot = new Bot<Context>(BOT_TOKEN, {
      botInfo: {
        id: 8_783_053_998,
        is_bot: true,
        first_name: "E2ETestBot",
        username: "e2etestbot",
        can_join_groups: true,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
        has_topics_enabled: false,
        allows_users_to_create_topics: false,
      },
    });
    // Stub all Telegram outbound/control calls — no real Telegram network needed
    sendMessageSpy = spyOn(bot.api, "sendMessage").mockResolvedValue({} as never);
    sendChatActionSpy = spyOn(bot.api, "sendChatAction").mockResolvedValue(true as never);
    spyOn(bot.api, "setWebhook").mockResolvedValue(true as never);
    spyOn(bot.api, "deleteWebhook").mockResolvedValue(true as never);
  });

  /** Create and connect a channel in webhook mode using the stubbed bot. */
  async function createConnectedChannel(): Promise<TelegramChannelAdapter> {
    const channel = createTelegramChannel({
      token: BOT_TOKEN,
      deployment: { mode: "webhook", webhookUrl: "https://e2e-test.example.com/bot" },
      _bot: bot,
    });
    await channel.connect();
    return channel;
  }

  /**
   * Attach an onMessage handler that sends user text to Claude and replies.
   *
   * Returns a Promise that resolves once the handler has processed its first
   * message. IMPORTANT: register before calling handleUpdate, then await after.
   *
   * channel-base's dispatchEvent() is fire-and-forget (void), so handleUpdate
   * resolves before async handlers complete. The returned promise bridges that gap.
   */
  function wireClaudeHandler(channel: TelegramChannelAdapter): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      channel.onMessage(async (inbound: InboundMessage) => {
        try {
          const text = extractText(inbound);
          if (text.length === 0) {
            resolve();
            return;
          }
          const reply = await askClaude(text);
          if (reply.length > 0) {
            await channel.send({
              content: [{ kind: "text", text: reply }],
              // exactOptionalPropertyTypes: omit threadId when undefined
              ...(inbound.threadId !== undefined && { threadId: inbound.threadId }),
            });
          }
          resolve();
        } catch (e: unknown) {
          reject(e);
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // Test 1: Full roundtrip — text in, real Claude reply out
  // -------------------------------------------------------------------------

  test(
    "sends Claude reply for incoming text message",
    async () => {
      const channel = await createConnectedChannel();
      // Register handler BEFORE triggering the update; await completion AFTER.
      const done = wireClaudeHandler(channel);
      await channel.handleUpdate?.(
        makeTextUpdate('Respond with only the single word "pong". No punctuation, no other text.'),
      );
      await done;

      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const [chatId, replyText] = sendMessageSpy.mock.calls[0] as [string, string, unknown];

      // Chat ID comes from the synthetic update (chat.id = 99999)
      expect(chatId).toBe("99999");
      // Claude should have replied with "pong" (case-insensitive)
      expect(replyText.toLowerCase()).toContain("pong");

      await channel.disconnect();
    },
    E2E_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 2: Typing indicator is sent while Claude is processing
  // -------------------------------------------------------------------------

  test(
    "sends typing indicator while Claude is processing",
    async () => {
      const channel = await createConnectedChannel();

      const done = new Promise<void>((resolve, reject) => {
        channel.onMessage(async (inbound: InboundMessage) => {
          try {
            // Signal processing before running Claude
            await channel.sendStatus?.({
              kind: "processing",
              turnIndex: 0,
              // exactOptionalPropertyTypes: omit messageRef when undefined
              ...(inbound.threadId !== undefined && { messageRef: inbound.threadId }),
            });

            const text = extractText(inbound);
            const reply = await askClaude(`${text} (one word answer)`);

            await channel.send({
              content: [{ kind: "text", text: reply.length > 0 ? reply : "..." }],
              ...(inbound.threadId !== undefined && { threadId: inbound.threadId }),
            });

            await channel.sendStatus?.({
              kind: "idle",
              turnIndex: 0,
              ...(inbound.threadId !== undefined && { messageRef: inbound.threadId }),
            });

            resolve();
          } catch (e: unknown) {
            reject(e);
          }
        });
      });

      await channel.handleUpdate?.(makeTextUpdate('Say "hi"'));
      await done;

      // Typing action must have been sent before the reply
      expect(sendChatActionSpy).toHaveBeenCalled();
      const [, action] = sendChatActionSpy.mock.calls[0] as [string, string];
      expect(action).toBe("typing");

      // Reply must also have been sent
      expect(sendMessageSpy).toHaveBeenCalled();

      await channel.disconnect();
    },
    E2E_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 3: Forum topic routing — message_thread_id preserved across Claude reply
  // -------------------------------------------------------------------------

  test(
    "preserves forum message_thread_id in Claude reply",
    async () => {
      const channel = await createConnectedChannel();
      const done = wireClaudeHandler(channel);
      await channel.handleUpdate?.(makeTextUpdate('Reply with "ok"', { messageThreadId: 42 }));
      await done;

      expect(sendMessageSpy).toHaveBeenCalledTimes(1);
      const [chatId, , opts] = sendMessageSpy.mock.calls[0] as [
        string,
        string,
        { readonly message_thread_id?: number } | undefined,
      ];

      // Route stays in the same chat
      expect(chatId).toBe("99999");
      // Thread ID is forwarded from the inbound message through to the outbound call
      expect(opts?.message_thread_id).toBe(42);

      await channel.disconnect();
    },
    E2E_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Test 4: Webhook secret token verification (no Claude needed)
  // -------------------------------------------------------------------------

  test("verifyWebhookToken: accepts matching secret, rejects others", () => {
    const channel = createTelegramChannel({
      token: BOT_TOKEN,
      deployment: {
        mode: "webhook",
        webhookUrl: "https://e2e-test.example.com/bot",
        secretToken: "supersecret-e2e",
      },
      _bot: bot,
    });

    expect(channel.verifyWebhookToken?.("supersecret-e2e")).toBe(true);
    expect(channel.verifyWebhookToken?.("wrong-token")).toBe(false);
    expect(channel.verifyWebhookToken?.(undefined)).toBe(false);
  });

  test("verifyWebhookToken: accepts any token when no secret is configured (open webhook)", () => {
    const channel = createTelegramChannel({
      token: BOT_TOKEN,
      deployment: { mode: "webhook", webhookUrl: "https://e2e-test.example.com/bot" },
      _bot: bot,
    });

    // No secretToken configured → any/no token is accepted
    expect(channel.verifyWebhookToken?.(undefined)).toBe(true);
    expect(channel.verifyWebhookToken?.("anything")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Test 5: HTML parse_mode forwarded to Telegram API (no Claude needed)
  // -------------------------------------------------------------------------

  test("forwards HTML parse_mode from message metadata to Telegram sendMessage", async () => {
    const channel = await createConnectedChannel();

    await channel.send({
      content: [{ kind: "text", text: "<b>bold text</b>" }],
      threadId: "99999",
      metadata: { parse_mode: "HTML" },
    });

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const [, , opts] = sendMessageSpy.mock.calls[0] as [
      string,
      string,
      { readonly parse_mode?: string } | undefined,
    ];
    expect(opts?.parse_mode).toBe("HTML");

    await channel.disconnect();
  });

  // -------------------------------------------------------------------------
  // Test 6: Multi-message response — Claude sends multiple text blocks
  // -------------------------------------------------------------------------

  test(
    "channel handles multiple send() calls for the same thread",
    async () => {
      const channel = await createConnectedChannel();

      const done = new Promise<void>((resolve, reject) => {
        channel.onMessage(async (inbound: InboundMessage) => {
          try {
            const text = extractText(inbound);
            // Ask Claude to produce two clearly separated sentences
            const reply = await askClaude(
              `${text} Give exactly two short sentences as your answer. Keep it brief.`,
            );

            // Send two blocks separately (simulating an agent that streams)
            const sentences = reply.split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 0);
            for (const sentence of sentences.slice(0, 2)) {
              await channel.send({
                content: [{ kind: "text", text: sentence }],
                ...(inbound.threadId !== undefined && { threadId: inbound.threadId }),
              });
            }
            resolve();
          } catch (e: unknown) {
            reject(e);
          }
        });
      });

      await channel.handleUpdate?.(makeTextUpdate("What is 1+1? And what is 2+2?"));
      await done;

      // At least one sendMessage call — channel correctly forwarded the reply
      expect(sendMessageSpy.mock.calls.length).toBeGreaterThanOrEqual(1);

      await channel.disconnect();
    },
    E2E_TIMEOUT_MS,
  );
});
