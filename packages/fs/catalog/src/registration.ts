/**
 * ToolRegistration for @koi/catalog — self-describing registration descriptor.
 *
 * Exports a factory that creates a ToolRegistration given a CatalogProviderConfig.
 * This bridges the gap between the generic ToolRegistration pattern (which uses
 * Agent + JsonObject) and the catalog's richer CatalogProviderConfig (which
 * includes CatalogReader and other non-serializable deps).
 *
 * Usage in a manifest:
 *   tools:
 *     - name: search_catalog
 *       package: "@koi/catalog"
 *
 * The registration provides both search_catalog and attach_capability tools.
 */

import type { ToolRegistration } from "@koi/core";
import type { CatalogProviderConfig } from "./component-provider.js";
import { createAttachCapabilityTool } from "./tools/attach-capability.js";
import { createSearchCatalogTool } from "./tools/search-catalog.js";

/**
 * Create a ToolRegistration for catalog tools.
 *
 * Call this with a CatalogProviderConfig and export the result as `registration`.
 * The engine's auto-resolution will pick it up from the `package` field.
 */
export function createCatalogRegistration(config: CatalogProviderConfig): ToolRegistration {
  const allowedKinds = config.allowedKinds ?? ["tool", "skill"];
  const onAttach =
    config.onAttach ??
    (async () => ({
      ok: false as const,
      error: {
        code: "INTERNAL" as const,
        message: "Dynamic attachment is not configured for this agent",
        retryable: false,
      },
    }));
  const attachConfig = { allowedKinds, onAttach };

  return {
    name: "catalog",
    tools: [
      {
        name: "search_catalog",
        create: (agent) => createSearchCatalogTool(config.reader, agent),
      },
      {
        name: "attach_capability",
        create: (agent) => createAttachCapabilityTool(config.reader, agent, attachConfig),
      },
    ],
  };
}
