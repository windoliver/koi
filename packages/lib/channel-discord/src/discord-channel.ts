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
  readonly channels: {
    readonly cache: ReadonlyMap<string, DiscordSendTargetLike>;
    /** Falls back to a REST fetch when the channel is not cached. */
    fetch?(id: string): Promise<DiscordSendTargetLike | null>;
  };
  login(token: string): Promise<unknown>;
  destroy(): Promise<unknown> | unknown;
  on(event: string, listener: (...args: readonly unknown[]) => void): unknown;
  /**
   * Remove a single previously-registered listener. Required when the
   * adapter is given an injected client (caller-owned) so that adapter
   * teardown does not nuke listeners belonging to other features sharing
   * the same Client. discord.js Client implements `off` natively.
   */
  off(event: string, listener: (...args: readonly unknown[]) => void): unknown;
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
  /**
   * When true, accept inbound messages from other bots and webhooks. By
   * default the adapter drops every bot-authored message (not just our
   * own) so a third-party bot in a shared Discord server cannot prompt
   * this agent or trigger tools through cross-bot loops. Slash commands
   * and button interactions are unaffected — those originate from human
   * users by Discord's API contract.
   */
  readonly allowBots?: boolean;
  /**
   * Controls slash-command reply visibility. Discord requires the
   * adapter to call `deferReply()` within 3 seconds of an interaction
   * arriving, BEFORE the agent decides what to say — so visibility must
   * be chosen at ack time. `true` defers every slash command as
   * ephemeral (only the invoking user sees the reply); `false` (default)
   * defers as a public reply. A function lets callers route by command
   * name (e.g. `whoami`/diagnostics ephemeral, public commands public).
   */
  readonly slashCommandEphemeral?: boolean | ((commandName: string) => boolean);
  /**
   * When true, an `interaction:cmd:...` thread whose live interaction
   * has expired (15-minute Discord token TTL) or been lost across a
   * reconnect falls through to `channel.send()` on the same channel.
   * Default `false` — fail closed. Posting late results publicly after
   * Discord has already shown the user "interaction failed" creates
   * duplicate side effects when the user retries.
   */
  readonly slashCommandFallbackToChannel?: boolean;
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
/** Discord rejects messages with more than 10 attachments. */
const MAX_ATTACHMENTS = 10;

/** Discord interaction tokens are valid for 15 minutes after creation. */
const INTERACTION_TTL_MS = 15 * 60 * 1000;

/** Internal: subset of a discord.js interaction we route replies through. */
interface InteractionResponseLike {
  editReply(payload: DiscordSendPayload): Promise<unknown>;
  followUp?(payload: DiscordSendPayload): Promise<unknown>;
}

/**
 * Slash commands edit their deferred reply (the "thinking..." state).
 * Buttons follow up with a NEW message so we don't clobber the source
 * message that contained the button — and so ephemeral component
 * interactions stay scoped to the user who clicked them.
 */
type InteractionReplyKind = "slash" | "button";

interface PendingInteraction {
  readonly interaction: InteractionResponseLike;
  readonly kind: InteractionReplyKind;
  readonly expiresAt: number;
}

