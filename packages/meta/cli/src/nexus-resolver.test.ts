import { describe, expect, test } from "bun:test";
import type { KoiError, Result } from "@koi/core";
import type { SandboxConfig, SandboxHandle } from "@koi/nexus-sandbox";
import { resolveNexusEndpoint } from "./nexus-resolver.js";

interface MockDepsState {
  readonly capturedConfigs: SandboxConfig[];
  readonly stopped: number[];
  fail?: KoiError;
  baseUrl?: string;
  pid?: number;
}

function mockDeps(state: MockDepsState): {
  readonly startSandbox: typeof import("@koi/nexus-sandbox").startSandbox;
  readonly stopSandbox: typeof import("@koi/nexus-sandbox").stopSandbox;
} {
  return {
    startSandbox: async (config: SandboxConfig = {}): Promise<Result<SandboxHandle, KoiError>> => {
      state.capturedConfigs.push(config);
      if (state.fail !== undefined) return { ok: false, error: state.fail };
      const handle: SandboxHandle = {
        baseUrl: state.baseUrl ?? "http://127.0.0.1:2026",
        pid: state.pid ?? 999,
        dataDir: config.dataDir ?? "/tmp/nx",
        _process: {
          pid: state.pid ?? 999,
          exited: Promise.resolve(0),
          stderr: new ReadableStream(),
          kill: () => {},
          unref: () => {},
        },
      };
      return { ok: true, value: handle };
    },
    stopSandbox: async (handle: SandboxHandle): Promise<Result<void, KoiError>> => {
      state.stopped.push(handle.pid ?? -1);
      return { ok: true, value: undefined };
    },
  };
}

const empty: MockDepsState = { capturedConfigs: [], stopped: [] };

