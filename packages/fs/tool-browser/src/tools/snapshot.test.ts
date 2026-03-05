import { describe, expect, test } from "bun:test";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserSnapshotTool } from "./snapshot.js";

describe("browser_snapshot", () => {
  test("returns snapshot text and snapshotId on success", async () => {
    const driver = createMockDriver();
    const tool = createBrowserSnapshotTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({});
    expect(result).toMatchObject({
      snapshot: expect.any(String),
      snapshotId: expect.any(String),
      truncated: false,
      url: expect.any(String),
      title: expect.any(String),
    });
  });

  test("passes selector to driver when provided", async () => {
    const driver = createMockDriver();
    const tool = createBrowserSnapshotTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ selector: "#main" });
    expect(result).toMatchObject({ snapshotId: expect.any(String) });
  });

  test("rejects invalid selector type", async () => {
    const driver = createMockDriver();
    const tool = createBrowserSnapshotTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ selector: 42 });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("rejects invalid maxTokens type", async () => {
    const driver = createMockDriver();
    const tool = createBrowserSnapshotTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ maxTokens: "big" });
    expect(result).toMatchObject({ code: "VALIDATION" });
  });

  test("returns error object on driver failure", async () => {
    const driver = createMockDriver({ failWith: "INTERNAL" });
    const tool = createBrowserSnapshotTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({});
    expect(result).toMatchObject({ code: "INTERNAL" });
  });

  test("omits refs from LLM-facing output", async () => {
    const driver = createMockDriver();
    const tool = createBrowserSnapshotTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = (await tool.execute({})) as Record<string, unknown>;
    expect(result).not.toHaveProperty("refs");
  });
});
