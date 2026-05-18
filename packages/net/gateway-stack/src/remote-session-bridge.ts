import type { ResolvedWorkspaceConfig, WorkspaceId, WorkspaceInfo } from "@koi/core";
import { agentId } from "@koi/core";
import type { GatewayFrame, Session } from "@koi/gateway";
import type {
  RemoteSessionBridgeConfig,
  RemoteSessionBridgeHandle,
  RemoteSessionRuntime,
} from "./remote-bridge-types.js";
import { isRecord } from "./remote-bridge-util.js";

const DEFAULT_WORKSPACE_CONFIG: ResolvedWorkspaceConfig = {
  cleanupPolicy: "always",
  cleanupTimeoutMs: 30_000,
};

interface RemoteSessionRecord {
  readonly sessionId: string;
  readonly workspace: WorkspaceInfo;
  readonly runtime: RemoteSessionRuntime;
}

interface BridgeState {
  readonly records: Map<string, Promise<RemoteSessionRecord>>;
  readonly agentUnsubscribers: Map<string, () => void>;
  readonly sessionAgents: Map<string, string>;
  readonly workspaceConfig: ResolvedWorkspaceConfig;
}

export function attachRemoteSessionBridge(
  config: RemoteSessionBridgeConfig,
): RemoteSessionBridgeHandle {
  const state: BridgeState = {
    records: new Map(),
    agentUnsubscribers: new Map(),
    sessionAgents: new Map(),
    workspaceConfig: config.workspaceConfig ?? DEFAULT_WORKSPACE_CONFIG,
  };
  const registerAgent = (agent: string): void => {
    registerBridgeAgent(config, state, agent);
  };
  const unsubscribeSessions = config.gateway.onSessionEvent((event) => {
    if (event.kind === "created") {
      state.sessionAgents.set(event.session.id, event.session.agentId);
      registerAgent(event.session.agentId);
      return;
    }
    if (event.kind === "destroyed") {
      handleDestroyedSession(config, state, event.sessionId);
    }
  });

  return {
    dispose: () => disposeBridge(config, state, unsubscribeSessions),
  };
}

function registerBridgeAgent(
  config: RemoteSessionBridgeConfig,
  state: BridgeState,
  agent: string,
): void {
  if (state.agentUnsubscribers.has(agent)) return;
  const unsubscribe = config.gateway.onFrame(agent, async (session, frame) => {
    await handleBridgeFrame(config, state, session, frame);
  });
  state.agentUnsubscribers.set(agent, unsubscribe);
}

async function handleBridgeFrame(
  config: RemoteSessionBridgeConfig,
  state: BridgeState,
  session: Session,
  frame: GatewayFrame,
): Promise<void> {
  if (frame.kind !== "request") return;
  if (isTerminateFrame(frame)) {
    await terminateSession(config, state.records, session.id);
    return;
  }
  const record = await ensureRecord(config, state.records, state.workspaceConfig, session);
  await record.runtime.runFrame(session, frame);
}

function handleDestroyedSession(
  config: RemoteSessionBridgeConfig,
  state: BridgeState,
  sessionId: string,
): void {
  const agent = state.sessionAgents.get(sessionId);
  state.sessionAgents.delete(sessionId);
  if (agent !== undefined) unregisterAgentIfUnused(state, agent);
  void disposeRecord(config, state.records, sessionId).catch((err: unknown) => {
    config.onBridgeError?.(err, {
      operation: "dispose.destroyed-session",
      sessionId,
    });
  });
}

function unregisterAgentIfUnused(state: BridgeState, agent: string): void {
  for (const registeredAgent of state.sessionAgents.values()) {
    if (registeredAgent === agent) return;
  }
  state.agentUnsubscribers.get(agent)?.();
  state.agentUnsubscribers.delete(agent);
}

async function disposeBridge(
  config: RemoteSessionBridgeConfig,
  state: BridgeState,
  unsubscribeSessions: () => void,
): Promise<void> {
  unsubscribeSessions();
  for (const unsubscribe of state.agentUnsubscribers.values()) unsubscribe();
  state.agentUnsubscribers.clear();
  state.sessionAgents.clear();
  const settled = await Promise.allSettled(
    [...state.records.keys()].map((sessionId) => disposeRecord(config, state.records, sessionId)),
  );
  throwDisposeFailures(settled);
}

