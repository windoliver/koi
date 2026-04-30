import type { KoiError, Result } from "@koi/core";

type ChannelParser = (rawBody: string, contentType: string | null) => Result<unknown, KoiError>;

const INVALID_BODY: KoiError = {
  code: "INVALID_BODY",
  message: "Request body could not be parsed",
  retryable: false,
};

export function parseBody(
  rawBody: string,
  contentType: string | null,
  channelParser?: ChannelParser,
): Result<unknown, KoiError> {
  if (channelParser !== undefined) return channelParser(rawBody, contentType);
  if (contentType === null || !contentType.includes("application/json")) {
    return { ok: false, error: INVALID_BODY };
  }
  try {
    const value = JSON.parse(rawBody) as unknown;
    if (value === null || typeof value !== "object") {
      return { ok: false, error: INVALID_BODY };
    }
    return { ok: true, value };
  } catch {
    return { ok: false, error: INVALID_BODY };
  }
}
