import { describe, expect, test } from "bun:test";
import {
  InMemoryOutboxStore,
  InMemoryThreadStore,
  type OutboxStore,
  type ThreadStore,
} from "@koi/channel-base";
import type { OutboundMessage } from "@koi/core";
import { executeOutbound, type OutboundDeps } from "./outbound-state-machine.js";
import type { SmtpEnvelope, SmtpSendResult, SmtpTransport } from "./platform-send.js";

type FakeSmtpOptions = {
  readonly mode: "ok" | "pre-data" | "post-data-fail";
};

function fakeSmtp(opts: FakeSmtpOptions): SmtpTransport {
  return {
    async sendMail(env: SmtpEnvelope): Promise<SmtpSendResult> {
      if (opts.mode === "ok") {
        return { accepted: env.to.slice(), rejected: [], response: "250 OK" };
      }
      if (opts.mode === "pre-data") {
        const e = new Error("connection refused") as Error & { code?: string };
        e.code = "ECONNREFUSED";
        throw e;
      }
      // post-data-fail: throw without a recognized code → classified post-data
      throw new Error("server crash mid-DATA");
    },
  };
}

function buildDeps(overrides: {
  readonly threadStore?: ThreadStore;
  readonly outboxStore?: OutboxStore;
  readonly smtp: SmtpTransport;
  readonly idGenerator?: () => string;
}): OutboundDeps {
  let n = 0;
  return {
    threadStore: overrides.threadStore ?? new InMemoryThreadStore(),
    outboxStore: overrides.outboxStore ?? new InMemoryOutboxStore(),
    smtp: overrides.smtp,
    idGenerator: overrides.idGenerator ?? (() => `<msg-${++n}@test>`),
    clock: () => 1000,
    from: "agent@test.local",
  };
}

const sampleMessage: OutboundMessage = {
  content: [{ kind: "text", text: "hello world" }],
};

const sampleInput = {
  message: sampleMessage,
  threadKey: "<root@test>",
  to: ["user@test.local"],
  subject: "re: greeting",
};

describe("executeOutbound", () => {
  test("happy path: reserved → sending → sent", async () => {
    const deps = buildDeps({ smtp: fakeSmtp({ mode: "ok" }) });
    const result = await executeOutbound(deps, sampleInput);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = await deps.outboxStore.get(result.value.messageId);
    expect(row?.status).toBe("sent");
    const thread = await deps.threadStore.get(sampleInput.threadKey);
    expect(thread?.state.chain).toEqual([result.value.messageId]);
  });

  test("pre-data failure aborts and rolls back thread", async () => {
    const deps = buildDeps({ smtp: fakeSmtp({ mode: "pre-data" }) });
    const result = await executeOutbound(deps, sampleInput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SEND_FAILED");
    const thread = await deps.threadStore.get(sampleInput.threadKey);
    expect(thread?.state.chain).toEqual([]);
    const list = await deps.outboxStore.list({ status: "aborted" });
    expect(list.length).toBe(1);
  });

  test("pre-data failure strips unsent id even after concurrent advance", async () => {
    // Updated behaviour (round 10): rollback is a CAS-loop strip-by-id
    // that removes the unsent Message-ID from ANY chain version. An
    // unsent id should never appear in the chain — the previous
    // version-match-only rollback permanently leaked it into newer
    // ancestry.
    const threadStore = new InMemoryThreadStore();
    let calls = 0;
    const smtp: SmtpTransport = {
      async sendMail() {
        if (calls === 0) {
          calls++;
          await threadStore.cas("<root@test>", 1, {
            chain: [`<msg-1@test>`, `<concurrent@test>`],
          });
        }
        const e = new Error("conn refused") as Error & { code?: string };
        e.code = "ECONNREFUSED";
        throw e;
      },
    };
    const deps = buildDeps({ threadStore, smtp });
    const result = await executeOutbound(deps, sampleInput);
    expect(result.ok).toBe(false);
    const thread = await threadStore.get("<root@test>");
    // The unsent `<msg-1@test>` is stripped; the legitimately-advanced
    // `<concurrent@test>` survives.
    expect(thread?.state.chain).toEqual([`<concurrent@test>`]);
  });

  test("post-data crash → awaiting-recovery; thread state preserved", async () => {
    const deps = buildDeps({ smtp: fakeSmtp({ mode: "post-data-fail" }) });
    const result = await executeOutbound(deps, sampleInput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("SEND_FAILED");
    expect(result.error.context?.awaitingRecovery).toBe(true);
    const list = await deps.outboxStore.list({ status: "awaiting-recovery" });
    expect(list.length).toBe(1);
    const thread = await deps.threadStore.get(sampleInput.threadKey);
    expect(thread?.state.chain.length).toBe(1);
  });

  test("concurrent sends on same thread: both reservations land in order", async () => {
    const deps = buildDeps({ smtp: fakeSmtp({ mode: "ok" }) });
    const [r1, r2] = await Promise.all([
      executeOutbound(deps, sampleInput),
      executeOutbound(deps, sampleInput),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    const ids = new Set([r1.value.messageId, r2.value.messageId]);
    expect(ids.size).toBe(2);
    const thread = await deps.threadStore.get(sampleInput.threadKey);
    expect(thread?.state.chain.length).toBe(2);
    expect(new Set(thread?.state.chain ?? [])).toEqual(ids);
  });

  test("blocks new sends if thread has awaiting-recovery row", async () => {
    const outboxStore = new InMemoryOutboxStore();
    await outboxStore.put({
      messageId: "<stuck@test>",
      threadKey: sampleInput.threadKey,
      threadVersion: 1,
      payloadHash: "x",
      status: "awaiting-recovery",
      createdAt: 0,
    });
    const deps = buildDeps({ outboxStore, smtp: fakeSmtp({ mode: "ok" }) });
    const result = await executeOutbound(deps, sampleInput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("THREAD_BLOCKED_PENDING_RECOVERY");
  });
});
