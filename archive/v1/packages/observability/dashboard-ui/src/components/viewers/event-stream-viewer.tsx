/**
 * EventStreamViewer — renders event stream metadata files.
 *
 * Shows stream info (name, created, event count) at top, then a virtualized
 * expandable event list below. Uses @tanstack/react-virtual for efficient
 * rendering of large event streams.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useRef, useState } from "react";
import { Radio, ChevronDown, ChevronRight } from "lucide-react";

interface EventStreamData {
  readonly name?: string;
  readonly streamId?: string;
  readonly createdAt?: number;
  readonly eventCount?: number;
  readonly events?: readonly EventStreamEntry[];
  readonly [key: string]: unknown;
}

interface EventStreamEntry {
  readonly kind?: string;
  readonly subKind?: string;
  readonly timestamp?: number;
  readonly [key: string]: unknown;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

/** Collapsed row height in pixels. */
const COLLAPSED_ROW_HEIGHT = 36;

export function EventStreamViewer({
  content,
  path,
}: {
  readonly content: string;
  readonly path: string;
}): React.ReactElement {
  let data: EventStreamData;
  try {
    data = JSON.parse(content) as EventStreamData;
  } catch {
    return (
      <div className="p-4 text-sm text-red-500">
        Failed to parse event stream: {path}
      </div>
    );
  }

  const eventCount = data.eventCount ?? data.events?.length ?? 0;
  const events = data.events ?? [];

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 border-b border-[var(--color-border)] px-4 py-2">
        <Radio className="h-4 w-4 text-[var(--color-muted)]" />
        <span className="text-sm font-medium">
          {data.name ?? data.streamId ?? path.split("/").pop()}
        </span>
        <span className="text-xs text-[var(--color-muted)]">{eventCount} events</span>
      </div>
      {/* Stream info */}
      <div className="border-b border-[var(--color-border)] px-4 py-3">
        <div className="flex flex-wrap gap-4 text-xs text-[var(--color-muted)]">
          {data.streamId !== undefined && <span>Stream: {data.streamId}</span>}
          {data.createdAt !== undefined && (
            <span>Created: {formatTimestamp(data.createdAt)}</span>
          )}
          <span>Events: {eventCount}</span>
        </div>
      </div>

      {/* Virtualized event list */}
      {events.length > 0 ? (
        <VirtualizedEventList events={events} />
      ) : (
        <div className="px-4 py-8 text-center text-sm text-[var(--color-muted)]">
          No events in stream
        </div>
      )}
    </div>
  );
}

function VirtualizedEventList({
  events,
}: {
  readonly events: readonly EventStreamEntry[];
}): React.ReactElement {
  const parentRef = useRef<HTMLDivElement>(null);
  const [expandedSet, setExpandedSet] = useState<ReadonlySet<number>>(
    () => new Set<number>(),
  );

  const toggleExpanded = useCallback((index: number): void => {
    setExpandedSet((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) =>
      expandedSet.has(index) ? 200 : COLLAPSED_ROW_HEIGHT,
    overscan: 5,
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
          const isExpanded = expandedSet.has(virtualRow.index);

          return (
            <div
              key={virtualRow.index}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <ExpandableEventRow
                event={event}
                index={virtualRow.index}
                isExpanded={isExpanded}
                onToggle={toggleExpanded}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ExpandableEventRow({
  event,
  index,
  isExpanded,
  onToggle,
}: {
  readonly event: EventStreamEntry;
  readonly index: number;
  readonly isExpanded: boolean;
  readonly onToggle: (index: number) => void;
}): React.ReactElement {
  return (
    <div className="border-b border-[var(--color-border)]/50">
      <button
        type="button"
        onClick={() => onToggle(index)}
        className="flex w-full items-center gap-3 px-4 py-2 text-left font-mono text-xs hover:bg-[var(--color-muted)]/5"
      >
        {isExpanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-[var(--color-muted)]" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-[var(--color-muted)]" />
        )}
        <span className="shrink-0 text-[var(--color-muted)]">
          {event.timestamp !== undefined ? formatTime(event.timestamp) : `#${index}`}
        </span>
        {event.kind !== undefined && (
          <span className="shrink-0 rounded bg-[var(--color-primary)]/10 px-1.5 py-0.5 text-[var(--color-primary)]">
            {event.kind}
            {event.subKind !== undefined && `.${event.subKind}`}
          </span>
        )}
      </button>
      {isExpanded && (
        <pre className="mx-4 mb-3 overflow-auto rounded bg-[var(--color-muted)]/5 p-3 font-mono text-xs">
          {JSON.stringify(event, null, 2)}
        </pre>
      )}
    </div>
  );
}
