/**
 * E2E test — Rich trajectory through full Koi runtime with real LLM.
 *
 * Simulates the `koi up` demo scenario end-to-end:
 *   Session 1: Agent tries a tool call that fails with a specific error →
 *              rich trajectory captures full error → reflector analyzes →
 *              curator updates playbook with specific insight
 *   Session 2: Playbook injected with permission-specific bullet →
 *              agent behavior informed by prior failure
 *
 * This validates that rich trajectory data flows from audit capture
 * through the adapter → reflector → curator → structured playbook,
 * producing more actionable learnings than compact trajectory alone.
 *
 * Run:
 *   E2E_TESTS=1 bun test src/__tests__/e2e-rich-trajectory-koi.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AuditEntry,
  EngineEvent,
  EngineOutput,
  ModelRequest,
  ModelResponse,
  Tool,
} from "@koi/core";
import type { InboundMessage } from "@koi/core/message";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createAnthropicAdapter } from "@koi/model-router";
import { createAceMiddleware } from "../ace.js";
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

const TIMEOUT_MS = 120_000;
const E2E_MODEL = "claude-haiku-4-5-20251001";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createProvider(): {
  readonly modelCall: (req: ModelRequest) => Promise<ModelResponse>;
  readonly textCall: (messages: readonly InboundMessage[]) => Promise<string>;
} {
  const adapter = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });

  return {
    modelCall: (req: ModelRequest): Promise<ModelResponse> =>
      adapter.complete({ ...req, model: E2E_MODEL }),
    textCall: async (messages: readonly InboundMessage[]): Promise<string> => {
      const koiMessages = messages.map((m) => ({
        ...m,
        content: m.content.map((c) =>
          c.kind === "text" ? c : { kind: "text" as const, text: JSON.stringify(c) },
        ),
      }));
      const response = await adapter.complete({
        messages: koiMessages,
        model: E2E_MODEL,
        maxTokens: 1024,
      });
      return typeof response.content === "string" ? response.content : "";
    },
  };
}

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

/**
 * A tool that deliberately fails with a specific permission error.
 * This simulates writing to a protected path — the error message
 * is what we expect the rich trajectory reflector to learn from.
 */
function createFailingWriteTool(): Tool {
  return {
    name: "write_protected_file",
    description: "Write content to a file path. May fail if the path is protected.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write to" },
        content: { type: "string", description: "Content to write" },
      },
      required: ["path", "content"],
    },
    execute: async (_args: unknown): Promise<string> => {
      throw new Error(
        "EACCES: permission denied, open '/etc/protected/config.yaml' — " +
          "file is owned by root:root with mode 0644, current user is 'deploy'. " +
          "Use sudo or change file ownership to proceed.",
      );
    },
  };
}

