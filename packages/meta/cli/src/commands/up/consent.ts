/**
 * Interactive data source consent prompts for `koi up`.
 *
 * Uses @clack/prompts to present discovered data sources to the user,
 * allowing them to approve all, deny all, or selectively approve.
 * Non-TTY environments and prompt failures deny all sources (fail closed).
 */

import type { CliOutput } from "@koi/cli-render";
import type { DataSourceDescriptor } from "@koi/core";
import type { ConsentCallbacks, ConsentDecision } from "@koi/data-source-discovery";

/**
 * Creates interactive consent callbacks that use @clack/prompts
 * for batch data source approval during `koi up`.
 */
export function createInteractiveConsent(output: CliOutput): ConsentCallbacks {
  return {
    approve: async () => true,
    presentBatch: async (
      descriptors: readonly DataSourceDescriptor[],
    ): Promise<ConsentDecision> => {
      if (descriptors.length === 0) {
        return { kind: "deny_all" };
      }

      // Non-TTY (CI/piped): deny all — require explicit interactive approval
      if (!output.isTTY) {
        return { kind: "deny_all" };
      }

      return presentBatchInteractive(descriptors, output);
    },
  };
}

async function presentBatchInteractive(
  descriptors: readonly DataSourceDescriptor[],
  output: CliOutput,
): Promise<ConsentDecision> {
  try {
    const p = await import("@clack/prompts");

    // Show summary of discovered sources
    output.info(`Found ${String(descriptors.length)} data source(s):`);
    for (const ds of descriptors) {
      const desc = ds.description !== undefined ? ` — ${ds.description}` : "";
      output.info(`  ${ds.name} (${ds.protocol})${desc}`);
    }

    const choice = await p.select({
      message: "Approve discovered data sources?",
      options: [
        { value: "y", label: "Yes, approve all" },
        { value: "n", label: "No, skip all" },
        ...(descriptors.length > 1 ? [{ value: "s", label: "Select individually" }] : []),
      ],
    });

    if (p.isCancel(choice)) {
      return { kind: "deny_all" };
    }

    if (choice === "y") {
      return { kind: "approve_all" };
    }

    if (choice === "n") {
      return { kind: "deny_all" };
    }

    // Select individually
    const selected = await p.multiselect({
      message: "Select data sources to approve",
      options: descriptors.map((ds) => ({
        value: ds.name,
        label: `${ds.name} (${ds.protocol})`,
        ...(ds.description !== undefined ? { hint: ds.description } : {}),
      })),
      required: false,
    });

    if (p.isCancel(selected)) {
      return { kind: "deny_all" };
    }

    return { kind: "select", approved: selected as string[] };
  } catch {
    // Prompt failure (e.g., piped input) — fail closed, deny all
    return { kind: "deny_all" };
  }
}
