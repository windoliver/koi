/**
 * Test mock factories for discord.js types.
 *
 * These helpers return typed mock objects with overridable fields for
 * use in normalizer, platform-send, and channel lifecycle tests.
 * All mocks are config-injected — no global module mocking required.
 */

import { mock } from "bun:test";

// ---------------------------------------------------------------------------
// Mock Client
// ---------------------------------------------------------------------------

export interface MockClient {
  readonly user: { readonly id: string; readonly bot: boolean };
  readonly login: ReturnType<typeof mock>;
  readonly destroy: ReturnType<typeof mock>;
  readonly on: ReturnType<typeof mock>;
  readonly removeAllListeners: ReturnType<typeof mock>;
  readonly channels: {
    readonly cache: {
      readonly get: ReturnType<typeof mock>;
    };
  };
}

/** Failure mode configuration for mock Discord Client. */
export interface MockClientOptions {
  /** When true, login() rejects with an error. */
  readonly throwOnConnect?: boolean;
  /** When true, channel.send() rejects with an error. */
  readonly failOnSend?: boolean;
  /** When set, the Nth send() call (1-based) rejects with an error. */
  readonly rateLimitOnNthCall?: number;
}

export function createMockClient(
  overrides?: Partial<MockClient>,
  options?: MockClientOptions,
): MockClient {
  // let justified: tracks call count for rateLimitOnNthCall
  let sendCount = 0;
  const defaultChannel = {
    send: mock(async () => {
      sendCount++;
      if (options?.failOnSend === true) {
        throw new Error("Missing Permissions");
      }
      if (options?.rateLimitOnNthCall !== undefined && sendCount === options.rateLimitOnNthCall) {
        throw new Error("You are being rate limited.");
      }
      return {};
    }),
    sendTyping: mock(async () => {}),
    isThread: () => false,
  };

  return {
    user: overrides?.user ?? { id: "bot-123", bot: true },
    login:
      overrides?.login ??
      mock(async () => {
        if (options?.throwOnConnect === true) {
          throw new Error("TOKEN_INVALID");
        }
        return "token";
      }),
    destroy: overrides?.destroy ?? mock(async () => {}),
    on: overrides?.on ?? mock(() => {}),
    removeAllListeners: overrides?.removeAllListeners ?? mock(() => {}),
    channels: overrides?.channels ?? {
      cache: {
        get: mock(() => defaultChannel),
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Mock Message (messageCreate event)
// ---------------------------------------------------------------------------

export interface MockMessage {
  readonly id: string;
  readonly content: string;
  readonly author: { readonly id: string; readonly bot: boolean };
  readonly channelId: string;
  readonly guildId: string | null;
  readonly channel: {
    readonly id: string;
    readonly send: ReturnType<typeof mock>;
    readonly sendTyping: ReturnType<typeof mock>;
    readonly isThread: () => boolean;
    readonly parentId?: string;
  };
  readonly attachments: ReadonlyMap<string, MockAttachment>;
  readonly stickers: ReadonlyMap<string, MockSticker>;
  readonly reference: { readonly messageId: string } | null;
  readonly createdTimestamp: number;
}

export interface MockAttachment {
  readonly id: string;
  readonly url: string;
  readonly name: string;
  readonly contentType: string | null;
  readonly size: number;
}

export interface MockSticker {
  readonly id: string;
  readonly name: string;
  readonly format: number;
}

export function createMockMessage(
  overrides?: Partial<{
    id: string;
    content: string;
    authorId: string;
    authorBot: boolean;
    channelId: string;
    guildId: string | null;
    isThread: boolean;
    parentId: string;
    attachments: ReadonlyMap<string, MockAttachment>;
    stickers: ReadonlyMap<string, MockSticker>;
    replyToMessageId: string | null;
    createdTimestamp: number;
  }>,
): MockMessage {
  const channelId = overrides?.channelId ?? "channel-456";
  return {
    id: overrides?.id ?? "msg-789",
    content: overrides?.content ?? "hello world",
    author: {
      id: overrides?.authorId ?? "user-123",
      bot: overrides?.authorBot ?? false,
    },
    channelId,
    guildId:
      overrides !== undefined && "guildId" in overrides ? (overrides.guildId ?? null) : "guild-001",
    channel: {
      id: channelId,
      send: mock(async () => ({})),
      sendTyping: mock(async () => {}),
      isThread: () => overrides?.isThread ?? false,
      ...(overrides?.parentId !== undefined ? { parentId: overrides.parentId } : {}),
    },
    attachments: overrides?.attachments ?? new Map(),
    stickers: overrides?.stickers ?? new Map(),
    reference:
      overrides?.replyToMessageId !== undefined && overrides.replyToMessageId !== null
        ? { messageId: overrides.replyToMessageId }
        : null,
    createdTimestamp: overrides?.createdTimestamp ?? Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Mock Interaction (interactionCreate event)
// ---------------------------------------------------------------------------

export interface MockInteraction {
  readonly id: string;
  readonly type: number;
  readonly channelId: string;
  readonly guildId: string | null;
  readonly user: { readonly id: string };
  readonly channel: {
    readonly id: string;
    readonly send: ReturnType<typeof mock>;
    readonly sendTyping: ReturnType<typeof mock>;
    readonly isThread: () => boolean;
  };
  readonly isChatInputCommand: () => boolean;
  readonly isButton: () => boolean;
  readonly isStringSelectMenu: () => boolean;
  readonly deferReply: ReturnType<typeof mock>;
  readonly deferUpdate: ReturnType<typeof mock>;
  readonly commandName?: string;
  readonly options?: {
    readonly data: readonly MockCommandOption[];
  };
  readonly customId?: string;
  readonly values?: readonly string[];
  readonly createdTimestamp: number;
}

export interface MockCommandOption {
  readonly name: string;
  readonly value: unknown;
  readonly type: number;
}

export function createMockInteraction(
  overrides?: Partial<{
    id: string;
    type: "command" | "button" | "select";
    channelId: string;
    guildId: string | null;
    userId: string;
    isThread: boolean;
    commandName: string;
    options: readonly MockCommandOption[];
    customId: string;
    values: readonly string[];
    createdTimestamp: number;
  }>,
): MockInteraction {
  const type = overrides?.type ?? "command";
  const channelId = overrides?.channelId ?? "channel-456";

  return {
    id: overrides?.id ?? "interaction-001",
    type: type === "command" ? 2 : type === "button" ? 3 : 3,
    channelId,
    guildId:
      overrides !== undefined && "guildId" in overrides ? (overrides.guildId ?? null) : "guild-001",
    user: { id: overrides?.userId ?? "user-123" },
    channel: {
      id: channelId,
      send: mock(async () => ({})),
      sendTyping: mock(async () => {}),
      isThread: () => overrides?.isThread ?? false,
    },
    isChatInputCommand: () => type === "command",
    isButton: () => type === "button",
    isStringSelectMenu: () => type === "select",
    deferReply: mock(async () => {}),
    deferUpdate: mock(async () => {}),
    ...(overrides?.commandName !== undefined ? { commandName: overrides.commandName } : {}),
    ...(overrides?.options !== undefined ? { options: { data: overrides.options } } : {}),
    ...(overrides?.customId !== undefined ? { customId: overrides.customId } : {}),
    ...(overrides?.values !== undefined ? { values: overrides.values } : {}),
    createdTimestamp: overrides?.createdTimestamp ?? Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Mock Reaction (messageReactionAdd/Remove event)
// ---------------------------------------------------------------------------

export interface MockReaction {
  readonly reaction: {
    readonly message: {
      readonly id: string;
      readonly guildId: string | null;
      readonly channelId: string;
    };
    readonly emoji: {
      readonly id: string | null;
      readonly name: string | null;
      readonly animated: boolean;
    };
  };
  readonly user: { readonly id: string };
}

export function createMockReaction(
  overrides?: Partial<{
    messageId: string;
    guildId: string | null;
    channelId: string;
    userId: string;
    emojiId: string | null;
    emojiName: string | null;
    emojiAnimated: boolean;
  }>,
): MockReaction {
  return {
    reaction: {
      message: {
        id: overrides?.messageId ?? "msg-001",
        guildId:
          overrides !== undefined && "guildId" in overrides
            ? (overrides.guildId ?? null)
            : "guild-001",
        channelId: overrides?.channelId ?? "channel-456",
      },
      emoji: {
        id: overrides?.emojiId ?? null,
        name: overrides?.emojiName ?? "👍",
        animated: overrides?.emojiAnimated ?? false,
      },
    },
    user: { id: overrides?.userId ?? "user-123" },
  };
}

// ---------------------------------------------------------------------------
// Mock VoiceState (voiceStateUpdate event)
// ---------------------------------------------------------------------------

export interface MockVoiceState {
  readonly id: string;
  readonly channelId: string | null;
  readonly guild: { readonly id: string };
  readonly member: {
    readonly id: string;
    readonly user: { readonly id: string; readonly bot: boolean };
  };
  readonly selfDeaf: boolean;
  readonly selfMute: boolean;
  readonly serverDeaf: boolean;
  readonly serverMute: boolean;
}

export function createMockVoiceState(
  overrides?: Partial<{
    channelId: string | null;
    guildId: string;
    memberId: string;
    memberBot: boolean;
    selfDeaf: boolean;
    selfMute: boolean;
    serverDeaf: boolean;
    serverMute: boolean;
  }>,
): MockVoiceState {
  const memberId = overrides?.memberId ?? "user-123";
  return {
    id: memberId,
    channelId:
      overrides !== undefined && "channelId" in overrides
        ? (overrides.channelId ?? null)
        : "voice-channel-789",
    guild: { id: overrides?.guildId ?? "guild-001" },
    member: {
      id: memberId,
      user: { id: memberId, bot: overrides?.memberBot ?? false },
    },
    selfDeaf: overrides?.selfDeaf ?? false,
    selfMute: overrides?.selfMute ?? false,
    serverDeaf: overrides?.serverDeaf ?? false,
    serverMute: overrides?.serverMute ?? false,
  };
}
