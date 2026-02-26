/**
 * JSON serialization/deserialization for CanvasSurface.
 *
 * Handles Map ↔ array conversion since JSON doesn't support Maps natively.
 */

import type { JsonObject, KoiError, Result } from "@koi/core";
import type { CanvasElement, CanvasSurface, ComponentId } from "./types.js";
import { componentId, surfaceId } from "./types.js";

// ---------------------------------------------------------------------------
// Serialized shape (JSON-safe)
// ---------------------------------------------------------------------------

interface SerializedElement {
  readonly id: string;
  readonly type: string;
  readonly properties: JsonObject;
  readonly children: readonly string[];
  readonly dataBinding?: string;
}

interface SerializedSurface {
  readonly id: string;
  readonly title?: string;
  readonly components: readonly SerializedElement[];
  readonly dataModel: JsonObject;
}

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

/** Serializes a CanvasSurface to a JSON string. */
export function serializeSurface(surface: CanvasSurface): string {
  const components: SerializedElement[] = [];
  for (const element of surface.components.values()) {
    const serialized: SerializedElement = {
      id: element.id as string,
      type: element.type,
      properties: element.properties,
      children: element.children.map((c) => c as string),
      ...(element.dataBinding !== undefined ? { dataBinding: element.dataBinding } : {}),
    };
    components.push(serialized);
  }

  const serialized: SerializedSurface = {
    id: surface.id as string,
    ...(surface.title !== undefined ? { title: surface.title } : {}),
    components,
    dataModel: surface.dataModel,
  };

  return JSON.stringify(serialized);
}

// ---------------------------------------------------------------------------
// Deserialize
// ---------------------------------------------------------------------------

/** Deserializes a JSON string to a CanvasSurface. */
export function deserializeSurface(json: string): Result<CanvasSurface, KoiError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e: unknown) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Invalid JSON: ${e instanceof Error ? e.message : "parse error"}`,
        retryable: false,
      },
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Expected JSON object for surface",
        retryable: false,
      },
    };
  }

  const raw = parsed as {
    readonly id?: unknown;
    readonly title?: unknown;
    readonly components?: unknown;
    readonly dataModel?: unknown;
  };

  if (typeof raw.id !== "string") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Surface missing required 'id' string field",
        retryable: false,
      },
    };
  }

  if (!Array.isArray(raw.components)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Surface missing required 'components' array",
        retryable: false,
      },
    };
  }

  const components = new Map<ComponentId, CanvasElement>();
  for (const comp of raw.components as readonly Record<string, unknown>[]) {
    if (typeof comp.id !== "string" || typeof comp.type !== "string") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Component missing required 'id' or 'type' string field",
          retryable: false,
        },
      };
    }

    const cId = componentId(comp.id);
    const element: CanvasElement = {
      id: cId,
      type: comp.type as CanvasElement["type"],
      properties: (comp.properties ?? {}) as JsonObject,
      children: Array.isArray(comp.children)
        ? (comp.children as readonly string[]).map(componentId)
        : [],
      ...(typeof comp.dataBinding === "string" ? { dataBinding: comp.dataBinding } : {}),
    };
    components.set(cId, element);
  }

  const surface: CanvasSurface = {
    id: surfaceId(raw.id),
    ...(typeof raw.title === "string" ? { title: raw.title } : {}),
    components,
    dataModel: (raw.dataModel ?? {}) as JsonObject,
  };

  return { ok: true, value: surface };
}
