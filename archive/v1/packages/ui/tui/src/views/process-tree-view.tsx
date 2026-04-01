import { PanelChrome } from "../components/panel-chrome.js";
import type { ProcessTreeViewState } from "../state/domain-types.js";
import type { ProcessTreeNode } from "@koi/dashboard-types";
import { COLORS } from "../theme.js";

export interface ProcessTreeViewProps {
  readonly processTreeView: ProcessTreeViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

/** Flatten the tree into indented lines for rendering. */
function flattenTree(
  roots: readonly ProcessTreeNode[],
): readonly { readonly node: ProcessTreeNode; readonly prefix: string }[] {
  const result: { readonly node: ProcessTreeNode; readonly prefix: string }[] = [];
  function walk(nodes: readonly ProcessTreeNode[], indent: string): void {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node === undefined) continue;
      const isLast = i === nodes.length - 1;
      const connector = isLast ? "└─" : "├─";
      result.push({ node, prefix: `${indent}${connector}` });
      walk(node.children, `${indent}${isLast ? "  " : "│ "}`);
    }
  }
  walk(roots, "");
  return result;
}

const STATE_ICONS: Readonly<Record<string, string>> = {
  running: "●",
  waiting: "◉",
  suspended: "○",
  terminated: "✗",
  created: "◌",
} as const;

export function ProcessTreeView(props: ProcessTreeViewProps): React.ReactNode {
  const { snapshot, loading, scrollOffset } = props.processTreeView;
  const lines = snapshot !== null ? flattenTree(snapshot.roots) : [];
  const VISIBLE_ROWS = 20;
  const visible = lines.slice(scrollOffset, scrollOffset + VISIBLE_ROWS);

  return (
    <PanelChrome
      title="Process Tree"
      count={snapshot?.totalAgents}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      loading={loading}
      isEmpty={snapshot !== null && lines.length === 0}
      emptyMessage="No agents in the process tree."
    >
      {visible.map(({ node, prefix }, i) => {
        const icon = STATE_ICONS[node.state] ?? "?";
        return (
          <box key={`${String(node.agentId)}-${String(i)}`} height={1}>
            <text>
              {` ${prefix} ${icon} ${node.name} (${String(node.agentId).slice(0, 8)}…) [${node.state}]`}
            </text>
          </box>
        );
      })}
    </PanelChrome>
  );
}
