/**
 * @koi/channel-discord — discord.js ChannelAdapter factory.
 *
 * Listens to messageCreate + interactionCreate via the Gateway WebSocket and
 * sends through the REST API. discord.js values are loaded via dynamic
 * import() so consumers only pay the bundle cost when they actually call
 * connect().
 */

import { createChannelAdapter } from "@koi/channel-base";
import type { ChannelAdapter, ChannelCapabilities, OutboundMessage } from "@koi/core";
import type {
  DiscordButtonInteractionLike,
  DiscordEvent,
  DiscordMessageLike,
  DiscordSlashCommandLike,
} from "./normalize.js";
import { createNormalizer } from "./normalize.js";

/** Discord Gateway intent names accepted at construction time. */
export type DiscordIntent =
  | "Guilds"
  | "GuildMessages"
  | "MessageContent"
  | "DirectMessages"
  | "GuildMembers"
  | "GuildMessageTyping"
  | "DirectMessageTyping";

const DEFAULT_INTENTS: readonly DiscordIntent[] = [
  "Guilds",
  "GuildMessages",
  "MessageContent",
  "DirectMessages",
];

/** Shape we need from a discord.js Client (Like-typed for test injection). */
export interface DiscordClientLike {
  readonly user: { readonly id: string } | null;
  readonly channels: { readonly cache: ReadonlyMap<string, DiscordSendTargetLike> };
  login(token: string): Promise<unknown>;
  destroy(): Promise<unknown> | unknown;
  on(event: string, listener: (...args: readonly unknown[]) => void): unknown;
  removeAllListeners(): unknown;
}

/** A channel-like object exposed by discord.js client.channels.cache.get(). */
export interface DiscordSendTargetLike {
  send(payload: DiscordSendPayload): Promise<unknown>;
}

/** Outbound payload shape (subset of discord.js MessageCreateOptions). */
export interface DiscordSendPayload {
  readonly content?: string;
  readonly embeds?: readonly Record<string, unknown>[];
  readonly components?: readonly Record<string, unknown>[];
  readonly files?: readonly { readonly attachment: string; readonly name: string }[];
}

/** A slash command definition consumed by registerCommands. */
export interface DiscordSlashCommand {
  readonly name: string;
  readonly description: string;
  readonly options?: readonly Record<string, unknown>[];
}

export interface DiscordChannelConfig {
  readonly token: string;
  readonly applicationId?: string;
  readonly intents?: readonly DiscordIntent[];
  /** Test-only client double. When set, login() is still called on it. */
  readonly client?: DiscordClientLike;
  readonly onHandlerError?: (err: unknown, ctx: unknown) => void;
}

export interface DiscordChannelAdapter extends ChannelAdapter {
  readonly registerCommands: (commands: readonly DiscordSlashCommand[]) => Promise<void>;
}

const DISCORD_CAPABILITIES: ChannelCapabilities = {
  text: true,
  images: true,
  files: true,
  buttons: true,
  audio: false,
  video: false,
  threads: true,
  supportsA2ui: false,
};

/** Discord's per-message text limit. */
const TEXT_LIMIT = 2000;
const MAX_EMBEDS = 10;
const MAX_ACTION_ROWS = 5;

/** Discord interaction tokens are valid for 15 minutes after creation. */
const INTERACTION_TTL_MS = 15 * 60 * 1000;

/** Internal: subset of a discord.js interaction we route replies through. */
interface InteractionResponseLike {
  editReply(payload: DiscordSendPayload): Promise<unknown>;
  followUp?(payload: DiscordSendPayload): Promise<unknown>;
}

