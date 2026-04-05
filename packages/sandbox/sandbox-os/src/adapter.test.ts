import { describe, expect, test } from "bun:test";

import type { SandboxProfile } from "@koi/core";

import { collectStream, createOsAdapterForTest } from "./adapter.js";

const openProfile = (allow: boolean): SandboxProfile => ({
  filesystem: { defaultReadAccess: "open" },
  network: { allow },
  resources: {},
});

const closedProfile = (allow: boolean): SandboxProfile => ({
  filesystem: { defaultReadAccess: "closed" },
  network: { allow },
  resources: {},
});

describe("createOsAdapterForTest", () => {
  test("allows open defaultReadAccess on seatbelt", async () => {
    const adapter = createOsAdapterForTest({ platform: "seatbelt", available: true });
    // Should resolve without throwing
    const instance = await adapter.create(openProfile(true));
    expect(instance).toBeDefined();
  });

  test("rejects closed defaultReadAccess on seatbelt with VALIDATION error", async () => {
    const adapter = createOsAdapterForTest({ platform: "seatbelt", available: true });
    let caughtError: unknown;
    try {
      await adapter.create(closedProfile(true));
    } catch (e: unknown) {
      caughtError = e;
    }
    expect(caughtError).toBeInstanceOf(Error);
    // The cause is the KoiError with code VALIDATION
    const cause = (caughtError as Error & { cause?: { code?: string } }).cause;
    expect(cause?.code).toBe("VALIDATION");
  });

  test("allows closed defaultReadAccess on bwrap", async () => {
    const adapter = createOsAdapterForTest({ platform: "bwrap", available: true });
    const instance = await adapter.create(closedProfile(false));
    expect(instance).toBeDefined();
  });

  test("allows open defaultReadAccess on bwrap", async () => {
    const adapter = createOsAdapterForTest({ platform: "bwrap", available: true });
    const instance = await adapter.create(openProfile(true));
    expect(instance).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// collectStream unit tests — no process spawning needed
// ---------------------------------------------------------------------------

function makeStream(data: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(data);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("collectStream", () => {
  test("collects full text when budget is sufficient", async () => {
    const result = await collectStream(makeStream("hello"), { remaining: 100 });
    expect(result.text).toBe("hello");
    expect(result.truncated).toBe(false);
  });

  test("truncates when budget is exhausted mid-stream", async () => {
    const result = await collectStream(makeStream("hello world"), { remaining: 5 });
    expect(result.truncated).toBe(true);
    expect(result.text).toBe("hello");
  });

  test("truncated=false for empty stream", async () => {
    const result = await collectStream(makeStream(""), { remaining: 100 });
    expect(result.text).toBe("");
    expect(result.truncated).toBe(false);
  });

  test("budget.remaining is decremented by bytes consumed", async () => {
    const budget = { remaining: 100 };
    await collectStream(makeStream("hello"), budget);
    expect(budget.remaining).toBe(95); // 100 - 5
  });

  test("shared budget: combined streams respect combined cap", async () => {
    const budget = { remaining: 6 };
    const [r1, r2] = await Promise.all([
      collectStream(makeStream("abcdef"), budget), // 6 bytes — exhausts budget
      collectStream(makeStream("ghijkl"), budget), // 6 bytes — budget already 0
    ]);
    const totalChars = r1.text.length + r2.text.length;
    expect(totalChars).toBeLessThanOrEqual(6);
    expect(r1.truncated || r2.truncated).toBe(true);
  });

  test("onChunk callback is called for each decoded chunk", async () => {
    const chunks: string[] = [];
    await collectStream(makeStream("hello"), { remaining: 100 }, (c) => chunks.push(c));
    expect(chunks.join("")).toBe("hello");
  });

  test("onChunk is NOT called after budget exhausted", async () => {
    const chunks: string[] = [];
    await collectStream(makeStream("hello world"), { remaining: 5 }, (c) => chunks.push(c));
    expect(chunks.join("")).toBe("hello");
  });
});

// ---------------------------------------------------------------------------
// exec maxOutputBytes integration test — requires SANDBOX_INTEGRATION=1 on macOS
// ---------------------------------------------------------------------------

const SKIP_INTEGRATION = !process.env.SANDBOX_INTEGRATION || process.platform !== "darwin";

describe.skipIf(SKIP_INTEGRATION)("exec maxOutputBytes truncation", () => {
  test("truncated=true when process output exceeds maxOutputBytes", async () => {
    const adapter = createOsAdapterForTest({ platform: "seatbelt", available: true });
    const instance = await adapter.create(openProfile(false));
    // printf repeats a pattern — generates ~200 bytes, cap at 20
    const result = await instance.exec("/bin/sh", ["-c", "printf '%0200d' 0"], {
      maxOutputBytes: 20,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(20);
  });
});
