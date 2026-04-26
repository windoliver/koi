/**
 * GovernanceView — full-screen `/governance` view (gov-9).
 *
 * Read-only display of the GovernanceSlice. Four sections:
 *   - Sensors        — table of variable / current / limit / utilization%
 *   - Recent alerts  — last 10 from the bridge-driven alerts ring
 *   - Active rules   — from backend.describeRules?(); section omitted if empty
 *   - Middleware capabilities — from mw.describeCapabilities(ctx)
 *
 * No interaction beyond Esc (handled by TuiRoot's global key handler).
 */

import { For, Show, type Component } from "solid-js";
import type { SensorReading } from "@koi/core/governance";
import type { RuleDescriptor } from "@koi/core/governance-backend";
import type { RiskLevel } from "@koi/core/security-analyzer";
import type { GovernanceSlice, SecurityFinding } from "../state/types.js";
import { COLORS } from "../theme.js";

const COL_NAME = 22;
const COL_VALUE = 18;
const COL_UTIL = 8;
const MAX_RECENT_ALERTS = 10;
const MAX_SECURITY_FINDINGS = 10;

export interface GovernanceViewProps {
  readonly slice: GovernanceSlice;
}

export const GovernanceView: Component<GovernanceViewProps> = (props) => {
  const empty = (): boolean =>
    props.slice.snapshot === null &&
    props.slice.alerts.length === 0 &&
    props.slice.violations.length === 0 &&
    props.slice.rules.length === 0 &&
    props.slice.capabilities.length === 0 &&
    props.slice.securityFindings.length === 0;

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={2} paddingRight={2} paddingTop={1}>
      <text fg={COLORS.accent}>{"Governance"}</text>

      <Show when={empty()}>
        <text fg={COLORS.textMuted}>{"No governance data — controller not attached."}</text>
      </Show>

      <Show when={props.slice.snapshot !== null}>
        <SectionHeader title="Sensors" />
        <SensorTable readings={props.slice.snapshot?.readings ?? []} />
      </Show>

      <Show when={props.slice.alerts.length > 0}>
        <SectionHeader title="Recent alerts" />
        <For each={props.slice.alerts.slice(0, MAX_RECENT_ALERTS)}>
          {(alert) => (
            <text fg={COLORS.amber}>
              {`\u26A0 ${alert.variable} crossed ${Math.round(alert.threshold * 100)}% — ` +
                `${alert.current.toFixed(2)} / ${alert.limit.toFixed(2)}`}
            </text>
          )}
        </For>
      </Show>

      <Show when={props.slice.securityFindings.length > 0}>
        <SectionHeader title="Security findings" />
        <For each={props.slice.securityFindings.slice(0, MAX_SECURITY_FINDINGS)}>
          {(finding) => <SecurityFindingRow finding={finding} />}
        </For>
      </Show>

      <Show when={props.slice.rules.length > 0}>
        <SectionHeader title="Active rules" />
        <For each={props.slice.rules}>{(rule) => <RuleRow rule={rule} />}</For>
      </Show>

      <Show when={props.slice.capabilities.length > 0}>
        <SectionHeader title="Middleware capabilities" />
        <For each={props.slice.capabilities}>
          {(cap) => (
            <box flexDirection="row" gap={1}>
              <text fg={COLORS.cyan}>{cap.label}</text>
              <text fg={COLORS.textMuted}>{`\u2014 ${cap.description}`}</text>
            </box>
          )}
        </For>
      </Show>

      <text fg={COLORS.textMuted}>{"Esc to close \u00B7 /governance reset to clear alerts"}</text>
    </box>
  );
};

const SectionHeader: Component<{ readonly title: string }> = (p) => (
  <box marginTop={1}>
    <text fg={COLORS.accent}>{p.title}</text>
  </box>
);

const SensorTable: Component<{ readonly readings: readonly SensorReading[] }> = (p) => (
  <box flexDirection="column">
    <text fg={COLORS.textMuted}>
      {pad("Variable", COL_NAME) + pad("Current", COL_VALUE) + pad("Util%", COL_UTIL)}
    </text>
    <For each={p.readings}>
      {(r) => (
        <text>
          {pad(r.name, COL_NAME) +
            pad(`${formatNum(r.current)} / ${formatNum(r.limit)}`, COL_VALUE) +
            pad(`${Math.round(r.utilization * 100)}%`, COL_UTIL)}
        </text>
      )}
    </For>
  </box>
);

/**
 * Render a single rule as `[effect] id — description`. The `pattern` field
 * on RuleDescriptor is deliberately not rendered here — backends like the
 * pattern-backend produce verbose selector strings (e.g.,
 * "tool_call:toolId=Bash") that take significant column width and provide
 * little value beyond what the rule id already conveys. Add it back when
 * a backend ships pattern strings the user genuinely needs to read.
 */
const RuleRow: Component<{ readonly rule: RuleDescriptor }> = (p) => (
  <box flexDirection="row" gap={1}>
    <text fg={effectColor(p.rule.effect)}>{`[${p.rule.effect}]`}</text>
    <text>{p.rule.id}</text>
    <text fg={COLORS.textMuted}>{`\u2014 ${p.rule.description}`}</text>
  </box>
);

const SecurityFindingRow: Component<{ readonly finding: SecurityFinding }> = (p) => (
  <box flexDirection="row" gap={1}>
    <text fg={riskLevelColor(p.finding.riskLevel)}>{`[${p.finding.riskLevel}]`}</text>
    <text>{p.finding.toolName}</text>
    <text fg={COLORS.textMuted}>{`— ${p.finding.description}`}</text>
    <text fg={COLORS.textMuted}>{`[${p.finding.score}]`}</text>
  </box>
);

function pad(s: string, w: number): string {
  if (s.length >= w) return `${s.slice(0, Math.max(0, w - 1))} `;
  return s + " ".repeat(w - s.length);
}

function formatNum(n: number): string {
  // Order matters: round before integer-check so 99.999 doesn't render
  // as "100.00" while 100.0 renders as "100" (visual jump at the boundary).
  if (n >= 100) return String(Math.round(n));
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

function riskLevelColor(level: RiskLevel): string {
  switch (level) {
    case "critical":
      return COLORS.danger;
    case "high":
      return COLORS.amber;
    case "medium":
      return COLORS.cyan;
    case "low":
      return COLORS.success;
    default:
      return COLORS.textMuted;
  }
}

function effectColor(effect: RuleDescriptor["effect"]): string {
  switch (effect) {
    case "deny":
      return COLORS.danger;
    case "allow":
      return COLORS.success;
    case "advise":
      return COLORS.amber;
  }
}
