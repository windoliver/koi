/**
 * AG-UI EngineEvent custom event wrappers for A2UI messages.
 *
 * A2UI messages are transported as EngineEvent `custom` events
 * with type prefix `a2ui:`.
 */

import type { EngineEvent, KoiError, Result } from "@koi/core";
import type { A2uiMessage } from "./types.js";
import { isA2uiMessageKind } from "./types.js";

/** A2UI event type prefix. */
const A2UI_PREFIX = "a2ui:";

/** Creates an EngineEvent wrapping an A2UI message. */
export function createCanvasEvent(message: A2uiMessage): EngineEvent {
  return {
    kind: "custom",
    type: `${A2UI_PREFIX}${message.kind}`,
    data: message,
  };
}

/** Returns true if the EngineEvent is an A2UI canvas event. */
export function isCanvasEvent(event: EngineEvent): boolean {
  return (
    event.kind === "custom" &&
    typeof (event as { readonly type?: string }).type === "string" &&
    (event as { readonly type: string }).type.startsWith(A2UI_PREFIX)
  );
}

/** Extracts the A2UI message from a canvas EngineEvent. */
export function extractCanvasMessage(event: EngineEvent): Result<A2uiMessage, KoiError> {
  if (event.kind !== "custom") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Expected custom event, got "${event.kind}"`,
        retryable: false,
      },
    };
  }

  const customEvent = event as { readonly type: string; readonly data: unknown };

  if (!customEvent.type.startsWith(A2UI_PREFIX)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Expected a2ui: prefixed event, got "${customEvent.type}"`,
        retryable: false,
      },
    };
  }

  const data = customEvent.data;
  if (
    typeof data !== "object" ||
    data === null ||
    !("kind" in data) ||
    !isA2uiMessageKind((data as { readonly kind: unknown }).kind)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Event data is not a valid A2UI message",
        retryable: false,
      },
    };
  }

  return { ok: true, value: data as A2uiMessage };
}
