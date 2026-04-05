/**
 * Worker ↔ main thread message protocol for engine worker isolation.
 *
 * The engine adapter runs in a Bun worker thread. These discriminated unions
 * define every message that can cross the thread boundary via postMessage.
 *
 * Design:
 * - Plain data only — no functions, no class instances (structured-clone safe)
 * - String `kind` discriminant — hits Bun's zero-copy postMessage fast path
 * - Approval requests are bidirectional: worker requests → main resolves →
 *   worker continues (correlation via `requestId`)
 *
 * Layer: L0 (@koi/core) — pure types, zero logic, zero external deps.
 */

import type { EngineEvent, EngineState } from "./engine.js";
import type { InboundMessage } from "./message.js";
import type { ApprovalDecision, ApprovalRequest } from "./middleware.js";

// ---------------------------------------------------------------------------
// Clone-safe engine input (subset of EngineInput, no functions or AbortSignal)
// ---------------------------------------------------------------------------

/**
 * Serializable turn input sent over postMessage to start an engine stream.
 *
 * This is the structured-clone-safe subset of `EngineInput`:
 * - Excludes `callHandlers` (function-valued, not cloneable)
 * - Excludes `signal` (AbortSignal — not cloneable, worker manages its own)
 * - Excludes `correlationIds` (internal bookkeeping reconstructed in worker)
 *
 * The worker reconstructs a full `EngineInput` from this payload by:
 * 1. Building `callHandlers` from its local runtime/adapter
 * 2. Creating a fresh `AbortController` (cancelled via `stream_interrupt`)
 */
export type WorkerEngineInput =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "messages"; readonly messages: readonly InboundMessage[] }
  | { readonly kind: "resume"; readonly state: EngineState };

// ---------------------------------------------------------------------------
// Worker → main
// ---------------------------------------------------------------------------

/**
 * Messages the engine worker sends to the main thread.
 *
 * | kind              | meaning                                               |
 * |-------------------|-------------------------------------------------------|
 * | ready             | Worker initialised — main may send stream_start       |
 * | engine_event      | One EngineEvent from the adapter stream               |
 * | approval_request  | Middleware needs a permission decision (HITL)         |
 * | engine_done       | adapter.stream() completed normally                   |
 * | engine_error      | adapter.stream() threw; message carries the reason    |
 */
export type WorkerToMainMessage =
  | { readonly kind: "ready" }
  | { readonly kind: "engine_event"; readonly event: EngineEvent }
  | {
      readonly kind: "approval_request";
      readonly requestId: string;
      readonly request: ApprovalRequest;
    }
  | { readonly kind: "engine_done" }
  | { readonly kind: "engine_error"; readonly message: string };

// ---------------------------------------------------------------------------
// Main → worker
// ---------------------------------------------------------------------------

/**
 * Messages the main thread sends to the engine worker.
 *
 * | kind               | meaning                                              |
 * |--------------------|------------------------------------------------------|
 * | stream_start       | Begin adapter.stream(input); worker posts events     |
 * | stream_interrupt   | Abort the current stream (AbortController.abort())   |
 * | approval_response  | User's decision for a pending approval_request       |
 * | shutdown           | Terminate the worker cleanly                         |
 */
export type MainToWorkerMessage =
  | { readonly kind: "stream_start"; readonly input: WorkerEngineInput }
  | { readonly kind: "stream_interrupt" }
  | {
      readonly kind: "approval_response";
      readonly requestId: string;
      readonly decision: ApprovalDecision;
    }
  | { readonly kind: "shutdown" };
