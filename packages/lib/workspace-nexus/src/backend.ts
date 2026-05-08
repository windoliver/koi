import type {
  AgentId,
  KoiError,
  ResolvedWorkspaceConfig,
  Result,
  WorkspaceBackend,
  WorkspaceId,
  WorkspaceInfo,
} from "@koi/core";
import { createNexusWorkspaceBackendClient, type NexusWorkspaceBackendClient } from "./client.js";
import type {
  NexusWorkspaceBackendConfig,
  NexusWorkspaceRecord,
  NexusWorkspaceServerCapabilities,
} from "./types.js";

const DEFAULT_PREFIX = "workspace";

function workspaceId(id: string): WorkspaceId {
  return id as WorkspaceId;
}

function mapWorkspace(record: NexusWorkspaceRecord): WorkspaceInfo {
  return {
    id: workspaceId(record.id),
    path: record.path,
    createdAt: record.createdAt,
    metadata: record.metadata,
  };
}

type OptionalHook =
  | "findByAgentId"
  | "attestSetupComplete"
  | "verifySetupComplete"
  | "invalidateSetupComplete"
  | "exists";

// Optional hooks default to ON because the workspace provider depends on
// `findByAgentId` (and the attestation hooks) to recover crash survivors
// after a restart. Hiding them by default would silently disable survivor
// discovery and push the provider into duplicate-allocation under
// `cleanupPolicy="never"`.
//
//   - serverCapabilities omitted → expose all hooks.
//   - Hook listed `false` in serverCapabilities → omit.
//   - Hook listed `true` (or absent) → expose.
function isHookExposed(
  capabilities: NexusWorkspaceServerCapabilities | undefined,
  key: OptionalHook,
): boolean {
  return capabilities?.[key] !== false;
}

// `isSandboxed=true` lets the workspace provider trust backend-native
// attestation/existence hooks for survivor recovery. We can only honor that
// contract when ALL attestation/existence/discovery hooks are actually
// exposed — otherwise the provider would trust a local marker file for a
// remote workspace.
function computeSandboxedRecoveryReady(
  capabilities: NexusWorkspaceServerCapabilities | undefined,
): boolean {
  return (
    isHookExposed(capabilities, "findByAgentId") &&
    isHookExposed(capabilities, "attestSetupComplete") &&
    isHookExposed(capabilities, "verifySetupComplete") &&
    isHookExposed(capabilities, "invalidateSetupComplete") &&
    isHookExposed(capabilities, "exists")
  );
}

async function nexusCreate(
  client: NexusWorkspaceBackendClient,
  agentId: AgentId,
  resolved: ResolvedWorkspaceConfig,
): Promise<Result<WorkspaceInfo, KoiError>> {
  // create() does NOT fall back on a Nexus error: a transport failure is
  // ambiguous (Nexus may have committed the workspace and only lost the
  // response). Creating a second workspace on fallback in that case would
  // violate the provider's single-workspace-per-agent invariant and leave
  // one live workspace untracked.
  const result = await client.create(agentId, resolved);
  if (result.ok) return { ok: true, value: mapWorkspace(result.value.workspace) };
  return result;
}

async function nexusIsHealthy(
  client: NexusWorkspaceBackendClient,
  wsId: WorkspaceId,
): Promise<boolean> {
  // Distinguish "Nexus says unhealthy" from "transport failed" — the
  // workspace provider treats a `false` return as authoritative permission
  // to dispose the survivor, so collapsing a transient transport failure
  // into `false` would let a temporary Nexus outage delete a perfectly
  // valid workspace during crash recovery.
  const result = await client.health(wsId);
  if (result.ok) return result.value.healthy;
  throw new Error(`Workspace backend health check failed for ${wsId}`, { cause: result.error });
}

