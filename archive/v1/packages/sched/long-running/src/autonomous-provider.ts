/**
 * Autonomous provider — attaches InboxComponent to agents (Decision 4C).
 *
 * A ComponentProvider that attaches an InboxComponent via the INBOX
 * SubsystemToken at assembly time, enabling message steering for
 * autonomous agents.
 */

import type {
  Agent,
  AttachResult,
  ComponentProvider,
  InboxComponent,
  InboxPolicy,
} from "@koi/core";
import { COMPONENT_PRIORITY, INBOX } from "@koi/core";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AutonomousProviderConfig {
  /** Factory to create an InboxComponent. Injected by L1/L3 caller. */
  readonly createInbox: (policy?: InboxPolicy) => InboxComponent;
  /** Inbox capacity policy. Uses caller's default if omitted. */
  readonly inboxPolicy?: InboxPolicy | undefined;
  /** ComponentProvider priority. Default: BUNDLED (100). */
  readonly priority?: number | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ComponentProvider that attaches an InboxComponent to agents.
 *
 * The inbox queue factory is injected to avoid L2 → L1 layer violation.
 * The inbox is created fresh for each agent attachment, providing
 * per-agent isolation for message steering.
 */
export function createAutonomousProvider(config: AutonomousProviderConfig): ComponentProvider {
  return {
    name: "autonomous-provider",
    priority: config.priority ?? COMPONENT_PRIORITY.BUNDLED,

    attach: async (_agent: Agent): Promise<AttachResult> => {
      const inbox = config.createInbox(config.inboxPolicy);

      const components = new Map<string, unknown>();
      components.set(INBOX as string, inbox);

      return { components, skipped: [] };
    },
  };
}