function throwDisposeFailures(settled: readonly PromiseSettledResult<void>[]): void {
  const failures = settled
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "remote bridge session disposal failed");
  }
}

async function ensureRecord(
  config: RemoteSessionBridgeConfig,
  records: Map<string, Promise<RemoteSessionRecord>>,
  workspaceConfig: ResolvedWorkspaceConfig,
  session: Session,
): Promise<RemoteSessionRecord> {
  const existing = records.get(session.id);
  if (existing !== undefined) return existing;

  const created = createRecord(config, workspaceConfig, session).catch(async (err: unknown) => {
    records.delete(session.id);
    try {
      await destroyGatewaySession(config.gateway, session.id, "remote bridge spawn failed");
    } catch (destroyError: unknown) {
      throw new AggregateError(
        [err, destroyError],
        `remote runtime spawn failed and session ${session.id} destroy failed`,
      );
    }
    throw err;
  });
  records.set(session.id, created);
  return created;
}

async function createRecord(
  config: RemoteSessionBridgeConfig,
  workspaceConfig: ResolvedWorkspaceConfig,
  session: Session,
): Promise<RemoteSessionRecord> {
  const workspaceResult = await config.workspace.create(agentId(session.agentId), workspaceConfig);
  if (!workspaceResult.ok) {
    throw new Error(workspaceResult.error.message, { cause: workspaceResult.error });
  }
  try {
    const runtime = await config.createRuntime({
      session,
      workspace: workspaceResult.value,
      gateway: config.gateway,
    });
    return { sessionId: session.id, workspace: workspaceResult.value, runtime };
  } catch (err: unknown) {
    try {
      await disposeWorkspace(config.workspace, workspaceResult.value.id);
    } catch (disposeError: unknown) {
      throw new AggregateError(
        [err, disposeError],
        `remote runtime spawn failed and workspace ${workspaceResult.value.id} cleanup failed`,
      );
    }
    throw err;
  }
}

async function terminateSession(
  config: RemoteSessionBridgeConfig,
  records: Map<string, Promise<RemoteSessionRecord>>,
  sessionId: string,
): Promise<void> {
  let disposeError: unknown;
  try {
    await disposeRecord(config, records, sessionId);
  } catch (err: unknown) {
    disposeError = err;
  }
  try {
    await destroyGatewaySession(config.gateway, sessionId, "remote terminate");
  } catch (destroyError: unknown) {
    if (disposeError !== undefined) {
      throw new AggregateError(
        [disposeError, destroyError],
        `remote session ${sessionId} disposal and destroy failed`,
      );
    }
    throw destroyError;
  }
  if (disposeError !== undefined) throw disposeError;
}

async function destroyGatewaySession(
  gateway: Pick<RemoteSessionBridgeConfig["gateway"], "destroySession">,
  sessionId: string,
  reason: string,
): Promise<void> {
  const result = await gateway.destroySession(sessionId, reason);
  if (!result.ok) {
    throw new Error(result.error.message, { cause: result.error });
  }
}

async function disposeRecord(
  config: RemoteSessionBridgeConfig,
  records: Map<string, Promise<RemoteSessionRecord>>,
  sessionId: string,
): Promise<void> {
  const pending = records.get(sessionId);
  if (pending === undefined) return;
  records.delete(sessionId);
  const record = await pending;
  let disposeError: unknown;
  try {
    await record.runtime.dispose();
  } catch (err: unknown) {
    disposeError = err;
  }
  try {
    await disposeWorkspace(config.workspace, record.workspace.id);
  } catch (workspaceError: unknown) {
    if (disposeError !== undefined) {
      throw new AggregateError(
        [disposeError, workspaceError],
        `remote runtime and workspace ${record.workspace.id} disposal failed`,
      );
    }
    throw workspaceError;
  }
  if (disposeError !== undefined) throw disposeError;
}

async function disposeWorkspace(
  workspace: RemoteSessionBridgeConfig["workspace"],
  workspaceId: WorkspaceId,
): Promise<void> {
  const result = await workspace.dispose(workspaceId);
  if (!result.ok) {
    throw new Error(result.error.message, { cause: result.error });
  }
}

function isTerminateFrame(frame: GatewayFrame): boolean {
  if (!isRecord(frame.payload)) return false;
  return frame.payload.operation === "terminate" || frame.payload.kind === "terminate";
}