export function createDiscordChannel(config: DiscordChannelConfig): DiscordChannelAdapter {
  // let requires justification: client is created lazily inside platformConnect
  // because instantiating the real discord.js Client opens cache structures we
  // don't want to pay for if the caller never connects.
  let client: DiscordClientLike | undefined = config.client;
  // let requires justification: bot user id resolved after login; used by normalizer
  let botUserId: string | undefined;
  // let requires justification: maps interaction id → live discord.js Interaction
  // so the first send() to threadId "interaction:<id>:<channelId>" routes
  // through editReply/followUp on the correct interaction handle. Entries are
  // dropped after first edit, on disconnect, or after INTERACTION_TTL_MS.
  const pendingInteractions = new Map<
    string,
    { readonly interaction: InteractionResponseLike; readonly expiresAt: number }
  >();

  const getClient = (): DiscordClientLike => {
    if (client === undefined) {
      throw new Error("[channel-discord] not connected");
    }
    return client;
  };

  const normalize = createNormalizer(() => botUserId);

  const base = createChannelAdapter<DiscordEvent>({
    name: "discord",
    capabilities: DISCORD_CAPABILITIES,

    platformConnect: async (): Promise<void> => {
      if (client === undefined) {
        client = await instantiateClient(config.intents ?? DEFAULT_INTENTS);
      }
      await client.login(config.token);
      botUserId = client.user?.id;
    },

    platformDisconnect: async (): Promise<void> => {
      if (client === undefined) return;
      client.removeAllListeners();
      await client.destroy();
      client = undefined;
      botUserId = undefined;
      pendingInteractions.clear();
    },

    platformSend: async (message: OutboundMessage): Promise<void> => {
      await sendOutbound(getClient(), pendingInteractions, message);
    },

    onPlatformEvent: (handler): (() => void) => {
      const c = getClient();
      const onMessageCreate = (...args: readonly unknown[]): void => {
        const m = toMessageLike(args[0]);
        if (m !== null) handler({ kind: "message", message: m });
      };
      const onInteractionCreate = (...args: readonly unknown[]): void => {
        const raw = args[0];
        // Eagerly acknowledge the interaction so the Discord client does not
        // show "This interaction failed" while the agent works. Fire-and-forget;
        // ack errors are non-fatal (e.g., already-acked).
        ackInteraction(raw);
        // Stash the interaction handle so the first outbound reply on its
        // threadId can route through editReply rather than channel.send.
        if (isPlainObject(raw) && typeof raw.id === "string" && isInteractionResponseLike(raw)) {
          pendingInteractions.set(raw.id, {
            interaction: raw,
            expiresAt: Date.now() + INTERACTION_TTL_MS,
          });
        }
        const ev = toInteractionEvent(raw);
        if (ev !== null) handler(ev);
      };
      c.on("messageCreate", onMessageCreate);
      c.on("interactionCreate", onInteractionCreate);
      return (): void => {
        c.removeAllListeners();
      };
    },

    normalize,

    ...(config.onHandlerError !== undefined && {
      onHandlerError: config.onHandlerError,
    }),
  });

  const registerCommands = async (commands: readonly DiscordSlashCommand[]): Promise<void> => {
    if (config.applicationId === undefined) {
      throw new Error("[channel-discord] applicationId is required to register commands");
    }
    const { REST, Routes } = await loadDiscordRest();
    const rest = new REST({ version: "10" }).setToken(config.token);
    await rest.put(Routes.applicationCommands(config.applicationId), {
      body: commands.map((c) => ({
        name: c.name,
        description: c.description,
        ...(c.options !== undefined ? { options: c.options } : {}),
      })),
    });
  };

  return { ...base, registerCommands };
}

/** Splits text on word boundaries, falling back to hard cuts at the limit. */
export function splitText(text: string, limit: number): readonly string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  // let requires justification: walks the input slicing into <= limit chunks
  let remaining = text;
  while (remaining.length > limit) {
    const breakAt = remaining.lastIndexOf("\n", limit);
    const cut = breakAt > limit / 2 ? breakAt : limit;
    out.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}

async function sendOutbound(
  client: DiscordClientLike,
  pendingInteractions: Map<
    string,
    { readonly interaction: InteractionResponseLike; readonly expiresAt: number }
  >,
  message: OutboundMessage,
): Promise<void> {
  if (message.threadId === undefined) {
    throw new Error("[channel-discord] OutboundMessage.threadId is required");
  }
  const payloads = buildPayloads(message.content);

  // Interaction-response path: when the inbound threadId is
  // "interaction:<id>:<channelId>", the first payload edits the deferred
  // reply on the original interaction (so the slash-command's "thinking..."
  // state resolves cleanly). Overflow payloads spill into the channel.
  const interactionId = parseInteractionIdFromThreadId(message.threadId);
  if (interactionId !== undefined) {
    const entry = pendingInteractions.get(interactionId);
    if (entry !== undefined && entry.expiresAt > Date.now() && payloads.length > 0) {
      pendingInteractions.delete(interactionId);
      const first = payloads[0];
      if (first !== undefined) await entry.interaction.editReply(first);
      const channelIdFallback = parseChannelIdFromThreadId(message.threadId);
      const channel = client.channels.cache.get(channelIdFallback);
      for (let i = 1; i < payloads.length; i++) {
        const p = payloads[i];
        if (p !== undefined && channel !== undefined) {
          await channel.send(p);
        }
      }
      return;
    }
    // Interaction expired/missing — fall through to channel.send
  }

  const channelId = parseChannelIdFromThreadId(message.threadId);
  const channel = client.channels.cache.get(channelId);
  if (channel === undefined) {
    throw new Error(`[channel-discord] channel not found for threadId "${message.threadId}"`);
  }
  for (const payload of payloads) {
    await channel.send(payload);
  }
}

