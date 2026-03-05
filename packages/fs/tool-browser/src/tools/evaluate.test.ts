import { describe, expect, test } from "bun:test";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { EVALUATE_POLICY } from "../constants.js";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserEvaluateTool } from "./evaluate.js";

describe("browser_evaluate", () => {
  test("uses promoted trust tier", () => {
    const driver = createMockDriver();
    const tool = createBrowserEvaluateTool(driver, "browser", EVALUATE_POLICY);
    expect(tool.policy.sandbox).toBe(false);
  });

  test("executes script and returns value", async () => {
    const driver = createMockDriver();
    const tool = createBrowserEvaluateTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ script: "document.title" });
    expect(result).toMatchObject({ value: expect.anything() });
  });

  test("rejects missing script", async () => {
    const driver = createMockDriver();
    const tool = createBrowserEvaluateTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({});
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects empty script", async () => {
    const driver = createMockDriver();
    const tool = createBrowserEvaluateTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ script: "" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects timeout above maximum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserEvaluateTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ script: "1+1", timeout: 99999 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns error on driver failure", async () => {
    const driver = createMockDriver({ failWith: "INTERNAL" });
    const tool = createBrowserEvaluateTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ script: "throw new Error()" });
    expect(result).toMatchObject({ code: "INTERNAL" });
  });
});
