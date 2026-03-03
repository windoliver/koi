/**
 * Main factory for @koi/channel-chat-sdk.
 *
 * Creates a shared Chat SDK instance and returns one ChannelAdapter
 * per configured platform. Each adapter routes through the shared
 * Chat instance for webhook handling, event normalization, and sending.
 */

import { createMemoryState } from "@chat-adapter/state-memory";
import { createChannelAdapter } from "@koi/channel-base";
import type { ChannelAdapter, ChannelStatus, OutboundMessage } from "@koi/core";
import type { Adapter, Message, Thread } from "chat";
import { Chat } from "chat";
import { capabilitiesForPlatform } from "./capabilities.js";
import type { ChatSdkChannelConfig, PlatformConfig, PlatformName } from "./config.js";
import { mapContentToPostable } from "./map-content.js";
import { normalize } from "./normalize.js";
import type { ChatSdkEvent } from "./types.js";

const DEFAULT_USER_NAME = "koi-bot";

export interface ChatSdkChannelAdapter extends ChannelAdapter {
  readonly handleWebhook: (
    request: Request,
    options?: { readonly waitUntil?: (p: Promise<unknown>) => void },
  ) => Promise<Response>;
  readonly platform: string;
}

/**
 * Internal test overrides. Not part of the public API.
 */
export interface ChatSdkTestOverrides {
  /** Injected Chat instance for testing. Typed as unknown to accept partial mocks. */
  readonly _chat?: unknown;
  /** Injected platform adapters for testing. Typed as unknown to accept partial mocks. */
  readonly _adapters?: Readonly<Record<string, unknown>>;
}

/**
 * Creates a Chat SDK platform adapter from a PlatformConfig.
 * Each adapter factory auto-detects credentials from env when not provided.
 */
async function createPlatformAdapter(config: PlatformConfig): Promise<Adapter> {
  switch (config.platform) {
    case "slack": {
      const { createSlackAdapter } = await import("@chat-adapter/slack");
      // @ts-expect-error — SlackAdapter.botUserId is `string | undefined` vs Adapter's optional `string` (Chat SDK type bug under exactOptionalPropertyTypes)
      return createSlackAdapter({
        ...(config.botToken !== undefined ? { botToken: config.botToken } : {}),
        ...(config.signingSecret !== undefined ? { signingSecret: config.signingSecret } : {}),
      });
    }
    case "discord": {
      const { createDiscordAdapter } = await import("@chat-adapter/discord");
      return createDiscordAdapter({
        ...(config.botToken !== undefined ? { botToken: config.botToken } : {}),
        ...(config.publicKey !== undefined ? { publicKey: config.publicKey } : {}),
        ...(config.applicationId !== undefined ? { applicationId: config.applicationId } : {}),
      });
    }
    case "teams": {
      const { createTeamsAdapter } = await import("@chat-adapter/teams");
      return createTeamsAdapter({
        ...(config.appId !== undefined ? { appId: config.appId } : {}),
        ...(config.appPassword !== undefined ? { appPassword: config.appPassword } : {}),
      });
    }
    case "gchat": {
      const { createGoogleChatAdapter } = await import("@chat-adapter/gchat");
      return createGoogleChatAdapter({
        ...(config.credentials !== undefined ? { credentials: config.credentials } : {}),
      });
    }
    case "github": {
      const { createGitHubAdapter } = await import("@chat-adapter/github");
      // @ts-expect-error — GitHubAdapter.botUserId is `string | undefined` vs Adapter's optional `string` (Chat SDK type bug under exactOptionalPropertyTypes)
      return createGitHubAdapter({
        ...(config.token !== undefined ? { token: config.token } : {}),
        ...(config.webhookSecret !== undefined ? { webhookSecret: config.webhookSecret } : {}),
        ...(config.userName !== undefined ? { userName: config.userName } : {}),
      });
    }
    case "linear": {
      const { createLinearAdapter } = await import("@chat-adapter/linear");
      // @ts-expect-error — LinearAdapter.botUserId is `string | undefined` vs Adapter's optional `string` (Chat SDK type bug under exactOptionalPropertyTypes)
      return createLinearAdapter({
        ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
        ...(config.webhookSecret !== undefined ? { webhookSecret: config.webhookSecret } : {}),
        ...(config.userName !== undefined ? { userName: config.userName } : {}),
      });
    }
  }
}

