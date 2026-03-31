/**
 * Debug view — two-panel display showing package inventory and per-turn
 * timing trace waterfall. Toggled via /debug command.
 *
 * Features: resolver traces, channel I/O traces, forge refresh traces,
 * lifecycle badges, visibility tier filtering, cross-panel highlighting.
 */

import React from "react";
import { PanelChrome } from "../components/panel-chrome.js";
import type { DebugViewState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";
import type {
  ContributionGraphResponse,
  DebugInventoryItemResponse,
  DebugSpanResponse,
  DebugTurnTraceResponse,
  PackageContributionResponse,
  StackContributionResponse,
} from "@koi/dashboard-types";

export interface DebugViewProps {
  readonly debugView: DebugViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

// ─── Hook abbreviations ──────────────────────────────────────────────

const HOOK_ABBREV: Readonly<Record<string, string>> = {
  wrapModelCall: "mc",
  wrapToolCall: "tc",
  wrapModelStream: "ms",
  onBeforeTurn: "bt",
  onAfterTurn: "at",
  onSessionStart: "ss",
  onSessionEnd: "se",
};

function abbreviateHook(hook: string): string {
  return HOOK_ABBREV[hook] ?? hook.slice(0, 2);
}

// ─── Formatting helpers ──────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}\u00B5s`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function categoryColor(category: string): string {
  switch (category) {
    case "middleware":
      return COLORS.cyan;
    case "subsystem":
      return COLORS.cyan;
    case "tool":
      return COLORS.green;
    case "skill":
      return COLORS.yellow;
    case "channel":
      return COLORS.blue;
    case "engine":
      return COLORS.magenta;
    default:
      return COLORS.dim;
  }
}

function sourceLabel(source: string): string {
  switch (source) {
    case "static":
      return "static";
    case "forged":
      return "forged \u2726";
    case "dynamic":
      return "dynamic";
    case "operator":
      return "operator";
    case "manifest":
      return "manifest";
    default:
      return source;
  }
}

/** Lifecycle badge: active this turn vs. idle. */
function lifecycleBadge(
  item: DebugInventoryItemResponse,
  currentTurn: number,
): string {
  if (item.lastUsedTurn !== undefined && item.lastUsedTurn >= currentTurn - 1) {
    return "\u25C6"; // filled diamond — active
  }
  return "\u25CF"; // filled circle — idle
}

// ─── Inventory Panel ─────────────────────────────────────────────────

const InventoryPanel = React.memo(function InventoryPanel(props: {
  readonly items: readonly DebugInventoryItemResponse[];
  readonly selectedTurnIndex: number;
  readonly highlightedMiddleware: string | null;
}): React.ReactNode {
  const { items, selectedTurnIndex, highlightedMiddleware } = props;

  // Group by category
  const groups = new Map<string, readonly DebugInventoryItemResponse[]>();
  for (const item of items) {
    const prev = groups.get(item.category) ?? [];
    groups.set(item.category, [...prev, item]);
  }

  const categoryOrder = ["middleware", "tool", "skill", "channel", "engine", "subsystem"];

  return (
    <box flexDirection="column">
      {categoryOrder.map((cat) => {
        const catItems = groups.get(cat);
        if (catItems === undefined || catItems.length === 0) return null;
        return (
          <box key={cat} flexDirection="column" marginBottom={1}>
            <text fg={categoryColor(cat)}>
              <b>{`  ${cat.toUpperCase()} (${String(catItems.length)})`}</b>
            </text>
            {catItems.map((item) => {
              const isHighlighted = highlightedMiddleware === item.name;
              const fg = isHighlighted ? COLORS.accent : COLORS.white;
              const badge = lifecycleBadge(item, selectedTurnIndex);
              return (
                <text key={item.name} fg={fg}>
                  {`  ${badge} ${item.name.padEnd(24)} ${(item.phase ?? "").padEnd(10)} ${String(item.priority ?? "").padEnd(5)} ${sourceLabel(item.source).padEnd(12)} ${(item.hooks ?? []).map(abbreviateHook).join(" ")}`}
                </text>
              );
            })}
          </box>
        );
      })}
    </box>
  );
});

// ─── Waterfall Panel ─────────────────────────────────────────────────

function WaterfallSpan(props: {
  readonly span: DebugSpanResponse;
  readonly maxDuration: number;
  readonly indent: number;
}): React.ReactNode {
  const { span, maxDuration, indent } = props;
  const barWidth =
    maxDuration > 0 ? Math.max(1, Math.round((span.durationMs / maxDuration) * 30)) : 1;
  const bar = "\u2588".repeat(barWidth);
  const prefix = indent > 0 ? "  ".repeat(indent - 1) + "\u251C\u2500 " : "";
  const errorSuffix = span.error !== undefined ? ` [err: ${span.error}]` : "";
  const fg =
    span.error !== undefined ? COLORS.red : span.nextCalled ? COLORS.green : COLORS.dim;
  const padLen = Math.max(1, 22 - indent * 2);

  return (
    <box flexDirection="column">
      <text fg={fg}>
        {`  ${prefix}${span.name.padEnd(padLen)} ${bar} ${formatDuration(span.durationMs)}${errorSuffix}`}
      </text>
      {span.children?.map((child, i) => (
        <WaterfallSpan
          key={`${child.name}-${child.hook}-${String(i)}`}
          span={child}
          maxDuration={maxDuration}
          indent={indent + 1}
        />
      ))}
    </box>
  );
}

function WaterfallPanel(props: {
  readonly trace: DebugTurnTraceResponse;
  readonly visibilityTier: string;
}): React.ReactNode {
  const { trace, visibilityTier } = props;

  // Filter spans by visibility tier
  const visibleSpans = trace.spans.filter((s) => {
    if (visibilityTier === "all") return true;
    if (visibilityTier === "secondary") return s.tier !== "all";
    // "critical": show critical + untagged spans
    return s.tier === "critical" || s.tier === undefined;
  });

  const maxDuration = visibleSpans.reduce((max, s) => Math.max(max, s.durationMs), 1);

  return (
    <box flexDirection="column">
      <text fg={COLORS.cyan}>
        <b>{`  Turn #${String(trace.turnIndex)} \u2014 ${formatDuration(trace.totalDurationMs)} total`}</b>
      </text>
      <text fg={COLORS.dim}>{""}</text>
      {visibleSpans.map((span, i) => (
        <WaterfallSpan
          key={`${span.name}-${span.hook}-${String(i)}`}
          span={span}
          maxDuration={maxDuration}
          indent={0}
        />
      ))}
      {/* Resolver spans */}
      {trace.resolverSpans !== undefined && trace.resolverSpans.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <text fg={COLORS.blue}>{"  RESOLVER"}</text>
          {trace.resolverSpans.map((r, i) => (
            <text key={`resolve-${String(i)}`} fg={r.source === "miss" ? COLORS.red : COLORS.green}>
              {`  ${r.source === "miss" ? "\u2717" : "\u2713"} ${r.toolId.padEnd(24)} ${r.source.padEnd(10)} ${formatDuration(r.durationMs)}`}
            </text>
          ))}
        </box>
      )}
      {/* Channel I/O spans */}
      {trace.channelSpans !== undefined && trace.channelSpans.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <text fg={COLORS.blue}>{"  CHANNEL I/O"}</text>
          {trace.channelSpans.map((c, i) => (
            <text key={`channel-${String(i)}`} fg={COLORS.cyan}>
              {`  ${c.direction === "out" ? "\u2192" : "\u2190"} ${c.kind.padEnd(16)} ${formatDuration(c.durationMs)}`}
            </text>
          ))}
        </box>
      )}
      {/* Forge refresh */}
      {trace.forgeSpans !== undefined && trace.forgeSpans.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <text fg={COLORS.magenta}>{"  FORGE REFRESH"}</text>
          {trace.forgeSpans.map((f, i) => (
            <text key={`forge-${String(i)}`} fg={COLORS.dim}>
              {`  descriptors: ${String(f.descriptorCount)}${f.descriptorsChanged ? " (changed)" : ""} | middleware: ${f.middlewareRecomposed ? "recomposed" : "unchanged"}`}
            </text>
          ))}
        </box>
      )}
    </box>
  );
}

