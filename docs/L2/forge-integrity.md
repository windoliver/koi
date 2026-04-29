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

## Surface (exact `src/index.ts` exports)

- `createBrickVerifier(registry, options?): BrickVerifier` — bind a
  `BrickVerifier` to a frozen, validated producer registry. The returned
  function is the only supported entry point; the per-call
  `verifyBrickIntegrity` is intentionally **not** exported so callers
  cannot pass a request-scoped or attacker-controlled registry on each
  call. `options.lineageBoundBuilders` declares which producers' canonical
  recompute is operator-known to cover lineage fields (see Lineage below).
- `BrickVerifier(brick, expectedBuilderId): IntegrityResult` — verifies
  that the brick's self-asserted `provenance.builder.id` matches
  `expectedBuilderId`, then recomputes and compares to `brick.id`. Returns
  one of `ok`, `content_mismatch`, `producer_mismatch`,
  `producer_unknown`, `recompute_failed`, or `malformed`. Fails closed in
  every error case. The verifier also exposes `coversLineage(builderId)`.
- `createForgeProvenance(options): ForgeProvenance` — builds a minimal
  provenance struct. **`verification`, `classification`, and
  `contentMarkers` are all REQUIRED** so the helper cannot silently
  downgrade a secret artifact, mark a draft as `passed: true`, or omit a
  PII marker. Non-finite numbers (`NaN`/`Infinity`) and non-JSON-plain
  values (Map/Set/Date/functions) are rejected so the record stays stable
  across persist/sign round-trips. The returned struct (and its mutable
  subtrees) is deep-frozen.
- `getParentBrickId(brick): BrickId | undefined` — defensive accessor for
  `provenance.parentBrickId`. Returns `undefined` for malformed shapes.
- `isDerivedFrom(child, ancestor, store, options): Promise<LineageOutcome>`
  — bounded walk of `provenance.parentBrickId` upwards.
  `options.verify` + `options.producerBuilderId` are **required**.
  Returns a typed `LineageOutcome` of `derived | not_derived |
  depth_exceeded | cycle_detected | missing_link | store_error |
  malformed | integrity_failed`.
- `isDerivedFromUnchecked(child, ancestor, store): Promise<LineageOutcome>`
  — legacy unverified walk. Result is **untrusted**; intended only for
  debug tools / UI hints / pre-verification triage. Production trust paths
  must use `isDerivedFrom`.
- `findContentEquivalentById(bricks, candidate, producerBuilderId, verify, provenanceEquivalent): BrickArtifact | undefined`
  — finds the first stored brick whose canonical *content* matches
  `candidate` AND for which the caller-supplied
  `provenanceEquivalent(candidate, stored)` predicate returns `true`. The
  predicate is **required** because canonical id covers
  content only (name/version/scope/owner/implementation) and not
  provenance fields like `classification`/`contentMarkers`/`verification`
  — the caller's policy must decide whether substitution is safe.

## Lineage trust model

`isDerivedFrom` is fail-closed by default: it returns
`integrity_failed` with reason `lineage_unbound` for any producer not
listed in `options.lineageBoundBuilders` at verifier-construction time.

This is intentional. Integrity verification only proves
`brick.id === recompute(brick)`. If the producer's recompute does not hash
`provenance.parentBrickId`/`evolutionKind`, an attacker can rewrite the
parent pointer while keeping a valid id, and an unverified walk would
still report `derived`. A producer is only safe to mark lineage-bound
once its canonical recompute provably includes those lineage fields.

**Today no shipped producer is lineage-bound.** `@koi/forge-tools`
recomputes ids from name/description/version/scope/owner/content only.
Consumers that need trusted lineage queries must:

1. Extend their producer's canonical recompute to cover
   `parentBrickId` and `evolutionKind`, and
2. Pass that `builderId` in `lineageBoundBuilders` when constructing the
   verifier.

Until then, lineage queries fail closed under `isDerivedFrom`. Use
`isDerivedFromUnchecked` only for non-policy-bearing diagnostics.

## Wiring

L2: depends on `@koi/core` and `@koi/hash` (L0u). No imports from
`@koi/engine` or peer L2 packages. Each producer owns its canonical
identity scheme (e.g. `@koi/forge-tools`); operators wire a registry of
trusted producer → recompute pairs into `createBrickVerifier`.

## Out of scope

- Cryptographic attestation / signing (`brick-signing` from v1).
- SLSA v1.0 serialization (`slsa-serializer` from v1).
- LRU attestation caches (`attestation-cache` from v1).
- Producer authenticity beyond content-consistency.
- The canonical identity scheme itself (lives with each producer).
- Verification pipeline orchestration (`@koi/forge-verifier`, #1347).
- Forge policy enforcement (`@koi/forge-policy`, #1349).
- Authenticated builder-transition records that would let lineage
  legitimately cross producer rotations.

## Invariants

- Helpers never mutate inputs; the returned `ForgeProvenance` is
  deep-frozen, including `verification`, `externalParameters`, and
  `contentMarkers`.
- `BrickVerifier` is synchronous and pure (no I/O); registries are
  validated and frozen at `createBrickVerifier` time.
- `BrickVerifier` defines no identity scheme of its own and never trusts
  the artifact's self-asserted `builder.id` to choose a recompute — the
  caller must supply `expectedBuilderId` out-of-band.
- `createForgeProvenance` never invents trust- or sensitivity-bearing
  values (`verification`, `classification`, `contentMarkers`).
- `isDerivedFrom` reads through `ForgeStore.load`; cycles, depth overruns,
  store errors, missing ancestors, and integrity failures all surface as
  distinct `LineageOutcome` variants rather than collapsing to `false`.
- The whole walk is verified under one `producerBuilderId` — ancestors
  cannot self-select a more permissive registered recompute via their own
  `provenance.builder.id`.
