import { describe, expect, test } from "bun:test";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserSelectTool } from "./select.js";

describe("browser_select", () => {
  test("selects an option successfully", async () => {
    const driver = createMockDriver();
    const tool = createBrowserSelectTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e5", value: "Option B" });
    expect(result).toMatchObject({ success: true });
  });

  test("rejects missing ref", async () => {
    const driver = createMockDriver();
    const tool = createBrowserSelectTool(driver, "browser", "verified");
    const result = await tool.execute({ value: "Option B" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects missing value", async () => {
    const driver = createMockDriver();
    const tool = createBrowserSelectTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e5" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns error on driver failure", async () => {
    const driver = createMockDriver({ failWith: "NOT_FOUND" });
    const tool = createBrowserSelectTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e5", value: "Option A" });
    expect(result).toMatchObject({ code: "NOT_FOUND" });
  });

  test("rejects non-string snapshotId", async () => {
    const driver = createMockDriver();
    const tool = createBrowserSelectTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e5", value: "Option A", snapshotId: 42 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects empty snapshotId", async () => {
    const driver = createMockDriver();
    const tool = createBrowserSelectTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e5", value: "Option A", snapshotId: "" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects timeout below minimum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserSelectTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e5", value: "Option A", timeout: 50 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects timeout above maximum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserSelectTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e5", value: "Option A", timeout: 20_000 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });
});