/**
 * Event router state: maps adapter name → event handler list.
 * Immutable updates via Map.set with new arrays.
 */
interface EventRouter {
  readonly get: (name: string) => readonly ((event: ChatSdkEvent) => void)[];
  readonly add: (name: string, handler: (event: ChatSdkEvent) => void) => void;
  readonly remove: (name: string, handler: (event: ChatSdkEvent) => void) => void;
}

function createEventRouter(platforms: readonly PlatformConfig[]): EventRouter {
  const routes = new Map<string, readonly ((event: ChatSdkEvent) => void)[]>();

  for (const platformConfig of platforms) {
    routes.set(platformConfig.platform, []);
  }

  return {
    get: (name: string) => routes.get(name) ?? [],
    add: (name: string, handler: (event: ChatSdkEvent) => void) => {
      routes.set(name, [...(routes.get(name) ?? []), handler]);
    },
    remove: (name: string, handler: (event: ChatSdkEvent) => void) => {
      const current = routes.get(name) ?? [];
      routes.set(
        name,
        current.filter((h) => h !== handler),
      );
    },
  };
}

/**
 * Shared lifecycle state for the Chat SDK instance.
 * Uses a promise guard to prevent concurrent initialization.
 */
interface SharedLifecycle {
  readonly ensureInitialized: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
  readonly getChatInstance: () => Chat | null;
  readonly connect: () => Promise<void>;
  readonly disconnect: () => Promise<void>;
}

function createSharedLifecycle(
  config: ChatSdkChannelConfig,
  injectedChat: unknown,
  injectedAdapters: Readonly<Record<string, unknown>>,
  onReady: (chat: Chat) => void,
): SharedLifecycle {
  const userName = config.userName ?? DEFAULT_USER_NAME;

  // let justification: Chat instance is created lazily, or injected for tests
  let chatInstance = (injectedChat ?? null) as Chat | null;
  // let justification: promise guard for concurrent init
  let initPromise: Promise<void> | null = null;
  // let justification: tracks connected adapter count for ref-counted shutdown
  let connectedCount = 0;

  async function doInitialize(): Promise<void> {
    if (chatInstance === null) {
      const adapterMap: Record<string, Adapter> = {};
      for (const platformConfig of config.platforms) {
        const existing = injectedAdapters[platformConfig.platform] as Adapter | undefined;
        adapterMap[platformConfig.platform] =
          existing ?? (await createPlatformAdapter(platformConfig));
      }

      chatInstance = new Chat({
        userName,
        adapters: adapterMap,
        state: createMemoryState(),
      });
    }

    onReady(chatInstance);
    await chatInstance.initialize();
  }

  return {
    ensureInitialized: (): Promise<void> => {
      if (initPromise !== null) {
        return initPromise;
      }
      initPromise = doInitialize();
      return initPromise;
    },

    shutdown: async (): Promise<void> => {
      if (chatInstance !== null) {
        await chatInstance.shutdown();
        chatInstance = null;
        initPromise = null;
      }
    },

    getChatInstance: (): Chat | null => chatInstance,

    connect: async (): Promise<void> => {
      if (initPromise === null) {
        initPromise = doInitialize();
      }
      await initPromise;
      connectedCount++;
    },

    disconnect: async (): Promise<void> => {
      connectedCount = Math.max(0, connectedCount - 1);
      if (connectedCount === 0 && chatInstance !== null) {
        await chatInstance.shutdown();
        chatInstance = null;
        initPromise = null;
      }
    },
  };
}

/**
 * Builds a single ChatSdkChannelAdapter for one platform.
 */
