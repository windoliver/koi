import { describe, expect, it } from "bun:test";

import { mapShimResponse } from "./map-shim-response.js";

describe("mapShimResponse", () => {
  it("maps 200/success to ok", () => {
    const r = mapShimResponse({
      status: 200,
      resultKind: "success",
      shimErrorCode: null,
      body: { hello: 1 },
      durationMs: 12,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.output).toEqual({ hello: 1 });
    expect(r.value.durationMs).toBe(12);
  });

  it("maps 200/failed-permanent to EXTERNAL", () => {
    const r = mapShimResponse({
      status: 200,
      resultKind: "failed-permanent",
      shimErrorCode: null,
      body: { error: "boom" },
      durationMs: 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("EXTERNAL");
    expect(r.error.context?.subcode).toBe("HANDLER_PERMANENT_FAILURE");
  });

  it("maps 504/timeout", () => {
    const r = mapShimResponse({
      status: 504,
      resultKind: "timeout",
      shimErrorCode: null,
      body: {},
      durationMs: 25_000,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("TIMEOUT");
  });

  it("maps 401/shim-error to SIGNATURE_INVALID", () => {
    const r = mapShimResponse({
      status: 401,
      resultKind: "shim-error",
      shimErrorCode: "SIGNATURE_INVALID",
      body: {},
      durationMs: 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.context?.subcode).toBe("SIGNATURE_INVALID");
  });

  it("maps 409/operation-id-conflict", () => {
    const r = mapShimResponse({
      status: 409,
      resultKind: "operation-id-conflict",
      shimErrorCode: null,
      body: { storedFingerprint: "fp-X" },
      durationMs: 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("CONFLICT");
    expect(r.error.context?.storedFingerprint).toBe("fp-X");
  });

  it("maps 410/operation-expired", () => {
    const r = mapShimResponse({
      status: 410,
      resultKind: "operation-expired",
      shimErrorCode: null,
      body: { dedupeExpiresAtMs: 1 },
      durationMs: 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("VALIDATION");
  });

  it("flags 200 with unknown kind as MALFORMED_SHIM_RESPONSE", () => {
    const r = mapShimResponse({
      status: 200,
      resultKind: null,
      shimErrorCode: null,
      body: {},
      durationMs: 1,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.context?.subcode).toBe("MALFORMED_SHIM_RESPONSE");
  });
});