async function nexusFindByAgentId(
  client: NexusWorkspaceBackendClient,
  agentId: AgentId,
): Promise<readonly WorkspaceInfo[]> {
  // Nexus is the sole discovery authority. We do NOT substitute fallback
  // survivors when Nexus errors: an unsandboxed fallback's inventory is
  // incomplete for Nexus-owned workspaces. Fail closed.
  const result = await client.findByAgentId(agentId);
  if (result.ok) {
    return [...result.value.map(mapWorkspace)].sort((a, b) => b.createdAt - a.createdAt);
  }
  throw new Error(`Workspace backend failed to find workspaces for agent ${String(agentId)}`, {
    cause: result.error,
  });
}

async function nexusAttest(client: NexusWorkspaceBackendClient, wsId: WorkspaceId): Promise<void> {
  const result = await client.attestSetupComplete(wsId);
  if (result.ok) return;
  throw new Error(`Workspace backend failed to attest setup completion for ${wsId}`, {
    cause: result.error,
  });
}

async function nexusInvalidate(
  client: NexusWorkspaceBackendClient,
  wsId: WorkspaceId,
): Promise<void> {
  const result = await client.invalidateSetupComplete(wsId);
  if (result.ok) return;
  throw new Error(`Workspace backend failed to invalidate setup completion for ${wsId}`, {
    cause: result.error,
  });
}

async function nexusVerify(
  client: NexusWorkspaceBackendClient,
  wsId: WorkspaceId,
): Promise<boolean> {
  const result = await client.verifySetupComplete(wsId);
  if (result.ok) return result.value;
  throw new Error(`Workspace backend failed to verify setup completion for ${wsId}`, {
    cause: result.error,
  });
}

async function nexusExists(
  client: NexusWorkspaceBackendClient,
  wsId: WorkspaceId,
): Promise<boolean> {
  const result = await client.exists(wsId);
  if (result.ok) return result.value;
  throw new Error(`Workspace backend failed to check existence for ${wsId}`, {
    cause: result.error,
  });
}

function buildOptionalHooks(
  client: NexusWorkspaceBackendClient,
  capabilities: NexusWorkspaceServerCapabilities | undefined,
): Partial<WorkspaceBackend> {
  return {
    ...(isHookExposed(capabilities, "findByAgentId")
      ? { findByAgentId: (agentId: AgentId) => nexusFindByAgentId(client, agentId) }
      : {}),
    ...(isHookExposed(capabilities, "attestSetupComplete")
      ? { attestSetupComplete: (wsId: WorkspaceId) => nexusAttest(client, wsId) }
      : {}),
    ...(isHookExposed(capabilities, "invalidateSetupComplete")
      ? { invalidateSetupComplete: (wsId: WorkspaceId) => nexusInvalidate(client, wsId) }
      : {}),
    ...(isHookExposed(capabilities, "verifySetupComplete")
      ? { verifySetupComplete: (wsId: WorkspaceId) => nexusVerify(client, wsId) }
      : {}),
    ...(isHookExposed(capabilities, "exists")
      ? { exists: (wsId: WorkspaceId) => nexusExists(client, wsId) }
      : {}),
  };
}

export async function createNexusWorkspaceBackend(
  config: NexusWorkspaceBackendConfig,
): Promise<WorkspaceBackend> {
  const prefix = config.methodPrefix ?? DEFAULT_PREFIX;

  // Startup-only escape hatch: when the operator wires a local fallback and
  // the initial health probe fails, hand the caller the raw fallback as the
  // sole authority. Runtime RPC failures must NEVER swap authorities, since
  // the two backends do not share state and silent rerouting would orphan
  // live Nexus survivors and create duplicates after the next restart.
  if (config.fallback !== undefined && config.transport.health !== undefined) {
    const health = await config.transport.health();
    if (!health.ok) return config.fallback;
  }

  const client = createNexusWorkspaceBackendClient(config.transport, prefix);
  const capabilities = config.serverCapabilities;

  return {
    name: "workspace-nexus",
    isSandboxed: computeSandboxedRecoveryReady(capabilities),
    create: (agentId, resolved) => nexusCreate(client, agentId, resolved),
    dispose: (wsId) => client.dispose(wsId),
    isHealthy: (wsId) => nexusIsHealthy(client, wsId),
    ...buildOptionalHooks(client, capabilities),
  };
}
