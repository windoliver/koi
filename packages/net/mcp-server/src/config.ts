/**
 * MCP server configuration and capability gating.
 *
 * Platform capabilities are optional — only tools for provided subsystem
 * handles are registered. Validation at construction time prevents
 * runtime errors from missing handles.
 */

import type {
  Agent,
  AgentId,
  AgentRegistry,
  ForgeStore,
  MailboxComponent,
  ManagedTaskBoard,
} from "@koi/core";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Platform subsystem handles for MCP tool registration. */
export interface PlatformCapabilities {
  /** Identity for platform operations (message from, task ownership). */
  readonly callerId: AgentId;
  /** Enables koi_send_message + koi_list_messages. */
  readonly mailbox?: MailboxComponent;
  /** Enables koi_list_tasks + koi_get_task + koi_update_task + koi_task_output. */
  readonly taskBoard?: ManagedTaskBoard;
  /** Enables koi_list_agents. */
  readonly registry?: AgentRegistry;
}

/** Configuration for createMcpServer(). */
export interface McpServerConfig {
  /** Agent whose tools to expose via MCP. */
  readonly agent: Agent;
  /** MCP SDK transport (stdio for single-client). */
  readonly transport: Transport;
  /** Server name advertised during MCP initialization. Default: agent manifest name. */
  readonly name?: string;
  /** Server version advertised during MCP initialization. Default: "1.0.0". */
  readonly version?: string;
  /** Optional forge store — enables hot-reload of forged tools. */
  readonly forgeStore?: ForgeStore;
  /** Platform capabilities — enables platform tools (mailbox, tasks, registry). */
  readonly platform?: PlatformCapabilities;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validate that platform config is internally consistent. */
export function validateMcpServerConfig(config: McpServerConfig): void {
  const p = config.platform;
  if (p === undefined) return;

  if (typeof p.callerId !== "string" || p.callerId.length === 0) {
    throw new Error("McpServerConfig.platform.callerId is required and must be a non-empty string");
  }

  if (p.mailbox === undefined && p.taskBoard === undefined && p.registry === undefined) {
    throw new Error(
      "McpServerConfig.platform requires at least one subsystem handle (mailbox, taskBoard, or registry)",
    );
  }
}
