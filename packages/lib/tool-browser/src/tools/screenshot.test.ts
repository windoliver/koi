import { describe, expect, test } from "bun:test";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserScreenshotTool } from "./screenshot.js";

describe("browser_screenshot", () => {
  test("captures viewport screenshot by default", async () => {
    const driver = createMockDriver();
    const tool = createBrowserScreenshotTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({});
    expect(result).toMatchObject({
      data: expect.any(String),
      mimeType: "image/jpeg",
      width: expect.any(Number),
      height: expect.any(Number),
    });
  });

  test("accepts fullPage option", async () => {
    const driver = createMockDriver();
    const tool = createBrowserScreenshotTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ fullPage: true });
    expect(result).toMatchObject({ data: expect.any(String) });
  });

  test("rejects non-boolean fullPage", async () => {
    const driver = createMockDriver();
    const tool = createBrowserScreenshotTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ fullPage: "yes" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns error on driver failure", async () => {
    const driver = createMockDriver({ failWith: "INTERNAL" });
    const tool = createBrowserScreenshotTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({});
    expect(result).toMatchObject({ code: "INTERNAL" });
  });

  test("rejects non-number quality", async () => {
    const driver = createMockDriver();
    const tool = createBrowserScreenshotTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ quality: "high" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects timeout below minimum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserScreenshotTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ timeout: 50 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects timeout above maximum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserScreenshotTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ timeout: 60_000 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });
});
