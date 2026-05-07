import type { AgentStateRefs, IncomingMessage } from "../types.js";

export const MESSAGE_SIGNAL_NAME = "message" as const;
export const SHUTDOWN_SIGNAL_NAME = "shutdown" as const;

export const STATE_QUERY_NAME = "getState" as const;
export const STATUS_QUERY_NAME = "getStatus" as const;
export const PENDING_COUNT_QUERY_NAME = "getPendingCount" as const;

export type AgentActivityStatus = "idle" | "working" | "shutting_down";

export type MessageSignalPayload = IncomingMessage;
export type ShutdownSignalPayload = { readonly reason: string };
export type StateQueryResult = AgentStateRefs;
export type StatusQueryResult = AgentActivityStatus;
export type PendingCountQueryResult = number;
