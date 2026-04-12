/**
 * Type-level tests for SystemSignal, CompositionSchedulerEvent, and SystemSignalSource.
 *
 * These are compile-time correctness tests — the TypeScript compiler IS the test runner.
 * A type error here means the contract is broken. No runtime assertions needed for
 * a types-only file.
 *
 * Covers:
 * 1. Exhaustiveness guard — every SystemSignal variant handled in a switch
 * 2. Structural conformance — a concrete mock satisfies SystemSignalSource
 * 3. ForgeDemandSignal inlining — Extract<SystemSignal, {kind:"forge_demand"}> extends ForgeDemandSignal
 * 4. CompositionSchedulerEvent subset — strictly narrower than SchedulerEvent
 */

import type { AnomalyDetail, AnomalySignal } from "./agent-anomaly.js";
import type { ForgeDemandSignal } from "./forge-demand.js";
import type { SchedulerEvent } from "./scheduler.js";
import type {
  CompositionSchedulerEvent,
  SystemSignal,
  SystemSignalSource,
} from "./system-signal.js";

// ---------------------------------------------------------------------------
// 1. Exhaustiveness guard
// ---------------------------------------------------------------------------
// If a new variant is added to SystemSignal without updating this switch,
// `const _: never = signal` becomes a compile error.

function _assertExhaustiveSystemSignal(signal: SystemSignal): void {
  switch (signal.kind) {
    case "governance":
      return;
    case "vfs":
      return;
    case "forge_demand":
      return;
    case "schedule":
      return;
    case "agent_lifecycle":
      return;
    case "anomaly":
      return;
    case "compaction":
      return;
    default: {
      const _: never = signal;
      void _;
    }
  }
}

// ---------------------------------------------------------------------------
// 5. AnomalyDetail exhaustiveness guard
// ---------------------------------------------------------------------------

function _assertExhaustiveAnomalyDetail(detail: AnomalyDetail): void {
  switch (detail.kind) {
    case "tool_rate_exceeded":
      return;
    case "error_spike":
      return;
    case "tool_repeated":
      return;
    case "model_latency_anomaly":
      return;
    case "denied_tool_calls":
      return;
    case "irreversible_action_rate":
      return;
    case "token_spike":
      return;
    case "tool_diversity_spike":
      return;
    case "tool_ping_pong":
      return;
    case "session_duration_exceeded":
      return;
    case "delegation_depth_exceeded":
      return;
    case "goal_drift":
      return;
    default: {
      const _: never = detail;
      void _;
    }
  }
}

// AnomalySignal wraps AnomalyBase & AnomalyDetail — kind field must be accessible
type _AnomalyHasKind = AnomalySignal extends { kind: string } ? true : false;
const _anomalyHasKind: _AnomalyHasKind = true;
void _anomalyHasKind;

// ---------------------------------------------------------------------------
// 6. VFS rename split — rename variant has from/to, not path
// ---------------------------------------------------------------------------

type _VfsWrite = Extract<SystemSignal, { kind: "vfs"; event: "write" }>;
type _VfsRename = Extract<SystemSignal, { kind: "vfs"; event: "rename" }>;

// write/delete variants must have path
type _WriteHasPath = _VfsWrite extends { path: string } ? true : false;
const _writePathCheck: _WriteHasPath = true;
void _writePathCheck;

// rename variant must have from/to AND path (path = from, for uniform access)
type _RenameHasPath = _VfsRename extends { path: string } ? true : false;
type _RenameHasFrom = _VfsRename extends { from: string } ? true : false;
type _RenameHasTo = _VfsRename extends { to: string } ? true : false;
const _renamePathCheck: _RenameHasPath = true;
const _renameFromCheck: _RenameHasFrom = true;
const _renameToCheck: _RenameHasTo = true;
void _renamePathCheck;
void _renameFromCheck;
void _renameToCheck;

// ---------------------------------------------------------------------------
// 2. Structural conformance — SystemSignalSource
// ---------------------------------------------------------------------------
// Compile error if the SystemSignalSource interface shape changes incompatibly.

const _sourceConformance: SystemSignalSource = {
  name: "test-source",
  watch: (_handler, _opts) => {
    // Verify options shape is accessible
    void _opts?.sampleRateMs;
    void _opts?.replay;
    void _opts?.onError;
    void _opts?.onDisconnect;
    return () => {};
  },
};
void _sourceConformance;

// ---------------------------------------------------------------------------
// 3. ForgeDemandSignal inlining — discriminant extraction
// ---------------------------------------------------------------------------
// Verifies that ForgeDemandSignal is correctly embedded in SystemSignal and
// that the discriminant kind:"forge_demand" narrows to the full ForgeDemandSignal
// interface (including confidence, suggestedBrickKind, context, emittedAt).

type _ForgeDemandExtracted = Extract<SystemSignal, { kind: "forge_demand" }>;
type _ForgeDemandCheck = _ForgeDemandExtracted extends ForgeDemandSignal ? true : false;
const _forgeDemandAssert: _ForgeDemandCheck = true;
void _forgeDemandAssert;

// ---------------------------------------------------------------------------
// 4. CompositionSchedulerEvent — strictly narrower than SchedulerEvent
// ---------------------------------------------------------------------------

// Must be assignable to SchedulerEvent (it is a subset)
type _IsSubset = CompositionSchedulerEvent extends SchedulerEvent ? true : false;
const _subsetCheck: _IsSubset = true;
void _subsetCheck;

// SchedulerEvent must NOT be assignable to CompositionSchedulerEvent
// (i.e., the full union is wider — strictly narrower is enforced)
type _IsStrictlyNarrow = SchedulerEvent extends CompositionSchedulerEvent ? false : true;
const _strictCheck: _IsStrictlyNarrow = true;
void _strictCheck;
