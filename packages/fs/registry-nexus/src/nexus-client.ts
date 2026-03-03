/**
 * Nexus JSON-RPC 2.0 client.
 *
 * Thin wrapper around fetch that speaks the Nexus JSON-RPC protocol.
 * All RPC methods return Result<T, KoiError> — no thrown exceptions
 * for expected failures.
 */

import type { KoiError, KoiErrorCode, Result } from "@koi/core";
import type { NexusRegistryConfig } from "./config.js";
import { DEFAULT_NEXUS_REGISTRY_CONFIG } from "./config.js";

// ---------------------------------------------------------------------------
// Nexus error mapping
// ---------------------------------------------------------------------------

/**
 * Maps Nexus JSON-RPC error codes to Koi error codes.
 * Nexus uses standard JSON-RPC 2.0 error codes (negative numbers).
 */
const NEXUS_ERROR_MAP: Readonly<
  Record<number, { readonly code: KoiErrorCode; readonly retryable: boolean }>
> = Object.freeze({
  [-32006]: { code: "CONFLICT", retryable: true },
  [-32000]: { code: "NOT_FOUND", retryable: false },
  [-32003]: { code: "PERMISSION", retryable: false },
  [-32005]: { code: "VALIDATION", retryable: false },
  [-32601]: { code: "EXTERNAL", retryable: false },
  [-32603]: { code: "EXTERNAL", retryable: true },
});

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly id: string;
}

interface JsonRpcSuccessResponse {
  readonly jsonrpc: "2.0";
  readonly result: unknown;
  readonly id: string;
}

interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
  readonly id: string;
}

type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

// ---------------------------------------------------------------------------
// Core RPC function
// ---------------------------------------------------------------------------

/** Send a JSON-RPC 2.0 request to Nexus and return a typed Result. */
export async function nexusRpc<T>(
  config: NexusRegistryConfig,
  method: string,
  params: Readonly<Record<string, unknown>>,
): Promise<Result<T, KoiError>> {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_NEXUS_REGISTRY_CONFIG.timeoutMs;

  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    method,
    params,
    id: crypto.randomUUID(),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(`${config.baseUrl}/api/nfs/${method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      return {
        ok: false,
        error: {
          code: "EXTERNAL",
          message: `Nexus HTTP ${String(response.status)}: ${response.statusText}`,
          retryable: response.status >= 500,
        },
      };
    }

    const body = (await response.json()) as JsonRpcResponse;

    if ("error" in body && body.error !== undefined) {
      const mapped = NEXUS_ERROR_MAP[body.error.code];
      return {
        ok: false,
        error: {
          code: mapped?.code ?? "EXTERNAL",
          message: body.error.message,
          retryable: mapped?.retryable ?? false,
        },
      };
    }

    return { ok: true, value: (body as JsonRpcSuccessResponse).result as T };
  } catch (e: unknown) {
    clearTimeout(timer);

    if (e instanceof DOMException && e.name === "AbortError") {
      return {
        ok: false,
        error: {
          code: "TIMEOUT",
          message: `Nexus RPC timed out after ${String(timeoutMs)}ms: ${method}`,
          retryable: true,
        },
      };
    }

    return {
      ok: false,
      error: {
        code: "EXTERNAL",
        message: `Nexus RPC failed: ${e instanceof Error ? e.message : String(e)}`,
        retryable: true,
        cause: e,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Nexus agent types
// ---------------------------------------------------------------------------

/** Shape of a Nexus agent record returned by list/get calls. */
export interface NexusAgent {
  readonly agent_id: string;
  readonly name?: string;
  readonly state: string;
  readonly zone_id?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly generation?: number;
}

// ---------------------------------------------------------------------------
// Higher-level RPC methods
// ---------------------------------------------------------------------------

/** Register a new agent in Nexus. */
export async function nexusRegisterAgent(
  config: NexusRegistryConfig,
  params: {
    readonly agent_id: string;
    readonly name?: string;
    readonly zone_id?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  },
): Promise<Result<NexusAgent, KoiError>> {
  return nexusRpc<NexusAgent>(config, "register_agent", params);
}

/** Delete an agent from Nexus. */
export async function nexusDeleteAgent(
  config: NexusRegistryConfig,
  agentId: string,
): Promise<Result<unknown, KoiError>> {
  return nexusRpc(config, "delete_agent", { agent_id: agentId });
}

/** Transition an agent to a new state in Nexus with CAS. */
export async function nexusTransition(
  config: NexusRegistryConfig,
  agentId: string,
  targetState: string,
  expectedGeneration: number,
): Promise<Result<NexusAgent, KoiError>> {
  return nexusRpc<NexusAgent>(config, "agent_transition", {
    agent_id: agentId,
    target_state: targetState,
    expected_generation: expectedGeneration,
  });
}

/** List agents in Nexus, optionally filtered by zone. */
export async function nexusListAgents(
  config: NexusRegistryConfig,
  zoneId?: string,
): Promise<Result<readonly NexusAgent[], KoiError>> {
  const method = zoneId !== undefined ? "agent_list_by_zone" : "list_agents";
  const params = zoneId !== undefined ? { zone_id: zoneId } : {};
  return nexusRpc<readonly NexusAgent[]>(config, method, params);
}

/** Get a single agent by ID from Nexus. */
export async function nexusGetAgent(
  config: NexusRegistryConfig,
  agentId: string,
): Promise<Result<NexusAgent, KoiError>> {
  return nexusRpc<NexusAgent>(config, "get_agent", { agent_id: agentId });
}

/** Send a heartbeat for an agent. */
export async function nexusHeartbeat(
  config: NexusRegistryConfig,
  agentId: string,
): Promise<Result<unknown, KoiError>> {
  return nexusRpc(config, "agent_heartbeat", { agent_id: agentId });
}

/** Update metadata for an agent. */
export async function nexusUpdateMetadata(
  config: NexusRegistryConfig,
  agentId: string,
  metadata: Readonly<Record<string, unknown>>,
): Promise<Result<NexusAgent, KoiError>> {
  return nexusRpc<NexusAgent>(config, "update_agent_metadata", {
    agent_id: agentId,
    metadata,
  });
}
