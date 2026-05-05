import { describe, expect, test } from "bun:test";
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
  test("connect / disconnect calls login and destroy", async () => {
    const { client } = fakeClient();
    let logins = 0;
    let destroys = 0;
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
    };
    const adapter = createDiscordChannel({ token: "T", client: wrapped });
    await adapter.connect();
    expect(logins).toBe(1);
    await adapter.disconnect();
    expect(destroys).toBe(1);
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
      threadId: "interaction:i100:C1",
    });
    expect(edits).toHaveLength(1);
    expect(edits[0]?.content).toBe("answer");
    // The channel.send path should NOT have been called for the first payload.
    expect(f.sent).toHaveLength(0);
    await adapter.disconnect();
  });

  test("second reply on the same interaction threadId falls back to channel.send", async () => {
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
      threadId: "interaction:i101:C1",
    });
    await adapter.send({
      content: [{ kind: "text", text: "second" }],
      threadId: "interaction:i101:C1",
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
      threadId: "interaction:i102:C1",
    });
    expect(edits).toHaveLength(1);
    expect(f.sent.length).toBeGreaterThanOrEqual(2);
    await adapter.disconnect();
  });

  test("button replies do NOT use editReply (would clobber the source message)", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    const edits: DiscordSendPayload[] = [];
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
    });
    await new Promise((r) => setTimeout(r, 5));
    await adapter.send({
      content: [{ kind: "text", text: "thanks!" }],
      threadId: "interaction:btn-i1:C1",
    });
    // editReply MUST NOT have been called — it would mutate the original
    // message that contained the button.
    expect(edits).toHaveLength(0);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.payload.content).toBe("thanks!");
    await adapter.disconnect();
  });

  test("unknown interaction id falls back to channel.send", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();
    await adapter.send({
      content: [{ kind: "text", text: "x" }],
      threadId: "interaction:unknown-id:C1",
    });
    expect(f.sent).toHaveLength(1);
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
