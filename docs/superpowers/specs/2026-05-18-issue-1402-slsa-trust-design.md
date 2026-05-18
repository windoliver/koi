# Issue 1402 SLSA Trust Design

## Scope

This slice builds marketplace trust primitives in `@koi/forge-integrity`. It does not revive the archived v1 community registry server. The package already owns provenance and content integrity, and the v2 docs list SLSA serialization, signing, and attestation verification as deferred forge-integrity work.

## Approach

`@koi/forge-integrity` will expose pure, injectable APIs:

- SLSA v1.0 predicate and in-toto Statement mapping from existing `ForgeProvenance`.
- Attestation signing and verification using the L0 `SigningBackend` contract.
- Install-time provenance verification that composes content integrity with attestation verification.
- VirusTotal scan result types plus a client contract, with no hard-coded network dependency.
- Deterministic trust scoring from provenance, local scanner, VirusTotal, publisher identity, and community reputation signals.

## Boundaries

The implementation stays L2-clean: imports only from `@koi/core` and L0 utilities. Active registry/server wiring is deferred until a v2 community-registry package exists. The archived v1 registry remains reference material for publish-time gate behavior and scoring thresholds.

## Failure Model

Verification fails closed. Missing attestations, invalid signatures, expired provenance, content mismatch, malicious VirusTotal verdicts, and unverified publishers reduce or block trust. The APIs return typed result objects instead of throwing for expected security failures.

## Tests

Targeted tests cover:

- SLSA statement shape.
- Signed provenance verifies.
- Tampered provenance is rejected.
- Expired provenance is rejected.
- Install verification rejects integrity or attestation failures.
- VirusTotal malicious verdict maps to a blocking signal.
- Trust score incorporates all issue signals.
- Publisher identity verification raises trust only when explicitly verified.
