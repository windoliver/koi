/**
 * @koi/self-test — Public types for agent self-verification.
 */

import type {
  AgentManifest,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  JsonObject,
  KoiError,
  KoiMiddleware,
  ToolDescriptor,
  ToolResponse,
} from "@koi/core";

// ---------------------------------------------------------------------------
// Check primitives
// ---------------------------------------------------------------------------

/** Status of a single check. */
export type CheckStatus = "pass" | "fail" | "skip";

/** Built-in check categories plus user-defined custom. */
export type CheckCategory = "manifest" | "middleware" | "tools" | "engine" | "scenarios" | "custom";

/** Result of a single check. */
export interface CheckResult {
  readonly name: string;
  readonly category: CheckCategory;
  readonly status: CheckStatus;
  readonly durationMs: number;
  readonly error?: KoiError;
  /** Human-readable detail (e.g., "manifest.name is empty string"). */
  readonly message?: string;
  /** Machine-readable context for CI tools (e.g., { field: "name" }). */
  readonly metadata?: JsonObject;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

/** Aggregated self-test report. */
export interface SelfTestReport {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly totalDurationMs: number;
  readonly checks: readonly CheckResult[];
  /** True when failed === 0. */
  readonly healthy: boolean;
}

// ---------------------------------------------------------------------------
// Config building blocks
// ---------------------------------------------------------------------------

/** A tool descriptor + optional mock handler for self-test verification. */
export interface SelfTestTool {
  readonly descriptor: ToolDescriptor;
  /** If provided, handler is invoked with empty input to verify it returns valid ToolResponse. */
  readonly handler?: (args: JsonObject) => Promise<ToolResponse>;
}

/** An E2E smoke-test scenario. */
export interface SelfTestScenario {
  readonly name: string;
  readonly input: EngineInput;
  /** Expected text pattern (regex or string) in streamed text_delta output. */
  readonly expectedPattern?: string | RegExp;
  /** Custom assertion function run against the collected events. */
  readonly assert?: (events: readonly EngineEvent[]) => void | Promise<void>;
}

/** A user-defined custom check. */
export interface SelfTestCustomCheck {
  readonly name: string;
  readonly fn: () => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Configuration for createSelfTest. */
export interface SelfTestConfig {
  readonly manifest: AgentManifest;
  /**
   * Engine adapter instance or factory function.
   * - Function: self-test owns lifecycle (creates, uses, disposes).
   * - Object: caller owns lifecycle (dispose check is skipped).
   */
  readonly adapter?: EngineAdapter | (() => EngineAdapter | Promise<EngineAdapter>);
  readonly middleware?: readonly KoiMiddleware[];
  readonly tools?: readonly SelfTestTool[];
  readonly scenarios?: readonly SelfTestScenario[];
  readonly customChecks?: readonly SelfTestCustomCheck[];
  /** Whitelist of categories to run. undefined = all categories. */
  readonly categories?: readonly CheckCategory[];
  /** Per-check timeout in ms. Default: 5000. */
  readonly checkTimeoutMs?: number;
  /** Global run timeout in ms. Default: 30000. */
  readonly timeoutMs?: number;
  /** Stop on first category failure. Default: false. */
  readonly failFast?: boolean;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** The self-test runner returned by createSelfTest. */
export interface SelfTest {
  readonly run: () => Promise<SelfTestReport>;
}
