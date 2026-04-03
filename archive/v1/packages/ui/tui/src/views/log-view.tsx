/**
 * Log view — renders structured log buffer, color-coded by level.
 *
 * l key cycles log level filter.
 */

import type { LogEntry, LogLevel } from "../state/types.js";
import { COLORS } from "../theme.js";

export interface LogViewProps {
  readonly entries: readonly LogEntry[];
  readonly logLevel: LogLevel;
  readonly focused?: boolean | undefined;
}

const LOG_LEVEL_HIERARCHY: Readonly<Record<string, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function levelColor(level: LogLevel): string {
  switch (level) {
    case "debug": return COLORS.dim;
    case "info": return COLORS.cyan;
    case "warn": return COLORS.yellow;
    case "error": return COLORS.red;
  }
}

function levelLabel(level: LogLevel): string {
  return level.toUpperCase().padEnd(5);
}

/** Log view with level filtering. */
export function LogView(props: LogViewProps): React.ReactNode {
  const { entries, logLevel } = props;
  const minLevel = LOG_LEVEL_HIERARCHY[logLevel] ?? 1;
  const filtered = entries.filter(
    (e) => (LOG_LEVEL_HIERARCHY[e.level] ?? 0) >= minLevel,
  );

  // Show last 50 entries to fit in terminal
  const visible = filtered.slice(-50);

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingTop={1}>
      <box flexDirection="row">
        <text fg={COLORS.cyan}><b>{"  Logs"}</b></text>
        <text fg={COLORS.dim}>{`  [filter: ${logLevel}+]  (${String(filtered.length)} entries)`}</text>
      </box>

      <box marginTop={1} paddingLeft={2} flexGrow={1} flexDirection="column">
        {visible.length === 0 ? (
          <text fg={COLORS.dim}>{"  No log entries matching filter."}</text>
        ) : (
          visible.map((entry, i) => (
            <box key={i} height={1} flexDirection="row">
              <text fg={levelColor(entry.level)}>
                {`  ${levelLabel(entry.level)} `}
              </text>
              <text fg={COLORS.dim}>
                {`[${entry.source}] `}
              </text>
              <text fg={COLORS.white}>
                {entry.message}
              </text>
            </box>
          ))
        )}
      </box>

      <box marginTop={1} paddingLeft={2}>
        <text fg={COLORS.dim}>{"  l:cycle level  Esc:back"}</text>
      </box>
    </box>
  );
}
