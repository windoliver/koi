import { describe, expect, it } from "bun:test";

import {
  buildCanonicalSigningString,
  generatePairKeypair,
  signRequest,
  verifyRequest,
} from "./pair-keys.js";

describe("pair-keys", () => {
  it("generates an Ed25519 keypair as PEM", async () => {
    const k = await generatePairKeypair();
    expect(k.signingKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(k.verifyKeyPem).toContain("BEGIN PUBLIC KEY");
  });

  it("sign + verify round-trip succeeds", async () => {
    const k = await generatePairKeypair();
    const canonical = await buildCanonicalSigningString({
      method: "post",
      path: "/api/x",
      operationId: "op-1",
      requestId: "req-1",
      nonce: "n-1",
      timestampSec: 1_700_000_000,
      bodyBytes: new TextEncoder().encode('{"a":1}'),
    });
    const sig = await signRequest(k.signingKeyPem, canonical);
    const ok = await verifyRequest(k.verifyKeyPem, canonical, sig);
    expect(ok).toBe(true);
  });

  it("verify fails on tampered canonical string", async () => {
    const k = await generatePairKeypair();
    const canonical = await buildCanonicalSigningString({
      method: "POST",
      path: "/api/x",
      operationId: "op-1",
      requestId: "req-1",
      nonce: "n-1",
      timestampSec: 1_700_000_000,
      bodyBytes: new TextEncoder().encode('{"a":1}'),
    });
    const sig = await signRequest(k.signingKeyPem, canonical);
    const ok = await verifyRequest(k.verifyKeyPem, `${canonical}\nEXTRA`, sig);
    expect(ok).toBe(false);
  });

  it("verify fails when keys are crossed (different keypair)", async () => {
    const k1 = await generatePairKeypair();
    const k2 = await generatePairKeypair();
    const canonical = "POST\n/x\nop\nreq\nnonce\n0\nAAAA";
    const sig = await signRequest(k1.signingKeyPem, canonical);
    const ok = await verifyRequest(k2.verifyKeyPem, canonical, sig);
    expect(ok).toBe(false);
  });

  it("uppercases method in canonical string", async () => {
    const c1 = await buildCanonicalSigningString({
      method: "post",
      path: "/x",
      operationId: "op",
      requestId: "req",
      nonce: "n",
      timestampSec: 0,
      bodyBytes: new Uint8Array(),
    });
    const c2 = await buildCanonicalSigningString({
      method: "POST",
      path: "/x",
      operationId: "op",
      requestId: "req",
      nonce: "n",
      timestampSec: 0,
      bodyBytes: new Uint8Array(),
    });
    expect(c1).toBe(c2);
  });
});
