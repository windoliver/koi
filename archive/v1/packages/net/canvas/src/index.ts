/**
 * @koi/canvas — A2UI visual workspace data model.
 *
 * Headless protocol layer implementing Google's A2UI v0.9 specification
 * for agent-generated UIs. Provides types, validation, serialization,
 * and AG-UI event integration for canvas surfaces.
 *
 * @packageDocumentation
 */

export type { CanvasConfig } from "./config.js";
// Config
export { DEFAULT_CANVAS_CONFIG, validateCanvasConfig } from "./config.js";
// Events
export { createCanvasEvent, extractCanvasMessage, isCanvasEvent } from "./events.js";
// Mappers
export {
  mapA2uiComponent,
  mapCanvasElement,
  mapCanvasToCreateSurface,
  mapContentBlockToElement,
  mapCreateSurfaceToCanvas,
  mapElementToContentBlock,
} from "./mappers.js";
// Serialization
export { deserializeSurface, serializeSurface } from "./serialize.js";
// Surface operations
export {
  applyDataModelUpdate,
  applySurfaceUpdate,
  createCanvasSurface,
  getComponent,
} from "./surface.js";
export type {
  A2uiCategory,
  A2uiComponent,
  A2uiComponentType,
  A2uiCreateSurface,
  A2uiDataModelUpdate,
  A2uiDeleteSurface,
  A2uiDisplayType,
  A2uiInputType,
  A2uiLayoutType,
  A2uiMessage,
  A2uiMessageKind,
  A2uiUpdateComponents,
  A2uiUpdateDataModel,
  CanvasElement,
  CanvasSurface,
  ComponentId,
  SurfaceId,
} from "./types.js";
// Types + branded IDs
export {
  categorizeComponent,
  componentId,
  isA2uiComponentType,
  isA2uiMessageKind,
  surfaceId,
} from "./types.js";
export { validateA2uiMessage, validateCreateSurface } from "./validate-canvas.js";
export type { JsonPointerTokens } from "./validate-data-model.js";
// Validation
export { isValidJsonPointer, parseJsonPointer } from "./validate-data-model.js";
export { validateSurfaceComponents } from "./validate-surface.js";
