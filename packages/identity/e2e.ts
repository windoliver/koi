/**
 * Manual E2E script for @koi/identity middleware.
 *
 * Tests the full stack: manifest → personasFromManifest → createIdentityMiddleware
 * → createKoi (L1 assembly + guards + middleware chain) → createPiAdapter → real LLM.
 *
 * Run:
 *   bun packages/identity/e2e.ts
 *
 * Requires ANTHROPIC_API_KEY in .env (auto-loaded by Bun).
 */

import type { AgentManifest, EngineEvent } from "@koi/core";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createIdentityMiddleware } from "./src/identity.js";
import { personasFromManifest } from "./src/manifest.js";

// ── Config ────────────────────────────────────────────────────────────────────

const API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
if (API_KEY.length === 0) {
  console.error("ANTHROPIC_API_KEY not set — aborting.");
  process.exit(1);
}

const MODEL = "anthropic:claude-haiku-4-5-20251001";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function collectText(events: AsyncIterable<EngineEvent>): Promise<{
  text: string;
  tokens: number;
  turns: number;
  stopReason: string;
}> {
  const parts: string[] = [];
  let tokens = 0;
  let turns = 0;
  let stopReason = "unknown";
  for await (const e of events) {
    if (e.kind === "text_delta") parts.push(e.delta);
    if (e.kind === "done") {
      tokens = e.output.metrics.totalTokens;
      turns = e.output.metrics.turns;
      stopReason = e.output.stopReason;
    }
  }
  return { text: parts.join(""), tokens, turns, stopReason };
}

function pass(label: string, detail?: string): void {
  console.log(`  ✓  ${label}${detail !== undefined ? `  (${detail})` : ""}`);
}
function fail(label: string, detail: string): void {
  console.error(`  ✗  ${label}  →  ${detail}`);
  process.exitCode = 1;
}
function section(title: string): void {
  console.log(`\n── ${title} ${"─".repeat(Math.max(0, 55 - title.length))}`);
}

// ── Test 1: system message is injected for matching channelId ─────────────────

async function testPersonaInjected(): Promise<void> {
  section("1. Persona injected for matching channelId");

  const manifest: AgentManifest = {
    name: "identity-e2e",
    version: "1.0.0",
    model: { name: MODEL },
    channels: [
      {
        name: "@koi/channel-telegram",
        identity: {
          name: "Zara",
          instructions:
            'You must begin every reply with the exact token "ZARA_ACTIVE" followed by a colon.',
        },
      },
    ],
  };

  const identityMw = await createIdentityMiddleware(personasFromManifest(manifest));
  const piAdapter = createPiAdapter({ model: MODEL, getApiKey: async () => API_KEY });
  const runtime = await createKoi({
    manifest,
    adapter: piAdapter,
    middleware: [identityMw],
    channelId: "@koi/channel-telegram",
    loopDetection: false,
    limits: { maxTurns: 3, maxDurationMs: 30_000, maxTokens: 5_000 },
  });

  const { text, tokens, stopReason } = await collectText(
    runtime.run({ kind: "text", text: "Say hello." }),
  );
  await runtime.dispose();

  if (stopReason === "completed") {
    pass("stopReason = completed");
  } else {
    fail("stopReason", stopReason);
  }

  if (tokens > 0) {
    pass("tokens > 0", `${String(tokens)} tokens`);
  } else {
    fail("tokens", "got 0");
  }

  if (text.includes("ZARA_ACTIVE")) {
    pass(
      'response contains "ZARA_ACTIVE" — persona system message was honoured',
      text.slice(0, 80),
    );
  } else {
    fail('response should contain "ZARA_ACTIVE"', `got: "${text.slice(0, 120)}"`);
  }
}

// ── Test 2: no injection when channelId does not match ────────────────────────

