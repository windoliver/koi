/**
 * Browser ComponentProvider — attaches browser Tool components to an agent.
 *
 * Both engine-claude and engine-pi discover tools via `agent.query<Tool>("tool:")`.
 * This provider creates Tool components from a BrowserDriver, making them
 * available to any engine with zero engine changes.
 */

import type { Agent, BrowserDriver, ComponentProvider, Tool, TrustTier } from "@koi/core";
import { BROWSER, toolToken } from "@koi/core";
import {
  type BrowserOperation,
  EVALUATE_OPERATION,
  EVALUATE_TRUST_TIER,
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
  readonly trustTier?: TrustTier;
  readonly prefix?: string;
  /**
   * Operations to include. Defaults to OPERATIONS (excludes evaluate).
   * To enable evaluate: [...OPERATIONS, "evaluate"]
   * Note: evaluate always uses EVALUATE_TRUST_TIER ("promoted") regardless
   * of the trustTier option.
   */
  readonly operations?: readonly BrowserOperation[];
  /**
   * URL security configuration for browser_navigate and browser_tab_new.
   * When set, navigation to blocked URLs (private IPs, disallowed protocols,
   * domains outside the allowlist) returns a PERMISSION error with an
   * AI-friendly explanation instead of forwarding to the driver.
   *
   * Can be populated from koi.yaml via manifest.metadata.browser.security:
   * ```yaml
   * metadata:
   *   browser:
   *     security:
   *       allowedDomains: ["example.com", "*.api.example.com"]
   *       allowedProtocols: ["https:"]
   * ```
   */
  readonly security?: NavigationSecurityConfig;
}

// Re-export for callers using tool factories directly.
export type { CompiledNavigationSecurity, NavigationSecurityConfig };

// navigate and tab_new are handled separately in createBrowserProvider
// because they accept an optional security config (4th arg).
// upload, trace_start, trace_stop are handled separately because they are
// driver-optional (guarded with if (backend.method) before registering).
type ToolFactory = (driver: BrowserDriver, prefix: string, trustTier: TrustTier) => Tool;

const TOOL_FACTORIES: Readonly<
  Omit<
    Record<BrowserOperation, ToolFactory>,
    "navigate" | "tab_new" | "upload" | "trace_start" | "trace_stop"
  >
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
  evaluate: createBrowserEvaluateTool,
};

export function createBrowserProvider(config: BrowserProviderConfig): ComponentProvider {
  const {
    backend,
    trustTier = "verified",
    prefix = "browser",
    operations = OPERATIONS,
    security,
  } = config;

  // Compile security config once at construction time for efficient per-call use.
  const compiledSecurity: CompiledNavigationSecurity | undefined =
    security !== undefined ? compileNavigationSecurity(security) : undefined;

  return {
    name: `browser:${backend.name}`,

    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      const toolEntries = operations.flatMap((op) => {
        // evaluate always uses promoted tier regardless of config
        const tier: TrustTier = op === EVALUATE_OPERATION ? EVALUATE_TRUST_TIER : trustTier;

        // navigate and tab_new accept an optional security config (4th arg).
        // upload, trace_start, trace_stop are driver-optional — skip if not implemented.
        // All other tools use the standard 3-arg factory signature.
        let tool: Tool;
        if (op === "navigate") {
          tool = createBrowserNavigateTool(backend, prefix, tier, compiledSecurity);
        } else if (op === "tab_new") {
          tool = createBrowserTabNewTool(backend, prefix, tier, compiledSecurity);
        } else if (op === UPLOAD_OPERATION) {
          if (!backend.upload) return [];
          tool = createBrowserUploadTool(backend, prefix, tier);
        } else if (op === TRACE_OPERATION_START) {
          if (!backend.traceStart) return [];
          tool = createBrowserTraceStartTool(backend, prefix, tier);
        } else if (op === TRACE_OPERATION_STOP) {
          if (!backend.traceStop) return [];
          tool = createBrowserTraceStopTool(backend, prefix, tier);
        } else {
          const factory = TOOL_FACTORIES[op];
          tool = factory(backend, prefix, tier);
        }
        return [[toolToken(tool.descriptor.name) as string, tool] as const];
      });

      return new Map<string, unknown>([[BROWSER as string, backend], ...toolEntries]);
    },

    detach: async (_agent: Agent): Promise<void> => {
      if (backend.dispose) {
        await backend.dispose();
      }
    },
  };
}
