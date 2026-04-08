/**
 * LSP diagnostic adapter — maps LSP diagnostics to vendor-neutral DiagnosticProvider.
 *
 * Bridges the @koi/lsp client's getDiagnostics() output to the L0
 * DiagnosticProvider interface defined in @koi/core.
 */

import type { DiagnosticItem, DiagnosticProvider, DiagnosticSeverity } from "@koi/core";
import type { LspClient } from "./client.js";
import type { Diagnostic, DiagnosticSeverity as LspSeverity } from "./types.js";

// ---------------------------------------------------------------------------
// Severity mapping (LSP numeric → L0 string union)
// ---------------------------------------------------------------------------

/** Map LSP numeric severity to L0 string union. Defaults to "info" for unknown values. */
function mapSeverity(severity: LspSeverity | undefined): DiagnosticSeverity {
  switch (severity) {
    case 1:
      return "error";
    case 2:
      return "warning";
    case 3:
      return "info";
    case 4:
      return "hint";
    default:
      return "info";
  }
}

/** Map a single LSP Diagnostic to a vendor-neutral DiagnosticItem. */
function mapDiagnostic(uri: string, diagnostic: Diagnostic, source: string): DiagnosticItem {
  return {
    uri,
    range: {
      start: { line: diagnostic.range.start.line, character: diagnostic.range.start.character },
      end: { line: diagnostic.range.end.line, character: diagnostic.range.end.character },
    },
    severity: mapSeverity(diagnostic.severity),
    message: diagnostic.message,
    source: diagnostic.source ?? source,
    ...(diagnostic.code !== undefined ? { code: diagnostic.code } : {}),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a DiagnosticProvider backed by an LSP client.
 *
 * The `diagnose` method opens the document, waits briefly for diagnostics
 * to arrive (LSP publishes diagnostics asynchronously), then maps them.
 */
export function createLspDiagnosticProvider(
  client: LspClient,
  serverName: string,
): DiagnosticProvider {
  const name = `lsp:${serverName}`;

  const diagnose = async (uri: string, content: string): Promise<readonly DiagnosticItem[]> => {
    const openResult = await client.openDocument(uri, content);
    if (!openResult.ok) {
      return [];
    }

    // Give the server a short window to publish diagnostics.
    // LSP servers push diagnostics asynchronously via textDocument/publishDiagnostics.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 200);
    });

    const diagnosticsMap = client.getDiagnostics(uri);
    const lspDiagnostics = diagnosticsMap.get(uri) ?? [];

    await client.closeDocument(uri);

    return lspDiagnostics.map((d) => mapDiagnostic(uri, d, name));
  };

  const dispose = (): void => {
    void client.close();
  };

  return { name, diagnose, dispose };
}
