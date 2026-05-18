/**
 * @koi/gateway-stack — L3 wiring for the full gateway bundle.
 *
 * One factory, one start/stop, one health endpoint — Nexus-backed HA is
 * opt-in via `deps.nexusTransport`.
 */

export { createGatewayStack } from "./create-gateway-stack.js";
export {
  createLocalGatewayLauncher,
  type GatewayUpStartedEvent,
  type GatewayUpStoppedEvent,
  type LocalGatewayLauncher,
  type LocalGatewayLauncherConfig,
  type LocalGatewayLaunchHandle,
} from "./local-launcher.js";
export {
  attachRemoteSessionBridge,
  createGatewayRemoteSessionRuntime,
  createRemoteGatewayAuthenticator,
  createRemoteGatewayStack,
  type GatewayRemoteSessionRuntimeConfig,
  type RemoteEngineRuntime,
  type RemoteGatewayAuthenticatorConfig,
  type RemoteGatewayStack,
  type RemoteGatewayStackConfig,
  type RemoteGatewayStackDeps,
  type RemoteRuntimeCreateInput,
  type RemoteSessionBridgeConfig,
  type RemoteSessionBridgeHandle,
  type RemoteSessionRuntime,
} from "./remote-bridge.js";
export type {
  GatewayStack,
  GatewayStackConfig,
  GatewayStackDeps,
  GatewayStackHealth,
  GatewayStackHealthStatus,
} from "./types.js";
