/**
 * Welcome view — TUI-first startup screen when no koi.yaml manifest exists.
 *
 * Displays a branded header, quick-start preset selector, concept glossary,
 * and keyboard hint bar. Rendered before any admin API connection.
 */

import type { SelectOption } from "@opentui/core";
import { useMemo } from "react";
import type { PresetInfo } from "../state/types.js";
import { COLORS } from "../theme.js";

export interface WelcomeViewProps {
  readonly presets: readonly PresetInfo[];
  readonly selectedIndex: number;
  readonly onSelect: (presetId: string) => void;
  readonly onDetails: (presetId: string) => void;
  readonly focused: boolean;
}

/** Map presets to SelectOption array for the <select> component. */
function presetsToOptions(presets: readonly PresetInfo[]): readonly SelectOption[] {
  return presets.map((p) => ({
    name: p.id,
    description: p.demoPack !== undefined
      ? `${p.description} (demo: ${p.demoPack})`
      : p.description,
    value: p.id,
  }));
}

/** Concept glossary entries shown below the preset selector. */
const GLOSSARY = [
  { term: "Manifest", definition: "Declarative YAML that defines an agent (koi.yaml)" },
  { term: "Channel", definition: "I/O interface to users — terminal, Slack, HTTP, etc." },
  { term: "Middleware", definition: "Interception layer for model and tool calls" },
  { term: "Engine", definition: "Swappable agent loop that drives inference" },
  { term: "Forge", definition: "Self-improvement subsystem that evolves agent tools" },
  { term: "Nexus", definition: "Data service layer for sources, permissions, and schemas" },
] as const;

export function WelcomeView(props: WelcomeViewProps): React.ReactNode {
  const { presets, focused, onSelect } = props;
  const options = useMemo(() => presetsToOptions(presets), [presets]);

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={1}>
      {/* Header */}
      <box height={1}>
        <text fg={COLORS.cyan}>
          <b>{" Welcome to Koi"}</b>
        </text>
      </box>

      <box marginTop={1}>
        <text fg={COLORS.white}>
          {"Koi is a self-extending agent engine. Pick a preset to scaffold your first manifest."}
        </text>
      </box>

      {/* Quick Start — preset selector */}
      <box flexDirection="column" marginTop={1}>
        <text fg={COLORS.cyan}>
          <b>{"Quick Start"}</b>
        </text>
        {presets.length > 0 ? (
          <select
            options={options as SelectOption[]}
            focused={focused}
            showDescription={true}
            wrapSelection={true}
            flexGrow={1}
            selectedBackgroundColor={COLORS.blue}
            selectedTextColor={COLORS.white}
            descriptionColor={COLORS.dim}
            onSelect={(_index: number, option: SelectOption | null) => {
              if (option?.value !== undefined) {
                onSelect(option.value as string);
              }
            }}
          />
        ) : (
          <text fg={COLORS.dim}>{"  No presets available."}</text>
        )}
      </box>

      {/* Concept glossary */}
      <box flexDirection="column" marginTop={1}>
        <text fg={COLORS.cyan}>
          <b>{"What is this?"}</b>
        </text>
        {GLOSSARY.map((entry) => (
          <text key={entry.term} fg={COLORS.dim}>
            {`  ${entry.term}: ${entry.definition}`}
          </text>
        ))}
      </box>

      {/* Hint bar */}
      <box height={1} marginTop={1}>
        <text fg={COLORS.dim}>{"j/k:navigate  Enter:select  ?:details  q:quit"}</text>
      </box>
    </box>
  );
}
