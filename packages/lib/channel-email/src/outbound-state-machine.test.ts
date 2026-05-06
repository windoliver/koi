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

  test("non-text content rejected pre-flight without reserving thread", async () => {
    // Regression: previously formatOutbound silently dropped non-text
    // blocks and the outbox advanced to `sent` for a truncated mail
    // (or empty body, on all-non-text content). Now executeOutbound
    // rejects pre-flight with UNSUPPORTED_BLOCK before reserving any
    // thread slot — so the outbox is empty and the thread chain is
    // untouched on the failed call.
    const deps = buildDeps({ smtp: fakeSmtp({ mode: "ok" }) });
    const result = await executeOutbound(deps, {
      ...sampleInput,
      message: {
        content: [
          { kind: "text", text: "hi" },
          { kind: "image", url: "https://x/y.png" },
        ],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNSUPPORTED_BLOCK");
    expect(result.error.context?.kind).toBe("image");
    const thread = await deps.threadStore.get(sampleInput.threadKey);
    expect(thread?.state.chain ?? []).toEqual([]);
    const reserved = await deps.outboxStore.list({ status: "reserved" });
    const sending = await deps.outboxStore.list({ status: "sending" });
    expect(reserved.length).toBe(0);
    expect(sending.length).toBe(0);
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

  test("concurrent sends on same thread: one wins, the other gets THREAD_BUSY", async () => {
    // Single in-flight send per thread is the safety contract — the
    // chain may carry a tentative parent that gets rolled back on
    // pre-DATA failure, so a second send must NOT derive headers
    // atop it. With concurrent calls, the first to win the
    // threadStore CAS reserves; the second sees that tentative
    // predecessor on its retry and refuses with THREAD_BUSY rather
    // than threading atop an unresolved parent.
    const deps = buildDeps({ smtp: fakeSmtp({ mode: "ok" }) });
    const [r1, r2] = await Promise.all([
      executeOutbound(deps, sampleInput),
      executeOutbound(deps, sampleInput),
    ]);
    const oks = [r1, r2].filter((r) => r.ok);
    const errs = [r1, r2].filter((r) => !r.ok);
    expect(oks.length).toBe(1);
    expect(errs.length).toBe(1);
    const errResult = errs[0];
    if (errResult && !errResult.ok) {
      expect(errResult.error.code).toBe("THREAD_BUSY");
    }
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

  test("sequential send: second call gets THREAD_BUSY while first's reserving row is in flight", async () => {
    // Regression: tentative Message-IDs are visible in the chain
    // immediately after reservation, so a second send issued AFTER the
    // first reserved would derive In-Reply-To/References from a parent
    // that may yet be rolled back on pre-DATA failure — leaving the
    // sent reply pointing at a Message-ID that never existed. Only one
    // in-flight send per thread is safe given the chain-derivation
    // contract.
    //
    // Simulate "first send is mid-SMTP" by pre-placing a `sending` row
    // for sampleInput.threadKey and confirming a fresh executeOutbound
    // is rejected with THREAD_BUSY.
    const outboxStore = new InMemoryOutboxStore();
    await outboxStore.put({
      messageId: "<inflight@test>",
      threadKey: sampleInput.threadKey,
      threadVersion: 1,
      payloadHash: "x",
      status: "sending",
      createdAt: 0,
    });
    const deps = buildDeps({ outboxStore, smtp: fakeSmtp({ mode: "ok" }) });
    const result = await executeOutbound(deps, sampleInput);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("THREAD_BUSY");
  });

  test("crash mid-SMTP leaves row in `sending`, NOT auto-aborted on recovery", async () => {
    // Regression: previously the row was placed in `dispatching` before
    // sendViaSmtp and recovery auto-aborted dispatching rows. If the
    // process crashed during the SMTP call after DATA bytes were sent,
    // the relay may have accepted the message but recovery would roll
    // it back as if unsent — a future retry would then send it again
    // with a new Message-ID, duplicating the user-visible delivery.
    // Now the row enters `sending` BEFORE the SMTP call, so a crash
    // mid-call leaves a `sending` row that recovery flips to
    // `awaiting-recovery` for operator decision rather than
    // auto-aborting.
    const { recoverOrphanedReservations } = await import("./recover-orphans.js");
    let crashedDuringSmtp = false;
    const crashingSmtp: SmtpTransport = {
      async sendMail(): Promise<SmtpSendResult> {
        crashedDuringSmtp = true;
        // Simulate process death by never returning.
        throw new Error("simulated process crash mid-SMTP");
      },
    };
    const deps = buildDeps({ smtp: crashingSmtp });
    // The crash itself is observed via post-data-fail classification
    // (no recognized error code). The row is left in `awaiting-
    // recovery` directly. To reproduce a true mid-call crash where
    // executeOutbound never returns, we run the call and inspect the
    // intermediate state via a custom outboxStore that snapshots at the
    // pre-SMTP write.
    const states: string[] = [];
    const wrappedOutbox = new InMemoryOutboxStore();
    const monitoringOutbox: OutboxStore = {
      put: (r) => wrappedOutbox.put(r),
      cas: async (id, exp, next) => {
        states.push(`${exp}->${next}`);
        return wrappedOutbox.cas(id, exp, next);
      },
      get: (id) => wrappedOutbox.get(id),
      list: (q) => wrappedOutbox.list(q),
    };
    const depsMon = buildDeps({ smtp: crashingSmtp, outboxStore: monitoringOutbox });
    await executeOutbound(depsMon, sampleInput);
    expect(crashedDuringSmtp).toBe(true);
    // The state machine MUST persist `reserved->sending` BEFORE
    // calling SMTP (no `dispatching` intermediate). This guarantees
    // recovery sees `sending` after a real crash.
    expect(states).toContain("reserved->sending");
    // Independently: a row directly placed in `sending` (simulating
    // post-crash state) is recovered as `awaiting-recovery`, never
    // auto-aborted.
    const standaloneOutbox = new InMemoryOutboxStore();
    const standaloneThreads = new InMemoryThreadStore();
    await standaloneOutbox.put({
      messageId: "<crashed@test>",
      threadKey: sampleInput.threadKey,
      threadVersion: 1,
      payloadHash: "x",
      status: "sending",
      createdAt: 0,
    });
    const recovered = await recoverOrphanedReservations({
      outboxStore: standaloneOutbox,
      threadStore: standaloneThreads,
    });
    expect(recovered.length).toBe(1);
    expect(recovered[0]?.outcome).toBe("awaiting-recovery");
    void deps; // silence unused
  });
});
