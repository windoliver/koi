/**
 * Mailbox view — agent message inbox.
 *
 * Shows messages between agents with from, to, content (truncated), and timestamp.
 */

import { PanelChrome } from "../components/panel-chrome.js";
import type { MailboxViewState } from "../state/domain-types.js";
import { COLORS } from "../theme.js";

export interface MailboxViewProps {
  readonly mailboxView: MailboxViewState;
  readonly focused: boolean;
  readonly zoomLevel?: "normal" | "half" | "full" | undefined;
}

export function MailboxView(props: MailboxViewProps): React.ReactNode {
  const { messages, scrollOffset, loading } = props.mailboxView;
  const VISIBLE_ROWS = 15;
  const visible = messages.slice(scrollOffset, scrollOffset + VISIBLE_ROWS);

  return (
    <PanelChrome
      title="Mailbox"
      count={messages.length}
      focused={props.focused}
      zoomLevel={props.zoomLevel}
      loading={loading}
      loadingMessage="Loading messages…"
      isEmpty={messages.length === 0}
      emptyMessage="No messages."
      emptyHint="Mailbox shows inter-agent messages."
    >
      <box flexDirection="column">
        <box height={1}>
          <text fg={COLORS.dim}>{" From         To           Content                          Time"}</text>
        </box>
        {visible.map((msg) => {
          const time = new Date(msg.timestamp).toLocaleTimeString();
          const content = msg.content.replace(/\n/g, " ");
          return (
            <box key={msg.id} height={1}>
              <text>
                {`  ${msg.from.padEnd(12).slice(0, 12)} ${msg.to.padEnd(12).slice(0, 12)} ${content.padEnd(32).slice(0, 32)} ${time}`}
              </text>
            </box>
          );
        })}
      </box>
    </PanelChrome>
  );
}
