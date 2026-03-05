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

const mockCreateCloudflare = mock(() => mockCloudflareResult);
const mockCreateDaytona = mock(() => mockDaytonaResult);
const mockCreateDocker = mock(() => mockDockerResult);
const mockCreateE2b = mock(() => mockE2bResult);
const mockCreateVercel = mock(() => mockVercelResult);

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
  test("dispatches to createCloudflareAdapter for provider cloudflare", () => {
    const config = { provider: "cloudflare" } as unknown as CloudSandboxConfig;
    const result = createCloudSandbox(config);
    expect(result).toBe(mockCloudflareResult);
    expect(mockCreateCloudflare).toHaveBeenCalledWith(config);
  });

  test("dispatches to createDaytonaAdapter for provider daytona", () => {
    const config = { provider: "daytona" } as unknown as CloudSandboxConfig;
    const result = createCloudSandbox(config);
    expect(result).toBe(mockDaytonaResult);
    expect(mockCreateDaytona).toHaveBeenCalledWith(config);
  });

  test("dispatches to createDockerAdapter for provider docker", () => {
    const config = { provider: "docker" } as unknown as CloudSandboxConfig;
    const result = createCloudSandbox(config);
    expect(result).toBe(mockDockerResult);
    expect(mockCreateDocker).toHaveBeenCalledWith(config);
  });

  test("dispatches to createE2bAdapter for provider e2b", () => {
    const config = { provider: "e2b" } as unknown as CloudSandboxConfig;
    const result = createCloudSandbox(config);
    expect(result).toBe(mockE2bResult);
    expect(mockCreateE2b).toHaveBeenCalledWith(config);
  });

  test("dispatches to createVercelAdapter for provider vercel", () => {
    const config = { provider: "vercel" } as unknown as CloudSandboxConfig;
    const result = createCloudSandbox(config);
    expect(result).toBe(mockVercelResult);
    expect(mockCreateVercel).toHaveBeenCalledWith(config);
  });

  test("returns validation error for unknown provider", () => {
    const config = { provider: "unknown" } as unknown as CloudSandboxConfig;
    const result = createCloudSandbox(config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("unknown");
      expect(result.error.retryable).toBe(false);
    }
  });
});
