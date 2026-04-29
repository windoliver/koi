# @koi/forge-integrity

Content-addressable integrity, minimal provenance construction, and lineage
helpers for forged bricks (L2). Issue #1348.

Identity IS integrity: every `BrickArtifact.id` is a deterministic hash of
its identity-bearing fields. The canonical identity scheme is owned by the
package that produces the brick (e.g. `@koi/forge-tools`'s
`recomputeBrickIdFromArtifact`), not by this package — defining a separate
scheme here would silently diverge from producers and reject valid persisted
artifacts. `verifyBrickIntegrity` therefore takes the recompute function as
a parameter and delegates entirely.

## Surface

- `verifyBrickIntegrity(brick, recompute): IntegrityResult` — calls
  `recompute(brick)` and compares to `brick.id`. Returns `{ kind: "ok" }`,
  `{ kind: "content_mismatch", expectedId, actualId }`, or
  `{ kind: "recompute_failed", reason }` if the recompute function throws.
- `createForgeProvenance(options): ForgeProvenance` — builds a minimal
  provenance struct. **`verification` is required from the caller** so the
  helper cannot stamp drafts as `passed: true` or unsandboxed bricks as
  `sandbox: true`. Out of scope: signing, SLSA serialization, attestation
  caching.
- `getParentBrickId(brick): BrickId | undefined` — surface lineage parent.
- `isDerivedFrom(child, ancestor, store): Promise<boolean>` — bounded walk
  of `provenance.parentBrickId` upwards.
- `findDuplicateById(bricks, candidateId): BrickArtifact | undefined` —
  detect duplicate by `BrickId` equality.

## Wiring

L2: depends on `@koi/core` and `@koi/hash` (L0u). No imports from
`@koi/engine` or peer L2 packages. Producers (e.g. `@koi/forge-tools`) own
the canonical identity scheme; consumers wire these helpers around a
`ForgeStore` plus the producer's recompute function to validate and trace
forged artifacts.

## Out of scope

- Cryptographic attestation / signing (`brick-signing` from v1).
- SLSA v1.0 serialization (`slsa-serializer` from v1).
- LRU attestation caches (`attestation-cache` from v1).
- The canonical identity scheme itself (lives with each producer).
- Verification pipeline orchestration (`@koi/forge-verifier`, #1347).
- Forge policy enforcement (`@koi/forge-policy`, #1349).

## Invariants

- All artifacts immutable — helpers never mutate inputs.
- `verifyBrickIntegrity` is synchronous and pure (no I/O).
- `verifyBrickIntegrity` defines no identity scheme of its own.
- `createForgeProvenance` never invents `verification.passed` or `sandbox`
  values — they must come from the caller.
- `isDerivedFrom` reads through `ForgeStore.load`; cycles fail closed by
  bounding traversal depth (`MAX_LINEAGE_DEPTH`).
