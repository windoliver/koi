/**
 * Standard Webhooks HMAC-SHA256 signing and verification.
 *
 * Implements the Standard Webhooks spec:
 * - Signed content: "${webhookId}.${timestamp}.${body}"
 * - Header: webhook-signature: "v1,${base64(HMAC-SHA256(secret, signedContent))}"
 *
 * Uses Bun/Node native crypto.
 */

import { createHmac } from "node:crypto";

/**
 * Headers set on outbound webhook requests.
 */
export interface WebhookSignatureHeaders {
  readonly "webhook-id": string;
  readonly "webhook-timestamp": string;
  readonly "webhook-signature": string;
  readonly "content-type": string;
}

/**
 * Creates Standard Webhooks signature headers for an outbound delivery.
 *
 * @param webhookId - Unique delivery ID (ULID)
 * @param timestampSeconds - Unix seconds when the event was sent
 * @param body - Serialized JSON body string
 * @param secret - HMAC signing key
 */
export function createSignatureHeaders(
  webhookId: string,
  timestampSeconds: number,
  body: string,
  secret: string,
): WebhookSignatureHeaders {
  const signedContent = `${webhookId}.${timestampSeconds}.${body}`;
  const signature = createHmac("sha256", secret).update(signedContent).digest("base64");

  return {
    "webhook-id": webhookId,
    "webhook-timestamp": String(timestampSeconds),
    "webhook-signature": `v1,${signature}`,
    "content-type": "application/json",
  };
}

/**
 * Verifies a Standard Webhooks signature against a received body.
 *
 * @param webhookId - The webhook-id header value
 * @param timestampSeconds - The webhook-timestamp header value (as number)
 * @param body - The raw request body string
 * @param signature - The webhook-signature header value (e.g., "v1,base64...")
 * @param secret - The signing key
 * @param toleranceSeconds - Maximum allowed clock skew. Default: 300 (5 minutes).
 * @param clock - Injectable clock for testing. Default: Date.now.
 */
export function verifySignature(
  webhookId: string,
  timestampSeconds: number,
  body: string,
  signature: string,
  secret: string,
  toleranceSeconds: number = 300,
  clock: () => number = Date.now,
): boolean {
  // Check timestamp tolerance
  const nowSeconds = Math.floor(clock() / 1_000);
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) {
    return false;
  }

  // Extract version prefix
  if (!signature.startsWith("v1,")) {
    return false;
  }
  const receivedSig = signature.slice(3);

  // Compute expected signature
  const signedContent = `${webhookId}.${timestampSeconds}.${body}`;
  const expectedSig = createHmac("sha256", secret).update(signedContent).digest("base64");

  // Constant-time comparison
  if (receivedSig.length !== expectedSig.length) {
    return false;
  }

  const a = Buffer.from(receivedSig);
  const b = Buffer.from(expectedSig);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Constant-time comparison for buffers of equal length. */
function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return result === 0;
}
