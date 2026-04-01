/**
 * Integration tests — full stdio pipeline with mock LSP server.
 *
 * Spawns the mock LSP server as a subprocess and exercises the complete
 * client lifecycle: connect → open document → hover → definition →
 * references → symbols → close → shutdown.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createLspClient } from "../client.js";
import type { ResolvedLspServerConfig } from "../config.js";

const MOCK_SERVER_PATH = resolve(__dirname, "mock-lsp-server.ts");

const TEST_CONFIG: ResolvedLspServerConfig = {
  name: "mock-lsp",
  command: "bun",
  args: [MOCK_SERVER_PATH],
  env: {},
  rootUri: "file:///mock/project",
  languageId: undefined,
  initializationOptions: undefined,
  timeoutMs: 10_000,
};

// ---------------------------------------------------------------------------
// Full lifecycle test
// ---------------------------------------------------------------------------

describe("integration: full LSP pipeline", () => {
  test("connect → open → hover → definition → references → symbols → close → shutdown", async () => {
    const client = createLspClient(TEST_CONFIG, 0, 10_000);

    // Connect
    const connectResult = await client.connect();
    expect(connectResult.ok).toBe(true);
    expect(client.isConnected()).toBe(true);
    expect(client.capabilities()?.hoverProvider).toBe(true);

    // Open document
    const openResult = await client.openDocument(
      "file:///mock/test.ts",
      "const x = 1;",
      "typescript",
    );
    expect(openResult.ok).toBe(true);

    // Hover
    const hoverResult = await client.hover("file:///mock/test.ts", 0, 6);
    expect(hoverResult.ok).toBe(true);
    if (hoverResult.ok && hoverResult.value !== null) {
      expect(hoverResult.value.contents).toEqual({
        kind: "markdown",
        value: "**mock hover**",
      });
    }

    // Go to definition
    const defResult = await client.gotoDefinition("file:///mock/test.ts", 0, 6);
    expect(defResult.ok).toBe(true);
    if (defResult.ok) {
      expect(defResult.value).toHaveLength(1);
      expect(defResult.value[0]?.uri).toBe("file:///mock/definition.ts");
    }

    // Find references
    const refResult = await client.findReferences("file:///mock/test.ts", 0, 6);
    expect(refResult.ok).toBe(true);
    if (refResult.ok) {
      expect(refResult.value).toHaveLength(2);
    }

    // Document symbols
    const docSymResult = await client.documentSymbols("file:///mock/test.ts");
    expect(docSymResult.ok).toBe(true);
    if (docSymResult.ok) {
      expect(docSymResult.value).toHaveLength(1);
      expect(docSymResult.value[0]?.name).toBe("MockFunction");
    }

    // Workspace symbols
    const wsSymResult = await client.workspaceSymbols("Mock");
    expect(wsSymResult.ok).toBe(true);
    if (wsSymResult.ok) {
      expect(wsSymResult.value).toHaveLength(1);
      expect(wsSymResult.value[0]?.name).toBe("MockSymbol");
    }

    // Close document
    const closeDocResult = await client.closeDocument("file:///mock/test.ts");
    expect(closeDocResult.ok).toBe(true);

    // Shutdown
    await client.close();
    expect(client.isConnected()).toBe(false);
  }, 15_000);

  test("handles init timeout with non-responsive server", async () => {
    const timeoutConfig: ResolvedLspServerConfig = {
      ...TEST_CONFIG,
      name: "timeout-test",
      // `cat` will read stdin but never write back a response
      command: "cat",
      args: [],
    };

    const client = createLspClient(timeoutConfig, 0, 500);
    const result = await client.connect();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
    }
  }, 5_000);
});
