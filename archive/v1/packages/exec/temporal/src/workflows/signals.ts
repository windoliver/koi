/**
 * Signal and query definitions for the Entity Workflow.
 *
 * Shared between workflow code (sandbox) and client code (Bun host).
 * This file MUST be importable from both contexts — no I/O, no side effects.
 */

import type { AgentStateRefs, IncomingMessage } from "../types.js";

// ---------------------------------------------------------------------------
// Signal definitions — how messages reach the agent
// ---------------------------------------------------------------------------

/**
 * Signal name for incoming user/agent messages.
 * Nexus IPC → Temporal signal → workflow wakes.
 */
export const MESSAGE_SIGNAL_NAME = "message" as const;

/**
 * Signal name for graceful shutdown request.
 * The workflow completes its current turn and exits.
 */
export const SHUTDOWN_SIGNAL_NAME = "shutdown" as const;

// ---------------------------------------------------------------------------
// Query definitions — inspect agent state without side effects
// ---------------------------------------------------------------------------

/** Query the agent's current state references. */
export const STATE_QUERY_NAME = "getState" as const;

/** Query the agent's activity status. */
export const STATUS_QUERY_NAME = "getStatus" as const;

/** Query the count of pending (unprocessed) messages. */
export const PENDING_COUNT_QUERY_NAME = "getPendingCount" as const;

// ---------------------------------------------------------------------------
// Query result types
// ---------------------------------------------------------------------------

export type AgentActivityStatus = "idle" | "working" | "shutting_down";

/**
 * These type aliases exist so that client code can reference the signal/query
 * payloads without importing @temporalio/workflow (which is sandbox-only).
 */
export type MessageSignalPayload = IncomingMessage;
export type ShutdownSignalPayload = { readonly reason: string };
export type StateQueryResult = AgentStateRefs;
export type StatusQueryResult = AgentActivityStatus;
export type PendingCountQueryResult = number;
