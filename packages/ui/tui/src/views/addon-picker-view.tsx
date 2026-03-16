/**
 * Add-on picker view — optional add-on selection during welcome flow.
 *
 * Shows available add-ons (telegram, slack, discord, temporal, mcp, browser, voice)
 * with checkboxes for selection. Used after preset selection in the welcome flow.
 */

import { useMemo } from "react";
import { COLORS } from "../theme.js";

/** An add-on that can be enabled for a preset. */
export interface AddonOption {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly category: "channel" | "integration" | "capability";
}

/** Built-in add-ons available for all presets. */
export const AVAILABLE_ADDONS: readonly AddonOption[] = [
  { id: "telegram", name: "Telegram", description: "Telegram bot channel", category: "channel" },
  { id: "slack", name: "Slack", description: "Slack workspace integration", category: "channel" },
  { id: "discord", name: "Discord", description: "Discord bot channel", category: "channel" },
  { id: "temporal", name: "Temporal", description: "Durable workflow orchestration", category: "integration" },
  { id: "mcp", name: "MCP", description: "Model Context Protocol server bridge", category: "integration" },
  { id: "browser", name: "Browser", description: "Headless browser automation", category: "capability" },
  { id: "voice", name: "Voice", description: "Voice input/output via WebRTC", category: "capability" },
] as const;

export interface AddonPickerViewProps {
  readonly addons: readonly AddonOption[];
  readonly selected: ReadonlySet<string>;
  readonly focusedIndex: number;
  readonly onToggle: (addonId: string) => void;
  readonly onConfirm: (selectedIds: readonly string[]) => void;
  readonly onSkip: () => void;
  readonly focused: boolean;
}

/** Group addons by category for display. */
function groupByCategory(
  addons: readonly AddonOption[],
): ReadonlyMap<string, readonly AddonOption[]> {
  const groups = new Map<string, AddonOption[]>();
  for (const addon of addons) {
    const existing = groups.get(addon.category);
    if (existing !== undefined) {
      existing.push(addon);
    } else {
      groups.set(addon.category, [addon]);
    }
  }
  return groups;
}

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  channel: "Channels",
  integration: "Integrations",
  capability: "Capabilities",
} as const;

export function AddonPickerView(props: AddonPickerViewProps): React.ReactNode {
  const { addons, selected, focusedIndex, focused } = props;
  const groups = useMemo(() => groupByCategory(addons), [addons]);

  let flatIndex = 0;

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingTop={1}>
      <text fg={COLORS.cyan}><b>{"  Add-ons (optional)"}</b></text>
      <text fg={COLORS.dim}>
        {"  Select additional capabilities to enable. These can be changed later."}
      </text>

      <box marginTop={1} flexDirection="column" paddingLeft={2}>
        {[...groups.entries()].map(([category, categoryAddons]) => (
          <box key={category} flexDirection="column" marginTop={1}>
            <text fg={COLORS.dim}><b>{`  ${CATEGORY_LABELS[category] ?? category}`}</b></text>
            {categoryAddons.map((addon) => {
              const currentIndex = flatIndex++;
              const isFocused = currentIndex === focusedIndex;
              const isSelected = selected.has(addon.id);
              const checkbox = isSelected ? "[x]" : "[ ]";
              return (
                <box key={addon.id} height={1} flexDirection="row">
                  <text fg={isFocused ? COLORS.cyan : COLORS.dim}>
                    {isFocused ? " > " : "   "}
                  </text>
                  <text fg={isSelected ? COLORS.green : COLORS.dim}>{`${checkbox} `}</text>
                  <text fg={isFocused ? COLORS.white : COLORS.dim}>
                    {addon.name.padEnd(12)}
                  </text>
                  <text fg={COLORS.dim}>{addon.description}</text>
                </box>
              );
            })}
          </box>
        ))}
      </box>

      <box marginTop={2} paddingLeft={2}>
        <text fg={COLORS.dim}>
          {"  j/k:navigate  Space:toggle  Enter:confirm  s:skip"}
        </text>
      </box>
    </box>
  );
}