export function createDiscordChannel(config: DiscordChannelConfig): DiscordChannelAdapter {
  // let requires justification: client is created lazily inside platformConnect
  // because instantiating the real discord.js Client opens cache structures we
  // don't want to pay for if the caller never connects.
  let client: DiscordClientLike | undefined = config.client;
  // Lifecycle ownership: true when the adapter created the Client itself.
  // For caller-injected clients we must NOT call destroy() or
  // removeAllListeners() — those wipe listeners and tear down a gateway
  // session that other features in the same process may share. We can
  // only remove the specific listeners we registered.
  // let requires justification: flipped at platformConnect when we
  // instantiate our own Client; remains false for injected clients.
  let clientOwnedByAdapter = false;
  // let requires justification: bot user id resolved after login; used by normalizer
  let botUserId: string | undefined;
  // let requires justification: maps interaction id → live discord.js Interaction
  // so the first send() to threadId "interaction:<id>:<channelId>" routes
  // through editReply/followUp on the correct interaction handle. Entries are
  // dropped after first edit, on disconnect, or after INTERACTION_TTL_MS.
  const pendingInteractions = new Map<string, PendingInteraction>();

  const getClient = (): DiscordClientLike => {
    if (client === undefined) {
      throw new Error("[channel-discord] not connected");
    }
    return client;
  };

  const normalize = createNormalizer(
    () => botUserId,
    config.allowBots === true ? { allowBots: true } : {},
  );

  // let requires justification: the dispatch handler is set by onPlatformEvent
  // after platformConnect has already attached gateway listeners. We register
  // listeners BEFORE client.login() to close the race where Discord delivers
  // events between login and listener attachment, AND we buffer events that
  // arrive before onPlatformEvent installs the dispatcher (createChannelAdapter
  // calls platformConnect before onPlatformEvent — there is otherwise a window
  // during login/READY where slash commands would be silently dropped with no
  // retry path on the gateway).
  let dispatch: ((event: DiscordEvent) => void) | undefined;
  // let requires justification: drained when dispatch is installed.
  // The buffer is unbounded: silently truncating oldest entries (the
  // previous 256-cap) caused user-visible message loss during the
  // login/READY window on busy guilds. The handler-install window is
  // bounded by channel-base's connect() — measured in seconds at most —
  // so unbounded growth is bounded in practice. If onPlatformEvent never
  // fires, the host has bigger problems and OOM surfaces it visibly.
  let pending: DiscordEvent[] = [];

  const deliver = (event: DiscordEvent): void => {
    if (dispatch !== undefined) {
      dispatch(event);
      return;
    }
    pending.push(event);
  };

  const onMessageCreate = (...args: readonly unknown[]): void => {
    const m = toMessageLike(args[0]);
    if (m !== null) deliver({ kind: "message", message: m });
  };
  const onInteractionCreate = (...args: readonly unknown[]): void => {
    const raw = args[0];
    // Eagerly acknowledge the interaction so the Discord client does not
    // show "This interaction failed" while the agent works. Fire-and-forget;
    // ack errors are non-fatal (e.g., already-acked).
    ackInteraction(raw, config.slashCommandEphemeral);
    // Sweep expired entries every time a new interaction arrives. This
    // bounds memory under traffic for slash commands the agent never
    // replies to (handler dropped the event, decided not to answer,
    // crashed, etc.) without scheduling a separate timer.
    sweepExpiredInteractions(pendingInteractions);
    // Stash both slash-command and button interactions so replies route
    // through the interaction object (preserving ephemeral / private
    // scope) rather than the channel. Slash commands edit the deferred
    // reply; buttons followUp() (so the source message containing the
    // button is left intact and ephemeral interactions stay user-scoped).
    if (isPlainObject(raw) && typeof raw.id === "string" && isInteractionResponseLike(raw)) {
      const isSlash =
        typeof raw.isChatInputCommand === "function" && raw.isChatInputCommand() === true;
      const isButton = typeof raw.isButton === "function" && raw.isButton() === true;
      if (isSlash || isButton) {
        pendingInteractions.set(raw.id, {
          interaction: raw,
          kind: isSlash ? "slash" : "button",
          expiresAt: Date.now() + INTERACTION_TTL_MS,
        });
      }
    }
    const ev = toInteractionEvent(raw);
    if (ev !== null) deliver(ev);
  };

  const base = createChannelAdapter<DiscordEvent>({
    name: "discord",
    capabilities: DISCORD_CAPABILITIES,

    platformConnect: async (): Promise<void> => {
      if (client === undefined) {
        client = await instantiateClient(config.intents ?? DEFAULT_INTENTS);
        clientOwnedByAdapter = true;
      }
      const c = client;
      // Attach gateway listeners BEFORE login so we don't miss the first
      // events the WebSocket delivers right after READY.
      c.on("messageCreate", onMessageCreate);
      c.on("interactionCreate", onInteractionCreate);
      try {
        await c.login(config.token);
      } catch (err: unknown) {
        // Roll back ONLY the listeners we registered. removeAllListeners
        // would nuke handlers belonging to other features sharing an
        // injected client; destroy() is reserved for clients we own.
        c.off("messageCreate", onMessageCreate);
        c.off("interactionCreate", onInteractionCreate);
        if (clientOwnedByAdapter) {
          try {
            await c.destroy();
          } catch {
            // best-effort — original error matters more
          }
          client = undefined;
          clientOwnedByAdapter = false;
        }
        pending = [];
        throw err;
      }
      botUserId = c.user?.id;
    },

    platformDisconnect: async (): Promise<void> => {
      if (client === undefined) return;
      // Detach only our listeners. An injected (caller-owned) Client
      // remains alive and continues serving its other consumers.
      client.off("messageCreate", onMessageCreate);
      client.off("interactionCreate", onInteractionCreate);
      if (clientOwnedByAdapter) {
        await client.destroy();
        clientOwnedByAdapter = false;
      }
      client = undefined;
      botUserId = undefined;
      dispatch = undefined;
      pending = [];
      pendingInteractions.clear();
    },

    platformSend: async (message: OutboundMessage): Promise<void> => {
      await sendOutbound(getClient(), pendingInteractions, message, {
        slashCommandFallbackToChannel: config.slashCommandFallbackToChannel === true,
        slashCommandEphemeralConfigured: config.slashCommandEphemeral !== undefined,
      });
    },

    onPlatformEvent: (handler): (() => void) => {
      dispatch = handler;
      // Drain events that arrived during the connect window (after listener
      // attachment but before this handler was installed). Without this,
      // slash commands sent during login/READY would be silently dropped.
      const drained = pending;
      pending = [];
      for (const ev of drained) handler(ev);
      return (): void => {
        dispatch = undefined;
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
  pendingInteractions: Map<string, PendingInteraction>,
  message: OutboundMessage,
  options: {
    readonly slashCommandFallbackToChannel: boolean;
    readonly slashCommandEphemeralConfigured: boolean;
  },
): Promise<void> {
  if (message.threadId === undefined) {
    throw new Error("[channel-discord] OutboundMessage.threadId is required");
  }
  const payloads = buildPayloads(message.content);

  // Interaction-response path: when the inbound threadId is
  // "interaction:<id>:<channelId>", route through the interaction object
  // so ephemeral / private scope is preserved. Slash commands edit their
  // deferred reply (cleanly resolving the "thinking..." state); buttons
  // followUp() with a NEW message (so the source message containing the
  // button is left intact and ephemeral component interactions stay
  // user-scoped instead of leaking into the channel).
  // Overflow payloads also use followUp() so they share the same
  // visibility scope as the first reply.
  // One logical OutboundMessage may map to several Discord API calls
  // (long text → text chunks, attachment batching, interaction overflow).
  // Each call is non-revertible, so a transient failure mid-way leaves
  // earlier payloads delivered to the user. Track the count so the
  // error escalates to a typed partial-delivery surface — retry/queue
  // middleware MUST detect it and refuse to blindly resend the same
  // OutboundMessage (which would duplicate the already-delivered
  // chunks).
  // let requires justification: accumulates across sub-calls below
  let delivered = 0;
  const tryStep = async (step: () => Promise<unknown>): Promise<void> => {
    try {
      await step();
      delivered++;
    } catch (err: unknown) {
      if (delivered === 0) throw err;
      throw new DiscordPartialDeliveryError(delivered, err);
    }
  };

  const parsed = parseInteractionThread(message.threadId);
  if (parsed !== undefined) {
    const entry = pendingInteractions.get(parsed.interactionId);
    if (entry !== undefined && entry.expiresAt > Date.now() && payloads.length > 0) {
      const first = payloads[0];
      const followUp = entry.interaction.followUp;
      if (entry.kind === "button") {
        if (typeof followUp !== "function") {
          throw new Error(
            `[channel-discord] button interaction "${parsed.interactionId}" missing followUp() — cannot reply without leaking out of ephemeral scope`,
          );
        }
        // Keep the entry until the first followUp() succeeds so a transient
        // failure can be retried on the same threadId without losing the
        // interaction handle (which would otherwise force the retry to
        // hard-fail per the button-fail-closed rule above).
        if (first !== undefined) await tryStep(() => followUp.call(entry.interaction, first));
        pendingInteractions.delete(parsed.interactionId);
        for (let i = 1; i < payloads.length; i++) {
          const p = payloads[i];
          if (p !== undefined) await tryStep(() => followUp.call(entry.interaction, p));
        }
        return;
      }
      // slash — keep the entry until editReply() succeeds so transient
      // failures (network, 5xx) can be retried on the same threadId.
      if (first !== undefined) await tryStep(() => entry.interaction.editReply(first));
      pendingInteractions.delete(parsed.interactionId);
      if (payloads.length > 1) {
        if (typeof followUp === "function") {
          for (let i = 1; i < payloads.length; i++) {
            const p = payloads[i];
            if (p !== undefined) await tryStep(() => followUp.call(entry.interaction, p));
          }
        } else {
          const channel = await resolveChannel(client, parsed.channelId);
          if (channel === null) {
            throw new Error(
              `[channel-discord] interaction overflow channel not found for "${message.threadId}" — refusing to silently drop ${payloads.length - 1} payload(s)`,
            );
          }
          for (let i = 1; i < payloads.length; i++) {
            const p = payloads[i];
            if (p !== undefined) await tryStep(() => channel.send(p));
          }
        }
      }
      return;
    }
    // Interaction expired/missing. For BUTTON threads, fail closed: the
    // interaction was ephemeral or otherwise scoped, and falling through
    // to channel.send would repost a private reply publicly. For slash
    // commands the default is also fail-closed: Discord has already
    // shown the user "interaction failed" by the time the token
    // expired, so a late public repost creates duplicate side effects
    // when the user retries. Callers can opt in via
    // `slashCommandFallbackToChannel: true` when duplicates are
    // tolerable for their workflow.
    if (parsed.kind === "button") {
      throw new Error(
        `[channel-discord] button interaction "${parsed.interactionId}" expired or missing — refusing channel fallback to preserve ephemeral scope`,
      );
    }
    // Slash commands deferred as ephemeral MUST NOT fall back to a
    // public channel send: that would expose a private reply (auth
    // tokens, PII, command output the user marked sensitive) in the
    // visible channel. Refuse the fallback whenever the operator
    // configured ephemeral semantics for slash commands at all — we
    // cannot tell from the expired interaction alone which branch the
    // ack used, so fail closed.
    if (options.slashCommandEphemeralConfigured) {
      throw new Error(
        `[channel-discord] slash interaction "${parsed.interactionId}" expired or missing AND slashCommandEphemeral is configured — refusing channel fallback to prevent leaking an ephemeral reply publicly`,
      );
    }
    if (!options.slashCommandFallbackToChannel) {
      throw new Error(
        `[channel-discord] slash interaction "${parsed.interactionId}" expired or missing — channel fallback disabled (set slashCommandFallbackToChannel: true to opt in)`,
      );
    }
  }

  const channelId = parseChannelIdFromThreadId(message.threadId);
  const channel = await resolveChannel(client, channelId);
  if (channel === null) {
    throw new Error(`[channel-discord] channel not found for threadId "${message.threadId}"`);
  }
  for (const payload of payloads) {
    await tryStep(() => channel.send(payload));
  }
}

/**
 * Thrown when a multi-payload Discord send fails after at least one
 * payload has already been delivered. Retry/queue middleware should
 * detect this error class and NOT blindly retry the same `OutboundMessage` —
 * doing so would duplicate the already-sent chunks (long-text overflow,
 * batched attachments, or interaction-overflow followUps). Surface to
 * the caller so they can compose a manual recovery (e.g. resend only
 * the missing chunks) or accept partial delivery.
 */
export class DiscordPartialDeliveryError extends Error {
  readonly deliveredParts: number;
  override readonly cause: unknown;
  constructor(deliveredParts: number, cause: unknown) {
    super(
      `[channel-discord] partial delivery: ${deliveredParts} payload(s) sent before failure; retrying the same OutboundMessage will duplicate them`,
    );
    this.name = "DiscordPartialDeliveryError";
    this.deliveredParts = deliveredParts;
    this.cause = cause;
  }
}

/** Resolves a channel id through the cache, falling back to a REST fetch. */
async function resolveChannel(
  client: DiscordClientLike,
  channelId: string,
): Promise<DiscordSendTargetLike | null> {
  const cached = client.channels.cache.get(channelId);
  if (cached !== undefined) return cached;
  if (typeof client.channels.fetch === "function") {
    try {
      const fetched = await client.channels.fetch(channelId);
      return fetched ?? null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Parsed shape of `interaction:<kind>:<id>:<channelId>`. */
interface ParsedInteractionThread {
  readonly kind: InteractionReplyKind;
  readonly interactionId: string;
  readonly channelId: string;
}

function parseInteractionThread(threadId: string): ParsedInteractionThread | undefined {
  if (!threadId.startsWith("interaction:")) return undefined;
  const parts = threadId.slice("interaction:".length).split(":");
  // Expected: [kind, id, channelId]. Older threadIds without the kind
  // discriminator are rejected — the safety story (slash vs button
  // routing) depends on the discriminator being present.
  if (parts.length < 3) return undefined;
  const [kind, interactionId, channelId] = parts;
  if (interactionId === undefined || channelId === undefined) return undefined;
  if (kind !== "cmd" && kind !== "btn") return undefined;
  return { kind: kind === "cmd" ? "slash" : "button", interactionId, channelId };
}

function parseChannelIdFromThreadId(threadId: string): string {
  const parsed = parseInteractionThread(threadId);
  if (parsed !== undefined) return parsed.channelId;
  const parts = threadId.split(":");
  // "guildId:channelId" → channelId; "dm:channelId" → channelId. Both forms
  // resolve through `client.channels.cache` keyed on channelId.
  return parts.length >= 2 ? (parts[1] ?? threadId) : threadId;
}

function isInteractionResponseLike(
  raw: Record<string, unknown>,
): raw is Record<string, unknown> & InteractionResponseLike {
  return typeof raw.editReply === "function";
}

/** Removes entries whose interaction tokens have expired (15 min). */
function sweepExpiredInteractions(map: Map<string, PendingInteraction>): void {
  const now = Date.now();
  for (const [id, entry] of map) {
    if (entry.expiresAt <= now) map.delete(id);
  }
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
        // Discord rejects > 10 attachments on a single message; flush before
        // we cross the cap so a batch with many file blocks splits into
        // multiple deliveries instead of failing as a single rejected send.
        if (files.length >= MAX_ATTACHMENTS) flush();
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
 *
 * Slash-command visibility (public vs ephemeral) is locked in at defer time
 * — Discord does not let callers downgrade an interaction from public to
 * ephemeral once the deferred reply has been claimed. The `ephemeralPolicy`
 * arg is consulted here so trust-sensitive commands can be deferred
 * privately.
 */
function ackInteraction(
  raw: unknown,
  ephemeralPolicy: boolean | ((commandName: string) => boolean) | undefined,
): void {
  if (!isPlainObject(raw)) return;
  if (typeof raw.isChatInputCommand === "function" && raw.isChatInputCommand() === true) {
    const fn = raw.deferReply;
    if (typeof fn === "function") {
      const commandName = typeof raw.commandName === "string" ? raw.commandName : "";
      const ephemeral =
        typeof ephemeralPolicy === "function"
          ? ephemeralPolicy(commandName)
          : ephemeralPolicy === true;
      try {
        const arg = ephemeral ? { ephemeral: true } : undefined;
        void Promise.resolve(arg === undefined ? fn.call(raw) : fn.call(raw, arg)).catch(
          () => undefined,
        );
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
    readonly Client: new (opts: {
      readonly intents: readonly number[];
      readonly partials?: readonly number[];
    }) => DiscordClientLike;
    readonly GatewayIntentBits: Record<DiscordIntent, number>;
    readonly Partials: { readonly Channel: number; readonly Message: number };
  };
  const bits = intents.map((name) => mod.GatewayIntentBits[name]);
  // discord.js delivers DM `messageCreate` events through *partial* Channel
  // structures (and partial Message structures for old DMs). Without
  // Partials.Channel + Partials.Message enabled, the very DM events the
  // adapter advertises support for never reach the listener.
  const partials =
    intents.includes("DirectMessages") && mod.Partials !== undefined
      ? [mod.Partials.Channel, mod.Partials.Message]
      : undefined;
  return new mod.Client(partials !== undefined ? { intents: bits, partials } : { intents: bits });
}

async function loadDiscordRest(): Promise<DiscordRestModule> {
  const mod = (await import("discord.js")) as unknown as DiscordRestModule;
  return mod;
}
