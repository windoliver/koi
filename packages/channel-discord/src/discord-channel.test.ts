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
import { createMockClient } from "./test-helpers.js";

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
