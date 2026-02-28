/**
 * Internal types for @koi/engine-acp.
 *
 * These are implementation details, not part of the public API.
 */

import type { ApprovalHandler, EngineAdapter } from "@koi/core";
import type { AgentCapabilities, ClientCapabilities } from "./acp-schema.js";

// ---------------------------------------------------------------------------
// Adapter config
// ---------------------------------------------------------------------------

export interface AcpAdapterConfig {
  /** Command to spawn the ACP agent (e.g., "claude", "codex"). */
  readonly command: string;
  /** Arguments to pass to the agent command. */
  readonly args?: readonly string[] | undefined;
  /** Working directory for the spawned process. */
  readonly cwd?: string | undefined;
  /** Extra environment variables for the agent process. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /**
   * Capabilities to advertise in the `initialize` request.
   * Defaults to full fs + terminal support.
   */
  readonly clientCapabilities?: ClientCapabilities | undefined;
  /**
   * Timeout (ms) for each `session/prompt` call.
   * 0 = no timeout. Default: 300_000 (5 minutes).
   */
  readonly timeoutMs?: number | undefined;
  /**
   * Optional approval handler for `session/request_permission`.
   * If not provided, all permission requests are auto-allowed (headless mode).
   */
  readonly approvalHandler?: ApprovalHandler | undefined;
  /**
   * Client info to send in the `initialize` request.
   */
  readonly clientInfo?:
    | {
        readonly name?: string | undefined;
        readonly version?: string | undefined;
      }
    | undefined;
  /**
   * Extra parameters merged into every `session/new` request.
   * Use this to satisfy agent-specific requirements (e.g., codex-acp requires
   * `mcpServers: []`).
   */
  readonly sessionNewParams?: Readonly<Record<string, unknown>> | undefined;
}

// ---------------------------------------------------------------------------
// Extended adapter interface
// ---------------------------------------------------------------------------

/** Engine adapter with ACP-specific properties. */
export interface AcpEngineAdapter extends EngineAdapter {
  /** Capabilities negotiated during `initialize`. Undefined before first stream(). */
  readonly agentCapabilities: AgentCapabilities | undefined;
}

// ---------------------------------------------------------------------------
// Pending request tracker
// ---------------------------------------------------------------------------

/** A pending outbound request waiting for a response. */
export interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: { readonly code: number; readonly message: string }) => void;
}
