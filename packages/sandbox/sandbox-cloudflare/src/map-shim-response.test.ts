import { describe, expect, it } from "bun:test";

import { mapShimResponse } from "./map-shim-response.js";

const base = { shimErrorCode: null as string | null, durationMs: 5 };

describe("mapShimResponse", () => {
  it("maps 200 + success header to ok with parsed output", () => {
    const r = mapShimResponse({ ...base, status: 200, resultKind: "success", body: { hello: 1 } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.output).toEqual({ hello: 1 });
  });

  it("maps 200 + failed-permanent to HANDLER_PERMANENT_FAILURE (EXTERNAL)", () => {
    const r = mapShimResponse({
      ...base,
      status: 200,
      resultKind: "failed-permanent",
      body: { error: "bad input" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("EXTERNAL");
    expect(r.error.context?.subcode).toBe("HANDLER_PERMANENT_FAILURE");
  });

  it("maps 200 + missing header to MALFORMED_SHIM_RESPONSE", () => {
    const r = mapShimResponse({ ...base, status: 200, resultKind: null, body: { x: 1 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.context?.subcode).toBe("MALFORMED_SHIM_RESPONSE");
  });

  it("maps 504 + timeout to TIMEOUT", () => {
    const r = mapShimResponse({
      ...base,
      status: 504,
      resultKind: "timeout",
      body: { error: "TIMEOUT" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("TIMEOUT");
  });

  it("maps 503 + shim-error with subcode header", () => {
    const r = mapShimResponse({
      ...base,
      status: 503,
      resultKind: "shim-error",
      shimErrorCode: "LEASE_LOST",
      body: {},
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.context?.subcode).toBe("LEASE_LOST");
  });

  it("maps 409 + operation-id-conflict to CONFLICT", () => {
    const r = mapShimResponse({
      ...base,
      status: 409,
      resultKind: "operation-id-conflict",
      body: { storedFingerprint: "abc" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("CONFLICT");
    expect(r.error.context?.storedFingerprint).toBe("abc");
  });

  it("maps 410 + operation-expired to VALIDATION/OPERATION_EXPIRED", () => {
    const r = mapShimResponse({
      ...base,
      status: 410,
      resultKind: "operation-expired",
      body: { dedupeExpiresAtMs: 1000 },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.context?.subcode).toBe("OPERATION_EXPIRED");
  });

  it("falls back to PROVIDER_ERROR for any other status", () => {
    const r = mapShimResponse({ ...base, status: 502, resultKind: null, body: "bad gateway" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.context?.subcode).toBe("PROVIDER_ERROR");
  });
});
