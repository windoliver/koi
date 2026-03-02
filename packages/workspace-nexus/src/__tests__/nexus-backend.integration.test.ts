/**
 * Integration tests for the Nexus workspace backend.
 *
 * Requires a running Nexus server. Gated by NEXUS_URL env var.
 * Exercises full lifecycle with real Nexus + real filesystem.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { agentId } from "@koi/core";
import { assertOk } from "@koi/test-utils";
import { MARKER_FILENAME } from "../constants.js";
import { createNexusWorkspaceBackend } from "../nexus-backend.js";

const NEXUS_URL = process.env.NEXUS_URL;
const NEXUS_API_KEY = process.env.NEXUS_API_KEY ?? "integration-test-key";

const AID = agentId("integration-test-agent");
const DEFAULT_CONFIG = {
  cleanupPolicy: "on_success" as const,
  cleanupTimeoutMs: 10_000,
};

// let justified: test-local temp dir cleaned up in afterEach
let tempBaseDir: string;

describe.skipIf(!NEXUS_URL)("Nexus workspace backend (integration)", () => {
  afterEach(async () => {
    if (tempBaseDir && existsSync(tempBaseDir)) {
      await rm(tempBaseDir, { recursive: true, force: true });
    }
  });

  it("full lifecycle: create → isHealthy → dispose → !isHealthy", async () => {
    tempBaseDir = resolve(`/tmp/koi-nexus-integration-${Date.now()}`);
    const result = createNexusWorkspaceBackend({
      nexusUrl: NEXUS_URL ?? "",
      apiKey: NEXUS_API_KEY,
      baseDir: tempBaseDir,
    });
    assertOk(result);
    const backend = result.value;

    // Create
    const createResult = await backend.create(AID, DEFAULT_CONFIG);
    assertOk(createResult);
    const ws = createResult.value;

    expect(ws.id).toContain("nexus-ws-");
    expect(existsSync(ws.path)).toBe(true);

    // isHealthy → true
    const healthyBefore = await backend.isHealthy(ws.id);
    expect(healthyBefore).toBe(true);

    // Dispose
    const disposeResult = await backend.dispose(ws.id);
    assertOk(disposeResult);

    // isHealthy → false
    const healthyAfter = await backend.isHealthy(ws.id);
    expect(healthyAfter).toBe(false);

    // Local dir removed
    expect(existsSync(ws.path)).toBe(false);
  });

  it("local dir contains marker file after create", async () => {
    tempBaseDir = resolve(`/tmp/koi-nexus-integration-${Date.now()}`);
    const result = createNexusWorkspaceBackend({
      nexusUrl: NEXUS_URL ?? "",
      apiKey: NEXUS_API_KEY,
      baseDir: tempBaseDir,
    });
    assertOk(result);
    const backend = result.value;

    const createResult = await backend.create(AID, DEFAULT_CONFIG);
    assertOk(createResult);

    const markerPath = `${createResult.value.path}/${MARKER_FILENAME}`;
    expect(existsSync(markerPath)).toBe(true);

    // Cleanup
    await backend.dispose(createResult.value.id);
  });
});
