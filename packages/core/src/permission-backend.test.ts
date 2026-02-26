import { describe, expect, test } from "bun:test";
import type {
  PermissionBackend,
  PermissionDecision,
  PermissionQuery,
} from "./permission-backend.js";

describe("PermissionBackend interface", () => {
  test("minimal sync implementation satisfies the interface", () => {
    const backend = {
      check(_query: PermissionQuery): PermissionDecision {
        return { effect: "allow" };
      },
    } satisfies PermissionBackend;

    const result = backend.check({ principal: "agent-1", action: "invoke", resource: "calc" });
    expect(result.effect).toBe("allow");
  });

  test("async implementation satisfies the interface", async () => {
    const backend = {
      async check(_query: PermissionQuery): Promise<PermissionDecision> {
        return { effect: "deny", reason: "not authorized" };
      },
    } satisfies PermissionBackend;

    const result = await backend.check({ principal: "agent-1", action: "invoke", resource: "rm" });
    expect(result.effect).toBe("deny");
    if (result.effect === "deny") {
      expect(result.reason).toBe("not authorized");
    }
  });

  test("implementation with optional methods satisfies the interface", () => {
    const backend = {
      check(_query: PermissionQuery): PermissionDecision {
        return { effect: "allow" };
      },
      checkBatch(queries: readonly PermissionQuery[]): readonly PermissionDecision[] {
        return queries.map(() => ({ effect: "allow" }) as PermissionDecision);
      },
      dispose(): void {
        // cleanup
      },
    } satisfies PermissionBackend;

    expect(backend.checkBatch).toBeDefined();
    expect(backend.dispose).toBeDefined();
  });
});
