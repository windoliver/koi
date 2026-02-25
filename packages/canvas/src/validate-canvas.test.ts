import { describe, expect, test } from "bun:test";
import { validateA2uiMessage, validateCreateSurface } from "./validate-canvas.js";

describe("validateA2uiMessage", () => {
  test("accepts valid createSurface message", () => {
    const result = validateA2uiMessage({
      kind: "createSurface",
      surfaceId: "s1",
      components: [{ id: "c1", type: "Text" }],
    });
    expect(result.ok).toBe(true);
  });

  test("accepts valid deleteSurface message", () => {
    const result = validateA2uiMessage({
      kind: "deleteSurface",
      surfaceId: "s1",
    });
    expect(result.ok).toBe(true);
  });

  test("accepts valid updateDataModel message", () => {
    const result = validateA2uiMessage({
      kind: "updateDataModel",
      surfaceId: "s1",
      updates: [{ pointer: "/name", value: "test" }],
    });
    expect(result.ok).toBe(true);
  });

  test("rejects message with invalid kind", () => {
    const result = validateA2uiMessage({
      kind: "unknownKind",
      surfaceId: "s1",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects message with empty surfaceId", () => {
    const result = validateA2uiMessage({
      kind: "deleteSurface",
      surfaceId: "",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects message with invalid component type", () => {
    const result = validateA2uiMessage({
      kind: "createSurface",
      surfaceId: "s1",
      components: [{ id: "c1", type: "InvalidType" }],
    });
    expect(result.ok).toBe(false);
  });
});

describe("validateCreateSurface", () => {
  test("accepts valid surface with data binding", () => {
    const result = validateCreateSurface({
      kind: "createSurface",
      surfaceId: "s1",
      components: [{ id: "c1", type: "TextField", dataBinding: "/name" }],
      dataModel: { name: "test" },
    });
    expect(result.ok).toBe(true);
  });

  test("rejects surface with invalid data binding pointer", () => {
    const result = validateCreateSurface({
      kind: "createSurface",
      surfaceId: "s1",
      components: [{ id: "c1", type: "TextField", dataBinding: "invalid" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("data binding");
    }
  });

  test("rejects surface with duplicate component IDs", () => {
    const result = validateCreateSurface({
      kind: "createSurface",
      surfaceId: "s1",
      components: [
        { id: "c1", type: "Text" },
        { id: "c1", type: "Button" },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Duplicate");
    }
  });

  test("respects custom config for component limit", () => {
    const result = validateCreateSurface(
      {
        kind: "createSurface",
        surfaceId: "s1",
        components: [
          { id: "c1", type: "Text" },
          { id: "c2", type: "Text" },
          { id: "c3", type: "Text" },
        ],
      },
      { maxComponents: 2 },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("exceeds maximum");
    }
  });
});
