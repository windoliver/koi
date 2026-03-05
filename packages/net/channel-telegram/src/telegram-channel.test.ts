/**
 * Lifecycle tests for createTelegramChannel().
 *
 * Tests polling and webhook modes in separate suites.
 * Uses dependency injection (_bot config) to avoid network calls.
 */

import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test";
import type { Context } from "grammy";
import { Bot } from "grammy";
import { createTelegramChannel } from "./telegram-channel.js";

const DUMMY_TOKEN = "123456789:AABBCCDDEEFFaabbccddeeff-1234567890";
const WEBHOOK_URL = "https://example.com/bot";

// ---------------------------------------------------------------------------
// Mock bot factory
// ---------------------------------------------------------------------------

interface MockBotApi {
  readonly setWebhook: ReturnType<typeof mock>;
  readonly deleteWebhook: ReturnType<typeof mock>;
  readonly sendChatAction: ReturnType<typeof mock>;
  readonly sendMessage: ReturnType<typeof mock>;
}

interface MockBot {
  readonly api: MockBotApi;
  readonly init: ReturnType<typeof mock>;
  readonly start: ReturnType<typeof mock>;
  readonly stop: ReturnType<typeof mock>;
  readonly handleUpdate: ReturnType<typeof mock>;
  readonly on: ReturnType<typeof mock>;
}

function makeMockBot(): MockBot {
  const api: MockBotApi = {
    setWebhook: mock(async () => true),
    deleteWebhook: mock(async () => true),
    sendChatAction: mock(async () => true),
    sendMessage: mock(async () => ({})),
  };
  return {
    api,
    init: mock(async () => {}),
    start: mock(async () => {}),
    stop: mock(async () => {}),
    handleUpdate: mock(async () => {}),
    on: mock(() => {}),
  };
}

// ---------------------------------------------------------------------------
// Polling mode
// ---------------------------------------------------------------------------

