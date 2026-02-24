import { describe, expect, test } from "bun:test";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserConsoleTool } from "./console.js";

describe("browser_console", () => {
  test("returns console entries on success", async () => {
    const driver = createMockDriver();
    const tool = createBrowserConsoleTool(driver, "browser", "verified");
    const result = await tool.execute({});
    expect(result).toMatchObject({ success: true, entries: [], total: 0 });
  });

  test("returns empty entries when buffer is empty", async () => {
    const driver = createMockDriver();
    const tool = createBrowserConsoleTool(driver, "browser", "verified");
    const result = await tool.execute({});
    expect(result).toMatchObject({ success: true, entries: [] });
  });

  test("filters by levels", async () => {
    const driver = createMockDriver();
    const tool = createBrowserConsoleTool(driver, "browser", "verified");
    const result = await tool.execute({ levels: ["error", "warning"] });
    expect(result).toMatchObject({ success: true });
  });

  test("rejects invalid level", async () => {
    const driver = createMockDriver();
    const tool = createBrowserConsoleTool(driver, "browser", "verified");
    const result = await tool.execute({ levels: ["verbose"] });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects limit above 200", async () => {
    const driver = createMockDriver();
    const tool = createBrowserConsoleTool(driver, "browser", "verified");
    const result = await tool.execute({ limit: 201 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects limit below 1", async () => {
    const driver = createMockDriver();
    const tool = createBrowserConsoleTool(driver, "browser", "verified");
    const result = await tool.execute({ limit: 0 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("passes clear flag to driver", async () => {
    const driver = createMockDriver();
    const tool = createBrowserConsoleTool(driver, "browser", "verified");
    const result = await tool.execute({ clear: true });
    expect(result).toMatchObject({ success: true });
  });

  test("uses custom prefix in tool name", () => {
    const driver = createMockDriver();
    const tool = createBrowserConsoleTool(driver, "web", "verified");
    expect(tool.descriptor.name).toBe("web_console");
  });

  test("returns INTERNAL error on driver failure", async () => {
    const driver = createMockDriver({ failWith: "INTERNAL" });
    const tool = createBrowserConsoleTool(driver, "browser", "verified");
    const result = await tool.execute({});
    expect(result).toMatchObject({ code: "INTERNAL" });
  });
});
