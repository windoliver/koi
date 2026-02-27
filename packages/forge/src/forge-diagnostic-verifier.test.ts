import { describe, expect, test } from "bun:test";
import type { DiagnosticItem, DiagnosticProvider } from "@koi/core";
import { createDiagnosticVerifier } from "./forge-diagnostic-verifier.js";
import type { ForgeContext, ForgeInput } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockProvider(diagnostics: readonly DiagnosticItem[] = []): DiagnosticProvider {
  return {
    name: "test-provider",
    diagnose: async () => diagnostics,
  };
}

function toolInput(name: string = "test-tool"): ForgeInput {
  return {
    kind: "tool",
    name,
    description: "A test tool",
    implementation: "export default function() { return 42; }",
    inputSchema: {},
  } as ForgeInput;
}

function agentInput(): ForgeInput {
  return {
    kind: "agent",
    name: "test-agent",
    description: "A test agent",
    manifestYaml: "name: test",
  } as ForgeInput;
}

const MOCK_CONTEXT = {
  agentId: "agent-1",
  depth: 0,
  scope: "agent",
  sessionId: "session-1",
  forgesThisSession: 0,
} as ForgeContext;

function errorDiagnostic(message: string): DiagnosticItem {
  return {
    uri: "test.ts",
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } },
    severity: "error",
    message,
  };
}

function warningDiagnostic(message: string): DiagnosticItem {
  return {
    uri: "test.ts",
    range: { start: { line: 2, character: 0 }, end: { line: 2, character: 10 } },
    severity: "warning",
    message,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createDiagnosticVerifier", () => {
  test("passes when no diagnostics", async () => {
    const verifier = createDiagnosticVerifier(createMockProvider([]));
    const result = await verifier.verify(toolInput(), MOCK_CONTEXT);
    expect(result.passed).toBe(true);
  });

  test("passes for agent kind (no implementation)", async () => {
    const verifier = createDiagnosticVerifier(
      createMockProvider([errorDiagnostic("should not be called")]),
    );
    const result = await verifier.verify(agentInput(), MOCK_CONTEXT);
    expect(result.passed).toBe(true);
  });

  test("rejects on error diagnostics", async () => {
    const verifier = createDiagnosticVerifier(
      createMockProvider([errorDiagnostic("undefined variable")]),
    );
    const result = await verifier.verify(toolInput(), MOCK_CONTEXT);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("undefined variable");
  });

  test("passes on warnings by default", async () => {
    const verifier = createDiagnosticVerifier(
      createMockProvider([warningDiagnostic("unused import")]),
    );
    const result = await verifier.verify(toolInput(), MOCK_CONTEXT);
    expect(result.passed).toBe(true);
  });

  test("rejects on warnings when rejectOnWarning is true", async () => {
    const verifier = createDiagnosticVerifier(
      createMockProvider([warningDiagnostic("unused import")]),
      { rejectOnWarning: true },
    );
    const result = await verifier.verify(toolInput(), MOCK_CONTEXT);
    expect(result.passed).toBe(false);
    expect(result.message).toContain("unused import");
  });

  test("verifier name includes provider name", () => {
    const verifier = createDiagnosticVerifier(createMockProvider());
    expect(verifier.name).toBe("diagnostic:test-provider");
  });

  test("caps error messages at 5", async () => {
    const diagnostics = Array.from({ length: 10 }, (_, i) => errorDiagnostic(`error ${i}`));
    const verifier = createDiagnosticVerifier(createMockProvider(diagnostics));
    const result = await verifier.verify(toolInput(), MOCK_CONTEXT);
    expect(result.passed).toBe(false);
    // Should only show first 5
    expect(result.message).toContain("error 4");
    expect(result.message).not.toContain("error 5");
  });
});
