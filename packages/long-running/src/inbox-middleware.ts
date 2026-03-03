/**
 * Inbox middleware — routes MailboxComponent messages to InboxComponent (Phase 4).
 *
 * Priority 45 (before harness at 50). On each turn start, drains pending
 * agent-to-agent messages from the MailboxComponent and pushes them into
 * the InboxComponent keyed by `metadata.mode`. If no mode is specified,
 * defaults to "followup".
 */

import type {
  AgentMessage,
  InboxComponent,
  InboxItem,
  InboxMode,
  KoiMiddleware,
  MailboxComponent,
  TurnContext,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface InboxMiddlewareConfig {
  /** Retrieve the MailboxComponent for the current agent. */
  readonly getMailbox: () => MailboxComponent | undefined;
  /** Retrieve the InboxComponent for the current agent. */
  readonly getInbox: () => InboxComponent | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_MODES: ReadonlySet<string> = new Set<string>(["collect", "followup", "steer"]);

function resolveMode(message: AgentMessage): InboxMode {
  const raw = message.metadata?.mode;
  if (typeof raw === "string" && VALID_MODES.has(raw)) {
    return raw as InboxMode;
  }
  return "followup";
}

function mapToInboxItem(message: AgentMessage, mode: InboxMode): InboxItem {
  return {
    id: message.id,
    from: message.from,
    mode,
    content:
      typeof message.payload.text === "string"
        ? (message.payload.text as string)
        : JSON.stringify(message.payload),
    priority:
      typeof message.metadata?.priority === "number" ? (message.metadata.priority as number) : 0,
    createdAt: Date.parse(message.createdAt) || Date.now(),
    metadata: message.metadata ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create middleware that routes MailboxComponent messages into InboxComponent.
 *
 * Before each turn, lists pending agent-to-agent messages from the mailbox,
 * determines the inbox mode from `metadata.mode`, and pushes them into the
 * inbox queue. The engine's turn-boundary logic in koi.ts then drains the
 * inbox and dispatches items based on mode (steer/collect/followup).
 */
export function createInboxMiddleware(config: InboxMiddlewareConfig): KoiMiddleware {
  return {
    name: "inbox-middleware",
    priority: 45,

    describeCapabilities: () => ({
      label: "inbox",
      description: "Routes inter-agent messages to the inbox queue for turn-boundary processing.",
    }),

    onBeforeTurn: async (_ctx: TurnContext): Promise<void> => {
      const mailbox = config.getMailbox();
      const inbox = config.getInbox();

      if (mailbox === undefined || inbox === undefined) {
        return;
      }

      const messages: readonly AgentMessage[] = await mailbox.list();

      for (const message of messages) {
        const mode = resolveMode(message);
        const item = mapToInboxItem(message, mode);
        // push returns false if at capacity — drop silently per Decision 14B
        inbox.push(item);
      }
    },
  };
}
