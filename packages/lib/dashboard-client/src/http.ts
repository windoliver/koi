import { type KoiError, type KoiErrorCode, RETRYABLE_DEFAULTS, type Result } from "@koi/core";
import { clientError } from "./errors.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GetJsonOptions<T> {
  readonly init?: RequestInit;
  /**
   * When true, an `ok:true` envelope without a `value` field decodes to
   * `undefined` (correct for optional-result endpoints like `getTrace`).
   * When false (default), missing `value` is a VALIDATION error so list
   * endpoints fail fast on schema drift instead of returning `undefined`.
   */
  readonly allowUndefinedValue?: boolean;
  /**
   * Runtime payload guard. Required so `getJson` validates the success
   * payload at the trust boundary instead of casting `body.value as T`.
   * `undefined` (missing `value` with allowUndefinedValue=true) is always
   * accepted without invoking the guard.
   */
  readonly validate: (value: unknown) => value is T;
}

/**
 * Issue an HTTP GET, parse the JSON envelope, and convert any failure (network,
 * non-2xx, parse, server-returned error) into a `Result<T, KoiError>`. Never throws.
 *
 * Transient transport conditions (network throw, 5xx, 429) come back as retryable
 * KoiErrors so caller-side retry middleware can compose recovery.
 */
export async function getJson<T>(
  fetchImpl: FetchLike,
  url: string,
  options: GetJsonOptions<T>,
): Promise<Result<T>> {
  // Defensive: TypeScript requires `options.validate`, but a JS caller or an
  // escaped-types path may pass `undefined`. Honour the documented
  // never-throws contract by surfacing this as a Result instead.
  const safeOptions = (options ?? ({} as Partial<GetJsonOptions<T>>)) as Partial<GetJsonOptions<T>>;
  if (typeof safeOptions.validate !== "function") {
    return {
      ok: false,
      error: clientError("VALIDATION", "getJson called without a validate function"),
    };
  }

  const response = await safeFetch(fetchImpl, url, safeOptions.init);
  if (!response.ok) return { ok: false, error: response.error };

  const parsed = await safeParseEnvelope<T>(
    response.value,
    safeOptions.allowUndefinedValue ?? false,
    safeOptions.validate,
  );
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return parsed;
}

async function safeFetch(
  fetchImpl: FetchLike,
  url: string,
  init?: RequestInit,
): Promise<Result<Response>> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (cause) {
    // AbortError = caller cancellation; never retry, never resurrect.
    if (isAbortError(cause)) {
      return {
        ok: false,
        error: clientError("EXTERNAL", `Aborted: ${url}`, { cause }),
      };
    }
    // Other thrown fetch errors (DNS, TCP reset, refused connection) are
    // transient transport failures in practice. Default retryable so the
    // common outage path recovers; deterministic misconfiguration should
    // fail fast at config-load time, not here.
    return {
      ok: false,
      error: clientError("EXTERNAL", `Network error fetching ${url}`, {
        cause,
        retryable: true,
      }),
    };
  }
  if (response.status >= 500) {
    return {
      ok: false,
      error: clientError("EXTERNAL", `Server ${response.status} on ${url}`, {
        retryable: true,
      }),
    };
  }
  if (response.status === 429) {
    return { ok: false, error: clientError("RATE_LIMIT", `Rate limited on ${url}`) };
  }
  if (response.status === 404) {
    return { ok: false, error: clientError("NOT_FOUND", `Not found: ${url}`) };
  }
  if (!response.ok) {
    return {
      ok: false,
      error: clientError("EXTERNAL", `HTTP ${response.status} on ${url}`),
    };
  }
  return { ok: true, value: response };
}

async function safeParseEnvelope<T>(
  response: Response,
  allowUndefinedValue: boolean,
  validate: (value: unknown) => value is T,
): Promise<Result<T>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    return {
      ok: false,
      error: clientError("VALIDATION", "Response body was not valid JSON", { cause }),
    };
  }
  if (!isObject(body) || typeof body.ok !== "boolean") {
    return {
      ok: false,
      error: clientError("VALIDATION", "Response was not an ApiResult envelope"),
    };
  }
  if (body.ok === true) {
    const hasValue = "value" in body;
    if (!hasValue && !allowUndefinedValue) {
      return {
        ok: false,
        error: clientError(
          "VALIDATION",
          "ApiResult ok=true is missing `value` (use allowUndefinedValue for optional payloads)",
        ),
      };
    }
    if (!hasValue) {
      // Allowed-undefined endpoints: pass `undefined` straight through; the
      // T at the call site already includes `undefined` in its union.
      return { ok: true, value: undefined as T };
    }
    if (!validate(body.value)) {
      return {
        ok: false,
        error: clientError("VALIDATION", "ApiResult `value` does not match the expected schema"),
      };
    }
    return { ok: true, value: body.value };
  }
  const normalised = normaliseError(body.error);
  if (normalised === undefined) {
    return {
      ok: false,
      error: clientError("VALIDATION", "ApiResult ok=false has no well-formed `error`"),
    };
  }
  return { ok: false, error: normalised };
}

/**
 * Decode a server-supplied error tolerantly. Older or non-TS producers may
 * omit `retryable`; older servers may also use a code outside the current
 * KoiErrorCode union. We preserve the message in either case rather than
 * rewriting the whole error to a local VALIDATION failure.
 *
 * Codes outside the known set are mapped to `EXTERNAL` so the typed value
 * stays in the discriminated union without an `as` assertion on wire data.
 */
function normaliseError(raw: unknown): KoiError | undefined {
  if (!isObject(raw)) return undefined;
  const { code, message, retryable, cause, context, retryAfterMs } = raw;
  if (typeof code !== "string" || typeof message !== "string") return undefined;
  const knownCode: KoiErrorCode = code in RETRYABLE_DEFAULTS ? (code as KoiErrorCode) : "EXTERNAL";
  return {
    code: knownCode,
    message,
    retryable: typeof retryable === "boolean" ? retryable : RETRYABLE_DEFAULTS[knownCode],
    ...(cause === undefined ? {} : { cause }),
    ...(isObject(context) ? { context } : {}),
    ...(typeof retryAfterMs === "number" ? { retryAfterMs } : {}),
  };
}

function isObject(x: unknown): x is Readonly<Record<string, unknown>> {
  return typeof x === "object" && x !== null;
}

function isAbortError(cause: unknown): boolean {
  return isObject(cause) && cause.name === "AbortError";
}
