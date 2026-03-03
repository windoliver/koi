import { describe, expect, test } from "bun:test";
import {
  ASK_GUIDE_TOOL_DESCRIPTOR,
  createAskGuideProvider,
  createAskGuideTool,
  createRetrieverSearch,
  DEFAULT_MAX_RESULTS,
  DEFAULT_MAX_TOKENS,
} from "../index.js";

describe("@koi/tool-ask-guide API surface", () => {
  test("exports createAskGuideTool factory", () => {
    expect(typeof createAskGuideTool).toBe("function");
  });

  test("exports createAskGuideProvider factory", () => {
    expect(typeof createAskGuideProvider).toBe("function");
  });

  test("exports ASK_GUIDE_TOOL_DESCRIPTOR", () => {
    expect(ASK_GUIDE_TOOL_DESCRIPTOR).toBeDefined();
    expect(ASK_GUIDE_TOOL_DESCRIPTOR.name).toBe("ask_guide");
  });

  test("exports DEFAULT_MAX_TOKENS constant", () => {
    expect(typeof DEFAULT_MAX_TOKENS).toBe("number");
    expect(DEFAULT_MAX_TOKENS).toBe(500);
  });

  test("exports DEFAULT_MAX_RESULTS constant", () => {
    expect(typeof DEFAULT_MAX_RESULTS).toBe("number");
    expect(DEFAULT_MAX_RESULTS).toBe(10);
  });

  test("exports createRetrieverSearch adapter", () => {
    expect(typeof createRetrieverSearch).toBe("function");
  });
});
