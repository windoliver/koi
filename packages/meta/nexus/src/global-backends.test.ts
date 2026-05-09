import { describe, expect, test } from "bun:test";
import { createGlobalBackends } from "./global-backends.js";

describe("createGlobalBackends", () => {
  test("only wires live v2 singleton packages and omits archive-only names", async () => {
    const created: string[] = [];
    const backends = await createGlobalBackends(
      {
        registry: async () => (created.push("registry"), { kind: "registry" }),
        permissions: () => (created.push("permissions"), { kind: "permissions" }),
        audit: () => (created.push("audit"), { kind: "audit" }),
        search: () => (created.push("search"), { kind: "search" }),
        scheduler: () => (created.push("scheduler"), { kind: "scheduler" }),
      },
      { registry: true, permissions: true, audit: false, search: true, scheduler: true },
    );

    expect(created).toEqual(["registry", "permissions", "search", "scheduler"]);
    expect(backends.audit).toBeUndefined();
    expect("pay" in backends).toBe(false);
    expect("nameService" in backends).toBe(false);
  });
});
