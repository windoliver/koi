/**
 * @koi/channel-telegram — grammY integration.
 *
 * Creates a ChannelAdapter for Telegram bots using the grammY library.
 * Supports two deployment modes:
 *
 * - polling: bot.start() long-polling loop (default, works everywhere)
 * - webhook: Telegram pushes updates via HTTP; caller feeds them via handleUpdate()
 *
 * Usage (polling):
 *   const adapter = createTelegramChannel({ token: "...", deployment: { mode: "polling" } });
 *   await adapter.connect();
 *
 * Usage (webhook):
 *   const adapter = createTelegramChannel({
 *     token: "...",
 *     deployment: { mode: "webhook", webhookUrl: "https://yourserver.com/bot" },
 *   });
 *   await adapter.connect(); // registers webhook with Telegram
 *   // In your HTTP handler:
 *   if (adapter.handleUpdate) await adapter.handleUpdate(req.body);
 *
 * threadId convention: InboundMessage.threadId = String(chat.id).
 * OutboundMessage.threadId must match to route replies to the correct chat.
 *
 * Typing indicator: sendStatus({ kind: "processing" }) sends a typing indicator
 * that auto-refreshes every 4 seconds until sendStatus({ kind: "idle" }) is called.
 */

import { createChannelAdapter } from "@koi/channel-base";
import type { ChannelAdapter, ChannelCapabilities, ChannelStatus, InboundMessage } from "@koi/core";
import type { Context } from "grammy";
import { Bot } from "grammy";
import { createNormalizer } from "./normalize.js";
import { telegramSend } from "./platform-send.js";

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

/** Deployment mode for the Telegram channel. */
export type TelegramDeployment =
  | { readonly mode: "polling" }
  | {
      readonly mode: "webhook";
      /** Public HTTPS URL Telegram will POST updates to. */
      readonly webhookUrl: string;
      /**
       * Optional secret token sent in X-Telegram-Bot-Api-Secret-Token header.
       * Allows the webhook handler to verify requests came from Telegram.
       */
      readonly secretToken?: string;
    };

/** Configuration for createTelegramChannel(). */
export interface TelegramChannelConfig {
  /** Bot token from @BotFather. */
  readonly token: string;
  /** Deployment mode. Defaults to polling if omitted. */
  readonly deployment?: TelegramDeployment;
  /**
   * Called when a registered message handler throws or rejects.
   * Defaults to console.error. The channel continues processing events.
   */
  readonly onHandlerError?: (err: unknown, message: InboundMessage) => void;
  /**
   * For testing only: inject a pre-configured Bot instance instead of creating one.
   * This allows tests to provide mock bots without network access.
   * @internal
   */
  readonly _bot?: Bot<Context>;
  /**
   * When true, send() called while disconnected buffers the message and
   * flushes on the next connect(). When false (default), send() throws.
   */
  readonly queueWhenDisconnected?: boolean;
}

/** Telegram channel capabilities. */
const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: true,
  audio: true,
  video: true,
  threads: true, // Forum topics routed via "chatId:messageThreadId" threadId encoding
  supportsA2ui: false,
} as const satisfies ChannelCapabilities;

// ---------------------------------------------------------------------------
// Extended adapter interface (webhook mode)
// ---------------------------------------------------------------------------

/**
 * ChannelAdapter extended with webhook-specific methods.
 * These are only present when deployment.mode === "webhook".
 *
 * Callers can check: if ("handleUpdate" in adapter) { ... }
 */
export interface TelegramChannelAdapter extends ChannelAdapter {
  /**
   * Feeds a raw Telegram update into the bot for processing.
   * Wire this to your HTTP route handler in webhook mode.
   *
   * Only present when deployment.mode === "webhook".
   */
  readonly handleUpdate?: (update: unknown) => Promise<void>;

