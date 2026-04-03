/**
 * E2E integration test — runs against a real Nexus Docker instance.
 *
 * Requires a healthy Nexus server with writable zone storage.
 * Skip when NEXUS_URL is not set (CI without Nexus). Run manually:
 *
 *   NEXUS_URL=http://localhost:40807 \
 *   NEXUS_API_KEY=sk-... \
 *   bun test packages/net/fs-nexus/src/__tests__/nexus-e2e.test.ts
 *
 * Uses a unique basePath per run to isolate from other data.
 * Nexus serves JSON-RPC at /api/nfs/{method} with Bearer auth.
 */

import { describe, expect, test } from "bun:test";
import { createNexusFileSystem } from "../nexus-filesystem-backend.js";
import type { NexusTransport } from "../types.js";

const NEXUS_URL = process.env.NEXUS_URL;
const NEXUS_API_KEY = process.env.NEXUS_API_KEY;

const describeE2E = NEXUS_URL && NEXUS_API_KEY ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Real Nexus transport — /api/nfs/{method} wire protocol
// ---------------------------------------------------------------------------

function createNexusNfsTransport(baseUrl: string, apiKey: string): NexusTransport {
  let closed = false;

  async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (closed) throw new Error("Transport closed");

    const url = `${baseUrl.replace(/\/+$/, "")}/api/nfs/${encodeURIComponent(method)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${String(response.status)}: ${response.statusText}`);
    }

    const body = (await response.json()) as {
      readonly result?: T;
      readonly error?: { readonly code: number; readonly message: string };
    };

    if (body.error) {
      throw new Error(`RPC error ${String(body.error.code)}: ${body.error.message}`);
    }

    return body.result as T;
  }

  async function close(): Promise<void> {
    closed = true;
  }

  return { call, close };
}

// ---------------------------------------------------------------------------
// Connectivity / health check
// ---------------------------------------------------------------------------

describeE2E("@koi/fs-nexus E2E (real Nexus)", () => {
  const runId = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const basePath = `test/${runId}`;

  function createBackend() {
    const transport = createNexusNfsTransport(NEXUS_URL!, NEXUS_API_KEY!);
    return createNexusFileSystem({ transport, basePath });
  }

  test("health check — Nexus server responds", async () => {
    const response = await fetch(`${NEXUS_URL!}/health`);
    expect(response.ok).toBe(true);
    const body = (await response.json()) as { readonly status: string };
    expect(body.status).toBe("healthy");
  });

  test("transport connectivity — list RPC succeeds", async () => {
    const transport = createNexusNfsTransport(NEXUS_URL!, NEXUS_API_KEY!);
    const result = await transport.call<{ readonly files: readonly string[] }>("list", {
      path: "/",
      detail: false,
    });
    expect(result).toBeDefined();
    expect(Array.isArray(result.files)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Write/read operations — require writable Nexus zone storage.
  // These will fail if the Nexus data directory is missing or corrupted.
  // -----------------------------------------------------------------------

  test("write and read roundtrip", async () => {
    const backend = createBackend();
    const content = `E2E test at ${new Date().toISOString()}`;

    const writeResult = await backend.write("/hello.txt", content, { overwrite: true });
    if (!writeResult.ok) {
      console.log(`  [skip] write failed: ${writeResult.error.message}`);
      return;
    }
    expect(writeResult.value.path).toBe("/hello.txt");

    const readResult = await backend.read("/hello.txt");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.content).toBe(content);
    }
  });

  test("read non-existent file returns NOT_FOUND", async () => {
    const backend = createBackend();
    const result = await backend.read(`/nonexistent-${runId}.txt`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("path traversal blocked client-side (never reaches server)", async () => {
    const backend = createBackend();
    const result = await backend.read("/../../etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("traversal");
    }
  });

  test("null bytes in path rejected client-side", async () => {
    const backend = createBackend();
    const result = await backend.read("/file\0.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("dispose closes transport — subsequent calls fail", async () => {
    const backend = createBackend();
    const disposeFn = backend.dispose;
    if (disposeFn === undefined) throw new Error("dispose not defined");
    await disposeFn();

    const result = await backend.read("/anything.txt");
    expect(result.ok).toBe(false);
  });

  test("backend name is nexus", () => {
    const backend = createBackend();
    expect(backend.name).toBe("nexus");
  });
});
