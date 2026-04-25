import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { CapabilityScope } from "@koi/core";
import { agentId, sessionId } from "@koi/core";
import { verifyHmac } from "./hmac.js";
import { delegateCapability, issueRootCapability } from "./issue.js";
import type { CapabilitySigner as Signer } from "./signer.js";

const baseScope = (): CapabilityScope => ({
  permissions: { allow: ["read_file"] },
  sessionId: sessionId("sess-1"),
});

const hmacSigner = (): Signer => ({ kind: "hmac-sha256", secret: randomBytes(32) });

describe("issueRootCapability", () => {
  test("returns a token with chainDepth=0 and no parentId", async () => {
    const signer = hmacSigner();
    const tok = await issueRootCapability({
      signer,
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: baseScope(),
      ttlMs: 60_000,
      maxChainDepth: 3,
      now: () => 1000,
    });
    expect(tok.chainDepth).toBe(0);
    expect(tok.parentId).toBeUndefined();
    expect(tok.maxChainDepth).toBe(3);
    expect(tok.createdAt).toBe(1000);
    expect(tok.expiresAt).toBe(61_000);
    expect(tok.issuerId).toBe(agentId("engine"));
    expect(tok.delegateeId).toBe(agentId("alice"));
  });

  test("produces a token whose HMAC proof verifies", async () => {
    const signer = hmacSigner();
    const tok = await issueRootCapability({
      signer,
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: baseScope(),
      ttlMs: 60_000,
      maxChainDepth: 3,
    });
    if (signer.kind !== "hmac-sha256") throw new Error("unexpected");
    expect(verifyHmac(tok, signer.secret)).toBe(true);
  });

  test("produces an Ed25519 token whose proof has the correct kind + fingerprint", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pubDer = publicKey.export({ format: "der", type: "spki" });
    const privDer = privateKey.export({ format: "der", type: "pkcs8" });
    const fp = Buffer.from(pubDer).toString("base64");
    const tok = await issueRootCapability({
      signer: { kind: "ed25519", privateKey: privDer, publicKeyFingerprint: fp },
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: baseScope(),
      ttlMs: 60_000,
      maxChainDepth: 3,
    });
    expect(tok.proof.kind).toBe("ed25519");
    if (tok.proof.kind === "ed25519") {
      expect(tok.proof.publicKey).toBe(fp);
    }
  });

  test("registers the token if a registry is provided", async () => {
    const signer = hmacSigner();
    let registered: string | undefined;
    const registry = {
      register(t: { id: string }): void {
        registered = t.id;
      },
      isRevoked(): boolean {
        return false;
      },
      revoke(): void {},
    };
    const tok = await issueRootCapability({
      signer,
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: baseScope(),
      ttlMs: 60_000,
      maxChainDepth: 3,
      // biome-ignore lint/suspicious/noExplicitAny: cross-package mock
      registry: registry as any,
    });
    expect(registered).toBe(tok.id);
  });

  test("throws on ttlMs <= 0", async () => {
    const signer = hmacSigner();
    await expect(
      issueRootCapability({
        signer,
        issuerId: agentId("engine"),
        delegateeId: agentId("alice"),
        scope: baseScope(),
        ttlMs: 0,
        maxChainDepth: 3,
      }),
    ).rejects.toThrow();
  });

  test("throws on maxChainDepth < 0", async () => {
    const signer = hmacSigner();
    await expect(
      issueRootCapability({
        signer,
        issuerId: agentId("engine"),
        delegateeId: agentId("alice"),
        scope: baseScope(),
        ttlMs: 60_000,
        maxChainDepth: -1,
      }),
    ).rejects.toThrow();
  });
});

