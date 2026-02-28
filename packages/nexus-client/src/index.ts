/**
 * @koi/nexus-client — Shared JSON-RPC 2.0 transport for Nexus services.
 *
 * L0u utility package. Depends only on @koi/core.
 */

export { mapHttpError, mapRpcError } from "./errors.js";
export { createNexusClient } from "./nexus-client.js";
export type {
  JsonRpcErrorResponse,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
  NexusClient,
  NexusClientConfig,
} from "./types.js";
