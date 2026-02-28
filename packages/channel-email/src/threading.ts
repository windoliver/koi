/**
 * Email threading utilities.
 *
 * Manages In-Reply-To and References headers for email thread continuity.
 * Tracks the mapping between threadId (Message-ID) and conversation chains.
 */

/** Immutable thread state for a conversation. */
export interface EmailThread {
  readonly messageId: string;
  readonly references: readonly string[];
}

/**
 * Creates threading headers for a reply email.
 *
 * @param originalMessageId - The Message-ID of the email being replied to.
 * @param originalReferences - The References header from the original email.
 * @returns Headers to include in the reply.
 */
export function createReplyHeaders(
  originalMessageId: string,
  originalReferences?: string | readonly string[],
): { readonly inReplyTo: string; readonly references: string } {
  const refs = normalizeReferences(originalReferences);
  const allRefs = [...refs, originalMessageId];

  return {
    inReplyTo: originalMessageId,
    references: allRefs.join(" "),
  };
}

/**
 * Generates a unique Message-ID for outbound emails.
 */
export function generateMessageId(domain: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 10);
  return `<${timestamp}.${random}@${domain}>`;
}

/**
 * Extracts the domain from an email address.
 */
export function extractDomain(email: string): string {
  const atIndex = email.indexOf("@");
  if (atIndex === -1) return "localhost";
  return email.slice(atIndex + 1);
}

function normalizeReferences(refs?: string | readonly string[]): readonly string[] {
  if (refs === undefined) return [];
  if (typeof refs === "string") {
    return refs.split(/\s+/).filter((r) => r.length > 0);
  }
  return refs;
}
