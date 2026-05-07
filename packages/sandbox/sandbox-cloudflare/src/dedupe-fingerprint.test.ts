import { describe, expect, it } from "bun:test";

import { computeDedupeFingerprint } from "./dedupe-fingerprint.js";

describe("computeDedupeFingerprint", () => {
  it("is stable across object-key orderings (JCS canonical)", async () => {
    const a = await computeDedupeFingerprint("acme", { foo: 1, bar: 2 });
    const b = await computeDedupeFingerprint("acme", { bar: 2, foo: 1 });
    expect(a).toBe(b);
  });

  it("changes when ownerId changes (fleet namespacing)", async () => {
    const a = await computeDedupeFingerprint("acme", { x: 1 });
    const b = await computeDedupeFingerprint("widgets", { x: 1 });
    expect(a).not.toBe(b);
  });

  it("changes when payload changes", async () => {
    const a = await computeDedupeFingerprint("acme", { x: 1 });
    const b = await computeDedupeFingerprint("acme", { x: 2 });
    expect(a).not.toBe(b);
  });

  it("returns lowercase 64-character hex (256 bits)", async () => {
    const fp = await computeDedupeFingerprint("acme", { x: 1 });
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects empty ownerId", async () => {
    await expect(computeDedupeFingerprint("", { x: 1 })).rejects.toThrow();
  });
});
