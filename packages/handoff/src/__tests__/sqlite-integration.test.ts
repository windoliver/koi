/**
 * SQLite integration tests — verifies persistence across DB close/reopen.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HandoffEnvelope } from "@koi/core";
import { agentId, handoffId } from "@koi/core";
import { createSqliteHandoffStore } from "../sqlite-store.js";

function createTestEnvelope(overrides?: Partial<HandoffEnvelope>): HandoffEnvelope {
  return {
    id: handoffId("hoff-persist-1"),
    from: agentId("agent-a"),
    to: agentId("agent-b"),
    status: "pending",
    createdAt: Date.now(),
    phase: { completed: "phase 1 done", next: "do phase 2" },
    context: {
      results: { answer: 42 },
      artifacts: [],
      decisions: [],
      warnings: [],
    },
    metadata: {},
    ...overrides,
  };
}

describe("SQLite persistence", () => {
  const tmpPath = join(tmpdir(), `koi-handoff-test-${Date.now()}.db`);

  afterEach(() => {
    try {
      unlinkSync(tmpPath);
    } catch {
      // File may not exist
    }
    // Also clean WAL/SHM files
    try {
      unlinkSync(`${tmpPath}-wal`);
    } catch {
      /* noop */
    }
    try {
      unlinkSync(`${tmpPath}-shm`);
    } catch {
      /* noop */
    }
  });

  test("envelope persists across close/reopen", async () => {
    const envelope = createTestEnvelope();

    // Write and close
    const store1 = createSqliteHandoffStore({ dbPath: tmpPath });
    const putResult = await store1.put(envelope);
    expect(putResult.ok).toBe(true);
    store1.close();

    // Reopen and verify
    const store2 = createSqliteHandoffStore({ dbPath: tmpPath });
    const getResult = await store2.get(envelope.id);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value.id).toBe(envelope.id);
      expect(getResult.value.from).toBe(envelope.from);
      expect(getResult.value.to).toBe(envelope.to);
      expect(getResult.value.status).toBe("pending");
      expect(getResult.value.phase).toEqual(envelope.phase);
      expect(getResult.value.context.results).toEqual({ answer: 42 });
    }
    store2.close();
  });

  test("CAS transition survives reopen", async () => {
    const envelope = createTestEnvelope();

    // Write + transition
    const store1 = createSqliteHandoffStore({ dbPath: tmpPath });
    await store1.put(envelope);
    const transResult = await store1.transition(envelope.id, "pending", "injected");
    expect(transResult.ok).toBe(true);
    store1.close();

    // Reopen and verify status
    const store2 = createSqliteHandoffStore({ dbPath: tmpPath });
    const getResult = await store2.get(envelope.id);
    expect(getResult.ok).toBe(true);
    if (getResult.ok) {
      expect(getResult.value.status).toBe("injected");
    }
    store2.close();
  });

  test("TTL expiration works after reopen", async () => {
    const expired = createTestEnvelope({
      createdAt: Date.now() - 100_000, // 100 seconds ago
    });

    // Write with short TTL
    const store1 = createSqliteHandoffStore({ dbPath: tmpPath, ttlMs: 50_000 });
    await store1.put(expired);
    store1.close();

    // Reopen with same TTL — envelope should be expired
    const store2 = createSqliteHandoffStore({ dbPath: tmpPath, ttlMs: 50_000 });
    const getResult = await store2.get(expired.id);
    expect(getResult.ok).toBe(false);
    store2.close();
  });
});
