import { describe, expect, test } from "bun:test";
import type { AuditEntry, AuditSink } from "@koi/core";
import { createAuditMiddleware } from "./audit.js";
import { verifyEntrySignature } from "./signing.js";

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
    agentId: "sign-agent",
    sessionId: "sign-session" as never,
    runId: "sign-run" as never,
    metadata: {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Ed25519 signing", () => {
  test("signature field is present when signing: true", async () => {
    const sink = createCaptureSink();
    const mw = createAuditMiddleware({ sink, signing: true });
    await mw.onSessionStart?.(makeSession());
    await mw.flush();
    const entry = sink.entries[0];
    if (entry === undefined) throw new Error("expected at least one entry");
    expect(entry.signature).toBeDefined();
    expect(typeof entry.signature).toBe("string");
  });

  test("signature field is absent when signing not configured", async () => {
    const sink = createCaptureSink();
    const mw = createAuditMiddleware({ sink });
    await mw.onSessionStart?.(makeSession());
    await mw.flush();
    const entry = sink.entries[0];
    if (entry === undefined) throw new Error("expected at least one entry");
    expect(entry.signature).toBeUndefined();
  });

  test("signingPublicKey is defined when signing: true", () => {
    const sink = createCaptureSink();
    const mw = createAuditMiddleware({ sink, signing: true });
    expect(mw.signingPublicKey).toBeDefined();
    expect(mw.signingPublicKey?.length).toBeGreaterThan(0);
  });

  test("signingPublicKey is undefined when signing not configured", () => {
    const sink = createCaptureSink();
    const mw = createAuditMiddleware({ sink });
    expect(mw.signingPublicKey).toBeUndefined();
  });

  test("signature is verifiable with the public key", async () => {
    const sink = createCaptureSink();
    const mw = createAuditMiddleware({ sink, signing: true });
    await mw.onSessionStart?.(makeSession());
    await mw.flush();

    const entry = sink.entries[0];
    const publicKeyDer = mw.signingPublicKey;
    if (entry === undefined || publicKeyDer === undefined) {
      throw new Error("expected entry and public key");
    }
    expect(verifyEntrySignature(entry, publicKeyDer)).toBe(true);
  });

  test("tampered entry fails signature verification", async () => {
    const sink = createCaptureSink();
    const mw = createAuditMiddleware({ sink, signing: true });
    await mw.onSessionStart?.(makeSession());
    await mw.flush();

    const original = sink.entries[0];
    const publicKeyDer = mw.signingPublicKey;
    if (original === undefined || publicKeyDer === undefined) {
      throw new Error("expected entry and public key");
    }
    // Tamper: change the agentId
    const tampered: AuditEntry = { ...original, agentId: "attacker" };
    expect(verifyEntrySignature(tampered, publicKeyDer)).toBe(false);
  });

  test("entry without signature returns false from verifyEntrySignature", async () => {
    const sink = createCaptureSink();
    const mw = createAuditMiddleware({ sink }); // no signing
    await mw.onSessionStart?.(makeSession());
    await mw.flush();

    const entry = sink.entries[0];
    if (entry === undefined) throw new Error("expected at least one entry");
    const fakeKey = Buffer.alloc(44, 0); // invalid key
    expect(verifyEntrySignature(entry, fakeKey)).toBe(false);
  });
});
