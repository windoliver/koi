/**
 * CatalogComponentProvider — attaches search_catalog and attach_capability
 * as agent tools during assembly.
 */

import type {
  Agent,
  AttachResult,
  BrickKind,
  CatalogEntry,
  CatalogReader,
  ComponentProvider,
  KoiError,
  Result,
} from "@koi/core";
import { COMPONENT_PRIORITY, toolToken } from "@koi/core";
import type { AttachConfig } from "./tools/attach-capability.js";
import { createAttachCapabilityTool } from "./tools/attach-capability.js";
import { createSearchCatalogTool } from "./tools/search-catalog.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CatalogProviderConfig {
  readonly reader: CatalogReader;
  /** BrickKinds permitted for dynamic attachment. Defaults to ["tool", "skill"]. */
  readonly allowedKinds?: readonly BrickKind[];
  /**
   * Callback to perform the actual attach operation.
   * If not provided, attach_capability will return an error indicating
   * that dynamic attachment is not configured.
   */
  readonly onAttach?: (entry: CatalogEntry) => Promise<Result<void, KoiError>>;
}

// ---------------------------------------------------------------------------
// Default attach handler (returns error)
// ---------------------------------------------------------------------------

const DEFAULT_ON_ATTACH = async (): Promise<Result<void, KoiError>> => ({
  ok: false,
  error: {
    code: "INTERNAL",
    message: "Dynamic attachment is not configured for this agent",
    retryable: false,
  },
});

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ComponentProvider that attaches catalog tools to agents.
 *
 * Provides two tools:
 * - `search_catalog`: Search across all capability sources
 * - `attach_capability`: Dynamically attach a capability to the agent
 */
export function createCatalogComponentProvider(config: CatalogProviderConfig): ComponentProvider {
  return {
    name: "catalog",
    priority: COMPONENT_PRIORITY.BUNDLED,
    attach: async (agent: Agent): Promise<AttachResult> => {
      const attachConfig: AttachConfig = {
        allowedKinds: config.allowedKinds ?? ["tool", "skill"],
        onAttach: config.onAttach ?? DEFAULT_ON_ATTACH,
      };

      const searchTool = createSearchCatalogTool(config.reader, agent);
      const attachTool = createAttachCapabilityTool(config.reader, agent, attachConfig);

      // toolToken returns SubsystemToken<Tool> which is a branded string;
      // Map<string, unknown> accepts it directly since branded strings extend string
      const searchKey: string = toolToken("search_catalog");
      const attachKey: string = toolToken("attach_capability");

      const components = new Map<string, unknown>([
        [searchKey, searchTool],
        [attachKey, attachTool],
      ]);

      return { components, skipped: [] };
    },
  };
}
