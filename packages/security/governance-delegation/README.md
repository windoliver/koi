# @koi/governance-delegation

L2 implementation of `@koi/core`'s capability + delegation contracts.

- HMAC-SHA256 and Ed25519 signed `CapabilityToken` objects.
- Monotonic attenuation enforced at issue time via `isPermissionSubset`.
- Composite `CapabilityVerifier` dispatching on `proof.kind`.
- In-memory `CapabilityRevocationRegistry` with cascade.

See `docs/L2/governance-delegation.md` for the full contract.
