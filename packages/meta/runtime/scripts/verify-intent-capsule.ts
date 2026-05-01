/**
 * Verification script — confirms @koi/middleware-intent-capsule is wired into createRuntime
 * AND actually intercepts model calls when active. Not part of the test suite — E2E sanity check.
 */
import type { ModelHandler, ModelRequest, ModelResponse } from "@koi/core";
import { createRuntime } from "../src/index.js";

const handle = createRuntime({
  intentCapsule: { systemPrompt: "You are a verification agent." },
});

const names = handle.middleware.map((mw) => mw.name);
const intentCapsuleMw = handle.middleware.find((mw) => mw.name === "intent-capsule");

console.log("=== Wiring check ===");
console.log("middleware names:", names.join(", "));
console.log("intent-capsule found:", intentCapsuleMw !== undefined);
console.log("priority:", intentCapsuleMw?.priority);

if (!intentCapsuleMw) {
  console.error("FAIL: intent-capsule not in middleware list");
  process.exit(1);
}

console.log("\n=== Behavior check: wrapModelCall fires + verifies capsule ===");

const sessionCtx = {
  agentId: "verify-agent",
  sessionId: "verify-session" as never,
  runId: "verify-run" as never,
  metadata: {},
};

const turnCtx = {
  session: sessionCtx,
  turnIndex: 0,
  turnId: "verify-turn" as never,
  messages: [],
  metadata: {},
};

const modelRequest: ModelRequest = {
  messages: [{ senderId: "user", timestamp: Date.now(), content: [{ kind: "text", text: "hi" }] }],
};

let nextCalled = false;
const mockNext: ModelHandler = async (_req) => {
  nextCalled = true;
  return { content: "verified", model: "mock" } satisfies ModelResponse;
};

// Step 1: call wrapModelCall WITHOUT onSessionStart — must throw capsule_not_found
console.log("Step 1: wrapModelCall without onSessionStart");
try {
  await intentCapsuleMw.wrapModelCall?.(turnCtx, modelRequest, mockNext);
  console.error("  FAIL: should have thrown");
  process.exit(1);
} catch (e) {
  const err = e as { code?: string; context?: { detail?: string } };
  if (err.code === "PERMISSION" && err.context?.detail === "capsule_not_found") {
    console.log("  PASS: throws PERMISSION/capsule_not_found");
  } else {
    console.error("  FAIL: wrong error", e);
    process.exit(1);
  }
}

// Step 2: call onSessionStart, then wrapModelCall — must succeed and call next
console.log("Step 2: onSessionStart then wrapModelCall");
await intentCapsuleMw.onSessionStart?.(sessionCtx);
nextCalled = false;
const response = await intentCapsuleMw.wrapModelCall?.(turnCtx, modelRequest, mockNext);
if (response?.content === "verified" && nextCalled) {
  console.log("  PASS: capsule verified, next() called");
} else {
  console.error("  FAIL: response or next call missing", { response, nextCalled });
  process.exit(1);
}

// Step 3: onSessionEnd, then wrapModelCall — must throw capsule_not_found again
console.log("Step 3: onSessionEnd then wrapModelCall");
await intentCapsuleMw.onSessionEnd?.(sessionCtx);
try {
  await intentCapsuleMw.wrapModelCall?.(turnCtx, modelRequest, mockNext);
  console.error("  FAIL: should have thrown after onSessionEnd");
  process.exit(1);
} catch (e) {
  const err = e as { code?: string; context?: { detail?: string } };
  if (err.code === "PERMISSION" && err.context?.detail === "capsule_not_found") {
    console.log("  PASS: throws PERMISSION/capsule_not_found after cleanup");
  } else {
    console.error("  FAIL: wrong error", e);
    process.exit(1);
  }
}

console.log("\n=== ALL CHECKS PASSED ===");
