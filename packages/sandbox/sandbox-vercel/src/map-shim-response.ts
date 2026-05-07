/**
 * Host-side mapping from raw shim HTTP response → typed `Result<EdgeInvokeResult, KoiError>`.
 *
 * Identical contract to the Cloudflare mapper — `X-Koi-Result-Kind` is the
 * authoritative business outcome, HTTP status is transport. Symmetric across
 * providers so callers don't branch by adapter.
 */

import type { EdgeInvokeResult, KoiError, Result } from "@koi/core";

interface RawShimResponse {
  readonly status: number;
  readonly resultKind: string | null;
  readonly shimErrorCode: string | null;
  readonly body: unknown;
  readonly durationMs: number;
}

const koiError = (
  code: KoiError["code"],
  message: string,
  retryable: boolean,
  context?: KoiError["context"],
): KoiError =>
  context === undefined ? { code, message, retryable } : { code, message, retryable, context };

const fail = (error: KoiError): Result<EdgeInvokeResult, KoiError> => ({ ok: false, error });

const asObject = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === "object" ? (v as Record<string, unknown>) : undefined;

export const mapShimResponse = (raw: RawShimResponse): Result<EdgeInvokeResult, KoiError> => {
  const { status, resultKind, body, durationMs } = raw;
  const obj = asObject(body);

  if (status === 200) {
    if (resultKind === "success") {
      return { ok: true, value: { output: body, durationMs } };
    }
    if (resultKind === "failed-permanent") {
      const cachedError = obj?.error;
      return fail(
        koiError("EXTERNAL", "edge handler returned a cached permanent failure", false, {
          subcode: "HANDLER_PERMANENT_FAILURE",
          cachedError: cachedError ?? null,
        }),
      );
    }
    return fail(
      koiError("INTERNAL", "shim returned 200 with no/unknown X-Koi-Result-Kind", false, {
        subcode: "MALFORMED_SHIM_RESPONSE",
        observedKind: resultKind ?? null,
      }),
    );
  }

  if (status === 504 && resultKind === "timeout") {
    return fail(koiError("TIMEOUT", "edge invoke exceeded the waiter budget", true));
  }

  if (status === 503 && resultKind === "shim-error") {
    const subcode = raw.shimErrorCode ?? "UNKNOWN_SHIM_ERROR";
    return fail(koiError("INTERNAL", `shim error: ${subcode}`, true, { subcode }));
  }

  if (status === 401 && resultKind === "shim-error") {
    return fail(
      koiError("INTERNAL", "shim signature verification failed", false, {
        subcode: "SIGNATURE_INVALID",
      }),
    );
  }

  if (status === 409 && resultKind === "operation-id-conflict") {
    return fail(
      koiError(
        "CONFLICT",
        "operationId reused with a different payload (or expiry-horizon mismatch)",
        false,
        {
          subcode: "OPERATION_ID_CONFLICT",
          storedFingerprint: obj?.storedFingerprint ?? null,
        },
      ),
    );
  }

  if (status === 410 && resultKind === "operation-expired") {
    return fail(
      koiError("VALIDATION", "operation expired past its dedupeExpiresAtMs", false, {
        subcode: "OPERATION_EXPIRED",
        dedupeExpiresAtMs: obj?.dedupeExpiresAtMs ?? null,
      }),
    );
  }

  return fail(
    koiError("EXTERNAL", `provider error: HTTP ${status}`, false, {
      subcode: "PROVIDER_ERROR",
      status,
      body,
    }),
  );
};
