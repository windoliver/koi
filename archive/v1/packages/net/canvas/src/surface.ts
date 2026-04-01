/**
 * Immutable surface operations — create, update components, update data model.
 *
 * All operations return new objects (structural sharing for immutability).
 */

import type { JsonObject, KoiError, Result } from "@koi/core";
import { mapA2uiComponent } from "./mappers.js";
import type {
  A2uiComponent,
  A2uiDataModelUpdate,
  CanvasElement,
  CanvasSurface,
  ComponentId,
  SurfaceId,
} from "./types.js";
import { parseJsonPointer } from "./validate-data-model.js";

/** Creates a new empty CanvasSurface. */
export function createCanvasSurface(id: SurfaceId, title?: string): CanvasSurface {
  return {
    id,
    ...(title !== undefined ? { title } : {}),
    components: new Map<ComponentId, CanvasElement>(),
    dataModel: {},
  };
}

/** Applies component updates to a surface, returning a new surface. */
export function applySurfaceUpdate(
  surface: CanvasSurface,
  components: readonly A2uiComponent[],
): CanvasSurface {
  const updated = new Map(surface.components);
  for (const comp of components) {
    const element = mapA2uiComponent(comp);
    updated.set(element.id, element);
  }
  return { ...surface, components: updated };
}

/**
 * Applies data model updates to a surface, returning a new surface.
 *
 * Each update specifies a JSON Pointer and a new value. Only top-level
 * pointers (e.g., "/name") are supported for immutable updates.
 */
export function applyDataModelUpdate(
  surface: CanvasSurface,
  updates: readonly A2uiDataModelUpdate[],
): Result<CanvasSurface, KoiError> {
  // Build new data model immutably
  const entries = { ...surface.dataModel } as Record<string, unknown>;

  for (const update of updates) {
    const pointerResult = parseJsonPointer(update.pointer);
    if (!pointerResult.ok) return pointerResult;

    const tokens = pointerResult.value;
    if (tokens.length === 0) {
      // Root pointer — replace entire data model
      if (typeof update.value !== "object" || update.value === null) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: "Root pointer update value must be an object",
            retryable: false,
          },
        };
      }
      return {
        ok: true,
        value: { ...surface, dataModel: update.value as JsonObject },
      };
    }

    // Set the value at the first token (top-level key)
    // For nested paths, we'd need recursive immutable update — kept simple for now
    const firstToken = tokens[0];
    if (firstToken === undefined) continue;

    if (tokens.length === 1) {
      entries[firstToken] = update.value;
    } else {
      // Nested path: build nested structure immutably
      let current: Record<string, unknown> = entries;
      for (let i = 0; i < tokens.length - 1; i++) {
        const token = tokens[i];
        if (token === undefined) break;
        const existing = current[token];
        const next =
          typeof existing === "object" && existing !== null
            ? { ...(existing as Record<string, unknown>) }
            : {};
        current[token] = next;
        current = next;
      }
      const lastToken = tokens[tokens.length - 1];
      if (lastToken !== undefined) {
        current[lastToken] = update.value;
      }
    }
  }

  return {
    ok: true,
    value: { ...surface, dataModel: entries as JsonObject },
  };
}

/** Gets a component from a surface by ID. */
export function getComponent(surface: CanvasSurface, id: ComponentId): CanvasElement | undefined {
  return surface.components.get(id);
}
