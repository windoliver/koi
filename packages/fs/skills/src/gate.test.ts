import { describe, expect, test } from "bun:test";
import type { BrickRequires, CredentialComponent, SkillConfig } from "@koi/core";
import { gateSkills, gateSkillsWithCredentials } from "./gate.js";

function mockCredentialComponent(store: Readonly<Record<string, string>>): CredentialComponent {
  return {
    get: async (key: string): Promise<string | undefined> => store[key],
  };
}

function skill(name: string): SkillConfig {
  return { name, source: { kind: "filesystem", path: `./skills/${name}` } };
}

describe("gateSkills", () => {
  test("passes skills without requires", () => {
    const result = gateSkills([skill("a"), skill("b")]);
    expect(result.eligible).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
  });

  test("skips skills with unsatisfied platform", () => {
    const requiresMap = new Map<string, BrickRequires>([["a", { platform: ["freebsd"] }]]);
    const result = gateSkills([skill("a"), skill("b")], requiresMap);
    expect(result.eligible).toHaveLength(1);
    expect(result.eligible[0]?.name).toBe("b");
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.name).toBe("a");
  });
});

describe("gateSkillsWithCredentials", () => {
  test("passes all skills when credentials are available", async () => {
    const skills = [skill("a"), skill("b")];
    const requiresMap = new Map<string, BrickRequires>([
      ["a", { credentials: { db: { kind: "connection_string", ref: "DB_URL" } } }],
    ]);
    const creds = mockCredentialComponent({ DB_URL: "postgres://localhost" });
    const result = await gateSkillsWithCredentials(skills, requiresMap, creds);
    expect(result.eligible).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
  });

  test("skips skills with missing credentials", async () => {
    const skills = [skill("a")];
    const requiresMap = new Map<string, BrickRequires>([
      ["a", { credentials: { db: { kind: "connection_string", ref: "DB_URL" } } }],
    ]);
    const creds = mockCredentialComponent({});
    const result = await gateSkillsWithCredentials(skills, requiresMap, creds);
    expect(result.eligible).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.reason).toContain("db");
  });

  test("deduplicates credential refs across skills", async () => {
    let callCount = 0;
    const creds: CredentialComponent = {
      get: async (key: string): Promise<string | undefined> => {
        callCount++;
        return key === "SHARED_KEY" ? "value" : undefined;
      },
    };
    const skills = [skill("a"), skill("b")];
    const requiresMap = new Map<string, BrickRequires>([
      ["a", { credentials: { k1: { kind: "api_key", ref: "SHARED_KEY" } } }],
      ["b", { credentials: { k2: { kind: "api_key", ref: "SHARED_KEY" } } }],
    ]);
    const result = await gateSkillsWithCredentials(skills, requiresMap, creds);
    expect(result.eligible).toHaveLength(2);
    // SHARED_KEY resolved only once
    expect(callCount).toBe(1);
  });

  test("falls back to sync gating when no credential component", async () => {
    const skills = [skill("a")];
    const requiresMap = new Map<string, BrickRequires>([
      ["a", { credentials: { db: { kind: "connection_string", ref: "DB_URL" } } }],
    ]);
    // No credential component → should not reject on credentials
    const result = await gateSkillsWithCredentials(skills, requiresMap, undefined);
    expect(result.eligible).toHaveLength(1);
  });
});
