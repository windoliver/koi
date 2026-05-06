import { describe, expect, spyOn, test } from "bun:test";
import type { OutboundMessage } from "@koi/core";
import {
  createDiscordChannel,
  type DiscordClientLike,
  type DiscordSendPayload,
  type DiscordSendTargetLike,
  splitText,
} from "./discord-channel.js";

interface SentRecord {
  readonly channelId: string;
  readonly payload: DiscordSendPayload;
}

function fakeClient(): {
  readonly client: DiscordClientLike;
  readonly sent: readonly SentRecord[];
  readonly emit: (event: string, payload: unknown) => void;
} {
  const sent: SentRecord[] = [];
  const listeners: Record<string, ((...a: readonly unknown[]) => void)[]> = {};
  const cache = new Map<string, DiscordSendTargetLike>();
  const makeChannel = (id: string): DiscordSendTargetLike => ({
    send: async (payload) => {
      sent.push({ channelId: id, payload });
      return undefined;
    },
  });
  cache.set("C1", makeChannel("C1"));
  // DM channel id (distinct from any user id) — discord.js caches DM channels
  // by channel id, so the test fixture mirrors that.
  cache.set("DM_CHAN", makeChannel("DM_CHAN"));

  const client: DiscordClientLike = {
    user: { id: "BOT" },
    channels: { cache },
    login: async () => undefined,
    destroy: () => undefined,
    on: (event: string, listener: (...a: readonly unknown[]) => void) => {
      const bucket = listeners[event] ?? [];
      bucket.push(listener);
      listeners[event] = bucket;
      return undefined;
    },
    off: (event: string, listener: (...a: readonly unknown[]) => void) => {
      const bucket = listeners[event];
      if (bucket !== undefined) {
        listeners[event] = bucket.filter((l) => l !== listener);
      }
      return undefined;
    },
    removeAllListeners: () => {
      for (const k of Object.keys(listeners)) listeners[k] = [];
      return undefined;
    },
  };
  return {
    client,
    sent,
    emit: (event, payload) => {
      for (const l of listeners[event] ?? []) l(payload);
    },
  };
}

