import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "@koi/core";
import {
  mapA2uiComponent,
  mapCanvasElement,
  mapCanvasToCreateSurface,
  mapContentBlockToElement,
  mapCreateSurfaceToCanvas,
  mapElementToContentBlock,
} from "./mappers.js";
import type { A2uiComponent, A2uiCreateSurface, CanvasElement, CanvasSurface } from "./types.js";
import { componentId, surfaceId } from "./types.js";

describe("mapA2uiComponent", () => {
  test("maps component with all fields", () => {
    const input: A2uiComponent = {
      id: componentId("c1"),
      type: "TextField",
      properties: { label: "Name" },
      children: [componentId("c2")],
      dataBinding: "/name",
    };
    const result = mapA2uiComponent(input);
    expect(result.id).toBe(input.id);
    expect(result.type).toBe("TextField");
    expect(result.properties).toEqual({ label: "Name" });
    expect(result.children).toEqual([componentId("c2")]);
    expect(result.dataBinding).toBe("/name");
  });

  test("defaults properties to empty object and children to empty array", () => {
    const input: A2uiComponent = {
      id: componentId("c1"),
      type: "Text",
    };
    const result = mapA2uiComponent(input);
    expect(result.properties).toEqual({});
    expect(result.children).toEqual([]);
    expect(result.dataBinding).toBeUndefined();
  });
});

describe("mapCanvasElement", () => {
  test("maps element back to A2UI component", () => {
    const input: CanvasElement = {
      id: componentId("c1"),
      type: "Button",
      properties: { label: "Submit" },
      children: [],
      dataBinding: "/action",
    };
    const result = mapCanvasElement(input);
    expect(result.id).toBe(input.id);
    expect(result.type).toBe("Button");
    expect(result.dataBinding).toBe("/action");
  });

  test("omits empty properties and children", () => {
    const input: CanvasElement = {
      id: componentId("c1"),
      type: "Divider",
      properties: {},
      children: [],
    };
    const result = mapCanvasElement(input);
    expect(result.properties).toBeUndefined();
    expect(result.children).toBeUndefined();
  });

  test("round-trips: A2UI → CanvasElement → A2UI", () => {
    const original: A2uiComponent = {
      id: componentId("c1"),
      type: "Slider",
      properties: { min: 0, max: 100 },
      children: [componentId("c2")],
      dataBinding: "/value",
    };
    const element = mapA2uiComponent(original);
    const roundTripped = mapCanvasElement(element);
    expect(roundTripped).toEqual(original);
  });
});

describe("mapContentBlockToElement", () => {
  test("maps a2ui:component custom block to CanvasElement", () => {
    const block: ContentBlock = {
      kind: "custom",
      type: "a2ui:component",
      data: { id: "c1", type: "Text", properties: { text: "hi" } },
    };
    const result = mapContentBlockToElement(block);
    expect(result).toBeDefined();
    expect(result?.type).toBe("Text");
    expect(result?.properties).toEqual({ text: "hi" });
  });

  test("returns undefined for non-canvas blocks", () => {
    const block: ContentBlock = { kind: "text", text: "hello" };
    expect(mapContentBlockToElement(block)).toBeUndefined();
  });

  test("returns undefined for custom blocks with wrong type", () => {
    const block: ContentBlock = {
      kind: "custom",
      type: "other:thing",
      data: {},
    };
    expect(mapContentBlockToElement(block)).toBeUndefined();
  });
});

describe("mapElementToContentBlock", () => {
  test("maps CanvasElement to custom ContentBlock", () => {
    const element: CanvasElement = {
      id: componentId("c1"),
      type: "Text",
      properties: { text: "hi" },
      children: [],
    };
    const block = mapElementToContentBlock(element);
    expect(block.kind).toBe("custom");
    expect((block as { readonly type: string }).type).toBe("a2ui:component");
  });

  test("round-trips: CanvasElement → ContentBlock → CanvasElement", () => {
    const original: CanvasElement = {
      id: componentId("c1"),
      type: "CheckBox",
      properties: { checked: false },
      children: [],
      dataBinding: "/agreed",
    };
    const block = mapElementToContentBlock(original);
    const roundTripped = mapContentBlockToElement(block);
    expect(roundTripped).toEqual(original);
  });
});

describe("mapCreateSurfaceToCanvas", () => {
  test("maps createSurface message to CanvasSurface", () => {
    const msg: A2uiCreateSurface = {
      kind: "createSurface",
      surfaceId: surfaceId("s1"),
      title: "My Surface",
      components: [
        { id: componentId("c1"), type: "Text" },
        { id: componentId("c2"), type: "Button" },
      ],
      dataModel: { name: "test" },
    };
    const surface = mapCreateSurfaceToCanvas(msg);
    expect(surface.id).toBe(surfaceId("s1"));
    expect(surface.title).toBe("My Surface");
    expect(surface.components.size).toBe(2);
    expect(surface.dataModel).toEqual({ name: "test" });
  });
});

describe("mapCanvasToCreateSurface", () => {
  test("maps CanvasSurface back to createSurface message", () => {
    const surface: CanvasSurface = {
      id: surfaceId("s1"),
      title: "Test",
      components: new Map([
        [
          componentId("c1"),
          {
            id: componentId("c1"),
            type: "Text",
            properties: { text: "hi" },
            children: [],
          },
        ],
      ]),
      dataModel: { key: "val" },
    };
    const msg = mapCanvasToCreateSurface(surface);
    expect(msg.kind).toBe("createSurface");
    expect(msg.surfaceId).toBe(surfaceId("s1"));
    expect(msg.components.length).toBe(1);
    expect(msg.dataModel).toEqual({ key: "val" });
  });
});
