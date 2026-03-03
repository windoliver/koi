/**
 * Tests for soul self-modification awareness (issue #362).
 *
 * Validates that the soul middleware injects meta-instructions teaching the
 * agent about its ability to modify SOUL.md, configurable via `selfModify`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelRequest } from "@koi/core";
import type { CapabilityFragment } from "@koi/core/middleware";
import { createMockTurnContext, createSpyModelHandler } from "@koi/test-utils";
import { validateSoulConfig } from "./config.js";
import { createSoulMiddleware } from "./soul.js";
import { generateMetaInstructionText } from "./state.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(import.meta.dir, "__test_tmp__", crypto.randomUUID());
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Helper: create MetaInstructionSources with defaults. */
function sources(
  soul: readonly string[] = [],
  identity: readonly string[] = [],
  user: readonly string[] = [],
): {
  readonly soul: readonly string[];
  readonly identity: readonly string[];
  readonly user: readonly string[];
} {
  return { soul, identity, user };
}

// ---------------------------------------------------------------------------
// generateMetaInstructionText — pure function
// ---------------------------------------------------------------------------

describe("generateMetaInstructionText", () => {
  test("returns empty string when selfModify is false", () => {
    const result = generateMetaInstructionText(sources(["/path/SOUL.md"]), false);
    expect(result).toBe("");
  });

  test("returns empty string when all sources are inline", () => {
    const result = generateMetaInstructionText(sources(["inline"]), true);
    expect(result).toBe("");
  });

  test("returns empty string when sources are empty", () => {
    const result = generateMetaInstructionText(sources(), true);
    expect(result).toBe("");
  });

  test("returns compact format for single soul file", () => {
    const filePath = "/abs/path/SOUL.md";
    const result = generateMetaInstructionText(sources([filePath]), true);

    expect(result).toContain("[Soul System]");
    expect(result).toContain(`defined in ${filePath}.`);
    expect(result).toContain("propose changes");
    expect(result).toContain("human approval");
    expect(result).toContain("Do NOT update for:");
    // Single file — should NOT use grouped listing
    expect(result).not.toContain("(global personality)");
  });

  test("uses grouped listing for multiple files", () => {
    const result = generateMetaInstructionText(
      sources(["/abs/SOUL.md"], ["/abs/persona.md"], ["/abs/USER.md"]),
      true,
    );

    expect(result).toContain("[Soul System]");
    expect(result).toContain("defined in these files:");
    expect(result).toContain("/abs/SOUL.md (global personality)");
    expect(result).toContain("/abs/persona.md (channel persona)");
    expect(result).toContain("/abs/USER.md (user context)");
  });

  test("uses grouped listing for soul directory with multiple files", () => {
    const result = generateMetaInstructionText(sources(["/abs/SOUL.md", "/abs/STYLE.md"]), true);

    expect(result).toContain("defined in these files:");
    expect(result).toContain("/abs/SOUL.md (global personality)");
    expect(result).toContain("/abs/STYLE.md (global personality)");
  });

  test("filters out inline entries from all layers", () => {
    const result = generateMetaInstructionText(
      sources(["inline", "/abs/SOUL.md"], ["inline"], ["inline"]),
      true,
    );

    // Only one real file — compact format
    expect(result).toContain(`defined in /abs/SOUL.md.`);
    expect(result).not.toContain("inline");
  });

  test("identity-only files produce meta-instruction", () => {
    const result = generateMetaInstructionText(sources(["inline"], ["/abs/persona.md"]), true);

    expect(result).toContain("[Soul System]");
    expect(result).toContain("/abs/persona.md (channel persona)");
  });
});

// ---------------------------------------------------------------------------
// createSoulMiddleware — selfModify integration
// ---------------------------------------------------------------------------

