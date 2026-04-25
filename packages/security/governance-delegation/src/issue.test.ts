import { describe, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { CapabilityScope } from "@koi/core";
import { agentId, sessionId } from "@koi/core";
import { verifyHmac } from "./hmac.js";
import { issueRootCapability } from "./issue.js";
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
