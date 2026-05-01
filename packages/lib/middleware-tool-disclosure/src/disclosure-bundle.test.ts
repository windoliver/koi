import { describe, expect, test } from "bun:test";
import type { Agent, JsonObject, ToolRequest, ToolResponse, TurnContext } from "@koi/core";
import { isAttachResult } from "@koi/core";
import { createMockTurnContext } from "@koi/test";
import { createToolDisclosureBundle } from "./disclosure-bundle.js";
import { PROMOTE_TOOL_NAME } from "./tool-disclosure-middleware.js";

const fakeAgent = {} as Agent;
const ctx: TurnContext = createMockTurnContext();

async function attachComponents(
  bundle: ReturnType<typeof createToolDisclosureBundle>,
): Promise<ReadonlyMap<string, unknown>> {
  const provider = bundle.providers[0];
  if (!provider) throw new Error("provider missing");
  const result = await provider.attach(fakeAgent);
  return isAttachResult(result) ? result.components : result;
}

async function callPromoteViaMiddleware(
  bundle: ReturnType<typeof createToolDisclosureBundle>,
  input: JsonObject,
): Promise<ToolResponse> {
  const wrap = bundle.middleware.wrapToolCall;
  if (!wrap) throw new Error("wrapToolCall missing");
  const request: ToolRequest = { toolId: PROMOTE_TOOL_NAME, input };
  return wrap(ctx, request, async (_req): Promise<ToolResponse> => {
    throw new Error("next() should not be called for promote_tools");
  });
}

describe("createToolDisclosureBundle", () => {
  test("returns middleware + a single provider", () => {
    const bundle = createToolDisclosureBundle();
    expect(bundle.middleware.name).toBe("tool-disclosure");
    expect(bundle.providers).toHaveLength(1);
    expect(bundle.providers[0]?.name).toBe("tool-disclosure");
  });

  test("registers companion tool component", async () => {
    const bundle = createToolDisclosureBundle();
    const components = await attachComponents(bundle);
    expect(components.has(`tool:${PROMOTE_TOOL_NAME}`)).toBe(true);
  });

  test("middleware advertises companion tool after bundle creation", () => {
    const bundle = createToolDisclosureBundle();
    const fragment = bundle.middleware.describeCapabilities?.(ctx);
    expect(fragment?.label).toBe("tool-disclosure");
  });

  describe("Tool.execute fallback (middleware not registered)", () => {
    test("returns INTERNAL error explaining middleware is required", async () => {
      const bundle = createToolDisclosureBundle();
      const components = await attachComponents(bundle);
      const tool = components.get(`tool:${PROMOTE_TOOL_NAME}`) as {
        readonly execute: (args: JsonObject) => Promise<unknown>;
      };
      const result = (await tool.execute({ names: ["foo"] })) as {
        readonly ok: boolean;
        readonly error?: { readonly code: string; readonly message: string };
      };
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("INTERNAL");
      expect(result.error?.message).toContain("middleware");
    });
  });

  describe("middleware wrapToolCall handles promote_tools (the real path)", () => {
    test("rejects non-array names with VALIDATION error", async () => {
      const bundle = createToolDisclosureBundle();
      const response = await callPromoteViaMiddleware(bundle, { names: "not-array" });
      const out = response.output as { ok: boolean; error?: { code: string } };
      expect(out.ok).toBe(false);
      expect(out.error?.code).toBe("VALIDATION");
    });

    test("rejects empty names array with VALIDATION error", async () => {
      const bundle = createToolDisclosureBundle();
      const response = await callPromoteViaMiddleware(bundle, { names: [] });
      const out = response.output as { ok: boolean; error?: { code: string } };
      expect(out.ok).toBe(false);
      expect(out.error?.code).toBe("VALIDATION");
    });

    test("rejects names with no string entries", async () => {
      const bundle = createToolDisclosureBundle();
      const response = await callPromoteViaMiddleware(bundle, { names: [1, 2, 3] });
      const out = response.output as { ok: boolean; error?: { code: string } };
      expect(out.ok).toBe(false);
      expect(out.error?.code).toBe("VALIDATION");
    });

    test("returns ok with empty promoted list when no known names yet", async () => {
      const bundle = createToolDisclosureBundle();
      const response = await callPromoteViaMiddleware(bundle, { names: ["foo"] });
      const out = response.output as {
        ok: boolean;
        promoted: readonly string[];
        message: string;
      };
      expect(out.ok).toBe(true);
      expect(out.promoted).toEqual([]);
      expect(out.message).toContain("No tools were promoted");
    });
  });
});
