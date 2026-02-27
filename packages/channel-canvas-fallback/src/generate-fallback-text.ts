/**
 * Pure functions to generate fallback text blocks for A2UI surfaces.
 *
 * Produces TextBlock content for channels that cannot render A2UI natively.
 */

import type { TextBlock } from "@koi/core";
import type { A2uiBlockInfo } from "./detect-a2ui.js";

/** Generates a TextBlock with a link to the rendered surface. */
export function generateSuccessText(info: A2uiBlockInfo, url: string): TextBlock {
  const label = info.title ?? info.surfaceId;

  switch (info.kind) {
    case "createSurface":
      return { kind: "text", text: `[Surface] ${label}: ${url}` };
    case "updateComponents":
      return { kind: "text", text: `[Updated] ${label}: ${url}` };
    case "updateDataModel":
      return { kind: "text", text: `[Data updated] ${label}: ${url}` };
    case "deleteSurface":
      return { kind: "text", text: `[Removed] ${label}` };
    default:
      return { kind: "text", text: `[Surface] ${label}: ${url}` };
  }
}

/** Generates a degraded TextBlock when the Gateway call fails. */
export function generateDegradedText(info: A2uiBlockInfo, errorMessage: string): TextBlock {
  const label = info.title ?? info.surfaceId;
  return { kind: "text", text: `[Warning] Could not render surface "${label}": ${errorMessage}` };
}
