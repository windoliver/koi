import { describe, expect, test } from "bun:test";
import { InMemoryOutboxStore, InMemoryThreadStore, type OutboxRecord } from "@koi/channel-base";
import { getPendingSends, type ResolveDeps, resolvePending } from "./resolve-pending.js";

async function setup(): Promise<{
  readonly deps: ResolveDeps;
  readonly seed: (record: OutboxRecord) => Promise<void>;
  readonly seedThread: (key: string, chain: readonly string[]) => Promise<void>;
}> {
  const outboxStore = new InMemoryOutboxStore();
  const threadStore = new InMemoryThreadStore();
  return {
    deps: { outboxStore, threadStore },
    seed: async (r) => outboxStore.put(r),
    seedThread: async (k, chain) => {
      // Bump versions until we reach desired (1 by default, advance by re-CAS).
      await threadStore.cas(k, 0, { chain });
    },
  };
}

const baseRecord = (overrides: Partial<OutboxRecord> = {}): OutboxRecord => ({
  messageId: "<m1@test>",
  threadKey: "<root@test>",
  threadVersion: 1,
  payloadHash: "h",
  status: "awaiting-recovery",
  createdAt: 0,
  ...overrides,
});

describe("getPendingSends", () => {
  test("lists all awaiting-recovery rows", async () => {
    const { deps, seed } = await setup();
    await seed(baseRecord({ messageId: "<a@t>" }));
    await seed(baseRecord({ messageId: "<b@t>", status: "sent" }));
    await seed(baseRecord({ messageId: "<c@t>" }));
    const pending = await getPendingSends(deps);
    expect(pending.map((r) => r.messageId).sort()).toEqual(["<a@t>", "<c@t>"]);
  });
});

describe("resolvePending", () => {
  test("'sent' outcome flips row, leaves thread intact", async () => {
    const { deps, seed, seedThread } = await setup();
    await seed(baseRecord());
    await seedThread("<root@test>", ["<m1@test>"]);
    const r = await resolvePending(deps, "<m1@test>", "sent");
    expect(r.ok).toBe(true);
    expect((await deps.outboxStore.get("<m1@test>"))?.status).toBe("sent");
    const thread = await deps.threadStore.get("<root@test>");
    expect(thread?.state.chain).toEqual(["<m1@test>"]);
  });

  test("'failed' outcome flips row to aborted and strips thread chain entry", async () => {
    const { deps, seed, seedThread } = await setup();
    await seed(baseRecord());
    await seedThread("<root@test>", ["<m1@test>"]);
    const r = await resolvePending(deps, "<m1@test>", "failed");
    expect(r.ok).toBe(true);
    expect((await deps.outboxStore.get("<m1@test>"))?.status).toBe("aborted");
    const thread = await deps.threadStore.get("<root@test>");
    expect(thread?.state.chain).toEqual([]);
  });

  test("'failed' with concurrent later reservation → RECOVERY_CONFLICT", async () => {
    const { deps, seed, seedThread } = await setup();
    await seed(baseRecord());
    await seedThread("<root@test>", ["<m1@test>"]);
    // Stack a later reservation: bumps thread version to 2.
    await deps.threadStore.cas("<root@test>", 1, {
      chain: ["<m1@test>", "<m2@test>"],
    });
    const r = await resolvePending(deps, "<m1@test>", "failed");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("RECOVERY_CONFLICT");
  });

  test("re-calling with same outcome on resolved row → idempotent ok", async () => {
    const { deps, seed } = await setup();
    await seed(baseRecord({ status: "sent" }));
    const r = await resolvePending(deps, "<m1@test>", "sent");
    expect(r.ok).toBe(true);
  });

  test("re-calling with different outcome on resolved row → ALREADY_RESOLVED", async () => {
    const { deps, seed } = await setup();
    await seed(baseRecord({ status: "sent" }));
    const r = await resolvePending(deps, "<m1@test>", "failed");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("ALREADY_RESOLVED");
  });
});
