import { describe, expect, it } from "bun:test";
import { compareRisk } from "./risk-types.js";
import type { ApprovalZone, ZoneAction, ZoneVerdict } from "./zone-types.js";

describe("zone-types", () => {
  it("ZoneAction has exactly the three documented actions", () => {
    const actions: ZoneAction[] = ["auto", "ask", "sandbox-then-auto"];
    expect(actions).toHaveLength(3);
  });

  it("ApprovalZone shape compiles with all optional fields omitted", () => {
    const zone: ApprovalZone = { name: "x", match: {}, action: "ask" };
    expect(zone.name).toBe("x");
  });

  it("ZoneVerdict has 3 discriminated cases", () => {
    const v1: ZoneVerdict = { kind: "auto", zone: "z", risk: "low" };
    const v2: ZoneVerdict = { kind: "sandbox", zone: "z", risk: "low", backendId: "default" };
    const v3: ZoneVerdict = { kind: "ask", reason: "no-match" };
    expect([v1.kind, v2.kind, v3.kind]).toEqual(["auto", "sandbox", "ask"]);
  });
});

describe("compareRisk", () => {
  it("orders low < medium < high < critical", () => {
    expect(compareRisk("low", "critical")).toBeLessThan(0);
    expect(compareRisk("critical", "low")).toBeGreaterThan(0);
    expect(compareRisk("medium", "medium")).toBe(0);
  });
});
