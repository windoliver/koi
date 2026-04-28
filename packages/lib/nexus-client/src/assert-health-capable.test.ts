import { describe, expect, test } from "bun:test";
import { assertHealthCapable, assertProductionTransport } from "./assert-health-capable.js";
import type { NexusTransport } from "./types.js";

const baseStub: NexusTransport = {
  call: async <T>() => ({ ok: true, value: undefined as T }),
  close: () => {},
};

describe("assertHealthCapable", () => {
  test("throws when health is missing", () => {
    expect(() => assertHealthCapable(baseStub)).toThrow(/missing required `health\(\)`/);
  });

  test("passes when health is present", () => {
    const t: NexusTransport = {
      ...baseStub,
      health: async () => ({
        ok: true,
        value: { status: "ok", version: "v1", latencyMs: 1, probed: ["version"] },
      }),
    };
    expect(() => assertHealthCapable(t)).not.toThrow();
  });
});

describe("assertProductionTransport", () => {
  test("throws when kind is missing", () => {
    expect(() => assertProductionTransport(baseStub)).toThrow(/missing required `kind`/);
  });

  test("passes when kind is set", () => {
    const t: NexusTransport = { ...baseStub, kind: "http" };
    expect(() => assertProductionTransport(t)).not.toThrow();
  });
});
