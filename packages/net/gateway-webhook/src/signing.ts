/**
 * HMAC-SHA256 signature verification for common webhook providers.
 *
 * Each provider uses a different header format and signing scheme:
 * - GitHub:  X-Hub-Signature-256: sha256=<hex>
 * - Slack:   X-Slack-Signature: v0=<hex>  +  X-Slack-Request-Timestamp
 * - Stripe:  Stripe-Signature: t=<ts>,v1=<hex>
 * - Generic: X-Webhook-Signature: v1,<base64>  (Standard Webhooks spec)
 */

import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Timing-safe comparison
// ---------------------------------------------------------------------------

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ba.length; i++) {
    diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

// Compute HMAC-SHA256 over a prefix string plus an optional body chunk.
// Two-part update avoids allocating a concat buffer for prefix+body:
//   hmacSha256(secret, "v0:ts:", rawBodyBytes)  — no extra copy
//   hmacSha256(secret, "", rawBody)              — body-only (GitHub)
function hmacSha256(secret: string, prefix: string, body: string | Uint8Array): string {
  const h = createHmac("sha256", secret);
  if (prefix.length > 0) h.update(prefix);
  h.update(body);
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// Provider-specific verifiers
// ---------------------------------------------------------------------------

/** GitHub: `X-Hub-Signature-256: sha256=<hex>` */
export async function verifyGitHubSignature(
  secret: string,
  rawBody: string,
  request: Request,
  rawBodyBytes?: Uint8Array,
): Promise<boolean> {
  const header = request.headers.get("x-hub-signature-256");
  if (header === null) return false;
  const provided = header.startsWith("sha256=") ? header.slice(7) : header;
  const expected = hmacSha256(secret, "", rawBodyBytes ?? rawBody);
  return timingSafeEqual(provided, expected);
}

/**
 * Slack: `X-Slack-Signature: v0=<hex>` + `X-Slack-Request-Timestamp`
 * Signing string: `v0:<timestamp>:<body>`
 * Replay window: 5 minutes.
 */
export async function verifySlackSignature(
  secret: string,
  rawBody: string,
  request: Request,
  nowMs: number = Date.now(),
  rawBodyBytes?: Uint8Array,
): Promise<boolean> {
  const tsHeader = request.headers.get("x-slack-request-timestamp");
  const sigHeader = request.headers.get("x-slack-signature");
  if (tsHeader === null || sigHeader === null) return false;

  const tsSeconds = parseInt(tsHeader, 10);
  if (!Number.isFinite(tsSeconds)) return false;

  // Reject replays older than 5 minutes
  if (Math.abs(nowMs / 1000 - tsSeconds) > 300) return false;

  const provided = sigHeader.startsWith("v0=") ? sigHeader.slice(3) : sigHeader;
  // Two-part update: prefix string + body bytes/string — no concat buffer allocated.
  const expected =
    rawBodyBytes !== undefined
      ? hmacSha256(secret, `v0:${tsHeader}:`, rawBodyBytes)
      : hmacSha256(secret, "", `v0:${tsHeader}:${rawBody}`);
  return timingSafeEqual(provided, expected);
}

/**
 * Stripe: `Stripe-Signature: t=<ts>,v1=<hex>[,v1=<hex>...]`
 * Signing string: `<timestamp>.<body>`
 * Replay window: 5 minutes.
 */
export async function verifyStripeSignature(
  secret: string,
  rawBody: string,
  request: Request,
  nowMs: number = Date.now(),
  rawBodyBytes?: Uint8Array,
): Promise<boolean> {
  const header = request.headers.get("stripe-signature");
  if (header === null) return false;

  const parts = header.split(",");
  let timestamp: string | undefined;
  const v1Sigs: string[] = [];

  for (const part of parts) {
    if (part.startsWith("t=")) timestamp = part.slice(2);
    else if (part.startsWith("v1=")) v1Sigs.push(part.slice(3));
  }

  if (timestamp === undefined || v1Sigs.length === 0) return false;

  const tsSeconds = parseInt(timestamp, 10);
  if (!Number.isFinite(tsSeconds)) return false;
  if (Math.abs(nowMs / 1000 - tsSeconds) > 300) return false;

  // Two-part update: prefix string + body bytes/string — no concat buffer allocated.
  const expected =
    rawBodyBytes !== undefined
      ? hmacSha256(secret, `${timestamp}.`, rawBodyBytes)
      : hmacSha256(secret, "", `${timestamp}.${rawBody}`);
  return v1Sigs.some((sig) => timingSafeEqual(sig, expected));
}

/**
 * Generic / Standard Webhooks: `X-Webhook-Signature: v1,<base64>`
 * Signing string: `<webhookId>.<timestamp>.<body>`
 * Replay window: 5 minutes.
 */
export async function verifyGenericSignature(
  secret: string,
  rawBody: string,
  request: Request,
  nowMs: number = Date.now(),
  rawBodyBytes?: Uint8Array,
): Promise<boolean> {
  const sigHeader = request.headers.get("x-webhook-signature");
  const webhookId = request.headers.get("x-webhook-id");
  const tsHeader = request.headers.get("x-webhook-timestamp");
  if (sigHeader === null || webhookId === null || tsHeader === null) return false;

  const tsSeconds = parseInt(tsHeader, 10);
  if (!Number.isFinite(tsSeconds)) return false;
  if (Math.abs(nowMs / 1000 - tsSeconds) > 300) return false;

  // Two-part update: prefix string + body bytes/string — no concat buffer allocated.
  const expectedHex =
    rawBodyBytes !== undefined
      ? hmacSha256(secret, `${webhookId}.${tsHeader}.`, rawBodyBytes)
      : hmacSha256(secret, "", `${webhookId}.${tsHeader}.${rawBody}`);
  const expectedB64 = Buffer.from(expectedHex, "hex").toString("base64");

  const provided = sigHeader.startsWith("v1,") ? sigHeader.slice(3) : sigHeader;
  // Compare as base64 strings (same length guaranteed for same hash)
  return provided === expectedB64;
}
