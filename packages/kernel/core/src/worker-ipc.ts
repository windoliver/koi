/**
 * WorkerIpcMessage — Bun IPC envelope between a parent supervisor and a
 * subprocess-isolated supervised child (3b-5 / Bun IPC + JSON envelope).
 *
 * Type-tagged discriminated union. All cross-process messages share a
 * `{ koi: <kind>, ... }` shape so the subprocess backend can route them
 * by a single property check.
 *
 * Exception (L0 rule): types + a pure validator. `validateWorkerIpcMessage`
 * operates only on L0 types, zero side effects — permitted per architecture
 * doc's L0 exception list (same category as `validateSpawnRequest`,
 * `validateSupervisionConfig`).
 *
 * Design note: `engine-event` and `message` kinds carry opaque JSON-serializable
 * payloads. L0 does not validate their contents — runtime consumers (engine
 * adapters in 3b-5c and beyond) define their own payload schemas.
 */

import { type KoiError, RETRYABLE_DEFAULTS, type Result } from "./errors.js";

/**
 * Parent → child: advisory termination request. The supervisor's
 * `backend.terminate()` path may send this before falling back to OS
 * signals, giving the child a chance to flush work cleanly.
 */
export interface WorkerIpcTerminateMessage {
  readonly koi: "terminate";
  readonly reason?: string;
}

/**
 * Child → parent: liveness ping. Extends the existing heartbeat channel
 * already honored by `createSubprocessBackend`.
 */
export interface WorkerIpcHeartbeatMessage {
  readonly koi: "heartbeat";
}

/**
 * Child → parent: opaque engine event payload. Relays the child agent's
 * `EngineEvent` stream upward. Payload shape is defined by `@koi/core`'s
 * `EngineEvent` type but is NOT re-validated here — the child is trusted
 * to produce well-formed events.
 */
export interface WorkerIpcEngineEventMessage {
  readonly koi: "engine-event";
  readonly event: unknown;
}

/**
 * Bidirectional: sibling/inbox-style message. Reserved for future
 * supervised-child messaging; not yet consumed.
 */
export interface WorkerIpcMessageMessage {
  readonly koi: "message";
  readonly payload: unknown;
}

/**
 * Child → parent: terminal result artifact after the child's agent loop
 * completes. Carries exit code + optional structured output. Parent
 * adapters use this to forge the child's final `RegistryEntry` transition
 * reason.
 */
export interface WorkerIpcResultMessage {
  readonly koi: "result";
  readonly exitCode: number;
  readonly output?: unknown;
}

export type WorkerIpcMessage =
  | WorkerIpcTerminateMessage
  | WorkerIpcHeartbeatMessage
  | WorkerIpcEngineEventMessage
  | WorkerIpcMessageMessage
  | WorkerIpcResultMessage;

export type WorkerIpcMessageKind = WorkerIpcMessage["koi"];

const VALID_KINDS: ReadonlySet<string> = new Set([
  "terminate",
  "heartbeat",
  "engine-event",
  "message",
  "result",
]);

/**
 * Validate an unknown value as a `WorkerIpcMessage`. Checks the envelope
 * shape (object with known `koi` kind) and any kind-specific required
 * fields. Opaque payloads (`engine-event.event`, `message.payload`,
 * `result.output`) are accepted as-is.
 */
export function validateWorkerIpcMessage(raw: unknown): Result<WorkerIpcMessage, KoiError> {
  if (typeof raw !== "object" || raw === null) {
    return fail("WorkerIpcMessage must be an object");
  }
  if (!("koi" in raw)) {
    return fail("WorkerIpcMessage missing `koi` discriminator");
  }
  const kind = (raw as { readonly koi: unknown }).koi;
  if (typeof kind !== "string" || !VALID_KINDS.has(kind)) {
    return fail(`WorkerIpcMessage.koi unknown kind: ${JSON.stringify(kind)}`);
  }

  switch (kind) {
    case "terminate":
    case "heartbeat":
    case "message":
      return { ok: true, value: raw as WorkerIpcMessage };
    case "engine-event": {
      if (!("event" in raw)) {
        return fail("engine-event message missing `event` field");
      }
      return { ok: true, value: raw as WorkerIpcEngineEventMessage };
    }
    case "result": {
      const code = (raw as { readonly exitCode?: unknown }).exitCode;
      if (typeof code !== "number" || !Number.isFinite(code) || !Number.isInteger(code)) {
        return fail("result message requires integer `exitCode`");
      }
      return { ok: true, value: raw as WorkerIpcResultMessage };
    }
    default:
      return fail(`unreachable validateWorkerIpcMessage kind: ${kind as string}`);
  }
}

function fail(message: string): { readonly ok: false; readonly error: KoiError } {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}
