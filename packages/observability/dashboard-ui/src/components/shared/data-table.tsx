/**
 * Data table — generic sortable/filterable table component.
 */

import { ArrowDown, ArrowUp } from "lucide-react";
import { useMemo, useState } from "react";

interface Column {
  readonly key: string;
  readonly label: string;
  readonly sortable?: boolean;
}

interface DataTableProps {
  readonly columns: readonly Column[];
  readonly rows: readonly Record<string, unknown>[];
  readonly onRowClick?: (row: Record<string, unknown>) => void;
  readonly searchPlaceholder?: string;
}

interface SortState {
  readonly key: string;
  readonly direction: "asc" | "desc";
}

function compareValues(a: unknown, b: unknown, direction: "asc" | "desc"): number {
  const multiplier = direction === "asc" ? 1 : -1;

  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;

  if (typeof a === "number" && typeof b === "number") {
    return (a - b) * multiplier;
  }

  return String(a).localeCompare(String(b)) * multiplier;
}

function matchesSearch(row: Record<string, unknown>, query: string): boolean {
  const lower = query.toLowerCase();
  return Object.values(row).some(
    (v) => v !== null && v !== undefined && String(v).toLowerCase().includes(lower),
  );
}

export function DataTable({
  columns,
  rows,
  onRowClick,
  searchPlaceholder = "Filter...",
}: DataTableProps): React.ReactElement {
  const [sort, setSort] = useState<SortState | null>(null);
  const [search, setSearch] = useState("");

  const handleSort = (key: string): void => {
    setSort((prev) => {
      if (prev !== null && prev.key === key) {
        return prev.direction === "asc"
          ? { key, direction: "desc" }
          : null;
      }
      return { key, direction: "asc" };
    });
  };

  const processedRows = useMemo(() => {
    const filtered = search.length > 0
      ? rows.filter((row) => matchesSearch(row, search))
      : rows;

    if (sort === null) return filtered;

    return [...filtered].sort((a, b) =>
      compareValues(a[sort.key], b[sort.key], sort.direction),
    );
  }, [rows, sort, search]);

  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
      {/* Search input */}
      <div className="border-b border-[var(--color-border)] bg-[var(--color-card)] px-3 py-2">
        <input
          type="text"
          value={search}
          onChange={(e) => { setSearch(e.target.value); }}
          placeholder={searchPlaceholder}
          className="w-full bg-transparent text-sm text-[var(--color-foreground)] placeholder:text-[var(--color-muted)] outline-none"
        />
      </div>

      {/* Table */}
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--color-border)] bg-[var(--color-card)]">
            {columns.map((col) => (
              <th
                key={col.key}
                className={`px-3 py-2 text-left font-mono text-xs font-medium uppercase tracking-wider text-[var(--color-muted)] ${
                  col.sortable === true ? "cursor-pointer select-none hover:text-[var(--color-foreground)]" : ""
                }`}
                onClick={col.sortable === true ? () => { handleSort(col.key); } : undefined}
              >
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  {col.sortable === true && sort !== null && sort.key === col.key && (
                    sort.direction === "asc"
                      ? <ArrowUp className="h-3 w-3" />
                      : <ArrowDown className="h-3 w-3" />
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {processedRows.map((row, idx) => (
            <tr
              key={idx}
              className={`border-b border-[var(--color-border)] last:border-b-0 ${
                onRowClick !== undefined
                  ? "cursor-pointer hover:bg-[var(--color-border)]/20"
                  : ""
              }`}
              onClick={onRowClick !== undefined ? () => { onRowClick(row); } : undefined}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className="px-3 py-2 text-[var(--color-foreground)]"
                >
                  {row[col.key] !== null && row[col.key] !== undefined
                    ? String(row[col.key])
                    : ""}
                </td>
              ))}
            </tr>
          ))}
          {processedRows.length === 0 && (
            <tr>
              <td
                colSpan={columns.length}
                className="px-3 py-8 text-center text-[var(--color-muted)]"
              >
                No results
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
