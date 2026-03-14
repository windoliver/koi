import { describe, expect, mock, test } from "bun:test";
import type { DataSourceDescriptor } from "@koi/core";
import type { ConsentDecision } from "@koi/data-source-discovery";

// Mock @clack/prompts
const mockSelect = mock(() => Promise.resolve("y"));
const mockMultiselect = mock(() => Promise.resolve(["db-1"]));
const mockIsCancel = mock(() => false);

mock.module("@clack/prompts", () => ({
  select: mockSelect,
  multiselect: mockMultiselect,
  isCancel: mockIsCancel,
}));

// Mock @koi/cli-render
mock.module("@koi/cli-render", () => ({
  bold: (t: string) => t,
  green: (t: string) => t,
  dim: (t: string) => t,
  cyan: (t: string) => t,
}));

const { createInteractiveConsent } = await import("../consent.js");

function createMockOutput(isTTY = true): import("@koi/cli-render").CliOutput {
  return {
    isTTY,
    info: mock(() => {}),
    success: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
    spinner: {
      start: mock(() => {}),
      stop: mock(() => {}),
    },
  } as unknown as import("@koi/cli-render").CliOutput;
}

const DESCRIPTORS: readonly DataSourceDescriptor[] = [
  { name: "db-1", protocol: "postgres" as const, description: "Primary DB" },
  { name: "api-1", protocol: "http" as const, description: "REST API" },
];

/** Helper that asserts presentBatch exists and calls it. */
async function callPresentBatch(
  output: import("@koi/cli-render").CliOutput,
  descriptors: readonly DataSourceDescriptor[],
): Promise<ConsentDecision> {
  const consent = createInteractiveConsent(output);
  if (consent.presentBatch === undefined) throw new Error("presentBatch must be defined");
  return consent.presentBatch(descriptors);
}

describe("createInteractiveConsent", () => {
  test("approve_all when user selects yes", async () => {
    mockSelect.mockResolvedValueOnce("y");
    const decision = await callPresentBatch(createMockOutput(), DESCRIPTORS);
    expect(decision).toEqual({ kind: "approve_all" });
  });

  test("deny_all when user selects no", async () => {
    mockSelect.mockResolvedValueOnce("n");
    const decision = await callPresentBatch(createMockOutput(), DESCRIPTORS);
    expect(decision).toEqual({ kind: "deny_all" });
  });

  test("select when user picks individually", async () => {
    mockSelect.mockResolvedValueOnce("s");
    mockMultiselect.mockResolvedValueOnce(["db-1"]);
    const decision = await callPresentBatch(createMockOutput(), DESCRIPTORS);
    expect(decision).toEqual({ kind: "select", approved: ["db-1"] });
  });

  test("deny_all when user cancels select", async () => {
    mockIsCancel.mockReturnValueOnce(true);
    const decision = await callPresentBatch(createMockOutput(), DESCRIPTORS);
    expect(decision).toEqual({ kind: "deny_all" });
  });

  test("deny_all for empty descriptors", async () => {
    const decision = await callPresentBatch(createMockOutput(), []);
    expect(decision).toEqual({ kind: "deny_all" });
  });

  test("auto-approve in non-TTY mode", async () => {
    const decision = await callPresentBatch(createMockOutput(false), DESCRIPTORS);
    expect(decision).toEqual({ kind: "approve_all" });
  });

  test("approve fallback always returns true", async () => {
    const consent = createInteractiveConsent(createMockOutput());
    const descriptor = DESCRIPTORS[0];
    if (descriptor === undefined) throw new Error("descriptor must exist");
    const result = await consent.approve(descriptor);
    expect(result).toBe(true);
  });
});
