import { describe, expect, test } from "bun:test";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserNavigateTool } from "./navigate.js";

describe("browser_navigate", () => {
  test("navigates to a URL successfully", async () => {
    const driver = createMockDriver();
    const tool = createBrowserNavigateTool(driver, "browser", "verified");
    const result = await tool.execute({ url: "https://example.com" });
    expect(result).toMatchObject({ url: expect.any(String), title: expect.any(String) });
  });

  test("rejects missing url", async () => {
    const driver = createMockDriver();
    const tool = createBrowserNavigateTool(driver, "browser", "verified");
    const result = await tool.execute({});
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects empty url", async () => {
    const driver = createMockDriver();
    const tool = createBrowserNavigateTool(driver, "browser", "verified");
    const result = await tool.execute({ url: "" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects invalid waitUntil value", async () => {
    const driver = createMockDriver();
    const tool = createBrowserNavigateTool(driver, "browser", "verified");
    const result = await tool.execute({ url: "https://example.com", waitUntil: "ready" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects timeout below minimum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserNavigateTool(driver, "browser", "verified");
    const result = await tool.execute({ url: "https://example.com", timeout: 0 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects timeout above maximum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserNavigateTool(driver, "browser", "verified");
    const result = await tool.execute({ url: "https://example.com", timeout: 999999 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns error on driver failure", async () => {
    const driver = createMockDriver({ failWith: "EXTERNAL" });
    const tool = createBrowserNavigateTool(driver, "browser", "verified");
    const result = await tool.execute({ url: "https://example.com" });
    expect(result).toMatchObject({ code: "EXTERNAL" });
  });
});
