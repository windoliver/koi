import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NexusClient } from "@koi/nexus-client";

// Mock @koi/demo-packs
const mockRunSeed = mock(
  async (): Promise<{
    readonly ok: boolean;
    readonly counts: Readonly<Record<string, number>>;
    readonly summary: readonly string[];
  }> => ({
    ok: true,
    counts: { memory: 3 },
    summary: ["Memory: 3 entities ready"],
  }),
);

const mockCheckSeeded = mock(async (): Promise<boolean> => false);

const mockGetPack = mock((id: string) => {
  if (id === "connected") {
    return {
      id: "connected",
      name: "Connected",
      description: "test",
      requires: [],
      agentRoles: [
        { name: "primary", type: "copilot", lifecycle: "copilot", reuse: true, description: "" },
        {
          name: "research-helper",
          type: "copilot",
          lifecycle: "copilot",
          reuse: true,
          description: "helper",
        },
      ],
      seed: mockRunSeed,
      checkSeeded: mockCheckSeeded,
      prompts: ["What did I learn?", "Show me data."],
    };
  }
  return undefined;
});

mock.module("@koi/demo-packs", () => ({
  runSeed: mockRunSeed,
  getPack: mockGetPack,
}));

const { seedDemoPackIfNeeded, provisionDemoAgents } = await import("../demo.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "demo-seed-test-"));
  mockRunSeed.mockClear();
  mockGetPack.mockClear();
  mockCheckSeeded.mockClear();
  mockCheckSeeded.mockResolvedValue(false);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeSuccessClient(): NexusClient {
  return {
    rpc: async () => ({
      ok: true as const,
      value: undefined,
    }),
  } as unknown as NexusClient;
}

// ---------------------------------------------------------------------------
// seedDemoPackIfNeeded
// ---------------------------------------------------------------------------

describe("seedDemoPackIfNeeded", () => {
  test("skips when demoPack is undefined", async () => {
    const result = await seedDemoPackIfNeeded(undefined, tempDir, "test-agent", undefined, false);
    expect(result.prompts).toEqual([]);
    expect(mockRunSeed).not.toHaveBeenCalled();
  });

  test("skips re-seed when marker file exists and returns static views", async () => {
    const koiDir = join(tempDir, ".koi");
    await mkdir(koiDir, { recursive: true });
    await writeFile(join(koiDir, ".demo-seeded"), "connected");

    const result = await seedDemoPackIfNeeded(
      "connected",
      tempDir,
      "test-agent",
      makeSuccessClient(),
      false,
    );
    expect(result.prompts).toEqual(["What did I learn?", "Show me data."]);
    // Must NOT re-run seed — data is already in Nexus
    expect(mockRunSeed).not.toHaveBeenCalled();
  });

  test("warns and returns empty when nexus client is undefined", async () => {
    const original = process.stderr.write;
    const chunks: string[] = [];
    process.stderr.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const result = await seedDemoPackIfNeeded(
        "connected",
        tempDir,
        "test-agent",
        undefined,
        false,
      );
      expect(result.prompts).toEqual([]);
      expect(chunks.join("")).toContain("demo pack requires Nexus");
    } finally {
      process.stderr.write = original;
    }
  });

  test("warns for unknown pack ID", async () => {
    mockGetPack.mockReturnValueOnce(undefined);

    const original = process.stderr.write;
    const chunks: string[] = [];
    process.stderr.write = ((chunk: string) => {
      chunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;

    try {
      const result = await seedDemoPackIfNeeded(
        "nonexistent",
        tempDir,
        "test-agent",
        makeSuccessClient(),
        false,
      );
      expect(result.prompts).toEqual([]);
      expect(chunks.join("")).toContain('Unknown demo pack "nonexistent"');
    } finally {
      process.stderr.write = original;
    }
  });

  test("seeds successfully, writes marker, and returns prompts", async () => {
    const result = await seedDemoPackIfNeeded(
      "connected",
      tempDir,
      "test-agent",
      makeSuccessClient(),
      false,
    );

    expect(result.prompts).toEqual(["What did I learn?", "Show me data."]);
    expect(mockRunSeed).toHaveBeenCalledTimes(1);

    const markerPath = join(tempDir, ".koi", ".demo-seeded");
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8")).toBe("connected");
  });

  test("does not write marker on seed failure", async () => {
    mockRunSeed.mockResolvedValueOnce({
      ok: false,
      counts: { memory: 0 },
      summary: ["Memory: 0 entities ready"],
    });

    await seedDemoPackIfNeeded("connected", tempDir, "test-agent", makeSuccessClient(), false);

    const markerPath = join(tempDir, ".koi", ".demo-seeded");
    expect(existsSync(markerPath)).toBe(false);
  });

  test("skips seed and restores marker when checkSeeded returns true (Nexus fallback)", async () => {
    // No marker file exists, but Nexus already has the data
    mockCheckSeeded.mockResolvedValueOnce(true);

    const result = await seedDemoPackIfNeeded(
      "connected",
      tempDir,
      "test-agent",
      makeSuccessClient(),
      false,
    );

    expect(result.prompts).toEqual(["What did I learn?", "Show me data."]);
    expect(mockRunSeed).not.toHaveBeenCalled();
    expect(mockCheckSeeded).toHaveBeenCalledTimes(1);

    // Marker should be restored for future fast-path
    const markerPath = join(tempDir, ".koi", ".demo-seeded");
    expect(existsSync(markerPath)).toBe(true);
    expect(readFileSync(markerPath, "utf-8")).toBe("connected");
  });

  test("proceeds with seed when checkSeeded returns false", async () => {
    mockCheckSeeded.mockResolvedValueOnce(false);

    const result = await seedDemoPackIfNeeded(
      "connected",
      tempDir,
      "test-agent",
      makeSuccessClient(),
      false,
    );

    expect(result.prompts).toEqual(["What did I learn?", "Show me data."]);
    expect(mockCheckSeeded).toHaveBeenCalledTimes(1);
    expect(mockRunSeed).toHaveBeenCalledTimes(1);
  });

  test("proceeds with seed when checkSeeded throws", async () => {
    mockCheckSeeded.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await seedDemoPackIfNeeded(
      "connected",
      tempDir,
      "test-agent",
      makeSuccessClient(),
      false,
    );

    expect(result.prompts).toEqual(["What did I learn?", "Show me data."]);
    expect(mockRunSeed).toHaveBeenCalledTimes(1);
  });

  test("proceeds with seed when checkSeeded times out", async () => {
    // Simulate a hung Nexus that never resolves
    mockCheckSeeded.mockImplementationOnce(
      () => new Promise<boolean>(() => {}), // never resolves
    );

    const result = await seedDemoPackIfNeeded(
      "connected",
      tempDir,
      "test-agent",
      makeSuccessClient(),
      false,
    );

    expect(result.prompts).toEqual(["What did I learn?", "Show me data."]);
    expect(mockRunSeed).toHaveBeenCalledTimes(1);
  }, 10_000);
});

// ---------------------------------------------------------------------------
// provisionDemoAgents
// ---------------------------------------------------------------------------

describe("provisionDemoAgents", () => {
  test("returns empty when dispatcher is undefined", async () => {
    const result = await provisionDemoAgents("connected", "/tmp/koi.yaml", undefined, false);
    expect(result).toEqual([]);
  });

  test("returns empty when demoPack is undefined", async () => {
    const dispatcher = { dispatchAgent: mock() } as never;
    const result = await provisionDemoAgents(undefined, "/tmp/koi.yaml", dispatcher, false);
    expect(result).toEqual([]);
  });

  test("skips primary role", async () => {
    const dispatchAgent = mock(async () => ({
      ok: true as const,
      value: { agentId: "test-id" },
    }));
    const dispatcher = { dispatchAgent } as never;

    await provisionDemoAgents("connected", "/tmp/koi.yaml", dispatcher, false);

    // Should not dispatch primary, only research-helper
    expect(dispatchAgent).toHaveBeenCalledTimes(1);
    const firstCall = dispatchAgent.mock.calls[0] as unknown[];
    const callArg = firstCall[0] as Record<string, unknown>;
    expect(callArg.name).toContain("research-helper");
  });
});
