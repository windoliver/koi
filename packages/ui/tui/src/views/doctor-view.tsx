/**
 * Doctor view — diagnostic check results with pass/fail/warn indicators.
 */

import type { DoctorCheck } from "../state/types.js";
import { COLORS } from "../theme.js";

export interface DoctorViewProps {
  readonly checks: readonly DoctorCheck[];
  readonly focused?: boolean | undefined;
}

function checkSymbol(status: DoctorCheck["status"]): string {
  switch (status) {
    case "pass": return "\u2713";
    case "fail": return "\u2715";
    case "warn": return "\u26A0";
    case "running": return "\u25CF";
  }
}

function checkColor(status: DoctorCheck["status"]): string {
  switch (status) {
    case "pass": return COLORS.green;
    case "fail": return COLORS.red;
    case "warn": return COLORS.yellow;
    case "running": return COLORS.cyan;
  }
}

/** Doctor diagnostic view. */
export function DoctorView(props: DoctorViewProps): React.ReactNode {
  const { checks } = props;
  const failCount = checks.filter((c) => c.status === "fail").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;
  const running = checks.some((c) => c.status === "running");

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={2} paddingTop={1}>
      <text fg={COLORS.cyan}><b>{"  Diagnostics"}</b></text>
      {running && <text fg={COLORS.dim}>{"  Running checks..."}</text>}

      <box marginTop={1} paddingLeft={2} flexDirection="column">
        {checks.map((check) => (
          <box key={check.id} flexDirection="column">
            <box height={1} flexDirection="row">
              <text fg={checkColor(check.status)}>
                {`  ${checkSymbol(check.status)} `}
              </text>
              <text fg={check.status === "fail" ? COLORS.red : COLORS.white}>
                {check.label}
              </text>
            </box>
            {check.detail !== undefined && (
              <text fg={COLORS.dim}>{`      ${check.detail}`}</text>
            )}
          </box>
        ))}
      </box>

      {!running && checks.length > 0 && (
        <box marginTop={1} paddingLeft={2}>
          <text fg={failCount > 0 ? COLORS.red : warnCount > 0 ? COLORS.yellow : COLORS.green}>
            {failCount > 0
              ? `  ${String(failCount)} check(s) failed`
              : warnCount > 0
                ? `  ${String(warnCount)} warning(s)`
                : "  All checks passed"}
          </text>
        </box>
      )}

      <box marginTop={1} paddingLeft={2}>
        <text fg={COLORS.dim}>{"  Esc:back"}</text>
      </box>
    </box>
  );
}
