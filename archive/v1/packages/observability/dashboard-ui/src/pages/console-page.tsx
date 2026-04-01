/**
 * ConsolePage — route wrapper for the interactive agent console.
 *
 * Reads :agentId from URL params and delegates to ConsoleView.
 * Navigates back to /agents on "Back".
 */

import { useNavigate, useParams } from "react-router-dom";
import { ConsoleView } from "../components/console/console-view.js";

export function ConsolePage(): React.ReactElement {
  const { agentId } = useParams<{ readonly agentId: string }>();
  const navigate = useNavigate();

  if (agentId === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted)]">
        No agent ID specified
      </div>
    );
  }

  return (
    <div className="h-full">
      <ConsoleView
        agentId={agentId}
        onBack={() => { navigate("/agents"); }}
      />
    </div>
  );
}
