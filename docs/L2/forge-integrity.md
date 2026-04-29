# @koi/forge-integrity

Content-consistency verification, minimal provenance construction, and
lineage helpers for forged bricks (L2). Issue #1348.

**Scope: content-consistency, not authenticity.** A successful verification
result proves only that the brick's stored `id` matches the canonical
recomputation under the expected producer's identity scheme. It does NOT
prove cryptographic authorship — `provenance.builder.id` is read from the
unverified artifact, so a brick fabricated under a trusted producer's name
will still pass here. Producer authenticity requires a separate
signed-attestation check (out of scope for this package).

## Surface

- `verifyBrickIntegrity(brick, registry, expectedBuilderId): IntegrityResult`
  — looks up the recompute registered for `expectedBuilderId`, verifies that
  the brick's self-asserted `provenance.builder.id` matches it, then
  recomputes and compares to `brick.id`. Returns one of `ok`,
  `content_mismatch`, `producer_mismatch`, `producer_unknown`, or
  `recompute_failed`. Fails closed in every error case.
- `createForgeProvenance(options): ForgeProvenance` — builds a minimal
  provenance struct. **`verification`, `classification`, and
  `contentMarkers` are all REQUIRED** so the helper cannot silently
  downgrade a secret artifact, mark a draft as `passed: true`, or omit a PII
  marker. The returned struct (and its mutable subtrees) is deep-frozen.
- `getParentBrickId(brick): BrickId | undefined` — surface lineage parent.
- `isDerivedFrom(child, ancestor, store): Promise<LineageOutcome>` — bounded
  walk of `provenance.parentBrickId` upwards. Returns a typed
  `LineageOutcome` of `derived | not_derived | depth_exceeded |
  cycle_detected | store_error` so callers can distinguish a transient
  store outage from a true non-lineage relationship.
- `findDuplicateById(bricks, candidateId): BrickArtifact | undefined` —
  detect duplicate by `BrickId` equality.

## Wiring

L2: depends on `@koi/core` and `@koi/hash` (L0u). No imports from
`@koi/engine` or peer L2 packages. The canonical identity scheme is owned
by each producer (e.g. `@koi/forge-tools`); operators wire a registry of
trusted producer → recompute pairs into a `verifyBrickIntegrity` call.

## Out of scope

- Cryptographic attestation / signing (`brick-signing` from v1).
- SLSA v1.0 serialization (`slsa-serializer` from v1).
- LRU attestation caches (`attestation-cache` from v1).
- Producer authenticity beyond content-consistency.
- The canonical identity scheme itself (lives with each producer).
- Verification pipeline orchestration (`@koi/forge-verifier`, #1347).
- Forge policy enforcement (`@koi/forge-policy`, #1349).

## Invariants

- Helpers never mutate inputs; the returned `ForgeProvenance` is
  deep-frozen, including `verification`, `externalParameters`, and
  `contentMarkers`.
- `verifyBrickIntegrity` is synchronous and pure (no I/O).
- `verifyBrickIntegrity` defines no identity scheme of its own and never
  trusts the artifact's self-asserted `builder.id` to choose a recompute —
  the caller must supply `expectedBuilderId` out-of-band.
- `createForgeProvenance` never invents trust- or sensitivity-bearing
  values (`verification`, `classification`, `contentMarkers`).
- `isDerivedFrom` reads through `ForgeStore.load`; cycles, depth overruns,
  and store errors all surface as distinct `LineageOutcome` variants
  rather than collapsing to `false`.
