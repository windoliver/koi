/**
 * Table-driven tests for validatePolicyForKind() and ToolPolicy types.
 */

import { describe, expect, test } from "bun:test";
import type { ToolPolicy } from "./ecs.js";
import { DEFAULT_SANDBOXED_POLICY, DEFAULT_UNSANDBOXED_POLICY } from "./ecs.js";
import type { BrickKind } from "./forge-types.js";
import { SANDBOX_REQUIRED_BY_KIND, validatePolicyForKind } from "./forge-types.js";

describe("validatePolicyForKind", () => {
  const validCases: ReadonlyArray<{
    readonly name: string;
    readonly policy: ToolPolicy;
    readonly kind: BrickKind;
  }> = [
    {
      name: "sandboxed tool is valid",
      policy: DEFAULT_SANDBOXED_POLICY,
      kind: "tool",
    },
    {
      name: "sandboxed skill is valid",
      policy: DEFAULT_SANDBOXED_POLICY,
      kind: "skill",
    },
    {
      name: "sandboxed agent is valid",
      policy: DEFAULT_SANDBOXED_POLICY,
      kind: "agent",
    },
    {
      name: "sandboxed composite is valid",
      policy: DEFAULT_SANDBOXED_POLICY,
      kind: "composite",
    },
    {
      name: "unsandboxed middleware is valid",
      policy: DEFAULT_UNSANDBOXED_POLICY,
      kind: "middleware",
    },
    {
      name: "unsandboxed channel is valid",
      policy: DEFAULT_UNSANDBOXED_POLICY,
      kind: "channel",
    },
    {
      name: "unsandboxed tool is valid (operator decision)",
      policy: DEFAULT_UNSANDBOXED_POLICY,
      kind: "tool",
    },
    {
      name: "empty capabilities with sandbox: true is valid",
      policy: { sandbox: true, capabilities: {} },
      kind: "tool",
    },
    {
      name: "network.allow:false with hosts is valid (hosts ignored when denied)",
      policy: {
        sandbox: true,
        capabilities: { network: { allow: false, hosts: ["example.com"] } },
      },
      kind: "tool",
    },
  ];

  for (const { name, policy, kind } of validCases) {
    test(name, () => {
      const result = validatePolicyForKind(policy, kind);
      expect(result.valid).toBe(true);
    });
  }

  const invalidCases: ReadonlyArray<{
    readonly name: string;
    readonly policy: ToolPolicy;
    readonly kind: BrickKind;
    readonly reasonContains: string;
  }> = [
    {
      name: "middleware with sandbox: true is invalid",
      policy: { sandbox: true, capabilities: {} },
      kind: "middleware",
      reasonContains: "middleware cannot have sandbox: true",
    },
    {
      name: "channel with sandbox: true is invalid",
      policy: { sandbox: true, capabilities: {} },
      kind: "channel",
      reasonContains: "channel cannot have sandbox: true",
    },
    {
      name: "timeoutMs: 0 is invalid",
      policy: {
        sandbox: true,
        capabilities: { resources: { timeoutMs: 0 } },
      },
      kind: "tool",
      reasonContains: "timeoutMs must be positive",
    },
    {
      name: "timeoutMs: -1 is invalid",
      policy: {
        sandbox: true,
        capabilities: { resources: { timeoutMs: -1 } },
      },
      kind: "tool",
      reasonContains: "timeoutMs must be positive",
    },
  ];

  for (const { name, policy, kind, reasonContains } of invalidCases) {
    test(name, () => {
      const result = validatePolicyForKind(policy, kind);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toContain(reasonContains);
      }
    });
  }
});

describe("SANDBOX_REQUIRED_BY_KIND", () => {
  test("tool, skill, agent, composite require sandbox", () => {
    expect(SANDBOX_REQUIRED_BY_KIND.tool).toBe(true);
    expect(SANDBOX_REQUIRED_BY_KIND.skill).toBe(true);
    expect(SANDBOX_REQUIRED_BY_KIND.agent).toBe(true);
    expect(SANDBOX_REQUIRED_BY_KIND.composite).toBe(true);
  });

  test("middleware and channel do not require sandbox", () => {
    expect(SANDBOX_REQUIRED_BY_KIND.middleware).toBe(false);
    expect(SANDBOX_REQUIRED_BY_KIND.channel).toBe(false);
  });
});

describe("DEFAULT_SANDBOXED_POLICY", () => {
  test("has sandbox: true", () => {
    expect(DEFAULT_SANDBOXED_POLICY.sandbox).toBe(true);
  });

  test("denies network by default", () => {
    expect(DEFAULT_SANDBOXED_POLICY.capabilities.network?.allow).toBe(false);
  });

  test("has filesystem read paths", () => {
    expect(DEFAULT_SANDBOXED_POLICY.capabilities.filesystem?.read).toBeDefined();
    expect(DEFAULT_SANDBOXED_POLICY.capabilities.filesystem?.read?.length).toBeGreaterThan(0);
  });

  test("has resource limits", () => {
    expect(DEFAULT_SANDBOXED_POLICY.capabilities.resources?.maxMemoryMb).toBe(512);
    expect(DEFAULT_SANDBOXED_POLICY.capabilities.resources?.timeoutMs).toBe(30_000);
    expect(DEFAULT_SANDBOXED_POLICY.capabilities.resources?.maxPids).toBe(64);
    expect(DEFAULT_SANDBOXED_POLICY.capabilities.resources?.maxOpenFiles).toBe(256);
  });
});

describe("DEFAULT_UNSANDBOXED_POLICY", () => {
  test("has sandbox: false", () => {
    expect(DEFAULT_UNSANDBOXED_POLICY.sandbox).toBe(false);
  });

  test("has empty capabilities", () => {
    expect(DEFAULT_UNSANDBOXED_POLICY.capabilities).toEqual({});
  });
});
