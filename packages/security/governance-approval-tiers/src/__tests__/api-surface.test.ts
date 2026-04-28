import { describe, expect, it } from "bun:test";
import * as api from "../index.js";

describe("@koi/governance-approval-tiers API surface", () => {
  it("exports the documented factory functions", () => {
    expect(typeof api.createJsonlApprovalStore).toBe("function");
    expect(typeof api.createPersistSink).toBe("function");
    expect(typeof api.wrapBackendWithPersistedAllowlist).toBe("function");
    expect(typeof api.createViolationAuditAdapter).toBe("function");
    expect(typeof api.applyAliases).toBe("function");
  });
});