function createPlatformChannelAdapter(
  platform: PlatformName,
  router: EventRouter,
  lifecycle: SharedLifecycle,
  injectedAdapters: Readonly<Record<string, unknown>>,
): ChatSdkChannelAdapter {
  const adapterName = `chat-sdk:${platform}`;
  const capabilities = capabilitiesForPlatform(platform);

  const resolveAdapter = (): Adapter => {
    const injected = injectedAdapters[platform] as Adapter | undefined;
    if (injected !== undefined) {
      return injected;
    }
    const chat = lifecycle.getChatInstance();
    if (chat !== null) {
      return chat.getAdapter(platform);
    }
    throw new Error(`Chat SDK adapter for "${platform}" not found`);
  };

  const base = createChannelAdapter<ChatSdkEvent>({
    name: adapterName,
    capabilities,
    platformConnect: lifecycle.connect,
    platformDisconnect: lifecycle.disconnect,

    platformSend: async (message: OutboundMessage): Promise<void> => {
      if (message.threadId === undefined) {
        throw new Error(`[${adapterName}] threadId is required to send a message`);
      }
      const postable = mapContentToPostable(message.content);
      const adapter = resolveAdapter();
      await adapter.postMessage(message.threadId, postable);
    },

    onPlatformEvent: (handler: (event: ChatSdkEvent) => void): (() => void) => {
      router.add(platform, handler);
      return (): void => {
        router.remove(platform, handler);
      };
    },

    normalize,

    platformSendStatus: async (status: ChannelStatus): Promise<void> => {
      if (status.kind !== "processing" || status.messageRef === undefined) {
        return;
      }
      const adapter = resolveAdapter();
      await adapter.startTyping(status.messageRef);
    },
  });

  return {
    ...base,
    platform,

    handleWebhook: async (
      request: Request,
      options?: { readonly waitUntil?: (p: Promise<unknown>) => void },
    ): Promise<Response> => {
      await lifecycle.ensureInitialized();

      const chat = lifecycle.getChatInstance();
      if (chat === null) {
        return new Response("Chat instance not initialized", { status: 503 });
      }

      const webhooks = chat.webhooks;
      const handler = (
        webhooks as Readonly<Record<string, (req: Request, opts?: unknown) => Promise<Response>>>
      )[platform];
      if (handler === undefined) {
        return new Response(`No webhook handler for platform "${platform}"`, { status: 404 });
      }

      return handler(request, options);
    },
  };
}

/**
 * Creates N ChannelAdapters backed by a shared Chat SDK instance.
 *
 * @param config - Validated ChatSdkChannelConfig with platforms array.
 * @param overrides - Test-only overrides for the Chat instance and adapters.
 * @returns One ChatSdkChannelAdapter per configured platform.
 */
export function createChatSdkChannels(
  config: ChatSdkChannelConfig,
  overrides?: ChatSdkTestOverrides,
): readonly ChatSdkChannelAdapter[] {
  const injectedAdapters = overrides?._adapters ?? {};
  const injectedChat = overrides?._chat ?? null;

  const router = createEventRouter(config.platforms);

  function dispatchChatEvent(thread: Thread, message: Message): void {
    const adapterName = thread.adapter.name;
    const handlers = router.get(adapterName);
    if (handlers.length === 0) {
      return;
    }

    const event: ChatSdkEvent = { thread, message, adapterName };
    for (const handler of handlers) {
      handler(event);
    }
  }

  function handleNewMention(thread: Thread, message: Message): void {
    void thread.subscribe();
    dispatchChatEvent(thread, message);
  }

  const lifecycle = createSharedLifecycle(config, injectedChat, injectedAdapters, (chat) => {
    chat.onNewMention(handleNewMention);
    chat.onSubscribedMessage(dispatchChatEvent);
  });

  return config.platforms.map((platformConfig) =>
    createPlatformChannelAdapter(platformConfig.platform, router, lifecycle, injectedAdapters),
  );
}
