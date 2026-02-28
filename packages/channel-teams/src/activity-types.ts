/**
 * Minimal Activity type subset for Teams channel.
 *
 * These types are defined locally to avoid importing vendor types
 * from Microsoft SDKs into the public API surface. They represent
 * the subset of the Bot Framework Activity protocol that Koi uses.
 */

/** Account identity in a Teams conversation. */
export interface TeamsAccount {
  readonly id: string;
  readonly name?: string;
}

/** Attachment in a Teams Activity. */
export interface TeamsAttachment {
  readonly contentType: string;
  readonly contentUrl?: string;
  readonly content?: unknown;
  readonly name?: string;
}

/** Conversation reference for threading. */
export interface TeamsConversation {
  readonly id: string;
  readonly name?: string;
  readonly isGroup?: boolean;
  readonly tenantId?: string;
}

/**
 * Minimal Activity shape used for normalization.
 * Maps to the Bot Framework Activity protocol without importing the full SDK.
 */
/**
 * Minimal Activity shape used for normalization.
 * Maps to the Bot Framework Activity protocol without importing the full SDK.
 */
export interface TeamsActivity {
  readonly type: string;
  readonly id?: string;
  readonly text?: string;
  readonly from: TeamsAccount;
  readonly conversation: TeamsConversation;
  readonly recipient?: TeamsAccount;
  readonly serviceUrl?: string;
  readonly channelId?: string;
  readonly attachments?: readonly TeamsAttachment[];
  readonly timestamp?: string;
}

/**
 * Conversation reference for proactive messaging (OpenClaw pattern).
 *
 * Stores enough information to send messages to a conversation
 * outside of the normal turn context.
 */
export interface TeamsConversationReference {
  readonly conversationId: string;
  readonly serviceUrl: string;
  readonly botId: string;
  readonly tenantId?: string;
}
