/**
 * Contract test suite for the long-running harness.
 *
 * Uses the reusable contract tests from @koi/test-utils.
 */

import type { SessionPersistence } from "@koi/core";
import { agentId, harnessId } from "@koi/core";
import { createInMemorySnapshotChainStore } from "@koi/snapshot-chain-store";
import { runHarnessContractTests } from "@koi/test-utils";
import { createLongRunningHarness } from "../harness.js";

function createMockPersistence(): SessionPersistence {
  return {
    saveSession: () => ({ ok: true as const, value: undefined }),
    loadSession: () => ({
      ok: false as const,
      error: { code: "NOT_FOUND" as const, message: "Not found", retryable: false },
    }),
    removeSession: () => ({ ok: true as const, value: undefined }),
    listSessions: () => ({ ok: true as const, value: [] }),
    savePendingFrame: () => ({ ok: true as const, value: undefined }),
    loadPendingFrames: () => ({ ok: true as const, value: [] }),
    clearPendingFrames: () => ({ ok: true as const, value: undefined }),
    removePendingFrame: () => ({ ok: true as const, value: undefined }),
    recover: () => ({
      ok: true as const,
      value: { sessions: [], pendingFrames: new Map(), skipped: [] },
    }),
    close: () => undefined,
  };
}

runHarnessContractTests(() =>
  createLongRunningHarness({
    harnessId: harnessId("contract-harness"),
    agentId: agentId("contract-agent"),
    harnessStore: createInMemorySnapshotChainStore(),
    sessionPersistence: createMockPersistence(),
  }),
);
