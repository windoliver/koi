import { describe, expect, it } from "bun:test";
import * as api from "../index.js";

describe("@koi/approval-zones public surface", () => {
  it("exports the documented value entry points", () => {
    expect(typeof api.createZoneEvaluator).toBe("function");
    expect(typeof api.createDefaultRiskScorer).toBe("function");
    expect(typeof api.matchesZone).toBe("function");
    expect(typeof api.compareRisk).toBe("function");
    expect(Array.isArray(api.READ_ONLY_PROFILE)).toBe(true);
    expect(Array.isArray(api.EDIT_TEST_FILES_PROFILE)).toBe(true);
    expect(Array.isArray(api.SCRIPTED_CLEANUP_PROFILE)).toBe(true);
  });
});
