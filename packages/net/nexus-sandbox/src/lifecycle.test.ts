import { describe, expect, test } from "bun:test";
import { startSandbox, stopSandbox } from "./lifecycle.js";
import type { FetchFn, SpawnedProcess, SpawnFn } from "./types.js";

interface MockProcessOpts {
  readonly pid?: number;
  readonly exitedWith?: number;
  readonly exitDelayMs?: number;
  readonly stderr?: string;
  readonly captureSignals?: string[];
}

function mockProcess(opts: MockProcessOpts = {}): SpawnedProcess {
  const pid = opts.pid ?? 42;
  const stderrText = opts.stderr ?? "";
  let resolveExit: (code: number) => void = () => {};
  const exited: Promise<number> = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  // If the test asks for an early exit, schedule it.
  if (opts.exitedWith !== undefined || opts.exitDelayMs !== undefined) {
    void (async () => {
      if (opts.exitDelayMs !== undefined) await Bun.sleep(opts.exitDelayMs);
      resolveExit(opts.exitedWith ?? 0);
    })();
  }
  return {
    pid,
    exited,
    stderr: new Response(stderrText).body ?? new ReadableStream(),
    kill(signal?: string | number) {
      const sig = typeof signal === "string" ? signal : "SIGTERM";
      opts.captureSignals?.push(sig);
      // SIGTERM/SIGKILL should let exited resolve so stopSandbox can drain.
      if (opts.exitedWith === undefined && opts.exitDelayMs === undefined) {
        resolveExit(0);
      }
    },
    unref() {},
  } as SpawnedProcess;
}

function alwaysHealthyFetch(): FetchFn {
  return async () => new Response(null, { status: 200 });
}

function alwaysFailingFetch(): FetchFn {
  return async () => {
    throw new Error("Connection refused");
  };
}

function spawnReturning(proc: SpawnedProcess): SpawnFn {
  return () => proc;
}

describe("startSandbox", () => {
  test("happy path: spawns nexusd with sandbox flags, polls /health, returns handle", async () => {
    let argv: readonly string[] | undefined;
    const proc = mockProcess({ pid: 123 });
    const spawn: SpawnFn = (cmd, _opts) => {
      argv = cmd;
      return proc;
    };
    const result = await startSandbox({
      port: 2026,
      dataDir: "/tmp/nexus-test",
      spawn,
      fetch: alwaysHealthyFetch(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.baseUrl).toBe("http://127.0.0.1:2026");
      expect(result.value.pid).toBe(123);
      expect(result.value.dataDir).toBe("/tmp/nexus-test");
    }
    expect(argv).toEqual([
      "uvx",
      "--from",
      "nexus-ai-fs",
      "nexusd",
      "--profile",
      "sandbox",
      "--host",
      "127.0.0.1",
      "--port",
      "2026",
      "--data-dir",
      "/tmp/nexus-test",
    ]);
  });

  test("custom port + host reflected in baseUrl and argv", async () => {
    let argv: readonly string[] | undefined;
    const spawn: SpawnFn = (cmd, _opts) => {
      argv = cmd;
      return mockProcess();
    };
    const result = await startSandbox({
      port: 9999,
      host: "0.0.0.0",
      spawn,
      fetch: alwaysHealthyFetch(),
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.baseUrl).toBe("http://0.0.0.0:9999");
    expect(argv).toContain("0.0.0.0");
    expect(argv).toContain("9999");
  });

  test("enableVectorSearch sets NEXUS_ENABLE_VECTOR_SEARCH=true", async () => {
    let env: Record<string, string | undefined> | undefined;
    const spawn: SpawnFn = (_cmd, opts) => {
      env = opts?.env;
      return mockProcess();
    };
    const result = await startSandbox({
      enableVectorSearch: true,
      embeddingModel: "text-embedding-3-large",
      spawn,
      fetch: alwaysHealthyFetch(),
    });
    expect(result.ok).toBe(true);
    expect(env?.NEXUS_ENABLE_VECTOR_SEARCH).toBe("true");
    expect(env?.NEXUS_EMBEDDING_MODEL).toBe("text-embedding-3-large");
  });

  test("vectorSearch off by default — env vars not set", async () => {
    let env: Record<string, string | undefined> | undefined;
    const spawn: SpawnFn = (_cmd, opts) => {
      env = opts?.env;
      return mockProcess();
    };
    await startSandbox({ spawn, fetch: alwaysHealthyFetch() });
    expect(env?.NEXUS_ENABLE_VECTOR_SEARCH).toBeUndefined();
    expect(env?.NEXUS_EMBEDDING_MODEL).toBeUndefined();
  });

  test("HEALTH_TIMEOUT when /health never returns 200 → kills child", async () => {
    const signals: string[] = [];
    const proc = mockProcess({ captureSignals: signals });
    const result = await startSandbox({
      spawn: spawnReturning(proc),
      fetch: alwaysFailingFetch(),
      healthTimeoutMs: 200,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.message).toContain("health");
    }
    expect(signals).toContain("SIGTERM");
  });

  test("PORT_IN_USE when child exits early with EADDRINUSE in stderr", async () => {
    const proc = mockProcess({
      exitedWith: 1,
      exitDelayMs: 10,
      stderr: "OSError: [Errno 48] Address already in use",
    });
    const result = await startSandbox({
      port: 2026,
      spawn: spawnReturning(proc),
      fetch: alwaysFailingFetch(),
      healthTimeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFLICT");
      expect(result.error.context).toMatchObject({ port: 2026 });
    }
  });

  test("SPAWN_FAILED when spawn itself throws (binary missing)", async () => {
    const spawn: SpawnFn = () => {
      throw new Error("ENOENT: command not found: uvx");
    };
    const result = await startSandbox({ spawn, fetch: alwaysHealthyFetch() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toContain("spawn");
    }
  });

  test("SPAWN_FAILED when child exits non-zero before health (no port pattern)", async () => {
    const proc = mockProcess({
      exitedWith: 2,
      exitDelayMs: 10,
      stderr: "ImportError: bm25s",
    });
    const result = await startSandbox({
      spawn: spawnReturning(proc),
      fetch: alwaysFailingFetch(),
      healthTimeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.context).toMatchObject({ exitCode: 2 });
    }
  });
});

describe("stopSandbox", () => {
  test("graceful: SIGTERM then waits for exit", async () => {
    const signals: string[] = [];
    const proc = mockProcess({ pid: 50, exitDelayMs: 0, captureSignals: signals });
    const handle = {
      baseUrl: "http://127.0.0.1:2026",
      pid: 50,
      dataDir: "/tmp/x",
      _process: proc,
    };
    const r = await stopSandbox(handle);
    expect(r.ok).toBe(true);
    expect(signals[0]).toBe("SIGTERM");
  });

  test("force-kill on drain timeout", async () => {
    const signals: string[] = [];
    // Process never exits within drain window.
    const proc: SpawnedProcess = {
      pid: 51,
      exited: new Promise(() => {}),
      stderr: new ReadableStream(),
      kill(signal?: string | number) {
        signals.push(typeof signal === "string" ? signal : "SIGTERM");
      },
      unref() {},
    };
    const handle = {
      baseUrl: "http://127.0.0.1:2026",
      pid: 51,
      dataDir: "/tmp/x",
      _process: proc,
    };
    const r = await stopSandbox(handle, { drainMs: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("TIMEOUT");
      expect(r.error.context).toMatchObject({ pid: 51 });
    }
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });
});
