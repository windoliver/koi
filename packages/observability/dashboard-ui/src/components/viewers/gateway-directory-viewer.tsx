/**
 * GatewayDirectoryViewer — shown when selecting /global/gateway/ directory.
 *
 * Combines file listing with runtime topology data from the
 * /api/view/gateway/topology endpoint per admin-panel.md §5 contract.
 */

import { useQuery } from "@tanstack/react-query";
import type { GatewayTopology } from "@koi/dashboard-types";
import { File, Folder, Network } from "lucide-react";
import { useFileTree } from "../../hooks/use-file-tree.js";
import { fetchGatewayTopology } from "../../lib/api-client.js";
import { useTreeStore } from "../../stores/tree-store.js";
import { useViewStore } from "../../stores/view-store.js";

export function GatewayDirectoryViewer({
  path,
}: {
  readonly path: string;
}): React.ReactElement {
  const globPattern = useViewStore((s) => s.activeView.globPattern);
  const { entries, isLoading: treeLoading } = useFileTree(
    path,
    globPattern !== undefined ? { glob: globPattern } : undefined,
  );
  const select = useTreeStore((s) => s.select);
  const setExpanded = useTreeStore((s) => s.setExpanded);

  const topology = useQuery({
    queryKey: ["gateway-topology"],
    queryFn: () => fetchGatewayTopology(),
    staleTime: 10_000,
    retry: 1,
  });

  const topo: GatewayTopology | undefined =
    topology.data !== undefined ? topology.data : undefined;

  const sorted = [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <Network className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">Gateway</span>
        {topo !== undefined && (
          <span className="text-xs text-[var(--color-muted)]">
            {topo.nodeCount} nodes, {topo.connections.length} connections
          </span>
        )}
      </div>

      <div className="flex-1 overflow-auto p-4">
        {/* Topology summary */}
        {topo !== undefined && topo.connections.length > 0 && (
          <div className="mb-4 rounded-lg border border-[var(--color-border)] p-4">
            <h3 className="mb-2 text-xs font-medium text-[var(--color-muted)]">
              Live Topology
            </h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {topo.connections.map((conn) => (
                <div
                  key={conn.channelId}
                  className="flex items-center gap-2 rounded border border-[var(--color-border)] p-2 text-xs"
                >
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${
                      conn.connected ? "bg-green-500" : "bg-red-500"
                    }`}
                  />
                  <div className="flex-1">
                    <span className="font-medium">{conn.channelId}</span>
                    <span className="ml-1 text-[var(--color-muted)]">
                      ({conn.channelType})
                    </span>
                  </div>
                  <span className="text-[var(--color-muted)]">
                    {"\u2192"} {String(conn.agentId)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {topology.error !== null && !topology.isLoading && (
          <div className="mb-4 rounded border border-[var(--color-border)] p-3 text-xs text-[var(--color-muted)]">
            Topology data unavailable
          </div>
        )}

        {/* File listing */}
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-medium text-[var(--color-muted)]">
          <Folder className="h-3.5 w-3.5" />
          Gateway Files
          {!treeLoading && (
            <span className="font-normal">({entries.length} items)</span>
          )}
        </h3>

        {treeLoading ? (
          <div className="text-xs text-[var(--color-muted)]">Loading...</div>
        ) : sorted.length === 0 ? (
          <div className="text-xs italic text-[var(--color-muted)]">
            No files
          </div>
        ) : (
          <div className="divide-y divide-[var(--color-border)]/50">
            {sorted.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="flex w-full items-center gap-2 px-2 py-2 text-left text-sm hover:bg-[var(--color-muted)]/5"
                onClick={() => {
                  if (entry.isDirectory) setExpanded(entry.path, true);
                  select(entry.path, entry.isDirectory);
                }}
              >
                {entry.isDirectory ? (
                  <Folder className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
                ) : (
                  <File className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
                )}
                <span className="truncate">{entry.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
