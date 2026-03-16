import { PanelChrome } from "../components/panel-chrome.js";
import type { SkillsViewState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";

export interface SkillsViewProps {
  readonly skillsView: SkillsViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

export function SkillsView(props: SkillsViewProps): React.ReactNode {
  const { events, scrollOffset, skills } = props.skillsView;
  const VISIBLE_ROWS = 20;
  const visible = events.slice(scrollOffset, scrollOffset + VISIBLE_ROWS);

  return (
    <PanelChrome
      title="Skills"
      count={events.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      isEmpty={events.length === 0 && skills.length === 0}
      emptyMessage="No skill events yet."
      emptyHint="Skills are installed/removed as agents evolve."
    >
      <box flexDirection="column">
        {skills.length > 0 && (
          <>
            <box height={1}>
              <text fg={COLORS.dim}>{" Installed Skills"}</text>
            </box>
            {skills.map((skill) => (
              <box key={skill.name} height={1}>
                <text>{`  ${skill.name.padEnd(24).slice(0, 24)} ${skill.description.slice(0, 40)}`}</text>
              </box>
            ))}
            <box height={1}>
              <text fg={COLORS.dim}>{""}</text>
            </box>
          </>
        )}
        <box height={1}>
          <text fg={COLORS.dim}>{" Event          Name                 Time"}</text>
        </box>
        {visible.map((event, i) => {
          const time = new Date(event.timestamp).toLocaleTimeString();
          return (
            <box key={`${event.name}-${String(i)}`} height={1}>
              <text>{` ${event.subKind.padEnd(14)} ${event.name.padEnd(20).slice(0, 20)} ${time}`}</text>
            </box>
          );
        })}
      </box>
    </PanelChrome>
  );
}
