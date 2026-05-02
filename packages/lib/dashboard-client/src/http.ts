import type { KoiError, Result } from "@koi/core";
import type { ApiResult } from "@koi/dashboard-types";
import { clientError } from "./errors.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Issue an HTTP GET, parse the JSON envelope, and convert any failure (network,
 * non-2xx, parse, server-returned error) into a `Result<T, KoiError>`. Never throws.
 */
export async function getJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init?: RequestInit,
): Promise<Result<T>> {
  const response = await safeFetch(fetchImpl, url, init);
  if (!response.ok) return { ok: false, error: response.error };

  const parsed = await safeParse<ApiResult<T>>(response.value);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const envelope = parsed.value;
  if (!envelope.ok) return { ok: false, error: envelope.error };
  return { ok: true, value: envelope.value };
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
    return { ok: false, error: clientError("EXTERNAL", `Network error fetching ${url}`, cause) };
  }
  if (response.status >= 500) {
    return {
      ok: false,
      error: clientError("EXTERNAL", `Server ${response.status} on ${url}`),
    };
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

async function safeParse<T>(response: Response): Promise<Result<T>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    return {
      ok: false,
      error: clientError("VALIDATION", "Response body was not valid JSON", cause),
    };
  }
  if (!isApiResultShape(body)) {
    return {
      ok: false,
      error: clientError("VALIDATION", "Response was not an ApiResult envelope"),
    };
  }
  return { ok: true, value: body as T };
}

function isApiResultShape(x: unknown): x is { readonly ok: boolean; readonly error?: KoiError } {
  return (
    typeof x === "object" &&
    x !== null &&
    "ok" in x &&
    typeof (x as { ok: unknown }).ok === "boolean"
  );
}
