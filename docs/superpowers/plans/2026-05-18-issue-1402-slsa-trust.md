# Issue 1402 SLSA Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SLSA provenance, attestation verification, VirusTotal scan contracts, and deterministic trust scoring primitives for marketplace bricks.

**Architecture:** Keep the implementation in `@koi/forge-integrity`, where provenance and content integrity already live. Use small files for serialization, attestation, install verification, VirusTotal contracts, and trust scoring. All expected security failures return typed results and fail closed.

**Tech Stack:** Bun, TypeScript 6, `bun:test`, existing `@koi/core` and `@koi/hash` contracts.

---

### Task 1: SLSA Serialization

**Files:**
- Create: `packages/lib/forge-integrity/src/slsa.ts`
- Test: `packages/lib/forge-integrity/src/slsa.test.ts`
- Modify: `packages/lib/forge-integrity/src/index.ts`

- [ ] Write failing tests for `mapProvenanceToSlsa` and `mapProvenanceToStatement`.
- [ ] Run `bun test packages/lib/forge-integrity/src/slsa.test.ts` and confirm missing exports fail.
- [ ] Implement SLSA v1.0 predicate mapping and in-toto Statement mapping.
- [ ] Re-run the test and confirm it passes.

### Task 2: Attestation Signing

**Files:**
- Create: `packages/lib/forge-integrity/src/attestation.ts`
- Test: `packages/lib/forge-integrity/src/attestation.test.ts`
- Modify: `packages/lib/forge-integrity/src/index.ts`

- [ ] Write failing tests for signing, verification, tamper rejection, missing attestation, and expiry.
- [ ] Run `bun test packages/lib/forge-integrity/src/attestation.test.ts` and confirm missing exports fail.
- [ ] Implement canonical unsigned provenance serialization, `signAttestation`, and `verifyAttestation`.
- [ ] Re-run the test and confirm it passes.

### Task 3: Install Verification

**Files:**
- Create: `packages/lib/forge-integrity/src/install-verification.ts`
- Test: `packages/lib/forge-integrity/src/install-verification.test.ts`
- Modify: `packages/lib/forge-integrity/src/index.ts`

- [ ] Write failing tests for ok install verification, integrity rejection, and attestation rejection.
- [ ] Implement `verifyInstallProvenance` by composing `BrickVerifier` and attestation verification.
- [ ] Re-run the test and confirm it passes.

### Task 4: VirusTotal Contracts And Trust Scoring

**Files:**
- Create: `packages/lib/forge-integrity/src/virustotal.ts`
- Create: `packages/lib/forge-integrity/src/trust-score.ts`
- Test: `packages/lib/forge-integrity/src/trust-score.test.ts`
- Modify: `packages/lib/forge-integrity/src/index.ts`

- [ ] Write failing tests for malicious VirusTotal verdicts, all-signal trust composition, and publisher identity contribution.
- [ ] Implement injectable VirusTotal types and deterministic `computeTrustScore`.
- [ ] Re-run the test and confirm it passes.

### Task 5: Verification

**Files:**
- Modify only files changed by Tasks 1-4.

- [ ] Run `bunx turbo run test --filter=@koi/forge-integrity`.
- [ ] Run `bunx turbo run typecheck --filter=@koi/forge-integrity`.
- [ ] Run `bunx turbo run lint --filter=@koi/forge-integrity`.
- [ ] Inspect `git diff --stat` and `git status --short`.
