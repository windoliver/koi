import { describe, expect, mock, test } from "bun:test";
import { createTemporalWorker } from "./worker-factory.js";

const MOCK_CONFIG = Object.freeze({
  url: "localhost:7233",
  taskQueue: "test-queue",
  maxCachedWorkflows: 10,
  healthCheckIntervalMs: 10_000,
  healthFailureThreshold: 3,
  healthCooldownMs: 60_000,
  dbPath: undefined,
});

function makeWorkerAndConnection(runFn?: () => Promise<void>): {
  worker: { run: () => Promise<void>; shutdown: () => void };
  connection: { close: () => Promise<void> };
  shutdownCalled: () => boolean;
  closeCalled: () => boolean;
} {
  let shutdownCalled = false;
  let closeCalled = false;

  const worker = {
    run: runFn ?? mock(async () => undefined),
    shutdown: mock(() => {
      shutdownCalled = true;
    }),
  };
  const connection = {
    close: mock(async () => {
      closeCalled = true;
    }),
  };

  return {
    worker,
    connection,
    shutdownCalled: () => shutdownCalled,
    closeCalled: () => closeCalled,
  };
}

describe("createTemporalWorker", () => {
  test("dispose calls shutdown and closes connection", async () => {
    const { worker, connection } = makeWorkerAndConnection();
    const handle = await createTemporalWorker(
      { config: MOCK_CONFIG },
      "/workflows",
      {},
      async () => ({ worker, connection }),
    );

    await handle.dispose();

    expect(worker.shutdown).toHaveBeenCalledTimes(1);
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  test("dispose awaits worker run drain before closing connection", async () => {
    const order: string[] = [];
    let resolveRun!: () => void;
    const runPromise = new Promise<void>((r) => {
      resolveRun = r;
    });

    const worker = {
      run: mock(async () => {
        await runPromise;
        order.push("run-settled");
      }),
      shutdown: mock(() => {
        order.push("shutdown");
        resolveRun();
      }),
    };
    const connection = {
      close: mock(async () => {
        order.push("connection-closed");
      }),
    };

    const handle = await createTemporalWorker(
      { config: MOCK_CONFIG },
      "/workflows",
      {},
      async () => ({ worker, connection }),
    );

    await handle.dispose();

    // run must settle before connection is closed
    expect(order).toEqual(["shutdown", "run-settled", "connection-closed"]);
  });

  test("dispose tolerates worker.run() rejection containing 'shutdown' (normal path)", async () => {
    const worker = {
      run: mock(async () => {
        throw new Error("Worker shutdown graceful");
      }),
      shutdown: mock(() => {}),
    };
    const connection = {
      close: mock(async () => {}),
    };

    const handle = await createTemporalWorker(
      { config: MOCK_CONFIG },
      "/workflows",
      {},
      async () => ({ worker, connection }),
    );

    await expect(handle.dispose()).resolves.toBeUndefined();
    expect(connection.close).toHaveBeenCalledTimes(1);
  });

  test("exposes worker, connection, and runPromise on the handle", async () => {
    const { worker, connection } = makeWorkerAndConnection();
    const handle = await createTemporalWorker(
      { config: MOCK_CONFIG },
      "/workflows",
      {},
      async () => ({ worker, connection }),
    );

    expect(handle.worker).toBe(worker);
    expect(handle.connection).toBe(connection);
    expect(handle.runPromise).toBeInstanceOf(Promise);
  });

  test("runPromise resolves after worker.run() completes", async () => {
    let resolveRun!: () => void;
    const worker = {
      run: mock(
        () =>
          new Promise<void>((r) => {
            resolveRun = r;
          }),
      ),
      shutdown: mock(() => {}),
    };
    const connection = { close: mock(async () => {}) };

    const handle = await createTemporalWorker(
      { config: MOCK_CONFIG },
      "/workflows",
      {},
      async () => ({ worker, connection }),
    );

    let settled = false;
    void handle.runPromise.then(() => {
      settled = true;
    });

    expect(settled).toBe(false);
    resolveRun();
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(true);
  });
});
