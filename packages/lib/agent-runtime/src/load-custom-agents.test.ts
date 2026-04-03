/**
 * Tests for custom agent loading, registry, and resolver.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentDefinitionRegistry } from "./agent-definition-registry.js";
import { getBuiltInAgents } from "./built-in/index.js";
import { createDefinitionResolver } from "./definition-resolver.js";
import { loadCustomAgents } from "./load-custom-agents.js";

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = join(tmpdir(), `koi-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempDir, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function writeAgentFile(baseDir: string, filename: string, content: string): void {
  const agentsDir = join(baseDir, ".koi", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(join(agentsDir, filename), content, "utf-8");
}

const VALID_AGENT = `---
name: custom-agent
description: A custom agent for testing
model: haiku
---

You are a test agent.`;

const INVALID_AGENT = `---
description: Missing name field
---

No name here.`;

// ---------------------------------------------------------------------------
// loadCustomAgents tests
// ---------------------------------------------------------------------------

describe("loadCustomAgents", () => {
  test("discovers all .md files in a directory", () => {
    writeAgentFile(tempDir, "agent-one.md", VALID_AGENT);
    writeAgentFile(tempDir, "agent-two.md", VALID_AGENT.replace("custom-agent", "agent-two"));

    const result = loadCustomAgents({ projectDir: tempDir });
    expect(result.agents.length).toBe(2);
    expect(result.warnings.length).toBe(0);
  });

  test("ignores non-.md files", () => {
    writeAgentFile(tempDir, "agent.md", VALID_AGENT);
    const agentsDir = join(tempDir, ".koi", "agents");
    writeFileSync(join(agentsDir, "README.txt"), "not an agent", "utf-8");
    writeFileSync(join(agentsDir, "config.yaml"), "also: not", "utf-8");

    const result = loadCustomAgents({ projectDir: tempDir });
    expect(result.agents.length).toBe(1);
  });

  test("missing directory returns empty list, no error", () => {
    const result = loadCustomAgents({ projectDir: "/nonexistent/path" });
    expect(result.agents.length).toBe(0);
    expect(result.warnings.length).toBe(0);
  });

  test("parse failure on one file produces warning, other files still load", () => {
    writeAgentFile(tempDir, "good.md", VALID_AGENT);
    writeAgentFile(tempDir, "bad.md", INVALID_AGENT);

    const result = loadCustomAgents({ projectDir: tempDir });
    expect(result.agents.length).toBe(1);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]?.error.code).toBe("VALIDATION");
  });

  test("tags agents with correct source based on directory", () => {
    const userDir = join(tempDir, "user");
    const projectDir = join(tempDir, "project");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    writeAgentFile(userDir, "user-agent.md", VALID_AGENT.replace("custom-agent", "user-agent"));
    writeAgentFile(
      projectDir,
      "project-agent.md",
      VALID_AGENT.replace("custom-agent", "project-agent"),
    );

    const result = loadCustomAgents({ userDir, projectDir });
    const userAgent = result.agents.find((a) => a.agentType === "user-agent");
    const projectAgent = result.agents.find((a) => a.agentType === "project-agent");

    expect(userAgent?.source).toBe("user");
    expect(projectAgent?.source).toBe("project");
  });
});

// ---------------------------------------------------------------------------
// createAgentDefinitionRegistry tests
// ---------------------------------------------------------------------------

describe("createAgentDefinitionRegistry", () => {
  test("priority override: project agent overrides built-in with same name", () => {
    const builtIn = getBuiltInAgents();
    const customResearcher = `---
name: researcher
description: Custom project researcher override
model: opus
---

Overridden researcher prompt.`;

    writeAgentFile(tempDir, "researcher.md", customResearcher);
    const { agents: custom } = loadCustomAgents({ projectDir: tempDir });

    const registry = createAgentDefinitionRegistry(builtIn, custom);
    const resolved = registry.resolve("researcher");

    expect(resolved).toBeDefined();
    expect(resolved?.source).toBe("project");
    expect(resolved?.manifest.model.name).toBe("opus");
  });

  test("lists all unique agents", () => {
    const builtIn = getBuiltInAgents();
    const registry = createAgentDefinitionRegistry(builtIn, []);
    expect(registry.list().length).toBe(builtIn.length);
  });

  test("resolve returns undefined for unknown type", () => {
    const registry = createAgentDefinitionRegistry([], []);
    expect(registry.resolve("nonexistent")).toBeUndefined();
  });

  test("same-tier duplicates produce a warning and first definition wins", () => {
    const agentA = `---
name: duplicate-agent
description: First definition
---

First prompt.`;
    const agentB = `---
name: duplicate-agent
description: Second definition
---

Second prompt.`;

    // Write two files with same agentType in the same directory
    writeAgentFile(tempDir, "aaa-first.md", agentA);
    writeAgentFile(tempDir, "zzz-second.md", agentB);

    const { agents: custom } = loadCustomAgents({ projectDir: tempDir });
    const registry = createAgentDefinitionRegistry([], custom);

    // First definition wins (sorted by filename: aaa-first.md < zzz-second.md)
    const resolved = registry.resolve("duplicate-agent");
    expect(resolved?.whenToUse).toBe("First definition");

    // Warning emitted for the duplicate
    expect(registry.warnings.length).toBe(1);
    expect(registry.warnings[0]?.agentType).toBe("duplicate-agent");
    expect(registry.warnings[0]?.message).toContain("Duplicate");
  });

  test("fail-closed: broken project override blocks fallback to built-in", () => {
    const builtIn = getBuiltInAgents();

    // Write a malformed override for "researcher" (a built-in agent)
    writeAgentFile(tempDir, "researcher.md", INVALID_AGENT);

    const { agents: custom, failedTypes } = loadCustomAgents({ projectDir: tempDir });

    // "researcher" is in failedTypes with source "project"
    expect(failedTypes.some((f) => f.agentType === "researcher" && f.source === "project")).toBe(
      true,
    );

    // Registry blocks fallback: project failure removes lower-priority built-in
    const registry = createAgentDefinitionRegistry(builtIn, custom, failedTypes);
    expect(registry.resolve("researcher")).toBeUndefined();
  });

  test("fail-closed: filename !== frontmatter name still poisons the intended type", () => {
    const builtIn = getBuiltInAgents();

    const brokenOverride = `---
name: researcher
description: Override with bad extra field
badField: true
---

Override prompt.`;

    writeAgentFile(tempDir, "override.md", brokenOverride);

    const { failedTypes } = loadCustomAgents({ projectDir: tempDir });

    // Poisoned by frontmatter name "researcher", NOT filename "override"
    expect(failedTypes.some((f) => f.agentType === "researcher")).toBe(true);
    expect(failedTypes.some((f) => f.agentType === "override")).toBe(false);

    const registry = createAgentDefinitionRegistry(builtIn, [], failedTypes);
    expect(registry.resolve("researcher")).toBeUndefined();
  });

  test("source-aware: broken user agent does NOT block valid project override", () => {
    const builtIn = getBuiltInAgents();

    const userDir = join(tempDir, "user");
    const projectDir = join(tempDir, "project");
    mkdirSync(userDir, { recursive: true });
    mkdirSync(projectDir, { recursive: true });

    // Broken user-level researcher
    writeAgentFile(userDir, "researcher.md", INVALID_AGENT);

    // Valid project-level researcher
    const validProjectOverride = `---
name: researcher
description: Valid project researcher
model: opus
---

Project researcher prompt.`;
    writeAgentFile(projectDir, "researcher.md", validProjectOverride);

    const { agents: custom, failedTypes } = loadCustomAgents({ userDir, projectDir });

    // User failure recorded
    expect(failedTypes.some((f) => f.agentType === "researcher" && f.source === "user")).toBe(true);

    // Registry preserves the valid project-level override (higher priority than failure)
    const registry = createAgentDefinitionRegistry(builtIn, custom, failedTypes);
    const resolved = registry.resolve("researcher");
    expect(resolved).toBeDefined();
    expect(resolved?.source).toBe("project");
    expect(resolved?.manifest.model.name).toBe("opus");
  });

  test("built-in definitions are deep-frozen and cannot be mutated", () => {
    const builtIn = getBuiltInAgents();
    // Built-in agents themselves should be frozen
    expect(() => {
      (builtIn[0] as unknown as Record<string, unknown>).agentType = "hacked";
    }).toThrow();
  });

  test("definitions are deep-frozen and cannot be mutated", () => {
    const builtIn = getBuiltInAgents();
    const registry = createAgentDefinitionRegistry(builtIn, []);
    const resolved = registry.resolve("researcher");
    expect(resolved).toBeDefined();

    // Attempting to mutate should throw (frozen)
    expect(() => {
      (resolved as unknown as Record<string, unknown>).agentType = "hacked";
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// createDefinitionResolver tests
// ---------------------------------------------------------------------------

describe("createDefinitionResolver", () => {
  test("resolve returns ok result for known agent", async () => {
    const builtIn = getBuiltInAgents();
    const registry = createAgentDefinitionRegistry(builtIn, []);
    const resolver = createDefinitionResolver(registry);

    const result = await resolver.resolve("researcher");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("researcher");
    }
  });

  test("resolve returns NOT_FOUND for unknown agent", async () => {
    const registry = createAgentDefinitionRegistry([], []);
    const resolver = createDefinitionResolver(registry);

    const result = await resolver.resolve("nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("list returns summaries for all agents", async () => {
    const builtIn = getBuiltInAgents();
    const registry = createAgentDefinitionRegistry(builtIn, []);
    const resolver = createDefinitionResolver(registry);

    const summaries = await resolver.list();
    expect(summaries.length).toBe(builtIn.length);
    for (const s of summaries) {
      expect(s.key).toBeTruthy();
      expect(s.name).toBeTruthy();
      expect(s.description).toBeTruthy();
    }
  });
});
