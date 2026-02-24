import { describe, expect, test } from "bun:test";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserTabFocusTool } from "./tab-focus.js";

describe("browser_tab_focus", () => {
  test("switches to the specified tab", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabFocusTool(driver, "browser", "verified");
    const result = await tool.execute({ tabId: "tab-2" });
    expect(result).toMatchObject({
      tabId: "tab-2",
      url: expect.any(String),
      title: expect.any(String),
    });
  });

  test("rejects missing tabId", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabFocusTool(driver, "browser", "verified");
    const result = await tool.execute({});
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns NOT_FOUND for unknown tab", async () => {
    const driver = createMockDriver({ failWith: "NOT_FOUND" });
    const tool = createBrowserTabFocusTool(driver, "browser", "verified");
    const result = await tool.execute({ tabId: "tab-ghost" });
    expect(result).toMatchObject({ code: "NOT_FOUND" });
  });

  test("rejects non-string tabId", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabFocusTool(driver, "browser", "verified");
    const result = await tool.execute({ tabId: 42 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects timeout below minimum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabFocusTool(driver, "browser", "verified");
    const result = await tool.execute({ tabId: "tab-2", timeout: 50 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects timeout above maximum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabFocusTool(driver, "browser", "verified");
    const result = await tool.execute({ tabId: "tab-2", timeout: 20_000 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });
});
