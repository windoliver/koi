import { describe, expect, test } from "bun:test";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserPressTool } from "./press.js";

describe("browser_press", () => {
  test("presses a key successfully", async () => {
    const driver = createMockDriver();
    const tool = createBrowserPressTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ key: "Enter" });
    expect(result).toMatchObject({ success: true });
  });

  test("rejects missing key", async () => {
    const driver = createMockDriver();
    const tool = createBrowserPressTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({});
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects non-string key", async () => {
    const driver = createMockDriver();
    const tool = createBrowserPressTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ key: 13 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects timeout above maximum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserPressTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ key: "Tab", timeout: 99999 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns error on driver failure", async () => {
    const driver = createMockDriver({ failWith: "INTERNAL" });
    const tool = createBrowserPressTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ key: "Escape" });
    expect(result).toMatchObject({ code: "INTERNAL" });
  });

  test("uses custom prefix in tool name", () => {
    const driver = createMockDriver();
    const tool = createBrowserPressTool(driver, "web", DEFAULT_UNSANDBOXED_POLICY);
    expect(tool.descriptor.name).toBe("web_press");
  });

  test("accepts common key names", async () => {
    const driver = createMockDriver();
    const tool = createBrowserPressTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    for (const key of ["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp", "Space"]) {
      const result = await tool.execute({ key });
      expect(result).toMatchObject({ success: true });
    }
  });

  test("accepts key combinations", async () => {
    const driver = createMockDriver();
    const tool = createBrowserPressTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    for (const key of ["Control+a", "Control+c", "Shift+Tab", "Alt+F4", "Meta+k"]) {
      const result = await tool.execute({ key });
      expect(result).toMatchObject({ success: true });
    }
  });
});
