/**
 * Composite factory wiring all four ACE stores onto a single Nexus transport.
 * Mirrors the shape of `createSqlitePlaybookStore` in @koi/playbook-store-sqlite.
 */

import type {
  PlaybookProposalStore,
  PlaybookStore,
  StructuredPlaybook,
  StructuredPlaybookStore,
  TrajectoryStore,
} from "@koi/ace-types";
import { createNexusPlaybookStore } from "./playbook.js";
import { createNexusPlaybookProposalStore } from "./proposal.js";
import { createNexusStructuredPlaybookStore } from "./structured.js";
import { createNexusTrajectoryStore } from "./trajectory.js";
import type { NexusPlaybookStoreConfig } from "./types.js";

export interface NexusPlaybookStoreBundle {
  readonly playbooks: PlaybookStore;
  readonly structuredPlaybooks: Required<
    Pick<StructuredPlaybookStore, "get" | "list" | "save" | "remove" | "getVersion">
  > &
    Pick<StructuredPlaybookStore, "lineageSupported">;
  readonly trajectories: TrajectoryStore;
  readonly proposals: PlaybookProposalStore;
  /** Stable identity for resume guards — derived from basePath. */
  readonly storeId: string;
  readonly close: () => void;
}

const DEFAULT_BASE = "ace";

const noopGetVersion = async (
  _id: string,
  _version: number,
): Promise<StructuredPlaybook | undefined> => undefined;

export function createPlaybookStoreNexus(
  config: NexusPlaybookStoreConfig,
): NexusPlaybookStoreBundle {
  const base = config.basePath ?? DEFAULT_BASE;
  const structured = createNexusStructuredPlaybookStore(config);
  return {
    playbooks: createNexusPlaybookStore(config),
    structuredPlaybooks: {
      get: structured.get,
      list: structured.list,
      save: structured.save,
      remove: structured.remove,
      getVersion: structured.getVersion ?? noopGetVersion,
      // Preserve the lineage-capability flag so middleware fail-closed checks
      // (e.g. ACE rollback path) reject Nexus before attempting commits.
      // Default to false here — Nexus has no version history.
      lineageSupported: structured.lineageSupported ?? false,
    },
    trajectories: createNexusTrajectoryStore(config),
    proposals: createNexusPlaybookProposalStore(config),
    storeId: `nexus:${base}`,
    close: (): void => {
      config.transport.close();
    },
  };
}
