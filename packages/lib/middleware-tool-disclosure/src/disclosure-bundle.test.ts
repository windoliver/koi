import { describe, expect, test } from "bun:test";
import type { Agent, JsonObject } from "@koi/core";
import { isAttachResult } from "@koi/core";
import { createToolDisclosureBundle } from "./disclosure-bundle.js";
import { PROMOTE_TOOL_NAME } from "./tool-disclosure-middleware.js";

const fakeAgent = {} as Agent;

async function attachComponents(
  bundle: ReturnType<typeof createToolDisclosureBundle>,
): Promise<ReadonlyMap<string, unknown>> {
  const provider = bundle.providers[0];
  if (!provider) throw new Error("provider missing");
  const result = await provider.attach(fakeAgent);
  return isAttachResult(result) ? result.components : result;
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
    const fragment = bundle.middleware.describeCapabilities?.(
      // biome-ignore lint/suspicious/noExplicitAny: context is unused by this hook
      {} as any,
    );
    expect(fragment?.label).toBe("tool-disclosure");
  });

  describe("promote_tools execute", () => {
    async function getTool(): Promise<{
      readonly execute: (args: JsonObject) => Promise<unknown>;
    }> {
      const bundle = createToolDisclosureBundle();
      const components = await attachComponents(bundle);
      const tool = components.get(`tool:${PROMOTE_TOOL_NAME}`) as {
        readonly execute: (args: JsonObject) => Promise<unknown>;
      };
      return tool;
    }

    test("rejects non-array names", async () => {
      const tool = await getTool();
      const result = (await tool.execute({ names: "not-array" })) as {
        readonly ok: boolean;
        readonly error?: { readonly code: string };
      };
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("VALIDATION");
    });

    test("rejects empty names array", async () => {
      const tool = await getTool();
      const result = (await tool.execute({ names: [] })) as {
        readonly ok: boolean;
        readonly error?: { readonly code: string };
      };
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("VALIDATION");
    });

    test("rejects names with no string entries", async () => {
      const tool = await getTool();
      const result = (await tool.execute({ names: [1, 2, 3] })) as {
        readonly ok: boolean;
        readonly error?: { readonly code: string };
      };
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("VALIDATION");
    });

    test("promotes 0 tools when middleware has no known names yet", async () => {
      const tool = await getTool();
      const result = (await tool.execute({ names: ["foo"] })) as {
        readonly ok: boolean;
        readonly promoted: readonly string[];
        readonly message: string;
      };
      expect(result.ok).toBe(true);
      expect(result.promoted).toEqual([]);
      expect(result.message).toContain("No tools were promoted");
    });
  });
});
