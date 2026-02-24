import { describe, expect, test } from "bun:test";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserScreenshotTool } from "./screenshot.js";

describe("browser_screenshot", () => {
  test("captures viewport screenshot by default", async () => {
    const driver = createMockDriver();
    const tool = createBrowserScreenshotTool(driver, "browser", "verified");
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
    const tool = createBrowserScreenshotTool(driver, "browser", "verified");
    const result = await tool.execute({ fullPage: true });
    expect(result).toMatchObject({ data: expect.any(String) });
  });

  test("rejects non-boolean fullPage", async () => {
    const driver = createMockDriver();
    const tool = createBrowserScreenshotTool(driver, "browser", "verified");
    const result = await tool.execute({ fullPage: "yes" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns error on driver failure", async () => {
    const driver = createMockDriver({ failWith: "INTERNAL" });
    const tool = createBrowserScreenshotTool(driver, "browser", "verified");
    const result = await tool.execute({});
    expect(result).toMatchObject({ code: "INTERNAL" });
  });
});
