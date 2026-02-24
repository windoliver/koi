import { describe, expect, test } from "bun:test";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserClickTool } from "./click.js";

describe("browser_click", () => {
  test("clicks an element by ref successfully", async () => {
    const driver = createMockDriver();
    const tool = createBrowserClickTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e1" });
    expect(result).toMatchObject({ success: true });
  });

  test("rejects missing ref", async () => {
    const driver = createMockDriver();
    const tool = createBrowserClickTool(driver, "browser", "verified");
    const result = await tool.execute({});
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects ref in wrong format", async () => {
    const driver = createMockDriver();
    const tool = createBrowserClickTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "button-1" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("accepts valid snapshotId", async () => {
    const driver = createMockDriver();
    const tool = createBrowserClickTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e1", snapshotId: "snap-abc" });
    expect(result).toMatchObject({ success: true });
  });

  test("returns STALE_REF error when snapshotId is stale", async () => {
    const driver = createMockDriver({ staleSnapshotId: "snap-old" });
    const tool = createBrowserClickTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e1", snapshotId: "snap-old" });
    expect(result).toMatchObject({ code: "NOT_FOUND" });
    expect((result as { error: string }).error).toContain("stale");
  });

  test("rejects timeout above maximum", async () => {
    const driver = createMockDriver();
    const tool = createBrowserClickTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e1", timeout: 99999 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns error on driver failure", async () => {
    const driver = createMockDriver({ failWith: "INTERNAL" });
    const tool = createBrowserClickTool(driver, "browser", "verified");
    const result = await tool.execute({ ref: "e1" });
    expect(result).toMatchObject({ code: "INTERNAL" });
  });
});
