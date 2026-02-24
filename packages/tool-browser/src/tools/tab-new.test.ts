import { describe, expect, test } from "bun:test";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserTabNewTool } from "./tab-new.js";

describe("browser_tab_new", () => {
  test("opens a new blank tab", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabNewTool(driver, "browser", "verified");
    const result = await tool.execute({});
    expect(result).toMatchObject({
      tabId: expect.any(String),
      url: expect.any(String),
      title: expect.any(String),
    });
  });

  test("opens a new tab with URL", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabNewTool(driver, "browser", "verified");
    const result = await tool.execute({ url: "https://example.com" });
    expect(result).toMatchObject({ tabId: expect.any(String) });
  });

  test("rejects non-string url", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabNewTool(driver, "browser", "verified");
    const result = await tool.execute({ url: 42 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns error on driver failure", async () => {
    const driver = createMockDriver({ failWith: "INTERNAL" });
    const tool = createBrowserTabNewTool(driver, "browser", "verified");
    const result = await tool.execute({});
    expect(result).toMatchObject({ code: "INTERNAL" });
  });

  test("rejects timeout below minimum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabNewTool(driver, "browser", "verified");
    const result = await tool.execute({ timeout: 500 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects timeout above maximum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabNewTool(driver, "browser", "verified");
    const result = await tool.execute({ timeout: 120_000 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });
});