describe("resolveNexusEndpoint", () => {
  test("CLI flag wins over everything", async () => {
    const state = { capturedConfigs: [], stopped: [] };
    const r = await resolveNexusEndpoint(
      {
        manifestNexus: {
          mode: "sandbox",
          url: undefined,
          port: 1,
          dataDir: undefined,
          enableVectorSearch: undefined,
          embeddingModel: undefined,
        },
        cliNexusUrl: "http://override.example",
        env: { NEXUS_URL: "http://env.example" },
      },
      mockDeps(state),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.url).toBe("http://override.example");
    expect(r.value.source).toBe("cli-flag");
    expect(state.capturedConfigs).toEqual([]);
  });

  test("external mode with manifest url", async () => {
    const r = await resolveNexusEndpoint(
      {
        manifestNexus: {
          mode: "external",
          url: "http://nexus.co",
          port: undefined,
          dataDir: undefined,
          enableVectorSearch: undefined,
          embeddingModel: undefined,
        },
        cliNexusUrl: undefined,
        env: {},
      },
      mockDeps({ capturedConfigs: [], stopped: [] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.url).toBe("http://nexus.co");
    expect(r.value.source).toBe("manifest-url");
  });

  test("external mode falls back to NEXUS_URL env", async () => {
    const r = await resolveNexusEndpoint(
      {
        manifestNexus: {
          mode: "external",
          url: undefined,
          port: undefined,
          dataDir: undefined,
          enableVectorSearch: undefined,
          embeddingModel: undefined,
        },
        cliNexusUrl: undefined,
        env: { NEXUS_URL: "http://from-env" },
      },
      mockDeps({ capturedConfigs: [], stopped: [] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.url).toBe("http://from-env");
    expect(r.value.source).toBe("env");
  });

  test("external mode without any URL → INVALID_CONFIG", async () => {
    const r = await resolveNexusEndpoint(
      {
        manifestNexus: {
          mode: "external",
          url: undefined,
          port: undefined,
          dataDir: undefined,
          enableVectorSearch: undefined,
          embeddingModel: undefined,
        },
        cliNexusUrl: undefined,
        env: {},
      },
      mockDeps({ capturedConfigs: [], stopped: [] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_CONFIG");
    expect(r.error.message).toContain("--nexus-url");
  });

  test("sandbox mode always spawns regardless of NEXUS_URL", async () => {
    const state = { capturedConfigs: [] as SandboxConfig[], stopped: [] as number[] };
    const r = await resolveNexusEndpoint(
      {
        manifestNexus: {
          mode: "sandbox",
          url: undefined,
          port: 9000,
          dataDir: "/tmp/x",
          enableVectorSearch: true,
          embeddingModel: "m",
        },
        cliNexusUrl: undefined,
        env: { NEXUS_URL: "http://ignored" },
      },
      mockDeps(state),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.source).toBe("spawned-sandbox");
    expect(state.capturedConfigs).toEqual([
      { port: 9000, dataDir: "/tmp/x", enableVectorSearch: true, embeddingModel: "m" },
    ]);
  });

  test("auto mode uses NEXUS_URL when set", async () => {
    const state = { capturedConfigs: [] as SandboxConfig[], stopped: [] as number[] };
    const r = await resolveNexusEndpoint(
      {
        manifestNexus: undefined,
        cliNexusUrl: undefined,
        env: { NEXUS_URL: "http://existing" },
      },
      mockDeps(state),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.url).toBe("http://existing");
    expect(r.value.source).toBe("env");
    expect(state.capturedConfigs).toEqual([]);
  });

  test("auto mode spawns when no URL", async () => {
    const state = {
      capturedConfigs: [] as SandboxConfig[],
      stopped: [] as number[],
      baseUrl: "http://127.0.0.1:2026",
    };
    const r = await resolveNexusEndpoint(
      { manifestNexus: undefined, cliNexusUrl: undefined, env: {} },
      mockDeps(state),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.source).toBe("spawned-sandbox");
    expect(r.value.url).toBe("http://127.0.0.1:2026");
  });

  test("shutdown invokes stopSandbox only for spawned source", async () => {
    const state = { capturedConfigs: [] as SandboxConfig[], stopped: [] as number[], pid: 42 };
    const spawned = await resolveNexusEndpoint(
      {
        manifestNexus: {
          mode: "sandbox",
          url: undefined,
          port: undefined,
          dataDir: undefined,
          enableVectorSearch: undefined,
          embeddingModel: undefined,
        },
        cliNexusUrl: undefined,
        env: {},
      },
      mockDeps(state),
    );
    if (!spawned.ok) throw new Error("expected ok");
    await spawned.value.shutdown();
    expect(state.stopped).toEqual([42]);

    const cliFlag = await resolveNexusEndpoint(
      { manifestNexus: undefined, cliNexusUrl: "http://x", env: {} },
      mockDeps({ capturedConfigs: [], stopped: [] }),
    );
    if (!cliFlag.ok) throw new Error("expected ok");
    await cliFlag.value.shutdown(); // must not throw
  });

  test("propagates spawn failure", async () => {
    const state = {
      capturedConfigs: [] as SandboxConfig[],
      stopped: [] as number[],
      fail: { code: "EXTERNAL", message: "boom", retryable: false } satisfies KoiError,
    };
    const r = await resolveNexusEndpoint(
      {
        manifestNexus: {
          mode: "sandbox",
          url: undefined,
          port: undefined,
          dataDir: undefined,
          enableVectorSearch: undefined,
          embeddingModel: undefined,
        },
        cliNexusUrl: undefined,
        env: {},
      },
      mockDeps(state),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("EXTERNAL");
  });

  test("treats whitespace-only URL as missing", async () => {
    const r = await resolveNexusEndpoint(
      {
        manifestNexus: {
          mode: "external",
          url: "   ",
          port: undefined,
          dataDir: undefined,
          enableVectorSearch: undefined,
          embeddingModel: undefined,
        },
        cliNexusUrl: "  ",
        env: { NEXUS_URL: "" },
      },
      mockDeps({ capturedConfigs: [], stopped: [] }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("INVALID_CONFIG");
  });
});

void empty;
