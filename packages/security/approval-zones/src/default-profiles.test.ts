import { describe, expect, it } from "bun:test";
import type { PermissionQuery } from "@koi/core";
import {
  EDIT_TEST_FILES_PROFILE,
  READ_ONLY_PROFILE,
  SCRIPTED_CLEANUP_PROFILE,
} from "./default-profiles.js";
import { createZoneEvaluator } from "./evaluator.js";
import { createDefaultRiskScorer } from "./risk-scorer.js";

const scorer = createDefaultRiskScorer({ projectRoot: "/proj" });

function q(over: Partial<PermissionQuery>): PermissionQuery {
  return {
    principal: "agent:main",
    action: "read",
    resource: "/proj/x.ts",
    ...over,
  };
}

describe("READ_ONLY_PROFILE", () => {
  const ev = createZoneEvaluator({ zones: READ_ONLY_PROFILE, scorer });
  it("auto-approves read on project files", async () => {
    expect((await ev.evaluate(q({}))).kind).toBe("auto");
  });
  it("does not auto-approve write", async () => {
    expect((await ev.evaluate(q({ action: "write" }))).kind).toBe("ask");
  });
  it("does not auto-approve read on .env", async () => {
    expect((await ev.evaluate(q({ resource: "/proj/.env" }))).kind).toBe("ask");
  });
});

describe("EDIT_TEST_FILES_PROFILE", () => {
  const ev = createZoneEvaluator({ zones: EDIT_TEST_FILES_PROFILE, scorer });
  it("auto-approves edits to .test.ts", async () => {
    expect((await ev.evaluate(q({ action: "edit", resource: "/proj/foo.test.ts" }))).kind).toBe(
      "auto",
    );
  });
  it("does not auto-approve edits to non-test files", async () => {
    expect((await ev.evaluate(q({ action: "edit", resource: "/proj/foo.ts" }))).kind).toBe("ask");
  });
});

describe("SCRIPTED_CLEANUP_PROFILE", () => {
  const ev = createZoneEvaluator({ zones: SCRIPTED_CLEANUP_PROFILE, scorer });
  it("returns sandbox verdict for bash on /tmp", async () => {
    const v = await ev.evaluate(
      q({ action: "bash", resource: "/tmp/work", context: { command: "ls /tmp/work" } }),
    );
    expect(v.kind).toBe("sandbox");
  });
  it("falls back to ask for bash outside /tmp", async () => {
    const v = await ev.evaluate(
      q({ action: "bash", resource: "/proj", context: { command: "ls /proj" } }),
    );
    expect(v.kind).toBe("ask");
  });
});
