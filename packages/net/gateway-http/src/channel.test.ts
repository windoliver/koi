import { describe, expect, test } from "bun:test";
import { createChannelRegistry } from "./channel.js";
import type { ChannelRegistration } from "./types.js";

const stubReg: ChannelRegistration = {
  id: "slack",
  secret: "s",
  replayProtection: "timestamp-only",
  authenticate: async () => ({ ok: true, value: { agentId: "a", tenantId: "t" } }),
  extractDeliveryId: () => "d1",
};

describe("createChannelRegistry", () => {
  test("register + get", () => {
    const r = createChannelRegistry();
    const result = r.register(stubReg);
    expect(result.ok).toBe(true);
    expect(r.get("slack")).toBe(stubReg);
  });

  test("duplicate id -> CONFLICT", () => {
    const r = createChannelRegistry();
    r.register(stubReg);
    const result = r.register(stubReg);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFLICT");
  });

  test("unknown id -> undefined", () => {
    const r = createChannelRegistry();
    expect(r.get("nope")).toBeUndefined();
  });

  test("ids() lists all registered", () => {
    const r = createChannelRegistry();
    r.register(stubReg);
    r.register({ ...stubReg, id: "discord" });
    expect(new Set(r.ids())).toEqual(new Set(["slack", "discord"]));
  });
});
