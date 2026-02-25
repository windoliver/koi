import { describe, expect, test } from "bun:test";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserTraceStopTool } from "./trace-stop.js";

describe("browser_trace_stop", () => {
  test("stops trace and returns path", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTraceStopTool(driver, "browser", "verified");
    const result = await tool.execute({});
    expect(result).toMatchObject({ path: expect.any(String) });
  });

  test("returns path to .zip file", async () => {
    const driver = createMockDriver();
    const tool = createBrowserTraceStopTool(driver, "browser", "verified");
    const result = await tool.execute({});
    expect((result as { path: string }).path).toContain(".zip");
  });

  test("returns error on driver failure", async () => {
    const driver = createMockDriver({ failWith: "INTERNAL" });
    const tool = createBrowserTraceStopTool(driver, "browser", "verified");
    const result = await tool.execute({});
    expect(result).toMatchObject({ code: "INTERNAL" });
  });

  test("uses correct tool name with prefix", () => {
    const driver = createMockDriver();
    const tool = createBrowserTraceStopTool(driver, "browser", "verified");
    expect(tool.descriptor.name).toBe("browser_trace_stop");
  });
});
