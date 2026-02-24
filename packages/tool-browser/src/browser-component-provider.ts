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
} from "./constants.js";
import { createBrowserClickTool } from "./tools/click.js";
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
import { createBrowserTypeTool } from "./tools/type.js";
import { createBrowserWaitTool } from "./tools/wait.js";

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
}

type ToolFactory = (driver: BrowserDriver, prefix: string, trustTier: TrustTier) => Tool;

const TOOL_FACTORIES: Readonly<Record<BrowserOperation, ToolFactory>> = {
  snapshot: createBrowserSnapshotTool,
  navigate: createBrowserNavigateTool,
  click: createBrowserClickTool,
  hover: createBrowserHoverTool,
  press: createBrowserPressTool,
  type: createBrowserTypeTool,
  select: createBrowserSelectTool,
  fill_form: createBrowserFillFormTool,
  scroll: createBrowserScrollTool,
  screenshot: createBrowserScreenshotTool,
  wait: createBrowserWaitTool,
  tab_new: createBrowserTabNewTool,
  tab_close: createBrowserTabCloseTool,
  tab_focus: createBrowserTabFocusTool,
  evaluate: createBrowserEvaluateTool,
};

export function createBrowserProvider(config: BrowserProviderConfig): ComponentProvider {
  const { backend, trustTier = "verified", prefix = "browser", operations = OPERATIONS } = config;

  return {
    name: `browser:${backend.name}`,

    attach: async (_agent: Agent): Promise<ReadonlyMap<string, unknown>> => {
      const toolEntries = operations.map((op) => {
        const factory = TOOL_FACTORIES[op];
        // evaluate always uses promoted tier regardless of config
        const tier: TrustTier = op === EVALUATE_OPERATION ? EVALUATE_TRUST_TIER : trustTier;
        const tool = factory(backend, prefix, tier);
        return [toolToken(tool.descriptor.name) as string, tool] as const;
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
