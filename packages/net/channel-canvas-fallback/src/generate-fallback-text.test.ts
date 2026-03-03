/**
 * Tests for fallback text generation.
 */

import { describe, expect, test } from "bun:test";
import type { A2uiBlockInfo } from "./detect-a2ui.js";
import { generateDegradedText, generateSuccessText } from "./generate-fallback-text.js";

const BASE_URL = "http://localhost:3000/gateway/canvas/s1";

describe("generateSuccessText", () => {
  test("createSurface with title", () => {
    const info: A2uiBlockInfo = {
      kind: "createSurface",
      surfaceId: "s1",
      title: "Dashboard",
      rawData: {},
    };
    const result = generateSuccessText(info, BASE_URL);
    expect(result).toEqual({ kind: "text", text: `[Surface] Dashboard: ${BASE_URL}` });
  });

  test("createSurface without title uses surfaceId", () => {
    const info: A2uiBlockInfo = { kind: "createSurface", surfaceId: "s1", rawData: {} };
    const result = generateSuccessText(info, BASE_URL);
    expect(result).toEqual({ kind: "text", text: `[Surface] s1: ${BASE_URL}` });
  });

  test("updateComponents", () => {
    const info: A2uiBlockInfo = {
      kind: "updateComponents",
      surfaceId: "s1",
      title: "Form",
      rawData: {},
    };
    const result = generateSuccessText(info, BASE_URL);
    expect(result).toEqual({ kind: "text", text: `[Updated] Form: ${BASE_URL}` });
  });

  test("updateDataModel", () => {
    const info: A2uiBlockInfo = { kind: "updateDataModel", surfaceId: "s1", rawData: {} };
    const result = generateSuccessText(info, BASE_URL);
    expect(result).toEqual({ kind: "text", text: `[Data updated] s1: ${BASE_URL}` });
  });

  test("deleteSurface", () => {
    const info: A2uiBlockInfo = {
      kind: "deleteSurface",
      surfaceId: "s1",
      title: "Old",
      rawData: {},
    };
    const result = generateSuccessText(info, "");
    expect(result).toEqual({ kind: "text", text: "[Removed] Old" });
  });

  test("unknown kind falls back to [Surface]", () => {
    const info: A2uiBlockInfo = { kind: "futureKind", surfaceId: "s1", rawData: {} };
    const result = generateSuccessText(info, BASE_URL);
    expect(result).toEqual({ kind: "text", text: `[Surface] s1: ${BASE_URL}` });
  });
});

describe("generateDegradedText", () => {
  test("includes warning prefix and error message", () => {
    const info: A2uiBlockInfo = {
      kind: "createSurface",
      surfaceId: "s1",
      title: "Dashboard",
      rawData: {},
    };
    const result = generateDegradedText(info, "Gateway unreachable");
    expect(result).toEqual({
      kind: "text",
      text: '[Warning] Could not render surface "Dashboard": Gateway unreachable',
    });
  });

  test("uses surfaceId when title is absent", () => {
    const info: A2uiBlockInfo = { kind: "createSurface", surfaceId: "s1", rawData: {} };
    const result = generateDegradedText(info, "timeout");
    expect(result).toEqual({
      kind: "text",
      text: '[Warning] Could not render surface "s1": timeout',
    });
  });
});