// ─── Contribution Tree Panel ────────────────────────────────────────

function PackageItem(props: {
  readonly pkg: PackageContributionResponse;
  readonly highlightedMiddleware?: string | null | undefined;
}): React.ReactNode {
  const { pkg, highlightedMiddleware } = props;
  const kindBadge = pkg.kind.slice(0, 4).toUpperCase();
  const names: readonly string[] = [
    ...(pkg.middlewareNames ?? []),
    ...(pkg.providerNames ?? []),
    ...(pkg.toolNames ?? []),
    ...(pkg.channelNames ?? []),
  ];
  const nameStr = names.length > 0 ? names.join(", ") : "";
  const notesStr = pkg.notes !== undefined && pkg.notes.length > 0
    ? ` (${pkg.notes.join(", ")})`
    : "";
  // Highlight if any middleware name matches the cross-panel selection
  const isHighlighted = highlightedMiddleware !== null
    && highlightedMiddleware !== undefined
    && names.includes(highlightedMiddleware);
  const fg = isHighlighted ? COLORS.accent : categoryColor(pkg.kind);

  return (
    <text fg={fg}>
      {`      [${kindBadge}] ${pkg.id} ${nameStr}${notesStr}`}
    </text>
  );
}

/** Status badge and color for a contribution stack. */
function statusBadge(stack: StackContributionResponse): {
  readonly mark: string;
  readonly fg: string;
} {
  const status = stack.status ?? (stack.enabled ? "active" : "skipped");
  switch (status) {
    case "active":
      return { mark: "\u25C6", fg: COLORS.green };
    case "degraded":
      return { mark: "\u25D0", fg: COLORS.yellow };
    case "skipped":
      return { mark: "\u25CB", fg: COLORS.dim };
    case "failed":
      return { mark: "\u2717", fg: COLORS.red };
    default:
      return { mark: "\u25CB", fg: COLORS.dim };
  }
}

