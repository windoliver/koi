import { describe, expect, mock, test } from "bun:test";
import type { KoiError, Result, SandboxAdapter } from "@koi/core";
import type { CloudSandboxConfig } from "./cloud-types.js";

// Mock all provider factories before importing the module under test
const mockCloudflareResult: Result<SandboxAdapter, KoiError> = {
  ok: true,
  value: { name: "cloudflare" } as unknown as SandboxAdapter,
};
const mockDaytonaResult: Result<SandboxAdapter, KoiError> = {
  ok: true,
  value: { name: "daytona" } as unknown as SandboxAdapter,
};
const mockDockerResult: Result<SandboxAdapter, KoiError> = {
  ok: true,
  value: { name: "docker" } as unknown as SandboxAdapter,
};
const mockE2bResult: Result<SandboxAdapter, KoiError> = {
  ok: true,
  value: { name: "e2b" } as unknown as SandboxAdapter,
};
const mockVercelResult: Result<SandboxAdapter, KoiError> = {
  ok: true,
  value: { name: "vercel" } as unknown as SandboxAdapter,
};

const mockCreateCloudflare = mock(() => Promise.resolve(mockCloudflareResult));
const mockCreateDaytona = mock(() => Promise.resolve(mockDaytonaResult));
const mockCreateDocker = mock(() => Promise.resolve(mockDockerResult));
const mockCreateE2b = mock(() => Promise.resolve(mockE2bResult));
const mockCreateVercel = mock(() => Promise.resolve(mockVercelResult));

mock.module("@koi/sandbox-cloudflare", () => ({
  createCloudflareAdapter: mockCreateCloudflare,
}));
mock.module("@koi/sandbox-daytona", () => ({
  createDaytonaAdapter: mockCreateDaytona,
}));
mock.module("@koi/sandbox-docker", () => ({
  createDockerAdapter: mockCreateDocker,
}));
mock.module("@koi/sandbox-e2b", () => ({
  createE2bAdapter: mockCreateE2b,
}));
mock.module("@koi/sandbox-vercel", () => ({
  createVercelAdapter: mockCreateVercel,
}));

// Import after mocking
const { createCloudSandbox } = await import("./create-cloud-sandbox.js");

describe("createCloudSandbox", () => {
  test("dispatches to createCloudflareAdapter for provider cloudflare", async () => {
    const config = { provider: "cloudflare" } as unknown as CloudSandboxConfig;
    const result = await createCloudSandbox(config);
    expect(result).toEqual(mockCloudflareResult);
  });

  test("dispatches to createDaytonaAdapter for provider daytona", async () => {
    const config = { provider: "daytona" } as unknown as CloudSandboxConfig;
    const result = await createCloudSandbox(config);
    expect(result).toEqual(mockDaytonaResult);
  });

  test("dispatches to createDockerAdapter for provider docker", async () => {
    const config = { provider: "docker" } as unknown as CloudSandboxConfig;
    const result = await createCloudSandbox(config);
    expect(result).toEqual(mockDockerResult);
  });

  test("dispatches to createE2bAdapter for provider e2b", async () => {
    const config = { provider: "e2b" } as unknown as CloudSandboxConfig;
    const result = await createCloudSandbox(config);
    expect(result).toEqual(mockE2bResult);
  });

  test("dispatches to createVercelAdapter for provider vercel", async () => {
    const config = { provider: "vercel" } as unknown as CloudSandboxConfig;
    const result = await createCloudSandbox(config);
    expect(result).toEqual(mockVercelResult);
  });

  test("returns validation error for unknown provider", async () => {
    const config = { provider: "unknown" } as unknown as CloudSandboxConfig;
    const result = await createCloudSandbox(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("unknown");
      expect(result.error.retryable).toBe(false);
    }
  });
});