describe("createSoulMiddleware — selfModify default (true)", () => {
  test("meta-instruction appears in soul message by default", async () => {
    const soulFile = join(tmpDir, "SOUL.md");
    await writeFile(soulFile, "I am a helpful assistant.");

    const mw = await createSoulMiddleware({ soul: "SOUL.md", basePath: tmpDir });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
    };

    await mw.wrapModelCall?.(ctx, request, spy.handler);

    const msg = spy.calls[0]?.messages[0];
    if (msg?.content[0]?.kind === "text") {
      expect(msg.content[0].text).toContain("[Soul System]");
      expect(msg.content[0].text).toContain("I am a helpful assistant.");
    } else {
      throw new Error("Expected text content");
    }
  });

  test("meta-instruction contains correct absolute file path", async () => {
    const soulFile = join(tmpDir, "SOUL.md");
    await writeFile(soulFile, "Soul content.");

    const mw = await createSoulMiddleware({ soul: "SOUL.md", basePath: tmpDir });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
    };

    await mw.wrapModelCall?.(ctx, request, spy.handler);

    const msg = spy.calls[0]?.messages[0];
    if (msg?.content[0]?.kind === "text") {
      expect(msg.content[0].text).toContain(`defined in ${soulFile}`);
    } else {
      throw new Error("Expected text content");
    }
  });
});

describe("createSoulMiddleware — selfModify disabled", () => {
  test("meta-instruction absent when selfModify is false", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "I am helpful.");

    const mw = await createSoulMiddleware({
      soul: "SOUL.md",
      basePath: tmpDir,
      selfModify: false,
    });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
    };

    await mw.wrapModelCall?.(ctx, request, spy.handler);

    const msg = spy.calls[0]?.messages[0];
    if (msg?.content[0]?.kind === "text") {
      expect(msg.content[0].text).toContain("I am helpful.");
      expect(msg.content[0].text).not.toContain("[Soul System]");
    } else {
      throw new Error("Expected text content");
    }
  });
});

describe("createSoulMiddleware — selfModify with inline content", () => {
  test("meta-instruction absent for inline soul content even with selfModify true", async () => {
    const mw = await createSoulMiddleware({
      soul: "Inline soul\nWith multiple lines",
      basePath: tmpDir,
      selfModify: true,
    });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
    };

    await mw.wrapModelCall?.(ctx, request, spy.handler);

    const msg = spy.calls[0]?.messages[0];
    if (msg?.content[0]?.kind === "text") {
      expect(msg.content[0].text).toContain("Inline soul");
      expect(msg.content[0].text).not.toContain("[Soul System]");
    } else {
      throw new Error("Expected text content");
    }
  });
});

describe("createSoulMiddleware — selfModify with directory content", () => {
  test("meta-instruction present for directory soul, uses primary file path", async () => {
    const soulDir = join(tmpDir, "soul");
    await mkdir(soulDir, { recursive: true });
    await writeFile(join(soulDir, "SOUL.md"), "Directory soul personality.");

    const mw = await createSoulMiddleware({ soul: "soul", basePath: tmpDir });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
    };

    await mw.wrapModelCall?.(ctx, request, spy.handler);

    const msg = spy.calls[0]?.messages[0];
    if (msg?.content[0]?.kind === "text") {
      expect(msg.content[0].text).toContain("Directory soul personality.");
      expect(msg.content[0].text).toContain("[Soul System]");
      // Should reference the actual SOUL.md file, not the directory
      expect(msg.content[0].text).toContain("SOUL.md");
    } else {
      throw new Error("Expected text content");
    }
  });
});

// ---------------------------------------------------------------------------
// Concatenation order — meta-instruction comes last
// ---------------------------------------------------------------------------

describe("createSoulMiddleware — selfModify concatenation order", () => {
  test("meta-instruction appears after soul + user layers", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "Soul text.");
    await writeFile(join(tmpDir, "USER.md"), "User text.");

    const mw = await createSoulMiddleware({
      soul: "SOUL.md",
      user: "USER.md",
      basePath: tmpDir,
    });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
    };

    await mw.wrapModelCall?.(ctx, request, spy.handler);

    const msg = spy.calls[0]?.messages[0];
    if (msg?.content[0]?.kind === "text") {
      const text = msg.content[0].text;
      const soulIdx = text.indexOf("Soul text.");
      const userIdx = text.indexOf("User text.");
      const metaIdx = text.indexOf("[Soul System]");
      expect(soulIdx).toBeGreaterThanOrEqual(0);
      expect(userIdx).toBeGreaterThan(soulIdx);
      expect(metaIdx).toBeGreaterThan(userIdx);
    } else {
      throw new Error("Expected text content");
    }
  });
});