async function testPersonaNotInjectedOnMismatch(): Promise<void> {
  section("2. No persona injection when channelId does not match");

  const manifest: AgentManifest = {
    name: "identity-e2e-mismatch",
    version: "1.0.0",
    model: { name: MODEL },
    channels: [
      {
        name: "@koi/channel-telegram",
        identity: {
          instructions:
            'You must begin every reply with the exact token "ZARA_ACTIVE" followed by a colon.',
        },
      },
    ],
  };

  // channelId = "@koi/channel-slack" — no matching persona
  const identityMw = await createIdentityMiddleware(personasFromManifest(manifest));
  const piAdapter = createPiAdapter({ model: MODEL, getApiKey: async () => API_KEY });
  const runtime = await createKoi({
    manifest,
    adapter: piAdapter,
    middleware: [identityMw],
    channelId: "@koi/channel-slack", // mismatch
    loopDetection: false,
    limits: { maxTurns: 3, maxDurationMs: 30_000, maxTokens: 5_000 },
  });

  const { text, stopReason } = await collectText(
    runtime.run({ kind: "text", text: 'Reply with exactly the word "hello" and nothing else.' }),
  );
  await runtime.dispose();

  if (stopReason === "completed") {
    pass("stopReason = completed");
  } else {
    fail("stopReason", stopReason);
  }

  if (!text.includes("ZARA_ACTIVE")) {
    pass(
      'response does NOT contain "ZARA_ACTIVE" — persona correctly suppressed',
      text.slice(0, 80),
    );
  } else {
    fail(
      'response should NOT contain "ZARA_ACTIVE" when channelId mismatches',
      `got: "${text.slice(0, 120)}"`,
    );
  }
}

// ── Test 3: no injection when channelId is absent ────────────────────────────

async function testPersonaNotInjectedWithoutChannelId(): Promise<void> {
  section("3. No persona injection when channelId is absent (undefined)");

  const manifest: AgentManifest = {
    name: "identity-e2e-no-channel",
    version: "1.0.0",
    model: { name: MODEL },
    channels: [
      {
        name: "@koi/channel-telegram",
        identity: {
          instructions:
            'You must begin every reply with the exact token "ZARA_ACTIVE" followed by a colon.',
        },
      },
    ],
  };

  const identityMw = await createIdentityMiddleware(personasFromManifest(manifest));
  const piAdapter = createPiAdapter({ model: MODEL, getApiKey: async () => API_KEY });
  // No channelId in CreateKoiOptions → SessionContext.channelId = undefined
  const runtime = await createKoi({
    manifest,
    adapter: piAdapter,
    middleware: [identityMw],
    loopDetection: false,
    limits: { maxTurns: 3, maxDurationMs: 30_000, maxTokens: 5_000 },
  });

  const { text, stopReason } = await collectText(
    runtime.run({ kind: "text", text: 'Reply with exactly the word "hello" and nothing else.' }),
  );
  await runtime.dispose();

  if (stopReason === "completed") {
    pass("stopReason = completed");
  } else {
    fail("stopReason", stopReason);
  }

  if (!text.includes("ZARA_ACTIVE")) {
    pass('response does NOT contain "ZARA_ACTIVE" — no-op without channelId', text.slice(0, 80));
  } else {
    fail(
      'response should NOT contain "ZARA_ACTIVE" when no channelId is set',
      `got: "${text.slice(0, 120)}"`,
    );
  }
}

// ── Test 4: multiple channels — correct persona per channel ───────────────────

async function testMultiChannelIsolation(): Promise<void> {
  section("4. Multi-channel isolation — correct persona selected per channelId");

  // Use persona names as the verification signal — the model reliably introduces
  // itself by name when given "You are <Name>." via the system prompt.
  const manifest: AgentManifest = {
    name: "identity-e2e-multi",
    version: "1.0.0",
    model: { name: MODEL },
    channels: [
      {
        name: "@koi/channel-telegram",
        identity: { name: "Telegra", instructions: "Always introduce yourself by name first." },
      },
      {
        name: "@koi/channel-slack",
        identity: { name: "Slackra", instructions: "Always introduce yourself by name first." },
      },
    ],
  };

  const identityMw = await createIdentityMiddleware(personasFromManifest(manifest));

  // Run with telegram channelId
  const piA = createPiAdapter({ model: MODEL, getApiKey: async () => API_KEY });
  const rtA = await createKoi({
    manifest,
    adapter: piA,
    middleware: [identityMw],
    channelId: "@koi/channel-telegram",
    loopDetection: false,
    limits: { maxTurns: 3, maxDurationMs: 30_000, maxTokens: 5_000 },
  });
  const { text: textA } = await collectText(rtA.run({ kind: "text", text: "Introduce yourself." }));
  await rtA.dispose();

  // Run with slack channelId
  const piB = createPiAdapter({ model: MODEL, getApiKey: async () => API_KEY });
  const rtB = await createKoi({
    manifest,
    adapter: piB,
    middleware: [identityMw],
    channelId: "@koi/channel-slack",
    loopDetection: false,
    limits: { maxTurns: 3, maxDurationMs: 30_000, maxTokens: 5_000 },
  });
  const { text: textB } = await collectText(rtB.run({ kind: "text", text: "Introduce yourself." }));
  await rtB.dispose();

  if (textA.toLowerCase().includes("telegra")) {
    pass('telegram run → persona name "Telegra" present', textA.slice(0, 80));
  } else {
    fail('telegram run should contain "Telegra"', `got: "${textA.slice(0, 120)}"`);
  }

  if (!textA.toLowerCase().includes("slackra")) {
    pass('telegram run → "Slackra" absent (correct isolation)');
  } else {
    fail('telegram run should NOT contain "Slackra"', `got: "${textA.slice(0, 120)}"`);
  }

  if (textB.toLowerCase().includes("slackra")) {
    pass('slack run → persona name "Slackra" present', textB.slice(0, 80));
  } else {
    fail('slack run should contain "Slackra"', `got: "${textB.slice(0, 120)}"`);
  }

  if (!textB.toLowerCase().includes("telegra")) {
    pass('slack run → "Telegra" absent (correct isolation)');
  } else {
    fail('slack run should NOT contain "Telegra"', `got: "${textB.slice(0, 120)}"`);
  }
}

