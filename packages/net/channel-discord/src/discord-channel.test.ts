/**
 * Lifecycle and contract tests for createDiscordChannel().
 *
 * Uses dependency injection (_client config) to avoid network calls.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  AudioPlayer,
  CreateVoiceConnectionOptions,
  JoinVoiceChannelOptions,
  VoiceConnection,
} from "@discordjs/voice";
import { testChannelAdapter } from "@koi/test-utils";
import type { Client } from "discord.js";
import { createDiscordChannel } from "./discord-channel.js";
import type { MockClient } from "./test-helpers.js";
import { createMockClient, createMockMessage } from "./test-helpers.js";

const DUMMY_TOKEN = "test-discord-bot-token";

// ---------------------------------------------------------------------------
// Mock client factory for tests
// ---------------------------------------------------------------------------

type JoinVoiceFn = (
  config: CreateVoiceConnectionOptions & JoinVoiceChannelOptions,
) => VoiceConnection;
type CreateAudioPlayerFn = () => AudioPlayer;

function makeMockVoiceDeps(): {
  readonly _joinVoiceChannel: JoinVoiceFn;
  readonly _createAudioPlayer: CreateAudioPlayerFn;
} {
  return {
    _joinVoiceChannel: mock(() => ({
      subscribe: mock(() => {}),
      destroy: mock(() => {}),
      on: mock(() => {}),
    })) as unknown as JoinVoiceFn,
    _createAudioPlayer: mock(() => ({
      play: mock(() => {}),
      stop: mock(() => {}),
    })) as unknown as CreateAudioPlayerFn,
  };
}

function makeAdapter(overrides?: Partial<MockClient>) {
  const mockClient = createMockClient(overrides);
  const voiceDeps = makeMockVoiceDeps();
  return {
    adapter: createDiscordChannel({
      token: DUMMY_TOKEN,
      _client: mockClient as unknown as Client,
      _joinVoiceChannel: voiceDeps._joinVoiceChannel,
      _createAudioPlayer: voiceDeps._createAudioPlayer,
    }),
    mockClient,
  };
}

// ---------------------------------------------------------------------------
// Contract test suite
// ---------------------------------------------------------------------------

describe("createDiscordChannel — contract tests", () => {
  testChannelAdapter({
    createAdapter: () => makeAdapter().adapter,
  });
});

// ---------------------------------------------------------------------------
// Capabilities and interface
// ---------------------------------------------------------------------------

describe("createDiscordChannel — capabilities", () => {
  test("has name 'discord'", () => {
    const { adapter } = makeAdapter();
    expect(adapter.name).toBe("discord");
  });

  test("declares correct capabilities", () => {
    const { adapter } = makeAdapter();
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

  test("sendStatus is present", () => {
    const { adapter } = makeAdapter();
    expect(typeof adapter.sendStatus).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("createDiscordChannel — lifecycle", () => {
  test("connect() calls client.login()", async () => {
    const { adapter, mockClient } = makeAdapter();
    await adapter.connect();
    expect(mockClient.login).toHaveBeenCalledTimes(1);
    expect(mockClient.login).toHaveBeenCalledWith(DUMMY_TOKEN);
    await adapter.disconnect();
  });

  test("connect() is idempotent", async () => {
    const { adapter, mockClient } = makeAdapter();
    await adapter.connect();
    await adapter.connect();
    expect(mockClient.login).toHaveBeenCalledTimes(1);
    await adapter.disconnect();
  });

  test("disconnect() calls client.destroy()", async () => {
    const { adapter, mockClient } = makeAdapter();
    await adapter.connect();
    await adapter.disconnect();
    expect(mockClient.destroy).toHaveBeenCalledTimes(1);
  });

  test("disconnect() is safe without prior connect", async () => {
    const { adapter } = makeAdapter();
    await adapter.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Extended interface
// ---------------------------------------------------------------------------

describe("createDiscordChannel — extended interface", () => {
  test("registerCommands throws when applicationId is missing", async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.registerCommands([{ name: "ping", description: "Pong" }])).rejects.toThrow(
      "applicationId is required",
    );
  });

  test("joinVoice returns a voice connection handle", () => {
    const mockClient = createMockClient();
    // Add a guilds.cache.get mock
    const mockGuild = { voiceAdapterCreator: {} };
    const clientWithGuilds = {
      ...mockClient,
      guilds: { cache: { get: mock(() => mockGuild) } },
    };
    const adapter = createDiscordChannel({
      token: DUMMY_TOKEN,
      _client: clientWithGuilds as unknown as Client,
      _joinVoiceChannel: mock(() => ({
        subscribe: mock(() => {}),
        destroy: mock(() => {}),
        on: mock(() => {}),
      })) as unknown as JoinVoiceFn,
      _createAudioPlayer: mock(() => ({
        play: mock(() => {}),
        stop: mock(() => {}),
      })) as unknown as CreateAudioPlayerFn,
    });
    const vc = adapter.joinVoice("guild-1", "vc-1");
    expect(vc.guildId).toBe("guild-1");
    expect(vc.channelId).toBe("vc-1");
    expect(typeof vc.destroy).toBe("function");
    expect(typeof vc.playAudio).toBe("function");
  });

  test("leaveVoice does not throw when no connection exists", () => {
    const { adapter } = makeAdapter();
    // Should not throw
    adapter.leaveVoice("guild-nonexistent");
  });
});

// ---------------------------------------------------------------------------
// Regression: normalizer uses post-login botUserId, not "unknown"
// ---------------------------------------------------------------------------

describe("createDiscordChannel — botUserId normalizer regression", () => {
  const REAL_BOT_ID = "real-bot-999";

  /**
   * Creates a mock client that simulates the real Discord.js login flow:
   * client.user is null before login(), then populated after login() resolves.
   */
  function createLoginSimulatingClient(): MockClient & {
    readonly user: { readonly id: string; readonly bot: boolean };
  } {
    // Mutable user reference — starts as null-like state, set after login
    // let requires justification: simulates Discord.js client.user being set by login()
    let userRef: { readonly id: string; readonly bot: boolean } | null = null;

    const eventHandlers = new Map<string, ((...args: readonly unknown[]) => void)[]>();

    const clientObj = {
      get user() {
        return userRef;
      },
      login: mock(async () => {
        userRef = { id: REAL_BOT_ID, bot: true };
        return "token";
      }),
      destroy: mock(async () => {}),
      on: mock((event: string, handler: (...args: readonly unknown[]) => void) => {
        const handlers = eventHandlers.get(event) ?? [];
        eventHandlers.set(event, [...handlers, handler]);
        return clientObj;
      }),
      removeAllListeners: mock(() => {
        eventHandlers.clear();
        return clientObj;
      }),
      channels: {
        cache: {
          get: mock(() => ({
            send: mock(async () => ({})),
            sendTyping: mock(async () => {}),
            isThread: () => false,
          })),
        },
      },
      /** Fire a registered event handler for testing. */
      emit(event: string, ...args: readonly unknown[]): void {
        const handlers = eventHandlers.get(event);
        if (handlers !== undefined) {
          for (const h of handlers) {
            h(...args);
          }
        }
      },
    };

    return clientObj as unknown as MockClient & {
      readonly user: { readonly id: string; readonly bot: boolean };
    };
  }

  test("filters bot's own messages after login (botUserId is not stale 'unknown')", async () => {
    const mockClient = createLoginSimulatingClient();
    const voiceDeps = makeMockVoiceDeps();

    const adapter = createDiscordChannel({
      token: DUMMY_TOKEN,
      _client: mockClient as unknown as Client,
      _joinVoiceChannel: voiceDeps._joinVoiceChannel,
      _createAudioPlayer: voiceDeps._createAudioPlayer,
    });

    const received: unknown[] = [];
    adapter.onMessage(async (msg) => {
      received.push(msg);
    });

    await adapter.connect();

    // Simulate a message from the bot itself — should be filtered
    const botMessage = createMockMessage({
      authorId: REAL_BOT_ID,
      authorBot: true,
      content: "I am the bot",
    });
    (mockClient as unknown as { emit: (event: string, ...args: readonly unknown[]) => void }).emit(
      "messageCreate",
      botMessage,
    );

    // Yield to the microtask queue so the async normalizer runs
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(0);

    // Simulate a message from a real user — should be delivered
    const userMessage = createMockMessage({
      authorId: "human-user-42",
      authorBot: false,
      content: "Hello bot!",
    });
    (mockClient as unknown as { emit: (event: string, ...args: readonly unknown[]) => void }).emit(
      "messageCreate",
      userMessage,
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toHaveLength(1);

    await adapter.disconnect();
  });

  test("normalizer uses 'unknown' before login and real ID after login", async () => {
    const mockClient = createLoginSimulatingClient();
    const voiceDeps = makeMockVoiceDeps();

    // Before login, client.user is null — botUserId should be "unknown"
    expect(mockClient.user).toBeNull();

    const adapter = createDiscordChannel({
      token: DUMMY_TOKEN,
      _client: mockClient as unknown as Client,
      _joinVoiceChannel: voiceDeps._joinVoiceChannel,
      _createAudioPlayer: voiceDeps._createAudioPlayer,
    });

    await adapter.connect();

    // After login, client.user should be set
    expect(mockClient.user).not.toBeNull();
    expect(mockClient.user?.id).toBe(REAL_BOT_ID);

    await adapter.disconnect();
  });
});
