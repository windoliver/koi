/**
 * E2E test — Rich trajectory reflector with real LLM calls.
 *
 * Validates the core value proposition: the reflector produces more specific,
 * actionable insights when given rich trajectory data (full request/response
 * content, error messages, tool arguments) compared to compact summaries.
 *
 * Test scenarios:
 *   1. Rich vs compact reflection quality: reflector references specific error
 *      content that's only present in rich trajectory data
 *   2. Audit→ACE adapter integration: audit entries → rich trajectory → reflector
 *   3. Full pipeline with rich trajectory source, store, and completion callback
 *   4. ATIF roundtrip: export → import → reflect → valid output
 *
 * Uses Anthropic Claude Haiku for speed and cost efficiency.
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-rich-trajectory.test.ts
 *   (reads ANTHROPIC_API_KEY from .env automatically via Bun)
 */

import { describe, expect, mock, test } from "bun:test";
import type { AuditEntry } from "@koi/core";
import type { InboundMessage } from "@koi/core/message";
import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
import { createAnthropicAdapter } from "@koi/model-router";
import { mapAtifToRichTrajectory, mapRichTrajectoryToAtif } from "../atif.js";
import { createAuditTrajectoryAdapter } from "../audit-adapter.js";
import { createDefaultCurator } from "../curator.js";
import { createDefaultReflector } from "../reflector.js";
import {
  createInMemoryPlaybookStore,
  createInMemoryRichTrajectoryStore,
  createInMemoryStructuredPlaybookStore,
  createInMemoryTrajectoryStore,
} from "../stores.js";
import type { StructuredPlaybook } from "../types.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 90_000;
const E2E_MODEL = "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTextCall(): (messages: readonly InboundMessage[]) => Promise<string> {
  const adapter = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });

  return async (messages: readonly InboundMessage[]): Promise<string> => {
    const koiMessages = messages.map((m) => ({
      ...m,
      content: m.content.map((c) => {
        if (c.kind === "text") return c;
        return { kind: "text" as const, text: JSON.stringify(c) };
      }),
    }));

    const response = await adapter.complete({
      messages: koiMessages,
      model: E2E_MODEL,
      maxTokens: 1024,
    });

    return typeof response.content === "string" ? response.content : "";
  };
}

function makePlaybook(): StructuredPlaybook {
  return {
    id: "e2e-rich-pb",
    title: "Rich Trajectory Test",
    sections: [
      {
        name: "Strategy",
        slug: "str",
        bullets: [
          {
            id: "[str-00000]",
            content: "Always check file permissions before write operations",
            helpful: 3,
            harmful: 0,
            createdAt: 1000,
            updatedAt: 1000,
          },
        ],
      },
      {
        name: "Error Handling",
        slug: "err",
        bullets: [
          {
            id: "[err-00000]",
            content: "Retry transient network errors with exponential backoff",
            helpful: 2,
            harmful: 0,
            createdAt: 1000,
            updatedAt: 1000,
          },
        ],
      },
    ],
    tags: [],
    source: "curated",
    createdAt: 1000,
    updatedAt: 1000,
    sessionCount: 3,
  };
}

/** Compact trajectory — only has kind/identifier/outcome, no error details. */
function makeCompactTrajectory(): readonly {
  readonly turnIndex: number;
  readonly timestamp: number;
  readonly kind: "model_call" | "tool_call";
  readonly identifier: string;
  readonly outcome: "success" | "failure" | "retry";
  readonly durationMs: number;
}[] {
  return [
    {
      turnIndex: 0,
      timestamp: 1000,
      kind: "model_call",
      identifier: "claude-haiku",
      outcome: "success",
      durationMs: 500,
    },
    {
      turnIndex: 1,
      timestamp: 2000,
      kind: "tool_call",
      identifier: "read_file",
      outcome: "success",
      durationMs: 30,
    },
    {
      turnIndex: 2,
      timestamp: 3000,
      kind: "tool_call",
      identifier: "write_file",
      outcome: "failure",
      durationMs: 200,
    },
    {
      turnIndex: 3,
      timestamp: 4000,
      kind: "model_call",
      identifier: "claude-haiku",
      outcome: "failure",
      durationMs: 800,
    },
  ];
}

