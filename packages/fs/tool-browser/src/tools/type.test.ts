import { describe, expect, test } from "bun:test";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserTypeTool } from "./type.js";

describe("browser_type", () => {
  test("types text into element successfully", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTypeTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e3", value: "hello@example.com" });
    expect(result).toMatchObject({ success: true });
  });

  test("rejects missing ref", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTypeTool(driver, "browser", "verified");
    const result = await tool.execute({ value: "hello" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects missing value", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTypeTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e3" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects invalid ref format", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTypeTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "input-email", value: "test" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("accepts clear flag", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTypeTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e3", value: "new text", clear: true });
    expect(result).toMatchObject({ success: true });
  });

  test("returns error on driver failure", async () => {
    const driver = createMockDriver({ failWith: "NOT_FOUND" });
    const tool = createBrowserTypeTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e3", value: "hello" });
    expect(result).toMatchObject({ code: "NOT_FOUND" });
  });
});
