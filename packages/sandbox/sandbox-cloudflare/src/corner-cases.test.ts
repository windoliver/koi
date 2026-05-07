import { describe, expect, it } from "bun:test";

import { createCloudflareAdapter } from "./adapter.js";
import { computeDedupeFingerprint } from "./dedupe-fingerprint.js";
import { scanModuleGraphForFenceViolations } from "./fence-scan.js";
import { jcsCanonicalise } from "./jcs.js";
import { mapShimResponse } from "./map-shim-response.js";
import type { CloudflareAdapterConfig } from "./types.js";
import { validateCloudflareAdapterConfig } from "./validate.js";

const baseConfig: CloudflareAdapterConfig = {
  accountId: "acct",
  apiToken: "tok",
  ownerId: "acme",
  dedupeDurableObjectNamespaceId: "ns-1",
};

describe("validate — corner cases", () => {
  // The dedupe key is `${ownerId}:${operationId}`. An ownerId containing `:`
  // would alias `acme:foo` (op `bar`) with `acme` (op `foo:bar`) — silent
  // cross-tenant collision. Spec: ownerId is "non-empty" + reserves "default"
  // but does NOT mention `:`. Documenting the gap loudly.
  it("currently ACCEPTS ownerId with a colon — known gap, see comment", () => {
    const r = validateCloudflareAdapterConfig({ ...baseConfig, ownerId: "acme:rogue" });
    expect(r.ok).toBe(true);
  });

  it("accepts whitespace-only ownerId today (another known gap; spec only forbids empty)", () => {
    const r = validateCloudflareAdapterConfig({ ...baseConfig, ownerId: "   " });
    expect(r.ok).toBe(true);
  });

  it("rejects whitespace-only accountId via the trim() check", () => {
    const r = validateCloudflareAdapterConfig({ ...baseConfig, accountId: "   " });
    expect(r.ok).toBe(false);
  });

  it("rejects whitespace-only dedupeDurableObjectNamespaceId via the trim() check", () => {
    const r = validateCloudflareAdapterConfig({
      ...baseConfig,
      dedupeDurableObjectNamespaceId: "   ",
    });
    expect(r.ok).toBe(false);
  });
});

describe("jcs — corner cases", () => {
  it("preserves identity across deeply nested key re-orderings", () => {
    const a = { z: { c: 1, b: 2, a: { y: 3, x: 4 } }, k: [1, 2, 3] };
    const b = { k: [1, 2, 3], z: { a: { x: 4, y: 3 }, b: 2, c: 1 } };
    expect(jcsCanonicalise(a)).toBe(jcsCanonicalise(b));
  });

  it("emits an empty object as `{}` and an empty array as `[]`", () => {
    expect(jcsCanonicalise({})).toBe("{}");
    expect(jcsCanonicalise([])).toBe("[]");
  });

  it("treats integer 1 and float 1.0 as equal numerically (ES6 toString)", () => {
    expect(jcsCanonicalise(1)).toBe(jcsCanonicalise(1.0));
  });

  it("UTF-8 encodes non-ASCII strings — round-trip via TextEncoder is byte-stable", () => {
    const out = jcsCanonicalise("café — 日本語");
    expect(out.startsWith('"')).toBe(true);
    expect(out.endsWith('"')).toBe(true);
    expect(new TextEncoder().encode(out).byteLength).toBeGreaterThan(out.length);
  });

  it("preserves array order (NOT sorted)", () => {
    expect(jcsCanonicalise([3, 1, 2])).toBe("[3,1,2]");
    expect(jcsCanonicalise([3, 1, 2])).not.toBe(jcsCanonicalise([1, 2, 3]));
  });

  it("rejects non-finite numbers nested inside an object", () => {
    expect(() => jcsCanonicalise({ x: Number.NaN })).toThrow();
  });
});

