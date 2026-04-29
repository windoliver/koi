import { describe, expect, test } from "bun:test";
import type { ExternalAgentDescriptor } from "@koi/core";
import { checkAgentHealth } from "./health.js";
import type { SystemCalls } from "./types.js";

function makeSc(over: Partial<SystemCalls> = {}): SystemCalls {
  return {
    which: async () => null,
    readDir: async () => [],
    readFile: async () => "",
    spawn: async () => ({ stdout: "", exitCode: 0 }),
    ...over,
  };
}

const cli: ExternalAgentDescriptor = {
  name: "x",
  transport: "cli",
  command: "x",
  capabilities: [],
  source: "path",
};

describe("checkAgentHealth", () => {
  test("CLI healthy when --version exits 0", async () => {
    const sc = makeSc({ spawn: async () => ({ stdout: "1.0.0", exitCode: 0 }) });
    const r = await checkAgentHealth(cli, sc);
    expect(r.status).toBe("healthy");
    expect(typeof r.latencyMs).toBe("number");
  });

  test("CLI unhealthy when --version exits non-zero", async () => {
    const sc = makeSc({ spawn: async () => ({ stdout: "", exitCode: 1 }) });
    const r = await checkAgentHealth(cli, sc);
    expect(r.status).toBe("unhealthy");
  });

  test("CLI unhealthy when spawn throws", async () => {
    const sc = makeSc({
      spawn: async () => {
        throw new Error("boom");
      },
    });
    const r = await checkAgentHealth(cli, sc);
    expect(r.status).toBe("unhealthy");
    expect(r.message).toMatch(/boom/);
  });

  test("non-CLI returns unknown", async () => {
    const r = await checkAgentHealth({ ...cli, transport: "mcp", source: "mcp" }, makeSc());
    expect(r.status).toBe("unknown");
  });

  test("CLI with no command returns unknown", async () => {
    const r = await checkAgentHealth({ ...cli, command: undefined }, makeSc());
    expect(r.status).toBe("unknown");
  });
});
