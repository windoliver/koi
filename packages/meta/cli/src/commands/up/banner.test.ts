import { describe, expect, mock, test } from "bun:test";
import type { BannerInfo } from "./types.js";

// Mock @koi/cli-render to avoid module resolution issues in test
mock.module("@koi/cli-render", () => ({
  bold: (t: string) => t,
  green: (t: string) => t,
  dim: (t: string) => t,
  cyan: (t: string) => t,
}));

// Import after mock
const { printBanner } = await import("./banner.js");

function captureBanner(info: BannerInfo): string {
  const original = process.stderr.write;
  const chunks: string[] = [];
  process.stderr.write = ((chunk: string) => {
    chunks.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    printBanner(info);
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

const BASE_INFO: BannerInfo = {
  agentName: "test-agent",
  presetId: "local",
  nexusMode: "embed-lite",
  engineName: "engine-pi",
  modelName: "claude-sonnet-4-5-20250514",
  channels: [{ name: "cli" } as never],
  nexusBaseUrl: undefined,
  adminReady: false,
  temporalAdmin: undefined,
  temporalUrl: undefined,
  provisionedAgents: [],
  discoveredSources: [],
  prompts: [],
};

describe("printBanner", () => {
  test("shows agent name and preset", () => {
    const text = captureBanner(BASE_INFO);
    expect(text).toContain("test-agent");
    expect(text).toContain("local");
  });

  test("shows channel names", () => {
    const text = captureBanner(BASE_INFO);
    expect(text).toContain("cli");
  });

  test("shows nexus URL when provided", () => {
    const text = captureBanner({
      ...BASE_INFO,
      nexusBaseUrl: "http://localhost:2026",
    });
    expect(text).toContain("http://localhost:2026");
    expect(text).toContain("Nexus ready");
  });

  test("hides nexus when no URL", () => {
    const text = captureBanner(BASE_INFO);
    expect(text).not.toContain("Nexus ready");
  });

  test("shows admin URLs when ready", () => {
    const text = captureBanner({ ...BASE_INFO, adminReady: true });
    expect(text).toContain("Admin API ready");
    expect(text).toContain("Browser admin");
  });

  test("hides admin when not ready", () => {
    const text = captureBanner(BASE_INFO);
    expect(text).not.toContain("Admin API");
  });

  test("shows temporal URL when connected", () => {
    const text = captureBanner({
      ...BASE_INFO,
      temporalAdmin: { dispose: async () => {} },
      temporalUrl: "localhost:7233",
    });
    expect(text).toContain("Temporal ready");
    expect(text).toContain("localhost:7233");
  });

  test("shows discovered sources", () => {
    const text = captureBanner({
      ...BASE_INFO,
      discoveredSources: [
        { name: "orders-db", protocol: "postgres" },
        { name: "api", protocol: "http" },
      ],
    });
    expect(text).toContain("orders-db");
    expect(text).toContain("postgres");
    expect(text).toContain("api");
    expect(text).toContain("http");
  });

  test("shows provisioned agents", () => {
    const text = captureBanner({
      ...BASE_INFO,
      provisionedAgents: [
        { name: "researcher", role: "worker" },
        { name: "writer", role: "copilot" },
      ],
    });
    expect(text).toContain("researcher");
    expect(text).toContain("writer");
  });

  test("prints Try section when prompts provided", () => {
    const text = captureBanner({
      ...BASE_INFO,
      prompts: ["What did I learn about React?", "Summarize authentication."],
    });
    expect(text).toContain("Try:");
    expect(text).toContain('"What did I learn about React?"');
    expect(text).toContain('"Summarize authentication."');
  });

  test("does not print Try section when prompts empty", () => {
    const text = captureBanner(BASE_INFO);
    expect(text).not.toContain("Try:");
  });

  test("formats multiple prompts on separate lines", () => {
    const prompts = ["First prompt", "Second prompt", "Third prompt"];
    const text = captureBanner({ ...BASE_INFO, prompts });
    for (const p of prompts) {
      expect(text).toContain(`"${p}"`);
    }
    // Each prompt appears as its own indented line under "Try:"
    const tryIndex = text.indexOf("Try:");
    const trySection = text.slice(tryIndex);
    for (const p of prompts) {
      expect(trySection).toContain(`"${p}"`);
    }
  });
});
