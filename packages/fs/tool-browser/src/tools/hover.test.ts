import { describe, expect, test } from "bun:test";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserHoverTool } from "./hover.js";

describe("browser_hover", () => {
  test("hovers over an element by ref successfully", async () => {
    const driver = createMockDriver();
    const tool = createBrowserHoverTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e1" });
    expect(result).toMatchObject({ success: true });
  });

  test("rejects missing ref", async () => {
    const driver = createMockDriver();
    const tool = createBrowserHoverTool(driver, "browser", "verified");
    const result = await tool.execute({});
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects ref in wrong format", async () => {
    const driver = createMockDriver();
    const tool = createBrowserHoverTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "button-1" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns STALE_REF error when snapshotId is stale", async () => {
    const driver = createMockDriver({ staleSnapshotId: "snap-old" });
    const tool = createBrowserHoverTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e1", snapshotId: "snap-old" });
    expect(result).toMatchObject({
      code: "STALE_REF",
      error: expect.stringContaining("stale"),
    });
  });

  test("rejects timeout above maximum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserHoverTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e1", timeout: 99999 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns error on driver failure", async () => {
    const driver = createMockDriver({ failWith: "INTERNAL" });
    const tool = createBrowserHoverTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e1" });
    expect(result).toMatchObject({ code: "INTERNAL" });
  });

  test("uses custom prefix in tool name", () => {
    const driver = createMockDriver();
    const tool = createBrowserHoverTool(driver, "web", "verified");
    expect(tool.descriptor.name).toBe("web_hover");
  });
});
