/**
 * EventLogViewer — renders JSONL event logs with timeline and filtering.
 *
 * Uses @tanstack/react-virtual for efficient rendering of large log files.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { useMemo, useRef, useState } from "react";
import { Filter } from "lucide-react";

interface EventEntry {
  readonly kind?: string;
  readonly subKind?: string;
  readonly timestamp?: number;
  readonly [key: string]: unknown;
}

function parseEventLog(content: string): readonly EventEntry[] {
  return content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as EventEntry;
      } catch {
        return { kind: "parse_error", raw: line } as EventEntry;
      }
    });
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

/** Fixed row height for event log entries. */
const ROW_HEIGHT = 36;

export function EventLogViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  const events = useMemo(() => parseEventLog(content), [content]);
  const [kindFilter, setKindFilter] = useState<string | null>(null);

  const kinds = useMemo(
    () => [...new Set(events.map((e) => e.kind).filter((k): k is string => k !== undefined))],
    [events],
  );

  const filtered = useMemo(
    () =>
      kindFilter !== null
        ? events.filter((e) => e.kind === kindFilter)
        : events,
    [events, kindFilter],
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2">
        <span className="text-sm font-medium">{path.split("/").pop()}</span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[var(--color-muted)]">{events.length} events</span>
          {kinds.length > 1 && (
            <div className="flex items-center gap-1">
              <Filter className="h-3.5 w-3.5 text-[var(--color-muted)]" />
              <select
                value={kindFilter ?? ""}
                onChange={(e) => setKindFilter(e.target.value || null)}
                className="rounded border border-[var(--color-border)] bg-transparent px-1.5 py-0.5 text-xs"
              >
                <option value="">All kinds</option>
                {kinds.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>
      {filtered.length > 0 ? (
        <VirtualizedEventLog events={filtered} />
      ) : (
        <div className="px-4 py-8 text-center text-sm text-[var(--color-muted)]">
          No events{kindFilter !== null ? ` matching "${kindFilter}"` : ""}
        </div>
      )}
    </div>
  );
}

function VirtualizedEventLog({
  events,
}: {
  readonly events: readonly EventEntry[];
}): React.ReactElement {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 15,
  });

  return (
    <div ref={parentRef} className="flex-1 overflow-auto">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const event = events[virtualRow.index];
          if (event === undefined) return null;

          return (
            <div
              key={virtualRow.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <div className="flex h-full gap-3 border-b border-[var(--color-border)]/50 px-4 py-2 font-mono text-xs hover:bg-[var(--color-muted)]/5">
                <span className="shrink-0 text-[var(--color-muted)]">
                  {event.timestamp !== undefined
                    ? formatTimestamp(event.timestamp)
                    : `#${virtualRow.index}`}
                </span>
                {event.kind !== undefined && (
                  <span className="shrink-0 rounded bg-[var(--color-primary)]/10 px-1.5 py-0.5 text-[var(--color-primary)]">
                    {event.kind}
                    {event.subKind !== undefined && `.${event.subKind}`}
                  </span>
                )}
                <span className="truncate text-[var(--color-muted)]">
                  {JSON.stringify(event)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
