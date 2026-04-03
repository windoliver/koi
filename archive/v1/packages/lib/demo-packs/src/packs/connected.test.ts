/**
 * Happy-path tests for the connected demo pack seeder.
 *
 * Uses a mock NexusClient that records all rpc() calls and
 * returns success for every write.
 */

import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import type { NexusClient } from "@koi/nexus-client";
import { CONNECTED_PACK } from "./connected.js";

// ---------------------------------------------------------------------------
// Mock NexusClient
// ---------------------------------------------------------------------------

interface RpcCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function createRecordingClient(): {
  readonly client: NexusClient;
  readonly calls: RpcCall[];
} {
  const calls: RpcCall[] = [];

  const client: NexusClient = {
    rpc: async <T>(
      method: string,
      params: Record<string, unknown>,
    ): Promise<Result<T, KoiError>> => {
      calls.push({ method, params });
      return { ok: true, value: null as T };
    },
  };

  return { client, calls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("connected pack seed", () => {
  test("seeds all HERB data categories via Nexus", async () => {
    const { client, calls } = createRecordingClient();

    const result = await CONNECTED_PACK.seed({
      nexusClient: client,
      agentName: "test-agent",
      workspaceRoot: "/tmp/test-workspace",
      verbose: false,
    });

    expect(result.ok).toBe(true);

    // Verify counts match expected HERB volumes
    expect(result.counts.memory).toBeGreaterThan(0);
    expect(result.counts.corpus).toBeGreaterThan(0);
    expect(result.counts.dataSources).toBeGreaterThan(0);

    // All calls should be writes
    const writeCalls = calls.filter((c) => c.method === "write");
    expect(writeCalls.length).toBeGreaterThan(0);

    // Verify paths include the agent name
    for (const call of writeCalls) {
      const path = call.params.path as string;
      expect(path).toContain("test-agent");
    }
  });

  test("returns summary lines for each category", async () => {
    const { client } = createRecordingClient();

    const result = await CONNECTED_PACK.seed({
      nexusClient: client,
      agentName: "summary-test",
      workspaceRoot: "/tmp/test",
      verbose: false,
    });

    expect(result.summary.length).toBeGreaterThan(0);
    // Should mention data categories
    expect(result.summary.some((line) => line.includes("Memory"))).toBe(true);
    expect(result.summary.some((line) => line.includes("Corpus"))).toBe(true);
    expect(result.summary.some((line) => line.includes("Data Sources"))).toBe(true);
  });

  test("handles partial failure gracefully", async () => {
    // let justified: mutable counter to simulate failure on nth call
    let callCount = 0;
    const client: NexusClient = {
      rpc: async <T>(
        _method: string,
        _params: Record<string, unknown>,
      ): Promise<Result<T, KoiError>> => {
        callCount++;
        // Fail every 5th call
        if (callCount % 5 === 0) {
          return {
            ok: false,
            error: {
              code: "INTERNAL",
              message: "simulated failure",
              retryable: false,
            },
          };
        }
        return { ok: true, value: null as T };
      },
    };

    const result = await CONNECTED_PACK.seed({
      nexusClient: client,
      agentName: "fail-test",
      workspaceRoot: "/tmp/test",
      verbose: true,
    });

    // Should still produce results even with partial failures
    expect(result.counts).toBeDefined();
    expect(result.summary.length).toBeGreaterThan(0);
  });

  test("pack metadata is correct", () => {
    expect(CONNECTED_PACK.id).toBe("connected");
    expect(CONNECTED_PACK.agentRoles.length).toBeGreaterThan(0);
    expect(CONNECTED_PACK.prompts.length).toBeGreaterThan(0);
    // Primary role must exist
    expect(CONNECTED_PACK.agentRoles.some((r) => r.name === "primary")).toBe(true);
  });
});
