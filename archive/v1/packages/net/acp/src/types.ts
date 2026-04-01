/**
 * Configuration and type definitions for the ACP server ChannelAdapter.
 */

import type { AgentCapabilities } from "@koi/acp-protocol";
import type { ChannelAdapter } from "@koi/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface AcpServerConfig {
  /** Agent info reported in the initialize response. */
  readonly agentInfo?:
    | {
        readonly name?: string | undefined;
        readonly title?: string | undefined;
        readonly version?: string | undefined;
      }
    | undefined;
  /** Agent capabilities reported in the initialize response. */
  readonly agentCapabilities?: AgentCapabilities | undefined;
  /** Per-request timeout defaults (ms). */
  readonly timeouts?:
    | {
        readonly fsMs?: number | undefined;
        readonly terminalMs?: number | undefined;
        readonly permissionMs?: number | undefined;
      }
    | undefined;
  /** Maximum number of buffered outbound events before pausing. Default: 100. */
  readonly backpressureLimit?: number | undefined;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUTS = {
  fsMs: 30_000,
  terminalMs: 300_000,
  permissionMs: 60_000,
} as const;

export const DEFAULT_BACKPRESSURE_LIMIT = 100 as const;

export const ACP_PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Extended ChannelAdapter
// ---------------------------------------------------------------------------

/**
 * ACP server channel adapter — a ChannelAdapter that also exposes
 * an approval handler for wiring into agent assembly.
 */
export interface AcpChannelAdapter extends ChannelAdapter {
  /** Approval handler that bridges IDE permission dialogs to Koi's approval flow. */
  readonly getApprovalHandler: () => import("@koi/core").ApprovalHandler;
}