// ---------------------------------------------------------------------------
// reload — meta-instruction updates
// ---------------------------------------------------------------------------

describe("createSoulMiddleware — selfModify + reload", () => {
  test("meta-instruction text updates after reload", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "Version A");

    const mw = await createSoulMiddleware({ soul: "SOUL.md", basePath: tmpDir });
    const ctx = createMockTurnContext();
    const spy = createSpyModelHandler();
    const request: ModelRequest = {
      messages: [{ senderId: "user", timestamp: 1, content: [{ kind: "text", text: "hi" }] }],
    };

    // Before reload — Version A + meta-instruction
    await mw.wrapModelCall?.(ctx, request, spy.handler);
    const msg1 = spy.calls[0]?.messages[0];
    if (msg1?.content[0]?.kind === "text") {
      expect(msg1.content[0].text).toContain("Version A");
      expect(msg1.content[0].text).toContain("[Soul System]");
    }

    // Update file and reload
    await writeFile(join(tmpDir, "SOUL.md"), "Version B");
    await mw.reload();

    // After reload — Version B + meta-instruction still present
    await mw.wrapModelCall?.(ctx, request, spy.handler);
    const msg2 = spy.calls[1]?.messages[0];
    if (msg2?.content[0]?.kind === "text") {
      expect(msg2.content[0].text).toContain("Version B");
      expect(msg2.content[0].text).toContain("[Soul System]");
    }
  });
});

// ---------------------------------------------------------------------------
// validateSoulConfig — selfModify field
// ---------------------------------------------------------------------------

describe("validateSoulConfig — selfModify", () => {
  test("accepts selfModify: true", () => {
    const result = validateSoulConfig({ basePath: "/tmp", selfModify: true });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.selfModify).toBe(true);
    }
  });

  test("accepts selfModify: false", () => {
    const result = validateSoulConfig({ basePath: "/tmp", selfModify: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.selfModify).toBe(false);
    }
  });

  test("accepts selfModify: undefined (omitted)", () => {
    const result = validateSoulConfig({ basePath: "/tmp" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.selfModify).toBeUndefined();
    }
  });

  test("rejects selfModify: string", () => {
    const result = validateSoulConfig({ basePath: "/tmp", selfModify: "yes" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("selfModify must be a boolean");
    }
  });

  test("rejects selfModify: number", () => {
    const result = validateSoulConfig({ basePath: "/tmp", selfModify: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("selfModify must be a boolean");
    }
  });
});

// ---------------------------------------------------------------------------
// describeCapabilities — selfModify awareness
// ---------------------------------------------------------------------------

describe("describeCapabilities — selfModify", () => {
  test("describes self-modification enabled when selfModify is true with file source", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "Soul content.");

    const mw = await createSoulMiddleware({ soul: "SOUL.md", basePath: tmpDir });
    const ctx = createMockTurnContext();
    const result = mw.describeCapabilities?.(ctx) as CapabilityFragment;

    expect(result.label).toBe("soul");
    expect(result.description).toContain("self-modification enabled");
  });

  test("does not describe self-modification when selfModify is false", async () => {
    await writeFile(join(tmpDir, "SOUL.md"), "Soul content.");

    const mw = await createSoulMiddleware({
      soul: "SOUL.md",
      basePath: tmpDir,
      selfModify: false,
    });
    const ctx = createMockTurnContext();
    const result = mw.describeCapabilities?.(ctx) as CapabilityFragment;

    expect(result.label).toBe("soul");
    expect(result.description).toContain("Persona system prompt injected");
    expect(result.description).not.toContain("self-modification");
  });

  test("does not describe self-modification for inline content", async () => {
    const mw = await createSoulMiddleware({
      soul: "Inline soul\nMultiple lines",
      basePath: tmpDir,
      selfModify: true,
    });
    const ctx = createMockTurnContext();
    const result = mw.describeCapabilities?.(ctx) as CapabilityFragment;

    expect(result.label).toBe("soul");
    expect(result.description).toContain("Persona system prompt injected");
  });
});