function StackSection(props: {
  readonly stack: StackContributionResponse;
  readonly highlightedMiddleware?: string | null | undefined;
}): React.ReactNode {
  const { stack, highlightedMiddleware } = props;
  const { mark, fg } = statusBadge(stack);
  const reasonSuffix =
    stack.reason !== undefined ? ` \u2014 ${stack.reason}` : "";

  return (
    <box flexDirection="column" marginBottom={1}>
      <text fg={fg}>
        <b>{`  ${mark} ${stack.label} (${stack.source})${reasonSuffix}`}</b>
      </text>
      {stack.packages.map((pkg, i) => (
        <PackageItem key={`${pkg.id}-${String(i)}`} pkg={pkg} highlightedMiddleware={highlightedMiddleware} />
      ))}
    </box>
  );
}

const ContributionTreePanel = React.memo(function ContributionTreePanel(props: {
  readonly contributions: ContributionGraphResponse;
  readonly highlightedMiddleware?: string | null | undefined;
}): React.ReactNode {
  const { contributions, highlightedMiddleware } = props;

  return (
    <box flexDirection="column">
      <text fg={COLORS.cyan}>
        <b>{`  CONTRIBUTION GRAPH (${String(contributions.stacks.length)} stacks)`}</b>
      </text>
      <text fg={COLORS.dim}>{""}</text>
      {contributions.stacks.map((stack) => (
        <StackSection key={stack.id} stack={stack} highlightedMiddleware={highlightedMiddleware} />
      ))}
    </box>
  );
});

// ─── Keyboard hint bar ───────────────────────────────────────────────

function DebugHintBar(): React.ReactNode {
  return (
    <text fg={COLORS.dim}>
      {"\n  [1] Inventory  [2] Waterfall  [n/p] Turn  [j/k] Scroll  [Tab] Tier"}
    </text>
  );
}

// ─── Main Debug View ─────────────────────────────────────────────────

export function DebugView(props: DebugViewProps): React.ReactNode {
  const {
    inventory,
    contributions,
    trace,
    loading,
    activePanel,
    selectedTurnIndex,
    visibilityTier,
    highlightedMiddleware,
  } = props.debugView;

  if (activePanel === "inventory") {
    return (
      <PanelChrome
        title="Debug \u2014 Inventory"
        count={inventory?.length ?? 0}
        focused={props.focused}
        zoomLevel={props.zoomLevel}
        loading={loading}
        isEmpty={inventory === null && contributions === null && !loading}
        emptyMessage="No debug data available."
        emptyHint="Enable debug mode and select an agent."
      >
        {contributions !== null && (
          <ContributionTreePanel contributions={contributions} highlightedMiddleware={highlightedMiddleware} />
        )}
        {inventory !== null && contributions === null && (
          <InventoryPanel
            items={inventory}
            selectedTurnIndex={selectedTurnIndex}
            highlightedMiddleware={highlightedMiddleware}
          />
        )}
        <DebugHintBar />
      </PanelChrome>
    );
  }

  return (
    <PanelChrome
      title={`Debug \u2014 Turn #${String(selectedTurnIndex)} Waterfall [${visibilityTier}]`}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      loading={loading}
      isEmpty={trace === null && !loading}
      emptyMessage={`No trace for turn #${String(selectedTurnIndex)}.`}
      emptyHint="Run a query to generate trace data, or press [n/p] to navigate turns."
    >
      {trace !== null && (
        <WaterfallPanel trace={trace} visibilityTier={visibilityTier} />
      )}
      <DebugHintBar />
    </PanelChrome>
  );
}
