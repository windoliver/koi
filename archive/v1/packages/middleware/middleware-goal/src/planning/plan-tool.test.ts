import { describe, expect, test } from "bun:test";
import { PLAN_SYSTEM_PROMPT, WRITE_PLAN_DESCRIPTOR, WRITE_PLAN_TOOL_NAME } from "./plan-tool.js";

describe("WRITE_PLAN_TOOL_NAME", () => {
  test("is write_plan", () => {
    expect(WRITE_PLAN_TOOL_NAME).toBe("write_plan");
  });
});

describe("WRITE_PLAN_DESCRIPTOR", () => {
  test("has correct name", () => {
    expect(WRITE_PLAN_DESCRIPTOR.name).toBe("write_plan");
  });

  test("has a description", () => {
    expect(WRITE_PLAN_DESCRIPTOR.description.length).toBeGreaterThan(0);
  });

  test("has inputSchema with plan array", () => {
    const schema = WRITE_PLAN_DESCRIPTOR.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["plan"]);
    const props = schema.properties as Record<string, unknown>;
    const plan = props.plan as Record<string, unknown>;
    expect(plan.type).toBe("array");
  });
});

describe("PLAN_SYSTEM_PROMPT", () => {
  test("mentions write_plan", () => {
    expect(PLAN_SYSTEM_PROMPT).toContain("write_plan");
  });

  test("is concise (under 500 chars)", () => {
    expect(PLAN_SYSTEM_PROMPT.length).toBeLessThan(500);
  });

  test("mentions at-most-once rule", () => {
    expect(PLAN_SYSTEM_PROMPT).toContain("at most once");
  });
});
