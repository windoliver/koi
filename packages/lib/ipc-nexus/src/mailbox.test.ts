import { describe, expect, test } from "bun:test";
import type { KoiError, MailboxComponent, Result } from "@koi/core";
import { agentId, messageId } from "@koi/core";
import type { NexusTransport } from "@koi/nexus-client";

function createFallbackMailbox(owner = agentId("agent-a")): MailboxComponent {
  let messages: readonly {
    readonly id: ReturnType<typeof messageId>;
    readonly from: ReturnType<typeof agentId>;
    readonly to: ReturnType<typeof agentId>;
    readonly kind: "request" | "response" | "event" | "cancel";
    readonly correlationId?: ReturnType<typeof messageId> | undefined;
    readonly createdAt: string;
    readonly ttlSeconds?: number | undefined;
    readonly type: string;
    readonly payload: Record<string, never>;
    readonly metadata?: Record<string, never> | undefined;
  }[] = [];

  return {
    send: async (message) => {
      const mapped = {
        ...message,
        id: messageId(`fallback-${messages.length + 1}`),
        createdAt: "2026-05-06T00:00:00.000Z",
      };
      messages = [...messages, mapped];
      return { ok: true, value: mapped };
    },
    onMessage: () => () => {},
    list: async () => messages.filter((message) => message.to === owner),
    drain: () => {
      const snapshot = messages;
      messages = [];
      return snapshot;
    },
  };
}

function createHealthyTransport(call: NexusTransport["call"]): NexusTransport {
  return {
    kind: "http",
    call,
    health: async () => ({
      ok: true,
      value: {
        status: "ok",
        version: "1",
        latencyMs: 1,
        probed: ["version"],
      },
    }),
    close: () => {},
  };
}

describe("createNexusMailbox", () => {
  test("sends a message through Nexus transport", async () => {
    const { createNexusMailbox } = await import("./index.js");

    const transport = createHealthyTransport(async <T>() => ({
      ok: true,
      value: {
        id: "msg-1",
        from: "agent-a",
        to: "agent-b",
        kind: "request",
        type: "review",
        payload: { text: "check this" },
        createdAt: "2026-05-06T00:00:00.000Z",
      } as T,
    }));

    const mailbox = await createNexusMailbox({
      agentId: agentId("agent-a"),
      transport,
    });

    const result = await mailbox.send({
      from: agentId("agent-a"),
      to: agentId("agent-b"),
      kind: "request",
      type: "review",
      payload: { text: "check this" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(messageId("msg-1"));
      expect(result.value.to).toBe(agentId("agent-b"));
    }
  });

  test("uses fallback mailbox when health check fails", async () => {
    const { createNexusMailbox } = await import("./index.js");

    const fallback = createFallbackMailbox();
    const mailbox = await createNexusMailbox({
      agentId: agentId("agent-a"),
      transport: {
        kind: "http",
        call: async <T>(): Promise<Result<T, KoiError>> => ({
          ok: false,
          error: { code: "EXTERNAL", message: "down", retryable: false },
        }),
        health: async () => ({
          ok: false,
          error: { code: "EXTERNAL", message: "down", retryable: false },
        }),
        close: () => {},
      },
      fallback,
    });

    const result = await mailbox.send({
      from: agentId("agent-a"),
      to: agentId("agent-a"),
      kind: "event",
      type: "noop",
      payload: {},
    });

    expect(result.ok).toBe(true);
  });

  test("drain returns seen messages once", async () => {
    const { createNexusMailbox } = await import("./index.js");

    const transport = createHealthyTransport(async <T>(method: string) => {
      if (method === "ipc.list") {
        return {
          ok: true,
          value: {
            messages: [
              {
                id: "msg-2",
                from: "agent-b",
                to: "agent-a",
                kind: "event",
                type: "status",
                payload: { ok: true },
                createdAt: "2026-05-06T00:00:00.000Z",
              },
            ],
          } as T,
        };
      }
      return {
        ok: false,
        error: { code: "EXTERNAL", message: "unexpected", retryable: false },
      };
    });

    const mailbox = await createNexusMailbox({ agentId: agentId("agent-a"), transport });
    const unsubscribe = mailbox.onMessage(() => {});
    await Bun.sleep(10);
    unsubscribe();

    expect(mailbox.drain()).toHaveLength(1);
    expect(mailbox.drain()).toHaveLength(0);
  });

  test("list filters messages returned from Nexus", async () => {
    const { createNexusMailbox } = await import("./index.js");

    const mailbox = await createNexusMailbox({
      agentId: agentId("agent-a"),
      transport: createHealthyTransport(async <T>() => ({
        ok: true,
        value: {
          messages: [
            {
              id: "msg-3",
              from: "agent-b",
              to: "agent-a",
              kind: "request",
              type: "review",
              payload: {},
              createdAt: "2026-05-06T00:00:00.000Z",
            },
            {
              id: "msg-4",
              from: "agent-c",
              to: "agent-a",
              kind: "event",
              type: "status",
              payload: {},
              createdAt: "2026-05-06T00:00:01.000Z",
            },
          ],
        } as T,
      })),
    });

    const filtered = await mailbox.list({ kind: "request", from: agentId("agent-b") });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.type).toBe("review");
  });

  test("falls back on send failure after startup health passes", async () => {
    const { createNexusMailbox } = await import("./index.js");

    const fallback = createFallbackMailbox();
    const mailbox = await createNexusMailbox({
      agentId: agentId("agent-a"),
      transport: createHealthyTransport(async <T>(method: string) => {
        if (method === "ipc.send") {
          return {
            ok: false,
            error: { code: "EXTERNAL", message: "down", retryable: false },
          };
        }
        return {
          ok: true,
          value: { messages: [] } as T,
        };
      }),
      fallback,
    });

    const result = await mailbox.send({
      from: agentId("agent-a"),
      to: agentId("agent-a"),
      kind: "event",
      type: "local",
      payload: {},
    });

    expect(result.ok).toBe(true);
    const listed = await mailbox.list();
    expect(listed).toHaveLength(1);
  });
});
