/**
 * Browser ComponentProvider — attaches browser Tool components to an agent.
 *
 * Both engine-claude and engine-pi discover tools via `agent.query<Tool>("tool:")`.
 * This provider creates Tool components from a BrowserDriver, making them
 * available to any engine with zero engine changes.
 *
 * Single-agent design: this provider shares a single BrowserDriver backend.
 * Attaching multiple agents would share browser state (tabs, cookies) and
 * detaching any agent would dispose the backend for all. Create a separate
 * provider instance per agent if multi-agent use is needed.
 */

import type { Agent, AgentId, BrowserDriver, ComponentProvider, Tool, ToolPolicy } from "@koi/core";
import {
  BROWSER,
  createServiceProvider,
  DEFAULT_UNSANDBOXED_POLICY,
  skillToken,
  toolToken,
} from "@koi/core";
import type { BrowserScope } from "@koi/scope";
import { createScopedBrowser } from "@koi/scope";
import {
  BROWSER_SKILL,
  BROWSER_SKILL_NAME,
  type BrowserOperation,
  EVALUATE_OPERATION,
  EVALUATE_POLICY,
  OPERATIONS,
  TRACE_OPERATION_START,
  TRACE_OPERATION_STOP,
  UPLOAD_OPERATION,
} from "./constants.js";
import { createBrowserClickTool } from "./tools/click.js";
import { createBrowserConsoleTool } from "./tools/console.js";
import { createBrowserEvaluateTool } from "./tools/evaluate.js";
import { createBrowserFillFormTool } from "./tools/fill-form.js";
import { createBrowserHoverTool } from "./tools/hover.js";
import { createBrowserNavigateTool } from "./tools/navigate.js";
import { createBrowserPressTool } from "./tools/press.js";
import { createBrowserScreenshotTool } from "./tools/screenshot.js";
import { createBrowserScrollTool } from "./tools/scroll.js";
import { createBrowserSelectTool } from "./tools/select.js";
import { createBrowserSnapshotTool } from "./tools/snapshot.js";
import { createBrowserTabCloseTool } from "./tools/tab-close.js";
import { createBrowserTabFocusTool } from "./tools/tab-focus.js";
import { createBrowserTabNewTool } from "./tools/tab-new.js";
import { createBrowserTraceStartTool } from "./tools/trace-start.js";
import { createBrowserTraceStopTool } from "./tools/trace-stop.js";
import { createBrowserTypeTool } from "./tools/type.js";
import { createBrowserUploadTool } from "./tools/upload.js";
import { createBrowserWaitTool } from "./tools/wait.js";
import {
  type CompiledNavigationSecurity,
  compileNavigationSecurity,
  type NavigationSecurityConfig,
} from "./url-security.js";

export interface BrowserProviderConfig {
  readonly backend: BrowserDriver;
  readonly policy?: ToolPolicy;
  readonly prefix?: string;
  /**
   * Operations to include. Defaults to OPERATIONS (excludes evaluate).
   * To enable evaluate: [...OPERATIONS, "evaluate"]
   * Note: evaluate always uses EVALUATE_POLICY ("promoted") regardless
   * of the policy option.
   */
  readonly operations?: readonly BrowserOperation[];
  /**
   * URL security configuration for browser_navigate and browser_tab_new.
   * When set, navigation to blocked URLs (private IPs, disallowed protocols,
   * domains outside the allowlist) returns a PERMISSION error with an
   * AI-friendly explanation instead of forwarding to the driver.
   *
   * Prefer `scope` for new code — it wraps the entire driver and also
   * gates evaluate() behind policy. `security` is kept for backward
   * compatibility and applies only to navigate/tab_new tools.
   */
  readonly security?: NavigationSecurityConfig;
  /**
   * Browser scope restriction. When set, the backend is wrapped in a scoped
   * proxy that enforces URL allowlists, private address blocking, and
   * trust-tier gating for evaluate(). Supersedes `security` — if both are
   * provided, `scope` takes precedence.
   */
  readonly scope?: BrowserScope;
}

// Re-export for callers using tool factories directly.
export type { CompiledNavigationSecurity, NavigationSecurityConfig };

// ---------------------------------------------------------------------------
// Standard tools — 3-arg factory signature (backend, prefix, policy)
// ---------------------------------------------------------------------------

type StandardOperation = Exclude<
  BrowserOperation,
  "navigate" | "tab_new" | "upload" | "trace_start" | "trace_stop" | "evaluate"
>;

const STANDARD_OPS = new Set<BrowserOperation>([
  "snapshot",
  "click",
  "hover",
  "press",
  "type",
  "select",
  "fill_form",
  "scroll",
  "screenshot",
  "wait",
  "tab_close",
  "tab_focus",
  "console",
]);

const TOOL_FACTORIES: Readonly<
  Record<StandardOperation, (driver: BrowserDriver, prefix: string, policy: ToolPolicy) => Tool>
> = {
  snapshot: createBrowserSnapshotTool,
  click: createBrowserClickTool,
  hover: createBrowserHoverTool,
  press: createBrowserPressTool,
  type: createBrowserTypeTool,
  select: createBrowserSelectTool,
  fill_form: createBrowserFillFormTool,
  scroll: createBrowserScrollTool,
  screenshot: createBrowserScreenshotTool,
  wait: createBrowserWaitTool,
  tab_close: createBrowserTabCloseTool,
  tab_focus: createBrowserTabFocusTool,
  console: createBrowserConsoleTool,
};

