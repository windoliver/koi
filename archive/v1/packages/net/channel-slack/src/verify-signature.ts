/**
 * Slack HTTP request signature verification.
 *
 * Implements HMAC-SHA256 signature verification per Slack's "Verifying requests
 * from Slack" spec, with timing-safe comparison and 5-minute replay protection.
 *
 * @see https://api.slack.com/authentication/verifying-requests-from-slack
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Maximum age (in seconds) for a valid Slack request timestamp. */
const REPLAY_WINDOW_SECONDS = 300;

/**
 * Verifies a Slack request signature using HMAC-SHA256.
 *
 * Computes `v0=HMAC-SHA256(signingSecret, "v0:{timestamp}:{rawBody}")` and
 * compares it to the provided signature using timing-safe comparison.
 *
 * @param signingSecret - The Slack app signing secret.
 * @param timestamp - The `X-Slack-Request-Timestamp` header value.
 * @param rawBody - The raw HTTP request body string.
 * @param signature - The `X-Slack-Signature` header value.
 * @returns `true` if the signature is valid.
 */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
): boolean {
  const baseString = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac("sha256", signingSecret);
  hmac.update(baseString);
  const computed = `v0=${hmac.digest("hex")}`;

  // Both strings must be the same length for timingSafeEqual.
  // If lengths differ, the signature is definitely invalid.
  if (computed.length !== signature.length) {
    return false;
  }

  return timingSafeEqual(
    new Uint8Array(Buffer.from(computed)),
    new Uint8Array(Buffer.from(signature)),
  );
}

/** Result of verifying a Slack HTTP request. */
export interface VerifySlackRequestResult {
  /** Whether the request signature is valid and within the replay window. */
  readonly ok: boolean;
  /** The raw request body (so the caller doesn't need to re-read the stream). */
  readonly body: string;
}

/**
 * Verifies a full Slack HTTP request: extracts headers, checks replay window,
 * reads the body, and validates the HMAC signature.
 *
 * @param signingSecret - The Slack app signing secret.
 * @param request - The incoming HTTP Request object.
 * @returns The verification result including the raw body string.
 */
export async function verifySlackRequest(
  signingSecret: string,
  request: Request,
): Promise<VerifySlackRequestResult> {
  const timestamp = request.headers.get("X-Slack-Request-Timestamp");
  const signature = request.headers.get("X-Slack-Signature");

  // Missing required headers
  if (timestamp === null || signature === null) {
    return { ok: false, body: "" };
  }

  // Replay protection: reject requests older than 5 minutes
  const requestEpoch = Number(timestamp);
  if (!Number.isFinite(requestEpoch)) {
    return { ok: false, body: "" };
  }

  const nowEpoch = Math.floor(Date.now() / 1000);
  if (Math.abs(nowEpoch - requestEpoch) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, body: "" };
  }

  const rawBody = await request.text();
  const ok = verifySlackSignature(signingSecret, timestamp, rawBody, signature);

  return { ok, body: rawBody };
}
