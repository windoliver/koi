/**
 * BrickListViewer — renders a directory listing of bricks as a table.
 *
 * Shows name, version, and status columns. Rows are clickable (no-op for now).
 */

import { Blocks } from "lucide-react";

interface BrickEntry {
  readonly name?: string;
  readonly version?: string;
  readonly status?: string;
  readonly [key: string]: unknown;
}

const STATUS_COLORS: Readonly<Record<string, string>> = {
  active: "bg-green-500/10 text-green-600",
  disabled: "bg-[var(--color-muted)]/10 text-[var(--color-muted)]",
  error: "bg-red-500/10 text-red-600",
  draft: "bg-yellow-500/10 text-yellow-600",
};

function statusColorClass(status: string): string {
  return STATUS_COLORS[status.toLowerCase()] ?? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]";
}

export function BrickListViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  let bricks: readonly BrickEntry[];
  try {
    const parsed: unknown = JSON.parse(content);
    bricks = Array.isArray(parsed) ? (parsed as readonly BrickEntry[]) : [];
  } catch {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to parse brick list: {path}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <Blocks className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">{path.split("/").pop()}</span>
        <span className="text-xs text-[var(--color-muted)]">{bricks.length} bricks</span>
      </div>
      <div className="flex-1 overflow-auto">
        {bricks.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)] text-xs text-[var(--color-muted)]">
                <th className="px-4 py-2 text-left font-medium">Name</th>
                <th className="px-4 py-2 text-left font-medium">Version</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {bricks.map((brick, i) => (
                <tr
                  key={brick.name ?? i}
                  onClick={() => console.log(`[BrickList] Clicked brick: ${brick.name ?? i}`)}
                  className="cursor-pointer border-b border-[var(--color-border)]/50 hover:bg-[var(--color-muted)]/5"
                >
                  <td className="px-4 py-2 font-medium">{brick.name ?? "unnamed"}</td>
                  <td className="px-4 py-2 font-mono text-xs text-[var(--color-muted)]">
                    {brick.version ?? "-"}
                  </td>
                  <td className="px-4 py-2">
                    {brick.status !== undefined ? (
                      <span className={`rounded px-2 py-0.5 text-xs ${statusColorClass(brick.status)}`}>
                        {brick.status}
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--color-muted)]">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="px-4 py-8 text-center text-sm text-[var(--color-muted)]">
            No bricks found
          </div>
        )}
      </div>
    </div>
  );
}
