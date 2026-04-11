import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AuditEntry, AuditSink } from "@koi/core";
import { createAuditMiddleware } from "./audit.js";
import { GENESIS_HASH } from "./signing.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCaptureSink(): AuditSink & { readonly entries: AuditEntry[] } {
  const entries: AuditEntry[] = [];
  return {
    entries,
    async log(entry: AuditEntry): Promise<void> {
      entries.push(entry);
    },
    async flush(): Promise<void> {},
  };
}

function makeSession() {
  return {
    agentId: "chain-agent",
    sessionId: "chain-session" as never,
    runId: "chain-run" as never,
    metadata: {},
  };
}

function sha256hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("hash chain tamper evidence", () => {
  test("first entry has genesis prev_hash (64 zeros)", async () => {
    const sink = createCaptureSink();
    const mw = createAuditMiddleware({ sink, signing: true });
    await mw.onSessionStart?.(makeSession());
    await mw.flush();

    const first = sink.entries[0];
    if (first === undefined) throw new Error("expected at least one entry");
    expect(first.prev_hash).toBe(GENESIS_HASH);
    expect(first.prev_hash).toHaveLength(64);
    expect(first.prev_hash).toMatch(/^0+$/);
  });

  test("prev_hash fields are absent when signing disabled", async () => {
    const sink = createCaptureSink();
    const mw = createAuditMiddleware({ sink }); // no signing
    await mw.onSessionStart?.(makeSession());
    await mw.flush();

    const entry = sink.entries[0];
    if (entry === undefined) throw new Error("expected at least one entry");
    expect(entry.prev_hash).toBeUndefined();
  });

  test("second entry prev_hash = SHA-256 of first entry JSON", async () => {
    const sink = createCaptureSink();
    const mw = createAuditMiddleware({ sink, signing: true });
    const session = makeSession();
    await mw.onSessionStart?.(session);
    await mw.onSessionEnd?.(session);
    // onSessionEnd flushes internally
    await mw.flush();

    const entries = sink.entries;
    expect(entries.length).toBeGreaterThanOrEqual(2);

    const first = entries[0];
    const second = entries[1];
    if (first === undefined || second === undefined) throw new Error("expected at least 2 entries");

    const expectedPrevHash = sha256hex(JSON.stringify(first));
    expect(second.prev_hash).toBe(expectedPrevHash);
  });

  test("chain of 3 entries is continuous", async () => {
    const sink = createCaptureSink();
    const mw = createAuditMiddleware({ sink, signing: true });
    const session = makeSession();

    // Produce 3 entries
    await mw.onSessionStart?.(session);
    await mw.wrapModelCall?.(
      {
        session,
        turnIndex: 0,
        turnId: "t1" as never,
        messages: [],
        metadata: {},
      },
      { messages: [] },
      async () => ({ content: "hello", model: "test" }),
    );
    await mw.onSessionEnd?.(session);
    await mw.flush();

    const entries = sink.entries;
    expect(entries.length).toBeGreaterThanOrEqual(3);

    // Verify chain continuity
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1];
      const curr = entries[i];
      if (prev === undefined || curr === undefined) throw new Error("unexpected undefined entry");
      const expectedHash = sha256hex(JSON.stringify(prev));
      expect(curr.prev_hash).toBe(expectedHash);
    }
  });

  test("modifying an entry breaks the chain for the next entry", async () => {
    const sink = createCaptureSink();
    const mw = createAuditMiddleware({ sink, signing: true });
    const session = makeSession();

    await mw.onSessionStart?.(session);
    await mw.wrapModelCall?.(
      {
        session,
        turnIndex: 0,
        turnId: "t1" as never,
        messages: [],
        metadata: {},
      },
      { messages: [] },
      async () => ({ content: "hello", model: "test" }),
    );
    await mw.flush();

    const entries = sink.entries;
    expect(entries.length).toBeGreaterThanOrEqual(2);

    const original = entries[0];
    const second = entries[1];
    if (original === undefined || second === undefined)
      throw new Error("expected at least 2 entries");

    const tampered: AuditEntry = { ...original, agentId: "hacker" };

    const hashOfTampered = sha256hex(JSON.stringify(tampered));
    // The stored prev_hash should NOT match the hash of the tampered entry
    expect(second.prev_hash).not.toBe(hashOfTampered);
    // The stored prev_hash SHOULD match the hash of the original entry
    expect(second.prev_hash).toBe(sha256hex(JSON.stringify(original)));
  });
});
