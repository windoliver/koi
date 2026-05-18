import type { AuthResult, ConnectFrame, GatewayAuthenticator, RoutingContext } from "@koi/gateway";
import {
  authenticateRemoteRequest,
  type RemoteAuthRequest,
  type RemoteAuthResult,
} from "@koi/remote";
import { createGatewayStack } from "./create-gateway-stack.js";
import type {
  RemoteGatewayAuthenticatorConfig,
  RemoteGatewayStack,
  RemoteGatewayStackConfig,
  RemoteGatewayStackDeps,
} from "./remote-bridge-types.js";
import { attachRemoteSessionBridge } from "./remote-session-bridge.js";
import type { GatewayStackConfig } from "./types.js";

export type {
  GatewayRemoteSessionRuntimeConfig,
  RemoteEngineRuntime,
  RemoteGatewayAuthenticatorConfig,
  RemoteGatewayStack,
  RemoteGatewayStackConfig,
  RemoteGatewayStackDeps,
  RemoteRuntimeCreateInput,
  RemoteSessionBridgeConfig,
  RemoteSessionBridgeHandle,
  RemoteSessionRuntime,
} from "./remote-bridge-types.js";
export { attachRemoteSessionBridge } from "./remote-session-bridge.js";
export { createGatewayRemoteSessionRuntime } from "./remote-session-runtime.js";

export interface RemoteGatewayStackInternals {
  readonly createGatewayStack: typeof createGatewayStack;
  readonly createRemoteGatewayAuthenticator: typeof createRemoteGatewayAuthenticator;
  readonly attachRemoteSessionBridge: typeof attachRemoteSessionBridge;
}

const DEFAULT_REMOTE_GATEWAY_STACK_INTERNALS: RemoteGatewayStackInternals = {
  createGatewayStack,
  createRemoteGatewayAuthenticator,
  attachRemoteSessionBridge,
};

export function createRemoteGatewayStack(
  config: RemoteGatewayStackConfig,
  deps: RemoteGatewayStackDeps,
  internals: RemoteGatewayStackInternals = DEFAULT_REMOTE_GATEWAY_STACK_INTERNALS,
): RemoteGatewayStack {
  const { workspace, createRuntime, ...stackDeps } = deps;
  const auth = internals.createRemoteGatewayAuthenticator(config.remote);
  const stack = internals.createGatewayStack(toGatewayStackConfig(config), { ...stackDeps, auth });
  const remoteBridge = internals.attachRemoteSessionBridge({
    gateway: stack.gateway,
    workspace,
    createRuntime,
    ...(config.workspaceConfig !== undefined ? { workspaceConfig: config.workspaceConfig } : {}),
  });

  return {
    ...stack,
    remoteBridge,
    async stop(): Promise<void> {
      await stopRemoteGatewayStack(remoteBridge.dispose, stack.stop);
    },
  };
}

export function createRemoteGatewayAuthenticator(
  config: RemoteGatewayAuthenticatorConfig,
): GatewayAuthenticator {
  return {
    authenticate: async (frame): Promise<AuthResult> => {
      const remote = await runRemoteAuth(config, frame);
      if (!remote.ok) return mapRemoteReject(remote.reason);

      return {
        ok: true,
        sessionId: resolveRemoteSessionId(config, remote, frame),
        agentId: resolveRemoteAgentId(config, remote, frame),
        metadata: {
          remoteSubject: remote.subject,
          remoteDeviceId: remote.deviceId,
          remotePermissions: remote.permissions,
          remoteMetadata: remote.metadata,
        },
        routing: resolveRemoteRouting(config, remote, frame),
      };
    },
  };
}

async function stopRemoteGatewayStack(
  stopBridge: () => Promise<void>,
  stopStack: () => Promise<void>,
): Promise<void> {
  let bridgeError: unknown;
  try {
    await stopBridge();
  } catch (err: unknown) {
    bridgeError = err;
  }
  try {
    await stopStack();
  } catch (stackError: unknown) {
    if (bridgeError !== undefined) {
      throw new AggregateError(
        [bridgeError, stackError],
        "remote bridge and gateway stack stop failed",
      );
    }
    throw stackError;
  }
  if (bridgeError !== undefined) throw bridgeError;
}

async function runRemoteAuth(
  config: RemoteGatewayAuthenticatorConfig,
  frame: ConnectFrame,
): Promise<RemoteAuthResult> {
  const request: RemoteAuthRequest = {
    bearerToken: frame.auth.token,
    transport: "websocket",
    operation: "stream",
    url: typeof config.url === "string" ? config.url : config.url(frame),
  };
  if (config.authenticateRemote !== undefined) return config.authenticateRemote(request);
  if (config.remote === undefined) {
    return { ok: false, reason: "jwt_rejected" };
  }
  return authenticateRemoteRequest(request, config.remote);
}

function mapRemoteReject(
  reason: Exclude<RemoteAuthResult, { readonly ok: true }>["reason"],
): AuthResult {
  if (reason === "jwt_rejected") {
    return { ok: false, code: "INVALID_TOKEN", message: "Remote JWT rejected" };
  }
  if (reason === "untrusted_device") {
    return { ok: false, code: "FORBIDDEN", message: "Remote device is not trusted" };
  }
  if (reason === "permission_rejected") {
    return { ok: false, code: "FORBIDDEN", message: "Remote permissions rejected" };
  }
  return { ok: false, code: "FORBIDDEN", message: "Remote transport rejected" };
}

function resolveRemoteSessionId(
  config: RemoteGatewayAuthenticatorConfig,
  remote: Extract<RemoteAuthResult, { readonly ok: true }>,
  frame: ConnectFrame,
): string {
  return config.resolveSessionId?.(remote, frame) ?? `remote:${remote.subject}:${remote.deviceId}`;
}

function resolveRemoteAgentId(
  config: RemoteGatewayAuthenticatorConfig,
  remote: Extract<RemoteAuthResult, { readonly ok: true }>,
  frame: ConnectFrame,
): string {
  return (
    config.resolveAgentId?.(remote, frame) ?? remote.agentId ?? frame.client?.id ?? remote.subject
  );
}

function resolveRemoteRouting(
  config: RemoteGatewayAuthenticatorConfig,
  remote: Extract<RemoteAuthResult, { readonly ok: true }>,
  frame: ConnectFrame,
): RoutingContext {
  return config.resolveRouting?.(remote, frame) ?? { peer: frame.client?.id ?? remote.deviceId };
}

function toGatewayStackConfig(config: RemoteGatewayStackConfig): GatewayStackConfig {
  return {
    ...(config.gateway !== undefined ? { gateway: config.gateway } : {}),
    ...(config.canvas !== undefined ? { canvas: config.canvas } : {}),
    ...(config.webhook !== undefined ? { webhook: config.webhook } : {}),
    ...(config.nexus !== undefined ? { nexus: config.nexus } : {}),
  };
}
