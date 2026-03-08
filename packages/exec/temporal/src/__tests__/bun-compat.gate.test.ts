/**
 * Bun compatibility gate test — Decision 9A.
 *
 * This is the FIRST test that must pass before any other Temporal test.
 * It verifies that the Temporal SDK's native modules (@temporalio/core-bridge)
 * work on the current Bun version.
 *
 * Gated behind TEMPORAL_INTEGRATION=true — skipped in normal CI.
 * Run explicitly: TEMPORAL_INTEGRATION=true bun test src/__tests__/bun-compat.gate.test.ts
 */

import { describe, expect, test } from "bun:test";

const SKIP = process.env.TEMPORAL_INTEGRATION !== "true";

describe.skipIf(SKIP)("Bun compatibility gate", () => {
  test("can import @temporalio/common", async () => {
    // @temporalio/common is pure TypeScript — should always work
    const common = await import("@temporalio/common");
    expect(common).toBeDefined();
  });

  test("can import @temporalio/client", async () => {
    // @temporalio/client uses gRPC — may fail if native modules don't load
    const client = await import("@temporalio/client");
    expect(client.Client).toBeDefined();
    expect(client.Connection).toBeDefined();
  });

  test("can import @temporalio/worker", async () => {
    // @temporalio/worker has the heaviest native dependency (core-bridge)
    const worker = await import("@temporalio/worker");
    expect(worker.Worker).toBeDefined();
    expect(worker.NativeConnection).toBeDefined();
  });

  test("can create NativeConnection to Temporal server", async () => {
    // This actually connects to the Temporal server — requires it to be running
    const { NativeConnection } = await import("@temporalio/worker");

    const connection = await NativeConnection.connect({
      address: "localhost:7233",
    });

    expect(connection).toBeDefined();
    await connection.close();
  });

  test("can create and run a trivial workflow", async () => {
    const { NativeConnection, Worker } = await import("@temporalio/worker");
    const { Client, Connection } = await import("@temporalio/client");

    // Connect Worker
    const nativeConn = await NativeConnection.connect({
      address: "localhost:7233",
    });

    const worker = await Worker.create({
      connection: nativeConn,
      taskQueue: "bun-compat-test",
      workflowsPath: new URL("./fixtures/trivial-workflow.js", import.meta.url).pathname,
      activities: {
        async noOp(): Promise<string> {
          return "ok";
        },
      },
    });

    // Start Worker in background
    const workerPromise = worker.run();

    try {
      // Connect Client
      const clientConn = await Connection.connect({
        address: "localhost:7233",
      });
      const client = new Client({ connection: clientConn });

      // Start and wait for trivial workflow
      const handle = await client.workflow.start("trivialWorkflow", {
        taskQueue: "bun-compat-test",
        workflowId: `bun-compat-${Date.now()}`,
      });

      const result = await handle.result();
      expect(result).toBe("ok");
    } finally {
      worker.shutdown();
      await workerPromise;
      await nativeConn.close();
    }
  });
});
