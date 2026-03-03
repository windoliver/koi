import { describe, expect, test } from "bun:test";
import type { Agent, GuardContext } from "@koi/core";
import { EXTENSION_PRIORITY } from "@koi/core";
import { createMockAgent } from "@koi/test-utils";
import { createContextExtension } from "./extension.js";

/** Minimal GuardContext for testing. */
function createGuardCtx(agent: Agent): GuardContext {
  return {
    agentDepth: 0,
    manifest: agent.manifest,
    components: agent.components(),
    agent,
  };
}

describe("createContextExtension", () => {
  test("returns undefined when rawConfig is undefined", () => {
    const result = createContextExtension(undefined);
    expect(result).toBeUndefined();
  });

  test("returns undefined when rawConfig is null", () => {
    const result = createContextExtension(null);
    expect(result).toBeUndefined();
  });

  test("throws on invalid context config", () => {
    expect(() => createContextExtension({ invalid: true })).toThrow(
      "Invalid context configuration",
    );
  });

  test("returns KernelExtension with correct name and priority", () => {
    const ext = createContextExtension({
      sources: [{ kind: "text", text: "Hello" }],
    });
    expect(ext).toBeDefined();
    expect(ext?.name).toBe("koi:context-hydrator");
    expect(ext?.priority).toBe(EXTENSION_PRIORITY.USER);
  });

  test("guards produces context hydrator middleware", async () => {
    const ext = createContextExtension({
      sources: [{ kind: "text", text: "System context" }],
    });
    expect(ext).toBeDefined();
    expect(ext?.guards).toBeDefined();

    const agent = createMockAgent();
    const ctx = createGuardCtx(agent);
    const middleware = await ext?.guards?.(ctx);

    expect(middleware).toHaveLength(1);
    expect(middleware?.[0]?.name).toBe("context-hydrator");
  });

  test("guards throws when agent is undefined in GuardContext", () => {
    const ext = createContextExtension({
      sources: [{ kind: "text", text: "test" }],
    });

    const ctx: GuardContext = {
      agentDepth: 0,
      manifest: createMockAgent().manifest,
      components: new Map(),
      // agent is undefined
    };

    expect(() => ext?.guards?.(ctx)).toThrow("requires agent in GuardContext");
  });

  test("validates complex context config with multiple sources", async () => {
    const ext = createContextExtension({
      sources: [
        { kind: "text", text: "Instructions", label: "System", priority: 1 },
        { kind: "skill", name: "code-review", required: true },
      ],
      maxTokens: 4000,
      refreshInterval: 5,
    });
    expect(ext).toBeDefined();

    const agent = createMockAgent();
    const middleware = await ext?.guards?.(createGuardCtx(agent));
    expect(middleware).toHaveLength(1);
  });
});
