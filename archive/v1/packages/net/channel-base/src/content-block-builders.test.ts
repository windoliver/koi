/**
 * Tests for ContentBlock builder utilities.
 *
 * Verifies correct shapes including optional-field handling required by
 * exactOptionalPropertyTypes (fields are omitted rather than set to undefined).
 */

import { describe, expect, test } from "bun:test";
import { button, custom, file, image, text } from "./content-block-builders.js";

describe("text()", () => {
  test("returns a TextBlock with correct text", () => {
    expect(text("hello")).toEqual({ kind: "text", text: "hello" });
  });

  test("returns a TextBlock for empty string", () => {
    expect(text("")).toEqual({ kind: "text", text: "" });
  });
});

describe("file()", () => {
  test("returns a FileBlock with url, mimeType, and name", () => {
    expect(file("https://example.com/r.pdf", "application/pdf", "r.pdf")).toEqual({
      kind: "file",
      url: "https://example.com/r.pdf",
      mimeType: "application/pdf",
      name: "r.pdf",
    });
  });

  test("omits name when not provided (exactOptionalPropertyTypes compliance)", () => {
    const result = file("https://example.com/r.pdf", "application/pdf");
    expect(result).toEqual({
      kind: "file",
      url: "https://example.com/r.pdf",
      mimeType: "application/pdf",
    });
    expect("name" in result).toBe(false);
  });
});

describe("image()", () => {
  test("returns an ImageBlock with url and alt", () => {
    expect(image("https://example.com/cat.png", "a cat")).toEqual({
      kind: "image",
      url: "https://example.com/cat.png",
      alt: "a cat",
    });
  });

  test("omits alt when not provided (exactOptionalPropertyTypes compliance)", () => {
    const result = image("https://example.com/cat.png");
    expect(result).toEqual({ kind: "image", url: "https://example.com/cat.png" });
    expect("alt" in result).toBe(false);
  });
});

describe("button()", () => {
  test("returns a ButtonBlock with label, action, and payload", () => {
    expect(button("Click", "submit", { id: 1 })).toEqual({
      kind: "button",
      label: "Click",
      action: "submit",
      payload: { id: 1 },
    });
  });

  test("omits payload when not provided (exactOptionalPropertyTypes compliance)", () => {
    const result = button("Click", "submit");
    expect(result).toEqual({ kind: "button", label: "Click", action: "submit" });
    expect("payload" in result).toBe(false);
  });
});

describe("custom()", () => {
  test("returns a CustomBlock with type and data", () => {
    expect(custom("chart", { x: 1 })).toEqual({ kind: "custom", type: "chart", data: { x: 1 } });
  });

  test("accepts null data", () => {
    expect(custom("empty", null)).toEqual({ kind: "custom", type: "empty", data: null });
  });
});
