/**
 * @koi/permissions-nexus — ReBAC permission backend via Nexus JSON-RPC.
 *
 * Thin client: all permission logic lives in the Nexus server.
 * This package provides typed L0 contract implementations that
 * forward queries to Nexus and map responses.
 */

export {
  type NexusPermissionsConfig,
  validateNexusPermissionsConfig,
} from "./config.js";
export {
  createNexusPermissionBackend,
  type NexusPermissionBackendConfig,
} from "./nexus-permission-backend.js";
export {
  createNexusRevocationRegistry,
  type NexusRevocationRegistryConfig,
} from "./nexus-revocation-registry.js";
export {
  createNexusScopeEnforcer,
  type NexusScopeEnforcerConfig,
} from "./nexus-scope-enforcer.js";
export {
  FS_OPERATION_RELATIONS,
  type NexusCheckBatchResponse,
  type NexusCheckResponse,
  type NexusRevocationBatchResponse,
  type NexusRevocationCheckResponse,
  type RelationshipTuple,
} from "./types.js";
