import { afterEach, describe, expect, mock, test } from "bun:test";
import type { MemoryComponent, MemoryResult, MemoryStoreOptions } from "@koi/core/ecs";
import { createPersonalizationMiddleware } from "./personalization.js";

function createMockMemory(): MemoryComponent {
  return {
    async recall(): Promise<readonly MemoryResult[]> {
      return [];
    },
    async store(_content: string, _options?: MemoryStoreOptions): Promise<void> {},
  };
}

describe("createPersonalizationMiddleware (deprecation shim)", () => {
  const originalWarn = console.warn;

  afterEach(() => {
    console.warn = originalWarn;
  });

  test("factory delegates to mw-user-model and returns valid middleware", () => {
    const warnings: string[] = [];
    console.warn = mock((...args: unknown[]) => {
      warnings.push(String(args[0]));
    });

    const mw = createPersonalizationMiddleware({ memory: createMockMemory() });

    // Middleware was created by the unified user-model factory
    expect(mw.name).toBe("user-model");
    expect(mw.priority).toBe(415);
    expect(mw.describeCapabilities).toBeDefined();
    expect(mw.wrapModelCall).toBeDefined();
  });

  test("factory emits deprecation warning", () => {
    const warnings: string[] = [];
    console.warn = mock((...args: unknown[]) => {
      warnings.push(String(args[0]));
    });

    createPersonalizationMiddleware({ memory: createMockMemory() });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("DEPRECATED");
    expect(warnings[0]).toContain("middleware-user-model");
  });
});
