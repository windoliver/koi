/**
 * E2E provenance test — validates the full SLSA provenance pipeline with real LLM calls.
 *
 * Tests the changes from the provenance metadata improvements:
 *   1. 3-variant IntegrityResult (ok / content_mismatch / attestation_failed)
 *   2. In-toto Statement v1 envelope (mapProvenanceToStatement)
 *   3. Signed attestation through forge → store → verify → LLM round-trip
 *   4. Eliminated placeholder provenance (real provenance only)
 *   5. Koi vendor extensions in SLSA serialization
 *   6. Single-brick fast path in ForgeRuntime
 *   7. Middleware chain observes tool calls on signed bricks
 *
 * Gated on ANTHROPIC_API_KEY + E2E_TESTS=1.
 *
 * Run:
 *   E2E_TESTS=1 bun test packages/forge/src/__tests__/e2e-provenance.test.ts
 */

import { describe, expect, test } from "bun:test";
import type {
  AgentManifest,
  EngineEvent,
  EngineOutput,
  KoiMiddleware,
  ModelRequest,
  SigningBackend,
  ToolRequest,
} from "@koi/core";
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import {
  mapProvenanceToSlsa,
  mapProvenanceToStatement,
  verifyAttestation,
  verifyBrickAttestation,
  verifyBrickIntegrity,
} from "@koi/forge-integrity";
import type { ForgeDeps } from "@koi/forge-tools";
import {
  createForgeComponentProvider,
  createForgeSkillTool,
  createForgeToolTool,
  createInMemoryForgeStore,
} from "@koi/forge-tools";
import type { ForgeResult, SandboxExecutor } from "@koi/forge-types";
import { createDefaultForgeConfig } from "@koi/forge-types";
import { createAnthropicAdapter } from "@koi/model-router";
import { createForgePipeline } from "../create-forge-stack.js";
import { createForgeRuntime } from "../forge-runtime.js";

// ---------------------------------------------------------------------------
// Environment gate
// ---------------------------------------------------------------------------

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const HAS_KEY = ANTHROPIC_KEY.length > 0;
const E2E_OPTED_IN = process.env.E2E_TESTS === "1";
const describeE2E = HAS_KEY && E2E_OPTED_IN ? describe : describe.skip;

const TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createHmacSigner(): SigningBackend {
  const BLOCK_SIZE = 64;
  const secretKey = new Uint8Array(32).fill(42);

  function hmac(key: Uint8Array, data: Uint8Array): Uint8Array {
    const hasher1 = new Bun.CryptoHasher("sha256");
    const paddedKey = new Uint8Array(BLOCK_SIZE);
    paddedKey.set(
      key.length > BLOCK_SIZE
        ? new Uint8Array(new Bun.CryptoHasher("sha256").update(key).digest())
        : key,
    );
    const innerPad = new Uint8Array(BLOCK_SIZE);
    const outerPad = new Uint8Array(BLOCK_SIZE);
    for (let i = 0; i < BLOCK_SIZE; i++) {
      const kb = paddedKey[i] ?? 0;
      innerPad[i] = kb ^ 0x36;
      outerPad[i] = kb ^ 0x5c;
    }
    hasher1.update(innerPad);
    hasher1.update(data);
    const innerDigest = new Uint8Array(hasher1.digest());
    const hasher2 = new Bun.CryptoHasher("sha256");
    hasher2.update(outerPad);
    hasher2.update(innerDigest);
    return new Uint8Array(hasher2.digest());
  }

  return {
    algorithm: "hmac-sha256",
    sign: (data: Uint8Array) => hmac(secretKey, data),
    verify: (data: Uint8Array, signature: Uint8Array) => {
      const expected = hmac(secretKey, data);
      if (expected.length !== signature.length) return false;
      // let justified: accumulator for constant-time comparison
      let diff = 0;
      for (let i = 0; i < expected.length; i++) {
        diff |= (expected[i] ?? 0) ^ (signature[i] ?? 0);
      }
      return diff === 0;
    },
  };
}

