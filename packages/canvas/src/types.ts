/**
 * A2UI v0.9 types + Koi canvas types with branded IDs.
 */

import type { JsonObject } from "@koi/core";

// ---------------------------------------------------------------------------
// Branded IDs
// ---------------------------------------------------------------------------

declare const __surfaceBrand: unique symbol;

/** Branded string type for canvas surface identifiers. */
export type SurfaceId = string & { readonly [__surfaceBrand]: "SurfaceId" };

declare const __componentIdBrand: unique symbol;

/** Branded string type for A2UI component identifiers. */
export type ComponentId = string & { readonly [__componentIdBrand]: "ComponentId" };

/** Create a branded SurfaceId from a plain string. */
export function surfaceId(id: string): SurfaceId {
  return id as SurfaceId;
}

/** Create a branded ComponentId from a plain string. */
export function componentId(id: string): ComponentId {
  return id as ComponentId;
}

// ---------------------------------------------------------------------------
// A2UI Component Catalog (v0.9)
// ---------------------------------------------------------------------------

/** Layout component types. */
export type A2uiLayoutType = "Row" | "Column" | "List" | "Card" | "Tabs" | "Modal";

/** Display component types. */
export type A2uiDisplayType = "Text" | "Image" | "Icon" | "Video" | "AudioPlayer" | "Divider";

/** Input component types. */
export type A2uiInputType =
  | "TextField"
  | "CheckBox"
  | "DateTimeInput"
  | "ChoicePicker"
  | "Slider"
  | "Button";

/** All A2UI v0.9 component types. */
export type A2uiComponentType = A2uiLayoutType | A2uiDisplayType | A2uiInputType;

/** A2UI v0.9 component categories. */
export type A2uiCategory = "layout" | "display" | "input";

/** Set of layout component types for type guards. */
const LAYOUT_TYPES: ReadonlySet<string> = new Set<A2uiLayoutType>([
  "Row",
  "Column",
  "List",
  "Card",
  "Tabs",
  "Modal",
]);

/** Set of display component types for type guards. */
const DISPLAY_TYPES: ReadonlySet<string> = new Set<A2uiDisplayType>([
  "Text",
  "Image",
  "Icon",
  "Video",
  "AudioPlayer",
  "Divider",
]);

/** Set of input component types for type guards. */
const INPUT_TYPES: ReadonlySet<string> = new Set<A2uiInputType>([
  "TextField",
  "CheckBox",
  "DateTimeInput",
  "ChoicePicker",
  "Slider",
  "Button",
]);

/** All valid A2UI component type strings. */
const ALL_COMPONENT_TYPES: ReadonlySet<string> = new Set<string>([
  ...LAYOUT_TYPES,
  ...DISPLAY_TYPES,
  ...INPUT_TYPES,
]);

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Returns true if the value is a valid A2UI component type string. */
export function isA2uiComponentType(value: unknown): value is A2uiComponentType {
  return typeof value === "string" && ALL_COMPONENT_TYPES.has(value);
}

/** Returns the category of an A2UI component type. */
export function categorizeComponent(type: A2uiComponentType): A2uiCategory {
  if (LAYOUT_TYPES.has(type)) return "layout";
  if (DISPLAY_TYPES.has(type)) return "display";
  return "input";
}

// ---------------------------------------------------------------------------
// A2UI Component (raw protocol)
// ---------------------------------------------------------------------------

/** A single A2UI component as it appears in protocol messages. */
export interface A2uiComponent {
  readonly id: ComponentId;
  readonly type: A2uiComponentType;
  readonly properties?: JsonObject;
  readonly children?: readonly ComponentId[];
  readonly dataBinding?: string;
}

// ---------------------------------------------------------------------------
// A2UI Messages (discriminated by `kind`)
// ---------------------------------------------------------------------------

export interface A2uiCreateSurface {
  readonly kind: "createSurface";
  readonly surfaceId: SurfaceId;
  readonly title?: string;
  readonly components: readonly A2uiComponent[];
  readonly dataModel?: JsonObject;
}

export interface A2uiUpdateComponents {
  readonly kind: "updateComponents";
  readonly surfaceId: SurfaceId;
  readonly components: readonly A2uiComponent[];
}

export interface A2uiDataModelUpdate {
  readonly pointer: string;
  readonly value: unknown;
}

export interface A2uiUpdateDataModel {
  readonly kind: "updateDataModel";
  readonly surfaceId: SurfaceId;
  readonly updates: readonly A2uiDataModelUpdate[];
}

export interface A2uiDeleteSurface {
  readonly kind: "deleteSurface";
  readonly surfaceId: SurfaceId;
}

/** All A2UI message types. */
export type A2uiMessage =
  | A2uiCreateSurface
  | A2uiUpdateComponents
  | A2uiUpdateDataModel
  | A2uiDeleteSurface;

/** All A2UI message kinds. */
export type A2uiMessageKind = A2uiMessage["kind"];

/** Type guard for A2UI message kind. */
export function isA2uiMessageKind(value: unknown): value is A2uiMessageKind {
  return (
    value === "createSurface" ||
    value === "updateComponents" ||
    value === "updateDataModel" ||
    value === "deleteSurface"
  );
}

// ---------------------------------------------------------------------------
// Koi Canvas types (public API)
// ---------------------------------------------------------------------------

/** A canvas element — the Koi representation of an A2UI component. */
export interface CanvasElement {
  readonly id: ComponentId;
  readonly type: A2uiComponentType;
  readonly properties: JsonObject;
  readonly children: readonly ComponentId[];
  readonly dataBinding?: string;
}

/** A canvas surface — the Koi representation of an A2UI surface. */
export interface CanvasSurface {
  readonly id: SurfaceId;
  readonly title?: string;
  readonly components: ReadonlyMap<ComponentId, CanvasElement>;
  readonly dataModel: JsonObject;
}
