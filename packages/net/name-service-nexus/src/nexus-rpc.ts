/**
 * Nexus JSON-RPC 2.0 client for ANS operations.
 *
 * Self-contained transport (same pattern as registry-nexus/nexus-client.ts).
 * Posts to ${baseUrl}/api/ans/${method}.
 * All RPC methods return Result<T, KoiError> — no thrown exceptions
 * for expected failures.
 */

import type { BrickKind, ForgeScope, KoiError, KoiErrorCode, NameBinding, Result } from "@koi/core";
import { agentId, brickId } from "@koi/core";
import type { NexusNameServiceConfig } from "./config.js";
import { DEFAULT_NEXUS_NAME_SERVICE_CONFIG } from "./config.js";

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

/** Send a JSON-RPC 2.0 request to Nexus ANS endpoint and return a typed Result. */
async function nexusAnsRpc<T>(
  config: NexusNameServiceConfig,
  method: string,
  params: Readonly<Record<string, unknown>>,
): Promise<Result<T, KoiError>> {
  const fetchFn = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_NEXUS_NAME_SERVICE_CONFIG.timeoutMs;

  const request: JsonRpcRequest = {
    jsonrpc: "2.0",
    method,
    params,
    id: crypto.randomUUID(),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(`${config.baseUrl}/api/ans/${method}`, {
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
          message: `Nexus ANS RPC timed out after ${String(timeoutMs)}ms: ${method}`,
          retryable: true,
        },
      };
    }

    return {
      ok: false,
      error: {
        code: "EXTERNAL",
        message: `Nexus ANS RPC failed: ${e instanceof Error ? e.message : String(e)}`,
        retryable: true,
        cause: e,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Nexus ANS wire types
// ---------------------------------------------------------------------------

/** Wire format for a name record in Nexus. */
export interface NexusNameRecord {
  readonly name: string;
  readonly binding_kind: "agent" | "brick";
  readonly agent_id?: string | undefined;
  readonly brick_id?: string | undefined;
  readonly brick_kind?: string | undefined;
  readonly scope: string;
  readonly aliases: readonly string[];
  readonly registered_at: number;
  readonly expires_at: number;
  readonly registered_by: string;
  readonly zone_id?: string | undefined;
}

// ---------------------------------------------------------------------------
// Higher-level RPC methods
// ---------------------------------------------------------------------------

/** Register a name in Nexus ANS. */
export async function nexusAnsRegister(
  config: NexusNameServiceConfig,
  params: {
    readonly name: string;
    readonly binding: NameBinding;
    readonly scope: ForgeScope;
    readonly aliases?: readonly string[] | undefined;
    readonly ttl_ms?: number | undefined;
    readonly registered_by: string;
    readonly zone_id?: string | undefined;
  },
): Promise<Result<NexusNameRecord, KoiError>> {
  const wireParams: Record<string, unknown> = {
    name: params.name,
    binding_kind: params.binding.kind,
    scope: params.scope,
    aliases: params.aliases ?? [],
    registered_by: params.registered_by,
  };

  if (params.binding.kind === "agent") {
    wireParams.agent_id = params.binding.agentId;
  } else {
    wireParams.brick_id = params.binding.brickId;
    wireParams.brick_kind = params.binding.brickKind;
  }

  if (params.ttl_ms !== undefined) {
    wireParams.ttl_ms = params.ttl_ms;
  }
  if (params.zone_id !== undefined) {
    wireParams.zone_id = params.zone_id;
  }

  return nexusAnsRpc<NexusNameRecord>(config, "name.register", wireParams);
}

/** Resolve a name from Nexus ANS. */
export async function nexusAnsResolve(
  config: NexusNameServiceConfig,
  name: string,
  scope?: ForgeScope,
): Promise<Result<NexusNameRecord, KoiError>> {
  const params: Record<string, unknown> = { name };
  if (scope !== undefined) {
    params.scope = scope;
  }
  return nexusAnsRpc<NexusNameRecord>(config, "name.resolve", params);
}

/** Renew a name's TTL in Nexus ANS. */
export async function nexusAnsRenew(
  config: NexusNameServiceConfig,
  name: string,
  scope: ForgeScope,
  ttlMs?: number,
): Promise<Result<NexusNameRecord, KoiError>> {
  const params: Record<string, unknown> = { name, scope };
  if (ttlMs !== undefined) {
    params.ttl_ms = ttlMs;
  }
  return nexusAnsRpc<NexusNameRecord>(config, "name.renew", params);
}

/** Deregister a name from Nexus ANS. */
export async function nexusAnsDeregister(
  config: NexusNameServiceConfig,
  name: string,
  scope: ForgeScope,
): Promise<Result<unknown, KoiError>> {
  return nexusAnsRpc(config, "name.deregister", { name, scope });
}

/** List all name records in Nexus ANS. */
export async function nexusAnsList(
  config: NexusNameServiceConfig,
  zoneId?: string,
): Promise<Result<readonly NexusNameRecord[], KoiError>> {
  const params: Record<string, unknown> = {};
  if (zoneId !== undefined) {
    params.zone_id = zoneId;
  }
  return nexusAnsRpc<readonly NexusNameRecord[]>(config, "name.list", params);
}

// ---------------------------------------------------------------------------
// Wire → domain mapping
// ---------------------------------------------------------------------------

/**
 * Map a Nexus wire record to a NameBinding.
 * Returns undefined if the binding_kind is unrecognized.
 */
export function mapNexusBinding(record: NexusNameRecord): NameBinding | undefined {
  if (record.binding_kind === "agent" && record.agent_id !== undefined) {
    return { kind: "agent", agentId: agentId(record.agent_id) };
  }
  if (
    record.binding_kind === "brick" &&
    record.brick_id !== undefined &&
    record.brick_kind !== undefined
  ) {
    return {
      kind: "brick",
      brickId: brickId(record.brick_id),
      brickKind: record.brick_kind as BrickKind,
    };
  }
  return undefined;
}
