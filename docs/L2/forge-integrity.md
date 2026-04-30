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
- `isDerivedFromUnchecked(child, ancestor, store): Promise<LineageOutcome>`
  — bounded walk of `provenance.parentBrickId` upwards. Result is
  **untrusted**: an attacker who can write to the store can rewrite a
  parent pointer, so this helper is only for diagnostics, UI hints, or
  pre-verification triage. Returns a typed `LineageOutcome` of
  `derived | not_derived | depth_exceeded | cycle_detected | missing_link
  | store_error | malformed`.

The trusted lineage API (`isDerivedFrom`, requiring a lineage-bound
producer) is intentionally not exported in this release — no shipped
producer currently binds lineage fields into its canonical id, so the
helper would fail closed on every real call. It will be exposed in a
follow-up release alongside the `@koi/forge-tools` change that extends
the canonical recompute to cover `parentBrickId`/`evolutionKind`.
- `findContentEquivalentById(bricks, candidate, producerBuilderId, verify, provenanceEquivalent): BrickArtifact | undefined`
  — finds the first stored brick whose canonical *content* matches
  `candidate` AND for which the caller-supplied
  `provenanceEquivalent(candidate, stored)` predicate returns `true`. The
  predicate is **required** because canonical id covers
  content only (name/version/scope/owner/implementation) and not
  provenance fields like `classification`/`contentMarkers`/`verification`
  — the caller's policy must decide whether substitution is safe.

## Lineage trust model (deferred)

A trusted `isDerivedFrom` helper is implemented internally but is not
exported in this release. Integrity verification only proves
`brick.id === recompute(brick)`; if the producer's recompute does not
hash `provenance.parentBrickId`/`evolutionKind`, an attacker can rewrite
the parent pointer while keeping a valid id, and a walk would still
report `derived`. The trusted helper therefore requires the operator to
declare which producers are lineage-bound (via
`createBrickVerifier`'s `lineageBoundBuilders`), and `@koi/forge-tools`
does not yet hash those fields.

The follow-up release will (a) extend the producer's canonical recompute
to cover lineage fields and (b) re-export `isDerivedFrom`. Until then,
only `isDerivedFromUnchecked` is exposed and its result is untrusted.

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
