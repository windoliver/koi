/**
 * Lifecycle tests for createTelegramChannel().
 *
 * Tests polling and webhook modes in separate suites.
 * Uses dependency injection (_bot config) to avoid network calls.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
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