function parseChannelIdFromThreadId(threadId: string): string {
  // "interaction:<id>:<channelId>" → <channelId>
  if (threadId.startsWith("interaction:")) {
    const rest = threadId.slice("interaction:".length);
    const idx = rest.indexOf(":");
    return idx < 0 ? rest : rest.slice(idx + 1);
  }
  const parts = threadId.split(":");
  // "guildId:channelId" → channelId; "dm:channelId" → channelId. Both forms
  // resolve through `client.channels.cache` keyed on channelId.
  return parts.length >= 2 ? (parts[1] ?? threadId) : threadId;
}

function parseInteractionIdFromThreadId(threadId: string): string | undefined {
  if (!threadId.startsWith("interaction:")) return undefined;
  const rest = threadId.slice("interaction:".length);
  const idx = rest.indexOf(":");
  return idx < 0 ? rest : rest.slice(0, idx);
}

function isInteractionResponseLike(
  raw: Record<string, unknown>,
): raw is Record<string, unknown> & InteractionResponseLike {
  return typeof raw.editReply === "function";
}

function buildPayloads(
  blocks: readonly import("@koi/core").ContentBlock[],
): readonly DiscordSendPayload[] {
  const payloads: DiscordSendPayload[] = [];
  // let requires justification: accumulators emptied between flushes
  let pendingText = "";
  let embeds: Record<string, unknown>[] = [];
  let components: Record<string, unknown>[] = [];
  let files: { readonly attachment: string; readonly name: string }[] = [];

  const flush = (): void => {
    const parts = pendingText.length > 0 ? splitText(pendingText, TEXT_LIMIT) : [];
    pendingText = "";
    if (
      parts.length === 0 &&
      embeds.length === 0 &&
      components.length === 0 &&
      files.length === 0
    ) {
      return;
    }
    const first: DiscordSendPayload = {
      ...(parts.length > 0 && parts[0] !== undefined ? { content: parts[0] } : {}),
      ...(embeds.length > 0 ? { embeds } : {}),
      ...(components.length > 0 ? { components } : {}),
      ...(files.length > 0 ? { files } : {}),
    };
    payloads.push(first);
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];
      if (p !== undefined) payloads.push({ content: p });
    }
    embeds = [];
    components = [];
    files = [];
  };

  for (const block of blocks) {
    switch (block.kind) {
      case "text":
        pendingText = pendingText.length > 0 ? `${pendingText}\n${block.text}` : block.text;
        break;
      case "image":
        embeds.push({
          image: { url: block.url },
          ...(block.alt !== undefined ? { description: block.alt } : {}),
        });
        if (embeds.length >= MAX_EMBEDS) flush();
        break;
      case "file":
        files.push({ attachment: block.url, name: block.name ?? "file" });
        break;
      case "button":
        components.push({
          type: 1,
          components: [{ type: 2, style: 1, label: block.label, custom_id: block.action }],
        });
        if (components.length >= MAX_ACTION_ROWS) flush();
        break;
      case "custom":
        if (block.type === "discord:embed" && isPlainObject(block.data)) {
          embeds.push(block.data);
          if (embeds.length >= MAX_EMBEDS) flush();
        } else if (block.type === "discord:action_row" && isPlainObject(block.data)) {
          components.push(block.data);
          if (components.length >= MAX_ACTION_ROWS) flush();
        }
        break;
    }
  }
  flush();
  return payloads;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Calls deferReply() on slash commands and deferUpdate() on button presses so
 * the user does not see "This interaction failed" while the agent decides what
 * to send. The actual response still goes through the channel `send()` path.
 */
