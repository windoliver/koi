import { describe, expect, test } from "bun:test";
import type { KoiMiddleware } from "@koi/core";
import { createStubAdapter } from "../stubs/stub-adapter.js";
import { createStubChannel } from "../stubs/stub-channel.js";
import { createStubMiddleware } from "../stubs/stub-middleware.js";
import { collectDebugInfo, formatDebugInfo } from "./collect-debug-info.js";

describe("collectDebugInfo", () => {
  test("reports all stubs when no real middleware provided", () => {
    const stub = createStubMiddleware("permissions");
    const info = collectDebugInfo(
      [stub],
      createStubAdapter(),
      createStubChannel(),
      new Set([stub]),
    );

    expect(info.middleware).toHaveLength(1);
    expect(info.middleware[0]?.stubbed).toBe(true);
    expect(info.adapter.stubbed).toBe(true);
  });

  test("reports real middleware as not stubbed", () => {
    const real: KoiMiddleware = {
      name: "permissions",
      phase: "intercept",
      priority: 100,
      describeCapabilities: () => undefined,
    };
    const info = collectDebugInfo([real], createStubAdapter(), createStubChannel(), new Set());

    expect(info.middleware[0]?.stubbed).toBe(false);
    expect(info.middleware[0]?.phase).toBe("intercept");
    expect(info.middleware[0]?.priority).toBe(100);
  });
});

describe("formatDebugInfo", () => {
  test("formats stub stack as readable text", () => {
    const stub = createStubMiddleware("event-trace");
    const info = collectDebugInfo(
      [stub],
      createStubAdapter(),
      createStubChannel(),
      new Set([stub]),
    );
    const output = formatDebugInfo(info);

    expect(output).toContain("=== Runtime Stack ===");
    expect(output).toContain("Adapter: stub (stub)");
    expect(output).toContain("Channel: stub");
    expect(output).toContain("event-trace [stub]");
  });

  test("formats empty middleware chain", () => {
    const info = collectDebugInfo([], createStubAdapter(), createStubChannel(), new Set());
    const output = formatDebugInfo(info);

    expect(output).toContain("Middleware chain: (empty)");
  });

  test("includes tools when present", () => {
    const info = collectDebugInfo([], createStubAdapter(), createStubChannel(), new Set());
    // Manually add tools for testing format
    const withTools = { ...info, tools: [{ name: "bash", source: "builtin" }] };
    const output = formatDebugInfo(withTools);

    expect(output).toContain("Tools: bash");
  });
});