// ── Test 5: hot-reload via manual reload() ────────────────────────────────────

async function testHotReload(): Promise<void> {
  section("5. Hot-reload — reload() swaps persona mid-session");

  // Use persona names (reliable signal) loaded from a file so reload() re-reads the file.
  const tmpFile = "/tmp/koi-identity-e2e-persona.md";
  await Bun.write(tmpFile, "You are Beforera. Always introduce yourself by name first.");

  const manifest: AgentManifest = {
    name: "identity-e2e-reload",
    version: "1.0.0",
    model: { name: MODEL },
  };

  const identityMw = await createIdentityMiddleware({
    personas: [{ channelId: "@koi/channel-telegram", instructions: { path: tmpFile } }],
  });

  const makeRuntime = async () => {
    const pi = createPiAdapter({ model: MODEL, getApiKey: async () => API_KEY });
    return createKoi({
      manifest,
      adapter: pi,
      middleware: [identityMw],
      channelId: "@koi/channel-telegram",
      loopDetection: false,
      limits: { maxTurns: 3, maxDurationMs: 30_000, maxTokens: 5_000 },
    });
  };

  // Run before reload
  const rtBefore = await makeRuntime();
  const { text: textBefore } = await collectText(
    rtBefore.run({ kind: "text", text: "Introduce yourself." }),
  );
  await rtBefore.dispose();

  if (textBefore.toLowerCase().includes("beforera")) {
    pass('before reload → persona "Beforera" present', textBefore.slice(0, 80));
  } else {
    fail('before reload should contain "Beforera"', `got: "${textBefore.slice(0, 120)}"`);
  }

  // Swap persona file and reload
  await Bun.write(tmpFile, "You are Afterra. Always introduce yourself by name first.");
  await identityMw.reload();
  pass("reload() completed without error");

  // Run after reload — new runtime, same middleware instance
  const rtAfter = await makeRuntime();
  const { text: textAfter } = await collectText(
    rtAfter.run({ kind: "text", text: "Introduce yourself." }),
  );
  await rtAfter.dispose();

  if (textAfter.toLowerCase().includes("afterra")) {
    pass('after reload → persona "Afterra" present', textAfter.slice(0, 80));
  } else {
    fail('after reload should contain "Afterra"', `got: "${textAfter.slice(0, 120)}"`);
  }

  if (!textAfter.toLowerCase().includes("beforera")) {
    pass('after reload → "Beforera" absent (old persona evicted)');
  } else {
    fail('after reload should NOT contain "Beforera"', `got: "${textAfter.slice(0, 120)}"`);
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

console.log("@koi/identity E2E — createKoi + createPiAdapter + real LLM");
console.log(`model: ${MODEL}`);

const t0 = Date.now();
await testPersonaInjected();
await testPersonaNotInjectedOnMismatch();
await testPersonaNotInjectedWithoutChannelId();
await testMultiChannelIsolation();
await testHotReload();

const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const ok = process.exitCode === undefined || process.exitCode === 0;
console.log(`\n${"─".repeat(58)}`);
console.log(`${ok ? "ALL PASS" : "FAILURES ABOVE"} — ${elapsed}s`);
