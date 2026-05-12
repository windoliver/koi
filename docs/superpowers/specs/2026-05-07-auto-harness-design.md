# Auto-Harness L3 Wiring Design

## Summary

Implement issue `#1355` by adding a new L3 meta-package, `@koi/auto-harness`, that composes the existing demand, synthesis, refinement, verification, policy, and deployment primitives into a reusable auto-harness pipeline. The work is composition-only: no new synthesis or verification algorithms, only wiring, gating, and configuration around the existing v2 building blocks.

## Goals

- Provide a first-class L3 composition entrypoint for auto-harness.
- Wire the demand-to-artifact pipeline through synthesis, verification, policy evaluation, and deployment.
- Make deployment require explicit human approval.
- Halt the pipeline on verification or policy failure.
- Expose configuration for stage enablement and observability.
- Keep runtime and CLI integration thin and declarative.

## Non-Goals

- Rewriting `@koi/harness-synth`, `@koi/harness-search`, `@koi/forge-verifier`, or `@koi/forge-policy`.
- Introducing new forge algorithms or heuristics.
- Expanding the feature beyond the issue scope into broader forge orchestration.
- Porting the archive implementation wholesale when smaller v2 composition points are sufficient.

## Proposed Architecture

### New package: `packages/meta/auto-harness`

Create a dedicated L3 package named `@koi/auto-harness`. This package owns the composition boundary for the auto-harness flow and exports a single main factory:

- `createAutoHarnessStack(config): AutoHarnessStack`

The returned stack should provide:

- a policy-cache middleware instance for insertion into the runtime middleware chain
- a `synthesizeHarness` callback that can be passed into forge auto-forge wiring
- auto-harness session controls such as per-session synthesis limits
- stage-level observability hooks or handles needed by runtime integration

This package should depend on existing lower-level packages only. It should not embed runtime-specific or CLI-specific behavior.

### Pipeline stages

The L3 composition should express this ordered pipeline:

1. `forge-demand` emits a demand signal with failure context.
2. Auto-harness aggregates the relevant failure evidence.
3. `harness-synth` generates an initial candidate.
4. `harness-search` optionally refines the candidate.
5. `forge-verifier` verifies the resulting artifact.
6. `forge-policy` evaluates whether the artifact is eligible to proceed.
7. Deployment is allowed only when:
   - verification succeeds
   - policy evaluation passes
   - explicit human approval is present
8. Once deployed and later promoted, policy-cache registration can short-circuit future calls.

This ordering is mandatory. Verification and policy checks must happen before deployment, and approval must be checked before any deployment side effect occurs.

### Runtime integration

`@koi/runtime` should remain a thin consumer of `@koi/auto-harness`.

Runtime responsibilities:

- read runtime configuration for forge and auto-harness enablement
- instantiate `createAutoHarnessStack(...)` when enabled
- inject the returned middleware and callback into the existing forge wiring
- surface status/telemetry for pipeline observability

Runtime should not reimplement stage transitions or policy/deployment rules. Those rules belong in the auto-harness package.

### CLI integration

`@koi/cli` should only provide configuration and activation plumbing.

CLI responsibilities:

- expose or pass through auto-harness config in existing forge-enabled startup flows
- provide the human approval signal required for deployment
- report stage outcomes in operator-facing output when useful

CLI should not own the synthesis, verification, or policy logic. It is only the operator-facing shell around runtime composition.

## Configuration Model

`AutoHarnessConfig` should include enough structure to wire the pipeline without baking in CLI details. The config should include:

- forge store and notifier dependencies needed by lower layers
- generation callback used by synthesis
- optional refinement limits such as `maxIterations`
- optional per-session synthesis limit such as `maxSynthesesPerSession`
- stage toggles for synthesis/refinement/verification/deployment where supported by the issue
- error and observability callbacks
- an approval callback or approval gate abstraction used to decide whether deployment may proceed

Configuration must preserve one hard invariant:

- deployment cannot proceed without positive human approval

That invariant should not be disabled by configuration.

## Safety Gates

Safety behavior is the central contract of this issue.

### Verification gate

If verification returns a failure result, the pipeline stops and the candidate is not deployed.

### Policy gate

If policy evaluation returns a blocking or violation result, the pipeline stops and the candidate is not deployed.

### Approval gate

If approval is absent, denied, or unavailable, the pipeline stops before deployment. The pipeline may still surface a verified candidate as pending approval, but it must not activate or register it as deployed.

### Deployment gate

Deployment is an L3 composition step, not an implicit side effect of synthesis. A candidate is only considered deployed after the approval, verification, and policy gates all succeed.

## Test Strategy

Testing should prove both composition and halting behavior.

### Package-level tests

Add tests in `packages/meta/auto-harness/src` for:

- stack construction with required outputs
- demand signal routing into synthesis
- verification failure halting deployment
- policy failure halting deployment
- approval absence halting deployment
- configuration toggles enabling or skipping supported stages

### Runtime integration tests

Add tests in `packages/meta/runtime/src/__tests__` for:

- runtime activation of the auto-harness stack when enabled
- runtime omission of the stack when disabled
- middleware insertion and callback wiring into existing forge flows
- observable pipeline status reporting

### End-to-end path test

Add one focused integration-style test proving:

- demand produces a synthesized candidate
- verification passes
- policy passes
- artifact remains undeployed without approval
- artifact becomes deployable or deployed once approval is granted

## Implementation Notes

- Use the archived package under `archive/v1/packages/meta/auto-harness` as a wiring reference only.
- Prefer the current v2 lower-level packages over copying archive internals.
- Keep the public API intentionally small: a single stack factory plus minimal supporting types.
- Follow existing monorepo package conventions for `package.json`, `tsconfig.json`, `tsup.config.ts`, and API surface tests if needed.

## Risks and Mitigations

### Risk: hidden coupling to archived forge wiring

Mitigation: treat archive code as a reference for boundaries and stage order, not as a source to transplant directly.

### Risk: approval logic leaking into CLI-only behavior

Mitigation: define approval as an injected gate in `AutoHarnessConfig`, with CLI providing one concrete implementation.

### Risk: ambiguous deployment semantics

Mitigation: make deployment an explicit post-verification, post-policy, post-approval step in the composition API and tests.

### Risk: incomplete observability

Mitigation: require stage outcome reporting from the stack and verify it in runtime integration tests.

## Acceptance Criteria

The work is complete when:

- `@koi/auto-harness` exists as a live package in `packages/meta/auto-harness`
- runtime can instantiate and wire the package when enabled
- CLI can supply configuration and approval flow without owning the logic
- verification and policy failures stop the pipeline
- deployment cannot happen without explicit approval
- tests cover the demand-to-verified-artifact path and gate behavior
