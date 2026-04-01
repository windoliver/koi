/**
 * Deployable registry factory — wires real verification and scanning
 * implementations into a community registry handler.
 *
 * This is the entrypoint for running a production community registry server.
 * It connects:
 * - Content-hash integrity verification via @koi/forge-integrity
 * - Attestation signature verification via @koi/forge-integrity
 * - Skill-scanner-based security gate via @koi/skill-scanner
 */

import type { BrickArtifact, BrickRegistryBackend, SigningBackend } from "@koi/core";
import {
  verifyAttestation as verifyAttestationImpl,
  verifyBrickIntegrity as verifyBrickIntegrityImpl,
} from "@koi/forge-integrity";
import { createCommunityRegistryHandler } from "./handler.js";
import type { CommunityRegistryConfig, SecurityGate, SecurityGateResult } from "./types.js";

// ---------------------------------------------------------------------------
// Config for the default registry
// ---------------------------------------------------------------------------

export interface DefaultRegistryConfig {
  /** The backend registry implementation (e.g., SQLite or in-memory). */
  readonly registry: BrickRegistryBackend;
  /** Valid auth tokens for publish access. */
  readonly authTokens: ReadonlySet<string>;
  /** Signing backend for attestation verification (e.g., HMAC-SHA256). */
  readonly signer: SigningBackend;
  /** Whether to enable the skill-scanner security gate. Default: true. */
  readonly enableSecurityGate?: boolean;
}

// ---------------------------------------------------------------------------
// Default security gate backed by @koi/skill-scanner
// ---------------------------------------------------------------------------

function createScannerSecurityGate(): SecurityGate {
  return {
    check: async (brick: BrickArtifact): Promise<SecurityGateResult> => {
      // Lazy import to avoid pulling scanner into lightweight deployments
      const { createScanner } = await import("@koi/skill-scanner");
      const scanner = createScanner();

      // Route to the correct scanner path based on brick kind:
      // - skill bricks use scanSkill() for markdown + NL prompt-injection rules
      // - code bricks use scan() for AST-based security rules
      const isSkill = brick.kind === "skill";
      const content = isSkill
        ? "content" in brick
          ? (brick as { readonly content?: string }).content
          : undefined
        : "implementation" in brick
          ? (brick as { readonly implementation?: string }).implementation
          : undefined;

      if (content === undefined) {
        return { passed: true, score: 100 };
      }

      const report = isSkill
        ? scanner.scanSkill(content)
        : scanner.scan(content, `${brick.name}.ts`);
      const criticalCount = report.findings.filter((f) => f.severity === "CRITICAL").length;
      const highCount = report.findings.filter((f) => f.severity === "HIGH").length;

      // Scoring: start at 100, deduct per finding severity
      const score = Math.max(0, 100 - criticalCount * 40 - highCount * 20);
      const findings = report.findings.map((f) => `[${f.severity}] ${f.rule}: ${f.message}`);

      return {
        passed: score >= 30,
        score,
        ...(findings.length > 0 ? { findings } : {}),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fully-wired community registry handler with real verification.
 *
 * Connects @koi/forge-integrity for content-hash and attestation verification,
 * and @koi/skill-scanner for publish-time security scanning.
 */
export function createDefaultRegistry(
  config: DefaultRegistryConfig,
): ReturnType<typeof createCommunityRegistryHandler> {
  const registryConfig: CommunityRegistryConfig = {
    registry: config.registry,
    authTokens: config.authTokens,

    // Content-hash integrity verification (sync — verifyBrickIntegrity is pure)
    verifyIntegrity: (brick: BrickArtifact) => {
      return verifyBrickIntegrityImpl(brick);
    },

    // Attestation signature verification
    verifyAttestation: async (brick: BrickArtifact): Promise<boolean> => {
      return verifyAttestationImpl(brick.provenance, config.signer);
    },

    // Skill-scanner security gate
    ...(config.enableSecurityGate !== false ? { securityGate: createScannerSecurityGate() } : {}),
  };

  return createCommunityRegistryHandler(registryConfig);
}
