import { describe, expect, test } from "bun:test";
import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import { createMockDriver } from "../test-helpers.js";
import { createBrowserSnapshotTool, DEFAULT_SNAPSHOT_MAX_BYTES } from "./snapshot.js";

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

  test("rejects invalid maxBytes type", async () => {
    const driver = createMockDriver();
    const tool = createBrowserSnapshotTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    const result = await tool.execute({ maxBytes: "big" });
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

  test("uses default 50KB maxBytes when not specified", async () => {
    let capturedMaxTokens: number | undefined;
    const driver = {
      ...createMockDriver(),
      snapshot: (opts?: { maxTokens?: number }) => {
        capturedMaxTokens = opts?.maxTokens;
        return createMockDriver().snapshot(opts);
      },
    };
    const tool = createBrowserSnapshotTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({});
    const expectedMaxTokens = Math.floor(DEFAULT_SNAPSHOT_MAX_BYTES / 4);
    expect(capturedMaxTokens).toBe(expectedMaxTokens);
  });

  test("passes maxBytes converted to maxTokens to driver", async () => {
    let capturedMaxTokens: number | undefined;
    const driver = {
      ...createMockDriver(),
      snapshot: (opts?: { maxTokens?: number }) => {
        capturedMaxTokens = opts?.maxTokens;
        return createMockDriver().snapshot(opts);
      },
    };
    const tool = createBrowserSnapshotTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ maxBytes: 20_000 });
    expect(capturedMaxTokens).toBe(Math.floor(20_000 / 4)); // 5000
  });

  test("custom maxBytes is respected", async () => {
    let capturedMaxTokens: number | undefined;
    const driver = {
      ...createMockDriver(),
      snapshot: (opts?: { maxTokens?: number }) => {
        capturedMaxTokens = opts?.maxTokens;
        return createMockDriver().snapshot(opts);
      },
    };
    const tool = createBrowserSnapshotTool(driver, "browser", DEFAULT_UNSANDBOXED_POLICY);
    await tool.execute({ maxBytes: 100_000 });
    expect(capturedMaxTokens).toBe(Math.floor(100_000 / 4)); // 25000
  });
});