  /**
   * Verifies the X-Telegram-Bot-Api-Secret-Token header value.
   * Returns true if the token matches the configured secretToken, or if no
   * secretToken was configured (open webhook). Returns false on mismatch.
   *
   * Only present when deployment.mode === "webhook".
   *
   * Usage: if (!adapter.verifyWebhookToken?.(req.headers["x-telegram-bot-api-secret-token"])) return 403;
   */
  readonly verifyWebhookToken?: (token: string | undefined) => boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a Telegram ChannelAdapter using grammY.
 *
 * @param config - Bot token, deployment mode, and optional hooks.
 * @returns A TelegramChannelAdapter satisfying the @koi/core ChannelAdapter contract.
 */
export function createTelegramChannel(config: TelegramChannelConfig): TelegramChannelAdapter {
  const deployment: TelegramDeployment = config.deployment ?? { mode: "polling" };
  const bot = config._bot ?? new Bot<Context>(config.token);

  // let requires justification: typing interval handle, started/cleared by sendStatus
  let typingInterval: ReturnType<typeof setInterval> | undefined;
  // let requires justification: 5-minute TTL timeout — auto-stops if idle is never sent
  let typingTimeout: ReturnType<typeof setTimeout> | undefined;
  // let requires justification: tracks the last chatId that triggered a typing indicator
  let typingChatId: string | undefined;

  const stopTyping = (): void => {
    if (typingInterval !== undefined) {
      clearInterval(typingInterval);
      typingInterval = undefined;
    }
    if (typingTimeout !== undefined) {
      clearTimeout(typingTimeout);
      typingTimeout = undefined;
    }
    typingChatId = undefined;
  };

  const platformSendStatus = async (status: ChannelStatus): Promise<void> => {
    // Extract chatId from the messageRef (which we set to the threadId)
    const chatId = status.messageRef ?? typingChatId;
    if (chatId === undefined) {
      return;
    }

    if (status.kind === "processing") {
      typingChatId = chatId;
      // Send immediately, then refresh every 4s (Telegram indicator expires at ~5s)
      await bot.api.sendChatAction(chatId, "typing");
      if (typingInterval === undefined) {
        typingInterval = setInterval(() => {
          void bot.api.sendChatAction(chatId, "typing").catch((e: unknown) => {
            console.error("[channel-telegram] sendChatAction failed:", e);
          });
        }, 4000);
        // Safety TTL: auto-stop after 5 minutes if caller never sends "idle"
        typingTimeout = setTimeout(
          () => {
            stopTyping();
          },
          5 * 60 * 1000,
        );
      }
    } else {
      // "idle" or "error" — stop the typing indicator
      stopTyping();
    }
  };

  if (deployment.mode === "polling") {
    // grammY requires listeners to be registered BEFORE bot.start().
    // channel-base calls onPlatformEvent AFTER platformConnect, so we register
    // grammY listeners eagerly here and forward events to the handler once set.
    // let justified: handler set by onPlatformEvent after connect
    let eventHandler: ((ctx: Context) => void) | undefined;
    // let justified: active flag gates dispatching; cleared on unsubscribe
    let handlerActive = true;

    // Register grammY listeners immediately (before bot.start).
    // Use bot.use() instead of bot.on("message") — grammY 1.40.x on Bun has
    // a compatibility issue where filter middleware (bot.on) doesn't dispatch,
    // but catch-all middleware (bot.use) works reliably.
    bot.use((ctx) => {
      if (!handlerActive || eventHandler === undefined) return;
      if (ctx.message !== undefined || ctx.callbackQuery !== undefined) {
        eventHandler(ctx);
      }
    });

    const base = createChannelAdapter<Context>({
      name: "telegram",
      capabilities: TELEGRAM_CAPABILITIES,

      platformConnect: async () => {
        // bot.init() validates the token and fetches bot info synchronously before
        // starting the polling loop. This gives connect() a clean "ready" signal.
        await bot.init();
        // bot.start() never resolves — run as background loop (fire-and-forget).
        // Listeners are already registered above, so messages are dispatched immediately.
        void bot.start();
      },

      platformDisconnect: async () => {
        stopTyping();
        handlerActive = false;
        await bot.stop();
      },

      platformSend: async (message) => {
        await telegramSend(bot, message);
      },

      onPlatformEvent: (handler) => {
        // Wire handler to the eagerly-registered grammY listeners
        eventHandler = handler;
        handlerActive = true;
        return () => {
          handlerActive = false;
          eventHandler = undefined;
        };
      },

      normalize: createNormalizer(config.token),
      platformSendStatus,
      // exactOptionalPropertyTypes: only spread optional fields when defined
      ...(config.onHandlerError !== undefined && { onHandlerError: config.onHandlerError }),
      ...(config.queueWhenDisconnected !== undefined && {
        queueWhenDisconnected: config.queueWhenDisconnected,
      }),
    });

    return base;
  }

  // --- Webhook mode ---
  const webhookUrl = deployment.webhookUrl;
  const secretToken = "secretToken" in deployment ? deployment.secretToken : undefined;

  const base = createChannelAdapter<Context>({
    name: "telegram",
    capabilities: TELEGRAM_CAPABILITIES,

    platformConnect: async () => {
      await bot.api.setWebhook(webhookUrl, {
        // exactOptionalPropertyTypes: omit secret_token when undefined
        ...(secretToken !== undefined && { secret_token: secretToken }),
      });
    },

    platformDisconnect: async () => {
      stopTyping();
      await bot.api.deleteWebhook();
    },

    platformSend: async (message) => {
      await telegramSend(bot, message);
    },

    onPlatformEvent: (handler) => {
      // let justified: active flag gates dispatching; cleared on unsubscribe
      let active = true;
      const guard = (ctx: Context): void => {
        if (active) handler(ctx);
      };
      bot.on("message", guard);
      bot.on("callback_query", guard);
      return () => {
        active = false;
      };
    },

    normalize: createNormalizer(config.token),
    platformSendStatus,
    // exactOptionalPropertyTypes: only spread optional fields when defined
    ...(config.onHandlerError !== undefined && { onHandlerError: config.onHandlerError }),
    ...(config.queueWhenDisconnected !== undefined && {
      queueWhenDisconnected: config.queueWhenDisconnected,
    }),
  });

  // Expose handleUpdate and verifyWebhookToken so callers can process webhook payloads
  return {
    ...base,
    handleUpdate: async (update: unknown): Promise<void> => {
      await bot.handleUpdate(update as Parameters<typeof bot.handleUpdate>[0]);
    },
    verifyWebhookToken: (token: string | undefined): boolean => {
      // No secretToken configured — accept all requests (open webhook)
      if (secretToken === undefined) {
        return true;
      }
      return token === secretToken;
    },
  };
}