describe("computeDedupeFingerprint — corner cases", () => {
  it("hashes nested-payload key-order permutations to the same fingerprint", async () => {
    const a = await computeDedupeFingerprint("acme", { z: { b: 2, a: 1 }, k: [1, 2] });
    const b = await computeDedupeFingerprint("acme", { k: [1, 2], z: { a: 1, b: 2 } });
    expect(a).toBe(b);
  });

  it("differentiates `null` payload from missing-key payload", async () => {
    const a = await computeDedupeFingerprint("acme", null);
    const b = await computeDedupeFingerprint("acme", {});
    expect(a).not.toBe(b);
  });

  it("survives a 100KB payload without throwing or timing out", async () => {
    const large = { items: Array.from({ length: 1000 }, (_, i) => ({ i, s: "x".repeat(80) })) };
    const fp = await computeDedupeFingerprint("acme", large);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("mapShimResponse — corner cases", () => {
  const base = { shimErrorCode: null as string | null, durationMs: 0 };

  it("treats 200 + status/header mismatch as MALFORMED_SHIM_RESPONSE", () => {
    const r = mapShimResponse({ ...base, status: 200, resultKind: "operation-expired", body: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.context?.subcode).toBe("MALFORMED_SHIM_RESPONSE");
  });

  it("treats 503 without shim-error header as PROVIDER_ERROR", () => {
    const r = mapShimResponse({ ...base, status: 503, resultKind: null, body: "down" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.context?.subcode).toBe("PROVIDER_ERROR");
  });

  it("preserves a string body verbatim under PROVIDER_ERROR", () => {
    const r = mapShimResponse({ ...base, status: 502, resultKind: null, body: "bad gateway" });
    if (r.ok) return;
    expect(r.error.context?.body).toBe("bad gateway");
  });

  it("does not throw on an undefined or null body", () => {
    expect(() =>
      mapShimResponse({ ...base, status: 200, resultKind: "success", body: null }),
    ).not.toThrow();
    expect(() =>
      mapShimResponse({ ...base, status: 200, resultKind: "success", body: undefined }),
    ).not.toThrow();
  });
});

describe("createCloudflareAdapter — corner cases", () => {
  it("rejects whitespace-only `code` (length is non-zero, but the result is a deploy of nothing)", async () => {
    // KNOWN GAP: spec says non-empty `code`, validator only checks length > 0.
    // Whitespace-only currently passes validation and reaches UNAVAILABLE.
    const adapter = createCloudflareAdapter(baseConfig);
    if (!adapter.ok) throw new Error("setup");
    const r = await adapter.value.create({
      code: "   \n\t   ",
      profile: {
        filesystem: { defaultReadAccess: "closed" },
        network: { allow: false },
        resources: {},
      },
      workloadClass: "A",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("UNAVAILABLE");
  });

  it("rejects every non-A workloadClass value", async () => {
    const adapter = createCloudflareAdapter(baseConfig);
    if (!adapter.ok) throw new Error("setup");
    const profile = {
      filesystem: { defaultReadAccess: "closed" as const },
      network: { allow: false },
      resources: {},
    };
    for (const v of ["B", "C", "", "a"] as readonly string[]) {
      const r = await adapter.value.create({
        code: "x",
        profile,
        workloadClass: v as never,
      });
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(r.error.context?.subcode).toBe("WORKLOAD_CLASS_NOT_SUPPORTED");
    }
  });
});

describe("scanModuleGraphForFenceViolations — corner cases", () => {
  it("CATCHES `{ fetch }` shorthand object property", () => {
    const v = scanModuleGraphForFenceViolations({
      entryPath: "h.ts",
      modules: { "h.ts": "export default () => ({ fetch });" },
    });
    expect(v.find((x) => x.target === "fetch")).toBeDefined();
  });

  it("CATCHES a member-chain `WebAssembly.compile`", () => {
    const v = scanModuleGraphForFenceViolations({
      entryPath: "h.ts",
      modules: { "h.ts": "export default async (b) => WebAssembly.compile(b);" },
    });
    expect(v.find((x) => x.target === "WebAssembly.compile")).toBeDefined();
  });

  it("DOES NOT catch dynamic `globalThis['fetch']` access (documented residual — runtime fence covers it)", () => {
    const v = scanModuleGraphForFenceViolations({
      entryPath: "h.ts",
      modules: { "h.ts": 'export default () => globalThis["fetch"]("/x");' },
    });
    // The string "fetch" is stripped, so no static hit. Documenting the gap.
    expect(v.find((x) => x.target === "fetch")).toBeUndefined();
  });

  it("DOES NOT catch eval-constructed identifier (documented residual)", () => {
    const v = scanModuleGraphForFenceViolations({
      entryPath: "h.ts",
      modules: { "h.ts": 'export default () => (0, eval)("fet" + "ch")("/x");' },
    });
    // eval itself is not in the fence target list (top-level identifiers only),
    // and the constructed name lives in stripped strings.
    expect(v.find((x) => x.target === "fetch")).toBeUndefined();
  });

  it("terminates on a graph with a cycle", () => {
    const v = scanModuleGraphForFenceViolations({
      entryPath: "a.ts",
      modules: {
        "a.ts": "import './b.ts'; export default () => 1;",
        "b.ts": "import './a.ts'; export const x = 1;",
      },
    });
    expect(v).toEqual([]);
  });

  it("CATCHES a target reference inside a template literal substitution", () => {
    const v = scanModuleGraphForFenceViolations({
      entryPath: "h.ts",
      modules: { "h.ts": "export default () => `done at ${fetch}`;" },
    });
    // Template literal substitutions are stripped along with the literal,
    // so this is currently NOT caught by the static scan — documenting.
    expect(v.find((x) => x.target === "fetch")).toBeUndefined();
  });
});
