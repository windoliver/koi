/**
 * @koi/nexus-client — Shared JSON-RPC 2.0 transport for Nexus services.
 *
 * L0u utility package. Depends only on @koi/core.
 */

export { batchRead } from "./batch-read.js";
export { mapHttpError, mapRpcError } from "./errors.js";
export {
  deleteJson,
  readJson,
  validatePathSegment,
  wrapNexusError,
  writeJson,
} from "./helpers.js";
export { createNexusClient } from "./nexus-client.js";
export {
  agentBrickPath,
  agentBricksGlob,
  agentDeadLetterGlob,
  agentDeadLetterPath,
  agentEventGlob,
  agentEventMetaPath,
  agentEventPath,
  agentMemoryGlob,
  agentMemoryPath,
  agentPendingFramePath,
  agentPendingFramesGlob,
  agentSessionPath,
  agentSnapshotGlob,
  agentSnapshotPath,
  agentSubscriptionPath,
  agentWorkspaceGlob,
  agentWorkspacePath,
  gatewayNodePath,
  gatewayNodesGlob,
  gatewaySessionPath,
  gatewaySessionsGlob,
  gatewaySurfacePath,
  gatewaySurfacesGlob,
  globalBrickPath,
  groupScratchGlob,
  groupScratchPath,
  SEGMENTS,
} from "./paths.js";
export type { NexusRestClient, NexusRestClientConfig } from "./rest-client.js";
export { createNexusRestClient, mapRestFetchError, mapRestHttpError } from "./rest-client.js";
export type {
  JsonRpcErrorResponse,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
  NexusClient,
  NexusClientConfig,
} from "./types.js";
export { validateNexusConfig, validateNexusPath } from "./validate.js";
