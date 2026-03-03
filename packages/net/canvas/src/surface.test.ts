import { describe, expect, test } from "bun:test";
import {
  applyDataModelUpdate,
  applySurfaceUpdate,
  createCanvasSurface,
  getComponent,
} from "./surface.js";
import { componentId, surfaceId } from "./types.js";

describe("createCanvasSurface", () => {
  test("creates an empty surface with given id", () => {
    const surface = createCanvasSurface(surfaceId("s1"));
    expect(surface.id).toBe(surfaceId("s1"));
    expect(surface.components.size).toBe(0);
    expect(surface.dataModel).toEqual({});
    expect(surface.title).toBeUndefined();
  });

  test("creates a surface with optional title", () => {
    const surface = createCanvasSurface(surfaceId("s1"), "My Surface");
    expect(surface.title).toBe("My Surface");
  });
});

describe("applySurfaceUpdate", () => {
  test("adds new components to surface", () => {
    const surface = createCanvasSurface(surfaceId("s1"));
    const updated = applySurfaceUpdate(surface, [
      { id: componentId("c1"), type: "Text" },
      { id: componentId("c2"), type: "Button" },
    ]);
    expect(updated.components.size).toBe(2);
    expect(updated.components.get(componentId("c1"))?.type).toBe("Text");
  });

  test("replaces existing components", () => {
    const surface = createCanvasSurface(surfaceId("s1"));
    const first = applySurfaceUpdate(surface, [
      { id: componentId("c1"), type: "Text", properties: { text: "old" } },
    ]);
    const second = applySurfaceUpdate(first, [
      { id: componentId("c1"), type: "Text", properties: { text: "new" } },
    ]);
    expect(second.components.size).toBe(1);
    expect(second.components.get(componentId("c1"))?.properties).toEqual({ text: "new" });
  });

  test("does not mutate original surface", () => {
    const surface = createCanvasSurface(surfaceId("s1"));
    applySurfaceUpdate(surface, [{ id: componentId("c1"), type: "Text" }]);
    expect(surface.components.size).toBe(0);
  });
});

describe("applyDataModelUpdate", () => {
  test("sets top-level key", () => {
    const surface = createCanvasSurface(surfaceId("s1"));
    const result = applyDataModelUpdate(surface, [{ pointer: "/name", value: "Alice" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dataModel).toEqual({ name: "Alice" });
    }
  });

  test("sets nested key", () => {
    const surface = createCanvasSurface(surfaceId("s1"));
    const result = applyDataModelUpdate(surface, [{ pointer: "/user/name", value: "Bob" }]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dataModel).toEqual({ user: { name: "Bob" } });
    }
  });

  test("applies multiple updates", () => {
    const surface = createCanvasSurface(surfaceId("s1"));
    const result = applyDataModelUpdate(surface, [
      { pointer: "/a", value: 1 },
      { pointer: "/b", value: 2 },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dataModel).toEqual({ a: 1, b: 2 });
    }
  });

  test("returns error for invalid JSON Pointer", () => {
    const surface = createCanvasSurface(surfaceId("s1"));
    const result = applyDataModelUpdate(surface, [{ pointer: "no-slash", value: "bad" }]);
    expect(result.ok).toBe(false);
  });

  test("does not mutate original surface", () => {
    const surface = createCanvasSurface(surfaceId("s1"));
    applyDataModelUpdate(surface, [{ pointer: "/x", value: 42 }]);
    expect(surface.dataModel).toEqual({});
  });
});

describe("getComponent", () => {
  test("returns component by ID", () => {
    const surface = applySurfaceUpdate(createCanvasSurface(surfaceId("s1")), [
      { id: componentId("c1"), type: "Text", properties: { text: "hi" } },
    ]);
    const comp = getComponent(surface, componentId("c1"));
    expect(comp).toBeDefined();
    expect(comp?.type).toBe("Text");
  });

  test("returns undefined for missing component", () => {
    const surface = createCanvasSurface(surfaceId("s1"));
    expect(getComponent(surface, componentId("nope"))).toBeUndefined();
  });
});
