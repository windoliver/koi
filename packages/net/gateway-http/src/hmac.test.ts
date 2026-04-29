import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { computeSignature, verifyHmac } from "./hmac.js";

const SECRET = "test-secret";

function sign(ts: string, body: string, secret: string = SECRET): string {
  const h = createHmac("sha256", secret);
  h.update(`v0:${ts}:${body}`);
  return `v0=${h.digest("hex")}`;
}

describe("computeSignature", () => {
  test("matches the v0:{ts}:{body} convention", () => {
    expect(computeSignature(SECRET, "1730000000", "{}")).toBe(sign("1730000000", "{}"));
  });
});

describe("verifyHmac", () => {
  test("accepts valid signature", () => {
    const sig = sign("1730000000", "{}");
    expect(verifyHmac(SECRET, "1730000000", "{}", sig)).toBe(true);
  });

  test("rejects tampered body", () => {
    const sig = sign("1730000000", "{}");
    expect(verifyHmac(SECRET, "1730000000", `{"x":1}`, sig)).toBe(false);
  });

  test("rejects bit-flipped signature", () => {
    const sig = sign("1730000000", "{}");
    const flipped = `${sig.slice(0, -1)}${sig.endsWith("0") ? "1" : "0"}`;
    expect(verifyHmac(SECRET, "1730000000", "{}", flipped)).toBe(false);
  });

  test("rejects mismatched length without throwing", () => {
    expect(verifyHmac(SECRET, "1730000000", "{}", "v0=short")).toBe(false);
  });

  test("uses different secret -> reject", () => {
    const sig = sign("1730000000", "{}", "other-secret");
    expect(verifyHmac(SECRET, "1730000000", "{}", sig)).toBe(false);
  });
});
