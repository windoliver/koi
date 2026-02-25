#!/usr/bin/env bun
/**
 * Mock LSP server for integration testing.
 *
 * Reads JSON-RPC messages from stdin, responds with canned data.
 * Designed to be spawned as a subprocess by integration tests.
 *
 * Run directly: bun packages/lsp/src/__tests__/mock-lsp-server.ts
 */

// ---------------------------------------------------------------------------
// Message framing
// ---------------------------------------------------------------------------

function writeMessage(message: object): void {
  const body = JSON.stringify(message);
  const header = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n`;
  process.stdout.write(header + body);
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

interface Request {
  readonly jsonrpc: string;
  readonly id?: number;
  readonly method: string;
  readonly params?: unknown;
}

function handleRequest(request: Request): void {
  if (request.id === undefined) {
    // Notification — no response needed
    return;
  }

  const method = request.method;

  switch (method) {
    case "initialize": {
      writeMessage({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          capabilities: {
            hoverProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            documentSymbolProvider: true,
            workspaceSymbolProvider: true,
            textDocumentSync: { openClose: true, change: 1 },
          },
          serverInfo: { name: "mock-lsp-server", version: "1.0.0" },
        },
      });
      break;
    }

    case "textDocument/hover": {
      writeMessage({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          contents: { kind: "markdown", value: "**mock hover**" },
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 5 },
          },
        },
      });
      break;
    }

    case "textDocument/definition": {
      writeMessage({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          uri: "file:///mock/definition.ts",
          range: {
            start: { line: 10, character: 0 },
            end: { line: 10, character: 20 },
          },
        },
      });
      break;
    }

    case "textDocument/references": {
      writeMessage({
        jsonrpc: "2.0",
        id: request.id,
        result: [
          {
            uri: "file:///mock/ref1.ts",
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
          },
          {
            uri: "file:///mock/ref2.ts",
            range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
          },
        ],
      });
      break;
    }

    case "textDocument/documentSymbol": {
      writeMessage({
        jsonrpc: "2.0",
        id: request.id,
        result: [
          {
            name: "MockFunction",
            kind: 12,
            location: {
              uri: "file:///mock/test.ts",
              range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
            },
          },
        ],
      });
      break;
    }

    case "workspace/symbol": {
      writeMessage({
        jsonrpc: "2.0",
        id: request.id,
        result: [
          {
            name: "MockSymbol",
            kind: 5,
            location: {
              uri: "file:///mock/symbol.ts",
              range: { start: { line: 0, character: 0 }, end: { line: 10, character: 1 } },
            },
          },
        ],
      });
      break;
    }

    case "shutdown": {
      writeMessage({
        jsonrpc: "2.0",
        id: request.id,
        result: null,
      });
      break;
    }

    default: {
      writeMessage({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Stdin parser
// ---------------------------------------------------------------------------

// let is justified: accumulates streaming data
let buffer = "";

process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf-8");

  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;

    const headerSection = buffer.slice(0, headerEnd);
    const clLine = headerSection.split("\r\n").find((l) => l.startsWith("Content-Length: "));
    if (clLine === undefined) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }

    const cl = Number.parseInt(clLine.slice("Content-Length: ".length), 10);
    const bodyStart = headerEnd + 4;
    if (Buffer.byteLength(buffer.slice(bodyStart), "utf-8") < cl) break;

    const body = buffer.slice(bodyStart, bodyStart + cl);
    buffer = buffer.slice(bodyStart + cl);

    try {
      const request = JSON.parse(body) as Request;
      handleRequest(request);
    } catch {
      // Skip malformed messages
    }
  }
});

// Handle exit notification
process.stdin.on("end", () => {
  process.exit(0);
});