describe("@koi/channel-discord createDiscordChannel", () => {
  test("a failed login removes listeners so retried connect dispatches each event once", async () => {
    const base = fakeClient();
    let attempts = 0;
    const wrapped: DiscordClientLike = {
      ...base.client,
      login: async () => {
        attempts++;
        if (attempts === 1) throw new Error("401 Unauthorized");
        return undefined;
      },
    };
    const adapter = createDiscordChannel({ token: "T", client: wrapped });
    await expect(adapter.connect()).rejects.toThrow(/401/);
    // Retry — succeeds. Listeners from the failed attempt must NOT have
    // survived; otherwise each emit would fan out into 2+ dispatches.
    await adapter.connect();
    const seen: unknown[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m);
    });
    base.emit("messageCreate", {
      id: "m1",
      content: "hi",
      author: { id: "U1", bot: false },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 1,
      attachments: new Map(),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    await adapter.disconnect();
  });

  test("connect calls login; disconnect does NOT destroy an injected (caller-owned) client", async () => {
    const { client } = fakeClient();
    let logins = 0;
    let destroys = 0;
    let removeAllCalls = 0;
    const wrapped: DiscordClientLike = {
      ...client,
      login: async () => {
        logins++;
        return undefined;
      },
      destroy: () => {
        destroys++;
        return undefined;
      },
      removeAllListeners: () => {
        removeAllCalls++;
        return undefined;
      },
    };
    const adapter = createDiscordChannel({ token: "T", client: wrapped });
    await adapter.connect();
    expect(logins).toBe(1);
    await adapter.disconnect();
    // Lifecycle ownership stays with the caller — destroy() and the
    // listener-nuke must never run on a shared/injected Client.
    expect(destroys).toBe(0);
    expect(removeAllCalls).toBe(0);
  });

  test("disconnect leaves unrelated listeners on an injected client intact", async () => {
    const f = fakeClient();
    const otherFeatureCalls: unknown[] = [];
    // Simulate another consumer of the same shared discord.js Client
    // attaching its own messageCreate listener BEFORE the channel is
    // wired in. Adapter teardown must not nuke this listener.
    f.client.on("messageCreate", (m: unknown) => {
      otherFeatureCalls.push(m);
    });
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    await adapter.disconnect();
    f.emit("messageCreate", {
      id: "m1",
      content: "hi",
      author: { id: "U1", bot: false },
      channelId: "C1",
    });
    expect(otherFeatureCalls).toHaveLength(1);
  });

  test("inbound messageCreate dispatches an InboundMessage to handlers", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    const received: unknown[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });
    f.emit("messageCreate", {
      id: "m1",
      content: "hi",
      author: { id: "U1", bot: false },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 100,
      attachments: new Map(),
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(1);
    await adapter.disconnect();
  });

  test("messages from OTHER bots/webhooks are dropped by default (no cross-bot ingress)", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    const received: unknown[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });
    f.emit("messageCreate", {
      id: "m1",
      content: "from-stranger-bot",
      author: { id: "OTHER_BOT", bot: true },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 100,
      attachments: new Map(),
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(0);
    await adapter.disconnect();
  });

  test("allowBots: true opts in to cross-bot ingress", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client, allowBots: true });
    await adapter.connect();
    const received: unknown[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });
    f.emit("messageCreate", {
      id: "m1",
      content: "from-friendly-bot",
      author: { id: "OTHER_BOT", bot: true },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 100,
      attachments: new Map(),
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(1);
    await adapter.disconnect();
  });

  test("inbound messages from the bot user are dropped", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    const received: unknown[] = [];
    adapter.onMessage(async (m) => {
      received.push(m);
    });
    f.emit("messageCreate", {
      id: "m1",
      content: "loop",
      author: { id: "BOT", bot: true },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 100,
      attachments: new Map(),
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toHaveLength(0);
    await adapter.disconnect();
  });

  test("send routes to channels.cache by threadId guildId:channelId", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    const out: OutboundMessage = {
      content: [{ kind: "text", text: "hello world" }],
      threadId: "G1:C1",
    };
    await adapter.send(out);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.channelId).toBe("C1");
    expect(f.sent[0]?.payload.content).toBe("hello world");
    await adapter.disconnect();
  });

  test("send throws when channel not in cache", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    await expect(
      adapter.send({ content: [{ kind: "text", text: "x" }], threadId: "G9:C9" }),
    ).rejects.toThrow(/channel not found/);
    await adapter.disconnect();
  });

  test("send throws when threadId is missing", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    await expect(adapter.send({ content: [{ kind: "text", text: "x" }] })).rejects.toThrow(
      /threadId is required/,
    );
    await adapter.disconnect();
  });

  test("button block becomes an action_row component in payload", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    await adapter.send({
      content: [{ kind: "button", label: "OK", action: "ok" }],
      threadId: "G1:C1",
    });
    const components = f.sent[0]?.payload.components;
    expect(components).toBeDefined();
    expect(components?.[0]?.type).toBe(1);
    await adapter.disconnect();
  });

  test("discord:embed custom block is sent as embed", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    await adapter.send({
      content: [{ kind: "custom", type: "discord:embed", data: { title: "T", description: "D" } }],
      threadId: "G1:C1",
    });
    const embeds = f.sent[0]?.payload.embeds;
    expect(embeds).toEqual([{ title: "T", description: "D" }]);
    await adapter.disconnect();
  });

  test("text > 2000 chars is split into multiple payloads", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    const big = "x".repeat(4500);
    await adapter.send({ content: [{ kind: "text", text: big }], threadId: "G1:C1" });
    expect(f.sent.length).toBeGreaterThanOrEqual(3);
    await adapter.disconnect();
  });

  test("registerCommands throws without applicationId", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await expect(adapter.registerCommands([])).rejects.toThrow(/applicationId/);
  });
});

