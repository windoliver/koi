/**
 * Integration tests for createAgentResolver.
 *
 * Tests the full composition: getBuiltInAgents + loadCustomAgents +
 * createAgentDefinitionRegistry + createDefinitionResolver.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAgentResolver } from "./create-agent-resolver.js";

// ---------------------------------------------------------------------------
// Temp directory helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `koi-resolver-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CUSTOM_RESEARCHER = [
  "---",
  "name: researcher",
  "description: Custom project researcher overriding the built-in",
  "model: haiku",
  "---",
  "",
  "This is a custom researcher agent with project-specific instructions.",
].join("\n");

const INVALID_AGENT = "---\nname: [unclosed bracket\n---\n\nBody text.\n";

const CUSTOM_NEW_AGENT = [
  "---",
  "name: data-analyst",
  "description: Use when you need to analyse data and extract patterns",
  "model: sonnet",
  "---",
  "",
  "You are a data analyst specialising in structured data.",
].join("\n");

// ---------------------------------------------------------------------------
// No dirs — built-ins only
// ---------------------------------------------------------------------------

describe("createAgentResolver — no dirs", () => {
  test("returns resolver with all built-in agents and no warnings", async () => {
    const { resolver, warnings, conflicts } = createAgentResolver();

    expect(warnings).toHaveLength(0);
    expect(conflicts).toHaveLength(0);

    const summaries = await resolver.list();
    expect(summaries.length).toBeGreaterThan(0);
    const keys = summaries.map((s) => s.key);
    expect(keys).toContain("researcher");
    expect(keys).toContain("coder");
    expect(keys).toContain("reviewer");
    expect(keys).toContain("coordinator");
  });

  test("resolve() returns ok for all expected built-in types", async () => {
    const { resolver } = createAgentResolver();

    for (const agentType of ["researcher", "coder", "reviewer", "coordinator"]) {
      const result = await resolver.resolve(agentType);
      expect(result.ok).toBe(true);
    }
  });

  test("resolve() returns NOT_FOUND for unknown type with available agents listed", async () => {
    const { resolver } = createAgentResolver();

    const result = await resolver.resolve("nonexistent");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toContain("researcher");
    }
  });

  test("list() name equals key (agentType) for all built-ins", async () => {
    const { resolver } = createAgentResolver();

    for (const summary of await resolver.list()) {
      expect(summary.name).toBe(summary.key);
    }
  });
});

// ---------------------------------------------------------------------------
// Non-existent dirs — graceful degradation
// ---------------------------------------------------------------------------

describe("createAgentResolver — non-existent dirs", () => {
  test("missing projectDir produces no warnings and still returns built-ins", async () => {
    const { resolver, warnings } = createAgentResolver({
      projectDir: "/tmp/koi-does-not-exist-abc123",
    });

    expect(warnings).toHaveLength(0);
    const result = await resolver.resolve("researcher");
    expect(result.ok).toBe(true);
  });

  test("missing both dirs produces no warnings and still returns built-ins", async () => {
    const { resolver, warnings } = createAgentResolver({
      projectDir: "/tmp/koi-does-not-exist-abc123",
      userDir: "/tmp/koi-also-does-not-exist-abc456",
    });

    expect(warnings).toHaveLength(0);
    const summaries = await resolver.list();
    expect(summaries.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Custom project agents
// ---------------------------------------------------------------------------

describe("createAgentResolver — custom project agents", () => {
  test("project agent overrides built-in of the same agentType", async () => {
    writeAgentFile(tempDir, "researcher.md", CUSTOM_RESEARCHER);

    const { resolver, warnings } = createAgentResolver({ projectDir: tempDir });

    expect(warnings).toHaveLength(0);

    const result = await resolver.resolve("researcher");
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Custom researcher uses haiku; built-in uses sonnet — confirms project override was applied
      expect(result.value.manifest.model.name).toBe("haiku");
    }
  });

  test("new project agent is available alongside built-ins", async () => {
    writeAgentFile(tempDir, "data-analyst.md", CUSTOM_NEW_AGENT);

    const { resolver } = createAgentResolver({ projectDir: tempDir });

    const result = await resolver.resolve("data-analyst");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest.model.name).toBe("sonnet");
    }

    // Built-ins still present
    expect((await resolver.resolve("researcher")).ok).toBe(true);
  });

  test("parse failure emits warning and poisons the intended agentType (fail-closed)", async () => {
    writeAgentFile(tempDir, "researcher.md", INVALID_AGENT);

    const { resolver, warnings } = createAgentResolver({ projectDir: tempDir });

    // Warning emitted for the bad file
    expect(warnings.length).toBeGreaterThan(0);

    // researcher is poisoned — built-in fallback is blocked
    const result = await resolver.resolve("researcher");
    expect(result.ok).toBe(false);
  });

  test("parse failure for one file does not affect other agents", async () => {
    writeAgentFile(tempDir, "researcher.md", INVALID_AGENT);
    writeAgentFile(tempDir, "data-analyst.md", CUSTOM_NEW_AGENT);

    const { resolver, warnings } = createAgentResolver({ projectDir: tempDir });

    expect(warnings.length).toBeGreaterThan(0);

    // data-analyst still resolves correctly
    expect((await resolver.resolve("data-analyst")).ok).toBe(true);
    // coder (built-in, unrelated) still resolves
    expect((await resolver.resolve("coder")).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// warnings and conflicts surface
// ---------------------------------------------------------------------------

describe("createAgentResolver — warning and conflict surfacing", () => {
  test("warnings are returned for unparseable files, not swallowed", async () => {
    writeAgentFile(tempDir, "bad.md", INVALID_AGENT);

    const { warnings } = createAgentResolver({ projectDir: tempDir });

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]?.error).toBeDefined();
  });

  test("no conflicts when each agentType appears in only one source tier", async () => {
    writeAgentFile(tempDir, "researcher.md", CUSTOM_RESEARCHER);

    const { conflicts } = createAgentResolver({ projectDir: tempDir });

    // Only one project-level researcher — no same-tier conflict
    expect(conflicts).toHaveLength(0);
  });
});
