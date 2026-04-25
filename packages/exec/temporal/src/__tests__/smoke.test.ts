/**
 * Smoke test: verifies the dynamic import path in worker-factory is reachable.
 *
 * Catches "module not found" regressions that only surface at runtime.
 * @temporalio/worker is a devDependency so this always runs in repo CI.
 */

import { describe, expect, test } from "bun:test";
import type { WorkerAndConnection, WorkerCreateParams } from "../worker-factory.js";
import { createTemporalWorker } from "../worker-factory.js";

describe("createTemporalWorker smoke", () => {
  test("factory override bypasses dynamic import — always passes", async () => {
    const stubFactory = async (_params: WorkerCreateParams): Promise<WorkerAndConnection> => ({
      worker: { run: async () => {}, shutdown: () => {} },
      connection: { close: async () => {} },
    });

    const handle = await createTemporalWorker(
      { taskQueue: "smoke-test" },
      {},
      "/fake/workflows.js",
      stubFactory,
    );

    expect(typeof handle.dispose).toBe("function");
    await handle.dispose();
  });

  test("@temporalio/worker module resolves (devDep installed in repo)", async () => {
    // Verifies the dynamic import path is reachable. The SDK is a devDependency
    // so this must not skip in repo CI. If this fails, check that bun.lock includes
    // @temporalio/worker and that `bun install` completed successfully.
    let resolved = false;
    try {
      await import("@temporalio/worker");
      resolved = true;
    } catch (e: unknown) {
      // surface the actual error so CI knows why it failed
      throw new Error(`@temporalio/worker failed to resolve: ${String(e)}`);
    }
    expect(resolved).toBe(true);
  });
});
