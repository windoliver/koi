/**
 * Tests for bidirectional Koi ↔ ACP content block mapping.
 */

import { describe, expect, test } from "bun:test";
import { mapAcpContentToKoi, mapKoiContentToAcp } from "./content-map.js";

// ---------------------------------------------------------------------------
// Koi → ACP
// ---------------------------------------------------------------------------

describe("mapKoiContentToAcp", () => {
  test("maps TextBlock to TextContent", () => {
    const result = mapKoiContentToAcp([{ kind: "text", text: "hello" }]);
    expect(result).toEqual([{ type: "text", text: "hello" }]);
  });

  test("maps FileBlock to ResourceLinkContent", () => {
    const result = mapKoiContentToAcp([
      { kind: "file", url: "file:///foo.ts", mimeType: "text/typescript" },
    ]);
    expect(result).toEqual([
      { type: "resourceLink", uri: "file:///foo.ts", mimeType: "text/typescript" },
    ]);
  });

  test("maps ImageBlock to text placeholder (lossy)", () => {
    const result = mapKoiContentToAcp([
      { kind: "image", url: "https://example.com/img.png", alt: "screenshot" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("text");
    if (result[0]?.type === "text") {
      expect(result[0].text).toContain("screenshot");
    }
  });

  test("maps ImageBlock without alt to URL placeholder", () => {
    const result = mapKoiContentToAcp([{ kind: "image", url: "https://example.com/img.png" }]);
    expect(result).toHaveLength(1);
    if (result[0]?.type === "text") {
      expect(result[0].text).toContain("https://example.com/img.png");
    }
  });

  test("skips ButtonBlock silently", () => {
    const result = mapKoiContentToAcp([{ kind: "button", label: "Click me", action: "confirm" }]);
    expect(result).toEqual([]);
  });

  test("skips CustomBlock silently", () => {
    const result = mapKoiContentToAcp([{ kind: "custom", type: "widget", data: { x: 1 } }]);
    expect(result).toEqual([]);
  });

  test("returns empty array for empty input", () => {
    expect(mapKoiContentToAcp([])).toEqual([]);
  });

  test("handles mixed blocks, preserving order", () => {
    const result = mapKoiContentToAcp([
      { kind: "text", text: "A" },
      { kind: "button", label: "X", action: "y" },
      { kind: "text", text: "B" },
      { kind: "file", url: "file:///a.ts", mimeType: "text/plain" },
    ]);
    expect(result).toHaveLength(3);
    expect(result[0]?.type).toBe("text");
    expect(result[1]?.type).toBe("text");
    expect(result[2]?.type).toBe("resourceLink");
  });
});

// ---------------------------------------------------------------------------
// ACP → Koi
// ---------------------------------------------------------------------------

describe("mapAcpContentToKoi", () => {
  test("maps TextContent to TextBlock", () => {
    const result = mapAcpContentToKoi([{ type: "text", text: "hello" }]);
    expect(result).toEqual([{ kind: "text", text: "hello" }]);
  });

  test("maps ImageContent to ImageBlock with data URI", () => {
    const result = mapAcpContentToKoi([{ type: "image", mimeType: "image/png", data: "abc123" }]);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("image");
    if (result[0]?.kind === "image") {
      expect(result[0].url).toBe("data:image/png;base64,abc123");
    }
  });

  test("maps ResourceLinkContent to FileBlock", () => {
    const result = mapAcpContentToKoi([
      { type: "resourceLink", uri: "file:///foo.ts", mimeType: "text/plain" },
    ]);
    expect(result).toEqual([{ kind: "file", url: "file:///foo.ts", mimeType: "text/plain" }]);
  });

  test("maps EmbeddedResourceContent to CustomBlock", () => {
    const result = mapAcpContentToKoi([
      { type: "resource", uri: "file:///bar.ts", mimeType: "text/plain", text: "content" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("custom");
    if (result[0]?.kind === "custom") {
      expect(result[0].type).toBe("acp:embedded_resource");
      const data = result[0].data as { uri: string; text: string };
      expect(data.uri).toBe("file:///bar.ts");
      expect(data.text).toBe("content");
    }
  });

  test("returns empty array for empty input", () => {
    expect(mapAcpContentToKoi([])).toEqual([]);
  });
});
