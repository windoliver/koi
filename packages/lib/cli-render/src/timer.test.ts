import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createTimer } from "./timer.js";

describe("createTimer", () => {
  test("enabled=false still executes the function", async () => {
    const timer = createTimer(false);
    const result = await timer.time("test", async () => 42);
    expect(result).toBe(42);
  });

  test("enabled=false records no entries", async () => {
    const timer = createTimer(false);
    await timer.time("test", async () => undefined);
    expect(timer.entries()).toEqual([]);
  });

  test("enabled=false print is no-op", () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));

    const timer = createTimer(false);
    timer.print(stream);
    expect(Buffer.concat(chunks).toString()).toBe("");
  });

  test("enabled=true records label and durationMs", async () => {
    const timer = createTimer(true);
    await timer.time("resolve", async () => {
      // Simulate work
      await new Promise((r) => setTimeout(r, 10));
    });

    const entries = timer.entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.label).toBe("resolve");
    expect(entries[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("records multiple phases in order", async () => {
    const timer = createTimer(true);
    await timer.time("phase-1", async () => undefined);
    await timer.time("phase-2", async () => undefined);
    await timer.time("phase-3", async () => undefined);

    const entries = timer.entries();
    expect(entries).toHaveLength(3);
    expect(entries[0]?.label).toBe("phase-1");
    expect(entries[1]?.label).toBe("phase-2");
    expect(entries[2]?.label).toBe("phase-3");
  });

  test("print outputs formatted timing table", async () => {
    const stream = new PassThrough();
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));

    const timer = createTimer(true);
    await timer.time("resolve", async () => undefined);
    await timer.time("validate", async () => undefined);
    timer.print(stream);

    const text = Buffer.concat(chunks).toString();
    expect(text).toContain("[timing] resolve");
    expect(text).toContain("[timing] validate");
    expect(text).toContain("[timing] total");
    expect(text).toContain("ms");
  });

  test("time returns the function result", async () => {
    const timer = createTimer(true);
    const result = await timer.time("compute", async () => ({ value: 99 }));
    expect(result).toEqual({ value: 99 });
  });
});