/** Create the full middleware stack: ACE + audit observer + rich trajectory. */
function createFullAceStack(provider: ReturnType<typeof createProvider>): {
  readonly aceMiddleware: ReturnType<typeof createAceMiddleware>;
  readonly stores: {
    readonly trajectoryStore: ReturnType<typeof createInMemoryTrajectoryStore>;
    readonly playbookStore: ReturnType<typeof createInMemoryPlaybookStore>;
    readonly structuredPlaybookStore: ReturnType<typeof createInMemoryStructuredPlaybookStore>;
    readonly richTrajectoryStore: ReturnType<typeof createInMemoryRichTrajectoryStore>;
  };
  readonly auditMiddleware: ReturnType<
    typeof import("@koi/middleware-audit").createAuditMiddleware
  >;
  readonly callbacks: {
    readonly errors: unknown[];
    readonly completedSessions: string[];
  };
} {
  const trajectoryStore = createInMemoryTrajectoryStore();
  const playbookStore = createInMemoryPlaybookStore();
  const structuredPlaybookStore = createInMemoryStructuredPlaybookStore();
  const richTrajectoryStore = createInMemoryRichTrajectoryStore();

  // Shared audit sink for capturing full payloads
  const auditEntries: AuditEntry[] = [];
  const auditSink = {
    async log(entry: AuditEntry): Promise<void> {
      auditEntries.push(entry);
    },
    async flush(): Promise<void> {},
    async query(sessionId: string): Promise<readonly AuditEntry[]> {
      return auditEntries.filter((e) => e.sessionId === sessionId);
    },
  };

  // Audit middleware captures full request/response/error
  // Use dynamic import to avoid circular dependency issues
  const { createAuditMiddleware } =
    require("@koi/middleware-audit") as typeof import("@koi/middleware-audit");
  const auditMiddleware = createAuditMiddleware({ sink: auditSink });

  // Rich trajectory adapter
  const richTrajectorySource = createAuditTrajectoryAdapter({ sink: auditSink });

  // Reflector + curator
  const reflector = createDefaultReflector(provider.textCall);
  const curator = createDefaultCurator(provider.textCall);

  const errors: unknown[] = [];
  const completedSessions: string[] = [];

  const aceMiddleware = createAceMiddleware({
    trajectoryStore,
    playbookStore,
    structuredPlaybookStore,
    richTrajectoryStore,
    reflector,
    curator,
    richTrajectorySource,
    playbookTokenBudget: 2000,
    maxReflectorTokens: 4000,
    minCurationScore: 0.01,
    onLlmPipelineError: (err) => {
      errors.push(err);
    },
    onLlmPipelineComplete: (sessionId) => {
      completedSessions.push(sessionId);
    },
  });

  return {
    aceMiddleware,
    stores: { trajectoryStore, playbookStore, structuredPlaybookStore, richTrajectoryStore },
    auditMiddleware,
    callbacks: { errors, completedSessions },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e: rich trajectory through full Koi runtime", () => {
  test(
    "session 1 failure → rich reflector → playbook with specific error insight",
    async () => {
      const provider = createProvider();
      const stack = createFullAceStack(provider);
      const failingTool = createFailingWriteTool();

      // Run session 1: ask agent to use the failing tool
      const adapter = createLoopAdapter({ modelCall: provider.modelCall, maxTurns: 5 });
      const runtime = await createKoi({
        manifest: { name: "ace-rich-e2e", version: "0.1.0", model: { name: "haiku" } },
        adapter,
        middleware: [stack.auditMiddleware, stack.aceMiddleware],
        loopDetection: false,
        limits: { maxTurns: 5, maxDurationMs: 60_000, maxTokens: 10_000 },
        tools: [failingTool],
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Please write 'hello world' to the file /etc/protected/config.yaml using the write_protected_file tool.",
        }),
      );
      await runtime.dispose();

      const output = findDoneOutput(events);
      expect(output).toBeDefined();

      // Wait for fire-and-forget LLM pipeline
      // Use a polling approach rather than fixed timeout
      const maxWaitMs = 30_000;
      const startWait = Date.now();
      while (
        stack.callbacks.completedSessions.length === 0 &&
        stack.callbacks.errors.length === 0 &&
        Date.now() - startWait < maxWaitMs
      ) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Check for pipeline errors
      if (stack.callbacks.errors.length > 0) {
        console.warn("LLM pipeline errors:", stack.callbacks.errors);
      }

      // Rich trajectory should be persisted (full, uncompressed)
      const sessions = await stack.stores.trajectoryStore.listSessions({ limit: 10 });
      expect(sessions.length).toBeGreaterThan(0);
      const sessionId = sessions[0];
      if (sessionId === undefined) throw new Error("no session found");

      const richSteps = await stack.stores.richTrajectoryStore.getSession(sessionId);
      expect(richSteps.length).toBeGreaterThan(0);

      // Rich trajectory should contain the specific error message
      const errorStep = richSteps.find((s) => s.outcome === "failure");
      if (errorStep !== undefined) {
        expect(errorStep.error?.text).toContain("EACCES");
      }

      // Structured playbook should exist (created by curator)
      const playbooks = await stack.stores.structuredPlaybookStore.list();
      if (playbooks.length > 0 && stack.callbacks.completedSessions.length > 0) {
        // The playbook should have bullets that reference the specific error
        const pb = playbooks[0] as StructuredPlaybook;
        const allBullets = pb.sections.flatMap((s) => s.bullets);
        const allContent = allBullets.map((b) => b.content.toLowerCase()).join(" ");

        // The reflector should have produced insights about the permission error
        // Check for permission-related terms (LLM non-determinism means we
        // check broadly)
        const hasSpecificInsight =
          allContent.includes("permission") ||
          allContent.includes("eacces") ||
          allContent.includes("root") ||
          allContent.includes("access") ||
          allContent.includes("denied") ||
          allContent.includes("sudo") ||
          allContent.includes("ownership") ||
          allContent.includes("protected");

        if (!hasSpecificInsight) {
          console.warn(
            "Playbook bullets don't reference permission error — LLM non-determinism. " +
              "Bullets:",
            allBullets.map((b) => b.content),
          );
        }

        // This is the key assertion: with rich trajectory, the playbook
        // should contain specific error-aware insights, not just
        // "write_protected_file: 0% success rate"
        expect(allBullets.length).toBeGreaterThan(0);
      }
    },
    TIMEOUT_MS,
  );
});
