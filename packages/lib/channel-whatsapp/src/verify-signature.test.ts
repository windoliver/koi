import { describe, expect, test } from "bun:test";
import { verifyMetaSignature } from "./verify-signature.js";

const SECRET = "test-app-secret";

function sign(body: string, secret: string = SECRET): string {
  const h = new Bun.CryptoHasher("sha256", secret);
  h.update(body);
  return `sha256=${h.digest("hex")}`;
}

describe("verifyMetaSignature", () => {
  test("matching signature passes", () => {
    const body = '{"hello":"world"}';
    const r = verifyMetaSignature({ rawBody: body, header: sign(body), appSecret: SECRET });
    expect(r.ok).toBe(true);
  });

  test("mutated body fails", () => {
    const body = '{"hello":"world"}';
    const sig = sign(body);
    const r = verifyMetaSignature({
      rawBody: '{"hello":"WORLD"}',
      header: sig,
      appSecret: SECRET,
    });
    expect(r.ok).toBe(false);
  });

  test("missing header fails", () => {
    const r = verifyMetaSignature({ rawBody: "x", header: null, appSecret: SECRET });
    expect(r.ok).toBe(false);
  });

  test("undefined header fails", () => {
    const r = verifyMetaSignature({ rawBody: "x", header: undefined, appSecret: SECRET });
    expect(r.ok).toBe(false);
  });

  test("wrong secret fails", () => {
    const body = "x";
    const r = verifyMetaSignature({
      rawBody: body,
      header: sign(body, "other-secret"),
      appSecret: SECRET,
    });
    expect(r.ok).toBe(false);
  });

  test("non-sha256= prefix fails", () => {
    const body = "x";
    const tail = sign(body).slice("sha256=".length);
    const r = verifyMetaSignature({
      rawBody: body,
      header: `sha1=${tail}`,
      appSecret: SECRET,
    });
    expect(r.ok).toBe(false);
  });

  test("mismatched length fails", () => {
    const r = verifyMetaSignature({
      rawBody: "x",
      header: "sha256=abcd",
      appSecret: SECRET,
    });
    expect(r.ok).toBe(false);
  });
});
