import { describe, expect, it } from "bun:test";
import type {
  Agent,
  AgentId,
  AgentManifest,
  AttachResult,
  ProcessId,
  SubsystemToken,
  Tool,
} from "@koi/core";
import { EXTERNAL_AGENTS, isAttachResult, toolToken } from "@koi/core";
import { createDiscoveryProvider } from "./component-provider.js";
import type { SystemCalls } from "./types.js";

/** Extract the components map from an attach result (handles union return type). */
function getComponents(
  result: ReadonlyMap<string, unknown> | AttachResult,
): ReadonlyMap<string, unknown> {
  return isAttachResult(result) ? result.components : result;
}

function createStubAgent(): Agent {
  const pid: ProcessId = {
    id: "test-agent" as AgentId,
    name: "test",
    type: "copilot",
    depth: 0,
  };
  const components = new Map<string, unknown>();
  return {
    pid,
    manifest: {} as AgentManifest,
    state: "running",
    component: <T>(token: SubsystemToken<T>): T | undefined =>
      components.get(token as string) as T | undefined,
    has: (token: SubsystemToken<unknown>): boolean => components.has(token as string),
    hasAll: (...tokens: readonly SubsystemToken<unknown>[]): boolean =>
      tokens.every((t) => components.has(t as string)),
    query: <T>(_prefix: string): ReadonlyMap<SubsystemToken<T>, T> => new Map(),
    components: (): ReadonlyMap<string, unknown> => components,
  };
}

const noopSystemCalls: SystemCalls = {
  which: () => null,
  exec: async () => ({ exitCode: 0, stdout: "" }),
};

describe("createDiscoveryProvider", () => {
  it("has name 'agent-discovery'", () => {
    const provider = createDiscoveryProvider({ systemCalls: noopSystemCalls });
    expect(provider.name).toBe("agent-discovery");
  });

  it("attaches discover_agents tool", async () => {
    const provider = createDiscoveryProvider({ systemCalls: noopSystemCalls });
    const agent = createStubAgent();
    const raw = await provider.attach(agent);
    const result = getComponents(raw);

    const toolKey = toolToken("discover_agents") as string;
    expect(result.has(toolKey)).toBe(true);

    const tool = result.get(toolKey) as Tool;
    expect(tool.descriptor.name).toBe("discover_agents");
    expect(tool.policy.sandbox).toBe(false);
  });

  it("attaches EXTERNAL_AGENTS singleton", async () => {
    const provider = createDiscoveryProvider({ systemCalls: noopSystemCalls });
    const agent = createStubAgent();
    const raw = await provider.attach(agent);
    const result = getComponents(raw);

    const agentsKey = EXTERNAL_AGENTS as string;
    expect(result.has(agentsKey)).toBe(true);

    const agents = result.get(agentsKey) as readonly unknown[];
    expect(Array.isArray(agents)).toBe(true);
  });
});
