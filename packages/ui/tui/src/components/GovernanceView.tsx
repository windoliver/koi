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
import type { GovernanceSlice } from "../state/types.js";
import { COLORS } from "../theme.js";

const COL_NAME = 22;
const COL_VALUE = 18;
const COL_UTIL = 8;
const MAX_RECENT_ALERTS = 10;

export interface GovernanceViewProps {
  readonly slice: GovernanceSlice;
}

export const GovernanceView: Component<GovernanceViewProps> = (props) => {
  const empty = (): boolean =>
    props.slice.snapshot === null &&
    props.slice.alerts.length === 0 &&
    props.slice.rules.length === 0 &&
    props.slice.capabilities.length === 0;

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

const RuleRow: Component<{ readonly rule: RuleDescriptor }> = (p) => (
  <box flexDirection="row" gap={1}>
    <text fg={effectColor(p.rule.effect)}>{`[${p.rule.effect}]`}</text>
    <text>{p.rule.id}</text>
    <text fg={COLORS.textMuted}>{`\u2014 ${p.rule.description}`}</text>
  </box>
);

function pad(s: string, w: number): string {
  if (s.length >= w) return `${s.slice(0, Math.max(0, w - 1))} `;
  return s + " ".repeat(w - s.length);
}

function formatNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  if (n >= 100) return String(Math.round(n));
  return n.toFixed(2);
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
