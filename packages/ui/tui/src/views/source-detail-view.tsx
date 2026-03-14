/**
 * Source detail view — shows full detail for a single data source.
 *
 * Displays descriptor fields (name, protocol, description, endpoint,
 * auth, allowedHosts, schema status) plus rich schema tables, fitness
 * metrics, provenance, and verification stages.
 */

import type {
  DashboardSchemaTable,
  DashboardVerificationStage,
  DataSourceFitnessSummary,
} from "@koi/dashboard-types";
import { COLORS } from "../theme.js";

export interface SourceDetailData {
  readonly name: string;
  readonly protocol: string;
  readonly status: string;
  readonly source: string;
  readonly description?: string | undefined;
  readonly endpoint?: string | undefined;
  readonly allowedHosts?: readonly string[] | undefined;
  readonly schemaProbed?: boolean | undefined;
  readonly auth?: { readonly kind: string } | undefined;
  readonly tables?: readonly DashboardSchemaTable[] | undefined;
  readonly fitness?: DataSourceFitnessSummary | undefined;
  readonly trailStrength?: number | undefined;
  readonly verification?: readonly DashboardVerificationStage[] | undefined;
  readonly provenance?:
    | {
        readonly builder: string;
        readonly forgedAt: number;
        readonly verificationPassed: boolean;
      }
    | undefined;
}

export interface SourceDetailViewProps {
  readonly data: SourceDetailData | null;
  readonly loading: boolean;
  readonly onApprove?: ((name: string) => void) | undefined;
  readonly onViewSchema?: ((name: string) => void) | undefined;
  readonly onBack: () => void;
  readonly focused: boolean;
}

/** Render a text-based fitness bar: e.g. "████████░░ 85%" */
function renderFitnessBar(rate: number): string {
  const filled = Math.round(rate * 10);
  const empty = 10 - filled;
  return "\u2588".repeat(filled) + "\u2591".repeat(empty) + ` ${String(Math.round(rate * 100))}%`;
}

export function SourceDetailView(props: SourceDetailViewProps): React.ReactNode {
  const { data, loading } = props;

  if (loading) {
    return (
      <box flexGrow={1} justifyContent="center" alignItems="center">
        <text fg={COLORS.dim}>{"Loading source detail..."}</text>
      </box>
    );
  }

  if (data === null) {
    return (
      <box flexGrow={1} justifyContent="center" alignItems="center">
        <text fg={COLORS.dim}>{"No source selected."}</text>
      </box>
    );
  }

  const statusColor =
    data.status === "approved" ? COLORS.green : data.status === "pending" ? COLORS.yellow : COLORS.red;

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={1}>
      <box height={1}>
        <text fg={COLORS.cyan}>
          <b>{` Source: ${data.name}`}</b>
        </text>
      </box>

      <box flexDirection="column" marginTop={1}>
        <text>{`Protocol:     ${data.protocol}`}</text>
        <text>
          {"Status:       "}
          <text fg={statusColor}>{data.status}</text>
        </text>
        <text>{`Origin:       ${data.source}`}</text>
        {data.description !== undefined ? <text>{`Description:  ${data.description}`}</text> : null}
        {data.endpoint !== undefined ? <text>{`Endpoint:     ${data.endpoint}`}</text> : null}
        {data.auth !== undefined ? <text>{`Auth:         ${data.auth.kind}`}</text> : null}
        {data.allowedHosts !== undefined && data.allowedHosts.length > 0 ? (
          <text>{`Hosts:        ${data.allowedHosts.join(", ")}`}</text>
        ) : null}
        <text>{`Schema:       ${data.schemaProbed === true || (data.tables !== undefined && data.tables.length > 0) ? "probed" : "not probed"}`}</text>
      </box>

      {/* Schema tables */}
      {data.tables !== undefined && data.tables.length > 0 ? (
        <box flexDirection="column" marginTop={1}>
          <text fg={COLORS.cyan}>
            <b>{"─── Schema ───"}</b>
          </text>
          {data.tables.map((table) => (
            <box key={`${table.schema}.${table.name}`} flexDirection="column" paddingLeft={1}>
              <text fg={COLORS.white}>
                <b>{`${table.schema}.${table.name}`}</b>
              </text>
              {table.columns.map((col) => (
                <text key={col.name} fg={COLORS.dim}>
                  {`  ${col.name} ${col.type}${col.nullable ? "" : " NOT NULL"}`}
                </text>
              ))}
              {table.foreignKeys !== undefined
                ? table.foreignKeys.map((fk) => (
                    <text key={`fk-${fk.column}`} fg={COLORS.yellow}>
                      {`  FK: ${fk.column} → ${fk.referencedTable}.${fk.referencedColumn}`}
                    </text>
                  ))
                : null}
            </box>
          ))}
        </box>
      ) : null}

      {/* Fitness metrics */}
      {data.fitness !== undefined ? (
        <box flexDirection="column" marginTop={1}>
          <text fg={COLORS.cyan}>
            <b>{"─── Fitness ───"}</b>
          </text>
          <text>{`Success:      ${renderFitnessBar(data.fitness.successRate)}`}</text>
          <text>{`Queries:      ${String(data.fitness.successCount + data.fitness.errorCount)} (${String(data.fitness.successCount)} ok, ${String(data.fitness.errorCount)} err)`}</text>
          {data.fitness.p95LatencyMs !== undefined ? (
            <text>{`P95 Latency:  ${String(data.fitness.p95LatencyMs)}ms`}</text>
          ) : null}
          {data.trailStrength !== undefined ? (
            <text>{`Trail:        ${renderFitnessBar(data.trailStrength)}`}</text>
          ) : null}
          <text fg={COLORS.dim}>{`Last used:    ${new Date(data.fitness.lastUsedAt).toLocaleString()}`}</text>
        </box>
      ) : null}

      {/* Provenance */}
      {data.provenance !== undefined ? (
        <box flexDirection="column" marginTop={1}>
          <text fg={COLORS.cyan}>
            <b>{"─── Provenance ───"}</b>
          </text>
          <text>{`Builder:      ${data.provenance.builder}`}</text>
          <text>{`Forged:       ${new Date(data.provenance.forgedAt).toLocaleString()}`}</text>
          <text>
            {"Verified:     "}
            <text fg={data.provenance.verificationPassed ? COLORS.green : COLORS.red}>
              {data.provenance.verificationPassed ? "passed" : "failed"}
            </text>
          </text>
        </box>
      ) : null}

      {/* Verification stages */}
      {data.verification !== undefined && data.verification.length > 0 ? (
        <box flexDirection="column" marginTop={1}>
          <text fg={COLORS.cyan}>
            <b>{"─── Verification ───"}</b>
          </text>
          {data.verification.map((stage) => (
            <text key={stage.stage}>
              <text fg={stage.passed ? COLORS.green : COLORS.red}>
                {stage.passed ? " \u2713 " : " \u2717 "}
              </text>
              {`${stage.stage} (${String(stage.durationMs)}ms)`}
            </text>
          ))}
        </box>
      ) : null}

      <box height={1} marginTop={1} flexDirection="row">
        {data.status === "pending" && props.onApprove !== undefined ? (
          <text fg={COLORS.cyan}>{"[a] Approve  "}</text>
        ) : null}
        {props.onViewSchema !== undefined ? <text fg={COLORS.cyan}>{"[s] Schema  "}</text> : null}
        <text fg={COLORS.dim}>{"[Esc] Back"}</text>
      </box>
    </box>
  );
}
