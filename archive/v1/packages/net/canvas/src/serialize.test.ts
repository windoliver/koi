import { describe, expect, test } from "bun:test";
import { deserializeSurface, serializeSurface } from "./serialize.js";
import type { CanvasElement, CanvasSurface } from "./types.js";
import { componentId, surfaceId } from "./types.js";

function makeSurface(overrides?: Partial<CanvasSurface>): CanvasSurface {
  return {
    id: surfaceId("s1"),
    components: new Map<ReturnType<typeof componentId>, CanvasElement>(),
    dataModel: {},
    ...overrides,
  };
}

describe("serializeSurface", () => {
  test("serializes empty surface to JSON", () => {
    const json = serializeSurface(makeSurface());
    const parsed = JSON.parse(json);
    expect(parsed.id).toBe("s1");
    expect(parsed.components).toEqual([]);
    expect(parsed.dataModel).toEqual({});
  });

  test("serializes surface with components", () => {
    const components = new Map<ReturnType<typeof componentId>, CanvasElement>([
      [
        componentId("c1"),
        {
          id: componentId("c1"),
          type: "Text",
          properties: { text: "hello" },
          children: [],
        },
      ],
    ]);
    const json = serializeSurface(makeSurface({ components }));
    const parsed = JSON.parse(json);
    expect(parsed.components).toHaveLength(1);
    expect(parsed.components[0].id).toBe("c1");
    expect(parsed.components[0].properties.text).toBe("hello");
  });

  test("serializes surface with title", () => {
    const json = serializeSurface(makeSurface({ title: "My Surface" }));
    const parsed = JSON.parse(json);
    expect(parsed.title).toBe("My Surface");
  });

  test("omits title when undefined", () => {
    const json = serializeSurface(makeSurface());
    const parsed = JSON.parse(json);
    expect(parsed.title).toBeUndefined();
  });
});

describe("deserializeSurface", () => {
  test("deserializes valid JSON to CanvasSurface", () => {
    const json = JSON.stringify({
      id: "s1",
      components: [{ id: "c1", type: "Text", properties: { text: "hi" } }],
      dataModel: { key: "val" },
    });
    const result = deserializeSurface(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.id).toBe(surfaceId("s1"));
      expect(result.value.components.size).toBe(1);
      expect(result.value.dataModel).toEqual({ key: "val" });
    }
  });

  test("returns error for invalid JSON", () => {
    const result = deserializeSurface("not json");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("returns error for non-object JSON", () => {
    const result = deserializeSurface('"just a string"');
    expect(result.ok).toBe(false);
  });

  test("returns error for missing id", () => {
    const result = deserializeSurface(JSON.stringify({ components: [] }));
    expect(result.ok).toBe(false);
  });

  test("returns error for missing components array", () => {
    const result = deserializeSurface(JSON.stringify({ id: "s1" }));
    expect(result.ok).toBe(false);
  });

  test("returns error for invalid component", () => {
    const result = deserializeSurface(JSON.stringify({ id: "s1", components: [{ nope: true }] }));
    expect(result.ok).toBe(false);
  });

  test("deserializes surface with data binding", () => {
    const json = JSON.stringify({
      id: "s1",
      components: [{ id: "c1", type: "TextField", dataBinding: "/name" }],
    });
    const result = deserializeSurface(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const comp = result.value.components.get(componentId("c1"));
      expect(comp?.dataBinding).toBe("/name");
    }
  });

  test("deserializes surface with title", () => {
    const json = JSON.stringify({
      id: "s1",
      title: "Test",
      components: [],
    });
    const result = deserializeSurface(json);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.title).toBe("Test");
  });
});

describe("round-trip serialization", () => {
  test("serialize → deserialize preserves surface data", () => {
    const original = makeSurface({
      title: "Round Trip",
      components: new Map([
        [
          componentId("c1"),
          {
            id: componentId("c1"),
            type: "Row" as const,
            properties: {},
            children: [componentId("c2")],
          },
        ],
        [
          componentId("c2"),
          {
            id: componentId("c2"),
            type: "Text" as const,
            properties: { text: "inside row" },
            children: [],
            dataBinding: "/content",
          },
        ],
      ]),
      dataModel: { content: "hello" },
    });

    const json = serializeSurface(original);
    const result = deserializeSurface(json);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const s = result.value;
      expect(s.id).toBe(original.id);
      expect(s.title).toBe("Round Trip");
      expect(s.components.size).toBe(2);
      expect(s.dataModel).toEqual({ content: "hello" });

      const c1 = s.components.get(componentId("c1"));
      expect(c1?.children).toEqual([componentId("c2")]);

      const c2 = s.components.get(componentId("c2"));
      expect(c2?.dataBinding).toBe("/content");
    }
  });

  test("empty surface round-trips", () => {
    const original = makeSurface();
    const json = serializeSurface(original);
    const result = deserializeSurface(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.components.size).toBe(0);
      expect(result.value.dataModel).toEqual({});
    }
  });

  test("surface with data model round-trips", () => {
    const original = makeSurface({
      dataModel: { users: [1, 2, 3], config: { theme: "dark" } },
    });
    const json = serializeSurface(original);
    const result = deserializeSurface(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.dataModel).toEqual({
        users: [1, 2, 3],
        config: { theme: "dark" },
      });
    }
  });
});
