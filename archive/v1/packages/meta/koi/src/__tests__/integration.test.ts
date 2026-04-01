/**
 * Integration smoke test — load a manifest and verify basic wiring.
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadManifest } from "@koi/manifest";

const FIXTURE_PATH = resolve(__dirname, "../../fixtures/test-agent.yaml");

describe("integration", () => {
  test("loads test fixture manifest", async () => {
    const result = await loadManifest(FIXTURE_PATH);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.manifest.name).toBe("test-agent");
      expect(result.value.manifest.version).toBe("0.1.0");
    }
  });

  test("root export provides createKoi", async () => {
    const { createKoi } = await import("../index.js");
    expect(typeof createKoi).toBe("function");
  });

  test("root export provides createPiAdapter", async () => {
    const { createPiAdapter } = await import("../index.js");
    expect(typeof createPiAdapter).toBe("function");
  });
});
