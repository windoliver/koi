import { describe, expect, test } from "bun:test";
import {
  createMapAgentResolver,
  createTaskToolDescriptor,
  isTaskSpawnFailure,
  isTaskSpawnSuccess,
} from "./types.js";

describe("createTaskToolDescriptor", () => {
  test("uses generic schema when no agents", () => {
    const d = createTaskToolDescriptor([]);
    const props = (d.inputSchema as { properties: Record<string, { enum?: unknown[] }> })
      .properties;
    expect(props.agent_type?.enum).toBeUndefined();
  });

  test("populates agent_type enum from summaries", () => {
    const d = createTaskToolDescriptor([
      { key: "researcher", name: "Researcher", description: "Web research" },
      { key: "coder", name: "Coder", description: "Code generation" },
    ]);
    const props = (d.inputSchema as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(props.agent_type?.enum).toEqual(["researcher", "coder"]);
  });
});

describe("type guards", () => {
  test("isTaskSpawnSuccess", () => {
    expect(isTaskSpawnSuccess({ ok: true, output: "x" })).toBe(true);
    expect(isTaskSpawnSuccess({ ok: false, error: "y" })).toBe(false);
  });
  test("isTaskSpawnFailure", () => {
    expect(isTaskSpawnFailure({ ok: false, error: "y" })).toBe(true);
    expect(isTaskSpawnFailure({ ok: true, output: "x" })).toBe(false);
  });
});

describe("createMapAgentResolver", () => {
  test("resolves keys present in the map", () => {
    const r = createMapAgentResolver(
      new Map([
        [
          "x",
          {
            name: "X",
            description: "x agent",
            manifest: { name: "X", version: "1.0.0", model: { name: "m" } },
          },
        ],
      ]),
    );
    const ok = r.resolve("x");
    expect("ok" in ok && ok.ok === true).toBe(true);
  });

  test("returns NOT_FOUND for missing key", () => {
    const r = createMapAgentResolver(new Map());
    const result = r.resolve("missing");
    if ("ok" in result && result.ok === false) {
      expect(result.error.code).toBe("NOT_FOUND");
    } else {
      throw new Error("expected NOT_FOUND");
    }
  });

  test("list returns summaries derived from the map", () => {
    const r = createMapAgentResolver(
      new Map([
        [
          "y",
          {
            name: "Y",
            description: "y agent",
            manifest: { name: "Y", version: "1.0.0", model: { name: "m" } },
          },
        ],
      ]),
    );
    const list = r.list();
    expect(Array.isArray(list)).toBe(true);
    if (Array.isArray(list)) {
      expect(list[0]?.key).toBe("y");
    }
  });
});
