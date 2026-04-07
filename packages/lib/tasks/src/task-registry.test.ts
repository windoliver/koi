import { describe, expect, mock, test } from "bun:test";
import type { TaskItemId } from "@koi/core";
import type { TaskOutputStream } from "./output-stream.js";
import type { RuntimeTaskBase } from "./task-kinds.js";
import { type TaskKindLifecycle, createTaskRegistry } from "./task-registry.js";

function makeLifecycle(kind: string): TaskKindLifecycle {
  return {
    kind: kind as TaskKindLifecycle["kind"],
    start: mock(async (_taskId: TaskItemId, _output: TaskOutputStream, _config: unknown): Promise<RuntimeTaskBase> => {
      throw new Error("not implemented");
    }),
    stop: mock(async (_state: RuntimeTaskBase): Promise<void> => {}),
  };
}

describe("createTaskRegistry", () => {
  test("register then get returns the lifecycle", () => {
    const registry = createTaskRegistry();
    const lifecycle = makeLifecycle("local_shell");
    registry.register(lifecycle);

    expect(registry.get("local_shell")).toBe(lifecycle);
  });

  test("get for unregistered kind returns undefined", () => {
    const registry = createTaskRegistry();
    expect(registry.get("dream")).toBeUndefined();
  });

  test("has returns true for registered kind", () => {
    const registry = createTaskRegistry();
    registry.register(makeLifecycle("local_agent"));

    expect(registry.has("local_agent")).toBe(true);
    expect(registry.has("dream")).toBe(false);
  });

  test("kinds returns all registered kind names", () => {
    const registry = createTaskRegistry();
    registry.register(makeLifecycle("local_shell"));
    registry.register(makeLifecycle("dream"));

    const kinds = registry.kinds();
    expect(kinds).toContain("local_shell");
    expect(kinds).toContain("dream");
    expect(kinds).toHaveLength(2);
  });

  test("duplicate registration throws", () => {
    const registry = createTaskRegistry();
    registry.register(makeLifecycle("local_shell"));

    expect(() => {
      registry.register(makeLifecycle("local_shell"));
    }).toThrow(/already registered/);
  });

  test("register multiple kinds independently", () => {
    const registry = createTaskRegistry();
    const shell = makeLifecycle("local_shell");
    const agent = makeLifecycle("local_agent");

    registry.register(shell);
    registry.register(agent);

    expect(registry.get("local_shell")).toBe(shell);
    expect(registry.get("local_agent")).toBe(agent);
  });
});
