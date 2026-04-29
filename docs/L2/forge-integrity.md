# @koi/forge-integrity

Content-addressable integrity, minimal provenance construction, and lineage
helpers for forged bricks (L2). Issue #1348.

Identity IS integrity: every `BrickArtifact.id` is the SHA-256 of its
canonical content (`extractBrickContent` + companion files). Verification
recomputes the ID and compares to the stored value — no separate hash field.

## Surface

- `extractBrickContent(brick): { kind; content }` — pure mapping from brick
  kind to its hashable primary content (kept verbatim from v1).
- `verifyBrickIntegrity(brick): IntegrityResult` — recomputes the brick's
  content-addressed ID and returns `{ kind: "ok" }` on match,
  `{ kind: "content_mismatch", expectedId, actualId }` on tamper.
- `createForgeProvenance(options): ForgeProvenance` — builds a minimal
  provenance struct from creator + demand + timestamps. Out of scope for v2:
  signing, SLSA serialization, attestation caching.
- `getParentBrickId(brick): BrickId | undefined` — surface lineage parent.
- `isDerivedFrom(child, ancestor, store): Promise<boolean>` — walk the
  lineage chain by following `provenance.parentBrickId` upwards.
- `findDuplicateById(bricks, candidateId): BrickArtifact | undefined` —
  detect content-equivalent duplicate by recomputed ID.

## Wiring

L2: depends on `@koi/core` and `@koi/hash` (L0u). No imports from
`@koi/engine` or peer L2 packages. Consumers wire these helpers around a
`ForgeStore` to validate and trace forged artifacts.

## Out of scope

- Cryptographic attestation / signing (`brick-signing` from v1).
- SLSA v1.0 serialization (`slsa-serializer` from v1).
- LRU attestation caches (`attestation-cache` from v1).
- Verification pipeline orchestration (`@koi/forge-verifier`, #1347).
- Forge policy enforcement (`@koi/forge-policy`, #1349).

## Invariants

- All artifacts immutable — helpers never mutate inputs.
- `verifyBrickIntegrity` is synchronous and pure (no I/O).
- `isDerivedFrom` reads through `ForgeStore.load`; cycles fail closed by
  bounding traversal depth.
- Provenance structs always include `source.forgedBy` (creator) and
  `metadata.startedAt`/`finishedAt`.