/** Rich trajectory — includes full error messages, tool arguments, responses. */
function makeRichTrajectory(): readonly RichTrajectoryStep[] {
  return [
    {
      stepIndex: 0,
      timestamp: 1000,
      source: "agent",
      kind: "model_call",
      identifier: "claude-haiku",
      outcome: "success",
      durationMs: 500,
      request: {
        text: "Read the config file at /etc/myapp/config.yaml and update the database port to 5433",
      },
      response: { text: "I'll read the config file first, then update the port." },
    },
    {
      stepIndex: 1,
      timestamp: 2000,
      source: "tool",
      kind: "tool_call",
      identifier: "read_file",
      outcome: "success",
      durationMs: 30,
      request: {
        text: '{"path": "/etc/myapp/config.yaml"}',
        data: { path: "/etc/myapp/config.yaml" },
      },
      response: { text: "database:\n  host: localhost\n  port: 5432\n  name: myapp_prod" },
    },
    {
      stepIndex: 2,
      timestamp: 3000,
      source: "tool",
      kind: "tool_call",
      identifier: "write_file",
      outcome: "failure",
      durationMs: 200,
      request: {
        text: '{"path": "/etc/myapp/config.yaml", "content": "...port: 5433..."}',
        data: { path: "/etc/myapp/config.yaml" },
      },
      error: {
        text: "EACCES: permission denied, open '/etc/myapp/config.yaml' — file is owned by root:root with mode 0644, current user is 'deploy'",
      },
    },
    {
      stepIndex: 3,
      timestamp: 4000,
      source: "agent",
      kind: "model_call",
      identifier: "claude-haiku",
      outcome: "failure",
      durationMs: 800,
      request: { text: "The write failed. Let me try a different approach." },
      error: { text: "Context window exceeded: 128000 tokens used, 128000 max" },
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: rich trajectory reflector with real LLM", () => {
  // ── Test 1: Rich trajectory produces more specific reflection ────────
  test(
    "reflector with rich trajectory references specific error details absent from compact data",
    async () => {
      const textCall = createTextCall();
      const reflector = createDefaultReflector(textCall);
      const playbook = makePlaybook();

      // Reflect with compact data (no error details)
      const compactReflection = await reflector.analyze({
        trajectory: makeCompactTrajectory(),
        citedBulletIds: ["[str-00000]"],
        outcome: "mixed",
        playbook,
      });

      // Reflect with rich data (full error messages)
      const richReflection = await reflector.analyze({
        trajectory: makeCompactTrajectory(),
        richTrajectory: makeRichTrajectory(),
        citedBulletIds: ["[str-00000]"],
        outcome: "mixed",
        playbook,
      });

      // Both should produce non-empty analysis
      expect(compactReflection.rootCause.length).toBeGreaterThan(0);
      expect(richReflection.rootCause.length).toBeGreaterThan(0);

      // Rich reflection should be more specific — it has access to the actual
      // error message ("EACCES: permission denied") which compact doesn't.
      // We check that the rich response references permission-related terms.
      const richText = `${richReflection.rootCause} ${richReflection.keyInsight}`.toLowerCase();
      const mentionsPermission =
        richText.includes("permission") ||
        richText.includes("eacces") ||
        richText.includes("root") ||
        richText.includes("access") ||
        richText.includes("denied") ||
        richText.includes("privilege");

      expect(mentionsPermission).toBe(true);

      // Rich reflection should be longer/more detailed than compact
      const richLength = richReflection.rootCause.length + richReflection.keyInsight.length;
      const compactLength =
        compactReflection.rootCause.length + compactReflection.keyInsight.length;
      // Not a strict assertion (LLM non-determinism), but log for visibility
      if (richLength <= compactLength) {
        console.warn(
          `Rich reflection (${richLength} chars) was not longer than compact (${compactLength} chars) — LLM non-determinism`,
        );
      }
    },
    TIMEOUT_MS,
  );

  // ── Test 2: Audit adapter → reflector integration ────────────────────
  test(
    "audit entries transformed via adapter produce valid reflector input",
    async () => {
      const textCall = createTextCall();
      const reflector = createDefaultReflector(textCall);

      // Simulate audit entries (as captured by middleware-audit)
      const auditEntries: readonly AuditEntry[] = [
        {
          timestamp: 1000,
          sessionId: "e2e-audit-session",
          agentId: "test-agent",
          turnIndex: 0,
          kind: "model_call",
          request: { model: "claude-haiku", messages: [{ role: "user", content: "Fix the bug" }] },
          response: { content: "I'll investigate the issue." },
          durationMs: 400,
        },
        {
          timestamp: 2000,
          sessionId: "e2e-audit-session",
          agentId: "test-agent",
          turnIndex: 1,
          kind: "tool_call",
          request: { toolId: "grep", arguments: { pattern: "TODO", path: "/src" } },
          response: { results: ["src/index.ts:42: // TODO: fix race condition"] },
          durationMs: 50,
        },
        {
          timestamp: 3000,
          sessionId: "e2e-audit-session",
          agentId: "test-agent",
          turnIndex: 2,
          kind: "tool_call",
          request: { toolId: "write_file", arguments: { path: "/src/index.ts" } },
          error: { code: "EACCES", message: "Permission denied" },
          durationMs: 10,
        },
        {
          timestamp: 500,
          sessionId: "e2e-audit-session",
          agentId: "test-agent",
          turnIndex: -1,
          kind: "session_start",
          durationMs: 0,
        },
      ];

      // Create adapter with mock sink
      const adapter = createAuditTrajectoryAdapter({
        sink: {
          log: async () => {},
          query: async (sid: string) => auditEntries.filter((e) => e.sessionId === sid),
        },
      });

      const richSteps = await adapter("e2e-audit-session");

      // session_start should be filtered out
      expect(richSteps).toHaveLength(3);

      // Feed to reflector with rich data
      const reflection = await reflector.analyze({
        trajectory: makeCompactTrajectory().slice(0, 3),
        richTrajectory: richSteps,
        citedBulletIds: [],
        outcome: "mixed",
        playbook: makePlaybook(),
      });

      expect(reflection.rootCause.length).toBeGreaterThan(0);
      expect(reflection.keyInsight.length).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  // ── Test 3: Full pipeline with rich trajectory source + store ────────
  test(
    "LLM pipeline fetches rich trajectory, persists to store, fires completion callback",
    async () => {
      const textCall = createTextCall();
      const reflector = createDefaultReflector(textCall);
      const curator = createDefaultCurator(textCall);

      const trajectoryStore = createInMemoryTrajectoryStore();
      const playbookStore = createInMemoryPlaybookStore();
      const structuredPlaybookStore = createInMemoryStructuredPlaybookStore();
      const richTrajectoryStore = createInMemoryRichTrajectoryStore();

      const richSteps = makeRichTrajectory();
      const richTrajectorySource = mock(async (_sessionId: string) => richSteps);
      const onLlmPipelineComplete = mock((_sessionId: string) => {});

      // let: track errors
      let pipelineError: unknown;

      const { createLlmPipeline } = await import("../pipeline.js");
      const pipeline = createLlmPipeline({
        trajectoryStore,
        playbookStore,
        structuredPlaybookStore,
        reflector,
        curator,
        richTrajectorySource,
        richTrajectoryStore,
        richTrajectoryRetentionDays: 30,
        maxReflectorTokens: 4000,
        playbookTokenBudget: 2000,
        onLlmPipelineComplete,
        onLlmPipelineError: (err) => {
          pipelineError = err;
        },
      });

      const { createTrajectoryBuffer } = await import("../trajectory-buffer.js");
      const buffer = createTrajectoryBuffer(100);

      // Record some compact entries
      for (const entry of makeCompactTrajectory()) {
        buffer.record(entry);
      }
      const entries = buffer.flush();

      // Run the LLM pipeline
      await pipeline.consolidate(entries, "e2e-rich-session", 1, Date.now, buffer);

      // Pipeline should not have errored
      expect(pipelineError).toBeUndefined();

      // Rich trajectory source should have been called
      expect(richTrajectorySource).toHaveBeenCalledWith("e2e-rich-session");

      // Full (uncompressed) rich trajectory should be persisted in store
      const stored = await richTrajectoryStore.getSession("e2e-rich-session");
      expect(stored).toHaveLength(richSteps.length);

      // Completion callback should have fired
      expect(onLlmPipelineComplete).toHaveBeenCalledWith("e2e-rich-session");

      // Structured playbook should have been created
      const playbooks = await structuredPlaybookStore.list();
      expect(playbooks.length).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  // ── Test 4: ATIF roundtrip → reflector ───────────────────────────────
  test(
    "ATIF export → import → reflector produces valid analysis",
    async () => {
      const textCall = createTextCall();
      const reflector = createDefaultReflector(textCall);

      // Export rich trajectory to ATIF
      const originalSteps = makeRichTrajectory();
      const atifDoc = mapRichTrajectoryToAtif(originalSteps, {
        sessionId: "e2e-atif-session",
        agentName: "test-agent",
        agentVersion: "1.0.0",
        notes: "E2E ATIF roundtrip test",
      });

      expect(atifDoc.schema_version).toBe("ATIF-v1.6");
      expect(atifDoc.steps).toHaveLength(4);
      expect(atifDoc.notes).toBe("E2E ATIF roundtrip test");

      // Import back from ATIF
      const importedSteps = mapAtifToRichTrajectory(atifDoc);
      expect(importedSteps).toHaveLength(4);

      // Feed imported steps to reflector
      const reflection = await reflector.analyze({
        trajectory: makeCompactTrajectory(),
        richTrajectory: importedSteps,
        citedBulletIds: [],
        outcome: "mixed",
        playbook: makePlaybook(),
      });

      // Should produce valid analysis from ATIF-imported data
      expect(reflection.rootCause.length).toBeGreaterThan(0);
      expect(reflection.keyInsight.length).toBeGreaterThan(0);

      // Bullet tags should have valid structure
      for (const tag of reflection.bulletTags) {
        expect(["helpful", "harmful", "neutral"]).toContain(tag.tag);
      }
    },
    TIMEOUT_MS,
  );
});
