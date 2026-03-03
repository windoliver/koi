import { describe, expect, test } from "bun:test";
import {
  categorizeComponent,
  componentId,
  isA2uiComponentType,
  isA2uiMessageKind,
  surfaceId,
} from "./types.js";

describe("surfaceId", () => {
  test("creates a branded SurfaceId from a plain string", () => {
    const id = surfaceId("surface-1");
    expect(id as string).toBe("surface-1");
  });
});

describe("componentId", () => {
  test("creates a branded ComponentId from a plain string", () => {
    const id = componentId("comp-1");
    expect(id as string).toBe("comp-1");
  });
});

describe("isA2uiComponentType", () => {
  test("returns true for valid layout types", () => {
    expect(isA2uiComponentType("Row")).toBe(true);
    expect(isA2uiComponentType("Column")).toBe(true);
    expect(isA2uiComponentType("Modal")).toBe(true);
  });

  test("returns true for valid display types", () => {
    expect(isA2uiComponentType("Text")).toBe(true);
    expect(isA2uiComponentType("Image")).toBe(true);
  });

  test("returns true for valid input types", () => {
    expect(isA2uiComponentType("TextField")).toBe(true);
    expect(isA2uiComponentType("Button")).toBe(true);
  });

  test("returns false for invalid strings", () => {
    expect(isA2uiComponentType("Nonexistent")).toBe(false);
    expect(isA2uiComponentType("")).toBe(false);
    expect(isA2uiComponentType(42)).toBe(false);
    expect(isA2uiComponentType(null)).toBe(false);
  });
});

describe("categorizeComponent", () => {
  test("categorizes layout components", () => {
    expect(categorizeComponent("Row")).toBe("layout");
    expect(categorizeComponent("Card")).toBe("layout");
  });

  test("categorizes display components", () => {
    expect(categorizeComponent("Text")).toBe("display");
    expect(categorizeComponent("Divider")).toBe("display");
  });

  test("categorizes input components", () => {
    expect(categorizeComponent("Button")).toBe("input");
    expect(categorizeComponent("Slider")).toBe("input");
  });
});

describe("isA2uiMessageKind", () => {
  test("returns true for valid message kinds", () => {
    expect(isA2uiMessageKind("createSurface")).toBe(true);
    expect(isA2uiMessageKind("updateComponents")).toBe(true);
    expect(isA2uiMessageKind("updateDataModel")).toBe(true);
    expect(isA2uiMessageKind("deleteSurface")).toBe(true);
  });

  test("returns false for invalid values", () => {
    expect(isA2uiMessageKind("unknown")).toBe(false);
    expect(isA2uiMessageKind(123)).toBe(false);
  });
});
