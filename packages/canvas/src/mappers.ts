/**
 * Bidirectional mappers between A2UI protocol types and Koi canvas types,
 * plus ContentBlock ↔ CanvasElement conversions.
 */

import type { ContentBlock, JsonObject } from "@koi/core";
import type {
  A2uiComponent,
  A2uiCreateSurface,
  CanvasElement,
  CanvasSurface,
  ComponentId,
} from "./types.js";
import { componentId } from "./types.js";

// ---------------------------------------------------------------------------
// A2UI Component ↔ CanvasElement
// ---------------------------------------------------------------------------

/** Maps an A2UI protocol component to a Koi CanvasElement. */
export function mapA2uiComponent(component: A2uiComponent): CanvasElement {
  return {
    id: component.id,
    type: component.type,
    properties: component.properties ?? {},
    children: component.children ?? [],
    ...(component.dataBinding !== undefined ? { dataBinding: component.dataBinding } : {}),
  };
}

/** Maps a Koi CanvasElement back to an A2UI protocol component. */
export function mapCanvasElement(element: CanvasElement): A2uiComponent {
  return {
    id: element.id,
    type: element.type,
    ...(Object.keys(element.properties).length > 0 ? { properties: element.properties } : {}),
    ...(element.children.length > 0 ? { children: element.children } : {}),
    ...(element.dataBinding !== undefined ? { dataBinding: element.dataBinding } : {}),
  };
}

// ---------------------------------------------------------------------------
// ContentBlock ↔ CanvasElement
// ---------------------------------------------------------------------------

/**
 * Maps a ContentBlock (custom kind with A2UI data) to a CanvasElement.
 * Returns undefined if the block is not a canvas-compatible custom block.
 */
export function mapContentBlockToElement(block: ContentBlock): CanvasElement | undefined {
  if (block.kind !== "custom" || block.type !== "a2ui:component") return undefined;

  const data = block.data as {
    readonly id?: string;
    readonly type?: string;
    readonly properties?: JsonObject;
    readonly children?: readonly string[];
    readonly dataBinding?: string;
  };

  if (typeof data.id !== "string" || typeof data.type !== "string") return undefined;

  return {
    id: componentId(data.id),
    type: data.type as CanvasElement["type"],
    properties: data.properties ?? {},
    children: (data.children ?? []).map(componentId),
    ...(data.dataBinding !== undefined ? { dataBinding: data.dataBinding } : {}),
  };
}

/** Maps a CanvasElement to a ContentBlock (custom kind). */
export function mapElementToContentBlock(element: CanvasElement): ContentBlock {
  return {
    kind: "custom",
    type: "a2ui:component",
    data: {
      id: element.id as string,
      type: element.type,
      properties: element.properties,
      children: element.children.map((c) => c as string),
      ...(element.dataBinding !== undefined ? { dataBinding: element.dataBinding } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// createSurface ↔ CanvasSurface
// ---------------------------------------------------------------------------

/** Maps an A2UI createSurface message to a Koi CanvasSurface. */
export function mapCreateSurfaceToCanvas(msg: A2uiCreateSurface): CanvasSurface {
  const components = new Map<ComponentId, CanvasElement>();
  for (const comp of msg.components) {
    const element = mapA2uiComponent(comp);
    components.set(element.id, element);
  }

  return {
    id: msg.surfaceId,
    ...(msg.title !== undefined ? { title: msg.title } : {}),
    components,
    dataModel: msg.dataModel ?? {},
  };
}

/** Maps a Koi CanvasSurface back to an A2UI createSurface message. */
export function mapCanvasToCreateSurface(surface: CanvasSurface): A2uiCreateSurface {
  const components: A2uiComponent[] = [];
  for (const element of surface.components.values()) {
    components.push(mapCanvasElement(element));
  }

  return {
    kind: "createSurface",
    surfaceId: surface.id,
    ...(surface.title !== undefined ? { title: surface.title } : {}),
    components,
    ...(Object.keys(surface.dataModel).length > 0 ? { dataModel: surface.dataModel } : {}),
  };
}