describe("delegateCapability", () => {
  const newRoot = async (
    overrides: Partial<{
      ttlMs: number;
      maxChainDepth: number;
      allow: readonly string[];
      now: () => number;
    }> = {},
  ): Promise<{ signer: Signer; root: import("@koi/core").CapabilityToken }> => {
    const signer: Signer = { kind: "hmac-sha256", secret: randomBytes(32) };
    const root = await issueRootCapability({
      signer,
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: {
        permissions: { allow: overrides.allow ?? ["read_file", "write_file"] },
        sessionId: sessionId("sess-1"),
      },
      ttlMs: overrides.ttlMs ?? 60_000,
      maxChainDepth: overrides.maxChainDepth ?? 3,
      ...(overrides.now ? { now: overrides.now } : {}),
    });
    return { signer, root };
  };

  test("narrows allow list successfully", async () => {
    const { signer, root } = await newRoot();
    const result = await delegateCapability({
      signer,
      parent: root,
      delegateeId: agentId("bob"),
      scope: {
        permissions: { allow: ["read_file"] },
        sessionId: sessionId("sess-1"),
      },
      ttlMs: 30_000,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.parentId).toBe(root.id);
    expect(result.value.chainDepth).toBe(1);
    expect(result.value.maxChainDepth).toBe(3);
    expect(result.value.scope.permissions.allow).toEqual(["read_file"]);
  });

  test("rejects widening (child has tool not in parent)", async () => {
    const { signer, root } = await newRoot({ allow: ["read_file"] });
    const result = await delegateCapability({
      signer,
      parent: root,
      delegateeId: agentId("bob"),
      scope: {
        permissions: { allow: ["read_file", "write_file"] },
        sessionId: sessionId("sess-1"),
      },
      ttlMs: 30_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("PERMISSION");
    expect((result.error.context as { reason: string }).reason).toBe("scope_exceeded");
  });

  test("rejects when chain depth would exceed maxChainDepth", async () => {
    const { signer, root } = await newRoot({ maxChainDepth: 0 });
    const result = await delegateCapability({
      signer,
      parent: root,
      delegateeId: agentId("bob"),
      scope: {
        permissions: { allow: ["read_file"] },
        sessionId: sessionId("sess-1"),
      },
      ttlMs: 30_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error.context as { reason: string }).reason).toBe("chain_depth_exceeded");
  });

  test("rejects when parent is already expired", async () => {
    const { signer, root } = await newRoot({ ttlMs: 1, now: () => 1000 });
    const result = await delegateCapability({
      signer,
      parent: root,
      delegateeId: agentId("bob"),
      scope: root.scope,
      ttlMs: 100,
      now: () => 5000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("VALIDATION");
    expect((result.error.context as { reason: string }).reason).toBe("expired");
  });

  test("rejects sessionId mismatch", async () => {
    const { signer, root } = await newRoot();
    const result = await delegateCapability({
      signer,
      parent: root,
      delegateeId: agentId("bob"),
      scope: {
        permissions: { allow: ["read_file"] },
        sessionId: sessionId("DIFFERENT"),
      },
      ttlMs: 30_000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error.context as { reason: string }).reason).toBe("session_mismatch");
  });

  test("rejects when child TTL would exceed parent expiry", async () => {
    const { signer, root } = await newRoot({ ttlMs: 1000, now: () => 1000 });
    const result = await delegateCapability({
      signer,
      parent: root,
      delegateeId: agentId("bob"),
      scope: root.scope,
      ttlMs: 5000, // parent.expiresAt = 2000, now+ttl = 6000 → exceeds
      now: () => 1000,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect((result.error.context as { reason: string }).reason).toBe("ttl_exceeds_parent");
  });

  test("registers the child if a registry is given", async () => {
    const { signer, root } = await newRoot();
    let registeredId: string | undefined;
    const registry = {
      register(t: { id: string }): void {
        registeredId = t.id;
      },
      isRevoked(): boolean {
        return false;
      },
      revoke(): void {},
    };
    const result = await delegateCapability({
      signer,
      parent: root,
      delegateeId: agentId("bob"),
      scope: { permissions: { allow: ["read_file"] }, sessionId: sessionId("sess-1") },
      ttlMs: 30_000,
      // biome-ignore lint/suspicious/noExplicitAny: cross-package mock
      registry: registry as any,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(registeredId).toBe(result.value.id);
  });

  test("resource attenuation enforced (codex round-1: high)", async () => {
    const signer: Signer = { kind: "hmac-sha256", secret: randomBytes(32) };
    const root = await issueRootCapability({
      signer,
      issuerId: agentId("engine"),
      delegateeId: agentId("alice"),
      scope: {
        permissions: { allow: ["read_file"] },
        resources: ["read_file:/safe/**"],
        sessionId: sessionId("sess-1"),
      },
      ttlMs: 60_000,
      maxChainDepth: 3,
      now: () => 1000,
    });

    const widen = await delegateCapability({
      signer,
      parent: root,
      delegateeId: agentId("bob"),
      scope: {
        permissions: { allow: ["read_file"] },
        resources: ["read_file:/etc/**"],
        sessionId: sessionId("sess-1"),
      },
      ttlMs: 30_000,
      now: () => 1000,
    });
    expect(widen.ok).toBe(false);
    if (widen.ok) return;
    expect((widen.error.context as { reason: string }).reason).toBe("scope_exceeded");

    const drop = await delegateCapability({
      signer,
      parent: root,
      delegateeId: agentId("bob"),
      scope: {
        permissions: { allow: ["read_file"] },
        sessionId: sessionId("sess-1"),
      },
      ttlMs: 30_000,
      now: () => 1000,
    });
    expect(drop.ok).toBe(false);
    if (drop.ok) return;
    expect((drop.error.context as { reason: string }).reason).toBe("scope_exceeded");

    const okResult = await delegateCapability({
      signer,
      parent: root,
      delegateeId: agentId("bob"),
      scope: {
        permissions: { allow: ["read_file"] },
        resources: ["read_file:/safe/**"],
        sessionId: sessionId("sess-1"),
      },
      ttlMs: 30_000,
      now: () => 1000,
    });
    expect(okResult.ok).toBe(true);
  });
});
