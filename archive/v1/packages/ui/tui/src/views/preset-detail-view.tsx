/**
 * Preset detail view — expanded info for a single preset.
 *
 * Shown when the user presses `?` on a preset in the welcome screen.
 * Displays nexus mode, demo pack, agent roles, active middleware stacks,
 * sample prompts, and keyboard hints.
 */

import type { PresetInfo } from "../state/types.js";
import { COLORS } from "../theme.js";

export interface PresetDetailViewProps {
  readonly preset: PresetInfo;
  readonly onBack: () => void;
  readonly onSelect: (presetId: string) => void;
  readonly focused: boolean;
}

/** Collect active stack names from the stacks record. */
function activeStacks(stacks: Readonly<Record<string, boolean | undefined>>): readonly string[] {
  return Object.entries(stacks)
    .filter(([, enabled]) => enabled === true)
    .map(([name]) => name);
}

export function PresetDetailView(props: PresetDetailViewProps): React.ReactNode {
  const { preset } = props;
  const stacks = activeStacks(preset.stacks);

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={1}>
      {/* Title */}
      <box height={1}>
        <text fg={COLORS.cyan}>
          <b>{` Preset: ${preset.id}`}</b>
        </text>
      </box>

      {/* Core info */}
      <box flexDirection="column" marginTop={1}>
        <text fg={COLORS.white}>{`Nexus mode:  ${preset.nexusMode}`}</text>
        {preset.demoPack !== undefined ? (
          <text fg={COLORS.white}>{`Demo pack:   ${preset.demoPack}`}</text>
        ) : null}
        <text fg={COLORS.dim}>{preset.description}</text>
      </box>

      {/* Agent roles */}
      {preset.agentRoles !== undefined && preset.agentRoles.length > 0 ? (
        <box flexDirection="column" marginTop={1}>
          <text fg={COLORS.cyan}>
            <b>{"Agent Roles"}</b>
          </text>
          {preset.agentRoles.map((r) => (
            <text key={r.role} fg={COLORS.white}>
              {`  ${r.role}: `}
              <text fg={COLORS.dim}>{r.description}</text>
            </text>
          ))}
        </box>
      ) : null}

      {/* Active middleware stacks */}
      {stacks.length > 0 ? (
        <box flexDirection="column" marginTop={1}>
          <text fg={COLORS.cyan}>
            <b>{"Middleware Stacks"}</b>
          </text>
          <box flexDirection="row">
            {stacks.map((name) => (
              <text key={name} fg={COLORS.green}>{`  [${name}]`}</text>
            ))}
          </box>
        </box>
      ) : null}

      {/* Sample prompts */}
      {preset.prompts !== undefined && preset.prompts.length > 0 ? (
        <box flexDirection="column" marginTop={1}>
          <text fg={COLORS.cyan}>
            <b>{"Sample Prompts"}</b>
          </text>
          {preset.prompts.map((prompt, i) => (
            <text key={`prompt-${String(i)}`} fg={COLORS.dim}>
              <i>{`  "${prompt}"`}</i>
            </text>
          ))}
        </box>
      ) : null}

      {/* Hint bar */}
      <box height={1} marginTop={1}>
        <text fg={COLORS.dim}>{"Enter:select  Esc:back  q:quit"}</text>
      </box>
    </box>
  );
}