// ---------------------------------------------------------------------------
// Custom tools — special factory signatures or driver-optional
// ---------------------------------------------------------------------------

/**
 * Creates the [key, Tool] entries for non-standard browser operations:
 * - navigate/tab_new: 4th arg (security config)
 * - upload/trace_start/trace_stop: driver-optional (skip if not implemented)
 * - evaluate: uses EVALUATE_POLICY instead of config policy
 */
function createCustomToolEntries(
  ops: readonly BrowserOperation[],
  backend: BrowserDriver,
  prefix: string,
  policy: ToolPolicy,
  compiledSecurity: CompiledNavigationSecurity | undefined,
): ReadonlyArray<readonly [string, Tool]> {
  const entries: Array<readonly [string, Tool]> = [];

  for (const op of ops) {
    if (STANDARD_OPS.has(op)) continue;

    if (op === "navigate") {
      const tool = createBrowserNavigateTool(backend, prefix, policy, compiledSecurity);
      entries.push([toolToken(tool.descriptor.name) as string, tool]);
    } else if (op === "tab_new") {
      const tool = createBrowserTabNewTool(backend, prefix, policy, compiledSecurity);
      entries.push([toolToken(tool.descriptor.name) as string, tool]);
    } else if (op === UPLOAD_OPERATION && backend.upload) {
      const tool = createBrowserUploadTool(backend, prefix, policy);
      entries.push([toolToken(tool.descriptor.name) as string, tool]);
    } else if (op === TRACE_OPERATION_START && backend.traceStart) {
      const tool = createBrowserTraceStartTool(backend, prefix, policy);
      entries.push([toolToken(tool.descriptor.name) as string, tool]);
    } else if (op === TRACE_OPERATION_STOP && backend.traceStop) {
      const tool = createBrowserTraceStopTool(backend, prefix, policy);
      entries.push([toolToken(tool.descriptor.name) as string, tool]);
    } else if (op === EVALUATE_OPERATION) {
      const tool = createBrowserEvaluateTool(backend, prefix, EVALUATE_POLICY);
      entries.push([toolToken(tool.descriptor.name) as string, tool]);
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createBrowserProvider(config: BrowserProviderConfig): ComponentProvider {
  const {
    backend: rawBackend,
    policy = DEFAULT_UNSANDBOXED_POLICY,
    prefix = "browser",
    operations = OPERATIONS,
    security,
    scope,
  } = config;

  // When scope is provided, wrap the entire driver. Scope handles navigation
  // security and evaluate trust-tier gating at the driver level.
  const backend = scope !== undefined ? createScopedBrowser(rawBackend, scope) : rawBackend;

  // Compile security config once at construction time for efficient per-call use.
  // Only used when scope is NOT provided (scope handles this internally).
  const compiledSecurity: CompiledNavigationSecurity | undefined =
    scope === undefined && security !== undefined ? compileNavigationSecurity(security) : undefined;

  // let: ref-count for safe backend disposal — only dispose when last agent detaches
  let refCount = 0;
  // let: track attached agent for single-agent safety check
  let attachedAgent: AgentId | undefined;

  function guardAttach(agent: Agent): void {
    refCount++;
    if (attachedAgent === undefined) {
      attachedAgent = agent.pid.id;
    }
  }

  async function guardDetach(): Promise<void> {
    refCount--;
    if (refCount <= 0) {
      attachedAgent = undefined;
      if (backend.dispose) await backend.dispose();
    }
  }

  // Split operations into standard (handled by createServiceProvider factories)
  // and custom (handled by customTools hook).
  const standardOps = operations.filter((op): op is StandardOperation => STANDARD_OPS.has(op));

  // Guard: if no standard ops, we still need at least one for createServiceProvider.
  // Fall back to manual provider construction for the degenerate case.
  if (standardOps.length === 0) {
    const customEntries = createCustomToolEntries(
      operations,
      backend,
      prefix,
      policy,
      compiledSecurity,
    );
    const skillEntry = [skillToken(BROWSER_SKILL_NAME) as string, BROWSER_SKILL] as const;
    const components = new Map<string, unknown>([
      [BROWSER as string, backend],
      ...customEntries,
      skillEntry,
    ]);
    return {
      name: `browser:${backend.name}`,
      attach: async (agent: Agent) => {
        guardAttach(agent);
        return components;
      },
      detach: async (_agent: Agent) => {
        await guardDetach();
      },
    };
  }

  // Wrap createServiceProvider to add ref-counting for backend disposal
  const inner = createServiceProvider({
    name: `browser:${backend.name}`,
    singletonToken: BROWSER,
    backend,
    operations: standardOps,
    factories: TOOL_FACTORIES,
    policy,
    prefix,
    customTools: (b) => [
      ...createCustomToolEntries(operations, b, prefix, policy, compiledSecurity),
      [skillToken(BROWSER_SKILL_NAME) as string, BROWSER_SKILL],
    ],
  });

  return {
    name: inner.name,
    ...(inner.priority !== undefined ? { priority: inner.priority } : {}),
    attach: async (agent: Agent) => {
      guardAttach(agent);
      return inner.attach(agent);
    },
    detach: async (_agent: Agent) => {
      await guardDetach();
    },
  };
}
