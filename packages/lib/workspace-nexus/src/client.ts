import type {
  AgentId,
  KoiError,
  ResolvedWorkspaceConfig,
  Result,
  WorkspaceId,
} from "../../../kernel/core/src/index.ts";
import { internal } from "../../../kernel/core/src/index.ts";
import type { NexusTransport } from "../../../lib/nexus-client/src/index.ts";
import type {
  NexusWorkspaceCreateResponse,
  NexusWorkspaceExistsResponse,
  NexusWorkspaceFindResponse,
  NexusWorkspaceHealthResponse,
  NexusWorkspaceRecord,
  NexusWorkspaceSetupCompleteResponse,
} from "./types.js";

export interface NexusWorkspaceBackendClient {
  readonly create: (
    agentId: AgentId,
    config: ResolvedWorkspaceConfig,
  ) => Promise<Result<NexusWorkspaceCreateResponse, KoiError>>;
  readonly dispose: (wsId: WorkspaceId) => Promise<Result<void, KoiError>>;
  readonly health: (
    wsId: WorkspaceId,
  ) => Promise<Result<NexusWorkspaceHealthResponse, KoiError>>;
  readonly findByAgentId: (
    agentId: AgentId,
  ) => Promise<Result<ReadonlyArray<NexusWorkspaceRecord>, KoiError>>;
  readonly attestSetupComplete: (wsId: WorkspaceId) => Promise<Result<void, KoiError>>;
  readonly verifySetupComplete: (wsId: WorkspaceId) => Promise<Result<boolean, KoiError>>;
  readonly invalidateSetupComplete: (wsId: WorkspaceId) => Promise<Result<void, KoiError>>;
  readonly exists: (wsId: WorkspaceId) => Promise<Result<boolean, KoiError>>;
}

function normalizeWorkspaceList(
  value: unknown,
): ReadonlyArray<NexusWorkspaceRecord> | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && value !== null) {
    const workspaces = (value as { readonly workspaces?: unknown }).workspaces;
    if (Array.isArray(workspaces)) return workspaces as ReadonlyArray<NexusWorkspaceRecord>;
  }
  return undefined;
}

function normalizeBooleanResult(
  value: unknown,
  key: "exists" | "setupComplete",
): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "object" && value !== null) {
    const raw = (value as { readonly [K in typeof key]?: unknown })[key];
    if (typeof raw === "boolean") return raw;
  }
  return undefined;
}

export function createNexusWorkspaceBackendClient(
  transport: NexusTransport,
  prefix: string,
): NexusWorkspaceBackendClient {
  async function callVoid(method: string, params: Record<string, unknown>): Promise<Result<void, KoiError>> {
    const result = await transport.call<{ readonly ok: true }>(method, params);
    if (!result.ok) return result;
    return { ok: true, value: undefined };
  }

  return {
    create: (agentId, config) => transport.call(`${prefix}.create`, { agentId, config }),
    dispose: async (wsId) => {
      const result = await transport.call<{ readonly ok: true }>(`${prefix}.dispose`, {
        workspaceId: wsId,
      });
      return result.ok ? { ok: true, value: undefined } : result;
    },
    health: (wsId) => transport.call(`${prefix}.health`, { workspaceId: wsId }),
    findByAgentId: async (agentId) => {
      const result = await transport.call<
        readonly NexusWorkspaceRecord[] | NexusWorkspaceFindResponse
      >(`${prefix}.findByAgentId`, { agentId });
      if (!result.ok) return result;
      const workspaces = normalizeWorkspaceList(result.value);
      if (workspaces === undefined) {
        return {
          ok: false,
          error: internal(`Invalid workspace discovery payload for agent ${String(agentId)}`, result.value),
        };
      }
      return { ok: true, value: workspaces };
    },
    attestSetupComplete: (wsId) => callVoid(`${prefix}.attestSetupComplete`, { workspaceId: wsId }),
    verifySetupComplete: async (wsId) => {
      const result = await transport.call<boolean | NexusWorkspaceSetupCompleteResponse>(
        `${prefix}.verifySetupComplete`,
        { workspaceId: wsId },
      );
      if (!result.ok) return result;
      const setupComplete = normalizeBooleanResult(result.value, "setupComplete");
      if (setupComplete === undefined) {
        return {
          ok: false,
          error: internal(`Invalid setup-complete verification payload for workspace ${String(wsId)}`, result.value),
        };
      }
      return { ok: true, value: setupComplete };
    },
    invalidateSetupComplete: (wsId) =>
      callVoid(`${prefix}.invalidateSetupComplete`, { workspaceId: wsId }),
    exists: async (wsId) => {
      const result = await transport.call<boolean | NexusWorkspaceExistsResponse>(
        `${prefix}.exists`,
        { workspaceId: wsId },
      );
      if (!result.ok) return result;
      const exists = normalizeBooleanResult(result.value, "exists");
      if (exists === undefined) {
        return {
          ok: false,
          error: internal(`Invalid workspace existence payload for workspace ${String(wsId)}`, result.value),
        };
      }
      return { ok: true, value: exists };
    },
  };
}
