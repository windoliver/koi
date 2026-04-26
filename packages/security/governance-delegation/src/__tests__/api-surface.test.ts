import { describe, expect, it } from "bun:test";
import * as api from "../index.js";

describe("@koi/governance-delegation API surface", () => {
  it("exports the documented factory functions", () => {
    expect(typeof api.createCapabilityVerifier).toBe("function");
    expect(typeof api.createGlobScopeChecker).toBe("function");
    expect(typeof api.createMemoryCapabilityRevocationRegistry).toBe("function");
    expect(typeof api.issueRootCapability).toBe("function");
    expect(typeof api.delegateCapability).toBe("function");
  });
});
