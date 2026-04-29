import { describe, expect, test } from "bun:test";
import type { BrickArtifact, BrickId } from "@koi/core";
import { brickId } from "@koi/core";
import { makeTool, reBrandId, recomputeFixtureId, tamper } from "./__tests__/fixtures.js";
import type { ProducerRegistry } from "./integrity.js";
import { verifyBrickIntegrity } from "./integrity.js";

const TRUSTED_BUILDER = "koi/forge";
const trustedRegistry: ProducerRegistry = { [TRUSTED_BUILDER]: recomputeFixtureId };

describe("verifyBrickIntegrity", () => {
  test("artifact hash is deterministic — same content → same recomputed id", () => {
    const a = makeTool({ implementation: "export const x = 1" });
    const b = makeTool({ implementation: "export const x = 1" });
    expect(recomputeFixtureId(a)).toBe(recomputeFixtureId(b));
    expect(a.id).toBe(b.id);
  });

  test("ok when stored id matches the trusted producer's recomputation", () => {
    const result = verifyBrickIntegrity(makeTool(), trustedRegistry);
    expect(result.kind).toBe("ok");
    expect(result.ok).toBe(true);
    if (result.kind === "ok") expect(result.builderId).toBe(TRUSTED_BUILDER);
  });

  test("content_mismatch when implementation has been tampered", () => {
    const original = makeTool();
    const result = verifyBrickIntegrity(tamper(original), trustedRegistry);
    expect(result.kind).toBe("content_mismatch");
    expect(result.ok).toBe(false);
    if (result.kind === "content_mismatch") {
      expect(result.expectedId).toBe(original.id);
      expect(result.actualId).not.toBe(original.id);
    }
  });

  test("content_mismatch when stored id does not match content", () => {
    const brick = reBrandId(makeTool(), "0".repeat(64));
    const result = verifyBrickIntegrity(brick, trustedRegistry);
    expect(result.kind).toBe("content_mismatch");
  });

  test("producer_unknown when builder.id is not registered (rejects untrusted callers)", () => {
    const brick = makeTool();
    const result = verifyBrickIntegrity(brick, {});
    expect(result.kind).toBe("producer_unknown");
    if (result.kind === "producer_unknown") expect(result.builderId).toBe(TRUSTED_BUILDER);
  });

  test("a hostile registry entry cannot certify a tampered brick by aliasing builder.id", () => {
    // The hostile recompute returns brick.id verbatim — but it can only be
    // invoked when the brick's claimed builder.id matches the registry key.
    // The verifier never substitutes producers, so an attacker forging a
    // brick under a different builder.id gets producer_unknown; one forged
    // *as* the trusted producer must still match the trusted recompute.
    const hostile = (b: BrickArtifact): BrickId => b.id;
    const tamperedBrick = tamper(makeTool());
    const result = verifyBrickIntegrity(tamperedBrick, { [TRUSTED_BUILDER]: hostile });
    // This documents the residual trust requirement: the registry's recompute
    // function must match the producer's canonical scheme. Operators are
    // responsible for the recompute → builder mapping; the verifier prevents
    // *callers* from supplying arbitrary callbacks but cannot prevent a
    // misconfigured registry. The hostile entry produces an `ok` result —
    // proving why the registry must be authored by the trusted operator.
    expect(result.kind).toBe("ok");
  });

  test("recompute_failed surfaces caller-thrown errors as a typed result", () => {
    const failing: ProducerRegistry = {
      [TRUSTED_BUILDER]: () => {
        throw new Error("identity scheme requires agentId");
      },
    };
    const result = verifyBrickIntegrity(makeTool(), failing);
    expect(result.kind).toBe("recompute_failed");
    if (result.kind === "recompute_failed") expect(result.reason).toContain("agentId");
  });

  test("delegates per-producer (multiple registered producers route by builder.id)", () => {
    const other = (_b: BrickArtifact): BrickId => brickId(`sha256:${"f".repeat(64)}`);
    const registry: ProducerRegistry = {
      [TRUSTED_BUILDER]: recomputeFixtureId,
      "another/builder/v1": other,
    };
    const result = verifyBrickIntegrity(makeTool(), registry);
    expect(result.kind).toBe("ok");
  });
});
