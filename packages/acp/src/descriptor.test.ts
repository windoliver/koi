/**
 * Tests for the ACP server BrickDescriptor.
 */

import { describe, expect, test } from "bun:test";
import type { ResolutionContext } from "@koi/resolve";
import { descriptor } from "./descriptor.js";

const MOCK_CONTEXT: ResolutionContext = {
  manifestDir: "/tmp/test",
  manifest: { name: "test-agent", version: "0.1.0", model: { name: "mock:test" } },
  env: {},
};

describe("descriptor", () => {
  test("has correct metadata", () => {
    expect(descriptor.kind).toBe("channel");
    expect(descriptor.name).toBe("@koi/acp");
    expect(descriptor.aliases).toContain("acp-server");
    expect(descriptor.tags).toContain("acp");
    expect(descriptor.tags).toContain("ide");
  });

  test("has companion skills", () => {
    expect(descriptor.companionSkills).toBeDefined();
    expect(descriptor.companionSkills?.length).toBeGreaterThan(0);
    expect(descriptor.companionSkills?.[0]?.name).toBe("acp-server-guide");
  });

  test("options validator accepts undefined", () => {
    const result = descriptor.optionsValidator?.(undefined);
    expect(result?.ok).toBe(true);
  });

  test("options validator accepts empty object", () => {
    const result = descriptor.optionsValidator?.({});
    expect(result?.ok).toBe(true);
  });

  test("options validator accepts valid config", () => {
    const result = descriptor.optionsValidator?.({
      agentInfo: { name: "test" },
    });
    expect(result?.ok).toBe(true);
  });

  test("options validator rejects non-object", () => {
    const result = descriptor.optionsValidator?.("invalid");
    expect(result?.ok).toBe(false);
  });

  test("factory produces a ChannelAdapter", async () => {
    const channel = await descriptor.factory({}, MOCK_CONTEXT);
    expect(channel.name).toBe("acp");
    expect(typeof channel.connect).toBe("function");
    expect(typeof channel.disconnect).toBe("function");
    expect(typeof channel.send).toBe("function");
    expect(typeof channel.onMessage).toBe("function");
  });
});
