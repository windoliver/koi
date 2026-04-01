import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  EngineEvent,
  EngineInput,
  EngineOutput,
  KoiMiddleware,
} from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import { createMockEngineAdapter } from "@koi/test-utils";
import { createSelfTest } from "./self-test.js";
import type { SelfTestScenario, SelfTestTool } from "./types.js";

const VALID_MANIFEST: AgentManifest = {
  name: "test-agent",
  version: "1.0.0",
  model: { name: "test-model" },
};

const DEFAULT_OUTPUT: EngineOutput = {
  content: [{ kind: "text", text: "pong" }],
  stopReason: "completed",
  metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
};

const PING_INPUT: EngineInput = { kind: "text", text: "ping" };

describe("createSelfTest", () => {
  test("throws VALIDATION error when manifest is null", () => {
    expect(() => createSelfTest({ manifest: null as unknown as AgentManifest })).toThrow(
      KoiRuntimeError,
    );
  });

  test("returns a SelfTest with a run method", () => {
    const st = createSelfTest({ manifest: VALID_MANIFEST });
    expect(typeof st.run).toBe("function");
  });
});

describe("SelfTest.run", () => {
  test("full healthy run with all categories", async () => {
    const events: readonly EngineEvent[] = [
      { kind: "text_delta", delta: "pong" },
      { kind: "done", output: DEFAULT_OUTPUT },
    ];

    const adapter = createMockEngineAdapter({ events: [...events] });
    const mw: KoiMiddleware = {
      name: "test-mw",
      describeCapabilities: () => undefined,
      async onSessionStart() {},
    };
    const tool: SelfTestTool = {
      descriptor: {
        name: "search",
        description: "Search the web",
        inputSchema: { type: "object" },
      },
      async handler() {
        return { output: "ok" };
      },
    };
    const scenario: SelfTestScenario = {
      name: "ping-pong",
      input: PING_INPUT,
    };

    const st = createSelfTest({
      manifest: VALID_MANIFEST,
      adapter,
      middleware: [mw],
      tools: [tool],
      scenarios: [scenario],
    });

    const report = await st.run();
    expect(report.healthy).toBe(true);
    expect(report.failed).toBe(0);
    expect(report.passed).toBeGreaterThan(0);
    expect(report.passed + report.failed + report.skipped).toBe(report.checks.length);
    expect(typeof report.totalDurationMs).toBe("number");
  });

  test("full failing run when manifest is invalid", async () => {
    const st = createSelfTest({
      manifest: { ...VALID_MANIFEST, name: "" },
    });

    const report = await st.run();
    expect(report.healthy).toBe(false);
    expect(report.failed).toBeGreaterThan(0);
    const failedCheck = report.checks.find((c) => c.status === "fail" && c.category === "manifest");
    expect(failedCheck).toBeDefined();
  });

  test("failFast stops after first category failure", async () => {
    const st = createSelfTest({
      manifest: { ...VALID_MANIFEST, name: "" },
      middleware: [
        {
          name: "should-be-skipped",
          describeCapabilities: () => undefined,
          async onSessionStart() {},
        },
      ],
      failFast: true,
    });

    const report = await st.run();
    expect(report.healthy).toBe(false);

    // Middleware category should be skipped
    const mwChecks = report.checks.filter((c) => c.category === "middleware");
    expect(mwChecks.length).toBe(1);
    expect(mwChecks[0]?.status).toBe("skip");
    expect(mwChecks[0]?.message).toContain("failFast");
  });

  test("category filtering only runs specified categories", async () => {
    const st = createSelfTest({
      manifest: VALID_MANIFEST,
      categories: ["manifest"],
    });

    const report = await st.run();
    const categories = new Set(report.checks.map((c) => c.category));
    expect(categories.has("manifest")).toBe(true);
    expect(categories.has("middleware")).toBe(false);
    expect(categories.has("tools")).toBe(false);
    expect(categories.has("engine")).toBe(false);
    expect(categories.has("scenarios")).toBe(false);
  });

  test("custom checks are executed", async () => {
    let called = false;
    const st = createSelfTest({
      manifest: VALID_MANIFEST,
      customChecks: [
        {
          name: "custom: db connectivity",
          fn() {
            called = true;
          },
        },
      ],
    });

    const report = await st.run();
    expect(called).toBe(true);
    const customCheck = report.checks.find((c) => c.category === "custom");
    expect(customCheck?.status).toBe("pass");
    expect(customCheck?.name).toBe("custom: db connectivity");
  });

  test("custom checks that throw produce fail results", async () => {
    const st = createSelfTest({
      manifest: VALID_MANIFEST,
      customChecks: [
        {
          name: "custom: failing check",
          fn() {
            throw new Error("db unreachable");
          },
        },
      ],
    });

    const report = await st.run();
    expect(report.healthy).toBe(false);
    const customCheck = report.checks.find((c) => c.category === "custom");
    expect(customCheck?.status).toBe("fail");
    expect(customCheck?.error?.message).toBe("db unreachable");
  });

  test("report aggregates are correct", async () => {
    const st = createSelfTest({
      manifest: { ...VALID_MANIFEST, name: "" },
      categories: ["manifest"],
    });

    const report = await st.run();
    const passed = report.checks.filter((c) => c.status === "pass").length;
    const failed = report.checks.filter((c) => c.status === "fail").length;
    const skipped = report.checks.filter((c) => c.status === "skip").length;

    expect(report.passed).toBe(passed);
    expect(report.failed).toBe(failed);
    expect(report.skipped).toBe(skipped);
    expect(report.passed + report.failed + report.skipped).toBe(report.checks.length);
  });

  test("skips engine and scenarios when no adapter provided", async () => {
    const st = createSelfTest({ manifest: VALID_MANIFEST });

    const report = await st.run();
    const engineChecks = report.checks.filter((c) => c.category === "engine");
    const scenarioChecks = report.checks.filter((c) => c.category === "scenarios");

    // Engine and scenarios should have skip results
    for (const check of [...engineChecks, ...scenarioChecks]) {
      expect(check.status).toBe("skip");
    }
  });

  test("empty middleware and tools produce skip results", async () => {
    const st = createSelfTest({ manifest: VALID_MANIFEST });

    const report = await st.run();
    const mwChecks = report.checks.filter((c) => c.category === "middleware");
    const toolChecks = report.checks.filter((c) => c.category === "tools");

    expect(mwChecks.length).toBe(1);
    expect(mwChecks[0]?.status).toBe("skip");
    expect(toolChecks.length).toBe(1);
    expect(toolChecks[0]?.status).toBe("skip");
  });

  test("global timeout skips remaining categories", async () => {
    // Use categories filter so manifest runs first (fast), then engine (skipped by timeout)
    // We set global timeout to 0 so it's already expired when the second category starts
    const st = createSelfTest({
      manifest: VALID_MANIFEST,
      categories: ["manifest", "engine"],
      adapter: createMockEngineAdapter(),
      timeoutMs: 0, // Already expired — second category should be skipped
    });

    const report = await st.run();
    const skippedByTimeout = report.checks.filter(
      (c) => c.status === "skip" && c.message?.includes("Global timeout"),
    );
    expect(skippedByTimeout.length).toBeGreaterThan(0);
    // Manifest checks should have run (before timeout check)
    const manifestChecks = report.checks.filter((c) => c.category === "manifest");
    expect(manifestChecks.length).toBeGreaterThan(0);
  });
});
