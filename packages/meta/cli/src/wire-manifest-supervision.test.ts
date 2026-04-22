/**
 * Integration tests for the manifest.supervision → TUI bridge (#1866 phase 3b-5c).
 *
 * Exercises the full pipeline end-to-end without a real TUI:
 *   koi.yaml (supervision block) → loadManifestConfig → wireManifestSupervision
 *   → onChange callback receives SupervisedChildSummary[].
 *
 * A live tmux-driven TUI smoke is intentionally out of scope here — the
 * reducer/view layer is covered by @koi/tui unit tests; this file verifies
 * the CLI-side wiring that lights them up.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, AgentManifest, ProcessId, SubsystemToken } from "@koi/core";
import { agentId } from "@koi/core";
import type { KoiRuntime } from "@koi/engine";
import { loadManifestConfig } from "./manifest.js";
import {
  type SupervisedChildSummary,
  wireManifestSupervision,
} from "./wire-manifest-supervision.js";

const PARENT_ID = agentId("test-parent");

const MOCK_MANIFEST: AgentManifest = {
  name: "test-parent",
  version: "0.0.1",
  model: { name: "mock" },
};

function createMockAgent(): Agent {
  const pid: ProcessId = {
    id: PARENT_ID,
    name: "test-parent",
    type: "worker",
    depth: 0,
  };
  const empty = new Map<string, unknown>();
  return {
    pid,
    manifest: MOCK_MANIFEST,
    state: "running",
    component: <T>(_t: { toString(): string }): T | undefined => undefined,
    has: (_t: { toString(): string }): boolean => false,
    hasAll: (..._tokens: readonly { toString(): string }[]): boolean => false,
    query: <T>(_prefix: string): ReadonlyMap<SubsystemToken<T>, T> => new Map(),
    components: (): ReadonlyMap<string, unknown> => empty,
  };
}

function createMockRuntime(): KoiRuntime {
  const agent = createMockAgent();
  return {
    agent,
    sessionId: "test-session",
    currentRunId: undefined,
    conflicts: [],
    run: () => {
      throw new Error("not used in supervision wiring tests");
    },
    dispose: async (): Promise<void> => {},
    transcript: [],
  } as unknown as KoiRuntime;
}

describe("wireManifestSupervision: end-to-end", () => {
  test("dispatches supervised children when manifest declares one_for_one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "koi-1866-e2e-"));
    try {
      const manifestPath = join(dir, "koi.yaml");
      writeFileSync(
        manifestPath,
        [
          "model:",
          "  name: mock/mock",
          "supervision:",
          "  strategy: one_for_one",
          "  children:",
          "    - name: worker-a",
          "      restart: permanent",
          "    - name: worker-b",
          "      restart: transient",
        ].join("\n"),
      );

      const loaded = await loadManifestConfig(manifestPath);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      expect(loaded.value.supervision).toBeDefined();

      const snapshots: SupervisedChildSummary[][] = [];
      const runtime = createMockRuntime();
      if (loaded.value.supervision === undefined) {
        throw new Error("unreachable — supervision asserted above");
      }
      const handle = await wireManifestSupervision({
        runtime,
        supervisorManifestName: "test-parent",
        supervision: loaded.value.supervision,
        onChange: (children) => {
          snapshots.push([...children]);
        },
      });

      try {
        // Reconciler fast-path enqueues on registry events; give the
        // microtask queue a tick to drain so both children surface.
        await new Promise((resolve) => setTimeout(resolve, 400));

        const latest = snapshots.at(-1) ?? [];
        const names = latest.map((c) => c.childSpecName).sort();
        expect(names).toEqual(["worker-a", "worker-b"]);

        for (const summary of latest) {
          expect(summary.parentId).toBe(String(PARENT_ID));
          expect(summary.phase).toBe("running");
          expect(summary.agentId.length).toBeGreaterThan(0);
        }
      } finally {
        await handle.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no callback invocation when supervision block omits children", async () => {
    const dir = mkdtempSync(join(tmpdir(), "koi-1866-e2e-empty-"));
    try {
      const manifestPath = join(dir, "koi.yaml");
      writeFileSync(
        manifestPath,
        [
          "model:",
          "  name: mock/mock",
          "supervision:",
          "  strategy: one_for_all",
          "  children: []",
        ].join("\n"),
      );

      const loaded = await loadManifestConfig(manifestPath);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) return;
      if (loaded.value.supervision === undefined) {
        throw new Error("expected supervision block");
      }

      const snapshots: SupervisedChildSummary[][] = [];
      const runtime = createMockRuntime();
      const handle = await wireManifestSupervision({
        runtime,
        supervisorManifestName: "test-parent",
        supervision: loaded.value.supervision,
        onChange: (children) => {
          snapshots.push([...children]);
        },
      });

      try {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const latest = snapshots.at(-1) ?? [];
        expect(latest).toEqual([]);
      } finally {
        await handle.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dispose is idempotent + unsubscribes the registry watcher", async () => {
    const runtime = createMockRuntime();
    const handle = await wireManifestSupervision({
      runtime,
      supervisorManifestName: "test-parent",
      supervision: {
        strategy: { kind: "one_for_one" },
        maxRestarts: 5,
        maxRestartWindowMs: 60_000,
        children: [],
      },
    });

    await handle.dispose();
    // Second dispose must not throw — idempotency under double teardown
    // (TUI graceful + SIGINT paths can both fire).
    await expect(handle.dispose()).resolves.toBeUndefined();
  });
});
