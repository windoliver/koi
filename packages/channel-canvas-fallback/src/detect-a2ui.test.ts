/**
 * Tests for A2UI block detection and metadata extraction.
 */

import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "@koi/core";
import { extractA2uiBlockInfo, isA2uiBlock } from "./detect-a2ui.js";

describe("isA2uiBlock", () => {
  test("returns true for a2ui:surface custom block", () => {
    const block: ContentBlock = { kind: "custom", type: "a2ui:surface", data: {} };
    expect(isA2uiBlock(block)).toBe(true);
  });

  test("returns true for a2ui:createSurface custom block", () => {
    const block: ContentBlock = { kind: "custom", type: "a2ui:createSurface", data: {} };
    expect(isA2uiBlock(block)).toBe(true);
  });

  test("returns true for a2ui:component custom block", () => {
    const block: ContentBlock = { kind: "custom", type: "a2ui:component", data: {} };
    expect(isA2uiBlock(block)).toBe(true);
  });

  test("returns false for text block", () => {
    const block: ContentBlock = { kind: "text", text: "hello" };
    expect(isA2uiBlock(block)).toBe(false);
  });

  test("returns false for non-a2ui custom block", () => {
    const block: ContentBlock = { kind: "custom", type: "koi:state", data: {} };
    expect(isA2uiBlock(block)).toBe(false);
  });

  test("returns false for image block", () => {
    const block: ContentBlock = { kind: "image", url: "https://example.com/img.png" };
    expect(isA2uiBlock(block)).toBe(false);
  });
});

describe("extractA2uiBlockInfo", () => {
  test("extracts createSurface info", () => {
    const block: ContentBlock = {
      kind: "custom",
      type: "a2ui:createSurface",
      data: { kind: "createSurface", surfaceId: "s1", title: "Dashboard" },
    };
    const info = extractA2uiBlockInfo(block);
    expect(info).toEqual({
      kind: "createSurface",
      surfaceId: "s1",
      title: "Dashboard",
      rawData: { kind: "createSurface", surfaceId: "s1", title: "Dashboard" },
    });
  });

  test("extracts updateComponents info", () => {
    const block: ContentBlock = {
      kind: "custom",
      type: "a2ui:updateComponents",
      data: { kind: "updateComponents", surfaceId: "s2" },
    };
    const info = extractA2uiBlockInfo(block);
    expect(info?.kind).toBe("updateComponents");
    expect(info?.surfaceId).toBe("s2");
    expect(info?.title).toBeUndefined();
    expect(info?.rawData).toEqual({ kind: "updateComponents", surfaceId: "s2" });
  });

  test("extracts updateDataModel info", () => {
    const block: ContentBlock = {
      kind: "custom",
      type: "a2ui:updateDataModel",
      data: { kind: "updateDataModel", surfaceId: "s3" },
    };
    const info = extractA2uiBlockInfo(block);
    expect(info?.kind).toBe("updateDataModel");
    expect(info?.surfaceId).toBe("s3");
    expect(info?.title).toBeUndefined();
    expect(info?.rawData).toEqual({ kind: "updateDataModel", surfaceId: "s3" });
  });

  test("extracts deleteSurface info", () => {
    const block: ContentBlock = {
      kind: "custom",
      type: "a2ui:deleteSurface",
      data: { kind: "deleteSurface", surfaceId: "s4" },
    };
    const info = extractA2uiBlockInfo(block);
    expect(info?.kind).toBe("deleteSurface");
    expect(info?.surfaceId).toBe("s4");
    expect(info?.title).toBeUndefined();
    expect(info?.rawData).toEqual({ kind: "deleteSurface", surfaceId: "s4" });
  });

  test("returns undefined for non-a2ui block", () => {
    const block: ContentBlock = { kind: "text", text: "hello" };
    expect(extractA2uiBlockInfo(block)).toBeUndefined();
  });

  test("returns undefined when data is not an object", () => {
    const block: ContentBlock = { kind: "custom", type: "a2ui:createSurface", data: "not-object" };
    expect(extractA2uiBlockInfo(block)).toBeUndefined();
  });

  test("returns undefined when data is null", () => {
    const block: ContentBlock = { kind: "custom", type: "a2ui:createSurface", data: null };
    expect(extractA2uiBlockInfo(block)).toBeUndefined();
  });

  test("returns undefined when kind is missing from data", () => {
    const block: ContentBlock = {
      kind: "custom",
      type: "a2ui:createSurface",
      data: { surfaceId: "s1" },
    };
    expect(extractA2uiBlockInfo(block)).toBeUndefined();
  });

  test("returns undefined when kind is unknown", () => {
    const block: ContentBlock = {
      kind: "custom",
      type: "a2ui:unknown",
      data: { kind: "unknownKind", surfaceId: "s1" },
    };
    expect(extractA2uiBlockInfo(block)).toBeUndefined();
  });

  test("returns undefined when surfaceId is missing", () => {
    const block: ContentBlock = {
      kind: "custom",
      type: "a2ui:createSurface",
      data: { kind: "createSurface" },
    };
    expect(extractA2uiBlockInfo(block)).toBeUndefined();
  });

  test("omits title when it is not a string", () => {
    const block: ContentBlock = {
      kind: "custom",
      type: "a2ui:createSurface",
      data: { kind: "createSurface", surfaceId: "s1", title: 42 },
    };
    const info = extractA2uiBlockInfo(block);
    expect(info?.title).toBeUndefined();
  });
});
