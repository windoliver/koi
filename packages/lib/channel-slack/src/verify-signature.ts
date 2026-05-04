/**
 * Slack HTTP request signature verification.
 *
 * HMAC-SHA256 per Slack's "Verifying requests from Slack" spec, with
 * timing-safe comparison and 5-minute replay protection.
 *
 * @see https://api.slack.com/authentication/verifying-requests-from-slack
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const REPLAY_WINDOW_SECONDS = 300;
/**
 * Maximum body size accepted by `verifySlackRequest`. Slack signed payloads are
 * tiny (slash-command `text` is capped at 4000 chars, interactive payloads
 * around 4KB, message events a few KB at most). Capping at 100 KB covers all
 * documented Slack request shapes with headroom for forwarded files metadata
 * and prevents an unauthenticated attacker from forcing the webhook to buffer
 * unbounded request bodies in memory.
 */
const MAX_BODY_BYTES = 100_000;

/**
 * Verifies a Slack request signature using HMAC-SHA256.
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
  if (computed.length !== signature.length) return false;
  return timingSafeEqual(
    new Uint8Array(Buffer.from(computed)),
    new Uint8Array(Buffer.from(signature)),
  );
}

export interface VerifySlackRequestResult {
  readonly ok: boolean;
  readonly body: string;
  /** When `false`, indicates rejection due to body size, not signature. */
  readonly tooLarge?: boolean;
}

/**
 * Verifies a full Slack HTTP request and returns the raw body so the caller
 * doesn't have to re-read the request stream. Rejects oversized bodies up
 * front (via Content-Length) so an unauthenticated POST cannot force the
 * webhook to buffer arbitrarily large payloads.
 */
export async function verifySlackRequest(
  signingSecret: string,
  request: Request,
): Promise<VerifySlackRequestResult> {
  const timestamp = request.headers.get("X-Slack-Request-Timestamp");
  const signature = request.headers.get("X-Slack-Signature");
  if (timestamp === null || signature === null) return { ok: false, body: "" };
  const requestEpoch = Number(timestamp);
  if (!Number.isFinite(requestEpoch)) return { ok: false, body: "" };
  const nowEpoch = Math.floor(Date.now() / 1000);
  if (Math.abs(nowEpoch - requestEpoch) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, body: "" };
  }
  // Size guard BEFORE buffering. Reject any request whose declared
  // Content-Length exceeds the cap so we never read an unbounded body.
  const len = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(len) && len > MAX_BODY_BYTES) {
    return { ok: false, body: "", tooLarge: true };
  }
  // Authoritative byte cap via streaming read — defeats omitted/dishonest
  // Content-Length and chunked transfer that would otherwise force the
  // webhook to buffer the entire body before rejection.
  const rawBody = await readBodyWithCap(request, MAX_BODY_BYTES);
  if (rawBody === null) {
    return { ok: false, body: "", tooLarge: true };
  }
  const ok = verifySlackSignature(signingSecret, timestamp, rawBody, signature);
  return { ok, body: rawBody };
}

/**
 * Read the request body as UTF-8, aborting once the byte cap is exceeded.
 * Returns `null` on overflow. Stream-based so omitted Content-Length and
 * chunked transfer can't force unbounded buffering.
 */
async function readBodyWithCap(req: Request, cap: number): Promise<string | null> {
  const reader = req.body?.getReader();
  if (reader === undefined) return "";
  const decoder = new TextDecoder("utf-8");
  // let requires justification: accumulator for streamed body chunks
  let chunks = "";
  // let requires justification: byte counter for the streaming cap
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      try {
        await reader.cancel();
      } catch {
        // already terminated — ignore
      }
      return null;
    }
    chunks += decoder.decode(value, { stream: true });
  }
  chunks += decoder.decode();
  return chunks;
}
