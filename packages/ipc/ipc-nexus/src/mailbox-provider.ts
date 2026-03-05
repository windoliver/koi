/**
 * ComponentProvider factory for @koi/ipc-nexus.
 *
 * Wraps createNexusMailbox as a MailboxComponent and exposes
 * send/list as agent-facing tools via createServiceProvider.
 */

import type {
  AgentId,
  AgentRegistry,
  ComponentProvider,
  MailboxComponent,
  ToolPolicy,
} from "@koi/core";
import { createServiceProvider, DEFAULT_UNSANDBOXED_POLICY, MAILBOX, toolToken } from "@koi/core";
import type { DeliveryMode, IpcOperation } from "./constants.js";
import { DEFAULT_PREFIX, OPERATIONS } from "./constants.js";
import { createNexusMailbox } from "./mailbox-adapter.js";
import { createDiscoverTool } from "./tools/discover.js";
import { createListTool } from "./tools/list.js";
import { createSendTool } from "./tools/send.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface IpcNexusProviderConfig {
  readonly agentId: AgentId;
  readonly nexusBaseUrl?: string | undefined;
  readonly authToken?: string | undefined;
  readonly policy?: ToolPolicy | undefined;
  readonly prefix?: string | undefined;
  readonly delivery?: DeliveryMode | undefined;
  readonly seenCapacity?: number | undefined;
  readonly pollMinMs?: number | undefined;
  readonly pollMaxMs?: number | undefined;
  readonly pageLimit?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly operations?: readonly IpcOperation[] | undefined;
  readonly registry?: AgentRegistry | undefined;
}

// ---------------------------------------------------------------------------
// Tool factories map
// ---------------------------------------------------------------------------

const TOOL_FACTORIES: Readonly<
  Record<
    IpcOperation,
    (
      backend: MailboxComponent,
      prefix: string,
      policy: ToolPolicy,
    ) => ReturnType<typeof createSendTool>
  >
> = {
  send: createSendTool,
  list: createListTool,
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a ComponentProvider that attaches a MailboxComponent + IPC tools. */
export function createIpcNexusProvider(config: IpcNexusProviderConfig): ComponentProvider {
  const {
    agentId,
    nexusBaseUrl,
    authToken,
    policy = DEFAULT_UNSANDBOXED_POLICY,
    prefix = DEFAULT_PREFIX,
    delivery,
    seenCapacity,
    pollMinMs,
    pollMaxMs,
    pageLimit,
    timeoutMs,
    operations = OPERATIONS,
    registry,
  } = config;

  const mailbox = createNexusMailbox({
    agentId,
    baseUrl: nexusBaseUrl,
    authToken,
    delivery,
    seenCapacity,
    pollMinMs,
    pollMaxMs,
    pageLimit,
    timeoutMs,
  });

  return createServiceProvider<MailboxComponent, IpcOperation>({
    name: "ipc-nexus",
    singletonToken: MAILBOX,
    backend: mailbox,
    operations,
    factories: TOOL_FACTORIES,
    policy,
    prefix,
    ...(registry !== undefined
      ? {
          customTools: (_backend, agent) => {
            const tool = createDiscoverTool(registry, prefix, policy, agent.pid.id);
            return [[toolToken(tool.descriptor.name) as string, tool]];
          },
        }
      : {}),
    detach: async () => {
      mailbox[Symbol.dispose]();
    },
  });
}
