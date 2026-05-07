/**
 * @koi/channel-email — pure RFC 5322 thread helpers.
 *
 * `extractThreadKey` derives a stable thread root from inbound headers.
 * `deriveReplyHeaders` produces outbound `In-Reply-To`/`References` from
 * a thread state's chain of seen Message-IDs.
 */

import type { ThreadState } from "@koi/channel-base";

export type IncomingHeaders = {
  readonly messageId: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
};

export function extractThreadKey(h: IncomingHeaders): string {
  if (h.references.length > 0 && h.references[0]) return h.references[0];
  if (h.inReplyTo) return h.inReplyTo;
  return h.messageId;
}

export function deriveReplyHeaders(state: ThreadState): Readonly<Record<string, string>> {
  if (state.chain.length === 0) return {};
  const last = state.chain[state.chain.length - 1] ?? "";
  return {
    "In-Reply-To": last,
    References: state.chain.join(" "),
  };
}
