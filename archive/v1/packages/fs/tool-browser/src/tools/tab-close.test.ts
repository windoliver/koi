import { describe, expect, test } from "bun:test";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserTabCloseTool } from "./tab-close.js";

describe("browser_tab_close", () => {
  test("closes current tab when no tabId provided", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabCloseTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({});
    expect(result).toMatchObject({ success: true });
  });

  test("closes specific tab by tabId", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabCloseTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ tabId: "tab-2" });
    expect(result).toMatchObject({ success: true });
  });

  test("rejects non-string tabId", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabCloseTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ tabId: 42 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns NOT_FOUND for unknown tabId", async () => {
    const driver = createMockDriver({ failWith: "NOT_FOUND" });
    const tool = createBrowserTabCloseTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ tabId: "tab-nonexistent" });
    expect(result).toMatchObject({ code: "NOT_FOUND" });
  });

  test("rejects timeout below minimum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabCloseTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ timeout: 50 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects timeout above maximum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTabCloseTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ timeout: 20_000 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });
});
