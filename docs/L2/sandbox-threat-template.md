# Sandbox Adapter Threat Model — Template

Every L2 sandbox adapter package MUST ship a doc at
`docs/L2/sandbox-<name>.md` that includes a "Threat model" section using
this template. PRs 2-4 each populate this template for `sandbox-local`,
`sandbox-docker`, and `sandbox-ssh`.

## Trust boundary

Describe what is inside the sandbox boundary and what is outside. A reader
should be able to point at any resource and say "trusted" or "untrusted".

- Inside: ...
- Outside: ...

## Privileged surfaces

Enumerate every surface the adapter exposes that holds privilege relative to
the sandboxed code. Examples: a Docker daemon socket, an SSH agent, a host
filesystem mount.

## Escape vectors

Known or plausible ways code inside the sandbox could break out. Be specific —
"shell injection" is not enough; specify the boundary.

## Mitigations

For each escape vector above, the design choice that prevents it. If a vector
has no mitigation, it must appear in "Residual risk" below.

## Residual risk

Risks the adapter cannot mitigate at its layer. Callers must treat these as
known and accept them or compensate at a higher layer.

## Out-of-scope

What this adapter explicitly does not defend against. Examples: hardware
side-channel attacks, kernel 0-days. Document so future readers don't
mistakenly expect coverage.
