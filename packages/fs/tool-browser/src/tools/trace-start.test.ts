import { describe, expect, test } from "bun:test";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserTraceStartTool } from "./trace-start.js";

describe("browser_trace_start", () => {
  test("starts trace successfully with no options", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTraceStartTool(driver, "browser", "verified");
    const result = await tool.execute({});
    expect(result).toMatchObject({ success: true });
  });

  test("starts trace with all options", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTraceStartTool(driver, "browser", "verified");
    const result = await tool.execute({
      snapshots: false,
      network: true,
      title: "my-debug-trace",
    });
    expect(result).toMatchObject({ success: true });
  });

  test("rejects invalid snapshots type", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTraceStartTool(driver, "browser", "verified");
    const result = await tool.execute({ snapshots: "yes" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects invalid network type", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTraceStartTool(driver, "browser", "verified");
    const result = await tool.execute({ network: 1 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns error on driver failure", async () => {
    const driver = createMockDriver({ failWith: "INTERNAL" });
    const tool = createBrowserTraceStartTool(driver, "browser", "verified");
    const result = await tool.execute({});
    expect(result).toMatchObject({ code: "INTERNAL" });
  });

  test("uses correct tool name with prefix", () => {
    const driver = createMockDriver();
    const tool = createBrowserTraceStartTool(driver, "browser", "verified");
    expect(tool.descriptor.name).toBe("browser_trace_start");
  });
});
