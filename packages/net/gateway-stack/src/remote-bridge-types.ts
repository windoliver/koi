import type {
  EngineEvent,
  EngineInput,
  ResolvedWorkspaceConfig,
  WorkspaceBackend,
  WorkspaceInfo,
} from "@koi/core";
import type { ConnectFrame, Gateway, GatewayFrame, RoutingContext, Session } from "@koi/gateway";
import type { RemoteAuthenticatorOptions, RemoteAuthRequest, RemoteAuthResult } from "@koi/remote";
import type { GatewayStack, GatewayStackConfig, GatewayStackDeps } from "./types.js";

export interface RemoteGatewayAuthenticatorConfig {
  readonly url: string | ((frame: ConnectFrame) => string);
  readonly remote?: RemoteAuthenticatorOptions | undefined;
  readonly authenticateRemote?:
    | ((request: RemoteAuthRequest) => RemoteAuthResult | Promise<RemoteAuthResult>)
    | undefined;
  readonly resolveSessionId?:
    | ((auth: Extract<RemoteAuthResult, { readonly ok: true }>, frame: ConnectFrame) => string)
    | undefined;
  readonly resolveAgentId?:
    | ((auth: Extract<RemoteAuthResult, { readonly ok: true }>, frame: ConnectFrame) => string)
    | undefined;
  readonly resolveRouting?:
    | ((
        auth: Extract<RemoteAuthResult, { readonly ok: true }>,
        frame: ConnectFrame,
      ) => RoutingContext)
    | undefined;
}

export interface RemoteSessionRuntime {
  readonly runFrame: (session: Session, frame: GatewayFrame) => void | Promise<void>;
  readonly dispose: () => void | Promise<void>;
}

export interface RemoteEngineRuntime {
  readonly run: (input: EngineInput) => AsyncIterable<EngineEvent>;
  readonly dispose?: (() => void | Promise<void>) | undefined;
}

export interface GatewayRemoteSessionRuntimeConfig {
  readonly gateway: Pick<Gateway, "send">;
  readonly runtime: RemoteEngineRuntime;
  readonly nextFrameId?: (() => string) | undefined;
  readonly nowMs?: (() => number) | undefined;
  readonly onRuntimeError?:
    | ((
        error: unknown,
        context: { readonly session: Session; readonly frame: GatewayFrame },
      ) => void)
    | undefined;
}

export interface RemoteRuntimeCreateInput {
  readonly session: Session;
  readonly workspace: WorkspaceInfo;
  readonly gateway: Gateway;
}

export interface RemoteSessionBridgeConfig {
  readonly gateway: Gateway;
  readonly workspace: WorkspaceBackend;
  readonly workspaceConfig?: ResolvedWorkspaceConfig | undefined;
  readonly createRuntime: (input: RemoteRuntimeCreateInput) => Promise<RemoteSessionRuntime>;
  readonly onBridgeError?:
    | ((
        error: unknown,
        context: { readonly operation: string; readonly sessionId: string },
      ) => void)
    | undefined;
}

export interface RemoteSessionBridgeHandle {
  readonly dispose: () => Promise<void>;
}

export interface RemoteGatewayStackConfig extends GatewayStackConfig {
  readonly remote: RemoteGatewayAuthenticatorConfig;
  readonly workspaceConfig?: ResolvedWorkspaceConfig | undefined;
}

export interface RemoteGatewayStackDeps extends Omit<GatewayStackDeps, "auth"> {
  readonly workspace: WorkspaceBackend;
  readonly createRuntime: (input: RemoteRuntimeCreateInput) => Promise<RemoteSessionRuntime>;
}

export interface RemoteGatewayStack extends GatewayStack {
  readonly remoteBridge: RemoteSessionBridgeHandle;
}
