import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  AGENT_MESSAGE_SIGNAL,
  AGENT_STATE_QUERY,
  RETRY_WORKFLOW_NAME,
  SCHEDULED_TASK_WORKFLOW_NAME,
  agentWorkflow,
  retryWorkflow,
  scheduledTaskWorkflow,
} from "../workflows/index.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(TEST_DIR, "..", "..");
const FIXTURE = join(TEST_DIR, "fixtures", "workflows-boundary.ts");
const AMBIENT = join(TEST_DIR, "fixtures", "workflows-boundary.ambient.d.ts");

function runTypecheckFixture() {
  return spawnSync(
    "bunx",
    [
      "tsc",
      "--noEmit",
      "--ignoreConfig",
      "--pretty",
      "false",
      "--target",
      "ES2022",
      "--module",
      "ESNext",
      "--moduleResolution",
      "bundler",
      "--lib",
      "ES2022,DOM,ESNext.Disposable",
      "--noImplicitAny",
      "false",
      "--noImplicitReturns",
      "false",
      "--strict",
      "false",
      "--strictNullChecks",
      "false",
      FIXTURE,
      AMBIENT,
    ],
    {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
    },
  );
}

describe("temporal workflow public surface", () => {
  test("exports Koi-owned workflow type names through the package boundary", () => {
    const result = runTypecheckFixture();

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  }, 30_000);
});

describe("workflow module surface", () => {
  test("exports stable workflow names and signal names", () => {
    expect(AGENT_MESSAGE_SIGNAL).toBe("agent.message");
    expect(AGENT_STATE_QUERY).toBe("agent.state");
    expect(SCHEDULED_TASK_WORKFLOW_NAME).toBe("scheduledTaskWorkflow");
    expect(RETRY_WORKFLOW_NAME).toBe("retryWorkflow");
  });

  test("exports workflow entry point functions", () => {
    expect(typeof agentWorkflow).toBe("function");
    expect(typeof scheduledTaskWorkflow).toBe("function");
    expect(typeof retryWorkflow).toBe("function");
  });
});
