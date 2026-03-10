/**
 * SnapshotOverviewViewer — renders snapshot chains directory root.
 *
 * Shows a list of chains with name, length, and latest hash.
 */

import { GitBranch, Link } from "lucide-react";

interface SnapshotOverviewData {
  readonly chains?: readonly SnapshotOverviewChain[];
  readonly totalChains?: number;
  readonly [key: string]: unknown;
}

interface SnapshotOverviewChain {
  readonly chainId?: string;
  readonly name?: string;
  readonly length?: number;
  readonly latestHash?: string;
  readonly [key: string]: unknown;
}

function shortHash(hash: string): string {
  return hash.length > 12 ? hash.slice(0, 12) : hash;
}

export function SnapshotOverviewViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  let data: SnapshotOverviewData;
  try {
    data = JSON.parse(content) as SnapshotOverviewData;
  } catch {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to parse snapshot overview: {path}
      </div>
    );
  }

  const chains = data.chains ?? [];
  const totalChains = data.totalChains ?? chains.length;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <GitBranch className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">Snapshot Chains</span>
        <span className="text-xs text-[var(--color-muted)]">{totalChains} chains</span>
      </div>
      <div className="flex-1 overflow-auto">
        {chains.length > 0 ? (
          <div className="divide-y divide-[var(--color-border)]/50">
            {chains.map((chain, i) => (
              <div
                key={chain.chainId ?? i}
                className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--color-muted)]/5"
              >
                <GitBranch className="h-4 w-4 shrink-0 text-[var(--color-muted)]" />
                <div className="flex-1">
                  <div className="text-sm font-medium">
                    {chain.name ?? chain.chainId ?? `Chain #${i}`}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-3 text-xs text-[var(--color-muted)]">
                    {chain.length !== undefined && (
                      <span>{chain.length} nodes</span>
                    )}
                    {chain.latestHash !== undefined && (
                      <span className="font-mono">Latest: {shortHash(chain.latestHash)}</span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => console.log(`[SnapshotOverview] View chain: ${chain.chainId ?? i}`)}
                  className="flex items-center gap-1 text-xs text-[var(--color-primary)] hover:underline"
                >
                  <Link className="h-3 w-3" />
                  View
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-4 py-8 text-center text-sm text-[var(--color-muted)]">
            No snapshot chains found
          </div>
        )}
      </div>
    </div>
  );
}
