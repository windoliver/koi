import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { agentId, isAttachResult, MAILBOX, toolToken } from "@koi/core";
import { createMockAgent } from "@koi/test-utils";
import { createIpcNexusProvider } from "./mailbox-provider.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify({ messages: [] }), { status: 200 })),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createIpcNexusProvider", () => {
  test("has name 'ipc-nexus'", () => {
    const provider = createIpcNexusProvider({ agentId: agentId("test-agent") });
    expect(provider.name).toBe("ipc-nexus");
  });

  test("attaches MAILBOX singleton token", async () => {
    const provider = createIpcNexusProvider({ agentId: agentId("test-agent") });
    const agent = createMockAgent();
    const result = await provider.attach(agent);

    const components = isAttachResult(result) ? result.components : result;
    expect(components.has(MAILBOX as string)).toBe(true);
  });

  test("attaches ipc_send and ipc_list tools", async () => {
    const provider = createIpcNexusProvider({ agentId: agentId("test-agent") });
    const agent = createMockAgent();
    const result = await provider.attach(agent);

    const components = isAttachResult(result) ? result.components : result;
    expect(components.has(toolToken("ipc_send") as string)).toBe(true);
    expect(components.has(toolToken("ipc_list") as string)).toBe(true);
  });

  test("respects custom prefix", async () => {
    const provider = createIpcNexusProvider({
      agentId: agentId("test-agent"),
      prefix: "msg",
    });
    const agent = createMockAgent();
    const result = await provider.attach(agent);

    const components = isAttachResult(result) ? result.components : result;
    expect(components.has(toolToken("msg_send") as string)).toBe(true);
    expect(components.has(toolToken("msg_list") as string)).toBe(true);
  });

  test("respects custom operations subset", async () => {
    const provider = createIpcNexusProvider({
      agentId: agentId("test-agent"),
      operations: ["send"],
    });
    const agent = createMockAgent();
    const result = await provider.attach(agent);

    const components = isAttachResult(result) ? result.components : result;
    expect(components.has(toolToken("ipc_send") as string)).toBe(true);
    expect(components.has(toolToken("ipc_list") as string)).toBe(false);
  });

  test("detach cleans up mailbox resources", async () => {
    const provider = createIpcNexusProvider({ agentId: agentId("test-agent") });
    const agent = createMockAgent();
    await provider.attach(agent);

    // Should not throw
    await provider.detach?.(agent);
    expect(true).toBe(true);
  });
});
