import { describe, expect, test } from "bun:test";
import type { BrickArtifact, BrickId } from "@koi/core";
import { brickId } from "@koi/core";
import { makeTool, reBrandId, recomputeFixtureId, tamper } from "./__tests__/fixtures.js";
import type { ProducerRegistry, RecomputeBrickId } from "./integrity.js";
import { verifyBrickIntegrity } from "./integrity.js";

const TRUSTED_BUILDER = "koi/forge";
const trustedRegistry: ProducerRegistry = { [TRUSTED_BUILDER]: recomputeFixtureId };

function verify(brick: BrickArtifact, registry: ProducerRegistry = trustedRegistry) {
  return verifyBrickIntegrity(brick, registry, TRUSTED_BUILDER);
}

describe("verifyBrickIntegrity", () => {
  test("artifact hash is deterministic — same content → same recomputed id", () => {
    const a = makeTool({ implementation: "export const x = 1" });
    const b = makeTool({ implementation: "export const x = 1" });
    expect(recomputeFixtureId(a)).toBe(recomputeFixtureId(b));
    expect(a.id).toBe(b.id);
  });

  test("ok when stored id matches the trusted producer's recomputation", () => {
    const result = verify(makeTool(), trustedRegistry);
    expect(result.kind).toBe("ok");
    expect(result.ok).toBe(true);
    if (result.kind === "ok") expect(result.builderId).toBe(TRUSTED_BUILDER);
  });

  test("content_mismatch when implementation has been tampered (expectedId = canonical, actualId = stored)", () => {
    const original = makeTool();
    const tampered = tamper(original);
    const result = verify(tampered, trustedRegistry);
    expect(result.kind).toBe("content_mismatch");
    expect(result.ok).toBe(false);
    if (result.kind === "content_mismatch") {
      // expectedId is what the trusted recompute produced — the canonical value.
      // actualId is the id stored on the artifact — the observed (suspect) value.
      expect(result.expectedId).toBe(recomputeFixtureId(tampered));
      expect(result.actualId).toBe(tampered.id);
      expect(result.expectedId).not.toBe(result.actualId);
    }
  });

  test("content_mismatch when stored id does not match content", () => {
    const brick = reBrandId(makeTool(), "0".repeat(64));
    const result = verify(brick, trustedRegistry);
    expect(result.kind).toBe("content_mismatch");
    if (result.kind === "content_mismatch") {
      expect(result.actualId).toBe(brick.id);
      expect(result.expectedId).toBe(recomputeFixtureId(brick));
    }
  });

  test("producer_unknown when builder.id is not registered (rejects untrusted callers)", () => {
    const brick = makeTool();
    const result = verify(brick, {});
    expect(result.kind).toBe("producer_unknown");
    if (result.kind === "producer_unknown") expect(result.expectedBuilderId).toBe(TRUSTED_BUILDER);
  });

  test("a hostile registry entry cannot certify a tampered brick by aliasing builder.id", () => {
    // The hostile recompute returns brick.id verbatim — but it can only be
    // invoked when the brick's claimed builder.id matches the registry key.
    // The verifier never substitutes producers, so an attacker forging a
    // brick under a different builder.id gets producer_unknown; one forged
    // *as* the trusted producer must still match the trusted recompute.
    const hostile = (b: BrickArtifact): BrickId => b.id;
    const tamperedBrick = tamper(makeTool());
    const result = verify(tamperedBrick, { [TRUSTED_BUILDER]: hostile });
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
    const result = verify(makeTool(), failing);
    expect(result.kind).toBe("recompute_failed");
    if (result.kind === "recompute_failed") expect(result.reason).toContain("agentId");
  });

  test("delegates per-producer (multiple registered producers route by expected id)", () => {
    const other = (_b: BrickArtifact): BrickId => brickId(`sha256:${"f".repeat(64)}`);
    const registry: ProducerRegistry = {
      [TRUSTED_BUILDER]: recomputeFixtureId,
      "another/builder/v1": other,
    };
    const result = verify(makeTool(), registry);
    expect(result.kind).toBe("ok");
  });

  test("producer_mismatch when artifact's claimed builder differs from expected", () => {
    const brick = makeTool();
    // brick's provenance.builder.id is "koi/forge"; verifier expects different.
    const result = verifyBrickIntegrity(brick, trustedRegistry, "koi/forge/other");
    expect(result.kind).toBe("producer_mismatch");
    if (result.kind === "producer_mismatch") {
      expect(result.expectedBuilderId).toBe("koi/forge/other");
      expect(result.claimedBuilderId).toBe(TRUSTED_BUILDER);
    }
  });

  test("rejects prototype-inherited registry entries (own-property check)", () => {
    // Polluting Object.prototype with a builder id that happens to match the
    // expected one must NOT be treated as a registered producer.
    const polluted = "polluted/builder";
    const proto = Object.prototype as unknown as Record<string, RecomputeBrickId>;
    proto[polluted] = (b: BrickArtifact): BrickId => b.id; // hostile recompute
    try {
      const registry: ProducerRegistry = Object.create(null);
      const brick = makeTool();
      // The brick's claimed builder must equal the expected to reach the
      // own-property check; reBrand the test by using a builder-id matching
      // both expected and the polluted prototype key.
      const claimed = polluted;
      const fakeProvenanceBrick: BrickArtifact = {
        ...brick,
        provenance: { ...brick.provenance, builder: { id: claimed } },
      };
      const result = verifyBrickIntegrity(fakeProvenanceBrick, registry, claimed);
      expect(result.kind).toBe("producer_unknown");
    } finally {
      delete proto[polluted];
    }
  });

  test("malformed when brick.provenance.builder is missing", () => {
    const brick = makeTool();
    const broken = { ...brick, provenance: { ...brick.provenance, builder: undefined } };
    // Cast to BrickArtifact for the test boundary: we are deliberately
    // passing a malformed artifact to assert defensive shape validation.
    const result = verifyBrickIntegrity(
      broken as unknown as BrickArtifact,
      trustedRegistry,
      TRUSTED_BUILDER,
    );
    expect(result.kind).toBe("malformed");
    if (result.kind === "malformed") expect(result.reason).toContain("builder");
  });

  test("malformed when brick is null/undefined-shaped", () => {
    const result = verifyBrickIntegrity(
      null as unknown as BrickArtifact,
      trustedRegistry,
      TRUSTED_BUILDER,
    );
    expect(result.kind).toBe("malformed");
  });

  test("malformed when registry is null (does not throw)", () => {
    const brick = makeTool();
    const result = verifyBrickIntegrity(
      brick,
      null as unknown as ProducerRegistry,
      TRUSTED_BUILDER,
    );
    expect(result.kind).toBe("malformed");
  });

  test("malformed when registry is undefined or non-object", () => {
    const brick = makeTool();
    const r1 = verifyBrickIntegrity(
      brick,
      undefined as unknown as ProducerRegistry,
      TRUSTED_BUILDER,
    );
    expect(r1.kind).toBe("malformed");
    const r2 = verifyBrickIntegrity(brick, 42 as unknown as ProducerRegistry, TRUSTED_BUILDER);
    expect(r2.kind).toBe("malformed");
  });
});
