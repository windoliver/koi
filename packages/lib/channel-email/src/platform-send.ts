/**
 * @koi/channel-email — SMTP transport wrapper with phase classification.
 *
 * Classifies SMTP errors as `pre-data` (safe to retry) or `post-data`
 * (uncertain — relay may have already accepted the message). Per RFC 5321
 * SMTP `Message-ID` is NOT a protocol idempotency key; the email channel
 * uses this classification to drive its outbound state machine.
 */

export type SmtpEnvelope = {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly headers: Readonly<Record<string, string>>;
};

export type SmtpSendResult = {
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
  readonly response: string;
};

export interface SmtpTransport {
  sendMail(env: SmtpEnvelope): Promise<SmtpSendResult>;
}

export type SendResult =
  | { readonly phase: "pre-data"; readonly ok: false; readonly error: string }
  | { readonly phase: "post-data"; readonly ok: true }
  | { readonly phase: "post-data"; readonly ok: false; readonly error: string };

const PRE_DATA_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EAUTH",
  "EENVELOPE",
  "ESOCKET",
  "EDNS",
  "EHOSTUNREACH",
]);

export async function sendViaSmtp(t: SmtpTransport, env: SmtpEnvelope): Promise<SendResult> {
  try {
    const r = await t.sendMail(env);
    // Partial acceptance is treated as failure: marking the outbox `sent`
    // while some recipients were rejected would silently lose mail for
    // the rejected subset (no retry, no operator surface). The whole
    // message must succeed atomically — operators handle the post-data
    // failed branch via resolvePending. v1 does not implement per-
    // recipient retry; that is a future enhancement.
    if (r.accepted.length > 0 && r.rejected.length === 0) {
      return { phase: "post-data", ok: true };
    }
    return {
      phase: "post-data",
      ok: false,
      error: `accepted: ${r.accepted.join(",") || "none"}; rejected: ${r.rejected.join(",") || "none"}; response: ${r.response}`,
    };
  } catch (e) {
    const code = (e as { readonly code?: unknown }).code;
    const isPreData = typeof code === "string" && PRE_DATA_CODES.has(code);
    const phase: "pre-data" | "post-data" = isPreData ? "pre-data" : "post-data";
    const message = e instanceof Error ? e.message : String(e);
    if (phase === "pre-data") return { phase, ok: false, error: message };
    return { phase, ok: false, error: message };
  }
}