describe("createTelegramChannel — polling mode", () => {
  test("connect() calls bot.init() then bot.start()", async () => {
    const mockBot = makeMockBot();
    const adapter = createTelegramChannel({
      token: DUMMY_TOKEN,
      deployment: { mode: "polling" },
      _bot: mockBot as unknown as Bot<Context>,
    });
    await adapter.connect();
    expect(mockBot.init).toHaveBeenCalledTimes(1);
    expect(mockBot.start).toHaveBeenCalledTimes(1);
    await adapter.disconnect();
  });

  test("connect() is idempotent — second call is no-op", async () => {
    const mockBot = makeMockBot();
    const adapter = createTelegramChannel({
      token: DUMMY_TOKEN,
      deployment: { mode: "polling" },
      _bot: mockBot as unknown as Bot<Context>,
    });
    await adapter.connect();
    await adapter.connect();
    expect(mockBot.init).toHaveBeenCalledTimes(1);
    await adapter.disconnect();
  });

  test("disconnect() calls bot.stop()", async () => {
    const mockBot = makeMockBot();
    const adapter = createTelegramChannel({
      token: DUMMY_TOKEN,
      deployment: { mode: "polling" },
      _bot: mockBot as unknown as Bot<Context>,
    });
    await adapter.connect();
    await adapter.disconnect();
    expect(mockBot.stop).toHaveBeenCalledTimes(1);
  });

  test("reconnect does not cause duplicate event dispatch", async () => {
    // let justified: accumulates handler invocations across reconnect cycles
    let handlerCallCount = 0;

    // Build a mock bot that captures registered handlers for simulation
    const registeredHandlers: ((...args: readonly unknown[]) => void)[] = [];
    const mockBot: MockBot = {
      ...makeMockBot(),
      on: mock((_event: string, handler: (...args: readonly unknown[]) => void) => {
        registeredHandlers.push(handler);
      }),
    };

    const adapter = createTelegramChannel({
      token: DUMMY_TOKEN,
      deployment: { mode: "polling" },
      _bot: mockBot as unknown as Bot<Context>,
    });

    adapter.onMessage(async () => {
      handlerCallCount++;
    });

    // First connect/disconnect cycle
    await adapter.connect();
    await adapter.disconnect();

    // Second connect — should not duplicate handlers
    await adapter.connect();

    // Fire all registered handlers to simulate a single event
    for (const h of registeredHandlers) {
      h({ message: { text: "hi", chat: { id: 42 } } });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Without the fix, each connect registers new listeners, so the handler
    // would fire once per connect cycle (2 times). With the fix, the first
    // cycle's listeners are deactivated, so only 1 invocation.
    expect(handlerCallCount).toBeLessThanOrEqual(1);

    await adapter.disconnect();
  });

  test("handleUpdate is not present in polling mode", () => {
    const mockBot = makeMockBot();
    const adapter = createTelegramChannel({
      token: DUMMY_TOKEN,
      deployment: { mode: "polling" },
      _bot: mockBot as unknown as Bot<Context>,
    });
    expect("handleUpdate" in adapter).toBe(false);
  });

  test("defaults to polling when deployment is not specified", async () => {
    const mockBot = makeMockBot();
    const adapter = createTelegramChannel({
      token: DUMMY_TOKEN,
      _bot: mockBot as unknown as Bot<Context>,
    });
    await adapter.connect();
    expect(mockBot.init).toHaveBeenCalledTimes(1);
    expect(mockBot.start).toHaveBeenCalledTimes(1);
    await adapter.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Webhook mode
// ---------------------------------------------------------------------------

describe("createTelegramChannel — webhook mode", () => {
  test("handleUpdate is present in webhook mode", () => {
    const mockBot = makeMockBot();
    const adapter = createTelegramChannel({
      token: DUMMY_TOKEN,
      deployment: { mode: "webhook", webhookUrl: WEBHOOK_URL },
      _bot: mockBot as unknown as Bot<Context>,
    });
    expect("handleUpdate" in adapter).toBe(true);
    expect(typeof adapter.handleUpdate).toBe("function");
  });

  test("connect() calls setWebhook with the configured URL", async () => {
    const mockBot = makeMockBot();
    const adapter = createTelegramChannel({
      token: DUMMY_TOKEN,
      deployment: { mode: "webhook", webhookUrl: WEBHOOK_URL },
      _bot: mockBot as unknown as Bot<Context>,
    });
    await adapter.connect();
    expect(mockBot.api.setWebhook).toHaveBeenCalledTimes(1);
    expect(mockBot.api.setWebhook).toHaveBeenCalledWith(WEBHOOK_URL, expect.any(Object));
    await adapter.disconnect();
  });

  test("connect() passes secret_token to setWebhook when provided", async () => {
    const mockBot = makeMockBot();
    const adapter = createTelegramChannel({
      token: DUMMY_TOKEN,
      deployment: { mode: "webhook", webhookUrl: WEBHOOK_URL, secretToken: "my-secret" },
      _bot: mockBot as unknown as Bot<Context>,
    });
    await adapter.connect();
    const [, opts] = mockBot.api.setWebhook.mock.calls[0] as [string, { secret_token?: string }];
    expect(opts?.secret_token).toBe("my-secret");
    await adapter.disconnect();
  });

  test("disconnect() calls deleteWebhook", async () => {
    const mockBot = makeMockBot();
    const adapter = createTelegramChannel({
      token: DUMMY_TOKEN,
      deployment: { mode: "webhook", webhookUrl: WEBHOOK_URL },
      _bot: mockBot as unknown as Bot<Context>,
    });
    await adapter.connect();
    await adapter.disconnect();
    expect(mockBot.api.deleteWebhook).toHaveBeenCalledTimes(1);
  });

  test("handleUpdate delegates to bot.handleUpdate", async () => {
    const mockBot = makeMockBot();
    const adapter = createTelegramChannel({
      token: DUMMY_TOKEN,
      deployment: { mode: "webhook", webhookUrl: WEBHOOK_URL },
      _bot: mockBot as unknown as Bot<Context>,
    });
    await adapter.connect();
    const fakeUpdate = { update_id: 1, message: { text: "hi" } };
    await adapter.handleUpdate?.(fakeUpdate);
    expect(mockBot.handleUpdate).toHaveBeenCalledTimes(1);
    await adapter.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Capabilities and interface
// ---------------------------------------------------------------------------

describe("createTelegramChannel — capabilities", () => {
  let initSpy: ReturnType<typeof spyOn>;
  let startSpy: ReturnType<typeof spyOn>;
  let stopSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    initSpy = spyOn(Bot.prototype, "init").mockResolvedValue(undefined);
    startSpy = spyOn(Bot.prototype, "start").mockResolvedValue(undefined);
    stopSpy = spyOn(Bot.prototype, "stop").mockResolvedValue(undefined);
  });

  afterEach(() => {
    initSpy.mockRestore();
    startSpy.mockRestore();
    stopSpy.mockRestore();
  });

  test("declares correct capabilities", () => {
    const adapter = createTelegramChannel({ token: DUMMY_TOKEN });
    expect(adapter.capabilities).toMatchObject({
      text: true,
      images: true,
      files: true,
      buttons: true,
      audio: true,
      video: true,
      threads: true,
      supportsA2ui: false,
    });
  });

  test("has name 'telegram'", () => {
    const adapter = createTelegramChannel({ token: DUMMY_TOKEN });
    expect(adapter.name).toBe("telegram");
  });

  test("sendStatus is present (typing support)", () => {
    const adapter = createTelegramChannel({ token: DUMMY_TOKEN });
    expect(typeof adapter.sendStatus).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Typing indicator TTL
// ---------------------------------------------------------------------------

describe("createTelegramChannel — typing indicator TTL", () => {
  test("typing indicator stops automatically after 5 minutes", async () => {
    jest.useFakeTimers();
    try {
      const mockBot = makeMockBot();
      const adapter = createTelegramChannel({
        token: DUMMY_TOKEN,
        deployment: { mode: "polling" },
        _bot: mockBot as unknown as Bot<Context>,
      });
      await adapter.connect();

      // Trigger typing indicator
      await adapter.sendStatus?.({ kind: "processing", turnIndex: 0, messageRef: "42" });

      // Advance past 5-minute TTL
      jest.advanceTimersByTime(5 * 60 * 1000 + 1);

      // Record call count right after TTL fires
      const callsAtTtl = mockBot.api.sendChatAction.mock.calls.length;

      // Advance another full interval period — interval should be cleared
      jest.advanceTimersByTime(5000);
      const callsAfterInterval = mockBot.api.sendChatAction.mock.calls.length;

      // No new calls after TTL cleared the interval
      expect(callsAfterInterval).toBe(callsAtTtl);

      await adapter.disconnect();
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Webhook secret token verification
// ---------------------------------------------------------------------------

describe("createTelegramChannel — verifyWebhookToken", () => {
  test("returns true when token matches configured secretToken", () => {
    const mockBot = makeMockBot();
    const adapter = createTelegramChannel({
      token: DUMMY_TOKEN,
      deployment: { mode: "webhook", webhookUrl: WEBHOOK_URL, secretToken: "my-secret" },
      _bot: mockBot as unknown as Bot<Context>,
    });
    expect(adapter.verifyWebhookToken?.("my-secret")).toBe(true);
  });

  test("returns false when token does not match configured secretToken", () => {
    const mockBot = makeMockBot();
    const adapter = createTelegramChannel({
      token: DUMMY_TOKEN,
      deployment: { mode: "webhook", webhookUrl: WEBHOOK_URL, secretToken: "my-secret" },
      _bot: mockBot as unknown as Bot<Context>,
    });
    expect(adapter.verifyWebhookToken?.("wrong-token")).toBe(false);
  });

  test("returns false when token is undefined and secretToken is configured", () => {
    const mockBot = makeMockBot();
    const adapter = createTelegramChannel({
      token: DUMMY_TOKEN,
      deployment: { mode: "webhook", webhookUrl: WEBHOOK_URL, secretToken: "my-secret" },
      _bot: mockBot as unknown as Bot<Context>,
    });
    expect(adapter.verifyWebhookToken?.(undefined)).toBe(false);
  });

  test("returns true when no secretToken configured (open webhook)", () => {
    const mockBot = makeMockBot();
    const adapter = createTelegramChannel({
      token: DUMMY_TOKEN,
      deployment: { mode: "webhook", webhookUrl: WEBHOOK_URL },
      _bot: mockBot as unknown as Bot<Context>,
    });
    // With no secretToken, any token (even undefined) is accepted
    expect(adapter.verifyWebhookToken?.(undefined)).toBe(true);
    expect(adapter.verifyWebhookToken?.("anything")).toBe(true);
  });

  test("verifyWebhookToken is not present in polling mode", () => {
    const mockBot = makeMockBot();
    const adapter = createTelegramChannel({
      token: DUMMY_TOKEN,
      deployment: { mode: "polling" },
      _bot: mockBot as unknown as Bot<Context>,
    });
    expect("verifyWebhookToken" in adapter).toBe(false);
  });
});
