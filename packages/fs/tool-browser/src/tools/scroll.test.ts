import { describe, expect, test } from "bun:test";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserScrollTool } from "./scroll.js";

describe("browser_scroll", () => {
  test("scrolls page down successfully", async () => {
    const driver = createMockDriver();
    const tool = createBrowserScrollTool(driver, "browser", "verified");
    const result = await tool.execute({ direction: "down" });
    expect(result).toMatchObject({ success: true });
  });

  test("scrolls to element by ref", async () => {
    const driver = createMockDriver();
    const tool = createBrowserScrollTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e10" });
    expect(result).toMatchObject({ success: true });
  });

  test("rejects when neither ref nor direction provided", async () => {
    const driver = createMockDriver();
    const tool = createBrowserScrollTool(driver, "browser", "verified");
    const result = await tool.execute({});
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects invalid direction", async () => {
    const driver = createMockDriver();
    const tool = createBrowserScrollTool(driver, "browser", "verified");
    const result = await tool.execute({ direction: "diagonal" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects invalid ref format", async () => {
    const driver = createMockDriver();
    const tool = createBrowserScrollTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "bottom-of-page" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns error on driver failure", async () => {
    const driver = createMockDriver({ failWith: "INTERNAL" });
    const tool = createBrowserScrollTool(driver, "browser", "verified");
    const result = await tool.execute({ direction: "down" });
    expect(result).toMatchObject({ code: "INTERNAL" });
  });
});