describe("createDiscordChannel — interaction reply path", () => {
  test("first reply on interaction:<id>:<channelId> threadId routes through editReply", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    const edits: DiscordSendPayload[] = [];
    f.emit("interactionCreate", {
      id: "i100",
      isChatInputCommand: () => true,
      isButton: () => false,
      commandName: "say",
      options: { data: [] },
      user: { id: "U1" },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 1,
      deferReply: async () => undefined,
      editReply: async (p: DiscordSendPayload) => {
        edits.push(p);
        return undefined;
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    await adapter.send({
      content: [{ kind: "text", text: "answer" }],
      threadId: "interaction:cmd:i100:C1",
    });
    expect(edits).toHaveLength(1);
    expect(edits[0]?.content).toBe("answer");
    // The channel.send path should NOT have been called for the first payload.
    expect(f.sent).toHaveLength(0);
    await adapter.disconnect();
  });

  test("second reply on the same interaction threadId fails closed by default (no late duplicate)", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    f.emit("interactionCreate", {
      id: "i101",
      isChatInputCommand: () => true,
      isButton: () => false,
      commandName: "say",
      options: { data: [] },
      user: { id: "U1" },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 1,
      deferReply: async () => undefined,
      editReply: async () => undefined,
    });
    await new Promise((r) => setTimeout(r, 5));
    await adapter.send({
      content: [{ kind: "text", text: "first" }],
      threadId: "interaction:cmd:i101:C1",
    });
    // Default: no fallback. Discord has shown the user the result via
    // the deferred reply; reposting publicly would create duplicates.
    await expect(
      adapter.send({
        content: [{ kind: "text", text: "second" }],
        threadId: "interaction:cmd:i101:C1",
      }),
    ).rejects.toThrow(/expired or missing/);
    expect(f.sent).toHaveLength(0);
    await adapter.disconnect();
  });

  test("slashCommandEphemeral configured + expired interaction refuses channel fallback (no public leak)", async () => {
    // When ephemeral is configured we cannot tell after-the-fact
    // whether the now-expired interaction was deferred ephemeral, so
    // fail closed to prevent reposting a private reply into the public
    // channel.
    const f = fakeClient();
    const adapter = createDiscordChannel({
      token: "T",
      client: f.client,
      slashCommandEphemeral: true,
      slashCommandFallbackToChannel: true,
    });
    await adapter.connect();
    // Note: we send WITHOUT first emitting the interactionCreate, so the
    // interaction id is unknown / "expired" from the adapter's view.
    await expect(
      adapter.send({
        content: [{ kind: "text", text: "secret reply" }],
        threadId: "interaction:cmd:expired-id:C1",
      }),
    ).rejects.toThrow(/refusing channel fallback to prevent leaking an ephemeral reply/);
    expect(f.sent).toHaveLength(0);
  });

  test("concurrent sends on the same interaction threadId issue editReply at most once (atomic claim)", async () => {
    const f = fakeClient();
    let editReplyCalls = 0;
    let firstResolve: () => void = () => undefined;
    const blockEdit = new Promise<void>((r) => {
      firstResolve = r;
    });
    const adapter = createDiscordChannel({
      token: "T",
      client: f.client,
      slashCommandFallbackToChannel: true,
    });
    await adapter.connect();
    f.emit("interactionCreate", {
      id: "iRACE",
      isChatInputCommand: () => true,
      isButton: () => false,
      commandName: "say",
      options: { data: [] },
      user: { id: "U1" },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 1,
      deferReply: async () => undefined,
      editReply: async (): Promise<undefined> => {
        editReplyCalls++;
        // Hold the first call so the second send overlaps it.
        if (editReplyCalls === 1) await blockEdit;
        return undefined;
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    const send1 = adapter.send({
      content: [{ kind: "text", text: "first" }],
      threadId: "interaction:cmd:iRACE:C1",
    });
    // Tick so send1 reads + claims the interaction before send2 runs.
    await new Promise((r) => setTimeout(r, 0));
    const send2 = adapter.send({
      content: [{ kind: "text", text: "second" }],
      threadId: "interaction:cmd:iRACE:C1",
    });
    firstResolve();
    await Promise.all([send1, send2]);
    // Only one editReply ever fired; send2 fell through to channel.send
    // because the interaction was already claimed.
    expect(editReplyCalls).toBe(1);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.payload.content).toBe("second");
  });

  test("slashCommandFallbackToChannel: true opts in to channel.send for expired slash threads", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({
      token: "T",
      client: f.client,
      slashCommandFallbackToChannel: true,
    });
    await adapter.connect();
    f.emit("interactionCreate", {
      id: "i101b",
      isChatInputCommand: () => true,
      isButton: () => false,
      commandName: "say",
      options: { data: [] },
      user: { id: "U1" },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 1,
      deferReply: async () => undefined,
      editReply: async () => undefined,
    });
    await new Promise((r) => setTimeout(r, 5));
    await adapter.send({
      content: [{ kind: "text", text: "first" }],
      threadId: "interaction:cmd:i101b:C1",
    });
    await adapter.send({
      content: [{ kind: "text", text: "second" }],
      threadId: "interaction:cmd:i101b:C1",
    });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.payload.content).toBe("second");
    await adapter.disconnect();
  });

  test("interaction overflow (>1 payload) edits first and channel.sends the rest", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    const edits: DiscordSendPayload[] = [];
    f.emit("interactionCreate", {
      id: "i102",
      isChatInputCommand: () => true,
      isButton: () => false,
      commandName: "say",
      options: { data: [] },
      user: { id: "U1" },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 1,
      deferReply: async () => undefined,
      editReply: async (p: DiscordSendPayload) => {
        edits.push(p);
        return undefined;
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    const big = "x".repeat(4500);
    await adapter.send({
      content: [{ kind: "text", text: big }],
      threadId: "interaction:cmd:i102:C1",
    });
    expect(edits).toHaveLength(1);
    expect(f.sent.length).toBeGreaterThanOrEqual(2);
    await adapter.disconnect();
  });

  test("expired pending interactions are swept when a new interaction arrives (no late editReply)", async () => {
    const f = fakeClient();
    // Opt into channel fallback so the sweep is observable end-to-end.
    const adapter = createDiscordChannel({
      token: "T",
      client: f.client,
      slashCommandFallbackToChannel: true,
    });
    await adapter.connect();
    const editsByInteraction: Record<string, number> = {};
    const makeInteraction = (id: string): Record<string, unknown> => ({
      id,
      isChatInputCommand: () => true,
      isButton: () => false,
      commandName: "x",
      options: { data: [] },
      user: { id: "U1" },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 1,
      deferReply: async () => undefined,
      editReply: async () => {
        editsByInteraction[id] = (editsByInteraction[id] ?? 0) + 1;
        return undefined;
      },
    });
    const t0 = Date.now();
    const nowSpy = spyOn(Date, "now").mockReturnValue(t0);
    f.emit("interactionCreate", makeInteraction("OLD"));
    nowSpy.mockReturnValue(t0 + 16 * 60 * 1000);
    f.emit("interactionCreate", makeInteraction("NEW"));
    await adapter.send({
      content: [{ kind: "text", text: "late" }],
      threadId: "interaction:cmd:OLD:C1",
    });
    expect(editsByInteraction.OLD ?? 0).toBe(0);
    expect(f.sent).toHaveLength(1);
    nowSpy.mockRestore();
    await adapter.disconnect();
  });

  test("button replies route through followUp (preserves ephemeral scope, leaves source intact)", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    const edits: DiscordSendPayload[] = [];
    const follows: DiscordSendPayload[] = [];
    f.emit("interactionCreate", {
      id: "btn-i1",
      isChatInputCommand: () => false,
      isButton: () => true,
      customId: "ok",
      user: { id: "U1" },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 1,
      deferUpdate: async () => undefined,
      editReply: async (p: DiscordSendPayload) => {
        edits.push(p);
        return undefined;
      },
      followUp: async (p: DiscordSendPayload) => {
        follows.push(p);
        return undefined;
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    await adapter.send({
      content: [{ kind: "text", text: "thanks!" }],
      threadId: "interaction:btn:btn-i1:C1",
    });
    // editReply MUST NOT be called — it would clobber the source message.
    expect(edits).toHaveLength(0);
    // followUp MUST be called so the response stays in the same scope as
    // the original interaction (ephemeral or public).
    expect(follows).toHaveLength(1);
    expect(follows[0]?.content).toBe("thanks!");
    // No channel.send fallback either — that would leak ephemeral replies
    // into the public channel.
    expect(f.sent).toHaveLength(0);
    await adapter.disconnect();
  });

  test("button without followUp throws rather than leaking via channel.send", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    f.emit("interactionCreate", {
      id: "btn-no-fu",
      isChatInputCommand: () => false,
      isButton: () => true,
      customId: "ok",
      user: { id: "U1" },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 1,
      deferUpdate: async () => undefined,
      editReply: async () => undefined,
    });
    await new Promise((r) => setTimeout(r, 5));
    await expect(
      adapter.send({
        content: [{ kind: "text", text: "x" }],
        threadId: "interaction:btn:btn-no-fu:C1",
      }),
    ).rejects.toThrow(/missing followUp/);
    expect(f.sent).toHaveLength(0);
    await adapter.disconnect();
  });

  test("unknown interaction id throws by default, falls back to channel.send when opted in", async () => {
    const f1 = fakeClient();
    const a1 = createDiscordChannel({ token: "T", client: f1.client });
    await a1.connect();
    await expect(
      a1.send({
        content: [{ kind: "text", text: "x" }],
        threadId: "interaction:cmd:unknown-id:C1",
      }),
    ).rejects.toThrow(/expired or missing/);
    expect(f1.sent).toHaveLength(0);
    await a1.disconnect();

    const f2 = fakeClient();
    const a2 = createDiscordChannel({
      token: "T",
      client: f2.client,
      slashCommandFallbackToChannel: true,
    });
    await a2.connect();
    await a2.send({
      content: [{ kind: "text", text: "x" }],
      threadId: "interaction:cmd:unknown-id:C1",
    });
    expect(f2.sent).toHaveLength(1);
    await a2.disconnect();
  });

  test("retry after a transient editReply failure still routes through editReply (not channel.send)", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    let editCalls = 0;
    f.emit("interactionCreate", {
      id: "i-retry",
      isChatInputCommand: () => true,
      isButton: () => false,
      commandName: "say",
      options: { data: [] },
      user: { id: "U1" },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 1,
      deferReply: async () => undefined,
      editReply: async (_p: DiscordSendPayload) => {
        editCalls++;
        if (editCalls === 1) throw new Error("transient 5xx");
        return undefined;
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    // First send rejects (transient).
    await expect(
      adapter.send({
        content: [{ kind: "text", text: "hello" }],
        threadId: "interaction:cmd:i-retry:C1",
      }),
    ).rejects.toThrow(/transient 5xx/);
    // Retry MUST still hit editReply (the pending entry was preserved).
    await adapter.send({
      content: [{ kind: "text", text: "hello" }],
      threadId: "interaction:cmd:i-retry:C1",
    });
    expect(editCalls).toBe(2);
    // No channel.send fallback.
    expect(f.sent).toHaveLength(0);
    await adapter.disconnect();
  });

  test("expired/missing button interaction fails closed (no public channel leak)", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    // No matching pending button interaction. A retry / replay landing on
    // a button thread MUST NOT fall through to channel.send because the
    // original interaction may have been ephemeral.
    await expect(
      adapter.send({
        content: [{ kind: "text", text: "leak?" }],
        threadId: "interaction:btn:vanished:C1",
      }),
    ).rejects.toThrow(/expired or missing/);
    expect(f.sent).toHaveLength(0);
    await adapter.disconnect();
  });

  test("events arriving during the platformConnect login window are buffered and drained", async () => {
    // Simulates Discord delivering an event between listener attachment
    // and dispatcher installation: the fake client.login() fires a
    // messageCreate before resolving, so the listener sees an event while
    // channel-base has not yet called onPlatformEvent. Without buffering,
    // that event would be silently dropped with no retry path.
    const base = fakeClient();
    const wrapped: DiscordClientLike = {
      ...base.client,
      login: async () => {
        base.emit("messageCreate", {
          id: "early",
          content: "during-login",
          author: { id: "U1", bot: false },
          channelId: "C1",
          guildId: "G1",
          createdTimestamp: 1,
          attachments: new Map(),
        });
        return undefined;
      },
    };
    const adapter = createDiscordChannel({ token: "T", client: wrapped });
    const seen: unknown[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m);
    });
    await adapter.connect();
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
    await adapter.disconnect();
  });
});

describe("createDiscordChannel — interaction ack", () => {
  test("slash command triggers deferReply on the raw interaction", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    let deferred = 0;
    f.emit("interactionCreate", {
      id: "i1",
      isChatInputCommand: () => true,
      isButton: () => false,
      commandName: "say",
      options: { data: [] },
      user: { id: "U1" },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 1,
      deferReply: async () => {
        deferred++;
        return undefined;
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(deferred).toBe(1);
    await adapter.disconnect();
  });

  test("slashCommandEphemeral: true defers slash commands as ephemeral", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({
      token: "T",
      client: f.client,
      slashCommandEphemeral: true,
    });
    await adapter.connect();
    const deferArgs: unknown[] = [];
    f.emit("interactionCreate", {
      id: "i-eph",
      isChatInputCommand: () => true,
      isButton: () => false,
      commandName: "diag",
      options: { data: [] },
      user: { id: "U1" },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 1,
      deferReply: async (opts?: unknown) => {
        deferArgs.push(opts);
        return undefined;
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(deferArgs).toEqual([{ ephemeral: true }]);
    await adapter.disconnect();
  });

  test("slashCommandEphemeral: function gates by commandName", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({
      token: "T",
      client: f.client,
      slashCommandEphemeral: (name) => name === "whoami",
    });
    await adapter.connect();
    const deferArgs: unknown[] = [];
    const emit = (cmd: string, id: string): void => {
      f.emit("interactionCreate", {
        id,
        isChatInputCommand: () => true,
        isButton: () => false,
        commandName: cmd,
        options: { data: [] },
        user: { id: "U1" },
        channelId: "C1",
        guildId: "G1",
        createdTimestamp: 1,
        deferReply: async (opts?: unknown) => {
          deferArgs.push({ cmd, opts });
          return undefined;
        },
      });
    };
    emit("whoami", "i1");
    emit("hello", "i2");
    await new Promise((r) => setTimeout(r, 5));
    expect(deferArgs).toEqual([
      { cmd: "whoami", opts: { ephemeral: true } },
      { cmd: "hello", opts: undefined },
    ]);
    await adapter.disconnect();
  });

  test("button press triggers deferUpdate on the raw interaction", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    let updated = 0;
    f.emit("interactionCreate", {
      id: "b1",
      isChatInputCommand: () => false,
      isButton: () => true,
      customId: "ok",
      user: { id: "U1" },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 1,
      deferUpdate: async () => {
        updated++;
        return undefined;
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(updated).toBe(1);
    await adapter.disconnect();
  });

  test("ack failure is swallowed; the InboundMessage still dispatches", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    const seen: unknown[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m);
    });
    f.emit("interactionCreate", {
      id: "i2",
      isChatInputCommand: () => true,
      isButton: () => false,
      commandName: "x",
      options: { data: [] },
      user: { id: "U1" },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 1,
      deferReply: () => {
        throw new Error("already-acked");
      },
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toHaveLength(1);
    await adapter.disconnect();
  });
});

describe("createDiscordChannel — coverage of less-trodden paths", () => {
  test("inbound slash_command interaction is normalized", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    const seen: unknown[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m);
    });
    f.emit("interactionCreate", {
      id: "i1",
      isChatInputCommand: () => true,
      isButton: () => false,
      commandName: "say",
      options: {
        data: [
          { name: "text", value: "hi" },
          { name: "n", value: 5 },
          { name: "b", value: true },
          { name: "x", value: { nested: true } },
        ],
      },
      user: { id: "U1" },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 100,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toHaveLength(1);
    await adapter.disconnect();
  });

  test("inbound button interaction is normalized", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    const seen: unknown[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m);
    });
    f.emit("interactionCreate", {
      id: "b1",
      isChatInputCommand: () => false,
      isButton: () => true,
      customId: 'confirm:{"a":1}',
      user: { id: "U1" },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 100,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toHaveLength(1);
    await adapter.disconnect();
  });

  test("inbound interaction that is neither slash_command nor button is dropped", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    const seen: unknown[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m);
    });
    f.emit("interactionCreate", {
      id: "x1",
      isChatInputCommand: () => false,
      isButton: () => false,
      user: { id: "U1" },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 100,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toHaveLength(0);
    await adapter.disconnect();
  });

  test("inbound malformed message (non-object) is dropped", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    const seen: unknown[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m);
    });
    f.emit("messageCreate", "not-an-object");
    f.emit("interactionCreate", null);
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toHaveLength(0);
    await adapter.disconnect();
  });

  test("send to dm:<channelId> threadId routes to the DM channel cache entry", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    await adapter.send({ content: [{ kind: "text", text: "hi" }], threadId: "dm:DM_CHAN" });
    expect(f.sent[0]?.channelId).toBe("DM_CHAN");
    await adapter.disconnect();
  });

  test("file block is sent as an attachment", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    await adapter.send({
      content: [
        { kind: "file", url: "https://x/d.pdf", mimeType: "application/pdf", name: "d.pdf" },
      ],
      threadId: "G1:C1",
    });
    expect(f.sent[0]?.payload.files?.[0]?.name).toBe("d.pdf");
    await adapter.disconnect();
  });

  test("more than 10 file blocks chunk across multiple sends (Discord 10-attachment cap)", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    const files = Array.from(
      { length: 25 },
      (_, i) =>
        ({
          kind: "file",
          url: `https://x/${i}.bin`,
          name: `f${i}.bin`,
          mimeType: "application/octet-stream",
        }) as const,
    );
    await adapter.send({ content: files, threadId: "G1:C1" });
    expect(f.sent.length).toBeGreaterThanOrEqual(3);
    for (const s of f.sent) {
      expect(s.payload.files?.length ?? 0).toBeLessThanOrEqual(10);
    }
    const total = f.sent.reduce((n, s) => n + (s.payload.files?.length ?? 0), 0);
    expect(total).toBe(25);
    await adapter.disconnect();
  });

  test("image block is sent as an embed with description", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    await adapter.send({
      content: [{ kind: "image", url: "https://x/a.png", alt: "alt" }],
      threadId: "G1:C1",
    });
    const embeds = f.sent[0]?.payload.embeds;
    expect(embeds?.[0]).toEqual({ image: { url: "https://x/a.png" }, description: "alt" });
    await adapter.disconnect();
  });

  test("discord:action_row custom block is forwarded as a component", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    await adapter.send({
      content: [{ kind: "custom", type: "discord:action_row", data: { type: 1, components: [] } }],
      threadId: "G1:C1",
    });
    expect(f.sent[0]?.payload.components?.[0]?.type).toBe(1);
    await adapter.disconnect();
  });

  test("unknown custom block is silently dropped", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    await adapter.send({
      content: [
        { kind: "custom", type: "x:other", data: 1 },
        { kind: "text", text: "still-sent" },
      ],
      threadId: "G1:C1",
    });
    expect(f.sent[0]?.payload.content).toBe("still-sent");
    await adapter.disconnect();
  });

  test("11+ image blocks split into multiple payloads", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    const content = Array.from({ length: 11 }, (_, i) => ({
      kind: "image" as const,
      url: `https://x/${i}.png`,
    }));
    await adapter.send({ content, threadId: "G1:C1" });
    expect(f.sent.length).toBeGreaterThanOrEqual(2);
    await adapter.disconnect();
  });

  test("attachment Map on inbound message produces image + file blocks", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    const seen: { content: readonly { readonly kind: string }[] }[] = [];
    adapter.onMessage(async (m) => {
      seen.push(m);
    });
    const atts = new Map();
    atts.set("a", { url: "u1", name: "a.png", contentType: "image/png" });
    atts.set("b", { url: "u2", name: "b.bin", contentType: null });
    f.emit("messageCreate", {
      id: "m1",
      content: "",
      author: { id: "U1", bot: false },
      channelId: "C1",
      guildId: "G1",
      createdTimestamp: 1,
      attachments: atts,
    });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.content.map((b) => b.kind)).toEqual(["image", "file"]);
    await adapter.disconnect();
  });
});

describe("splitText", () => {
  test("returns input unchanged when below limit", () => {
    expect(splitText("abc", 100)).toEqual(["abc"]);
  });
  test("hard-cuts when no newline boundary available", () => {
    const parts = splitText("a".repeat(5), 2);
    expect(parts.every((p) => p.length <= 2)).toBe(true);
  });
  test("breaks on newline near the limit", () => {
    const text = `${"a".repeat(60)}\n${"b".repeat(60)}`;
    const parts = splitText(text, 70);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toBe("a".repeat(60));
  });
});
