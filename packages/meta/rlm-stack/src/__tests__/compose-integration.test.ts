/**
 * Integration: verify the rlm-stack RLM middleware composes correctly with
 * peer middleware via @koi/engine-compose's sorter.
 *
 * The architectural invariant: RLM_STACK_PRIORITY_FLOOR (801) must sort
 * strictly *after* tool-disclosure (priority 800) so that tool-disclosure's
 * wrapModelCall observes the advertised tool list before RLM segments.
 * Equal priorities have undefined relative order in the engine sorter, so
 * the +1 floor is what makes the ordering deterministic.
 */

import { describe, expect, it } from "bun:test";
import { sortMiddlewareByPhase } from "@koi/engine-compose";
import { createToolDisclosureBundle } from "@koi/middleware-tool-disclosure";
import { createRlmStack } from "../create-rlm-stack.js";
import { RLM_STACK_PRIORITY_FLOOR } from "../types.js";

describe("rlm-stack ↔ engine-compose ordering", () => {
  it("sorts RLM strictly after tool-disclosure when both use defaults", () => {
    const rlm = createRlmStack({
      contextWindowTokens: 200_000,
      acknowledgeSegmentLocalContract: true,
    }).middleware;
    const disclosure = createToolDisclosureBundle().middleware;

    expect(rlm.priority).toBe(RLM_STACK_PRIORITY_FLOOR);
    expect(disclosure.priority).toBe(800);

    const sorted = sortMiddlewareByPhase([rlm, disclosure]);
    expect(sorted.indexOf(rlm)).toBeGreaterThan(sorted.indexOf(disclosure));
  });

  it("preserves the ordering regardless of input order", () => {
    const rlm = createRlmStack({ contextWindowTokens: 200_000 }).middleware;
    const disclosure = createToolDisclosureBundle().middleware;

    const a = sortMiddlewareByPhase([rlm, disclosure]);
    const b = sortMiddlewareByPhase([disclosure, rlm]);

    expect(a.indexOf(rlm)).toBeGreaterThan(a.indexOf(disclosure));
    expect(b.indexOf(rlm)).toBeGreaterThan(b.indexOf(disclosure));
  });

  it("RLM_STACK_PRIORITY_FLOOR is strictly greater than tool-disclosure's priority", () => {
    const disclosure = createToolDisclosureBundle().middleware;
    expect(RLM_STACK_PRIORITY_FLOOR).toBeGreaterThan(disclosure.priority ?? 0);
  });
});
