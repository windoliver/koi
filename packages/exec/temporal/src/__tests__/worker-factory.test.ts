import { describe, expect, mock, test } from "bun:test";
import type { WorkerAndConnection, WorkerCreateParams } from "../worker-factory.js";
import { createTemporalWorker } from "../worker-factory.js";

function makeWorkerFactory(): (params: WorkerCreateParams) => Promise<WorkerAndConnection> {
  const worker = { run: mock(async () => {}), shutdown: mock(() => {}) };
  const connection = { close: mock(async () => {}) };
  return mock(async (_params: WorkerCreateParams) => ({ worker, connection }));
}

describe("createTemporalWorker", () => {
  test("calls createWorkerFn with correct params", async () => {
    const factory = makeWorkerFactory();
    await createTemporalWorker(
      { taskQueue: "my-queue", url: "localhost:7233", namespace: "default" },
      {},
      "/workflows/index.js",
      factory,
    );
    expect(factory).toHaveBeenCalledTimes(1);
    const [params] = (factory as ReturnType<typeof mock>).mock.calls[0] as [WorkerCreateParams];
    expect(params.taskQueue).toBe("my-queue");
    expect(params.serverUrl).toBe("localhost:7233");
    expect(params.namespace).toBe("default");
  });

  test("returns worker, connection, run, and dispose", async () => {
    const factory = makeWorkerFactory();
    const handle = await createTemporalWorker({ taskQueue: "q" }, {}, "/wf.js", factory);
    expect(typeof handle.worker.run).toBe("function");
    expect(typeof handle.worker.shutdown).toBe("function");
    expect(typeof handle.connection.close).toBe("function");
    expect(typeof handle.run).toBe("function");
    expect(typeof handle.dispose).toBe("function");
  });

  test("dispose without run: calls shutdown then connection.close", async () => {
    const factory = makeWorkerFactory();
    const handle = await createTemporalWorker({ taskQueue: "q" }, {}, "/wf.js", factory);
    await handle.dispose();
    expect(handle.worker.shutdown).toHaveBeenCalledTimes(1);
    expect(handle.connection.close).toHaveBeenCalledTimes(1);
  });

  test("dispose after run: drains worker before closing connection", async () => {
    const order: string[] = [];
    let resolveRun!: () => void;
    const worker = {
      run: mock(
        () =>
          new Promise<void>((res) => {
            resolveRun = () => {
              order.push("run-settled");
              res();
            };
          }),
      ),
      shutdown: mock(() => {
        order.push("shutdown");
        resolveRun();
      }),
    };
    const connection = {
      close: mock(async () => {
        order.push("connection-close");
      }),
    };
    const factory = mock(async () => ({ worker, connection }));
    const handle = await createTemporalWorker({ taskQueue: "q" }, {}, "/wf.js", factory);

    void handle.run();
    await handle.dispose();

    // shutdown must precede connection.close, and run must settle before close
    expect(order).toEqual(["shutdown", "run-settled", "connection-close"]);
  });

  test("dispose swallows run rejection (intentional shutdown)", async () => {
    const worker = {
      run: mock(async () => {
        throw new Error("worker crashed");
      }),
      shutdown: mock(() => {}),
    };
    const connection = { close: mock(async () => {}) };
    const factory = mock(async () => ({ worker, connection }));
    const handle = await createTemporalWorker({ taskQueue: "q" }, {}, "/wf.js", factory);
    void handle.run().catch(() => {});
    await expect(handle.dispose()).resolves.toBeUndefined();
    expect(handle.connection.close).toHaveBeenCalledTimes(1);
  });

  test("defaults: url=localhost:7233, namespace=default, maxCachedWorkflows=100", async () => {
    const factory = makeWorkerFactory();
    await createTemporalWorker({ taskQueue: "q" }, {}, "/wf.js", factory);
    const [params] = (factory as ReturnType<typeof mock>).mock.calls[0] as [WorkerCreateParams];
    expect(params.serverUrl).toBe("localhost:7233");
    expect(params.namespace).toBe("default");
    expect(params.maxCachedWorkflows).toBe(100);
  });

  test("factory error propagates: createWorkerFn throw rejects createTemporalWorker", async () => {
    const badFactory = mock(async (_params: WorkerCreateParams): Promise<WorkerAndConnection> => {
      throw new Error("worker create failed");
    });
    await expect(
      createTemporalWorker({ taskQueue: "q" }, {}, "/wf.js", badFactory),
    ).rejects.toThrow("worker create failed");
  });
});
