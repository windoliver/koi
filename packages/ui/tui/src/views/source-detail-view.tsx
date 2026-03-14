/**
 * Source detail view — shows full detail for a single data source.
 *
 * Displays descriptor fields (name, protocol, description, endpoint,
 * auth, allowedHosts, schema status) and available actions.
 */

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
}

export interface SourceDetailViewProps {
  readonly data: SourceDetailData | null;
  readonly loading: boolean;
  readonly onApprove?: ((name: string) => void) | undefined;
  readonly onViewSchema?: ((name: string) => void) | undefined;
  readonly onBack: () => void;
  readonly focused: boolean;
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
        <text>{`Schema:       ${data.schemaProbed === true ? "probed" : "not probed"}`}</text>
      </box>

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
