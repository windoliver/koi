/**
 * Integration tests: full connect → message → reconnect lifecycle, plus
 * action-row packing boundary that single-call tests don't cover.
 */

import { describe, expect, test } from "bun:test";
import {
  createDiscordChannel,
  type DiscordClientLike,
  type DiscordSendPayload,
  type DiscordSendTargetLike,
} from "../discord-channel.js";

interface SentRecord {
  readonly channelId: string;
  readonly payload: DiscordSendPayload;
}

function fakeClient(): {
  readonly client: DiscordClientLike;
  readonly sent: SentRecord[];
  readonly emit: (event: string, payload: unknown) => void;
  readonly listenerCounts: () => Record<string, number>;
} {
  const sent: SentRecord[] = [];
  const listeners: Record<string, ((...a: readonly unknown[]) => void)[]> = {};
  const cache = new Map<string, DiscordSendTargetLike>();
  cache.set("C1", {
    send: async (payload) => {
      sent.push({ channelId: "C1", payload });
      return undefined;
    },
  });
  const client: DiscordClientLike = {
    user: { id: "BOT" },
    channels: { cache },
    login: async () => undefined,
    destroy: () => undefined,
    on: (event, listener) => {
      const bucket = listeners[event] ?? [];
      bucket.push(listener);
      listeners[event] = bucket;
      return undefined;
    },
    off: (event, listener) => {
      const bucket = listeners[event];
      if (bucket !== undefined) listeners[event] = bucket.filter((l) => l !== listener);
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
    listenerCounts: () =>
      Object.fromEntries(Object.entries(listeners).map(([k, v]) => [k, v.length])),
  };
}

describe("channel-discord lifecycle", () => {
  test("connect → message ingress → outbound send → disconnect → reconnect leaves no listener leak", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });

    await adapter.connect();
    const before = f.listenerCounts();
    expect(before.messageCreate ?? 0).toBeGreaterThan(0);

    const seen: string[] = [];
    adapter.onMessage(async (m) => {
      const block = m.content[0];
      if (block?.kind === "text") seen.push(block.text);
      await adapter.send({
        content: [{ kind: "text", text: `echo:${block?.kind === "text" ? block.text : "?"}` }],
        threadId: "G1:C1",
      });
    });

    f.emit("messageCreate", {
      id: "M1",
      content: "ping",
      author: { id: "U1", bot: false },
      guildId: "G1",
      channelId: "C1",
      createdTimestamp: 1,
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(seen).toEqual(["ping"]);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.payload.content).toBe("echo:ping");

    await adapter.disconnect();
    // After disconnect, listeners on the injected client must be
    // detached (other consumers of the same client keep working).
    const afterDisconnect = f.listenerCounts();
    expect(afterDisconnect.messageCreate ?? 0).toBe(0);
    expect(afterDisconnect.interactionCreate ?? 0).toBe(0);
  });

  test("MAX_ACTION_ROWS boundary: 5 button blocks pack into one payload, 6 splits into two", async () => {
    const f = fakeClient();
    const adapter = createDiscordChannel({ token: "T", client: f.client });
    await adapter.connect();

    const fiveButtons = Array.from({ length: 5 }, (_, i) => ({
      kind: "button" as const,
      label: `b${i}`,
      action: `act${i}`,
    }));
    await adapter.send({ content: fiveButtons, threadId: "G1:C1" });
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]?.payload.components).toHaveLength(5);

    f.sent.length = 0;
    const sixButtons = Array.from({ length: 6 }, (_, i) => ({
      kind: "button" as const,
      label: `b${i}`,
      action: `act${i}`,
    }));
    await adapter.send({ content: sixButtons, threadId: "G1:C1" });
    expect(f.sent.length).toBeGreaterThanOrEqual(2);
    const totalRows = f.sent.reduce(
      (n, s) => n + ((s.payload.components as readonly unknown[] | undefined)?.length ?? 0),
      0,
    );
    expect(totalRows).toBe(6);

    await adapter.disconnect();
  });
});