function ackInteraction(raw: unknown): void {
  if (!isPlainObject(raw)) return;
  if (typeof raw.isChatInputCommand === "function" && raw.isChatInputCommand() === true) {
    const fn = raw.deferReply;
    if (typeof fn === "function") {
      try {
        void Promise.resolve(fn.call(raw)).catch(() => undefined);
      } catch {
        // sync throw from defer*() — swallow; the agent response can still go through
      }
    }
    return;
  }
  if (typeof raw.isButton === "function" && raw.isButton() === true) {
    const fn = raw.deferUpdate;
    if (typeof fn === "function") {
      try {
        void Promise.resolve(fn.call(raw)).catch(() => undefined);
      } catch {
        // sync throw from defer*() — swallow; the agent response can still go through
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Inbound coercions: discord.js objects → our Like shapes
// ---------------------------------------------------------------------------

function toMessageLike(raw: unknown): DiscordMessageLike | null {
  if (!isPlainObject(raw)) return null;
  const author = raw.author;
  if (!isPlainObject(author) || typeof author.id !== "string") return null;
  const content = typeof raw.content === "string" ? raw.content : "";
  const channelId = typeof raw.channelId === "string" ? raw.channelId : "";
  const guildId = typeof raw.guildId === "string" ? raw.guildId : null;
  const id = typeof raw.id === "string" ? raw.id : "";
  const ts = typeof raw.createdTimestamp === "number" ? raw.createdTimestamp : Date.now();
  const attachments = coerceAttachments(raw.attachments);
  const isThread =
    typeof raw.channel === "object" && raw.channel !== null
      ? typeof (raw.channel as Record<string, unknown>).isThread === "function"
      : false;
  return {
    id,
    content,
    author: { id: author.id, bot: author.bot === true },
    channelId,
    guildId,
    createdTimestamp: ts,
    attachments,
    isThread,
  };
}

function coerceAttachments(
  raw: unknown,
): ReadonlyMap<string, import("./normalize.js").DiscordAttachment> {
  const out = new Map<string, import("./normalize.js").DiscordAttachment>();
  if (raw instanceof Map) {
    for (const [k, v] of raw) {
      if (!isPlainObject(v)) continue;
      out.set(String(k), {
        url: typeof v.url === "string" ? v.url : "",
        name: typeof v.name === "string" ? v.name : null,
        contentType: typeof v.contentType === "string" ? v.contentType : null,
      });
    }
  }
  return out;
}

function toInteractionEvent(raw: unknown): DiscordEvent | null {
  if (!isPlainObject(raw)) return null;
  const userField = raw.user;
  const userId = isPlainObject(userField) && typeof userField.id === "string" ? userField.id : "";
  const channelId = typeof raw.channelId === "string" ? raw.channelId : "";
  const guildId = typeof raw.guildId === "string" ? raw.guildId : null;
  const id = typeof raw.id === "string" ? raw.id : "";
  const ts = typeof raw.createdTimestamp === "number" ? raw.createdTimestamp : Date.now();

  if (typeof raw.isChatInputCommand === "function" && raw.isChatInputCommand() === true) {
    const cmd: DiscordSlashCommandLike = {
      kind: "slash_command",
      id,
      name: typeof raw.commandName === "string" ? raw.commandName : "",
      options: extractCommandOptions(raw.options),
      userId,
      channelId,
      guildId,
      createdTimestamp: ts,
    };
    return { kind: "slash_command", command: cmd };
  }
  if (typeof raw.isButton === "function" && raw.isButton() === true) {
    const btn: DiscordButtonInteractionLike = {
      kind: "button",
      id,
      customId: typeof raw.customId === "string" ? raw.customId : "",
      userId,
      channelId,
      guildId,
      createdTimestamp: ts,
    };
    return { kind: "button", button: btn };
  }
  return null;
}

function extractCommandOptions(
  opts: unknown,
): readonly { readonly name: string; readonly value: string | number | boolean | null }[] {
  if (!isPlainObject(opts) || typeof (opts as Record<string, unknown>).data === "undefined") {
    return [];
  }
  const data = (opts as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  const out: { readonly name: string; readonly value: string | number | boolean | null }[] = [];
  for (const item of data) {
    if (!isPlainObject(item) || typeof item.name !== "string") continue;
    const v = item.value;
    out.push({
      name: item.name,
      value: typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lazy loaders for discord.js runtime modules
// ---------------------------------------------------------------------------

interface DiscordRestModule {
  readonly REST: new (opts: {
    readonly version: string;
  }) => {
    setToken: (t: string) => {
      put: (path: string, body: { readonly body: unknown }) => Promise<unknown>;
    };
  };
  readonly Routes: { readonly applicationCommands: (appId: string) => string };
}

async function instantiateClient(intents: readonly DiscordIntent[]): Promise<DiscordClientLike> {
  const mod = (await import("discord.js")) as unknown as {
    readonly Client: new (opts: { readonly intents: readonly number[] }) => DiscordClientLike;
    readonly GatewayIntentBits: Record<DiscordIntent, number>;
  };
  const bits = intents.map((name) => mod.GatewayIntentBits[name]);
  return new mod.Client({ intents: bits });
}

async function loadDiscordRest(): Promise<DiscordRestModule> {
  const mod = (await import("discord.js")) as unknown as DiscordRestModule;
  return mod;
}