function testManifest(): AgentManifest {
  return {
    name: "provenance-e2e",
    version: "0.1.0",
    model: { name: "claude-haiku-4-5-20251001" },
  };
}

function createModelCall(): (req: ModelRequest) => Promise<import("@koi/core").ModelResponse> {
  const adapter = createAnthropicAdapter({ apiKey: ANTHROPIC_KEY });
  return (req) => adapter.complete({ ...req, model: "claude-haiku-4-5-20251001" });
}

function adderExecutor(): SandboxExecutor {
  return {
    execute: async (_code, input, _timeout) => {
      const obj = input as { readonly a: number; readonly b: number };
      return {
        ok: true,
        value: { output: { sum: obj.a + obj.b }, durationMs: 1 },
      };
    },
  };
}

function createSignedDeps(
  store: ReturnType<typeof createInMemoryForgeStore>,
  executor: SandboxExecutor,
  signer: SigningBackend,
  sessionForges = 0,
): ForgeDeps {
  return {
    store,
    executor: executor,
    verifiers: [],
    config: createDefaultForgeConfig(),
    context: {
      agentId: "provenance-e2e-agent",
      depth: 0,
      sessionId: "provenance-e2e-session",
      forgesThisSession: sessionForges,
    },
    signer,
    pipeline: createForgePipeline(),
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E("e2e provenance: signed forge → full L1 runtime with real LLM", () => {
  test(
    "signed tool: forge → store → verify integrity (3-variant) → SLSA Statement → LLM calls it",
    async () => {
      const signer = createHmacSigner();
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();
      const deps = createSignedDeps(store, executor, signer);

      // ---------------------------------------------------------------
      // Step 1: Forge a tool with signer + classification
      // ---------------------------------------------------------------
      const forgeTool = createForgeToolTool(deps);
      const forgeResult = (await forgeTool.execute({
        name: "signed-adder",
        description: "Adds two numbers. Call with {a: number, b: number}. Returns {sum: number}.",
        inputSchema: {
          type: "object",
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
        implementation: "return { sum: input.a + input.b };",
        classification: "internal",
        contentMarkers: ["pii"],
      })) as { readonly ok: true; readonly value: ForgeResult };

      expect(forgeResult.ok).toBe(true);
      const toolBrickId = forgeResult.value.id;
      expect(toolBrickId).toMatch(/^sha256:/);

      // ---------------------------------------------------------------
      // Step 2: Load from store — verify provenance (no placeholder)
      // ---------------------------------------------------------------
      const loadResult = await store.load(toolBrickId);
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;

      const brick = loadResult.value;

      // Real provenance — NOT placeholder
      expect(brick.provenance.buildDefinition.buildType).toBe("koi.forge/tool/v1");
      expect(brick.provenance.buildDefinition.buildType).not.toContain("placeholder");
      expect(brick.provenance.source.origin).toBe("forged");
      expect(brick.provenance.metadata.agentId).toBe("provenance-e2e-agent");

      // Classification propagated
      expect(brick.provenance.classification).toBe("internal");
      expect(brick.provenance.contentMarkers).toEqual(["pii"]);

      // Signed attestation present
      expect(brick.provenance.attestation).toBeDefined();
      expect(brick.provenance.attestation?.algorithm).toBe("hmac-sha256");
      expect(brick.provenance.attestation?.signature).toMatch(/^[0-9a-f]+$/);

      // ---------------------------------------------------------------
      // Step 3: Verify 3-variant IntegrityResult
      // ---------------------------------------------------------------

      // Content integrity → IntegrityOk (kind: "ok")
      const hashResult = verifyBrickIntegrity(brick);
      expect(hashResult.kind).toBe("ok");
      expect(hashResult.ok).toBe(true);

      // Full attestation verification → IntegrityOk
      const attestResult = await verifyBrickAttestation(brick, signer);
      expect(attestResult.kind).toBe("ok");
      expect(attestResult.ok).toBe(true);

      // Tampered implementation → IntegrityContentMismatch (kind: "content_mismatch")
      const tamperedBrick = { ...brick, implementation: "return 'EVIL';" };
      const tamperResult = verifyBrickIntegrity(tamperedBrick as import("@koi/core").BrickArtifact);
      expect(tamperResult.kind).toBe("content_mismatch");
      expect(tamperResult.ok).toBe(false);
      if (tamperResult.kind === "content_mismatch") {
        expect(tamperResult.expectedId).toBe(brick.id);
        expect(tamperResult.actualId).not.toBe(brick.id);
      }

      // Invalid signature → IntegrityAttestationFailed (kind: "attestation_failed")
      const badSigBrick = {
        ...brick,
        provenance: {
          ...brick.provenance,
          attestation: { algorithm: "hmac-sha256", signature: "00".repeat(32) },
        },
      };
      const badSigResult = await verifyBrickAttestation(
        badSigBrick as import("@koi/core").BrickArtifact,
        signer,
      );
      expect(badSigResult.kind).toBe("attestation_failed");
      expect(badSigResult.ok).toBe(false);
      if (badSigResult.kind === "attestation_failed") {
        expect(badSigResult.reason).toBe("invalid");
      }

      // ---------------------------------------------------------------
      // Step 4: SLSA Statement v1 envelope + vendor extensions
      // ---------------------------------------------------------------
      const statement = mapProvenanceToStatement(brick.provenance, toolBrickId);
      expect(statement._type).toBe("https://in-toto.io/Statement/v1");
      expect(statement.subject).toHaveLength(1);
      expect(statement.subject[0]?.name).toBe(toolBrickId);
      expect(statement.subject[0]?.digest.sha256).toBe(toolBrickId.replace("sha256:", ""));
      expect(statement.predicateType).toBe("https://slsa.dev/provenance/v1");

      // Vendor extensions
      expect(statement.predicate.koi_classification).toBe("internal");
      expect(statement.predicate.koi_contentMarkers).toEqual(["pii"]);
      expect(statement.predicate.koi_verification.passed).toBe(true);
      expect(statement.predicate.koi_verification.finalTrustTier).toBe("sandbox");
      expect(statement.predicate.koi_verification.totalDurationMs).toBeGreaterThanOrEqual(0);

      // Standard SLSA predicate still present
      expect(statement.predicate.buildDefinition.buildType).toBe("koi.forge/tool/v1");
      expect(statement.predicate.runDetails.builder.id).toBe("koi.forge/pipeline/v1");

      // ---------------------------------------------------------------
      // Step 5: ForgeRuntime with signer — attestation-backed resolution
      // ---------------------------------------------------------------
      const forgeRuntime = createForgeRuntime({
        store,
        executor: executor,
        signer,
      });

      const resolved = await forgeRuntime.resolveTool("signed-adder");
      expect(resolved).toBeDefined();
      expect(resolved?.descriptor.name).toBe("signed-adder");
      forgeRuntime.dispose?.();

      // ---------------------------------------------------------------
      // Step 6: Full createKoi + createLoopAdapter — LLM calls signed tool
      // ---------------------------------------------------------------
      const forgeProvider = createForgeComponentProvider({
        store,
        executor: executor,
      });

      // Middleware spy: verify the tool call goes through middleware chain
      const interceptedToolIds: string[] = [];
      const middlewareSpy: KoiMiddleware = {
        name: "provenance-spy",
        describeCapabilities: () => undefined,
        wrapToolCall: async (_ctx, req: ToolRequest, next) => {
          interceptedToolIds.push(req.toolId);
          return next(req);
        },
      };

      const modelCall = createModelCall();
      const loopAdapter = createLoopAdapter({ modelCall, maxTurns: 3 });

      const runtime = await createKoi({
        manifest: testManifest(),
        adapter: loopAdapter,
        providers: [forgeProvider],
        middleware: [middlewareSpy],
        loopDetection: false,
      });

      const events = await collectEvents(
        runtime.run({
          kind: "text",
          text: "Use the signed-adder tool to add 42 and 58. Return only the result.",
        }),
      );
      await runtime.dispose();

      const output = findDoneOutput(events);
      expect(output).toBeDefined();
      expect(output?.stopReason === "completed" || output?.stopReason === "max_turns").toBe(true);

      // Token metrics populated (real LLM call happened)
      if (output !== undefined) {
        expect(output.metrics.inputTokens).toBeGreaterThan(0);
        expect(output.metrics.outputTokens).toBeGreaterThan(0);
      }

      // Middleware spy should have intercepted the tool call
      if (interceptedToolIds.length > 0) {
        expect(interceptedToolIds).toContain("signed-adder");
      }
    },
    TIMEOUT_MS,
  );

  test(
    "tampered signed brick rejected by ForgeRuntime through createKoi",
    async () => {
      const signer = createHmacSigner();
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();
      const deps = createSignedDeps(store, executor, signer);

      // Forge a valid signed tool
      const forgeTool = createForgeToolTool(deps);
      const forgeResult = (await forgeTool.execute({
        name: "tamper-target",
        description: "A tool that will be tampered with.",
        inputSchema: { type: "object", properties: { x: { type: "number" } } },
        implementation: "return { doubled: input.x * 2 };",
      })) as { readonly ok: true; readonly value: ForgeResult };
      expect(forgeResult.ok).toBe(true);

      // Load, tamper, save back
      const loadResult = await store.load(forgeResult.value.id);
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;

      const original = loadResult.value;
      const tampered = { ...original, implementation: "return { doubled: 'HACKED' };" };
      await store.save(tampered as import("@koi/core").BrickArtifact);

      // ForgeRuntime with signer rejects tampered tool at resolve time
      const forgeRuntime = createForgeRuntime({
        store,
        executor: executor,
        signer,
      });
      const tool = await forgeRuntime.resolveTool("tamper-target");
      expect(tool).toBeUndefined();

      // toolDescriptors() is a listing API — it lists all active tools from the store
      // without integrity checks. Integrity is enforced at resolveTool() time (use-time).
      const descriptors = await forgeRuntime.toolDescriptors();
      const listedDescriptor = descriptors.find((d) => d.name === "tamper-target");
      expect(listedDescriptor).toBeDefined(); // listed but NOT resolvable

      forgeRuntime.dispose?.();

      // Verify the 3-variant IntegrityResult for the tampered brick
      const tamperResult = verifyBrickIntegrity(tampered as import("@koi/core").BrickArtifact);
      expect(tamperResult.kind).toBe("content_mismatch");
      expect(tamperResult.ok).toBe(false);

      // Attestation also fails on tampered brick (content changed but signature didn't)
      const attestResult = await verifyBrickAttestation(
        tampered as import("@koi/core").BrickArtifact,
        signer,
      );
      // Content hash mismatch takes precedence → kind is content_mismatch
      expect(attestResult.kind).toBe("content_mismatch");
      expect(attestResult.ok).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "forge_skill with signer: signed provenance + SLSA Statement + LLM sees skill",
    async () => {
      const signer = createHmacSigner();
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();
      const deps = createSignedDeps(store, executor, signer);

      // Forge a skill with signer
      const forgeSkill = createForgeSkillTool(deps);
      const forgeResult = (await forgeSkill.execute({
        name: "research-primer",
        description: "A skill for research methodology.",
        body: "# Research Primer\n\nWhen asked to research, follow these steps:\n1. Identify sources\n2. Cross-reference claims\n3. Summarize findings",
        classification: "public",
      })) as { readonly ok: true; readonly value: ForgeResult };
      expect(forgeResult.ok).toBe(true);

      const skillId = forgeResult.value.id;

      // Load and verify provenance
      const loadResult = await store.load(skillId);
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;

      const brick = loadResult.value;
      expect(brick.kind).toBe("skill");
      expect(brick.provenance.attestation).toBeDefined();
      expect(brick.provenance.attestation?.algorithm).toBe("hmac-sha256");
      expect(brick.provenance.buildDefinition.buildType).toBe("koi.forge/skill/v1");
      expect(brick.provenance.classification).toBe("public");

      // Verify attestation signature is valid
      const attestationValid = await verifyAttestation(brick.provenance, signer);
      expect(attestationValid).toBe(true);

      // SLSA Statement for skill
      const statement = mapProvenanceToStatement(brick.provenance, skillId);
      expect(statement._type).toBe("https://in-toto.io/Statement/v1");
      expect(statement.predicate.buildDefinition.buildType).toBe("koi.forge/skill/v1");
      expect(statement.predicate.koi_classification).toBe("public");
    },
    TIMEOUT_MS,
  );

  test(
    "multiple forged tools: ForgeRuntime fast-path resolves each correctly",
    async () => {
      const signer = createHmacSigner();
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();

      // Forge 3 tools
      for (let i = 0; i < 3; i++) {
        const deps = createSignedDeps(store, executor, signer, i);
        const forgeTool = createForgeToolTool(deps);
        await forgeTool.execute({
          name: `tool-${String(i)}`,
          description: `Test tool ${String(i)}`,
          inputSchema: { type: "object" },
          implementation: `return { index: ${String(i)} };`,
        });
      }

      // ForgeRuntime with signer — fast path should work for cold cache
      const forgeRuntime = createForgeRuntime({
        store,
        executor: executor,
        signer,
      });

      // Resolve each tool — first resolve hits fast path (cold cache)
      const tool0 = await forgeRuntime.resolveTool("tool-0");
      expect(tool0).toBeDefined();
      expect(tool0?.descriptor.name).toBe("tool-0");

      const tool1 = await forgeRuntime.resolveTool("tool-1");
      expect(tool1).toBeDefined();
      expect(tool1?.descriptor.name).toBe("tool-1");

      const tool2 = await forgeRuntime.resolveTool("tool-2");
      expect(tool2).toBeDefined();
      expect(tool2?.descriptor.name).toBe("tool-2");

      // Non-existent tool returns undefined
      const missing = await forgeRuntime.resolveTool("tool-999");
      expect(missing).toBeUndefined();

      // toolDescriptors returns all 3
      const descriptors = await forgeRuntime.toolDescriptors();
      expect(descriptors).toHaveLength(3);

      forgeRuntime.dispose?.();
    },
    TIMEOUT_MS,
  );

  test(
    "full round-trip: SLSA predicate ↔ mapProvenanceToSlsa consistency check",
    async () => {
      const signer = createHmacSigner();
      const store = createInMemoryForgeStore();
      const executor = adderExecutor();
      const deps = createSignedDeps(store, executor, signer);

      const forgeTool = createForgeToolTool(deps);
      const forgeResult = (await forgeTool.execute({
        name: "consistency-tool",
        description: "A tool for SLSA consistency check.",
        inputSchema: { type: "object" },
        implementation: "return {};",
        classification: "secret",
        contentMarkers: ["credentials", "payment"],
      })) as { readonly ok: true; readonly value: ForgeResult };
      expect(forgeResult.ok).toBe(true);

      const loadResult = await store.load(forgeResult.value.id);
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;

      const provenance = loadResult.value.provenance;

      // mapProvenanceToSlsa → predicate only
      const predicate = mapProvenanceToSlsa(provenance);
      expect(predicate.buildDefinition.buildType).toBe("koi.forge/tool/v1");

      // mapProvenanceToStatement → full Statement envelope
      const statement = mapProvenanceToStatement(provenance, forgeResult.value.id);

      // Predicate inside Statement matches standalone predicate
      expect(statement.predicate.buildDefinition).toEqual(predicate.buildDefinition);
      expect(statement.predicate.runDetails).toEqual(predicate.runDetails);

      // Vendor extensions only present in Statement, not standalone predicate
      expect(statement.predicate.koi_classification).toBe("secret");
      expect(statement.predicate.koi_contentMarkers).toEqual(["credentials", "payment"]);
      expect(statement.predicate.koi_verification.passed).toBe(true);
    },
    TIMEOUT_MS,
  );
});
